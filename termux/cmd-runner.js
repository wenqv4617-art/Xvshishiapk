#!/data/data/com.termux/files/usr/bin/env node
// ============================================================
// 叙事诗小手机 - cmd-runner（内置脚本3 · AI 命令执行服务）
// ------------------------------------------------------------
// 用途：让「工作台 Agent」能执行 termux 命令 / 运行自己写的脚本 /
//       做 git 仓库操作（clone/commit/push），并取回 stdout/stderr。
// 原理：在 Termux 内常驻一个只监听 127.0.0.1 的小 HTTP 服务（端口 3002），
//       工作台通过 http://127.0.0.1:3002/run 提交 { cmd, cwd, timeout_ms }。
// 安全：
//   - 只绑定 127.0.0.1（仅本机可访问）；
//   - 若存在 ~/.xvshishi/.cmd_token 文件，则要求请求头 X-Cmd-Token 一致才执行
//     （echo -n '你的随机口令' > ~/.xvshishi/.cmd_token 即可启用）；
//   - 命令以 Termux 用户身份运行，请勿随意开放给不可信来源。
// 管理：由 xvshishi-services.sh 统一启停：xvshishi start cmd-runner
// ============================================================

'use strict';
const http = require('http');
const { exec } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 3002;
const HOME = os.homedir();
const TOKEN_FILE = path.join(HOME, '.xvshishi', '.cmd_token');

function token() {
  try { return fs.readFileSync(TOKEN_FILE, 'utf8').trim() || null; } catch (e) { return null; }
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Cmd-Token');
  res.setHeader('Access-Control-Max-Age', '86400');
}

function sendJson(res, code, obj) {
  cors(res);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function runCmd(cmd, cwd, timeoutMs, cb) {
  const target = (cwd && fs.existsSync(cwd)) ? cwd : HOME;
  exec(cmd, {
    cwd: target,
    timeout: timeoutMs || 90000,
    maxBuffer: 4 * 1024 * 1024,
    encoding: 'utf8'
  }, function (err, stdout, stderr) {
    cb({
      ok: !err,
      exitCode: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
      killed: !!(err && err.killed),
      stdout: String(stdout || ''),
      stderr: String(stderr || '')
    });
  });
}

const server = http.createServer(function (req, res) {
  cors(res);
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const tk = token();
  if (tk) {
    const given = req.headers['x-cmd-token'];
    if (given !== tk) { sendJson(res, 403, { ok: false, error: 'token 校验失败（请检查请求头 X-Cmd-Token）' }); return; }
  }

  const url = String(req.url || '/');

  if (req.method === 'GET' && url.indexOf('/health') === 0) {
    exec('git --version', { timeout: 5000 }, function (e, so) {
      sendJson(res, 200, { ok: true, service: 'cmd-runner', port: PORT, git: e ? null : String(so || '').trim() });
    });
    return;
  }

  if (req.method === 'POST' && url.indexOf('/run') === 0) {
    let body = '';
    req.on('data', function (c) { body += c; if (body.length > 524288) req.destroy(); });
    req.on('end', function () {
      let p = {};
      try { p = JSON.parse(body || '{}'); } catch (e) { sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' }); return; }
      const cmd = String(p.cmd || '').trim();
      if (!cmd) { sendJson(res, 400, { ok: false, error: '缺少 cmd' }); return; }
      runCmd(cmd, String(p.cwd || ''), p.timeout_ms || 90000, function (r) { sendJson(res, 200, r); });
    });
    return;
  }

  sendJson(res, 404, { ok: false, error: 'not found' });
});

server.listen(PORT, '127.0.0.1', function () {
  console.log('[cmd-runner] listening on http://127.0.0.1:' + PORT + (token() ? ' (token 已启用)' : ' (未启用 token，仅绑定本机)'));
});
