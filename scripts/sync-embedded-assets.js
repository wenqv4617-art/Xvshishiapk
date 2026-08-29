/**
 * scripts/sync-embedded-assets.js
 * ------------------------------------------------------------
 * 把 termux/ 目录下的脚本文件内容同步进两处内嵌副本：
 *   1. app/src/main/assets/app_local_deploy.js 的 JS 内嵌常量
 *      （CORS_PROXY_SOURCE / SERVICES_MANAGER_SOURCE / XSHISHI_LAUNCHER_SOURCE）
 *      —— 使「本地部署 → 部署引导」命令可直接在 Termux 里 heredoc 创建文件；
 *   2. termux-ncm-api.sh 的自包含引导脚本（heredoc 块 XSH_CORS_EOF /
 *      XSH_SVC_EOF / XSH_LAUNCHER_EOF）—— 使其无需联网下载任何文件。
 *
 * 用法：
 *   node scripts/sync-embedded-assets.js            # 重新生成两处内嵌副本
 *   node scripts/sync-embedded-assets.js --verify   # 只校验内嵌内容与 termux/ 目录是否一致
 *
 * 注意：请勿直接修改 app_local_deploy.js 的内嵌常量与 termux-ncm-api.sh 的
 *       heredoc 内容；修改 termux/ 目录文件后运行本脚本重新生成。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TARGET = path.join(ROOT, 'app', 'src', 'main', 'assets', 'app_local_deploy.js');
const TPL = path.join(__dirname, 'app_local_deploy.template.js');
const BOOTSTRAP = path.join(ROOT, 'termux-ncm-api.sh');
const SRC_CORS = path.join(ROOT, 'termux', 'cors-proxy.js');
const SRC_SVC = path.join(ROOT, 'termux', 'xvshishi-services.sh');
const SRC_LAUNCHER = path.join(ROOT, 'termux', 'xvshishi');

// JS 模板字符串转义：\ -> \\, ` -> \`, ${ -> \${（顺序重要：先转反斜杠）
function escapeTemplateLiteral(text) {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/\$\{/g, '\\${');
}

function read(file) {
  return fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
}

function extractConstant(src, name) {
  const re = new RegExp('var ' + name + ' = `([\\s\\S]*?)`;');
  const m = src.match(re);
  if (!m) throw new Error('app_local_deploy.js 中找不到常量 ' + name);
  // 源文件里是转义后的模板字符串源码，eval 还原为真实值再比较
  return eval('`' + m[1] + '`');
}

/** 提取 termux-ncm-api.sh 中指定 heredoc 标记的正文（含结尾换行） */
function extractHeredoc(src, marker) {
  const openTag = "<<'" + marker + "'";
  const start = src.indexOf(openTag);
  if (start < 0) return null;
  const bodyStart = src.indexOf('\n', start) + 1;
  const end = src.indexOf('\n' + marker, bodyStart);
  return end < 0 ? null : src.slice(bodyStart, end + 1);
}

/** 用 content 替换 termux-ncm-api.sh 中指定 heredoc 标记的正文 */
function patchHeredoc(src, marker, content) {
  const openTag = "<<'" + marker + "'";
  const start = src.indexOf(openTag);
  if (start < 0) throw new Error('termux-ncm-api.sh 中找不到 heredoc 起始 ' + openTag);
  const bodyStart = src.indexOf('\n', start) + 1;
  const end = src.indexOf('\n' + marker, bodyStart);
  if (end < 0) throw new Error('termux-ncm-api.sh 中找不到 heredoc 结束 ' + marker);
  return src.slice(0, bodyStart) + content + src.slice(end + 1);
}

function main() {
  const mode = process.argv[2] || 'generate';
  const cors = read(SRC_CORS);
  const svc = read(SRC_SVC);
  const launcher = read(SRC_LAUNCHER);

  if (mode === '--verify') {
    const cur = read(TARGET);
    const corsOk = extractConstant(cur, 'CORS_PROXY_SOURCE') === cors;
    const svcOk = extractConstant(cur, 'SERVICES_MANAGER_SOURCE') === svc;
    const launcherOk = extractConstant(cur, 'XSHISHI_LAUNCHER_SOURCE') === launcher;
    const boot = read(BOOTSTRAP);
    const bootCorsOk = extractHeredoc(boot, 'XSH_CORS_EOF') === cors;
    const bootSvcOk = extractHeredoc(boot, 'XSH_SVC_EOF') === svc;
    const bootLauncherOk = extractHeredoc(boot, 'XSH_LAUNCHER_EOF') === launcher;
    if (!corsOk || !svcOk || !launcherOk || !bootCorsOk || !bootSvcOk || !bootLauncherOk) {
      console.error('[sync-embedded-assets] ✗ 内嵌内容与 termux/ 目录文件不一致，请运行: node scripts/sync-embedded-assets.js');
      process.exit(1);
    }
    console.log('[sync-embedded-assets] ✓ 内嵌常量与 termux/ 目录文件一致');
    return;
  }

  // 1. 生成 app_local_deploy.js（JS 模板字符串需转义）
  let tpl = read(TPL);
  tpl = tpl.split('__CORS_PROXY_SOURCE__').join(escapeTemplateLiteral(cors));
  tpl = tpl.split('__SERVICES_MANAGER_SOURCE__').join(escapeTemplateLiteral(svc));
  tpl = tpl.split('__XSHISHI_LAUNCHER_SOURCE__').join(escapeTemplateLiteral(launcher));
  fs.writeFileSync(TARGET, tpl, 'utf8');

  // 2. 刷新 termux-ncm-api.sh 的 heredoc 正文（bash heredoc 无需转义，直接写入）
  let boot = read(BOOTSTRAP);
  boot = patchHeredoc(boot, 'XSH_CORS_EOF', cors);
  boot = patchHeredoc(boot, 'XSH_SVC_EOF', svc);
  boot = patchHeredoc(boot, 'XSH_LAUNCHER_EOF', launcher);
  fs.writeFileSync(BOOTSTRAP, boot, 'utf8');

  console.log('[sync-embedded-assets] 已重新生成:');
  console.log('  ' + path.relative(ROOT, TARGET) + '   (CORS_PROXY_SOURCE / SERVICES_MANAGER_SOURCE / XSHISHI_LAUNCHER_SOURCE)');
  console.log('  ' + path.relative(ROOT, BOOTSTRAP) + ' (heredoc: XSH_CORS_EOF / XSH_SVC_EOF / XSH_LAUNCHER_EOF)');
  console.log('  termux/cors-proxy.js        -> ' + cors.length + ' chars');
  console.log('  termux/xvshishi-services.sh -> ' + svc.length + ' chars');
  console.log('  termux/xvshishi             -> ' + launcher.length + ' chars');
}

main();
