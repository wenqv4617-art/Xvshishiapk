/**
 * scripts/sync-embedded-assets.js
 * ------------------------------------------------------------
 * 把 termux/ 目录下的脚本文件内容同步进 App 前端资源
 * app/src/main/assets/app_local_deploy.js 的内嵌常量
 * （CORS_PROXY_SOURCE / SERVICES_MANAGER_SOURCE），
 * 使「本地部署 → 部署引导」命令可直接在 Termux 里 heredoc 创建文件，
 * 无需展示/依赖任何下载地址。
 *
 * 用法：
 *   node scripts/sync-embedded-assets.js            # 重新生成 app_local_deploy.js
 *   node scripts/sync-embedded-assets.js --verify   # 只校验内嵌内容与 termux/ 目录是否一致
 *
 * 注意：请勿直接修改 app_local_deploy.js 的内嵌常量；
 *       修改 termux/ 目录文件后运行本脚本重新生成。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TARGET = path.join(ROOT, 'app', 'src', 'main', 'assets', 'app_local_deploy.js');
const TPL = path.join(__dirname, 'app_local_deploy.template.js');
const SRC_CORS = path.join(ROOT, 'termux', 'cors-proxy.js');
const SRC_SVC = path.join(ROOT, 'termux', 'xvshishi-services.sh');

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

function main() {
  const mode = process.argv[2] || 'generate';
  const cors = read(SRC_CORS);
  const svc = read(SRC_SVC);

  if (mode === '--verify') {
    const cur = read(TARGET);
    const corsOk = extractConstant(cur, 'CORS_PROXY_SOURCE') === cors;
    const svcOk = extractConstant(cur, 'SERVICES_MANAGER_SOURCE') === svc;
    if (!corsOk || !svcOk) {
      console.error('[sync-embedded-assets] ✗ 内嵌常量与 termux/ 目录文件不一致，请运行: node scripts/sync-embedded-assets.js');
      process.exit(1);
    }
    console.log('[sync-embedded-assets] ✓ 内嵌常量与 termux/ 目录文件一致');
    return;
  }

  let tpl = read(TPL);
  tpl = tpl.split('__CORS_PROXY_SOURCE__').join(escapeTemplateLiteral(cors));
  tpl = tpl.split('__SERVICES_MANAGER_SOURCE__').join(escapeTemplateLiteral(svc));
  fs.writeFileSync(TARGET, tpl, 'utf8');
  console.log('[sync-embedded-assets] 已重新生成 ' + path.relative(ROOT, TARGET));
  console.log('  termux/cors-proxy.js        -> CORS_PROXY_SOURCE        (' + cors.length + ' chars)');
  console.log('  termux/xvshishi-services.sh -> SERVICES_MANAGER_SOURCE  (' + svc.length + ' chars)');
}

main();
