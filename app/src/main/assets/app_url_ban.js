/**
 * app_url_ban.js - 全局 API URL 禁止列表（前端拦截）
 * ------------------------------------------------------------
 * 功能：
 *   1. 读取内置加密禁止列表文件（url_ban_list.js，整体加密，仅开发者
 *      通过 scripts/urlban-tool.js 可破译/修改），解密后得到明文禁止 URL；
 *   2. 提供 urlBan.guard(url) / urlBan.isBanned(url) 供全局 API 设置
 *      （设置 → API 协议设置、向量化记忆设置等）在保存/连接前拦截；
 *   3. 全局包装 window.fetch：任何请求命中禁止 URL 时直接在前端拒绝，
 *      并弹出提示卡片「此 url 已被禁止，如有疑问请联系开发人员」。
 *
 * 加密/解密统一走 app_crypto.js（window.xvshishiCrypto），算法与
 * scripts/urlban-tool.js 及独立工作台 tools/dev-workbench/index.html 完全一致。
 */
(function () {
  "use strict";

  var crypto = window.xvshishiCrypto || { decrypt: function () { return null; } };

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
  function getList() {
    if (_list) return _list;
    _list = [];
    var blob = (typeof window.__URL_BAN_LIST__ === "string") ? window.__URL_BAN_LIST__ : "";
    if (blob) {
      var plain = crypto.decrypt(blob);
      if (plain) {
        _list = plain.split(/\r?\n/).map(function (s) { return s.trim(); })
          .filter(function (s) { return s && s.charAt(0) !== "#"; });
      }
    }
    return _list;
  }

  /**
   * 判断 URL 是否命中禁止列表。
   * 返回 { entry, mode } 或 null：
   *   mode "exact" 精确匹配；mode "host" 整站（条目只有主机）匹配。
   */
  function isUrlBanned(raw) {
    var url = normalizeUrl(raw);
    if (!url) return null;
    var list = getList();
    for (var i = 0; i < list.length; i++) {
      var entry = list[i];
      if (url === entry) return { entry: entry, mode: "exact" };
      try {
        var eUrl = new URL(entry);
        if (eUrl.pathname === "" || eUrl.pathname === "/") {
          var uUrl = new URL(url);
          if (uUrl.origin === eUrl.origin) return { entry: entry, mode: "host" };
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

  function showBanCard(url) {
    var now = Date.now();
    if (_showing || now - _lastShown < 3000) return; // 3 秒内不重复弹
    _lastShown = now;
    var overlay = document.createElement("div");
    overlay.id = "url-ban-overlay";
    overlay.style.cssText = "position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(15,23,42,0.55);z-index:99998;display:flex;align-items:center;justify-content:center;padding:20px;box-sizing:border-box;";
    overlay.innerHTML =
      '<div style="background:#ffffff;border-radius:18px;max-width:320px;width:100%;padding:22px;text-align:center;box-shadow:0 10px 40px rgba(0,0,0,0.25);box-sizing:border-box;">' +
        '<div style="width:46px;height:46px;margin:0 auto 12px;border-radius:50%;background:#fee2e2;display:flex;align-items:center;justify-content:center;font-size:22px;line-height:1;">🚫</div>' +
        '<div style="font-size:15px;font-weight:800;color:#1f2937;margin-bottom:8px;">访问已被阻止</div>' +
        '<div style="font-size:12px;line-height:1.8;color:#6b7280;">此 url 已被禁止，如有疑问请联系开发人员。</div>' +
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

  // ============ 全局 fetch 包装（任何连接请求先过禁查）============
  if (typeof window.fetch === "function" && !window.__urlBanWrapped) {
    window.__urlBanWrapped = true;
    var _origFetch = window.fetch.bind(window);
    window.fetch = function (input, init) {
      var urlStr = (typeof input === "string") ? input
        : (input && (input.url || input.href)) || String(input);
      if (urlStr && isUrlBanned(urlStr)) {
        showBanCard(urlStr);
        return Promise.reject(new TypeError("URL_BANNED: " + urlStr));
      }
      return _origFetch(input, init);
    };
  }

  // ============ 对外接口 ============
  window.urlBan = {
    isBanned: isUrlBanned,
    guard: function (url) {
      if (isUrlBanned(url)) { showBanCard(url); return false; }
      return true;
    },
    showCard: showBanCard,
    getBannedList: getList,
    normalize: normalizeUrl
  };
})();
