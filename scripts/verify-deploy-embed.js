// 综合校验（纯进程内，不 spawn 子进程）：内嵌常量、heredoc 内容、JS 语法、残留地址、行尾
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.resolve(__dirname, '..');

let failed = false;
const fail = (msg) => { failed = true; console.error('✗ ' + msg); };
const ok = (msg) => console.log('✓ ' + msg);

const readf = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

// 1. JS 语法（仅编译，不执行）
for (const f of ['app/src/main/assets/app_local_deploy.js', 'app/src/main/assets/app_assistant.js']) {
  try { new vm.Script(readf(f), { filename: f }); ok('JS 语法: ' + f); }
  catch (e) { fail('JS 语法: ' + f + '\n' + e.message); }
}

// 2. app_local_deploy.js 内嵌常量与 termux/ 目录一致
{
  const cur = readf('app/src/main/assets/app_local_deploy.js');
  const extract = (name) => {
    const re = new RegExp('var ' + name + ' = `([\\s\\S]*?)`;');
    const m = cur.match(re);
    if (!m) throw new Error('找不到常量 ' + name);
    return eval('`' + m[1] + '`');
  };
  const cors = readf('termux/cors-proxy.js');
  const svc = readf('termux/xvshishi-services.sh');
  const launcher = readf('termux/xvshishi');
  if (extract('CORS_PROXY_SOURCE') === cors && extract('SERVICES_MANAGER_SOURCE') === svc && extract('XSHISHI_LAUNCHER_SOURCE') === launcher) {
    ok('app_local_deploy.js 内嵌常量与 termux/ 一致');
  } else {
    fail('app_local_deploy.js 内嵌常量与 termux/ 不一致，请运行 node scripts/sync-embedded-assets.js');
  }
}

// 3. termux-ncm-api.sh heredoc 内容一致
{
  const b = readf('termux-ncm-api.sh');
  function heredoc(marker) {
    const start = b.indexOf("'" + marker + "'");
    if (start < 0) return null;
    const bodyStart = b.indexOf('\n', start) + 1;
    const end = b.indexOf('\n' + marker, bodyStart);
    return end < 0 ? null : b.slice(bodyStart, end + 1);
  }
  if (heredoc('XSH_CORS_EOF') === readf('termux/cors-proxy.js')) ok('termux-ncm-api.sh 内嵌 cors-proxy.js 一致');
  else fail('termux-ncm-api.sh 内嵌 cors-proxy.js 不一致');
  if (heredoc('XSH_SVC_EOF') === readf('termux/xvshishi-services.sh')) ok('termux-ncm-api.sh 内嵌 xvshishi-services.sh 一致');
  else fail('termux-ncm-api.sh 内嵌 xvshishi-services.sh 不一致');
  if (heredoc('XSH_LAUNCHER_EOF') === readf('termux/xvshishi')) ok('termux-ncm-api.sh 内嵌 xvshishi 唤出命令一致');
  else fail('termux-ncm-api.sh 内嵌 xvshishi 唤出命令不一致');
}

// 4. 残留下载地址
{
  const all = ['app/src/main/assets/app_local_deploy.js', 'termux-ncm-api.sh'].map(readf).join('\n');
  const bad = all.match(/raw\.githubusercontent\.com\/wenqv4617|wenqv4617-art\/Xvshishiapk\/main|curl -L https:\/\/raw/g);
  if (bad) fail('发现残留下载地址: ' + bad.join(', '));
  else ok('无残留下载地址');
}

// 5. 行尾一致性
for (const f of ['termux/cors-proxy.js', 'termux/xvshishi-services.sh', 'termux/xvshishi', 'termux-ncm-api.sh']) {
  if (readf(f).includes('\r')) fail(f + ' 仍有 CRLF');
  else ok(f + ' 为 LF 行尾');
}

console.log(failed ? '\n== 校验未通过 ==' : '\n== 全部校验通过 ==');
process.exit(failed ? 1 : 0);
