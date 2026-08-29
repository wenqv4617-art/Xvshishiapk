/**
 * app_crypto.js - 全局加密/解密共享模块（与 scripts/urlban-tool.js 算法完全一致）
 * ------------------------------------------------------------
 * 用途：
 *   1. URL 禁止列表（app_url_ban.js）解密
 *   2. 登录账密关键字段（app_auth.js 的 SUPABASE_URL / ANON_KEY、
 *      cached_user_password 缓存）加密存储与解密
 *   3. 与独立部署的开发者工作台（tools/dev-workbench/index.html）互通
 *
 * 加密格式：
 *   "XU1:" + Base64( [版本:1字节][IV:4字节][密文] )
 *   密文 = 明文 UTF-8 字节 ^ mulberry32 密钥流
 *   种子 = FNV-1a32(口令) ^ FNV-1a32(明文) * 黄金比例混合
 *   同一明文 + 同一口令 → 同一密文（确定性强，便于核对去重）
 *
 * 注意：口令 PASSPHRASE 是唯一秘密，必须与 scripts/urlban-tool.js
 *       及 tools/dev-workbench/index.html 保持一致；修改口令后需用工具
 *       重新生成 url_ban_list.js 与登录字段密文。
 */
(function () {
  "use strict";

  // ============ 密钥口令（唯一秘密；三处保持一致：本文件 / urlban-tool.js / 工作台）============
  var PASSPHRASE = "XVSHISHI_URLBAN_2026_K3y#8f3a9c!";

  // ============ 基础工具 ============
  var B64C = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

  function b64Encode(bytes) {
    var out = "";
    for (var i = 0; i < bytes.length; i += 3) {
      var b0 = bytes[i];
      var b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
      var b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
      out += B64C[b0 >> 2] + B64C[((b0 & 3) << 4) | (b1 >> 4)] + B64C[((b1 & 15) << 2) | (b2 >> 6)] + B64C[b2 & 63];
    }
    var rem = bytes.length % 3;
    if (rem === 1) out = out.slice(0, -2) + "==";
    else if (rem === 2) out = out.slice(0, -1) + "=";
    return out;
  }

  function b64Decode(str) {
    var s = String(str).replace(/=+$/, "");
    var out = [];
    var bits = 0;
    var c = 0;
    for (var i = 0; i < s.length; i++) {
      var v = B64C.indexOf(s[i]);
      if (v < 0) continue;
      bits = (bits << 6) | v;
      c += 6;
      if (c >= 8) {
        c -= 8;
        out.push((bits >> c) & 0xff);
      }
    }
    return out;
  }

  function utf8Encode(str) {
    if (typeof TextEncoder === "function") {
      return Array.prototype.slice.call(new TextEncoder().encode(String(str)));
    }
    var out = [];
    var s = String(str);
    for (var i = 0; i < s.length; i++) {
      var code = s.charCodeAt(i);
      if (code < 0x80) out.push(code);
      else if (code < 0x800) out.push(0xc0 | (code >> 6), 0x80 | (code & 63));
      else out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63));
    }
    return out;
  }

  function utf8Decode(bytes) {
    if (typeof TextDecoder === "function") {
      return new TextDecoder().decode(new Uint8Array(bytes));
    }
    var out = "";
    for (var i = 0; i < bytes.length; i++) {
      var b = bytes[i];
      if (b < 0x80) out += String.fromCharCode(b);
      else if (b < 0xe0) out += String.fromCharCode(((b & 31) << 6) | (bytes[++i] & 63));
      else out += String.fromCharCode(((b & 15) << 12) | ((bytes[++i] & 63) << 6) | (bytes[++i] & 63));
    }
    return out;
  }

  function fnv1a32Bytes(bytes) {
    var h = 0x811c9dc5;
    for (var i = 0; i < bytes.length; i++) {
      h ^= bytes[i];
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h >>> 0;
  }

  function fnv1a32(str) { return fnv1a32Bytes(utf8Encode(str)); }

  function mulberry32(a) {
    return function () {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ============ 加密 / 解密 ============
  var MAGIC = "XU1:";
  var VERSION = 1;

  function deriveSeed(passphrase, iv) {
    var keySeed = fnv1a32(passphrase);
    return (keySeed ^ Math.imul(iv, 0x9e3779b1)) >>> 0;
  }

  function encrypt(plain, passphrase) {
    var pass = passphrase || PASSPHRASE;
    var p = utf8Encode(plain);
    var iv = fnv1a32Bytes(p);
    var rand = mulberry32(deriveSeed(pass, iv));
    var out = [VERSION];
    out.push((iv >>> 24) & 0xff, (iv >>> 16) & 0xff, (iv >>> 8) & 0xff, iv & 0xff);
    for (var i = 0; i < p.length; i++) {
      var ks = Math.floor(rand() * 256);
      out.push((p[i] ^ ks) & 0xff);
    }
    return MAGIC + b64Encode(out);
  }

  function decrypt(blob, passphrase) {
    var s = String(blob || "").trim();
    if (s.indexOf(MAGIC) !== 0) return null;
    var bytes = b64Decode(s.slice(MAGIC.length));
    if (bytes.length < 5 || bytes[0] !== VERSION) return null;
    var pass = passphrase || PASSPHRASE;
    var iv = ((bytes[1] << 24) | (bytes[2] << 16) | (bytes[3] << 8) | bytes[4]) >>> 0;
    var rand = mulberry32(deriveSeed(pass, iv));
    var p = [];
    for (var i = 5; i < bytes.length; i++) {
      var ks = Math.floor(rand() * 256);
      p.push(bytes[i] ^ ks);
    }
    return utf8Decode(p);
  }

  // ============ 对外接口 ============
  window.xvshishiCrypto = {
    PASSPHRASE: PASSPHRASE,
    MAGIC: MAGIC,
    encrypt: encrypt,
    decrypt: decrypt,
    fingerprint: function (passphrase) {
      var pass = passphrase || PASSPHRASE;
      var h = fnv1a32(pass);
      return { dec: h, hex: "0x" + h.toString(16) };
    }
  };
})();
