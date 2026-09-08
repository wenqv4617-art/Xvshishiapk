#!/data/data/com.termux/files/usr/bin/env node
// ============================================================
// 叙事诗小手机 - link-meta（内置脚本4 · 分享链接元数据解析服务，端口 3003）
// ------------------------------------------------------------
// 用途：App/网页受 WebView 沙箱与 CORS 限制，无法直接抓取分享链接的标题/封面/摘要。
//       本服务在 Termux 内以「服务端」身份抓取并解析，返回干净 JSON 给 App 渲染分享卡片。
// 能力：
//   - 跟随重定向（xhslink.cn 短链 → 小红书笔记/主页）
//   - 移动端 UA 伪装（小红书对桌面 UA 不返回内容）
//   - 小红书笔记：解析页面内嵌 __INITIAL_STATE__，提取标题/正文/作者/图片列表
//   - 通用网页：og:title/og:description/og:image/twitter:* / <title>
// 接口：
//   GET /health                → 健康检查
//   GET /meta?url=<目标链接>    → 返回 {ok, finalUrl, site, kind, title, desc, author, images[]}
// 管理：xvshishi start link-meta
// ============================================================

'use strict';
const http = require('http');
const https = require('https');

const PORT = process.env.PORT || 3003;
const MAX_REDIRECT = 8;
const TIMEOUT_MS = 15000;
const MAX_BYTES = 3 * 1024 * 1024;

const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

const SITE_MAP = [
  [/xhslink\.cn|xiaohongshu\.com/i, '小红书'],
  [/bilibili\.com|b23\.tv/i, '哔哩哔哩'],
  [/douyin\.com|iesdouyin/i, '抖音'],
  [/weibo\.(cn|com)/i, '微博'],
  [/zhihu\.com/i, '知乎'],
  [/github\.com/i, 'GitHub'],
  [/youtube\.com|youtu\.be/i, 'YouTube'],
  [/taobao\.com|tmall\.com|tb\.cn/i, '淘宝'],
  [/jd\.com/i, '京东'],
  [/music\.163\.com/i, '网易云音乐'],
  [/y\.qq\.com|qq\.com/i, 'QQ音乐'],
  [/mp\.weixin\.qq\.com/i, '微信公众号']
];

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Max-Age', '86400');
}

function sendJson(res, code, obj) {
  cors(res);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function siteOf(url) {
  for (const [re, name] of SITE_MAP) if (re.test(url)) return name;
  try { return new URL(url).hostname; } catch (e) { return ''; }
}

function unescapeJson(s) {
  if (!s) return '';
  return String(s)
    .replace(/\\u002F/gi, '/')
    .replace(/\\u002f/g, '/')
    .replace(/\\\//g, '/')
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, ' ')
    .replace(/\\"/g, '"')
    .replace(/\\u([0-9a-fA-F]{4})/g, (m, h) => String.fromCharCode(parseInt(h, 16)));
}

function cleanText(s) {
  return unescapeJson(String(s || ''))
    .replace(/<[^>]+>/g, '')
    .replace(/[\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 带重定向的 GET，返回 { finalUrl, body, status } */
function fetchFollow(targetUrl, depth) {
  depth = depth || 0;
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(targetUrl); } catch (e) { return reject(new Error('invalid url')); }
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(u, {
      method: 'GET',
      headers: {
        'User-Agent': MOBILE_UA,
        'Accept': 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'Accept-Encoding': 'identity'
      },
      timeout: TIMEOUT_MS
    }, (resp) => {
      const code = resp.statusCode || 0;
      if (code >= 300 && code < 400 && resp.headers.location) {
        if (depth >= MAX_REDIRECT) { resp.resume(); return reject(new Error('too many redirects')); }
        const next = new URL(resp.headers.location, u).toString();
        resp.resume();
        return resolve(fetchFollow(next, depth + 1));
      }
      let size = 0;
      const chunks = [];
      resp.on('data', (c) => {
        size += c.length;
        if (size > MAX_BYTES) { req.destroy(); return; }
        chunks.push(c);
      });
      resp.on('end', () => {
        resolve({ finalUrl: u.toString(), status: code, body: Buffer.concat(chunks).toString('utf8') });
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
    req.end();
  });
}

function metaTag(html, prop) {
  const re = new RegExp('<meta[^>]+(?:property|name)=["\']' + prop.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '["\'][^>]*>', 'i');
  const m = html.match(re);
  if (!m) return '';
  const c = m[0].match(/content=["\']([\s\S]*?)["\']/i);
  return c ? cleanText(c[1]) : '';
}

/** 小红书笔记解析（页面内嵌 __INITIAL_STATE__，用正则稳取字段，避免 undefined 破坏 JSON.parse） */
function parseXhsNote(html) {
  const out = { title: '', desc: '', author: '', images: [] };
  let m = html.match(/"title"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (m) out.title = cleanText(m[1]);
  m = html.match(/"desc"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (m) out.desc = cleanText(m[1]);
  m = html.match(/"nickName"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (m) out.author = cleanText(m[1]);

  // 图片：优先 H5_DTL（高清），其次任意 sns-webpic 链接；按 fileId 去重
  const urls = [];
  const re = /"url"\s*:\s*"(http[^"]*?sns-(?:webpic|img)[^"]*)"/g;
  let mm;
  while ((mm = re.exec(html)) !== null) {
    const u = unescapeJson(mm[1]);
    if (!/^https?:\/\//.test(u)) continue;
    if (/\/(avatar|logo)\//i.test(u)) continue;
    urls.push(u);
  }
  const seen = {};
  for (const u of urls) {
    const key = (u.match(/1040g[0-9a-z]+/i) || [u])[0];
    if (seen[key]) {
      // 同图不同尺寸时，优先 h5_1080 / H5_DTL 版本
      if (/h5_1080|H5_DTL/i.test(u) && !/h5_1080|H5_DTL/i.test(seen[key])) seen[key] = u;
      continue;
    }
    seen[key] = u;
    if (urls.length > 60) break;
  }
  out.images = Object.values(seen).slice(0, 9);
  return out;
}

/** 通用网页解析：og / twitter / title / 首图 */
function parseGeneric(html, finalUrl) {
  const out = { title: '', desc: '', author: '', images: [] };
  out.title = metaTag(html, 'og:title') || metaTag(html, 'twitter:title');
  out.desc = metaTag(html, 'og:description') || metaTag(html, 'description') || metaTag(html, 'twitter:description');
  const ogImg = metaTag(html, 'og:image') || metaTag(html, 'twitter:image');
  if (!out.title) {
    const t = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    if (t) out.title = cleanText(t[1]);
  }
  if (ogImg) out.images.push(unescapeJson(ogImg));
  return out;
}

async function buildMeta(target) {
  const r = await fetchFollow(target);
  const html = r.body || '';
  const finalUrl = r.finalUrl;
  const site = siteOf(finalUrl) || siteOf(target);
  const isXhs = /xiaohongshu\.com|xhslink\.cn/i.test(finalUrl);
  const isXhsNote = /xiaohongshu\.com\/(discovery\/item|explore)\//i.test(finalUrl);

  let parsed;
  let kind = 'web';
  if (isXhs && isXhsNote) {
    parsed = parseXhsNote(html);
    kind = 'xhs-note';
  } else {
    parsed = parseGeneric(html, finalUrl);
    kind = isXhs ? 'xhs-profile' : 'web';
  }
  // 小红书主页补充：description 里通常有粉丝/关注信息
  if (kind === 'xhs-profile' && !parsed.desc) parsed.desc = metaTag(html, 'description');

  return {
    ok: true,
    finalUrl,
    site,
    kind,
    title: parsed.title || site || finalUrl,
    desc: parsed.desc || '',
    author: parsed.author || '',
    images: parsed.images || []
  };
}

const server = http.createServer((req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  const u = new URL(req.url || '/', 'http://127.0.0.1');
  if (u.pathname === '/health') {
    return sendJson(res, 200, { ok: true, service: 'link-meta', port: PORT });
  }
  if (u.pathname !== '/meta') {
    return sendJson(res, 404, { ok: false, error: 'not found', usage: '/meta?url=https://xhslink.cn/o/xxxx' });
  }
  const target = u.searchParams.get('url') || '';
  if (!/^https?:\/\//i.test(target)) {
    return sendJson(res, 400, { ok: false, error: 'missing or invalid url' });
  }
  buildMeta(target).then((meta) => sendJson(res, 200, meta)).catch((e) => {
    sendJson(res, 200, { ok: false, error: e.message || 'fetch failed', finalUrl: target, site: siteOf(target) });
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('[link-meta] listening on http://127.0.0.1:' + PORT);
});
