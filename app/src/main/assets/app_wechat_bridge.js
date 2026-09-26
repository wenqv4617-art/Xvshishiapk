/**
 * app_wechat_bridge.js —— 微信接入（App 内直连 iLink / ClawBot）
 * ---------------------------------------------------------------------------
 * 做什么：
 *   把微信官方的 ClawBot 通道接到「叙事诗小手机」里。
 *   走腾讯开放的 iLink 协议（纯 HTTP/JSON），登录二维码在 App 内本地渲染，
 *   扫码即完成绑定；收到微信消息后交给绑定的 char 生成回复，再发回微信。
 *
 * 定位（和旧的无障碍方案完全不同，别混淆）：
 *   · 这条通道是「ClawBot 联系人 ↔ 你」。你在微信里跟 ClawBot 说话，
 *     等于跟你的 char 说话。
 *   · 它**不是**「你的账号替你去给微信好友发消息」—— 那需要自动化你的微信客户端，
 *     是另一条路（已弃置）。
 *   · 走官方开放接口、不自动化你的微信账号，风险远低于模拟操作；
 *     但腾讯保留对这套接口的控制权（限速、内容过滤、随时终止），并非零风险。
 *
 * 依赖：
 *   · qrcode-generator.js（MIT，本地引入）+ qrcode-utf8.js：本地画二维码
 *   · app_ilink_client.js：iLink 协议（登录 / 收发 / 游标持久化）
 *   · AndroidMCP.sendNativeHttpRequestWithTimeout：长超时 HTTP（长轮询必须）
 *
 * UI 规范：无 Emoji、纯 SVG 图标、自绘卡片、淡彩配色。
 */
(function () {
  "use strict";

  // ---------- 淡彩主题 ----------
  var PASTEL = {
    accent: "#4A7DBF", soft: "#EAF2FB", border: "#CFE1F3",
    green: "#35867A", greenSoft: "#E9F5F2", greenBorder: "#CDE9E3",
    warn: "#B4794A", warnSoft: "#FBF3EA", warnBorder: "#F0DFC9",
    danger: "#C05B6A", dangerSoft: "#FBEDEF", dangerBorder: "#F2D5DA",
    ink: "#2C3A4B", sub: "#7A8A9C"
  };

  // ---------- 出站清洗：App 内部卡片指令标记（微信里没有对应物，必须剥掉） ----------
  var CARD_CMD_TAGS = {
    TRANSFER: 1, RED_ENVELOPE: 1, RECEIVE_TRANSFER: 1, OPEN_RED_ENVELOPE: 1,
    VOICE: 1, IMAGE: 1, LOCATION: 1, PAY_FOR_ME: 1, GIFT: 1, AGREE_PAY: 1,
    MP_INVITE: 1, AUTO_CALL: 1, CHECK_PHONE: 1, SPLIT: 1, QUOTE: 1,
    STATUS: 1, TRANSLATE: 1
  };
  var CARD_CMD_ZH = {
    "转账": 1, "红包": 1, "收钱": 1, "收转账": 1, "拆红包": 1, "领红包": 1,
    "语音": 1, "图片": 1, "位置": 1, "代付": 1, "送礼": 1, "同意代付": 1
  };

  // ---------- 本地配置键 ----------
  var K = {
    binding: "wx-ilink-binding",
    autoReply: "wx-ilink-auto-reply",
    minDelay: "wx-ilink-min-delay",
    maxDelay: "wx-ilink-max-delay",
    hourlyLimit: "wx-ilink-hourly-limit",
    riskAccepted: "wx-ilink-risk-accepted",
    ctxLog: "wx-ilink-ctx-log",
    // 事件流分实例持久化：前台页与后台中枢各写各的键，面板渲染时合并。
    // 这样打开 App 时能同时看到两个实例各自做了什么，便于判断是否重复收消息。
    eventsFront: "wx-ilink-events-front",
    eventsCenter: "wx-ilink-events-center",
    // 长轮询心跳：两个实例各自记录「我最后一次成功轮询的时间」，
    // 用来决定当前该由谁持有长轮询（服务端不允许同一 bot 并发长轮询）。
    beatFront: "wx-ilink-beat-front",
    beatCenter: "wx-ilink-beat-center"
  };

  var DEFAULTS = { autoReply: false, minDelay: 3, maxDelay: 8, hourlyLimit: 20 };

  // ---------- 通道上下文清理参数 ----------
  var CTX_MAX_USERS = 12;
  var CTX_MAX_TURNS = 40;
  var CTX_TTL_MS = 2 * 60 * 60 * 1000;

  // 生成失败后的自动重试间隔（接口偶发 5xx / 限流时，重试一次即可成功）
  var GEN_RETRY_DELAY_MS = 3000;

  var state = {
    binding: null,       // { sessionId, userName }
    loop: null,          // iLink 消息循环句柄
    loginRun: null,      // 进行中的登录句柄
    pendingVerify: null, // 等配对码时把输入回传的 resolve
    qrContent: "",       // 当前二维码内容（用于重绘）
    busy: false,
    lastError: "",
    stats: { received: 0, replied: 0, sent: 0, blocked: 0 },
    recentLog: [],
    sentTimestamps: [],
    replyBusy: {},
    mode: "",           // "" 未启动 / "native" 原生长轮询 / "js" 网页轮询
    keepAlive: null,    // 原生保活状态快照（诊断卡用）
    fallback: null,     // 原生兜底回信状态快照（诊断卡用）
    lastSnapshotAt: 0   // 最近一次向原生写上下文快照的时间
  };

  // =========================================================================
  // 基础工具
  // =========================================================================

  function toast(msg) {
    try {
      if (typeof window.showToast === "function") window.showToast(msg);
      else console.log("[ilink-ui]", msg);
    } catch (e) { }
  }

  function esc(s) {
    if (s === null || s === undefined) return "";
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function readBool(k, d) { var v = localStorage.getItem(k); return v === null ? d : v === "true"; }
  function readNum(k, d) { var v = parseInt(localStorage.getItem(k), 10); return isNaN(v) ? d : v; }

  function cfg() {
    return {
      autoReply: readBool(K.autoReply, DEFAULTS.autoReply),
      minDelay: readNum(K.minDelay, DEFAULTS.minDelay),
      maxDelay: readNum(K.maxDelay, DEFAULTS.maxDelay),
      hourlyLimit: readNum(K.hourlyLimit, DEFAULTS.hourlyLimit)
    };
  }

  // 当前实例身份：前台页面 / 后台中枢（由前台服务托管的隐藏 WebView）。
  // 原生给中枢页加 #sp_bg=1 标记（加载前就确定，无竞态）；initBackgroundCenter()
  // 之后也会置 window.__isBackgroundCenter，两者取或。
  function isCenterInstance() {
    return !!window.__isBackgroundCenter || /(^|[#&])sp_bg=1/.test(location.hash || "");
  }
  function instTag() { return isCenterInstance() ? "后台" : "前台"; }
  function eventKey() { return isCenterInstance() ? K.eventsCenter : K.eventsFront; }

  // =========================================================================
  // 长轮询持有权（单实例）
  //   iLink 的 getupdates 是「同一个 bot 同时只能有一条长轮询」的语义：
  //   两个实例并发轮询时服务端会返回 HTTP 500 并踢掉连接（用户实测：
  //   「收消息失败：HTTP 500」「发到一半就掉了」）。
  //   规则：后台中枢是首选持有者（它由前台服务托管，活得更久）；
  //        前台页只在「中枢心跳已过期」时接管，从而实现无缝接替、不会同时轮询。
  // =========================================================================
  var CENTER_BEAT_TTL_MS = 90 * 1000;

  function centerAlive() {
    try {
      var t = parseInt(localStorage.getItem(K.beatCenter) || "0", 10) || 0;
      return Date.now() - t < CENTER_BEAT_TTL_MS;
    } catch (e) { return false; }
  }

  function writeBeat() {
    try { localStorage.setItem(isCenterInstance() ? K.beatCenter : K.beatFront, String(Date.now())); } catch (e) { }
  }

  var lastYieldLogAt = 0;
  function noteFrontYield() {
    var now = Date.now();
    if (now - lastYieldLogAt < 120 * 1000) return;
    lastYieldLogAt = now;
    logEvent("后台中枢持有中，前台让出长轮询", "info");
  }

  function logEvent(text, tone) {
    var e = { at: Date.now(), text: String(text), tone: tone || "info", src: instTag() };
    state.recentLog.unshift(e);
    if (state.recentLog.length > 40) state.recentLog.length = 40;
    try {
      var buf = JSON.parse(localStorage.getItem(eventKey()) || "[]");
      if (!Array.isArray(buf)) buf = [];
      buf.unshift(e);
      if (buf.length > 60) buf.length = 60;
      localStorage.setItem(eventKey(), JSON.stringify(buf));
    } catch (err) { }
  }

  // 合并两个实例的事件（时间倒序）。两个实例都写同一个 localStorage，
  // 所以在前台页也能看到后台中枢的日志 —— 重复收消息会表现成两条时间几乎相同的「收到」。
  function allEvents() {
    var out = [];
    try {
      [K.eventsFront, K.eventsCenter].forEach(function (k) {
        var buf = JSON.parse(localStorage.getItem(k) || "[]");
        if (Array.isArray(buf)) out = out.concat(buf);
      });
    } catch (e) { }
    if (!out.length) return state.recentLog;
    out.sort(function (a, b) { return b.at - a.at; });
    return out;
  }

  function timeStr(ts) {
    try {
      var d = new Date(ts), p = function (n) { return String(n).padStart(2, "0"); };
      return p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
    } catch (e) { return ""; }
  }

  function ilink() {
    return (typeof window !== "undefined" && window.IlinkClient) ? window.IlinkClient : null;
  }

  function loadBinding() {
    try { return JSON.parse(localStorage.getItem(K.binding) || "null"); }
    catch (e) { return null; }
  }

  function saveBinding(b) {
    try {
      if (b) localStorage.setItem(K.binding, JSON.stringify(b));
      else localStorage.removeItem(K.binding);
    } catch (e) { }
  }

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function randInt(a, b) { return b <= a ? a : Math.floor(a + Math.random() * (b - a)); }

  // =========================================================================
  // 标签清洗
  // =========================================================================

  /** 从 s[0]（必须是 { 或 [）找配平结尾；找不到返回 -1 */
  function balancedJsonEnd(s) {
    if (!s || (s.charAt(0) !== "{" && s.charAt(0) !== "[")) return -1;
    var open = s.charAt(0), close = open === "{" ? "}" : "]";
    var depth = 0, inStr = false, quote = "";
    for (var i = 0; i < s.length; i++) {
      var c = s.charAt(i);
      if (inStr) {
        if (c === "\\") { i++; continue; }
        if (c === quote) inStr = false;
        continue;
      }
      if (c === '"' || c === "'") { inStr = true; quote = c; continue; }
      if (c === "{" || c === "[") depth++;
      else if (c === "}" || c === "]") { depth--; if (depth === 0) return i + 1; }
    }
    return -1;
  }

  /** 扫描全文剥掉已知卡片指令（连同其 JSON 负载）；未知方括号内容原样保留 */
  function stripCardCommands(text) {
    var out = "", i = 0, n = text.length;
    while (i < n) {
      var c = text.charAt(i);
      if (c !== "[" && c !== "【") { out += c; i++; continue; }
      var closeIdx = -1;
      for (var j = i + 1; j < n && j < i + 40; j++) {
        var cj = text.charAt(j);
        if (cj === "]" || cj === "】") { closeIdx = j; break; }
        if (cj === "\n") break;
      }
      if (closeIdx < 0) { out += c; i++; continue; }
      var raw = text.substring(i + 1, closeIdx);
      var tag = raw.split(/[:：\s]/)[0];
      if (CARD_CMD_TAGS[tag] === undefined && CARD_CMD_ZH[tag] === undefined) {
        out += text.substring(i, closeIdx + 1); i = closeIdx + 1; continue;
      }
      var after = closeIdx + 1, k = after;
      while (k < n && /\s/.test(text.charAt(k))) k++;
      if (text.charAt(k) === "{" || text.charAt(k) === "[") {
        var end = balancedJsonEnd(text.substring(k));
        if (end >= 0) after = k + end;
      }
      i = after;
      if (out.length && !/\s$/.test(out)) out += " ";
    }
    return out;
  }

  /** 出站清洗：发到微信的只能是干净人话 */
  function cleanOutbound(raw) {
    if (!raw) return "";
    var t = String(raw);
    t = t.replace(/<think>[\s\S]*?<\/think>/gi, "");
    t = t.replace(/<\/?think>/gi, "");
    t = t.replace(/[\[【]STATUS[\]】][\s\S]*$/gi, "");
    t = t.replace(/[\[\u3010]TRANSLATE[\]\u3011][\s\S]*?[\[\u3010]\/TRANSLATE[\]\u3011]/gi, "");
    t = t.replace(/[\[【]TRANSLATE[\]】[\s\S]*$/gi, "");
    t = t.replace(/[\[【](QUOTE|引用)\s*[:：]\s*\d+[\]】]\s*/gi, "");
    t = stripCardCommands(t);
    t = t.replace(/[\[【](AUTO_CALL|CHECK_PHONE|SPLIT)\s*[:：]?[^\]】]*[\]】]/gi, "");
    t = t.replace(/[\[【]表情包[:：][^\]】]*[\]】]/g, "");
    t = t.replace(/[\[【]SPLIT[\]】]/gi, "");
    t = t.replace(/__TR\d+__/g, "");
    // 残留的孤立 JSON 片段兜底（只删明显是 JSON 形状的，不误删对白）
    t = t.replace(/\[\s*"[^"\n]{1,40}"\s*:[^\]\n]{0,400}\]/g, "");
    t = t.replace(/\{\s*"[^"\n]{1,40}"\s*:[^}\n]{0,600}\}/g, "");
    t = t.replace(/(^|\n)\s*[\}\]]\s*(\n|$)/g, "$1$2");
    t = t.replace(/<[^>\n]{1,80}>/g, "");
    t = t.replace(/```[\s\S]*?```/g, "");
    return t.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  }

  /** 入站清洗 */
  function cleanInbound(raw) {
    if (!raw) return "";
    return String(raw).replace(/[\u200b-\u200f\ufeff]/g, "").replace(/[ \t]+/g, " ").trim();
  }

  // ---------- 通道上下文（按微信用户隔离 + 上限 + 老化） ----------

  function loadCtxLog() {
    try { return JSON.parse(localStorage.getItem(K.ctxLog) || "{}") || {}; }
    catch (e) { return {}; }
  }
  function saveCtxLog(o) { try { localStorage.setItem(K.ctxLog, JSON.stringify(o)); } catch (e) { } }

  function pruneCtxLog(obj) {
    var now = Date.now();
    Object.keys(obj).forEach(function (u) {
      var it = obj[u];
      if (!it || !Array.isArray(it.turns)) { delete obj[u]; return; }
      if (now - (it.updated || 0) > CTX_TTL_MS) { delete obj[u]; return; }
      if (it.turns.length > CTX_MAX_TURNS) it.turns = it.turns.slice(it.turns.length - CTX_MAX_TURNS);
      it.turns = it.turns.map(function (t) {
        return {
          role: t.role,
          text: t.role === "in" ? cleanInbound(t.text) : cleanOutbound(t.text),
          at: t.at
        };
      }).filter(function (t) { return !!t.text; });
    });
    var us = Object.keys(obj);
    if (us.length > CTX_MAX_USERS) {
      us.sort(function (a, b) { return (obj[a].updated || 0) - (obj[b].updated || 0); });
      us.slice(0, us.length - CTX_MAX_USERS).forEach(function (u) { delete obj[u]; });
    }
    return obj;
  }

  function ctxPush(userId, role, text) {
    var clean = role === "in" ? cleanInbound(text) : cleanOutbound(text);
    if (!clean) return;
    var o = pruneCtxLog(loadCtxLog());
    if (!o[userId]) o[userId] = { turns: [], updated: 0 };
    o[userId].turns.push({ role: role, text: clean, at: Date.now() });
    o[userId].updated = Date.now();
    saveCtxLog(pruneCtxLog(o));
  }

  function ctxStats() {
    var o = pruneCtxLog(loadCtxLog()), us = Object.keys(o), n = 0;
    us.forEach(function (u) { n += (o[u].turns || []).length; });
    return { users: us.length, turns: n };
  }

  // =========================================================================
  // 会话工具
  // =========================================================================

  async function listCharSessions() {
    var out = [];
    try {
      var uid = Number(window.activeUserPersonaId || localStorage.getItem("active_me_id") || 0);
      var list = uid ? await db.sessions.where("userId").equals(uid).toArray() : await db.sessions.toArray();
      for (var i = 0; i < list.length; i++) {
        var s = list[i];
        if (s.isGroup === 1) continue;
        var ch = null;
        try { ch = await db.archives.get(s.charId); } catch (e) { }
        out.push({
          id: s.id,
          name: s.customCharName || (ch && ch.name) || "未知角色",
          avatar: s.customCharAvatar || (ch && ch.avatar) || null
        });
      }
    } catch (e) { console.warn("[ilink] 读取单聊失败", e); }
    return out;
  }

  async function getSessionName(sid) {
    try {
      var s = await db.sessions.get(Number(sid));
      if (!s) return "";
      var ch = await db.archives.get(s.charId);
      return s.customCharName || (ch && ch.name) || "角色";
    } catch (e) { return ""; }
  }

  function ensureReplyEngine() {
    if (typeof window.generateReplyForSession !== "function") {
      throw new Error("回复引擎未加载（generateReplyForSession 不存在），请更新到最新版 APK");
    }
    if (typeof window.saveAndRenderMessage !== "function") {
      throw new Error("消息模块未加载，请先打开一次聊天页");
    }
  }

  // =========================================================================
  // 消息处理
  // =========================================================================

  async function handleIncoming(msg) {
    var userId = msg.fromUserId || "";
    var text = cleanInbound(msg.text || "");
    if (!userId || !text) return;

    var b = state.binding;
    if (!b || !b.sessionId) {
      state.stats.blocked++;
      logEvent("收到微信消息，但还没绑定 char，已忽略", "warn");
      return;
    }

    // 跨实例原子去重：前台页与后台中枢会各自长轮询，同一条消息可能被两边都收到，
    // 导致聊天页出现两条一样的消息、并触发两次生成。向原生认领，只放行一次。
    // （原生侧是进程级单例 + ConcurrentHashMap，认领是原子的；没有 msgId 时一律放行）
    try {
      if (window.AndroidMCP && typeof window.AndroidMCP.claimIncomingMessage === "function") {
        if (!window.AndroidMCP.claimIncomingMessage(userId, msg.msgId || "")) {
          logEvent("重复消息，已跳过（另一实例已在处理）", "warn");
          return;
        }
      }
    } catch (e) { }

    // ★ 告诉原生「网页正在处理」：原生兜底回信据此避让。
    //   网页每 4 秒都会拉一次队列，原生本来就知道网页活着；这个心跳是给「网页正好
    //   在处理一条消息、而队列里又来了新消息」时用的 —— 防止同一条被两边各回一遍。
    try {
      if (window.AndroidMCP && typeof window.AndroidMCP.ilinkWebBusy === "function") {
        window.AndroidMCP.ilinkWebBusy();
      }
    } catch (e) { }

    state.stats.received++;
    ctxPush(userId, "in", text);
    logEvent("收到：" + text.slice(0, 24) + (text.length > 24 ? "…" : ""), "in");

    try {
      await window.saveAndRenderMessage("user", text, "text", b.sessionId);
    } catch (e) { console.warn("[ilink] 落库失败", e); }

    if (cfg().autoReply) await generateAndSend(msg, b);
    refreshPanelIfOpen();
  }

  async function generateAndSend(msg, b) {
    var sid = Number(b.sessionId);
    if (state.replyBusy[sid]) { logEvent("上一条还在生成，本条跳过", "warn"); return; }
    var c = cfg();
    var now = Date.now();
    state.sentTimestamps = state.sentTimestamps.filter(function (t) { return now - t < 3600 * 1000; });
    if (state.sentTimestamps.length >= c.hourlyLimit) {
      state.stats.blocked++;
      logEvent("本小时已发 " + state.sentTimestamps.length + " 条，达到上限，暂停回信", "danger");
      return;
    }

    state.replyBusy[sid] = true;
    // ★ 生成期间持续向原生报「我还在干活」。
    //   为什么需要：原生兜底判定网页失联的依据是 45 秒没有心跳，而一次长上下文的
    //   生成经常要 30~60 秒。如果不额外打点，网页明明在正常生成，原生却会以为它死了，
    //   于是同一条消息被两边各回一遍。这里每 5 秒续一次；反过来，如果网页真的被冻结，
    //   这个心跳会在 45 秒内变旧，原生就能正确接管。
    var busyTimer = setInterval(function () {
      try {
        if (window.AndroidMCP && typeof window.AndroidMCP.ilinkWebBusy === "function") {
          window.AndroidMCP.ilinkWebBusy();
        }
      } catch (e) { }
    }, 5000);
    var collected = [];
    var IL = ilink();
    var ticket = "";
    try {
      ensureReplyEngine();
      logEvent("正在生成回复…", "info");
      if (IL) {
        try {
          var cr = await IL.getConfig(msg.fromUserId, msg.contextToken);
          ticket = (cr && cr.typingTicket) ? cr.typingTicket : "";
          if (ticket) await IL.sendTyping(msg.fromUserId, ticket, 1);
        } catch (e) { }
      }
      // 生成失败自动重试一次：接口偶发 5xx（含并发/限流）时，隔几秒重试通常就能成功。
      // 原来后台失败后就一直卡着，要等用户打开 App 触发下一轮才补上回复。
      var lastGenErr = null;
      for (var attempt = 1; attempt <= 2; attempt++) {
        collected.length = 0;
        try {
          await window.generateReplyForSession(sid, {
            background: true,
            silentError: false,
            onText: function (t) { if (t) collected.push(t); }
          });
          lastGenErr = null;
          break;
        } catch (e) {
          lastGenErr = e;
          if (attempt < 2) {
            logEvent("生成失败，" + (GEN_RETRY_DELAY_MS / 1000) + " 秒后重试：" +
              String(e && e.message || e).slice(0, 140), "warn");
            await sleep(GEN_RETRY_DELAY_MS);
          }
        }
      }
      if (lastGenErr) throw lastGenErr;
    } catch (e) {
      state.lastError = String(e && e.message || e);
      logEvent("生成回复失败：" + state.lastError, "danger");
      state.replyBusy[sid] = false;
      clearInterval(busyTimer);
      if (IL && ticket) { try { await IL.sendTyping(msg.fromUserId, ticket, 2); } catch (e2) { } }
      refreshPanelIfOpen();
      return;
    }
    state.replyBusy[sid] = false;
    clearInterval(busyTimer);
    if (IL && ticket) { try { await IL.sendTyping(msg.fromUserId, ticket, 2); } catch (e) { } }

    var outTexts = collected.map(cleanOutbound).filter(Boolean);
    state.stats.replied++;
    if (!outTexts.length) {
      logEvent("本轮没有可发送的文本，不回微信", "warn");
      refreshPanelIfOpen();
      return;
    }
    outTexts.forEach(function (t) { ctxPush(msg.fromUserId, "out", t); });

    if (!c.autoReply) {
      logEvent("已生成 " + outTexts.length + " 条回复（自动回信关闭，只留在 App）", "ok");
      refreshPanelIfOpen();
      return;
    }
    await sendToWechat(msg, outTexts);
    refreshPanelIfOpen();
  }

  // =========================================================================
  // 原生兜底回信：上下文快照 + 回执
  //
  // 真机现象：收消息早就在原生线程了，但「生成回复」还在网页里。WebView 被 Blink 冻结、
  // 渲染进程被回收，或者进程被国产 ROM 清掉后由看门狗拉起来（网页还没重建好）时，
  // 微信那边就变成「只有进、没有出」。
  //
  // 兜底方案的关键不是让原生去复刻提示词（那必然和网页版慢慢分叉），而是**照抄成品**：
  // 网页每次真正请求大模型前，把已经拼好的 messages（角色卡 + 世界书 + RAG 记忆 +
  // 时间提示）连同 API 配置交给原生存一份。网页不在时，原生拿这份成品 + 新消息
  // 调同一个模型，得到的就是同源回复。
  // =========================================================================

  /**
   * 由 app_chat.generateReplyForSession 在发请求前调用。
   * 只有「微信通道绑定的那个会话」才值得存 —— 别为无关会话反复写盘。
   */
  function saveWechatContextSnapshot(sid, messagesToSend, activeApi, charName, myName) {
    try {
      if (typeof window === "undefined" || !window.AndroidMCP) return false;
      if (typeof window.AndroidMCP.ilinkSaveContextSnapshot !== "function") return false;
      var b = state.binding;
      if (!b || !b.sessionId) return false;
      if (String(b.sessionId) !== String(sid)) return false;
      if (!Array.isArray(messagesToSend) || !messagesToSend.length) return false;
      if (!activeApi || !activeApi.url || !activeApi.model) return false;
      // 只留最近 40 条：原生那边还会再截一次，这里先压小写入体积
      var trimmed = messagesToSend.length > 44
        ? messagesToSend.slice(messagesToSend.length - 40)
        : messagesToSend;
      // system 提示词必须带上（它是角色卡+世界书的主体），上面裁剪可能把它切掉
      if (messagesToSend[0] && messagesToSend[0].role === "system" &&
        (!trimmed[0] || trimmed[0].role !== "system")) {
        trimmed = [messagesToSend[0]].concat(trimmed);
      }

      var api = {
        url: activeApi.url || "",
        key: activeApi.key || "",
        model: activeApi.model || "",
        temperature: (typeof activeApi.temperature === "number") ? activeApi.temperature : 0.8
      };
      window.AndroidMCP.ilinkSaveContextSnapshot(
        String(sid),
        JSON.stringify(trimmed),
        JSON.stringify(api),
        String(charName || ""),
        String(myName || "")
      );
      state.lastSnapshotAt = Date.now();
      return true;
    } catch (e) {
      console.warn("[ilink] 保存原生上下文快照失败", e);
      return false;
    }
  }

  function b64ToUtf8(b64) {
    try {
      var bin = atob(b64);
      var bytes = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return new TextDecoder("utf-8").decode(bytes);
    } catch (e) {
      return "";
    }
  }

  // 已经由原生兜底补录过的消息指纹。原生注入回调可能因为页面重载/多实例被投递多次，
  // 这里做一次幂等保护，避免同一条兜底回复在聊天记录里出现两遍。
  var nativeRepliedSeen = {};

  /**
   * 原生兜底回信成功后回调：把这段对话补进 App 的聊天库，
   * 用户回到 App 时能看到「我不在的时候它们聊了什么」。
   * 只在网页重新活过来之后才会走到（原生注入 JS 需要 WebView）。
   */
  async function onNativeReplied(b64) {
    try {
      var json = b64ToUtf8(b64);
      if (!json) return;
      var d = JSON.parse(json);
      var sid = Number(d.sessionId || 0);
      if (!sid) return;
      var userText = String(d.userText || "");
      var replyText = String(d.replyText || "");
      if (!userText && !replyText) return;

      var fp = sid + "|" + (d.at || 0) + "|" + replyText.slice(0, 40);
      if (nativeRepliedSeen[fp]) return;
      nativeRepliedSeen[fp] = 1;

      // 前台与后台中枢都只负责「落库」：渲染交给各自页面自己的刷新逻辑，
      // 免得后台中枢在无人观看时去动 DOM。
      await window.saveAndRenderMessage("user", userText, "text", sid);
      await window.saveAndRenderMessage("char", replyText, "text", sid);
      logEvent("已补录一条原生兜底回复：" + replyText.slice(0, 20) + "…", "out");
      if (!isCenterInstance()) refreshPanelIfOpen();
    } catch (e) {
      console.warn("[ilink] 补录原生兜底回复失败", e);
    }
  }

  async function sendToWechat(msg, texts) {    var IL = ilink();
    if (!IL) { logEvent("iLink 客户端未加载", "danger"); return; }
    var c = cfg();
    for (var i = 0; i < texts.length; i++) {
      if (i > 0) await sleep(randInt(c.minDelay * 1000, c.maxDelay * 1000));
      var r = await IL.sendMessage(msg.fromUserId, texts[i], msg.contextToken);
      if (r.ok) {
        state.stats.sent++;
        state.sentTimestamps.push(Date.now());
        logEvent("已发出：" + texts[i].slice(0, 24) + (texts[i].length > 24 ? "…" : ""), "out");
      } else if (r.stale) {
        state.stats.blocked++;
        logEvent("登录态失效，已停止收消息", "danger");
        stopLoop();
        break;
      } else {
        state.stats.blocked++;
        logEvent("发送被拒：" + (r.error || "未知原因"), "danger");
      }
    }
  }

  // =========================================================================
  // 循环控制
  // =========================================================================

  // =========================================================================
  // 原生传输（首选）与网页轮询（回退）
  //
  // 为什么优先走原生：Blink 会对隐藏页面启用 intensive throttling —— 隐藏满 5 分钟后
  // 把 setTimeout 的最小间隔强制放大到 60 秒。收消息的循环本来是 setTimeout 链，
  // 一旦被放大，长轮询周期断崖式拉长，服务端就判定掉线（现象：常驻通知还在，
  // 微信侧却显示「未连接」）。
  //
  // 搬到原生后：
  //   · 长轮询在原生线程里严格串行跑，不受网页节流影响；
  //   · 收到的消息先进原生队列，网页只是「消费端」，被冻结也不丢消息；
  //   · 网页恢复后一次性把积压拉走。
  // 旧 APK 上没有这套原生接口，会自动回退到原来的网页轮询，功能不受影响。
  // =========================================================================

  var NATIVE_PULL_MS = 4000;      // 网页拉取原生队列的兜底间隔
  var nativePullTimer = null;
  var nativePulling = false;
  var nativePullTicks = 0;

  function nativeAvailable() {
    if (typeof window === "undefined" || !window.AndroidMCP) return false;
    var n = window.AndroidMCP;
    return typeof n.ilinkNativeStart === "function" &&
      typeof n.ilinkNativeFetchPending === "function" &&
      typeof n.ilinkNativeAck === "function";
  }

  function nativeRunning() { return state.mode === "native"; }

  /** 原生轮询的实时状态（旧版 APK 没有这个接口时返回 null） */
  function nativeStatus() {
    try {
      if (!window.AndroidMCP || typeof window.AndroidMCP.ilinkNativeStatus !== "function") return null;
      return JSON.parse(window.AndroidMCP.ilinkNativeStatus() || "{}");
    } catch (e) { return null; }
  }

  /** 把原生队列里未确认的消息取出来处理，处理完逐条 ack（未 ack 会再次被拉到，保证不丢） */
  function pullNativePending() {
    if (nativePulling || !nativeAvailable()) return;
    nativePulling = true;
    (async function () {
      try {
        var raw = window.AndroidMCP.ilinkNativeFetchPending() || "[]";
        var arr = JSON.parse(raw);
        for (var i = 0; i < arr.length; i++) {
          var item = arr[i] || {};
          var p = item.payload || {};
          try {
            await handleIncoming({
              fromUserId: p.fromUserId || "",
              text: p.text || "",
              contextToken: p.contextToken || "",
              msgId: p.msgId || ""
            });
          } catch (e) {
            console.warn("[ilink] 处理原生消息失败", e);
          }
          try { window.AndroidMCP.ilinkNativeAck(String(item.id || "")); } catch (e) { }
        }
        if (arr.length) refreshPanelIfOpen();
        // 原生兜底可能刚在我们被节流的这段时间里回了信，顺手补录
        if (++nativePullTicks % 5 === 0) drainNativeReplies();
      } catch (e) {
        console.warn("[ilink] 拉取原生消息失败", e);
      } finally {
        nativePulling = false;
      }
    })();
  }

  function startNativePull() {
    stopNativePull();
    nativePullTimer = setInterval(pullNativePending, NATIVE_PULL_MS);
    pullNativePending();
    // 顺带把「原生替我们回过的消息」补录进聊天库。原生兜底发生时 WebView 通常是死的，
    // 记录存在原生侧，这里一活过来就取走落库。
    drainNativeReplies();
  }

  function stopNativePull() {
    if (nativePullTimer) { clearInterval(nativePullTimer); nativePullTimer = null; }
  }

  var drainingReplies = false;

  /** 取走原生补录队列并落库（幂等：落库后逐条 ack 删除，不会重复上屏） */
  async function drainNativeReplies() {
    if (drainingReplies) return;
    try {
      if (!window.AndroidMCP || typeof window.AndroidMCP.ilinkFetchNativeReplies !== "function") return;
      drainingReplies = true;
      var raw = window.AndroidMCP.ilinkFetchNativeReplies() || "[]";
      var arr = JSON.parse(raw);
      if (!Array.isArray(arr) || !arr.length) return;
      if (typeof window.saveAndRenderMessage !== "function") return;
      for (var i = 0; i < arr.length; i++) {
        var d = arr[i] || {};
        var sid = Number(d.sessionId || 0);
        if (!sid) { ackNativeReply(d.id); continue; }
        var fp = sid + "|" + (d.at || 0) + "|" + String(d.replyText || "").slice(0, 40);
        if (!nativeRepliedSeen[fp]) {
          nativeRepliedSeen[fp] = 1;
          try {
            if (d.userText) await window.saveAndRenderMessage("user", String(d.userText), "text", sid);
            if (d.replyText) await window.saveAndRenderMessage("char", String(d.replyText), "text", sid);
            logEvent("补录一条底层代回消息：" + String(d.replyText || "").slice(0, 20) + "…", "out");
          } catch (e) {
            console.warn("[ilink] 补录失败，保留待下次重试", e);
            continue;   // 落库失败就不 ack，下次再来
          }
        }
        ackNativeReply(d.id);
      }
      if (!isCenterInstance()) refreshPanelIfOpen();
    } catch (e) {
      console.warn("[ilink] 取原生补录队列失败", e);
    } finally {
      drainingReplies = false;
    }
  }

  function ackNativeReply(id) {
    try {
      if (window.AndroidMCP && typeof window.AndroidMCP.ilinkAckNativeReply === "function") {
        window.AndroidMCP.ilinkAckNativeReply(String(id || ""));
      }
    } catch (e) { }
  }

  /** 原生侧（收到消息/出错/掉线）推过来的提示：立刻拉一次 */
  function onNativePending(what) {
    if (what === "stale") {
      state.lastError = "登录态已失效，请重新扫码登录";
      state.mode = "";
      stopNativePull();
      logEvent(state.lastError, "danger");
      refreshPanelIfOpen();
      return;
    }
    if (what === "error") {
      try {
        var st = JSON.parse(window.AndroidMCP.ilinkNativeStatus() || "{}");
        if (st.lastError) {
          state.lastError = st.lastError;
          logEvent("收消息异常：" + st.lastError, "warn");
        }
      } catch (e) { }
      refreshPanelIfOpen();
      return;
    }
    if (what === "stopped") { state.mode = ""; stopNativePull(); refreshPanelIfOpen(); return; }
    pullNativePending();
  }

  function startLoop() {
    var IL = ilink();
    if (!IL) { toast("iLink 客户端未加载"); return false; }
    if (!IL.isLoggedIn()) { toast("请先扫码登录"); return false; }
    if (nativeRunning() && nativePullTimer) return true;
    if (IL.isLoopRunning()) return true;

    // 1) 首选：原生长轮询
    if (nativeAvailable()) {
      try {
        var r = JSON.parse(window.AndroidMCP.ilinkNativeStart(
          IL.getToken() || "", IL.getBaseUrl() || "", IL.getCursor() || "") || "{}");
        if (r && r.ok) {
          state.mode = "native";
          startNativePull();
          logEvent("已启动原生长轮询（不依赖网页定时器）", "ok");
          return true;
        }
        logEvent("原生轮询启动失败，回退网页轮询：" + ((r && r.error) || "未知原因"), "warn");
      } catch (e) {
        logEvent("原生轮询异常，回退网页轮询：" + (e && e.message || e), "warn");
      }
    }

    // 2) 回退：旧 APK 或原生启动失败时，仍用网页 setInterval/setTimeout 轮询
    state.mode = "js";
    state.loop = IL.startMessageLoop(
      function (m) { return handleIncoming(m); },
      {
        onError: function (e) {
          state.lastError = e;
          logEvent("收消息异常：" + e, "warn");
          refreshPanelIfOpen();
        },
        onStale: function (e) {
          logEvent(e, "danger");
          state.loop = null;
          refreshPanelIfOpen();
        },
        onIdle: function () { },
        // 单实例持有：中枢无脑持有；前台只在中枢心跳过期时接管。
        beforePoll: function () {
          if (isCenterInstance()) return true;
          if (centerAlive()) { noteFrontYield(); return false; }
          return true;
        },
        // 每一轮轮询后打点（含超时也算活着），供另一方判断持有权。
        afterPoll: writeBeat
      }
    );
    logEvent("已开始接收微信消息（网页轮询）", "ok");
    // 中枢一起循环就立刻打点，让前台在下一轮（≤35 秒内）尽快让出长轮询，
    // 把「两个实例同时轮询」的窗口压到最小。
    if (isCenterInstance()) writeBeat();
    return true;
  }

  async function stopLoop() {
    stopNativePull();
    // 无条件停原生：原生轮询是进程级的，可能是另一个实例启动的；
    // 用户点「停止接收」的意图是全局停止。
    if (nativeAvailable()) {
      try { window.AndroidMCP.ilinkNativeStop(); } catch (e) { }
    }
    state.mode = "";
    var IL = ilink();
    if (IL && state.loop) {
      try { await state.loop.stop(); } catch (e) { }
    }
    state.loop = null;
    logEvent("已停止接收微信消息", "info");
    refreshPanelIfOpen();
  }

  /** 传输是否在跑（原生或网页，二者其一） */
  function receiveRunning() {
    if (nativeRunning()) return true;
    var IL = ilink();
    return !!(IL && IL.isLoopRunning());
  }

  // =========================================================================
  // 面板 UI
  // =========================================================================

  function panelBody() { return document.getElementById("me-sub-body"); }

  function refreshPanelIfOpen() {
    var p = document.getElementById("me-sub-panel");
    var t = document.getElementById("me-sub-title");
    if (!p || !p.classList.contains("active")) return;
    if (!t || t.innerText !== "微信接入") return;
    renderPanel();
  }

  function cssOnce() {
    if (document.getElementById("wx-ilink-style")) return;
    var st = document.createElement("style");
    st.id = "wx-ilink-style";
    st.textContent = [
      ".il-switch{position:relative;display:inline-block;width:44px;height:25px;flex-shrink:0;}",
      ".il-switch input{opacity:0;width:0;height:0;}",
      ".il-track{position:absolute;cursor:pointer;inset:0;background:#D6DEE8;border-radius:999px;transition:.22s;}",
      ".il-thumb{position:absolute;content:'';height:19px;width:19px;left:3px;top:3px;background:#fff;border-radius:50%;transition:.22s;box-shadow:0 1px 3px rgba(0,0,0,.18);}",
      ".il-switch input:checked + .il-track{background:#4A7DBF;}",
      ".il-switch input:checked + .il-track .il-thumb{transform:translateX(19px);}",
      ".il-btn{display:inline-flex;align-items:center;justify-content:center;gap:5px;border-radius:10px;padding:8px 13px;font-size:12px;font-weight:700;cursor:pointer;border:1.5px solid transparent;transition:.16s;background:#fff;}",
      ".il-btn:active{transform:scale(.97);}",
      ".il-btn-primary{background:#4A7DBF;color:#fff;border-color:#4A7DBF;}",
      ".il-btn-soft{background:#EAF2FB;color:#3D6CA6;border-color:#CFE1F3;}",
      ".il-btn-green{background:#E9F5F2;color:#2C6E63;border-color:#CDE9E3;}",
      ".il-btn-ghost{background:#fff;color:#7A8A9C;border-color:#E3E9F0;}",
      ".il-pick{display:flex;align-items:center;gap:10px;padding:9px 10px;border-radius:11px;cursor:pointer;border:1.5px solid transparent;transition:.16s;}",
      ".il-pick:hover{background:#F7FAFD;}",
      ".il-log{display:flex;gap:7px;font-size:11.5px;line-height:1.6;padding:4px 0;border-bottom:1px dashed #F1F4F8;}",
      ".il-mono{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;}"
    ].join("\n");
    document.head.appendChild(st);
  }

  function statusChip(ok, text) {
    var c = ok ? PASTEL.green : PASTEL.danger;
    var bg = ok ? PASTEL.greenSoft : PASTEL.dangerSoft;
    return '<span style="display:inline-flex;align-items:center;gap:5px;font-size:11px;font-weight:700;color:' +
      c + ';background:' + bg + ';border:1px solid ' + (ok ? PASTEL.greenBorder : PASTEL.dangerBorder) +
      ';border-radius:999px;padding:3px 9px;"><span style="width:6px;height:6px;border-radius:50%;background:' +
      c + ';display:inline-block;"></span>' + esc(text) + '</span>';
  }

  function card(title, bodyHtml, opts) {
    opts = opts || {};
    var accent = opts.accent || PASTEL.accent;
    return '<div style="background:#fff;border:1.5px solid ' + (opts.border || PASTEL.border) +
      ';border-radius:14px;padding:14px;margin-bottom:12px;box-shadow:0 1px 3px rgba(44,58,75,0.04);">' +
      '<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:' +
      (bodyHtml ? '10px' : '0') + ';">' +
      '<div style="font-size:13px;font-weight:800;color:' + accent + ';">' + title + '</div>' +
      (opts.right || '') + '</div>' +
      (bodyHtml ? '<div style="font-size:12px;color:' + PASTEL.ink + ';line-height:1.7;">' + bodyHtml + '</div>' : '') +
      '</div>';
  }

  function row(label, control, hint) {
    return '<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;padding:9px 0;border-top:1px solid #F1F4F8;">' +
      '<div style="flex:1;min-width:0;"><div style="font-size:12.5px;font-weight:700;color:' + PASTEL.ink + ';">' + label + '</div>' +
      (hint ? '<div style="font-size:11px;color:' + PASTEL.sub + ';margin-top:2px;line-height:1.5;">' + hint + '</div>' : '') +
      '</div><div style="flex-shrink:0;">' + control + '</div></div>';
  }

  function switchHtml(id, on) {
    return '<label class="il-switch"><input type="checkbox" id="' + id + '"' + (on ? " checked" : "") +
      '><span class="il-track"><span class="il-thumb"></span></span></label>';
  }

  /**
   * 网络桥自检：异步桥（ilinkHttpSubmit/Poll）不会阻塞界面；
   * 只有同步桥的旧版 APK 会让长轮询把整个界面按住几十秒。
   * 这一行让用户在面板上直接看出卡顿修复是否生效。
   */
  function asyncBridgeLabel() {
    if (typeof window === "undefined" || !window.AndroidMCP) return "网页环境（走 fetch）";
    var n = window.AndroidMCP;
    var asyncOk = (typeof n.ilinkHttpSubmit === "function" && typeof n.ilinkHttpPoll === "function");
    if (asyncOk) return "异步（界面不会卡）";
    if (typeof n.sendNativeHttpRequest === "function") {
      return "同步（旧版：长轮询会卡界面，请更新 APK）";
    }
    return "不可用";
  }

  /**
   * 后台防冻结自检。
   *
   * 背景：Blink 用「View 是否 attach 到窗口」判断页面可见性。完全 detached 的 WebView
   * 内部就是 Hidden；隐藏满 5 分钟后 Chromium 启用 intensive throttling，把定时器最小
   * 间隔强制放大到 60 秒 —— 收消息的 setTimeout 链会因此退化，微信服务端判定掉线。
   * 现在的做法是把后台中枢 WebView 挂到一个 1×1 透明悬浮窗上，让页面保持「可见」。
   *
   * 注意 setRendererPriorityPolicy 解决不了这个：那是进程优先级维度，与 Blink 定时器节流无关。
   */
  function backgroundGuardLabel() {
    if (typeof window === "undefined" || !window.AndroidMCP) return "网页环境（不适用）";
    var n = window.AndroidMCP;
    if (typeof n.isCenterOverlayAttached !== "function") return "旧版 APK（后台会被节流）";
    try {
      if (n.isCenterOverlayAttached()) return "已挂悬浮窗（后台不被节流）";
      // 没挂上：可能是「显示在其他应用上层」权限没给
      return "未挂载（后台 5 分钟后会被节流，请给「显示在其他应用上层」权限）";
    } catch (e) { return "未知"; }
  }

  /** 当前用哪种方式收消息 */
  function transportLabel() {
    if (nativeRunning()) return "原生（不依赖网页定时器，后台不会掉）";
    var IL = ilink();
    if (IL && IL.isLoopRunning()) return "网页轮询（旧模式）";
    if (nativeAvailable()) return "待启动";
    return "旧版 APK（只有网页轮询）";
  }

  /** 原生侧是否已经持有游标 */
  function nativeCursorHint() {
    try {
      var st = JSON.parse(window.AndroidMCP.ilinkNativeStatus() || "{}");
      return !!st.hasCursor;
    } catch (e) { return false; }
  }

  function pill(label, value) {
    return '<div style="flex:1;min-width:70px;background:#fff;border:1.5px solid ' + PASTEL.border +
      ';border-radius:11px;padding:8px 10px;text-align:center;">' +
      '<div style="font-size:16px;font-weight:800;color:' + PASTEL.accent + ';">' + value + '</div>' +
      '<div style="font-size:10.5px;color:' + PASTEL.sub + ';margin-top:1px;">' + label + '</div></div>';
  }

  // ---------- 各区块 ----------

  function loginCardHtml() {
    var IL = ilink();
    if (!IL) {
      return card("环境不支持", "iLink 客户端没加载成功，请更新到最新版 APK。",
        { accent: PASTEL.danger, border: PASTEL.dangerBorder });
    }

    if (IL.isLoggedIn()) {
      var bid = IL.getBotId() || "";
      var at = IL.boundAt();
      var body = '<div style="display:flex;flex-direction:column;gap:4px;">' +
        '<div><span style="color:' + PASTEL.sub + ';">账号：</span><span class="il-mono">' +
        esc(bid.slice(0, 18)) + (bid.length > 18 ? "…" : "") + '</span></div>' +
        '<div><span style="color:' + PASTEL.sub + ';">绑定时间：</span>' + (at ? timeStr(at) : "—") + '</div>' +
        '<div><span style="color:' + PASTEL.sub + ';">接收消息：</span>' +
        (receiveRunning() ? (nativeRunning() ? "进行中（原生）" : "进行中") : "未启动") + '</div></div>' +
        '<div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap;">' +
        (receiveRunning()
          ? '<button class="il-btn il-btn-ghost" onclick="wechatBridge.stopReceive()">停止接收</button>'
          : '<button class="il-btn il-btn-primary" onclick="wechatBridge.startReceive()">开始接收</button>') +
        '<button class="il-btn il-btn-ghost" onclick="wechatBridge.relogin()">重新扫码登录</button>' +
        '<button class="il-btn il-btn-ghost" onclick="wechatBridge.logout()">退出登录</button>' +
        '</div>';
      return card("登录", body,
        { right: statusChip(true, "已登录"), accent: PASTEL.green, border: PASTEL.greenBorder });
    }

    // 未登录
    var s = IL.state;
    var qrBlock;
    if (state.qrContent) {
      qrBlock = '<div style="display:flex;justify-content:center;padding:6px 0;">' +
        '<canvas id="il-qr-canvas" style="border-radius:10px;border:1px solid ' + PASTEL.border +
        ';background:#fff;max-width:100%;"></canvas></div>';
    } else {
      qrBlock = '<div style="text-align:center;color:' + PASTEL.sub + ';padding:18px 0;font-size:12px;">' +
        '还没有二维码。点下面的按钮获取。</div>';
    }

    var statusText = {
      "wait": "等待扫码……",
      "scaned": "已扫码，请在手机上确认",
      "need_verifycode": "手机要求输入数字配对码",
      "verifying": "正在校验配对码……",
      "refreshed": "二维码已刷新，请重新扫",
      "expired": "二维码已过期",
      "error": "出错了",
      "timeout": "等待超时",
      "cancelled": "已取消"
    };
    var st = state.busy ? "正在处理……" : (statusText[s.lastStatus] || "");

    var body = qrBlock +
      (st ? '<div style="text-align:center;font-size:12px;color:' + PASTEL.sub + ';margin-top:6px;">' + esc(st) + '</div>' : '') +
      (state.lastError ? '<div style="margin-top:8px;padding:7px 9px;border-radius:9px;background:' + PASTEL.dangerSoft +
        ';color:' + PASTEL.danger + ';font-size:11.5px;line-height:1.6;">' + esc(state.lastError) + '</div>' : '') +
      '<div style="font-size:11.5px;color:' + PASTEL.sub + ';line-height:1.7;margin-top:10px;">' +
      '扫码步骤：点下面按钮出二维码 → 用微信扫一扫 → 手机上点绿色「连接」。' +
      '若微信要求数字配对码，点「输入配对码」填入。</div>' +
      '<div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap;">' +
      '<button class="il-btn il-btn-primary" onclick="wechatBridge.startLogin()">' +
      (state.qrContent ? "重新获取二维码" : "获取二维码") + '</button>' +
      (state.pendingVerify ? '<button class="il-btn il-btn-soft" onclick="wechatBridge.askVerifyCode()">输入配对码</button>' : '') +
      '</div>';

    return card("登录", body, { right: statusChip(false, "未登录"), accent: PASTEL.accent });
  }

  function bindCardHtml(sessions) {
    var b = state.binding;
    var inner = '';
    if (!sessions.length) {
      inner = '<div style="color:' + PASTEL.sub + ';">还没有单聊。先去聊天页新建一个和 char 的单聊，再回来绑定。</div>';
    } else {
      inner = '<div style="display:flex;flex-direction:column;gap:6px;max-height:240px;overflow-y:auto;">';
      sessions.forEach(function (s) {
        var active = b && Number(b.sessionId) === Number(s.id);
        var av = s.avatar
          ? '<img src="' + esc(s.avatar) + '" style="width:32px;height:32px;border-radius:50%;object-fit:cover;flex-shrink:0;">'
          : '<div style="width:32px;height:32px;border-radius:50%;background:' + PASTEL.soft +
            ';display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:800;color:' +
            PASTEL.accent + ';flex-shrink:0;">' + esc(String(s.name).slice(0, 1)) + '</div>';
        inner += '<div class="il-pick" onclick="wechatBridge.bindSession(' + s.id + ')" style="' +
          (active ? 'background:' + PASTEL.soft + ';border-color:' + PASTEL.border + ';' : 'border-color:#EEF2F7;') + '">' +
          av + '<div style="flex:1;min-width:0;"><div style="font-size:12.5px;font-weight:700;color:' + PASTEL.ink +
          ';overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + esc(s.name) + '</div>' +
          '<div style="font-size:11px;color:' + PASTEL.sub + ';">会话 #' + s.id + '</div></div>' +
          (active ? '<span style="font-size:11px;font-weight:800;color:' + PASTEL.green + ';flex-shrink:0;">已绑定</span>'
            : '<span style="font-size:11px;color:' + PASTEL.sub + ';flex-shrink:0;">选择</span>') + '</div>';
      });
      inner += '</div>';
    }
    inner += '<div style="margin-top:10px;font-size:11.5px;color:' + PASTEL.sub + ';line-height:1.7;">' +
      '你在微信里对 ClawBot 说的话，会进入这里选中的那个 char 单聊；char 的回复也会回到那条微信对话里。</div>';
    if (b) {
      inner += '<div style="margin-top:10px;"><button class="il-btn il-btn-ghost" onclick="wechatBridge.unbindSession()">解除绑定</button></div>';
    }
    return card("对接哪个 char", inner, {
      right: b ? statusChip(true, "已绑定") : statusChip(false, "未绑定"),
      accent: b ? PASTEL.green : PASTEL.accent,
      border: b ? PASTEL.greenBorder : PASTEL.border
    });
  }

  function settingsCardHtml() {
    var c = cfg();
    var delay = '<div style="display:flex;gap:8px;align-items:center;justify-content:flex-end;">' +
      '<input id="il-min-delay" class="il-mono" type="number" min="0" max="60" value="' + c.minDelay +
      '" style="width:54px;padding:6px;border:1.5px solid ' + PASTEL.border + ';border-radius:8px;text-align:center;">' +
      '<span style="color:' + PASTEL.sub + '">~</span>' +
      '<input id="il-max-delay" class="il-mono" type="number" min="0" max="120" value="' + c.maxDelay +
      '" style="width:54px;padding:6px;border:1.5px solid ' + PASTEL.border + ';border-radius:8px;text-align:center;">' +
      '<span style="font-size:11px;color:' + PASTEL.sub + ';">秒</span></div>';
    var limit = '<input id="il-hourly-limit" class="il-mono" type="number" min="1" max="200" value="' + c.hourlyLimit +
      '" style="width:60px;padding:6px;border:1.5px solid ' + PASTEL.border + ';border-radius:8px;text-align:center;">' +
      '<span style="font-size:11px;color:' + PASTEL.sub + ';margin-left:5px;">条/小时</span>';

    return card("回信设置",
      row("自动回信", switchHtml("il-sw-auto", c.autoReply),
        "打开后，收到微信消息就自动让 char 回复。默认关闭。") +
      row("随机延迟", delay, "每条之间随机等这么久，别让节奏太机器化。") +
      row("频率上限", limit, "超过就暂停回信，直到下一小时。") +
      row("保存", '<button class="il-btn il-btn-green" onclick="wechatBridge.saveConfig()">保存配置</button>'),
      { accent: PASTEL.accent });
  }

  function statsCardHtml() {
    var IL = ilink();
    var ctx = ctxStats();
    var logged = !!(IL && IL.isLoggedIn());
    var running = receiveRunning();
    var body = '<div style="display:flex;flex-wrap:wrap;gap:8px;">' +
      pill("收到", state.stats.received) + pill("生成回复", state.stats.replied) +
      pill("已发出", state.stats.sent) + pill("已拦截", state.stats.blocked) + '</div>' +
      '<div style="margin-top:10px;font-size:11.5px;color:' + PASTEL.sub + ';line-height:1.8;">' +
      '账号：' + (logged ? "已登录" : "未登录") + ' · 收消息循环：' + (running ? "运行中" : "未运行") + '<br>' +
      '网络桥：' + asyncBridgeLabel() + '<br>' +
      '收消息方式：' + transportLabel() + '<br>' +
      '后台防冻结：' + backgroundGuardLabel() + '<br>' +
      '消息游标：' + (nativeRunning() && nativeAvailable()
        ? (nativeCursorHint() ? "已保存在原生（断线可续）" : "尚未建立")
        : ((IL && IL.getCursor()) ? "已保存（断线可续）" : "尚未建立")) + '<br>' +
      '通道上下文：' + ctx.users + ' 个微信用户 / ' + ctx.turns + ' 条（每用户最多 ' + CTX_MAX_TURNS +
      ' 条，超过 2 小时无动静自动清理）' +
      (state.lastError ? '<br><span style="color:' + PASTEL.danger + ';">最近错误：' + esc(state.lastError) + '</span>' : '') +
      '</div>' +
      '<div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:12px;">' +
      '<button class="il-btn il-btn-ghost" onclick="wechatBridge.clearContext()">清理上下文</button>' +
      '<button class="il-btn il-btn-ghost" onclick="wechatBridge.resetStats()">计数归零</button>' +
      '</div>';
    return card("运行数据", body, { accent: PASTEL.green, border: PASTEL.greenBorder });
  }

  function logCardHtml() {
    var h = '';
    var evts = allEvents();
    if (!evts.length) {
      h = '<div style="color:' + PASTEL.sub + ';font-size:11.5px;">还没有事件。</div>';
    } else {
      evts.slice(0, 16).forEach(function (e) {
        var c = e.tone === "danger" ? PASTEL.danger : e.tone === "warn" ? PASTEL.warn
          : e.tone === "out" ? PASTEL.accent : e.tone === "in" ? PASTEL.green : PASTEL.ink;
        h += '<div class="il-log"><span class="il-mono" style="color:' + PASTEL.sub + ';flex-shrink:0;">' +
          timeStr(e.at) + ' ' + esc(e.src || "") + '</span><span style="color:' + c + ';word-break:break-all;">' + esc(e.text) + '</span></div>';
      });
    }
    return card("事件流", h, { accent: PASTEL.sub, border: "#E7EDF4" });
  }

  function aboutCardHtml() {
    return card("这条通道是什么",
      '<b>能做什么</b>：你在微信里给「微信 ClawBot」发消息，等于跟绑定的 char 说话；' +
      'char 的回复回到同一条对话里。<br><br>' +
      '<b>不能做什么</b>：它<b>不能代替你的微信账号去给好友发消息</b>。这条通道是「ClawBot 联系人 ↔ 你」。<br><br>' +
      '<b>风险说明</b>：走腾讯开放的 iLink 接口、不自动化你的微信客户端，风险远低于模拟操作；' +
      '但腾讯保留对这套接口的控制权（限速、内容过滤、随时终止），<b>并非零风险</b>。' +
      '默认关闭自动回信，请自行控制使用频率。<br><br>' +
      '<b>隐私</b>：登录凭据（bot_token）只存在本机 App 内，不会上传到任何第三方。',
      { accent: PASTEL.sub, border: "#E7EDF4" });
  }

  async function renderPanel() {
    var host = panelBody();
    if (!host) return;
    cssOnce();
    state.binding = loadBinding();

    // 保活与兜底的健康快照：这是判断「离开 App 后为什么没回信」最关键的一块信息
    state.keepAlive = readNativeJson("keepAliveStatus");
    state.fallback = readNativeJson("ilinkFallbackStatus");

    var sessions = await listCharSessions();
    host.innerHTML = '<div style="padding:4px 2px 14px;">' +
      loginCardHtml() +
      keepAliveCardHtml() +
      bindCardHtml(sessions) +
      settingsCardHtml() +
      statsCardHtml() +
      logCardHtml() +
      aboutCardHtml() +
      '</div>';

    bindControls();
    if (state.qrContent) drawQr(state.qrContent);
  }

  /** 安全读取原生返回的 JSON（旧版 APK 没有这些接口时返回 null） */
  function readNativeJson(fnName) {
    try {
      if (typeof window === "undefined" || !window.AndroidMCP) return null;
      if (typeof window.AndroidMCP[fnName] !== "function") return null;
      var raw = window.AndroidMCP[fnName]();
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (e) { return null; }
  }

  function fmtDur(ms) {
    if (!ms || ms < 0) return "—";
    var s = Math.round(ms / 1000);
    if (s < 60) return s + " 秒";
    var m = Math.round(s / 60);
    if (m < 60) return m + " 分钟";
    return (m / 60).toFixed(1) + " 小时";
  }

  /**
   * 保活与兜底诊断卡。
   *
   * 为什么单独做一张卡：真机上「离开 App 后收不到/回不了」有三个完全不同的故障点
   * （进程被 ROM 清掉 / WebView 被冻结 / 长轮询线程掉了），以前全靠猜。这里把
   * 原生侧的真实状态直接摊开，一眼就能看出卡在哪一环。
   */
  function keepAliveCardHtml() {
    if (typeof window === "undefined" || !window.AndroidMCP) {
      return card("保活状态", "网页环境：不适用（此卡片只在 APK 里有意义）",
        { accent: PASTEL.sub, border: "#E7EDF4" });
    }
    var ka = state.keepAlive;
    var fb = state.fallback;
    if (!ka) {
      return card("保活状态", "当前 APK 版本较旧，没有保活诊断接口。请更新到最新版 APK。",
        { accent: PASTEL.danger, border: PASTEL.dangerBorder });
    }

    var serviceOk = !!ka.serviceAlive;
    var batteryOk = !!ka.ignoringBattery;
    var pollerOk = nativeRunning() && !!(nativeStatus() || {}).running;
    var webOk = fb ? !!fb.webConsumerAlive : false;

    var rows = "";
    rows += row("常驻服务", statusChip(serviceOk, serviceOk ? "运行中" : "已停止"),
      "进程内的前台守护服务。它没了，长轮询也会一起没。");
    rows += row("微信收发线程", statusChip(pollerOk, pollerOk ? "运行中" : "未运行"),
      pollerOk ? "原生线程在跑，不受网页冻结影响。" : "点下面的「立即体检修复」重启它。");
    rows += row("网页应答端", statusChip(webOk, webOk ? "在线" : "不在线（原生兜底接管）"),
      webOk ? "网页活着，回复由网页生成（质量最高）。"
        : "网页被冻结或已回收，回复改由 App 底层直接生成并发出。");
    rows += row("看门狗闹钟", statusChip(!!ka.armed, ka.armed ? ("下次 " + fmtDur(ka.alarmInMs) + " 后") : "未开启"),
      "进程被系统清掉后，靠这个闹钟把它拉回来。");
    rows += row("电池优化白名单", statusChip(batteryOk, batteryOk ? "已加入" : "未加入"),
      batteryOk ? "系统不会在息屏后清理本应用。"
        : "国产 ROM（小米/华为/OPPO/vivo/荣耀）息屏后必然清进程，务必加入。");
    rows += row("累计自救次数", '<span class="il-mono">' + (ka.reviveCount || 0) + "</span>",
      "看门狗发现服务已死并把它拉起来的次数。持续增长 = ROM 在反复清你。");

    if (fb) {
      rows += row("原生兜底回信", fb.hasSnapshot
        ? statusChip(true, "已就绪（" + fmtDur(fb.snapshotAgeMs) + "前更新）")
        : statusChip(false, "缺少上下文快照"),
        fb.hasSnapshot
          ? ("模型：" + esc(fb.snapshotApiModel || "—") + "；本小时还能发 " + fb.hourlyRemaining + " 条。")
          : "先在 App 里正常聊一次绑定的会话，原生就会拿到上下文。");
      rows += row("兜底已回信", '<span class="il-mono">' + (fb.sentTotal || 0) + " 条</span>",
        fb.lastSentAt ? ("最近一次：" + timeStr(fb.lastSentAt)) : "还没发生过（说明网页一直活着，是好事）。");
      if (fb.pendingLog) {
        rows += row("待补录进聊天库", '<span class="il-mono">' + fb.pendingLog + " 条</span>",
          "底层代回的消息会在本页恢复后自动补进对应聊天记录，正常情况下几秒内清零。");
      }
      if (fb.lastError) {
        rows += '<div style="margin-top:8px;padding:7px 9px;border-radius:9px;background:' + PASTEL.dangerSoft +
          ';color:' + PASTEL.danger + ';font-size:11.5px;line-height:1.6;">兜底最近一次失败：' +
          esc(fb.lastError) + '</div>';
      }
    }

    var actions = '<div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap;">' +
      '<button class="il-btn il-btn-primary" onclick="wechatBridge.reviveNow()">立即体检修复</button>' +
      (batteryOk ? "" :
        '<button class="il-btn il-btn-green" onclick="wechatBridge.requestBatteryWhitelist()">加入电池白名单</button>') +
      '<button class="il-btn il-btn-ghost" onclick="wechatBridge.openSystemSettings()">打开系统设置</button>' +
      '</div>';

    var hint = ka.brandHint
      ? '<div style="margin-top:10px;padding:8px 10px;border-radius:9px;background:#FFF8E8;border:1px solid #F3E2B8;' +
        'color:#8A6A1F;font-size:11.5px;line-height:1.65;">' +
        '<b>本机（' + esc(ka.brand || "未知品牌") + '）还需要手动做一步</b><br>' + esc(ka.brandHint) + '</div>'
      : "";

    var overall = (serviceOk && pollerOk && batteryOk) ? true : false;
    return card("保活与兜底", rows + actions + hint, {
      accent: overall ? PASTEL.green : PASTEL.danger,
      border: overall ? PASTEL.greenBorder : PASTEL.dangerBorder,
      right: statusChip(overall, overall ? "配置完整" : "有缺口")
    });
  }

  /** 用本地二维码库把内容画到 canvas 上 */
  function drawQr(content) {
    var cv = document.getElementById("il-qr-canvas");
    if (!cv || !content) return;
    if (typeof window.qrcode !== "function") {
      state.lastError = "二维码库未加载（qrcode-generator.js 缺失）";
      return;
    }
    try {
      var qr = window.qrcode(0, "M");   // 0 = 自动选版本，等级 M
      qr.addData(content, "Byte");
      qr.make();
      var n = qr.getModuleCount();
      var scale = 5, margin = 4;
      var px = (n + margin * 2) * scale;
      cv.width = px;
      cv.height = px;
      var ctx = cv.getContext("2d");
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, px, px);
      ctx.fillStyle = "#000000";
      for (var r = 0; r < n; r++) {
        for (var c = 0; c < n; c++) {
          if (qr.isDark(r, c)) ctx.fillRect((c + margin) * scale, (r + margin) * scale, scale, scale);
        }
      }
      cv.style.width = "min(200px, 58vw)";
      cv.style.height = "auto";
    } catch (e) {
      state.lastError = "二维码渲染失败：" + String(e && e.message || e);
    }
  }

  function bindControls() {
    var sw = document.getElementById("il-sw-auto");
    if (sw) sw.onchange = function () { setAutoReply(this.checked); };
  }

  // =========================================================================
  // 对外动作
  // =========================================================================

  async function startLogin() {
    var IL = ilink();
    if (!IL) { toast("iLink 客户端未加载"); return; }
    if (state.busy) { toast("正在处理，请稍候"); return; }
    state.busy = true;
    state.lastError = "";
    state.qrContent = "";
    await renderPanel();

    state.loginRun = IL.startLogin({
      onQrcode: function (content) {
        state.qrContent = content;
        renderPanel().then(function () { drawQr(content); });
      },
      onState: function (s) {
        if (s.status === "error" || s.status === "expired" || s.status === "timeout") {
          state.lastError = s.error || "";
        }
        if (s.status === "confirmed") {
          state.busy = false;
          state.qrContent = "";
          logEvent("登录成功", "ok");
          toast("微信已连接");
          refreshPanelIfOpen();
          return;
        }
        refreshPanelIfOpen();
      },
      waitVerifyCode: function () {
        return new Promise(function (resolve) {
          state.pendingVerify = resolve;
          refreshPanelIfOpen();
          toast("手机要求配对码，请点「输入配对码」");
        });
      }
    });

    state.loginRun.promise.then(function (r) {
      state.busy = false;
      if (!r.ok && r.error) state.lastError = r.error;
      refreshPanelIfOpen();
    });
  }

  function askVerifyCode() {
    var code = window.prompt("请输入手机上显示的配对码");
    if (code === null) return;
    code = String(code).trim();
    if (!code) return;
    if (state.pendingVerify) {
      var f = state.pendingVerify;
      state.pendingVerify = null;
      f(code);
      refreshPanelIfOpen();
    }
  }

  async function relogin() {
    var IL = ilink();
    if (!IL) return;
    await stopLoop();
    IL.clearLogin();
    state.qrContent = "";
    state.lastError = "";
    toast("已清除登录态，请重新扫码");
    renderPanel();
  }

  async function logout() {
    var IL = ilink();
    if (!IL) return;
    if (!window.confirm("退出登录会清除本机的微信登录凭据，需要重新扫码。继续？")) return;
    await stopLoop();
    IL.clearLogin();
    // 清掉原生侧的上下文快照与兜底计数：换账号后旧上下文不该被复用
    try {
      if (window.AndroidMCP && typeof window.AndroidMCP.ilinkClearContextSnapshot === "function") {
        window.AndroidMCP.ilinkClearContextSnapshot();
      }
    } catch (e) { }
    state.qrContent = "";
    toast("已退出登录");
    renderPanel();
  }

  function startReceive() {
    if (startLoop()) { toast("已开始接收微信消息"); refreshPanelIfOpen(); }
  }

  // ---------- 保活相关的用户动作 ----------

  /** 立即体检：把常驻服务、看门狗、原生长轮询都重新拉一遍 */
  function reviveNow() {
    try {
      if (!window.AndroidMCP || typeof window.AndroidMCP.keepAliveReviveNow !== "function") {
        toast("当前 APK 版本较旧，请更新后再试");
        return;
      }
      window.AndroidMCP.keepAliveReviveNow();
      // 原生重启轮询后，网页这边的拉取循环也要跟着起（停止状态下用户手动修的话）
      logEvent("已执行保活体检修复", "ok");
      toast("已重新拉起服务与收发线程");
      setTimeout(refreshPanelIfOpen, 800);
    } catch (e) {
      toast("体检失败：" + String(e && e.message || e));
    }
  }

  /** 申请加入系统电池优化白名单（国产 ROM 保活的关键一步） */
  function requestBatteryWhitelist() {
    try {
      if (!window.AndroidMCP || typeof window.AndroidMCP.requestIgnoreBatteryOptimizations !== "function") {
        toast("当前 APK 版本较旧，请更新后再试");
        return;
      }
      window.AndroidMCP.requestIgnoreBatteryOptimizations();
      toast("请在系统弹窗里点「允许」");
      logEvent("已请求加入电池优化白名单", "info");
    } catch (e) {
      toast("打开失败，请手动到系统设置里允许后台运行");
    }
  }

  /** 打开本应用的系统详情页（自启动开关通常在里面） */
  function openSystemSettings() {
    try {
      if (window.AndroidMCP && typeof window.AndroidMCP.openAppDetailSettings === "function") {
        window.AndroidMCP.openAppDetailSettings();
      } else {
        toast("请手动进入系统设置 → 应用管理");
      }
    } catch (e) {
      toast("请手动进入系统设置 → 应用管理");
    }
  }

  async function stopReceive() {
    await stopLoop();
    toast("已停止接收微信消息");
  }

  function bindSession(id) {
    getSessionName(id).then(function (n) {
      state.binding = { sessionId: Number(id), userName: n };
      saveBinding(state.binding);
      logEvent("已绑定 char：" + (n || ("#" + id)), "ok");
      toast("已绑定 " + (n || ("会话 #" + id)));
      renderPanel();
    });
  }

  function unbindSession() {
    state.binding = null;
    saveBinding(null);
    toast("已解除绑定");
    renderPanel();
  }

  function setAutoReply(on) {
    localStorage.setItem(K.autoReply, on ? "true" : "false");
    if (on) localStorage.setItem(K.riskAccepted, "true");
    logEvent(on ? "自动回信：已打开" : "自动回信：已关闭", on ? "warn" : "info");
    toast(on ? "自动回信已打开" : "自动回信已关闭");
    renderPanel();
  }

  function saveConfig() {
    var mn = document.getElementById("il-min-delay"),
        mx = document.getElementById("il-max-delay"),
        hl = document.getElementById("il-hourly-limit");
    var a = Math.max(0, Math.min(60, parseInt(mn && mn.value, 10)));
    var b = Math.max(0, Math.min(120, parseInt(mx && mx.value, 10)));
    if (isNaN(a)) a = DEFAULTS.minDelay;
    if (isNaN(b)) b = DEFAULTS.maxDelay;
    if (b < a) b = a;
    var c = Math.max(1, Math.min(200, parseInt(hl && hl.value, 10) || DEFAULTS.hourlyLimit));
    localStorage.setItem(K.minDelay, String(a));
    localStorage.setItem(K.maxDelay, String(b));
    localStorage.setItem(K.hourlyLimit, String(c));
    toast("已保存：" + a + "-" + b + " 秒延迟，每小时最多 " + c + " 条");
    renderPanel();
  }

  function clearContext() {
    saveCtxLog({});
    logEvent("通道上下文已清理", "info");
    toast("通道上下文已清理");
    renderPanel();
  }

  function resetStats() {
    state.stats = { received: 0, replied: 0, sent: 0, blocked: 0 };
    state.sentTimestamps = [];
    toast("计数已归零");
    renderPanel();
  }

  function openPanel() {
    if (typeof window.openMeSub === "function") window.openMeSub("wechat-bridge");
    else renderPanel();
  }

  // =========================================================================
  // 启动
  // =========================================================================

  function boot() {
    try {
      state.binding = loadBinding();
      saveCtxLog(pruneCtxLog(loadCtxLog()));
      var IL = ilink();
      if (IL && IL.isLoggedIn() && state.binding && state.binding.sessionId) {
        startLoop();
      }
      document.addEventListener("visibilitychange", function () {
        if (document.visibilityState !== "visible") return;
        var L = ilink();
        if (L && L.isLoggedIn() && state.binding && state.binding.sessionId && !receiveRunning()) {
          startLoop();
        }
      });
    } catch (e) { console.warn("[ilink] 启动失败", e); }
  }

  window.wechatBridge = {
    openPanel: openPanel,
    renderPanel: renderPanel,
    startLogin: startLogin,
    askVerifyCode: askVerifyCode,
    relogin: relogin,
    logout: logout,
    startReceive: startReceive,
    stopReceive: stopReceive,
    bindSession: bindSession,
    unbindSession: unbindSession,
    saveConfig: saveConfig,
    setAutoReply: setAutoReply,
    clearContext: clearContext,
    resetStats: resetStats,
    cleanOutbound: cleanOutbound,
    cleanInbound: cleanInbound,
    ctxStats: ctxStats,
    listCharSessions: listCharSessions,
    onNativePending: onNativePending,
    pullNativePending: pullNativePending,
    onNativeReplied: onNativeReplied,
    reviveNow: reviveNow,
    requestBatteryWhitelist: requestBatteryWhitelist,
    openSystemSettings: openSystemSettings,
    state: state
  };

  /** 供 app_chat.generateReplyForSession 在发请求前调用（挂全局，跨模块调用） */
  window.saveWechatContextSnapshot = function (sid, messagesToSend, activeApi, charName, myName) {
    return saveWechatContextSnapshot(sid, messagesToSend, activeApi, charName, myName);
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
