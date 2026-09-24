/**
 * app_wechat_bridge.js - 微信接入（无障碍通道）
 * ---------------------------------------------------------------------------
 * 干什么：
 *   把「真实微信」接到叙事诗小手机里 —— 用安卓无障碍服务读微信新消息，
 *   交给绑定的 char 会话生成回复，再（按开关）把回复写回微信发出去。
 *
 * 为什么是无障碍而不是改数据库：
 *   打字、点发送走的是微信自己的客户端流程，服务端看到的就是一条普通消息。
 *   改本机数据库那种做法微信的内存态会覆盖，且消息没经过服务端，更容易出问题。
 *
 * 安全边界（有意为之，别放松）：
 *   · 只监听微信（com.tencent.mm），其它 App 完全不碰。
 *   · 原生侧发送前必须复核「当前会话名 == 目标会话名」，不一致一律不发。
 *   · 接收和自动回信都默认关闭，必须用户自己打开。
 *   · 回信带随机延迟与频率上限，避免机器化的固定节奏。
 *   · 出入站都做标签清洗，只发干净文本，不把 CoT / 心声 / 卡片指令漏到微信。
 *
 * UI 规范：无 Emoji、纯 SVG 图标、自绘卡片、淡彩配色。
 */
(function () {
  "use strict";

  // ---------- 淡彩主题（沿用全局上下文管理器的冷色规范：蓝 / 靛 / 青） ----------
  var PASTEL = {
    accent: "#4A7DBF",
    soft: "#EAF2FB",
    border: "#CFE1F3",
    green: "#35867A",
    greenSoft: "#E9F5F2",
    greenBorder: "#CDE9E3",
    warn: "#B4794A",
    warnSoft: "#FBF3EA",
    warnBorder: "#F0DFC9",
    danger: "#C05B6A",
    dangerSoft: "#FBEDEF",
    dangerBorder: "#F2D5DA",
    ink: "#2C3A4B",
    sub: "#7A8A9C"
  };

  // ---------- 出站清洗：已知的卡片指令标记 ----------
  // 这些标记代表 App 内部的多媒体/交易卡片，微信里没有对应物，必须剥掉。
  // 只列「明确是指令」的标记，避免把角色正在说的话（例如 [点头]）误删。
  var CARD_CMD_TAGS = {
    TRANSFER: 1, RED_ENVELOPE: 1, RECEIVE_TRANSFER: 1, OPEN_RED_ENVELOPE: 1,
    VOICE: 1, IMAGE: 1, LOCATION: 1, PAY_FOR_ME: 1, GIFT: 1, AGREE_PAY: 1,
    MP_INVITE: 1, AUTO_CALL: 1, CHECK_PHONE: 1, SPLIT: 1, QUOTE: 1,
    STATUS: 1, TRANSLATE: 1
  };

  // ---------- 存储键 ----------
  var K = {
    bindSession: "wx-bridge-bind-session",
    listen: "wx-bridge-listen",
    autoReply: "wx-bridge-auto-reply",
    autoNavigate: "wx-bridge-auto-navigate",
    replyMode: "wx-bridge-reply-mode",          // 'text' | 'text_voice_note'
    minDelay: "wx-bridge-min-delay",
    maxDelay: "wx-bridge-max-delay",
    hourlyLimit: "wx-bridge-hourly-limit",
    echoToApp: "wx-bridge-echo-to-app",
    riskAccepted: "wx-bridge-risk-accepted",
    ctxLog: "wx-bridge-ctx-log"                 // 通道上下文日志（按会话分组，带上限）
  };

  var DEFAULTS = {
    listen: false,
    autoReply: false,
    autoNavigate: true,
    replyMode: "text",
    minDelay: 3,
    maxDelay: 8,
    hourlyLimit: 20,
    echoToApp: true
  };

  // ---------- 上下文清理参数 ----------
  var CTX_MAX_CONVERSATIONS = 12;   // 最多保留多少个微信会话的短期上下文
  var CTX_MAX_TURNS = 40;           // 每个会话最多保留多少条通道记录
  var CTX_TTL_MS = 2 * 60 * 60 * 1000;  // 超过 2 小时没动静的会话上下文直接丢弃

  // ---------- 运行时状态 ----------
  var state = {
    polling: false,
    pollTimer: null,
    pollBusy: false,
    lastStatus: null,
    lastError: "",
    stats: { received: 0, replied: 0, sent: 0, blocked: 0 },
    recentLog: [],                 // 界面上的事件流（最多 30 条）
    lastSentAt: 0,
    lastProbe: null,
    replyBusy: {},                 // sessionId -> true，防同会话并发请求
    sentTimestamps: []             // 用于小时频率限制
  };

  // =========================================================================
  // 基础工具
  // =========================================================================

  function toast(msg) {
    try {
      if (typeof window.showToast === "function") window.showToast(msg);
      else console.log("[wechat]", msg);
    } catch (e) { }
  }

  function esc(s) {
    if (s === null || s === undefined) return "";
    return String(s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function native() {
    // APK 环境才有；PWA/浏览器里为 undefined
    return (typeof window.AndroidMCP !== "undefined" && window.AndroidMCP) ? window.AndroidMCP : null;
  }

  function hasNative(name) {
    var n = native();
    return !!(n && typeof n[name] === "function");
  }

  function readBool(key, dflt) {
    var v = localStorage.getItem(key);
    if (v === null) return dflt;
    return v === "true";
  }

  function readNum(key, dflt) {
    var v = parseInt(localStorage.getItem(key), 10);
    return isNaN(v) ? dflt : v;
  }

  function cfg() {
    return {
      listen: readBool(K.listen, DEFAULTS.listen),
      autoReply: readBool(K.autoReply, DEFAULTS.autoReply),
      autoNavigate: readBool(K.autoNavigate, DEFAULTS.autoNavigate),
      replyMode: localStorage.getItem(K.replyMode) || DEFAULTS.replyMode,
      minDelay: readNum(K.minDelay, DEFAULTS.minDelay),
      maxDelay: readNum(K.maxDelay, DEFAULTS.maxDelay),
      hourlyLimit: readNum(K.hourlyLimit, DEFAULTS.hourlyLimit),
      echoToApp: readBool(K.echoToApp, DEFAULTS.echoToApp)
    };
  }

  function boundSessionId() {
    var v = parseInt(localStorage.getItem(K.bindSession) || "0", 10);
    return isNaN(v) ? 0 : v;
  }

  function logEvent(text, tone) {
    state.recentLog.unshift({ at: Date.now(), text: text, tone: tone || "info" });
    if (state.recentLog.length > 30) state.recentLog.length = 30;
  }

  function timeStr(ts) {
    try {
      var d = new Date(ts);
      var p = function (n) { return String(n).padStart(2, "0"); };
      return p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
    } catch (e) { return ""; }
  }

  // =========================================================================
  // 标签清洗（出入站双向）
  // =========================================================================

  /**
   * 从 s[0]（必须是 { 或 [）开始找配平的结尾，返回「结尾之后」的下标；找不到返回 -1。
   * 会跳过字符串字面量内部的括号与转义，所以多层嵌套也能正确截断。
   * 用循环而不是正则，是因为「剥掉卡片指令但不吞后面的对白」必须精确知道 JSON 到哪结束。
   */
  function balancedJsonEnd(s) {
    if (!s || (s.charAt(0) !== "{" && s.charAt(0) !== "[")) return -1;
    var open = s.charAt(0);
    var close = open === "{" ? "}" : "]";
    var depth = 0;
    var inStr = false;
    var quote = "";
    for (var i = 0; i < s.length; i++) {
      var c = s.charAt(i);
      if (inStr) {
        if (c === "\\") { i++; continue; }
        if (c === quote) inStr = false;
        continue;
      }
      if (c === '"' || c === "'") { inStr = true; quote = c; continue; }
      if (c === "{" || c === "[") depth++;
      else if (c === "}" || c === "]") {
        depth--;
        if (depth === 0) return i + 1;
      }
    }
    return -1;
  }

  var CARD_CMD_ZH = {
    "转账": 1, "红包": 1, "收钱": 1, "收转账": 1, "拆红包": 1, "领红包": 1,
    "语音": 1, "图片": 1, "位置": 1, "代付": 1, "送礼": 1, "同意代付": 1
  };

  /**
   * 扫描全文，把所有已知卡片指令剥掉（连同紧跟其后的 JSON 负载）。
   * 未知的方括号内容（例如角色说的「[点头] 好呀」）原样保留 —— 宁可不删，也不能误删对白。
   */
  function stripCardCommands(text) {
    var out = "";
    var i = 0;
    var n = text.length;
    while (i < n) {
      var c = text.charAt(i);
      var openLen = (c === "[" || c === "【") ? 1 : 0;
      if (!openLen) { out += c; i++; continue; }
      // 找到配对的右括号
      var closeIdx = -1;
      for (var j = i + 1; j < n && j < i + 40; j++) {
        var cj = text.charAt(j);
        if (cj === "]" || cj === "】") { closeIdx = j; break; }
        if (cj === "\n") break;
      }
      if (closeIdx < 0) { out += c; i++; continue; }
      var raw = text.substring(i + 1, closeIdx);
      var tag = raw.split(/[:：\s]/)[0];
      var known = CARD_CMD_TAGS[tag] !== undefined || CARD_CMD_ZH[tag] !== undefined;
      if (!known) { out += text.substring(i, closeIdx + 1); i = closeIdx + 1; continue; }

      // 是指令：连同后面的 JSON 负载一起吃
      var after = closeIdx + 1;
      var k = after;
      while (k < n && /\s/.test(text.charAt(k))) k++;
      var payload = text.charAt(k);
      if (payload === "{" || payload === "[") {
        var end = balancedJsonEnd(text.substring(k));
        if (end >= 0) after = k + end;
      }
      i = after;
      // 指令被剥掉的位置补一个空格，避免把前后两句话粘成一个词
      if (out.length && !/\s$/.test(out)) out += " ";
    }
    return out;
  }

  /**
   * 出站清洗：把要发到微信的文本里的所有 App 内部标记剥掉。
   * 微信那边只应该收到「人话」，不能出现 CoT、心声、卡片指令、HTML 等。
   */
  function cleanOutbound(raw) {
    if (!raw) return "";
    var t = String(raw);
    t = t.replace(/<think>[\s\S]*?<\/think>/gi, "");
    t = t.replace(/<\/?think>/gi, "");
    t = t.replace(/[\[【]STATUS[\]】][\s\S]*$/gi, "");
    t = t.replace(/[\[\u3010]TRANSLATE[\]\u3011][\s\S]*?[\[\u3010]\/TRANSLATE[\]\u3011]/gi, "");
    t = t.replace(/[\[【]TRANSLATE[\]】[\s\S]*$/gi, "");
    // 引用指令 [QUOTE:12] —— 微信里没有对应的消息 ID，直接去掉前缀
    t = t.replace(/[\[【](QUOTE|引用)\s*[:：]\s*\d+[\]】]\s*/gi, "");
    // 多媒体 / 交易 / 分享等卡片指令：指令块后面跟着一段 JSON 负载，连块一起剥。
    // 关键：只吃到 JSON 真正结束（配平大括号/方括号），不能一路吃到字符串结尾 —— 否则会把
    // 指令后面真正的对白一起吞掉（例如「[IMAGE]{...} 结束」里的「结束」）。
    // 用一次全文扫描处理所有指令，避免「只替换第一个」的陷阱。
    t = stripCardCommands(t);
    // 表情包与分句标记
    t = t.replace(/[\[【]表情包[:：][^\]】]*[\]】]/g, "");
    t = t.replace(/[\[【]SPLIT[\]】]/gi, "");
    t = t.replace(/__TR\d+__/g, "");
    // 残留兜底：上面按标记剥过之后，可能还剩孤立的 JSON 负载片段（嵌套大括号、写坏的指令等）。
    // 只删「明显是 JSON 结构」的行内片段：必须以 { 或 [ 开头且紧跟 "键": 形式。
    // 不满足这个形状的一律保留，宁可留一点脏，也不能误删角色真正说的话。
    t = t.replace(/\[\s*"[^"\n]{1,40}"\s*:[^\]\n]{0,400}\]/g, "");
    t = t.replace(/\{\s*"[^"\n]{1,40}"\s*:[^}\n]{0,600}\}/g, "");
    // 反过来：只剩下一个孤立右大括号的残渣（前面被剥掉时留下的尾巴）
    t = t.replace(/(^|\n)\s*[\}\]]\s*(\n|$)/g, "$1$2");
    // HTML 标签与 Markdown 常见痕迹
    t = t.replace(/<[^>\n]{1,80}>/g, "");
    t = t.replace(/```[\s\S]*?```/g, "");
    // 折叠空白
    t = t.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
    return t;
  }

  /** 入站清洗：微信抓来的原文可能有零宽字符、多余换行等 */
  function cleanInbound(raw) {
    if (!raw) return "";
    var t = String(raw);
    t = t.replace(/[\u200b-\u200f\ufeff]/g, "");
    t = t.replace(/[ \t]+/g, " ");
    return t.trim();
  }

  // =========================================================================
  // 通道上下文（按微信会话隔离的短期记忆 + 上限 + 老化清理）
  // =========================================================================

  function loadCtxLog() {
    try {
      var raw = localStorage.getItem(K.ctxLog);
      if (!raw) return {};
      var obj = JSON.parse(raw);
      return (obj && typeof obj === "object") ? obj : {};
    } catch (e) { return {}; }
  }

  function saveCtxLog(obj) {
    try { localStorage.setItem(K.ctxLog, JSON.stringify(obj)); } catch (e) { }
  }

  /**
   * 清理通道上下文：
   *   1) 丢掉超过 TTL 没动静的会话；
   *   2) 每个会话只留最后 CTX_MAX_TURNS 条；
   *   3) 会话数超过上限时，按最后活跃时间淘汰最旧的。
   * 这是「上下文清理」要求里的第一层：保证通道自己的短期记忆不无限增长。
   */
  function pruneCtxLog(obj) {
    var now = Date.now();
    Object.keys(obj).forEach(function (name) {
      var item = obj[name];
      if (!item || !Array.isArray(item.turns)) { delete obj[name]; return; }
      if (now - (item.updated || 0) > CTX_TTL_MS) { delete obj[name]; return; }
      if (item.turns.length > CTX_MAX_TURNS) {
        item.turns = item.turns.slice(item.turns.length - CTX_MAX_TURNS);
      }
      // 单条也要过一遍出站清洗，防止历史里残留旧标记
      item.turns = item.turns.map(function (t) {
        return { role: t.role, text: cleanOutbound(t.text), at: t.at };
      }).filter(function (t) { return !!t.text; });
    });
    var names = Object.keys(obj);
    if (names.length > CTX_MAX_CONVERSATIONS) {
      names.sort(function (a, b) { return (obj[a].updated || 0) - (obj[b].updated || 0); });
      names.slice(0, names.length - CTX_MAX_CONVERSATIONS).forEach(function (n) { delete obj[n]; });
    }
    return obj;
  }

  function ctxPush(conversation, role, text, sessionId) {
    var clean = role === "in" ? cleanInbound(text) : cleanOutbound(text);
    if (!clean) return;
    var obj = pruneCtxLog(loadCtxLog());
    if (!obj[conversation]) obj[conversation] = { turns: [], updated: 0, sessionId: 0 };
    if (sessionId) obj[conversation].sessionId = Number(sessionId);
    obj[conversation].turns.push({ role: role, text: clean, at: Date.now() });
    obj[conversation].updated = Date.now();
    obj = pruneCtxLog(obj);
    saveCtxLog(obj);
  }

  function ctxClear(conversation) {
    var obj = loadCtxLog();
    if (conversation) delete obj[conversation];
    else obj = {};
    saveCtxLog(obj);
  }

  function ctxStats() {
    var obj = pruneCtxLog(loadCtxLog());
    var sessions = Object.keys(obj);
    var turns = 0;
    sessions.forEach(function (n) { turns += (obj[n].turns || []).length; });
    return { sessions: sessions.length, turns: turns };
  }

  // =========================================================================
  // 会话匹配：微信会话名 <-> App 里的 char 单聊
  // =========================================================================

  /** 取当前「我的人设」下的全部单聊（排除群聊），带角色名与备注 */
  async function listCharSessions() {
    try {
      var out = [];
      var userIdNum = Number(window.activeUserPersonaId || localStorage.getItem("active_me_id") || 0);
      var list = userIdNum
        ? await db.sessions.where("userId").equals(userIdNum).toArray()
        : await db.sessions.toArray();
      for (var i = 0; i < list.length; i++) {
        var s = list[i];
        if (s.isGroup === 1) continue;               // 只取单聊
        var char = null;
        try { char = await db.archives.get(s.charId); } catch (e) { }
        var name = s.customCharName || (char && char.name) || "未知角色";
        out.push({
          id: s.id,
          name: name,
          remark: s.charRemark || "",
          avatar: s.customCharAvatar || (char && char.avatar) || null,
          // 微信里显示的名字可能是角色名，也可能是备注，两个都拿来匹配
          matchKeys: [name, s.charRemark || ""].filter(Boolean)
        });
      }
      return out;
    } catch (e) {
      console.warn("[wechat] 读取单聊列表失败:", e);
      return [];
    }
  }

  /** 用微信会话名反查绑定的 App 会话（先精确，再去空格/大小写兜底） */
  async function matchSessionByConversation(conversation) {
    if (!conversation) return null;
    var list = await listCharSessions();
    var target = String(conversation).trim();
    var lower = target.toLowerCase();
    for (var i = 0; i < list.length; i++) {
      if (list[i].matchKeys.indexOf(target) >= 0) return list[i];
    }
    for (var j = 0; j < list.length; j++) {
      for (var k = 0; k < list[j].matchKeys.length; k++) {
        if (list[j].matchKeys[k].trim().toLowerCase() === lower) return list[j];
      }
    }
    return null;
  }

  // =========================================================================
  // 与原生层通信
  // =========================================================================

  function a11yEnabled() {
    if (!hasNative("wechatA11yIsEnabled")) return false;
    try {
      var r = JSON.parse(window.AndroidMCP.wechatA11yIsEnabled());
      return !!(r && r.enabled);
    } catch (e) { return false; }
  }

  function a11yStatus() {
    if (!hasNative("wechatA11yStatus")) return null;
    try { return JSON.parse(window.AndroidMCP.wechatA11yStatus()); }
    catch (e) { return null; }
  }

  /** 把界面上的开关同步给原生服务 */
  function pushConfig() {
    if (!hasNative("wechatA11yConfigure")) return;
    var c = cfg();
    try {
      // 白名单：只处理「已绑定会话」对应的微信名，避免把别的聊天也读进来
      var allow = [];
      var sid = boundSessionId();
      if (sid) {
        var obj = pruneCtxLog(loadCtxLog());
        Object.keys(obj).forEach(function (n) {
          if (obj[n].sessionId === sid) allow.push(n);
        });
      }
      window.AndroidMCP.wechatA11yConfigure(c.listen, c.autoReply, c.autoNavigate, JSON.stringify(allow));
    } catch (e) {
      console.warn("[wechat] 下发配置失败:", e);
    }
  }

  // =========================================================================
  // 消息泵：轮询原生收件箱 → 落进 App 会话 → 触发 char 回复 → 回写微信
  // =========================================================================

  function startPolling() {
    if (state.polling) return;
    state.polling = true;
    var tick = async function () {
      try { await pumpOnce(); } catch (e) { console.warn("[wechat] 轮询异常:", e); }
      if (state.polling) state.pollTimer = setTimeout(tick, 2500);
    };
    state.pollTimer = setTimeout(tick, 1200);
    logEvent("通道已启动，开始轮询微信新消息", "ok");
  }

  function stopPolling() {
    state.polling = false;
    if (state.pollTimer) { clearTimeout(state.pollTimer); state.pollTimer = null; }
  }

  async function pumpOnce() {
    if (state.pollBusy) return;
    if (!hasNative("wechatA11yDrainInbox")) return;
    var c = cfg();
    // 接收开关是总闸：关掉就完全不读微信。
    // 自动回信只决定「读到之后要不要发出去」，不决定要不要读。
    if (!c.listen) return;
    if (!a11yEnabled()) return;

    state.pollBusy = true;
    try {
      var raw = window.AndroidMCP.wechatA11yDrainInbox(20);
      var res = JSON.parse(raw || "{}");
      state.lastStatus = a11yStatus();
      var msgs = (res && res.messages) || [];
      for (var i = 0; i < msgs.length; i++) {
        await handleIncoming(msgs[i]);
      }
    } catch (e) {
      state.lastError = e && e.message ? e.message : String(e);
    } finally {
      state.pollBusy = false;
    }
  }

  /** 处理一条来自微信的新消息 */
  async function handleIncoming(m) {
    if (!m) return;
    var conversation = cleanInbound(m.conversation || "");
    var text = cleanInbound(m.text || "");
    if (!conversation || !text) return;

    var sid = boundSessionId();
    if (!sid) {
      state.stats.blocked++;
      logEvent("收到「" + conversation + "」的消息，但还没绑定 char，已忽略", "warn");
      return;
    }

    // 会话匹配：微信会话名必须能对上绑定的那个 char 单聊，否则一律不处理（防串台）
    var matched = await matchSessionByConversation(conversation);
    if (!matched || Number(matched.id) !== Number(sid)) {
      state.stats.blocked++;
      logEvent("「" + conversation + "」不在绑定范围内，已跳过", "warn");
      return;
    }

    state.stats.received++;
    ctxPush(conversation, "in", text, sid);
    logEvent("收到「" + conversation + "」：" + text.slice(0, 20) + (text.length > 20 ? "…" : ""), "in");

    // 落进 App 会话，和微信里真实发生的事保持一致
    try {
      await saveAndRenderMessage("user", text, "text", sid);
    } catch (e) {
      console.warn("[wechat] 落库失败:", e);
    }

    if (cfg().autoReply) {
      await generateAndSend(matched, conversation);
    }
    refreshPanelIfOpen();
  }

  /** 对某个会话生成 char 回复，并把文本气泡回写到微信 */
  async function generateAndSend(matched, conversation) {
    var sid = Number(matched.id);
    if (state.replyBusy[sid]) {
      logEvent("上一个请求还没结束，这条先排队（下次轮询会继续）", "warn");
      return;
    }
    // 频率限制
    var c = cfg();
    var now = Date.now();
    state.sentTimestamps = state.sentTimestamps.filter(function (t) { return now - t < 3600 * 1000; });
    if (state.sentTimestamps.length >= c.hourlyLimit) {
      state.stats.blocked++;
      logEvent("本小时已发送 " + state.sentTimestamps.length + " 条，达到上限，暂停回信", "danger");
      return;
    }

    state.replyBusy[sid] = true;
    var collected = [];
    try {
      logEvent("正在为「" + conversation + "」生成回复…", "info");
      verifyWechatBridgeDeps();
      await generateReplyForSession(sid, {
        background: true,
        silentError: false,
        onText: function (t) { if (t) collected.push(t); }
      });
    } catch (e) {
      state.lastError = e && e.message ? e.message : String(e);
      logEvent("生成回复失败：" + state.lastError, "danger");
      state.replyBusy[sid] = false;
      refreshPanelIfOpen();
      return;
    }
    state.replyBusy[sid] = false;

    // 出站清洗 + 剔除空串
    var outTexts = collected.map(cleanOutbound).filter(function (t) { return !!t; });
    state.stats.replied++;
    if (!outTexts.length) {
      logEvent("char 本轮没有可发送的文本（可能只有多媒体卡片），不回微信", "warn");
      refreshPanelIfOpen();
      return;
    }
    outTexts.forEach(function (t) { ctxPush(conversation, "out", t, sid); });

    if (!c.autoReply) {
      logEvent("已生成 " + outTexts.length + " 条回复（自动回信关闭，只保存在 App 内）", "ok");
      refreshPanelIfOpen();
      return;
    }
    await enqueueToWechat(conversation, outTexts);
    refreshPanelIfOpen();
  }

  function verifyWechatBridgeDeps() {
    if (typeof generateReplyForSession !== "function") {
      throw new Error("回复引擎未加载（generateReplyForSession 不存在），请更新到最新版 APK");
    }
    if (typeof saveAndRenderMessage !== "function") {
      throw new Error("消息模块未加载，请先打开一次聊天页");
    }
  }

  /** 把若干条文本依次排进原生回信队列（带随机延迟，避免机器化节奏） */
  async function enqueueToWechat(conversation, texts) {
    if (!hasNative("wechatA11yEnqueueReply")) {
      logEvent("当前环境不支持回写微信（非 APK 环境）", "danger");
      return;
    }
    var c = cfg();
    for (var i = 0; i < texts.length; i++) {
      if (i > 0) {
        // 多气泡之间也要有间隔，不要一口气全砸进去
        var gap = randInt(c.minDelay * 1000, c.maxDelay * 1000);
        await sleep(gap);
      }
      try {
        var r = JSON.parse(window.AndroidMCP.wechatA11yEnqueueReply(conversation, texts[i]) || "{}");
        if (r && r.ok) {
          state.stats.sent++;
          state.sentTimestamps.push(Date.now());
          logEvent("已排入发送队列 →「" + conversation + "」：" + texts[i].slice(0, 20) + (texts[i].length > 20 ? "…" : ""), "out");
        } else {
          state.stats.blocked++;
          logEvent("回写被拒：" + ((r && r.error) || "未知原因"), "danger");
        }
      } catch (e) {
        state.stats.blocked++;
        logEvent("回写异常：" + (e && e.message ? e.message : e), "danger");
      }
    }
  }

  function randInt(min, max) {
    if (max <= min) return min;
    return Math.floor(min + Math.random() * (max - min));
  }

  function sleep(ms) {
    return new Promise(function (r) { setTimeout(r, ms); });
  }

  // =========================================================================
  // 设置面板 UI
  // =========================================================================

  function panelEl() { return document.getElementById("me-sub-body"); }

  function refreshPanelIfOpen() {
    var panel = document.getElementById("me-sub-panel");
    if (!panel || !panel.classList.contains("active")) return;
    if (document.getElementById("me-sub-title") &&
        document.getElementById("me-sub-title").innerText !== "微信接入") return;
    renderPanel();
  }

  function switchHtml(id, on) {
    return '<label class="wx-switch"><input type="checkbox" id="' + id + '"' + (on ? " checked" : "") +
      '><span class="wx-switch-track"><span class="wx-switch-thumb"></span></span></label>';
  }

  function statusChip(ok, text) {
    var color = ok ? PASTEL.green : PASTEL.danger;
    var bg = ok ? PASTEL.greenSoft : PASTEL.dangerSoft;
    return '<span style="display:inline-flex;align-items:center;gap:5px;font-size:11px;font-weight:700;' +
      'color:' + color + ';background:' + bg + ';border:1px solid ' + (ok ? PASTEL.greenBorder : PASTEL.dangerBorder) +
      ';border-radius:999px;padding:3px 9px;">' +
      '<span style="width:6px;height:6px;border-radius:50%;background:' + color + ';display:inline-block;"></span>' +
      esc(text) + '</span>';
  }

  function card(title, bodyHtml, opts) {
    opts = opts || {};
    var accent = opts.accent || PASTEL.accent;
    var soft = opts.soft || PASTEL.soft;
    var border = opts.border || PASTEL.border;
    return '' +
      '<div style="background:#fff;border:1.5px solid ' + border + ';border-radius:14px;padding:14px;margin-bottom:12px;' +
      'box-shadow:0 1px 3px rgba(44,58,75,0.04);">' +
        '<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:' +
        (bodyHtml ? '10px' : '0') + ';">' +
          '<div style="font-size:13px;font-weight:800;color:' + accent + ';">' + title + '</div>' +
          (opts.right || '') +
        '</div>' +
        (bodyHtml ? '<div style="font-size:12px;color:' + PASTEL.ink + ';line-height:1.7;">' + bodyHtml + '</div>' : '') +
      '</div>';
  }

  function row(label, controlHtml, hint) {
    return '' +
      '<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;padding:9px 0;' +
      'border-top:1px solid #F1F4F8;">' +
        '<div style="flex:1;min-width:0;">' +
          '<div style="font-size:12.5px;font-weight:700;color:' + PASTEL.ink + ';">' + label + '</div>' +
          (hint ? '<div style="font-size:11px;color:' + PASTEL.sub + ';margin-top:2px;line-height:1.5;">' + hint + '</div>' : '') +
        '</div>' +
        '<div style="flex-shrink:0;">' + controlHtml + '</div>' +
      '</div>';
  }

  function cssOnce() {
    if (document.getElementById("wx-bridge-style")) return;
    var st = document.createElement("style");
    st.id = "wx-bridge-style";
    st.textContent = [
      ".wx-switch{position:relative;display:inline-block;width:44px;height:25px;flex-shrink:0;}",
      ".wx-switch input{opacity:0;width:0;height:0;}",
      ".wx-switch-track{position:absolute;cursor:pointer;inset:0;background:#D6DEE8;border-radius:999px;transition:.22s;}",
      ".wx-switch-thumb{position:absolute;content:'';height:19px;width:19px;left:3px;top:3px;background:#fff;border-radius:50%;transition:.22s;box-shadow:0 1px 3px rgba(0,0,0,.18);}",
      ".wx-switch input:checked + .wx-switch-track{background:#4A7DBF;}",
      ".wx-switch input:checked + .wx-switch-track .wx-switch-thumb{transform:translateX(19px);}",
      ".wx-btn{display:inline-flex;align-items:center;justify-content:center;gap:5px;border-radius:10px;padding:8px 13px;font-size:12px;font-weight:700;cursor:pointer;border:1.5px solid transparent;transition:.16s;background:#fff;}",
      ".wx-btn:active{transform:scale(.97);}",
      ".wx-btn-primary{background:#4A7DBF;color:#fff;border-color:#4A7DBF;}",
      ".wx-btn-soft{background:#EAF2FB;color:#3D6CA6;border-color:#CFE1F3;}",
      ".wx-btn-green{background:#E9F5F2;color:#2C6E63;border-color:#CDE9E3;}",
      ".wx-btn-ghost{background:#fff;color:#7A8A9C;border-color:#E3E9F0;}",
      ".wx-pick{display:flex;align-items:center;gap:10px;padding:9px 10px;border-radius:11px;cursor:pointer;border:1.5px solid transparent;transition:.16s;}",
      ".wx-pick:hover{background:#F7FAFD;}",
      ".wx-log-line{display:flex;gap:7px;font-size:11.5px;line-height:1.6;padding:4px 0;border-bottom:1px dashed #F1F4F8;}",
      ".wx-mono{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;}"
    ].join("\n");
    document.head.appendChild(st);
  }

  function renderPanel() {
    var body = panelEl();
    if (!body) return;
    cssOnce();

    var c = cfg();
    var nativeOk = hasNative("wechatA11yStatus");
    var enabled = nativeOk && a11yEnabled();
    var st = state.lastStatus || (nativeOk ? a11yStatus() : null);
    var sid = boundSessionId();

    var html = '';
    html += '<div style="padding:4px 2px 14px;">';

    // ---- 顶部：通道状态 ----
    html += card("通道状态", '', {
      right: (nativeOk ? statusChip(enabled, enabled ? "无障碍已开启" : "无障碍未开启") : statusChip(false, "非 APK 环境")),
      accent: PASTEL.accent
    });

    if (!nativeOk) {
      html += card("当前环境不支持", 
        '微信接入需要 APK 版本（依赖安卓无障碍服务）。你现在打开的是网页/PWA 版本，' +
        '这个页面里无法读取或操作微信。', { accent: PASTEL.danger, soft: PASTEL.dangerSoft, border: PASTEL.dangerBorder });
    } else if (!enabled) {
      html += card("先开无障碍服务",
        '第 1 步：点下面的按钮跳到系统无障碍设置。<br>' +
        '第 2 步：在列表里找到「叙事诗小手机 · 微信接入」并打开。<br>' +
        '第 3 步：如果开关被系统拦住（安卓 13+ 对侧载应用有「受限设置」保护），' +
        '先去 设置 → 应用 → 叙事诗小手机 → 右上角三个点 → 允许受限设置，再回来开。',
        { accent: PASTEL.warn, soft: PASTEL.warnSoft, border: PASTEL.warnBorder,
          right: '<button class="wx-btn wx-btn-primary" onclick="wechatBridge.openA11ySettings()">去开启</button>' });
    }

    // ---- 绑定 char ----
    html += '<div id="wx-bind-card"></div>';

    // ---- 开关 ----
    var listenRow = row("接收微信消息",
      switchHtml("wx-sw-listen", c.listen),
      "总闸。打开后才会读取微信新消息并同步到 App。默认关闭。");
    var replyRow = row("自动回信到微信",
      switchHtml("wx-sw-reply", c.autoReply),
      "在上面那个总闸打开的前提下，用你自己的账号把 char 的回复发出去。" +
      (c.listen ? "" : "（现在总闸是关的，打开这个也不会回信）") +
      "默认关闭，请先读完下面的风险提示再决定。");
    var navRow = row("自动跳转到目标会话",
      switchHtml("wx-sw-nav", c.autoNavigate),
      "回信时会话没打开时，先用微信搜索跳过去。关闭则只在你手动打开该会话后才发。");
    var echoRow = row("同步方向",
      '<span style="font-size:11.5px;font-weight:700;color:' + PASTEL.green + '">微信 → App（单向）</span>',
      "微信里的消息会进 App 会话；你在 App 里发的消息不会自动发到微信，避免来回打架。");
    html += card("开关", listenRow + replyRow + navRow + echoRow, { accent: PASTEL.green, soft: PASTEL.greenSoft, border: PASTEL.greenBorder });

    // ---- 界面诊断：微信版本/ROM 差异大，出问题时靠它定位 ----
    var probeHost = '<div id="wx-probe-result" style="font-size:11.5px;color:' + PASTEL.sub + ';line-height:1.8;">' +
      (state.lastProbe ? probeHtml(state.lastProbe) : "还没诊断过。点下面的按钮，它会把「无障碍服务眼里的微信」原样显示出来。") +
      '</div>';
    html += card("界面诊断",
      probeHost +
      '<div style="margin-top:10px;">' +
        '<button class="wx-btn wx-btn-primary" onclick="wechatBridge.probe()">刷新诊断</button>' +
        '<span style="font-size:11px;color:' + PASTEL.sub + ';margin-left:8px;">' +
          '正确用法：先在微信里打开那个聊天窗口停几秒（让它读一次），再切回来看这里' +
        '</span>' +
      '</div>',
      { accent: PASTEL.accent });

    // ---- 风险提示（打开自动回信才显示，且需确认） ----
    if (c.autoReply && localStorage.getItem(K.riskAccepted) !== "true") {
      html += card("发送前请确认",
        '自动化发送消息有被微信风控的可能（和你改不改本机数据库无关 —— 判定的依据在服务端）。<br><br>' +
        '本功能已做的降险措施：默认不开启、回信带 ' + c.minDelay + '-' + c.maxDelay + ' 秒随机延迟、' +
        '每小时最多 ' + c.hourlyLimit + ' 条、发送前必须复核会话名。' +
        '但风险无法降到零，请你自己判断是否接受。',
        { accent: PASTEL.danger, soft: PASTEL.dangerSoft, border: PASTEL.dangerBorder,
          right: '<button class="wx-btn wx-btn-soft" onclick="wechatBridge.acceptRisk()">我了解并接受</button>' });
    }

    // ---- 其他配置 ----
    var delayHtml = '' +
      '<div style="display:flex;gap:8px;align-items:center;justify-content:flex-end;">' +
        '<input id="wx-min-delay" class="wx-mono" type="number" min="1" max="60" value="' + c.minDelay + '" ' +
          'style="width:56px;padding:6px;border:1.5px solid ' + PASTEL.border + ';border-radius:8px;text-align:center;">' +
        '<span style="color:' + PASTEL.sub + '">~</span>' +
        '<input id="wx-max-delay" class="wx-mono" type="number" min="1" max="120" value="' + c.maxDelay + '" ' +
          'style="width:56px;padding:6px;border:1.5px solid ' + PASTEL.border + ';border-radius:8px;text-align:center;">' +
        '<span style="font-size:11px;color:' + PASTEL.sub + '">秒</span>' +
      '</div>';
    var limitHtml = '' +
      '<input id="wx-hourly-limit" class="wx-mono" type="number" min="1" max="200" value="' + c.hourlyLimit + '" ' +
        'style="width:64px;padding:6px;border:1.5px solid ' + PASTEL.border + ';border-radius:8px;text-align:center;">' +
      '<span style="font-size:11px;color:' + PASTEL.sub + ';margin-left:5px;">条/小时</span>';

    html += card("回信节奏",
      row("随机延迟", delayHtml, "每条之间随机等这么久再发，别让节奏太机器化。") +
      row("频率上限", limitHtml, "超过这个数量就暂停回信，直到下一小时。") +
      row("保存", '<button class="wx-btn wx-btn-green" onclick="wechatBridge.saveConfig()">保存配置</button>'),
      { accent: PASTEL.accent });

    // ---- 运行数据 ----
    var ctx = ctxStats();
    var runBody = '' +
      '<div style="display:flex;flex-wrap:wrap;gap:8px;">' +
        statPill("收到", state.stats.received) +
        statPill("生成回复", state.stats.replied) +
        statPill("已发出", state.stats.sent) +
        statPill("已拦截", state.stats.blocked) +
      '</div>' +
      (st ? '<div style="margin-top:10px;font-size:11.5px;color:' + PASTEL.sub + ';line-height:1.8;">' +
        '原生服务：' + (st.serviceRunning ? "运行中" : "未连接") + '<br>' +
        '当前微信会话：' + (st.currentChatName ? esc(st.currentChatName) : "（不在会话页）") + '<br>' +
        '待发回信：' + (st.replyQueueSize || 0) + ' 条 · 收件箱积压：' + (st.inboxSize || 0) + ' 条<br>' +
        '最近状态：' + esc(st.lastStatus || "—") +
      '</div>' : '') +
      '<div style="margin-top:10px;font-size:11.5px;color:' + PASTEL.sub + ';">' +
        '通道上下文：' + ctx.sessions + ' 个会话 / ' + ctx.turns + ' 条记录' +
        '（每会话最多 ' + CTX_MAX_TURNS + ' 条，超过 2 小时无动静自动清理）' +
      '</div>' +
      '<div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:12px;">' +
        '<button class="wx-btn wx-btn-soft" onclick="wechatBridge.openWechat()">打开微信</button>' +
        '<button class="wx-btn wx-btn-soft" onclick="wechatBridge.snapshotNow()">立即读一次</button>' +
        '<button class="wx-btn wx-btn-soft" onclick="wechatBridge.probe()">界面诊断</button>' +
        '<button class="wx-btn wx-btn-ghost" onclick="wechatBridge.clearInbox()">清空收件箱</button>' +
        '<button class="wx-btn wx-btn-ghost" onclick="wechatBridge.clearReplies()">清空待发</button>' +
        '<button class="wx-btn wx-btn-ghost" onclick="wechatBridge.clearContext()">清理上下文</button>' +
        '<button class="wx-btn wx-btn-ghost" onclick="wechatBridge.resetStats()">计数归零</button>' +
      '</div>';
    html += card("运行数据", runBody, { accent: PASTEL.green, soft: PASTEL.greenSoft, border: PASTEL.greenBorder });

    // ---- 事件流 ----
    var logHtml = '';
    if (!state.recentLog.length) {
      logHtml = '<div style="color:' + PASTEL.sub + ';font-size:11.5px;">还没有事件。打开开关后，微信来消息会在这里显示。</div>';
    } else {
      state.recentLog.slice(0, 12).forEach(function (e) {
        var color = e.tone === "danger" ? PASTEL.danger
          : e.tone === "warn" ? PASTEL.warn
          : e.tone === "out" ? PASTEL.accent
          : e.tone === "in" ? PASTEL.green
          : PASTEL.ink;
        logHtml += '<div class="wx-log-line">' +
          '<span class="wx-mono" style="color:' + PASTEL.sub + ';flex-shrink:0;">' + timeStr(e.at) + '</span>' +
          '<span style="color:' + color + ';word-break:break-all;">' + esc(e.text) + '</span>' +
          '</div>';
      });
    }
    html += card("事件流", logHtml, { accent: PASTEL.sub, soft: "#F7F9FC", border: "#E7EDF4" });

    // ---- 说明 ----
    html += card("它是怎么工作的",
      '1. 无障碍服务只监听微信（com.tencent.mm），读到对方发来的新消息。<br>' +
      '2. App 按会话名找到你绑定的那个 char 单聊，把消息存进去并让 char 回复。<br>' +
      '3. 开启自动回信时，回复文本会经过标签清洗，再交给无障碍服务填进微信输入框并点发送。<br>' +
      '4. 发送前一定会核对「当前打开的微信会话名 == 目标会话名」，对不上就不发 —— 宁可不发，也不发错人。',
      { accent: PASTEL.sub, soft: "#F7F9FC", border: "#E7EDF4" });

    html += '</div>';
    body.innerHTML = html;

    renderBindCard();
    bindControls();
  }

  function statPill(label, value) {
    return '<div style="flex:1;min-width:72px;background:#fff;border:1.5px solid ' + PASTEL.border +
      ';border-radius:11px;padding:8px 10px;text-align:center;">' +
      '<div style="font-size:16px;font-weight:800;color:' + PASTEL.accent + ';">' + value + '</div>' +
      '<div style="font-size:10.5px;color:' + PASTEL.sub + ';margin-top:1px;">' + label + '</div>' +
      '</div>';
  }

  /** 把诊断结果渲染成人能看懂的几行 */
  function probeHtml(p) {
    if (!p) return "";
    if (!p.ok) return '<span style="color:' + PASTEL.danger + ';">诊断失败：' + esc(p.error || "未知错误") + '</span>';

    var line = function (k, v, tone) {
      return '<div><span style="color:' + PASTEL.sub + ';">' + k + '：</span>' +
        '<span style="color:' + (tone || PASTEL.ink) + ';font-weight:600;">' + esc(String(v)) + '</span></div>';
    };
    var yn = function (b) {
      return '<span style="color:' + (b ? PASTEL.green : PASTEL.danger) + ';font-weight:800;">' + (b ? "是" : "否") + '</span>';
    };
    var h = '';
    h += line("服务已连接", p.running ? "是" : "否", p.running ? PASTEL.green : PASTEL.danger);
    if (p.hint) {
      h += '<div style="margin-top:4px;color:' + PASTEL.warn + ';">' + esc(p.hint) + '</div>';
      return h;
    }

    // ---- 第一段：此刻的活动窗口（面板开在小手机里，所以这里通常就是小手机自己，属正常）----
    h += '<div style="margin-top:2px;font-weight:700;color:' + PASTEL.sub + ';">此刻的活动窗口</div>';
    h += line("前台应用", p.foregroundPackage || p.windowPackage || "（取不到）");
    h += line("是微信", p.foregroundIsWechat ? "是" : "否", p.foregroundIsWechat ? PASTEL.green : PASTEL.sub);
    if (p.liveReason) {
      h += '<div style="color:' + PASTEL.sub + ';line-height:1.6;">' + esc(p.liveReason) + '</div>';
    }

    // ---- 第二段：最近一次在微信里真正读到的内容 ----
    h += '<div style="margin-top:10px;padding-top:8px;border-top:1px dashed #E7EDF4;font-weight:700;color:' + PASTEL.accent + ';">' +
      '最近一次在微信里读到的' +
      (p.lastScanTs ? '（' + timeStr(p.lastScanTs) + '）' : '') + '</div>';

    if (!p.lastScanTs) {
      h += '<div style="margin-top:5px;padding:7px 9px;border-radius:9px;background:' + PASTEL.warnSoft +
        ';color:' + PASTEL.warn + ';font-weight:600;line-height:1.6;">' + esc(p.reason || "还没在微信里读到过内容") + '</div>';
      return h;
    }

    h += line("识别到的会话名", p.chatName || "（没识别出来）", p.chatName ? PASTEL.ink : PASTEL.warn);
    h += '<div><span style="color:' + PASTEL.sub + ';">找到输入框：</span>' + yn(p.inputFound) +
      ' <span style="color:' + PASTEL.sub + ';">可编辑：</span>' + yn(p.inputEditable) +
      ' <span style="color:' + PASTEL.sub + ';">找到发送按钮：</span>' + yn(p.sendButtonFound) + '</div>';
    h += line("可见消息条数", (p.visibleMessageCount || 0) + "（其中对方发来 " + (p.incomingCount || 0) + " 条，系统行 " + (p.systemLineCount || 0) + " 条）");

    var okAll = !!p.chatName && (p.visibleMessageCount || 0) > 0;
    var tone = okAll ? PASTEL.green : PASTEL.warn;
    h += '<div style="margin-top:6px;padding:7px 9px;border-radius:9px;background:' +
      (tone === PASTEL.green ? PASTEL.greenSoft : PASTEL.warnSoft) +
      ';color:' + tone + ';font-weight:600;line-height:1.6;">' + esc(p.lastScanReason || "") + '</div>';

    if (Array.isArray(p.preview) && p.preview.length) {
      h += '<div style="margin-top:8px;color:' + PASTEL.sub + ';">最近几条读到的内容：</div>';
      h += '<div style="max-height:150px;overflow-y:auto;margin-top:2px;">';
      p.preview.forEach(function (m) {
        h += '<div class="wx-log-line" style="border-bottom:1px dashed #F1F4F8;">' +
          '<span class="wx-mono" style="flex-shrink:0;color:' + (m.dir === "in" ? PASTEL.green : PASTEL.accent) + ';">' +
          (m.dir === "in" ? "对方" : "自己") + (m.sys ? "·系统行" : "") + '</span>' +
          '<span style="word-break:break-all;">' + esc(m.text || "") + '</span>' +
          '</div>';
      });
      h += '</div>';
    }
    return h;
  }

  /** 绑定卡片：列出所有 char 单聊，选一个作为微信对接对象 */
  async function renderBindCard() {
    var host = document.getElementById("wx-bind-card");
    if (!host) return;
    var sessions = await listCharSessions();
    var sid = boundSessionId();

    var inner = '';
    if (!sessions.length) {
      inner = '<div style="color:' + PASTEL.sub + ';font-size:12px;">还没有单聊。先去聊天页新建一个和 char 的单聊，再回来绑定。</div>';
    } else {
      inner = '<div style="display:flex;flex-direction:column;gap:6px;max-height:260px;overflow-y:auto;">';
      sessions.forEach(function (s) {
        var active = Number(s.id) === Number(sid);
        var av = s.avatar
          ? '<img src="' + esc(s.avatar) + '" style="width:34px;height:34px;border-radius:50%;object-fit:cover;flex-shrink:0;">'
          : '<div style="width:34px;height:34px;border-radius:50%;background:' + PASTEL.soft + ';display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:800;color:' + PASTEL.accent + ';flex-shrink:0;">' + esc(String(s.name).slice(0, 1)) + '</div>';
        inner += '<div class="wx-pick" onclick="wechatBridge.bindSession(' + s.id + ')" style="' +
          (active ? 'background:' + PASTEL.soft + ';border-color:' + PASTEL.border + ';' : 'border-color:#EEF2F7;') + '">' +
          av +
          '<div style="flex:1;min-width:0;">' +
            '<div style="font-size:12.5px;font-weight:700;color:' + PASTEL.ink + ';overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + esc(s.name) + '</div>' +
            '<div style="font-size:11px;color:' + PASTEL.sub + ';overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' +
              (s.remark ? "备注：" + esc(s.remark) + " · " : "") + '会话 #' + s.id +
            '</div>' +
          '</div>' +
          (active
            ? '<span style="font-size:11px;font-weight:800;color:' + PASTEL.green + ';flex-shrink:0;">已绑定</span>'
            : '<span style="font-size:11px;color:' + PASTEL.sub + ';flex-shrink:0;">选择</span>') +
          '</div>';
      });
      inner += '</div>';
    }

    host.innerHTML = card("对接哪个 char",
      inner +
      '<div style="margin-top:10px;font-size:11.5px;color:' + PASTEL.sub + ';line-height:1.7;">' +
        '微信里那个人的昵称要和这里选中的 char 名字（或备注）一致，' +
        '否则消息会被当成「不在绑定范围内」直接跳过 —— 这是防止串台的保护。' +
      '</div>' +
      (sid ? '<div style="margin-top:10px;"><button class="wx-btn wx-btn-ghost" onclick="wechatBridge.unbindSession()">解除绑定</button></div>' : ''),
      { accent: PASTEL.accent });
  }

  /** 绑定开关的事件 */
  function bindControls() {
    var swListen = document.getElementById("wx-sw-listen");
    if (swListen) swListen.onchange = function () { setListen(this.checked); };
    var swReply = document.getElementById("wx-sw-reply");
    if (swReply) swReply.onchange = function () { setAutoReply(this.checked); };
    var swNav = document.getElementById("wx-sw-nav");
    if (swNav) swNav.onchange = function () {
      localStorage.setItem(K.autoNavigate, this.checked ? "true" : "false");
      pushConfig();
      toast(this.checked ? "回信时会自动跳转到目标会话" : "回信只在你手动打开目标会话后发送");
    };
  }

  // =========================================================================
  // 对外动作
  // =========================================================================

  function setListen(on) {
    localStorage.setItem(K.listen, on ? "true" : "false");
    pushConfig();
    if (on) {
      if (!hasNative("wechatA11yStatus")) { toast("当前环境不支持（需要 APK 版）"); return; }
      if (!a11yEnabled()) {
        toast("请先开启无障碍服务，再打开这个开关");
        renderPanel();
        return;
      }
      startPolling();
      toast("已开始接收微信消息");
    } else {
      stopPolling();
      toast("已停止接收微信消息");
    }
    logEvent(on ? "接收开关：已打开" : "接收开关：已关闭", "info");
    syncHeartbeat();
    renderPanel();
  }

  function setAutoReply(on) {
    if (on && !a11yEnabled()) {
      toast("请先开启无障碍服务");
      renderPanel();
      return;
    }
    localStorage.setItem(K.autoReply, on ? "true" : "false");
    pushConfig();
    if (on) {
      startPolling();   // 自动回信也依赖轮询
      logEvent("自动回信：已打开（请注意风控风险）", "warn");
      toast(cfg().listen
        ? "自动回信已打开，请留意上面的风险提示"
        : "自动回信已记录，但「接收微信消息」总闸还没打开，现在不会生效");
    } else {
      logEvent("自动回信：已关闭", "info");
      toast("自动回信已关闭");
    }
    syncHeartbeat();
    renderPanel();
  }

  function bindSession(id) {
    localStorage.setItem(K.bindSession, String(id));
    pushConfig();
    logEvent("已绑定会话 #" + id, "ok");
    toast("已绑定，记得让微信里的昵称和这个 char 一致");
    renderPanel();
  }

  function unbindSession() {
    localStorage.removeItem(K.bindSession);
    pushConfig();
    toast("已解除绑定");
    renderPanel();
  }

  function saveConfig() {
    var mn = document.getElementById("wx-min-delay");
    var mx = document.getElementById("wx-max-delay");
    var hl = document.getElementById("wx-hourly-limit");
    var minV = Math.max(1, Math.min(60, parseInt(mn && mn.value, 10) || DEFAULTS.minDelay));
    var maxV = Math.max(1, Math.min(120, parseInt(mx && mx.value, 10) || DEFAULTS.maxDelay));
    if (maxV < minV) maxV = minV;
    var limV = Math.max(1, Math.min(200, parseInt(hl && hl.value, 10) || DEFAULTS.hourlyLimit));
    localStorage.setItem(K.minDelay, String(minV));
    localStorage.setItem(K.maxDelay, String(maxV));
    localStorage.setItem(K.hourlyLimit, String(limV));
    toast("配置已保存：" + minV + "-" + maxV + " 秒延迟，每小时最多 " + limV + " 条");
    renderPanel();
  }

  function acceptRisk() {
    localStorage.setItem(K.riskAccepted, "true");
    toast("已记录，请自行控制使用频率");
    renderPanel();
  }

  function openA11ySettings() {
    if (!hasNative("wechatA11yOpenSettings")) { toast("当前环境不支持"); return; }
    window.AndroidMCP.wechatA11yOpenSettings();
  }

  function openWechat() {
    if (!hasNative("wechatOpenApp")) { toast("当前环境不支持"); return; }
    var ok = window.AndroidMCP.wechatOpenApp();
    if (!ok) toast("没找到微信，请确认已安装");
  }

  function snapshotNow() {
    if (!hasNative("wechatA11yRequestSnapshot")) { toast("当前环境不支持"); return; }
    window.AndroidMCP.wechatA11yRequestSnapshot();
    toast("已请求读一次，请稍候查看状态");
    setTimeout(function () { state.lastStatus = a11yStatus(); refreshPanelIfOpen(); }, 1200);
  }

  /**
   * 界面诊断：把无障碍服务当前看到的微信界面读出来。
   * 微信版本与各家 ROM 的无障碍树差异很大，出问题时要靠这个定位到底卡在哪一步。
   */
  function probe() {
    if (!hasNative("wechatA11yProbe")) { toast("当前环境不支持（需要最新版 APK）"); return; }
    try {
      state.lastProbe = JSON.parse(window.AndroidMCP.wechatA11yProbe() || "{}");
    } catch (e) {
      state.lastProbe = { ok: false, error: (e && e.message) ? e.message : String(e) };
    }
    var p = state.lastProbe || {};
    logEvent("界面诊断：" + (p.reason || p.error || "完成"), p.foregroundIsWechat && p.inputFound ? "ok" : "warn");
    toast(p.reason || "诊断完成");
    renderPanel();
  }

  function clearInbox() {
    if (!hasNative("wechatA11yClearInbox")) return;
    window.AndroidMCP.wechatA11yClearInbox();
    logEvent("收件箱已清空", "info");
    toast("收件箱已清空");
    renderPanel();
  }

  function clearReplies() {
    if (!hasNative("wechatA11yClearReplies")) return;
    window.AndroidMCP.wechatA11yClearReplies();
    logEvent("待发队列已清空", "info");
    toast("待发队列已清空");
    renderPanel();
  }

  function clearContext() {
    ctxClear();
    logEvent("通道上下文已清理", "info");
    toast("通道上下文已清理");
    renderPanel();
  }

  function resetStats() {
    state.stats = { received: 0, replied: 0, sent: 0, blocked: 0 };
    state.sentTimestamps = [];
    if (hasNative("wechatA11yResetStats")) {
      try { window.AndroidMCP.wechatA11yResetStats(); } catch (e) { }
    }
    toast("计数已归零");
    renderPanel();
  }

  /** 打开设置面板（由「我的 → 微信接入」调用） */
  function openPanel() {
    if (typeof window.openMeSub === "function") {
      window.openMeSub("wechat-bridge");
      return;
    }
    // 兜底：直接激活子面板
    var panel = document.getElementById("me-sub-panel");
    var title = document.getElementById("me-sub-title");
    if (title) title.innerText = "微信接入";
    if (panel) panel.classList.add("active");
    renderPanel();
  }

  // =========================================================================
  // 启动
  // =========================================================================

  /**
   * 保活：安卓会在应用退到后台一段时间后冻结 WebView，冻结期间轮询就停了，
   * 微信来消息也不会有反应。这里复用已有的「后台心跳」机制（AlarmManager 定时唤醒，
   * 能在 Doze 下唤醒），被唤醒时 WebView 恢复执行，轮询自然继续。
   * 只在接收/自动回信开着的时候才挂心跳，关掉就撤掉，不白耗电。
   */
  function syncHeartbeat() {
    if (!hasNative("startBackgroundPolling")) return;
    var c = cfg();
    var want = (c.listen || c.autoReply) && a11yEnabled();
    try {
      // ⚠️ 这两个原生接口与「后台主动发信」共用，关之前先确认对方没在用，
      //    否则会把用户另一个功能的心跳一起撤掉。
      var activeMsgOn = localStorage.getItem("settings-mcp-active-msg-enabled") === "true";
      if (want) {
        window.AndroidMCP.startBackgroundPolling(10);
      } else if (!activeMsgOn) {
        window.AndroidMCP.stopBackgroundPolling();
      }
    } catch (e) {
      console.warn("[wechat] 心跳同步失败:", e);
    }
  }

  /** 回到前台时立刻补一次：后台被冻结期间可能积压了消息 */
  function onVisible() {
    if (document.visibilityState !== "visible") return;
    var c = cfg();
    if (!a11yEnabled() || !c.listen) return;
    if (!state.polling) startPolling();
    // 不 await：这里只是补一次，失败了下一轮还会再来
    pumpOnce().catch(function (e) { console.warn("[wechat] 回前台补拉失败:", e); });
  }

  function boot() {
    // 面板渲染由 openMeSub 驱动；这里只做后台泵与配置下发
    try {
      pushConfig();
      var c = cfg();
      if (a11yEnabled() && c.listen) {
        startPolling();
      }
      syncHeartbeat();
      // 每次启动都清一次过期上下文：用户可能上次退出后过了很久才打开
      saveCtxLog(pruneCtxLog(loadCtxLog()));
      // 从后台回到前台时补一次，避免冻结期间漏掉消息
      document.addEventListener("visibilitychange", onVisible);
      window.addEventListener("focus", onVisible);
    } catch (e) {
      console.warn("[wechat] 启动失败:", e);
    }
  }

  window.wechatBridge = {
    openPanel: openPanel,
    renderPanel: renderPanel,
    bindSession: bindSession,
    unbindSession: unbindSession,
    saveConfig: saveConfig,
    acceptRisk: acceptRisk,
    openA11ySettings: openA11ySettings,
    openWechat: openWechat,
    snapshotNow: snapshotNow,
    probe: probe,
    clearInbox: clearInbox,
    clearReplies: clearReplies,
    clearContext: clearContext,
    resetStats: resetStats,
    // 供调试与其它模块使用
    cleanOutbound: cleanOutbound,
    cleanInbound: cleanInbound,
    listCharSessions: listCharSessions,
    matchSessionByConversation: matchSessionByConversation,
    pruneCtxLog: pruneCtxLog,
    ctxStats: ctxStats,
    startPolling: startPolling,
    stopPolling: stopPolling,
    syncHeartbeat: syncHeartbeat,
    state: state
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
