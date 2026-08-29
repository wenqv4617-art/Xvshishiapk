#!/usr/bin/env node
/**
 * scripts/urlban-tool.js - URL 禁止列表加密工具（独立于整个项目运行）
 * ------------------------------------------------------------
 * 用途：
 *   1. 开发者输入明文 URL，工具输出加密格式，追加进禁止列表文件
 *      （用户只看到加密密文，无法读取/篡改明文 URL）；
 *   2. 开发者可用工具解密整个列表文件，随时查看/修改禁止站点。
 *
 * 加密格式（与 App 内 app_url_ban.js 完全一致）：
 *   "XU1:" + Base64( [版本:1字节][IV:4字节][密文] )
 *   密文 = 明文 UTF-8 字节 ^ 密钥流；密钥流由 mulberry32 伪随机数生成器产生，
 *   种子 = FNV-1a32(口令) ^ FNV-1a32(明文) * 黄金比例混合。
 *   同一明文加密结果确定（同 URL 同密文），方便去重与核对。
 *
 * 用法：
 *   node urlban-tool.js enc <url>                 加密单个 URL，输出一行密文
 *   node urlban-tool.js dec <blob>                解密单个密文条目，输出明文
 *   node urlban-tool.js build <in.txt> [out.js]   明文列表(每行一个URL，# 为注释) -> 生成整个加密列表文件
 *   node urlban-tool.js dec-file <list.js>        解密整个列表文件，逐行打印明文 URL
 *   node urlban-tool.js key                       打印当前密钥指纹（用于核对工具与 App 密钥一致）
 *
 * 可选参数：-k <passphrase>  覆盖默认口令（必须与 app_url_ban.js 的 PASSPHRASE 一致才能互通）
 * 示例：
 *   node urlban-tool.js enc "https://bad-site.example.com"
 *   node urlban-tool.js dec "XU1:xxxx"
 *   node urlban-tool.js build banned.txt            # 默认输出 app/src/main/assets/url_ban_list.js
 *   node urlban-tool.js dec-file app/src/main/assets/url_ban_list.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

// ============ 密钥口令（唯一秘密；必须与 app_url_ban.js 中的 PASSPHRASE 保持一致）============
const DEFAULT_PASSPHRASE = 'XVSHISHI_URLBAN_2026_K3y#8f3a9c!';

// ============ 基础工具 ============
const B64C = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function b64Encode(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
    out += B64C[b0 >> 2] + B64C[((b0 & 3) << 4) | (b1 >> 4)] + B64C[((b1 & 15) << 2) | (b2 >> 6)] + B64C[b2 & 63];
  }
  const rem = bytes.length % 3;
  if (rem === 1) out = out.slice(0, -2) + '==';
  else if (rem === 2) out = out.slice(0, -1) + '=';
  return out;
}

function b64Decode(str) {
  const s = String(str).replace(/=+$/, '');
  const out = [];
  let bits = 0;
  let c = 0;
  for (let i = 0; i < s.length; i++) {
    const v = B64C.indexOf(s[i]);
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

function utf8Encode(str) { return Array.from(Buffer.from(String(str), 'utf8')); }
function utf8Decode(bytes) { return Buffer.from(bytes).toString('utf8'); }

function fnv1a32Bytes(bytes) {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
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
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ============ 加密 / 解密 ============
const MAGIC = 'XU1:';
const VERSION = 1;

function deriveSeed(passphrase, iv) {
  const keySeed = fnv1a32(passphrase);
  return (keySeed ^ Math.imul(iv, 0x9e3779b1)) >>> 0;
}

function encrypt(plain, passphrase) {
  const p = utf8Encode(plain);
  const iv = fnv1a32Bytes(p); // 4 字节，由明文派生（确定性强）
  const rand = mulberry32(deriveSeed(passphrase, iv));
  const out = [VERSION];
  out.push((iv >>> 24) & 0xff, (iv >>> 16) & 0xff, (iv >>> 8) & 0xff, iv & 0xff);
  for (let i = 0; i < p.length; i++) {
    const ks = Math.floor(rand() * 256);
    out.push((p[i] ^ ks) & 0xff);
  }
  return MAGIC + b64Encode(out);
}

function decrypt(blob, passphrase) {
  const s = String(blob || '').trim();
  if (s.indexOf(MAGIC) !== 0) return null;
  const bytes = b64Decode(s.slice(MAGIC.length));
  if (bytes.length < 5 || bytes[0] !== VERSION) return null;
  const iv = ((bytes[1] << 24) | (bytes[2] << 16) | (bytes[3] << 8) | bytes[4]) >>> 0;
  const rand = mulberry32(deriveSeed(passphrase, iv));
  const p = [];
  for (let i = 5; i < bytes.length; i++) {
    const ks = Math.floor(rand() * 256);
    p.push(bytes[i] ^ ks);
  }
  return utf8Decode(p);
}

// ============ URL 规整 ============
function normalizeUrl(u) {
  u = String(u || '').trim();
  if (!u) return '';
  try {
    const p = new URL(u);
    p.hash = '';
    let out = p.origin + p.pathname;
    if (p.search) out += p.search;
    if (out.length > 1 && out.endsWith('/')) out = out.slice(0, -1);
    return out;
  } catch (e) {
    return u.replace(/\/+$/, '');
  }
}

// ============ 命令实现 ============
function parseArgs(argv) {
  const args = [];
  let passphrase = DEFAULT_PASSPHRASE;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '-k') { passphrase = argv[++i] || DEFAULT_PASSPHRASE; }
    else args.push(argv[i]);
  }
  return { args, passphrase };
}

function readPlainList(file) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  const seen = new Set();
  const out = [];
  lines.forEach((raw) => {
    const line = String(raw).trim();
    if (!line || line.charAt(0) === '#') return;
    const norm = normalizeUrl(line);
    if (!norm) { console.warn('[urlban-tool] 跳过无效 URL: ' + line); return; }
    if (seen.has(norm)) return;
    seen.add(norm);
    out.push(norm);
  });
  return out;
}

function buildListFile(plainList, outFile) {
  const blob = encrypt(plainList.join('\n'), DEFAULT_PASSPHRASE);
  const displayPath = path.isAbsolute(outFile) && outFile.indexOf(path.join(__dirname, '..')) === 0
    ? path.relative(path.join(__dirname, '..'), outFile)
    : outFile;
  const content =
    '/* 本文件由 scripts/urlban-tool.js 生成 - 请勿手改（内容已整体加密，仅工具可破译） */\n' +
    '/* 查看/修改：node scripts/urlban-tool.js dec-file ' + displayPath + ' ；再编辑明文后 build 重新生成 */\n' +
    'window.__URL_BAN_LIST__ = ' + JSON.stringify(blob) + ';\n';
  fs.writeFileSync(outFile, content, 'utf8');
  return blob;
}

function main() {
  const { args, passphrase } = parseArgs(process.argv.slice(2));
  const cmd = args[0];

  switch (cmd) {
    case 'enc': {
      const url = normalizeUrl(args[1] || '');
      if (!url) { console.error('用法: node urlban-tool.js enc <url>'); process.exit(1); }
      console.log(encrypt(url, passphrase));
      break;
    }
    case 'dec': {
      const blob = args[1] || '';
      const plain = decrypt(blob, passphrase);
      if (plain === null) { console.error('解密失败：格式非法或口令不匹配'); process.exit(1); }
      console.log(plain);
      break;
    }
    case 'build': {
      const inFile = args[1];
      if (!inFile) { console.error('用法: node urlban-tool.js build <in.txt> [out.js]'); process.exit(1); }
      const outFile = args[2] || path.join(__dirname, '..', 'app', 'src', 'main', 'assets', 'url_ban_list.js');
      const list = readPlainList(inFile);
      buildListFile(list, outFile);
      console.log('[urlban-tool] 已生成 ' + outFile);
      console.log('[urlban-tool] 共 ' + list.length + ' 条禁止 URL');
      list.forEach((u) => console.log('  - ' + u));
      break;
    }
    case 'dec-file': {
      const listFile = args[1];
      if (!listFile) { console.error('用法: node urlban-tool.js dec-file <list.js>'); process.exit(1); }
      const src = fs.readFileSync(listFile, 'utf8');
      const m = src.match(/window\.__URL_BAN_LIST__\s*=\s*"([^"]+)"/);
      if (!m) { console.error('文件中未找到加密列表'); process.exit(1); }
      const plain = decrypt(m[1], passphrase);
      if (plain === null) { console.error('解密失败：口令不匹配或文件损坏'); process.exit(1); }
      console.log('[urlban-tool] 禁止列表明文（共 ' + plain.split('\n').filter(Boolean).length + ' 条）:');
      plain.split('\n').forEach((u) => { if (u) console.log('  - ' + u); });
      break;
    }
    case 'key': {
      console.log('[urlban-tool] 当前密钥指纹 FNV-1a32 = ' + fnv1a32(passphrase) + ' (0x' + fnv1a32(passphrase).toString(16) + ')');
      console.log('[urlban-tool] 口令长度: ' + passphrase.length + ' 字符');
      break;
    }
    default:
      console.log(
        'URL 禁止列表加密工具\n' +
        '用法:\n' +
        '  node urlban-tool.js enc <url>                 加密单个 URL\n' +
        '  node urlban-tool.js dec <blob>                解密单个条目\n' +
        '  node urlban-tool.js build <in.txt> [out.js]   明文列表 -> 生成整个加密文件\n' +
        '  node urlban-tool.js dec-file <list.js>        解密整个列表文件\n' +
        '  node urlban-tool.js key                       打印密钥指纹\n' +
        '可选: -k <passphrase> 覆盖默认口令（需与 app_url_ban.js 的 PASSPHRASE 一致）'
      );
      process.exit(1);
  }
}

main();
