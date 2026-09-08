#!/data/data/com.termux/files/usr/bin/env node
// ============================================================
// 叙事诗小手机 - link-meta（内置脚本4 · 分享链接元数据解析服务，端口 3003）
// ------------------------------------------------------------
// 用途：App/网页受 WebView 沙箱与 CORS 限制，无法直接抓取分享链接的标题/封面/摘要。
//       本服务在 Termux 内以「服务端」身份抓取并解析，返回干净 JSON 给 App 渲染分享卡片。
// 能力：
//   - 跟随重定向（xhslink.cn 短链 → 小红书笔记/主页）
//   - 移动端 UA 伪装（小红书对桌面 UA 不返回内容）
//   - 小红书笔记「全信息」：标题/正文/作者/图片列表 + 点赞/收藏/评论/分享数 + 发布时间
//     + 话题标签 + 首屏评论（含子评论），即"点进链接能看到什么，就返回什么"
//   - 通用网页：og:title/og:description/og:image/twitter:* / <title>
//   - /img 图片代理（补 CORS 头，供 App 把帖子配图压缩后随消息送给视觉模型）
// 接口：
//   GET /health                → 健康检查
//   GET /meta?url=<目标链接>    → 返回 {ok, finalUrl, site, kind, title, desc, author, images[],
//                                        likedCount, collectedCount, commentCount, shareCount,
//                                        publishTime, tags[], noteId, comments[], commentsHasMore}
//   GET /img?url=<图片地址>     → 原样转发图片字节（Access-Control-Allow-Origin: *）
// 管理：xvshishi start link-meta
// ============================================================

'use strict';
const http = require('http');
const https = require('https');

const PORT = process.env.PORT || 3003;
const MAX_REDIRECT = 8;
const TIMEOUT_MS = 15000;
const MAX_BYTES = 3 * 1024 * 1024;
const MAX_IMG_BYTES = 8 * 1024 * 1024;
const MAX_IMAGES = 20;
const MAX_COMMENTS = 12;

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

/** 已是 JSON.parse 后的字符串：只做标签剥离与空白整理，可保留换行 */
function tidyText(s, keepNewlines) {
  let t = String(s == null ? '' : s).replace(/<[^>]+>/g, '').replace(/\r/g, '');
  if (keepNewlines) {
    t = t.replace(/[ \t\u00a0]+/g, ' ').replace(/\n{3,}/g, '\n\n');
    return t.split('\n').map((l) => l.trim()).join('\n').trim();
  }
  return t.replace(/\s+/g, ' ').trim();
}

function toInt(v) {
  if (v == null) return null;
  if (typeof v === 'number' && isFinite(v)) return Math.round(v);
  const m = String(v).replace(/[^\d.]/g, '');
  if (!m) return null;
  const f = parseFloat(m);
  return isNaN(f) ? null : Math.round(f);
}

function toHttps(u) {
  const s = String(u || '');
  if (/^http:\/\//i.test(s)) return 'https://' + s.slice(7);
  return s;
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

/** 下载图片字节（跟随重定向），返回 { type, buf } */
function fetchImage(targetUrl, depth) {
  depth = depth || 0;
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(targetUrl); } catch (e) { return reject(new Error('invalid url')); }
    const lib = u.protocol === 'https:' ? https : http;
    // 小红书图床（xhscdn）对自身域名 Referer 返回 403，必须伪装成站内来源
    const referer = /xhscdn\.com|xiaohongshu\.com|xhslink\.cn/i.test(u.hostname)
      ? 'https://www.xiaohongshu.com/'
      : (u.origin + '/');
    const req = lib.request(u, {
      method: 'GET',
      headers: {
        'User-Agent': MOBILE_UA,
        'Accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
        'Referer': referer,
        'Accept-Encoding': 'identity'
      },
      timeout: TIMEOUT_MS
    }, (resp) => {
      const code = resp.statusCode || 0;
      if (code >= 300 && code < 400 && resp.headers.location) {
        if (depth >= MAX_REDIRECT) { resp.resume(); return reject(new Error('too many redirects')); }
        const next = new URL(resp.headers.location, u).toString();
        resp.resume();
        return resolve(fetchImage(next, depth + 1));
      }
      if (code !== 200) { resp.resume(); return reject(new Error('http ' + code)); }
      let size = 0;
      const chunks = [];
      resp.on('data', (c) => {
        size += c.length;
        if (size > MAX_IMG_BYTES) { req.destroy(); return; }
        chunks.push(c);
      });
      resp.on('end', () => {
        const type = String(resp.headers['content-type'] || '').split(';')[0].trim();
        if (!/^image\//i.test(type)) return reject(new Error('not an image: ' + type));
        resolve({ type, buf: Buffer.concat(chunks) });
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

/** 从任意位置起做括号配对截取（字符串/转义感知），用于取内嵌 JSON 片段 */
function balancedSlice(s, start) {
  let d = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (ch === '\\') { esc = true; continue; }
      if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{' || ch === '[') d++;
    else if (ch === '}' || ch === ']') { d--; if (d === 0) return s.slice(start, i + 1); }
  }
  return '';
}

/** 取页面内嵌 window.__INITIAL_STATE__（小红书为单行 JSON，可能含 undefined 需兜底修复） */
function extractInitialState(html) {
  const m = html.match(/window\.__INITIAL_STATE__\s*=\s*/);
  if (!m) return null;
  const start = m.index + m[0].length;
  let end = html.indexOf('</script>', start);
  if (end < 0) end = html.length;
  const raw = html.slice(start, end).trim().replace(/;\s*$/, '');
  try { return JSON.parse(raw); } catch (e) {}
  try { return JSON.parse(raw.replace(/:\s*undefined(?=\s*[,}\]])/g, ':null')); } catch (e) {}
  return null;
}

/** 按 key 取内嵌对象/数组（正则定位 + 括号配对 + JSON.parse），作为整页解析失败时的兜底 */
function grabJson(html, key) {
  const i = html.indexOf('"' + key + '":');
  if (i < 0) return null;
  const s = html.indexOf('{', i);
  const a = html.indexOf('[', i);
  let start = -1;
  if (s >= 0 && a >= 0) start = Math.min(s, a);
  else start = s >= 0 ? s : a;
  if (start < 0) return null;
  const raw = balancedSlice(html, start);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}

/** 小红书图片条目 → 最佳 URL（优先 h5_1080 / H5_DTL 高清版） */
function pickImageUrl(item) {
  if (!item || typeof item !== 'object') return '';
  const cands = [];
  if (typeof item.url === 'string') cands.push(item.url);
  (item.infoList || []).forEach((ii) => { if (ii && typeof ii.url === 'string') cands.push(ii.url); });
  if (!cands.length) return '';
  const best = cands.find((u) => /h5_1080|H5_DTL/i.test(u)) || cands[0];
  return toHttps(best);
}

/** 首屏评论 → 精简结构 */
function mapComment(c) {
  if (!c || typeof c !== 'object') return null;
  const user = (c.user && (c.user.nickname || c.user.nickName)) || '';
  const content = tidyText(c.content || '', true);
  if (!content && !user) return null;
  return {
    user,
    content,
    like: toInt(c.likeCount) || 0,
    ip: c.ipLocation || '',
    time: toInt(c.time) || 0,
    subs: (c.subComments || []).slice(0, 3).map((s) => ({
      user: (s && s.user && (s.user.nickname || s.user.nickName)) || '',
      content: tidyText((s && s.content) || '', true)
    })).filter((s) => s.content)
  };
}

/** 小红书笔记解析：优先整页 __INITIAL_STATE__ 结构化读取，失败回退正则 */
function parseXhsNote(html) {
  const out = {
    title: '', desc: '', author: '', images: [],
    likedCount: null, collectedCount: null, commentCount: null, shareCount: null,
    publishTime: 0, tags: [], noteId: '', comments: [], commentsHasMore: false
  };

  const st = extractInitialState(html);
  const data = st && st.noteData && st.noteData.data;
  const note = data && data.noteData;
  const cdata = data && data.commentData;

  if (note) {
    out.title = tidyText(note.title || '');
    out.desc = tidyText(note.desc || '', true);
    out.author = (note.user && (note.user.nickName || note.user.nickname)) || '';
    out.noteId = note.noteId || '';
    out.publishTime = toInt(note.time) || 0;
    out.tags = (note.tagList || []).map((t) => tidyText((t && t.name) || '')).filter(Boolean);
    const ii = note.interactInfo || {};
    out.likedCount = toInt(ii.likedCount);
    out.collectedCount = toInt(ii.collectedCount);
    out.commentCount = toInt(ii.commentCount);
    out.shareCount = toInt(ii.shareCount);
    const seen = {};
    (note.imageList || []).forEach((it) => {
      const u = pickImageUrl(it);
      if (!u) return;
      if (/\/avatar\//i.test(u)) return;
      const key = (it && it.fileId) || (u.match(/1040g[0-9a-z]+/i) || [u])[0];
      if (seen[key]) return;
      seen[key] = u;
    });
    out.images = Object.values(seen).slice(0, MAX_IMAGES);
  }

  // ---- 兜底：整页 JSON 解析失败时用正则逐个字段取 ----
  if (!out.title) {
    const m = html.match(/"title"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    if (m) out.title = cleanText(m[1]);
  }
  if (!out.desc) {
    const m = html.match(/"desc"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    if (m) out.desc = cleanText(m[1]);
  }
  if (!out.author) {
    const m = html.match(/"nickName"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    if (m) out.author = cleanText(m[1]);
  }
  if (!out.images.length) {
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
        if (/h5_1080|H5_DTL/i.test(u) && !/h5_1080|H5_DTL/i.test(seen[key])) seen[key] = u;
        continue;
      }
      seen[key] = u;
      if (urls.length > 60) break;
    }
    out.images = Object.values(seen).slice(0, MAX_IMAGES).map(toHttps);
  }
  if (out.likedCount == null && out.commentCount == null) {
    const ii = grabJson(html, 'interactInfo');
    if (ii) {
      out.likedCount = toInt(ii.likedCount);
      out.collectedCount = toInt(ii.collectedCount);
      out.commentCount = toInt(ii.commentCount);
      out.shareCount = toInt(ii.shareCount);
    }
  }
  if (!out.tags.length) {
    const tl = grabJson(html, 'tagList');
    if (Array.isArray(tl)) out.tags = tl.map((t) => cleanText((t && t.name) || '')).filter(Boolean);
  }
  if (!out.publishTime) {
    const tm = html.match(/"atUserList"\s*:\s*\[\s*\]\s*,\s*"time"\s*:\s*(\d{13})/);
    const tm2 = tm || html.match(/"time"\s*:\s*(\d{13})/);
    if (tm2) out.publishTime = Number(tm2[1]);
  }
  if (!out.comments.length) {
    const cd = grabJson(html, 'commentData');
    if (cd && Array.isArray(cd.comments)) {
      out.commentCount = out.commentCount != null ? out.commentCount : toInt(cd.commentCount);
      out.commentsHasMore = !!cd.hasMore;
    }
  }
  if (cdata) {
    if (out.commentCount == null) out.commentCount = toInt(cdata.commentCount);
    out.commentsHasMore = !!cdata.hasMore;
    out.comments = (cdata.comments || []).map(mapComment).filter(Boolean).slice(0, MAX_COMMENTS);
  } else if (!out.comments.length) {
    const cd = grabJson(html, 'commentData');
    if (cd && Array.isArray(cd.comments)) {
      out.comments = cd.comments.map(mapComment).filter(Boolean).slice(0, MAX_COMMENTS);
      out.commentsHasMore = !!cd.hasMore;
    }
  }

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

  const meta = {
    ok: true,
    finalUrl,
    site,
    kind,
    title: parsed.title || site || finalUrl,
    desc: parsed.desc || '',
    author: parsed.author || '',
    images: parsed.images || []
  };
  // 小红书笔记附带全量互动/评论信息（非笔记类不返回，保持通用结构干净）
  if (kind === 'xhs-note') {
    meta.likedCount = parsed.likedCount;
    meta.collectedCount = parsed.collectedCount;
    meta.commentCount = parsed.commentCount;
    meta.shareCount = parsed.shareCount;
    meta.publishTime = parsed.publishTime || 0;
    meta.tags = parsed.tags || [];
    meta.noteId = parsed.noteId || '';
    meta.comments = parsed.comments || [];
    meta.commentsHasMore = !!parsed.commentsHasMore;
  }
  return meta;
}

// ---- 图片代理：内存小缓存，避免同一帖多图被反复下载 ----
const imgCache = new Map();
const IMG_CACHE_TTL = 10 * 60 * 1000;
const IMG_CACHE_MAX = 40;

function cacheGet(key) {
  const hit = imgCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > IMG_CACHE_TTL) { imgCache.delete(key); return null; }
  return hit;
}

function cacheSet(key, type, buf) {
  if (imgCache.size >= IMG_CACHE_MAX) {
    const first = imgCache.keys().next();
    if (!first.done) imgCache.delete(first.value);
  }
  imgCache.set(key, { at: Date.now(), type, buf });
}

const server = http.createServer((req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  const u = new URL(req.url || '/', 'http://127.0.0.1');
  if (u.pathname === '/health') {
    return sendJson(res, 200, { ok: true, service: 'link-meta', port: PORT });
  }
  if (u.pathname === '/img') {
    const target = u.searchParams.get('url') || '';
    if (!/^https?:\/\//i.test(target)) return sendJson(res, 400, { ok: false, error: 'missing or invalid url' });
    const cached = cacheGet(target);
    if (cached) {
      res.writeHead(200, { 'Content-Type': cached.type, 'Cache-Control': 'public, max-age=600', 'Content-Length': cached.buf.length });
      return res.end(cached.buf);
    }
    return fetchImage(target).then((r) => {
      cacheSet(target, r.type, r.buf);
      res.writeHead(200, { 'Content-Type': r.type, 'Cache-Control': 'public, max-age=600', 'Content-Length': r.buf.length });
      res.end(r.buf);
    }).catch((e) => sendJson(res, 502, { ok: false, error: e.message || 'image fetch failed' }));
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
