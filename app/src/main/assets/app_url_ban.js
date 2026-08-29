/**
 * app_url_ban.js - 全局 API URL 禁止列表（前端拦截 + 文件缺失保护）
 * ------------------------------------------------------------
 * 功能：
 *   1. 读取内置加密禁止列表文件（url_ban_list.js，整个文件加密），解密后
 *      跳过 # 注释行得到明文禁止 URL；提供 urlBan.guard / isBanned 供
 *      设置页（API 协议设置、向量化记忆设置等）在保存/连接前拦截；
 *   2. 全局包装 window.fetch：任何请求命中禁止 URL 时直接在前端拒绝，
 *      绝不发出真实请求，并弹出提示卡片；
 *   3. 【文件缺失保护】若 url_ban_list.js 被删除/损坏/口令不匹配（列表不可用），
 *      则进入 fail-closed 模式：无论输入什么 URL，点击拉取模型或连接
 *      都只会弹出卡片「此 url 已被禁用，请联系开发者」，任何请求都不会发出；
 *   4. 【匹配增强】条目只填域名 → 拦整站；条目带路径（如 /v1）→ 拦该路径
 *      及其所有子路径（例如条目 https://x.com/v1 能拦下 /v1/models、/v1/embeddings）。
 *
 * 提示文案为加密常量（由 tools/urlban-tool.js enc 生成，运行时解密），
 * 防止用户篡改；有工具者可自行重新生成替换。
 * 加密/解密统一走 app_crypto.js（window.xvshishiCrypto），与工具及
 * 独立工作台 tools/dev-workbench/index.html 完全一致。
 */
(function () {
  "use strict";

  var crypto = window.xvshishiCrypto || { decrypt: function () { return null; } };

  // ============ 加密的提示文案（防篡改；tools/urlban-tool.js enc 生成）============
  var MSG_TITLE = crypto.decrypt("XU1:AQBroNRua5h1AKteg22E54kmzGZkPIk=") || "访问已被阻止";
  var MSG_BANNED = crypto.decrypt("XU1:AakMAYcXMjG8MwXjpkWDfoEcOZJxd6uX0ywIuPhelc5W+pNs1Tv5AGBDRcqWLScd9AQBJgZZZ5pwd0fn+9I57Q==") || "此 url 已被禁止，如有疑问请联系开发人员。";
  var MSG_FILE_MISSING = crypto.decrypt("XU1:AaEaO54mXiFZhm9qJtjOpPD0LSIUuKlgAkr0WiWtflE7G6s8eRQpBDA5FldKmml7/g==") || "此 url 已被禁用，请联系开发者。";

  // ============ URL 规整与匹配 ============
  function normalizeUrl(u) {
    u = String(u || "").trim();
    if (!u) return "";
    try {
      var p = new URL(u);
      p.hash = "";
      var out = p.origin + p.pathname;
      if (p.search) out += p.search;
      if (out.length > 1 && out.charAt(out.length - 1) === "/") out = out.slice(0, -1);
      return out;
    } catch (e) {
      return u.replace(/\/+$/, "");
    }
  }

  var _list = null;
  var _listState = "unknown"; // "ok" | "missing" | "broken"

  /**
   * 列表是否可用（文件存在且能解密）。
   * 缺失 / 损坏 / 口令不匹配 → false（fail-closed，全部拦截）。
   */
  function isListReady() {
    if (_listState === "unknown") {
      _list = [];
      var blob = (typeof window.__URL_BAN_LIST__ === "string") ? window.__URL_BAN_LIST__ : "";
      if (!blob) {
        _listState = "missing";
      } else {
        var plain = crypto.decrypt(blob);
        if (plain === null) {
          _listState = "broken";
        } else {
          _listState = "ok";
          _list = plain.split(/\r?\n/).map(function (s) { return s.trim(); })
            .filter(function (s) { return s && s.charAt(0) !== "#"; });
        }
      }
    }
    return _listState === "ok";
  }

  /**
   * 判断 URL 是否命中禁止列表。
   * 返回 { entry, mode } 或 null：
   *   mode "exact" 精确；mode "host" 整站（条目仅域名）；mode "prefix" 路径前缀（含 /v1 场景）。
   */
  function isUrlBanned(raw) {
    if (!isListReady()) return null; // 文件缺失走 guard/fetch 的 fail-closed 分支
    var url = normalizeUrl(raw);
    if (!url) return null;
    var list = _list;
    for (var i = 0; i < list.length; i++) {
      var entry = list[i];
      if (url === entry) return { entry: entry, mode: "exact" };
      try {
        var eUrl = new URL(entry);
        var uUrl = new URL(url);
        if (eUrl.origin !== uUrl.origin) continue;
        var ePath = (eUrl.pathname || "").replace(/\/+$/, "");
        var uPath = (uUrl.pathname || "").replace(/\/+$/, "");
        if (ePath === "" || ePath === "/") {
          return { entry: entry, mode: "host" }; // 条目只有域名 → 拦整站
        }
        // 条目带路径（如 /v1）→ 拦该路径及其子路径
        if (uPath === ePath || uPath.indexOf(ePath + "/") === 0) {
          return { entry: entry, mode: "prefix" };
        }
      } catch (e) { /* 忽略非法条目 */ }
    }
    return null;
  }

  // ============ 弹窗卡片 ============
  var _lastShown = 0;
  var _showing = false;

  function esc(str) {
    if (!str) return "";
    return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function showBanCard(url, msg) {
    var now = Date.now();
    if (_showing || now - _lastShown < 3000) return; // 3 秒内不重复弹
    _lastShown = now;
    var message = msg || MSG_BANNED;
    var overlay = document.createElement("div");
    overlay.id = "url-ban-overlay";
    overlay.style.cssText = "position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(15,23,42,0.55);z-index:99998;display:flex;align-items:center;justify-content:center;padding:20px;box-sizing:border-box;";
    overlay.innerHTML =
      '<div style="background:#ffffff;border-radius:18px;max-width:320px;width:100%;padding:22px;text-align:center;box-shadow:0 10px 40px rgba(0,0,0,0.25);box-sizing:border-box;">' +
        '<div style="width:46px;height:46px;margin:0 auto 12px;border-radius:50%;background:#fee2e2;display:flex;align-items:center;justify-content:center;font-size:22px;line-height:1;">🚫</div>' +
        '<div style="font-size:15px;font-weight:800;color:#1f2937;margin-bottom:8px;">' + esc(MSG_TITLE) + '</div>' +
        '<div style="font-size:12px;line-height:1.8;color:#6b7280;">' + esc(message) + '</div>' +
        '<div style="margin-top:8px;padding:8px 10px;border-radius:8px;background:#fef2f2;color:#dc2626;font-size:11px;word-break:break-all;line-height:1.6;">' + esc(url) + '</div>' +
        '<button id="url-ban-ok" style="margin-top:16px;width:100%;height:40px;border:none;border-radius:10px;background:#6366f1;color:#fff;font-size:13px;font-weight:700;cursor:pointer;">知道了</button>' +
      '</div>';
    document.body.appendChild(overlay);
    _showing = true;
    var close = function () {
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      _showing = false;
    };
    var okBtn = document.getElementById("url-ban-ok");
    if (okBtn) okBtn.onclick = close;
    overlay.addEventListener("click", function (e) { if (e.target === overlay) close(); });
  }

  // ============ 全局 fetch 包装（任何连接请求先过禁查；文件缺失时全拦，绝不放行）============
  if (typeof window.fetch === "function" && !window.__urlBanWrapped) {
    window.__urlBanWrapped = true;
    var _origFetch = window.fetch.bind(window);
    window.fetch = function (input, init) {
      var urlStr = (typeof input === "string") ? input
        : (input && (input.url || input.href)) || String(input);
      // 列表文件缺失/损坏 → fail-closed：任何请求都不发出
      if (!isListReady()) {
        showBanCard(urlStr || "未知地址", MSG_FILE_MISSING);
        return Promise.reject(new TypeError("URL_BAN_LIST_MISSING"));
      }
      if (urlStr && isUrlBanned(urlStr)) {
        showBanCard(urlStr);
        return Promise.reject(new TypeError("URL_BANNED: " + urlStr));
      }
      return _origFetch(input, init);
    };
  }

  // ============ 对外接口 ============
  window.urlBan = {
    /** 设置页保存/测试前调用；命中（或列表缺失）→ 弹卡片并返回 false，调用方应中止操作 */
    guard: function (url) {
      if (!isListReady()) { showBanCard(url || "未知地址", MSG_FILE_MISSING); return false; }
      if (isUrlBanned(url)) { showBanCard(url); return false; }
      return true;
    },
    isBanned: isUrlBanned,
    isListReady: isListReady,
    showCard: showBanCard,
    getBannedList: function () { return isListReady() ? _list : []; },
    normalize: normalizeUrl
  };
})();
