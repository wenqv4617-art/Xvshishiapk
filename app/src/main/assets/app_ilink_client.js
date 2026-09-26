/**
 * app_ilink_client.js —— 微信 iLink（ClawBot）协议客户端
 * ---------------------------------------------------------------------------
 * 腾讯通过 OpenClaw 平台开放了微信 Bot 能力，底层协议叫 iLink：纯 HTTP/JSON，
 * 官方仅发布 Node 包，没有 SDK 也能直接调。
 *
 * 本文件只做协议，不管界面：
 *   · 登录：取二维码 → 轮询扫码状态（含配对码 / 节点跳转 / 过期续期）→ 落 token
 *   · 收发：getupdates 长轮询收消息 → sendmessage 回消息（含 getconfig/sendtyping）
 *   · 持久化：bot_token / baseurl / 账号标识 / 消息游标 / 按用户 context_token
 *
 * ⚠️ 边界（必须让用户知道）：
 *   这条通道是「ClawBot 联系人 ↔ 你」，不是「你的账号给好友发消息」。
 *   它走官方开放接口、不自动化你的微信客户端，所以风险远低于模拟操作；
 *   但腾讯保留对这套接口的控制权（限速、内容过滤、随时终止），并非零风险。
 *
 * ⚠️ 长轮询超时是硬要求：getupdates / get_qrcode_status 服务端会 hold 最多 35 秒。
 *   若用 15 秒默认读超时，长轮询会每轮都超时，表现为「登录上了但收不到消息」。
 */
(function (root) {
  "use strict";

  // =========================================================================
  // 常量
  // =========================================================================

  var FIXED_HOST = "https://ilinkai.weixin.qq.com";  // 首次取二维码固定用这个入口
  var CHANNEL_VERSION = "2.4.6";
  var BOT_AGENT = "story-phone/1.0 (cordis)";
  var LONGPOLL_TIMEOUT_MS = 60000;   // 服务端 hold 约 35s，客户端留足余量：
                                     // 如果客户端超时早于服务端结束 hold，超时后重发会让
                                     // 服务端同时持有两条长轮询 → 返回 HTTP 500 并踢连接。
  var NORMAL_TIMEOUT_MS = 15000;
  var QR_POLL_TIMEOUT_MS = 40000;
  var QR_TTL_MS = 5 * 60 * 1000;     // 二维码本地有效期（官方客户端策略）
  var QR_MAX_REFRESH = 3;            // 过期/被限流时的最多刷新次数
  var BACKOFF_FAIL_THRESHOLD = 3;    // 连续失败达到这个次数后加长等待
  var BACKOFF_SHORT_MS = 2000;
  var BACKOFF_LONG_MS = 30000;
  var POLL_SKIP_MS = 3000;           // 把长轮询让给另一实例时的重试间隔
  var POLL_TIMEOUT_COOLDOWN_MS = 6000; // 本客户端超时后，等这么久再发下一条。
                                       // 服务端 hold 时长偶尔会超出我们的超时，立刻重发会重叠。

  var LS = {
    token: "ilink-bot-token",
    baseurl: "ilink-baseurl",
    botId: "ilink-bot-id",
    userId: "ilink-user-id",
    boundAt: "ilink-bound-at",
    // 会话内状态
    cursor: "ilink-cursor",              // get_updates_buf（按账号隔离；账号换了要清）
    cursorOwner: "ilink-cursor-owner",
    ctxTokens: "ilink-context-tokens"    // { userId: contextToken }
  };

  // =========================================================================
  // 小工具
  // =========================================================================

  function b64(str) {
    try {
      if (typeof btoa === "function") return btoa(str);
      return Buffer.from(str, "binary").toString("base64");
    } catch (e) { return ""; }
  }

  function toB64Bytes(u8) {
    var s = "";
    for (var i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
    return b64(s);
  }

  /** 32 位随机数的字节序（长度固定 8 字节，值在 0..2^31-1） */
  function makeUin() {
    var bytes = new Uint8Array(8);
    var v = Math.floor(Math.random() * 0x7fffffff);
    for (var i = 0; i < 8; i++) {
      bytes[i] = v & 0xff;
      v = Math.floor(v / 256);
    }
    return toB64Bytes(bytes);
  }

  function nowMs() { return Date.now(); }

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function randomHex(n) {
    var s = "";
    for (var i = 0; i < n; i++) s += "0123456789abcdef".charAt(Math.floor(Math.random() * 16));
    return s;
  }

  function log() {
    try {
      var a = Array.prototype.slice.call(arguments);
      a.unshift("[ilink]");
      console.log.apply(console, a);
    } catch (e) { }
  }

  // =========================================================================
  // 状态（内存态；持久部分写 localStorage）
  // =========================================================================

  var state = {
    qrcode: "",            // 当前二维码标识（短期凭据，别打日志）
    qrImgUrl: "",          // 二维码要编码的内容（那段 URL）
    qrIssuedAt: 0,
    qrRefreshCount: 0,
    qrRedirectHost: "",    // scaned_but_redirect 后切换
    verifyCode: null,      // 用户输入的配对码
    lastStatus: "",        // wait / scaned / need_verifycode / ...
    polling: false,
    consecutiveFail: 0,
    events: []             // 界面事件流
  };

  function pushEvent(text, tone) {
    state.events.unshift({ at: nowMs(), text: String(text), tone: tone || "info" });
    if (state.events.length > 40) state.events.length = 40;
  }

  function getToken() { try { return localStorage.getItem(LS.token) || ""; } catch (e) { return ""; } }
  function getBaseUrl() { try { return localStorage.getItem(LS.baseurl) || ""; } catch (e) { return ""; } }
  function getBotId() { try { return localStorage.getItem(LS.botId) || ""; } catch (e) { return ""; } }
  function getUserId() { try { return localStorage.getItem(LS.userId) || ""; } catch (e) { return ""; } }
  function isLoggedIn() { return !!getToken(); }

  /**
   * 保存登录凭据。
   *
   * ⚠ 这里必须**把失败报出来**。localStorage 在 Android WebView 里是全站共享的约 5MB，
   *   一旦被 base64 图片塞满，写 token 就会抛 QuotaExceededError。
   *   旧实现是 catch 住只写一条日志 —— 用户扫码后看起来「登录成功」，
   *   下次打开却发现没登录，非常难查。现在返回是否真的存下，并让 UI 明确提示。
   */
  function saveLogin(token, baseurl, botId, userId) {
    try {
      localStorage.setItem(LS.token, token || "");
      localStorage.setItem(LS.baseurl, baseurl || "");
      localStorage.setItem(LS.botId, botId || "");
      localStorage.setItem(LS.userId, userId || "");
      localStorage.setItem(LS.boundAt, String(nowMs()));
      return { ok: true };
    } catch (e) {
      var quota = (e && (e.name === "QuotaExceededError" ||
        /quota/i.test(String(e.name || "")) || /quota/i.test(String(e.message || ""))));
      log(quota
        ? "本机存储空间已满，登录凭据没能保存（本次会话仍可用，但重启后需要重新扫码）"
        : "保存登录态失败", e);
      return {
        ok: false,
        quota: !!quota,
        error: quota ? "存储空间已满" : String((e && e.message) || e)
      };
    }
  }

  function clearLogin() {
    try {
      [LS.token, LS.baseurl, LS.botId, LS.userId, LS.boundAt, LS.cursor, LS.cursorOwner, LS.ctxTokens]
        .forEach(function (k) { localStorage.removeItem(k); });
    } catch (e) { }
  }

  // ---------- 游标与 context_token（按账号隔离） ----------

  function loadCursor() {
    try {
      // 账号换了就丢弃旧游标，避免跨账号复用服务端游标
      if (localStorage.getItem(LS.cursorOwner) !== getBotId()) return "";
      return localStorage.getItem(LS.cursor) || "";
    } catch (e) { return ""; }
  }

  function saveCursor(buf) {
    try {
      if (!buf) return;
      localStorage.setItem(LS.cursor, buf);
      localStorage.setItem(LS.cursorOwner, getBotId());
    } catch (e) { }
  }

  function loadCtxTokens() {
    try { return JSON.parse(localStorage.getItem(LS.ctxTokens) || "{}") || {}; }
    catch (e) { return {}; }
  }

  function saveContextToken(userId, token) {
    if (!userId || !token) return;
    try {
      var m = loadCtxTokens();
      m[userId] = token;
      // 只保留最近 50 个用户，避免无限增长
      var keys = Object.keys(m);
      if (keys.length > 50) {
        keys.slice(0, keys.length - 50).forEach(function (k) { delete m[k]; });
      }
      localStorage.setItem(LS.ctxTokens, JSON.stringify(m));
    } catch (e) { }
  }

  function getContextToken(userId) {
    var m = loadCtxTokens();
    return m[userId] || "";
  }

  // =========================================================================
  // HTTP 封装
  // =========================================================================

  /** 把原生返回的 JSON 统一成内部结构 */
  function normalizeNative(parsed) {
    var status = (parsed && parsed.status) || 0;
    var isTimeout = (parsed && parsed.timeout === true) || status === 408;
    var text = (parsed && parsed.body) || "";
    var json = null;
    try { json = JSON.parse(text); } catch (e) { json = null; }
    return {
      ok: !isTimeout && status >= 200 && status < 300,
      httpStatus: status,
      timeout: isTimeout,
      json: json,
      raw: text
    };
  }

  function sleepLocal(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  /**
   * 统一请求。优先走 App 原生桥，否则退回 fetch（PWA/浏览器环境）。
   * 返回 { ok, httpStatus, timeout, json, raw }
   *
   * ⚠️ 关键：原生桥的方法是在 WebView 的 JS 线程上**同步执行**的。
   * 如果直接调同步版，一次 35~40 秒的长轮询会把 JS 线程按住 40 秒，
   * 界面会整体卡死（按钮点下去一分多钟才反应、切页面也卡）。
   * 所以这里一律走「异步提交 + 轮询取结果」：提交毫秒级返回，主线程始终让出。
   */
  async function request(url, method, headers, bodyObj, timeoutMs) {
    var headersJson = JSON.stringify(headers || {});
    var bodyStr = bodyObj ? JSON.stringify(bodyObj) : "";
    var t = timeoutMs || NORMAL_TIMEOUT_MS;

    var native = (typeof window !== "undefined" && window.AndroidMCP) ? window.AndroidMCP : null;

    // 首选：异步接口（不阻塞 JS 线程）
    if (native && typeof native.ilinkHttpSubmit === "function" &&
        typeof native.ilinkHttpPoll === "function") {
      var taskId = "";
      try {
        var sub = JSON.parse(native.ilinkHttpSubmit(url, method, headersJson, bodyStr, t) || "{}");
        if (!sub.ok || !sub.taskId) {
          return { ok: false, error: sub.error || "提交异步请求失败", raw: "" };
        }
        taskId = sub.taskId;
      } catch (e) {
        return { ok: false, error: String(e && e.message || e), raw: "" };
      }

      // 轮询取结果。给足余量：原生读超时 t 之后还会做收尾，多等 10 秒再放弃。
      // 间隔自适应：短请求要快（否则每次请求都被轮询间隔拖慢），
      // 长轮询则逐步放慢（40 秒 × 80ms = 500 次原生调用，没必要）。
      var deadline = Date.now() + t + 10000;
      var startedAt = Date.now();
      while (Date.now() < deadline) {
        var elapsed = Date.now() - startedAt;
        var gap = elapsed < 1500 ? 60 : (elapsed < 8000 ? 200 : 450);
        await sleepLocal(gap);
        var pr;
        try { pr = JSON.parse(native.ilinkHttpPoll(taskId) || "{}"); }
        catch (e) { pr = null; }
        if (!pr) continue;
        if (pr.done) {
          if (pr.result) return normalizeNative(pr.result);
          return { ok: false, error: pr.error || "异步请求无结果", raw: "" };
        }
        // done=false：还在跑，继续等
      }
      return { ok: false, timeout: true, httpStatus: 408, error: "等待原生响应超时", raw: "" };
    }

    // 次选：同步原生接口。这条会阻塞 JS 线程整整一个请求周期，所以：
    //   · 长轮询（>20s）绝不走它 —— 否则就是「界面卡死一分多钟」那个老问题；
    //   · 只有在拿不到异步接口时（旧版 APK）才用，并且只用于短请求。
    if (native && typeof native.sendNativeHttpRequest === "function") {
      if (t > 20000) {
        return {
          ok: false, httpStatus: 0, timeout: true,
          error: "当前 APK 的原生桥不支持异步请求，长轮询被跳过（请更新到最新版 APK）", raw: ""
        };
      }
      var fn = (typeof native.sendNativeHttpRequestWithTimeout === "function")
        ? "sendNativeHttpRequestWithTimeout" : "sendNativeHttpRequest";
      var out;
      try {
        out = (fn === "sendNativeHttpRequestWithTimeout")
          ? native.sendNativeHttpRequestWithTimeout(url, method, headersJson, bodyStr, t)
          : native.sendNativeHttpRequest(url, method, headersJson, bodyStr);
      } catch (e) {
        return { ok: false, error: String(e && e.message || e), raw: "" };
      }
      var parsed;
      try { parsed = JSON.parse(out || "{}"); }
      catch (e) { return { ok: false, error: "原生响应无法解析", raw: String(out).slice(0, 300) }; }
      return normalizeNative(parsed);
    }

    // fetch 兜底（可能受浏览器 CORS 限制；iLink 接口是否放开取决于官方）
    try {
      var ctrl = (typeof AbortController === "function") ? new AbortController() : null;
      var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, t) : null;
      var res = await fetch(url, {
        method: method,
        headers: headers,
        body: bodyStr || undefined,
        signal: ctrl ? ctrl.signal : undefined
      });
      if (timer) clearTimeout(timer);
      var txt = await res.text();
      var j = null;
      try { j = JSON.parse(txt); } catch (e) { j = null; }
      return { ok: res.ok, httpStatus: res.status, timeout: false, json: j, raw: txt };
    } catch (e) {
      var to = String(e && e.name) === "AbortError";
      return { ok: false, timeout: to, error: String(e && e.message || e), raw: "" };
    }
  }

  /** iLink 业务 POST 的请求头（登录后带 token） */
  function postHeaders(withAuth) {
    var h = {
      "Content-Type": "application/json",
      "AuthorizationType": "ilink_bot_token",
      "X-WECHAT-UIN": makeUin(),
      "iLink-App-Id": "bot",
      "iLink-App-ClientVersion": "132102"
    };
    if (withAuth) h["Authorization"] = "Bearer " + getToken();
    return h;
  }

  /** 二维码状态查询只需要公共应用头 */
  function qrHeaders() {
    return {
      "Content-Type": "application/json",
      "iLink-App-Id": "bot",
      "iLink-App-ClientVersion": "132102"
    };
  }

  function withBaseInfo(body) {
    var b = body || {};
    b.base_info = { channel_version: CHANNEL_VERSION, bot_agent: BOT_AGENT };
    return b;
  }

  /** 业务层成功判定：HTTP 2xx + JSON 可解析 + ret/errcode 为 0 或缺省 */
  function bizOk(res, allowTimeout) {
    if (res.timeout && allowTimeout) return { ok: true, timeout: true };
    if (!res.ok || !res.json) return { ok: false, res: res };
    var j = res.json;
    var ret = (j.ret === undefined) ? 0 : j.ret;
    var ec = (j.errcode === undefined) ? 0 : j.errcode;
    if (ret !== 0 || ec !== 0) {
      // -14 明确表示 token 失效
      var stale = (ret === -14 || ec === -14);
      return { ok: false, stale: stale, ret: ret, errcode: ec, errmsg: j.errmsg || "", res: res };
    }
    return { ok: true, json: j };
  }

  // =========================================================================
  // 登录
  // =========================================================================

  /** 申请二维码（固定入口），返回要编码进二维码的内容 */
  async function fetchQrcode() {
    var r = await request(
      FIXED_HOST + "/ilink/bot/get_bot_qrcode?bot_type=3",
      "POST", qrHeaders(), { local_token_list: [] }, NORMAL_TIMEOUT_MS
    );
    if (!r.ok || !r.json || r.json.ret !== 0) {
      return { ok: false, error: r.timeout ? "取二维码超时" : ("取二维码失败：" + (r.raw || "").slice(0, 120)) };
    }
    state.qrcode = r.json.qrcode || "";
    state.qrImgUrl = r.json.qrcode_img_content || "";
    state.qrIssuedAt = nowMs();
    state.qrRedirectHost = "";
    state.lastStatus = "wait";
    pushEvent("已获取登录二维码", "info");
    return { ok: true, qrcode: state.qrcode, content: state.qrImgUrl };
  }

  /**
   * 轮询一次扫码状态。
   * 返回 { status, done, needVerifyCode, error, stale }
   * status 取值见协议：wait / scaned / need_verifycode / verify_code_blocked /
   *   scaned_but_redirect / binded_redirect / expired / confirmed
   */
  async function pollQrcodeOnce(qrcodeOverride) {
    var qr = qrcodeOverride || state.qrcode;
    if (!qr) return { status: "expired", error: "没有可用二维码" };
    var host = state.qrRedirectHost ? ("https://" + state.qrRedirectHost) : FIXED_HOST;
    var url = host + "/ilink/bot/get_qrcode_status?qrcode=" + encodeURIComponent(qr);
    if (state.verifyCode) url += "&verify_code=" + encodeURIComponent(state.verifyCode);

    var r = await request(url, "GET", qrHeaders(), null, QR_POLL_TIMEOUT_MS);

    // 长轮询超时/网关 524 都属于正常控制流：保持二维码继续轮询
    if (r.timeout || r.httpStatus === 524 || r.httpStatus === 504) {
      return { status: "wait", timeout: true };
    }
    if (!r.ok || !r.json) {
      // 5xx 之类也按 wait 处理，避免一次抖动就判失败
      if (r.httpStatus >= 500) return { status: "wait", httpError: true };
      return { status: "error", error: "轮询失败：" + String(r.raw || r.error || "").slice(0, 120) };
    }

    var j = r.json;
    var st = j.status || (j.ret === 0 ? "wait" : "");
    state.lastStatus = st;

    if (st === "confirmed") {
      if (!j.ilink_bot_id) return { status: "error", error: "登录已确认但缺少账号标识（ilink_bot_id）" };
      var saved = saveLogin(j.bot_token || "", j.baseurl || FIXED_HOST, j.ilink_bot_id, j.ilink_user_id || "");
      // 换账号后旧游标不可复用
      try { localStorage.removeItem(LS.cursor); localStorage.removeItem(LS.cursorOwner); } catch (e) { }
      state.verifyCode = null;
      pushEvent("登录成功，账号 " + String(j.ilink_bot_id).slice(0, 12), "ok");
      if (!saved.ok) {
        // 本次会话照常可用（token 已在内存），但必须让用户知道存不下来
        pushEvent(saved.quota
          ? "但登录凭据没能保存：本机存储已满。请到「设置 → 数据管理 → 存储占用诊断」清理后重新扫码。"
          : ("但登录凭据保存失败：" + (saved.error || "未知原因")), "warn");
      }
      return {
        status: "confirmed", done: true, botId: j.ilink_bot_id,
        baseurl: j.baseurl || "", persisted: saved.ok, persistError: saved.ok ? "" : (saved.error || "")
      };
    }

    if (st === "scaned") {
      if (state.verifyCode) state.verifyCode = null;   // 配对码已接受，清掉暂存
      pushEvent("已扫码，等待手机端确认", "info");
      return { status: "scaned" };
    }

    if (st === "need_verifycode") {
      return { status: "need_verifycode", needVerifyCode: true };
    }

    if (st === "verify_code_blocked") {
      state.verifyCode = null;
      state.qrRefreshCount++;
      pushEvent("配对码多次错误被限制，已刷新二维码", "warn");
      return { status: "verify_code_blocked", needRefresh: true };
    }

    if (st === "scaned_but_redirect") {
      if (j.redirect_host) {
        state.qrRedirectHost = j.redirect_host;
        pushEvent("已切换到节点 " + String(j.redirect_host).slice(0, 24), "info");
      }
      return { status: "scaned_but_redirect" };
    }

    if (st === "binded_redirect") {
      // 本地仍有有效 token 才算成功；否则必须重新扫码
      if (isLoggedIn()) {
        pushEvent("该账号此前已绑定过，直接复用本地登录态", "ok");
        return { status: "binded_redirect", done: true, reused: true };
      }
      return { status: "binded_redirect", needRefresh: true, error: "服务端说已绑定，但本地没有可用登录态，需要重新扫码" };
    }

    if (st === "expired") {
      state.qrRefreshCount++;
      return { status: "expired", needRefresh: true };
    }

    return { status: st || "wait" };
  }

  /**
   * 完整登录流程：取码 → 轮询到 confirmed / 超时。
   * onQrcode(content) 用于界面显示二维码；onNeedVerify() 用于提示输入配对码。
   * 注意：本函数会一直轮询到结束，调用方负责提供取消方式（返回的 stop()）。
   */
  function startLogin(opts) {
    opts = opts || {};
    var stopped = false;
    var onQrcode = opts.onQrcode || function () { };
    var onState = opts.onState || function () { };
    var waitVerify = opts.waitVerifyCode || (function () { return Promise.resolve(null); });

    var promise = (async function () {
      var qr = await fetchQrcode();
      if (!qr.ok) { onState({ status: "error", error: qr.error }); return { ok: false, error: qr.error }; }
      onQrcode(qr.content);

      var deadline = nowMs() + (opts.overallTimeoutMs || 8 * 60 * 1000);

      while (!stopped && nowMs() < deadline) {
        // 二维码本地过期 → 续期
        if (nowMs() - state.qrIssuedAt > QR_TTL_MS) {
          if (state.qrRefreshCount >= QR_MAX_REFRESH) {
            var em = "二维码多次过期，本轮登录已结束，请重新发起";
            onState({ status: "expired", error: em });
            return { ok: false, error: em };
          }
          var again = await fetchQrcode();
          if (again.ok) onQrcode(again.content);
          else { onState({ status: "error", error: again.error }); return { ok: false, error: again.error }; }
          continue;
        }

        var r = await pollQrcodeOnce();
        if (stopped) break;

        if (r.needVerifyCode) {
          onState({ status: "need_verifycode" });
          // 等界面把配对码给回来；界面取消则返回 null
          var code = await waitVerify();
          if (stopped) break;
          if (!code) {
            onState({ status: "cancelled" });
            return { ok: false, error: "已取消输入配对码" };
          }
          state.verifyCode = String(code).trim();
          onState({ status: "verifying" });
          continue;
        }

        if (r.needRefresh) {
          if (state.qrRefreshCount >= QR_MAX_REFRESH) {
            var em2 = "二维码/配对码多次失败，本轮登录已结束，请稍后重试";
            onState({ status: "expired", error: em2 });
            return { ok: false, error: em2 };
          }
          state.verifyCode = null;
          var q2 = await fetchQrcode();
          if (q2.ok) onQrcode(q2.content);
          onState({ status: "refreshed" });
          continue;
        }

        if (r.done) {
          onState({ status: "confirmed" });
          return { ok: true, botId: r.botId, reused: !!r.reused };
        }

        if (r.status === "error") {
          onState({ status: "error", error: r.error });
          return { ok: false, error: r.error };
        }

        onState({ status: r.status });
        await sleep(900);
      }

      if (stopped) return { ok: false, error: "已取消" };
      var to = "登录等待超时（二维码有效期很短），请重新发起";
      onState({ status: "timeout", error: to });
      return { ok: false, error: to };
    })();

    return {
      promise: promise,
      stop: function () { stopped = true; }
    };
  }

  // =========================================================================
  // 收发消息
  // =========================================================================

  /**
   * 长轮询收消息。
   * 返回 { ok, messages: [...], timedOut, stale }
   * 每条消息：{ fromUserId, text, contextToken, msgId, raw }
   */
  async function getUpdates() {
    if (!isLoggedIn()) return { ok: false, error: "未登录" };
    var base = getBaseUrl() || FIXED_HOST;
    var body = withBaseInfo({ get_updates_buf: loadCursor() });
    var r = await request(base + "/ilink/bot/getupdates", "POST",
      postHeaders(true), body, LONGPOLL_TIMEOUT_MS);

    if (r.timeout) return { ok: true, messages: [], timedOut: true };

    var chk = bizOk(r, false);
    if (!chk.ok) {
      if (chk.stale) {
        pushEvent("登录态已失效（ret=-14），需要重新扫码", "danger");
        return { ok: false, stale: true, error: "登录态已失效，请重新扫码登录" };
      }
      return { ok: false, error: "收消息失败：" + (chk.errmsg || ("HTTP " + r.httpStatus)) };
    }

    var j = chk.json;
    // 只在响应成功且新游标非空时才推进游标
    if (j.get_updates_buf) saveCursor(j.get_updates_buf);

    var out = [];
    var msgs = j.msgs || [];
    for (var i = 0; i < msgs.length; i++) {
      var m = msgs[i];
      if (!m) continue;
      // 只处理用户发来的文本（1=USER）；其它类型先记录不误当文本
      if (m.message_type !== 1) continue;
      var text = "";
      var items = m.item_list || [];
      for (var k = 0; k < items.length; k++) {
        var it = items[k];
        if (it && it.type === 1 && it.text_item && it.text_item.text) {
          text += (text ? "\n" : "") + it.text_item.text;
        }
      }
      if (!text) continue;
      if (m.context_token) saveContextToken(m.from_user_id, m.context_token);
      out.push({
        fromUserId: m.from_user_id || "",
        text: text,
        contextToken: m.context_token || "",
        msgId: m.message_id !== undefined ? String(m.message_id) : "",
        raw: m
      });
    }
    return { ok: true, messages: out, timedOut: false };
  }

  /** 取 typing_ticket（可按用户缓存，仅用于「正在输入」） */
  async function getConfig(userId, contextToken) {
    var base = getBaseUrl() || FIXED_HOST;
    var r = await request(base + "/ilink/bot/getconfig", "POST", postHeaders(true),
      withBaseInfo({ ilink_user_id: userId, context_token: contextToken || "" }), NORMAL_TIMEOUT_MS);
    var chk = bizOk(r, false);
    if (!chk.ok) return { ok: false, error: chk.errmsg || "getconfig 失败" };
    return { ok: true, typingTicket: chk.json.typing_ticket || "" };
  }

  /** 发送「正在输入」状态；失败不应阻断正文发送 */
  async function sendTyping(userId, ticket, status) {
    if (!ticket) return { ok: false, error: "无 ticket" };
    var base = getBaseUrl() || FIXED_HOST;
    var r = await request(base + "/ilink/bot/sendtyping", "POST", postHeaders(true),
      withBaseInfo({ ilink_user_id: userId, typing_ticket: ticket, status: status }), NORMAL_TIMEOUT_MS);
    var chk = bizOk(r, false);
    return chk.ok ? { ok: true } : { ok: false, error: chk.errmsg || "sendtyping 失败" };
  }

  /**
   * 发送文本。必须校验业务返回码 —— HTTP 200 不代表投递成功。
   * contextToken 传当前入站消息的 token；主动发送时用按用户保存的最近值。
   */
  async function sendMessage(userId, text, contextToken) {
    if (!isLoggedIn()) return { ok: false, error: "未登录" };
    if (!userId) return { ok: false, error: "缺少接收方" };
    if (!text) return { ok: false, error: "内容为空" };
    var token = contextToken || getContextToken(userId);
    if (!token) return { ok: false, error: "缺少 context_token，无法回消息（可能已过期）" };

    var base = getBaseUrl() || FIXED_HOST;
    var payload = {
      msg: {
        from_user_id: "",
        to_user_id: userId,
        client_id: "story-phone-" + randomHex(16),
        message_type: 2,
        message_state: 2,
        context_token: token,
        item_list: [{ type: 1, text_item: { text: text } }]
      },
      base_info: { channel_version: CHANNEL_VERSION, bot_agent: BOT_AGENT }
    };
    var r = await request(base + "/ilink/bot/sendmessage", "POST",
      postHeaders(true), payload, NORMAL_TIMEOUT_MS);
    var chk = bizOk(r, false);
    if (!chk.ok) {
      if (chk.stale) return { ok: false, stale: true, error: "登录态失效，请重新扫码" };
      return { ok: false, error: "发送失败：" + (chk.errmsg || ("HTTP " + r.httpStatus)) };
    }
    return { ok: true };
  }

  /** 生命周期通知（最佳努力，失败不阻断） */
  async function notifyLifecycle(kind) {
    if (!isLoggedIn()) return { ok: false };
    var base = getBaseUrl() || FIXED_HOST;
    var path = (kind === "stop") ? "/ilink/bot/msg/notifystop" : "/ilink/bot/msg/notifystart";
    try {
      var r = await request(base + path, "POST", postHeaders(true), withBaseInfo({}), NORMAL_TIMEOUT_MS);
      return bizOk(r, false);
    } catch (e) { return { ok: false }; }
  }

  // =========================================================================
  // 后台消息循环
  // =========================================================================

  var loopState = { running: false, timer: null, abort: false };

  /**
   * 启动收消息循环。onMessage(msg) 返回 Promise（处理完再继续下一轮）。
   * 退避策略：普通失败等 2s；连续失败 3 次后等 30s 并清零计数。
   */
  function startMessageLoop(onMessage, opts) {
    opts = opts || {};
    if (loopState.running) return { stop: function () { } };
    loopState.running = true;
    loopState.abort = false;

    var onError = opts.onError || function () { };
    var onStale = opts.onStale || function () { };
    var onIdle = opts.onIdle || function () { };
    // 上层钩子：让调用方决定「这一轮该不该由本实例发起长轮询」。
    // 用途：本应用存在前后台两个 WebView 实例，若同时长轮询同一个 bot token，
    // 服务端会返回 HTTP 500 并踢掉连接，所以需要单实例持有。
    var beforePoll = typeof opts.beforePoll === "function" ? opts.beforePoll : null;
    var afterPoll = typeof opts.afterPoll === "function" ? opts.afterPoll : null;

    var tick = async function () {
      if (loopState.abort || !loopState.running) return;

      if (beforePoll) {
        var go = true;
        try { go = beforePoll() !== false; } catch (e) { go = true; }
        if (!go) {
          loopState.timer = setTimeout(tick, POLL_SKIP_MS);
          return;
        }
      }

      try {
        var r = await getUpdates();
        if (afterPoll) { try { afterPoll(r); } catch (e) { } }
        if (loopState.abort || !loopState.running) return;

        if (r.stale) {
          loopState.running = false;
          onStale(r.error);
          return;
        }
        if (!r.ok) {
          state.consecutiveFail++;
          onError(r.error);
          var wait = state.consecutiveFail >= BACKOFF_FAIL_THRESHOLD ? BACKOFF_LONG_MS : BACKOFF_SHORT_MS;
          if (state.consecutiveFail >= BACKOFF_FAIL_THRESHOLD) state.consecutiveFail = 0;
          loopState.timer = setTimeout(tick, wait);
          return;
        }
        state.consecutiveFail = 0;

        // 客户端超时：绝不能立刻重发。服务端可能仍持有上一条长轮询（hold 时长偶尔超过
        // 我们的超时），此时再发一条会让服务端看到同一 bot 的两条并发长轮询 →
        // 返回 HTTP 500 并把连接踢掉（这也是「聊到一半掉线」的成因之一）。
        if (r.timedOut) {
          onIdle();
          loopState.timer = setTimeout(tick, POLL_TIMEOUT_COOLDOWN_MS);
          return;
        }

        var msgs = r.messages || [];
        if (!msgs.length) onIdle();
        for (var i = 0; i < msgs.length; i++) {
          if (loopState.abort) break;
          try { await onMessage(msgs[i]); }
          catch (e) { log("处理消息出错", e); onError(String(e && e.message || e)); }
        }
      } catch (e) {
        state.consecutiveFail++;
        onError(String(e && e.message || e));
      }
      if (!loopState.abort && loopState.running) {
        loopState.timer = setTimeout(tick, 300);
      }
    };

    // 先宣告启动（最佳努力），再进入循环
    notifyLifecycle("start").then(function () { tick(); });
    pushEvent("已开始接收微信消息", "ok");

    return {
      stop: async function () {
        loopState.abort = true;
        loopState.running = false;
        if (loopState.timer) { clearTimeout(loopState.timer); loopState.timer = null; }
        // 停止通知用独立短超时，避免被取消信号一起带走
        try { await notifyLifecycle("stop"); } catch (e) { }
        pushEvent("已停止接收微信消息", "info");
      }
    };
  }

  function isLoopRunning() { return loopState.running; }

  // =========================================================================
  // 导出
  // =========================================================================

  var API = {
    // 常量 / 配置
    FIXED_HOST: FIXED_HOST,
    CHANNEL_VERSION: CHANNEL_VERSION,
    LONGPOLL_TIMEOUT_MS: LONGPOLL_TIMEOUT_MS,
    LS: LS,

    // 登录
    fetchQrcode: fetchQrcode,
    pollQrcodeOnce: pollQrcodeOnce,
    startLogin: startLogin,
    isLoggedIn: isLoggedIn,
    getBotId: getBotId,
    getUserId: getUserId,
    getToken: getToken,
    getBaseUrl: getBaseUrl,
    boundAt: function () { try { return Number(localStorage.getItem(LS.boundAt) || 0); } catch (e) { return 0; } },
    clearLogin: clearLogin,

    // 收发
    getUpdates: getUpdates,
    sendMessage: sendMessage,
    getConfig: getConfig,
    sendTyping: sendTyping,
    startMessageLoop: startMessageLoop,
    isLoopRunning: isLoopRunning,

    // 游标
    getCursor: loadCursor,
    clearCursor: function () { try { localStorage.removeItem(LS.cursor); localStorage.removeItem(LS.cursorOwner); } catch (e) { } },

    // 状态
    state: state,
    pushEvent: pushEvent
  };

  root.IlinkClient = API;
  if (typeof module !== "undefined" && module.exports) module.exports = API;
})(typeof window !== "undefined" ? window : globalThis);
