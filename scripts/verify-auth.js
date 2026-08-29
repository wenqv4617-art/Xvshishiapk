// 校验 invite.html 内联解密函数能正确还原账密字段，且全仓无明文账密残留
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.resolve(__dirname, '..');

let failed = false;
const assert = (name, cond) => { if (cond) console.log('✓ ' + name); else { console.error('✗ ' + name); failed = true; } };

// 1. invite.html 内联解密
{
  const html = fs.readFileSync(path.join(ROOT, 'app/src/main/assets/invite.html'), 'utf8');
  const m = html.match(/<script>([\s\S]*?)<\/script>/);
  assert('invite.html 含内联脚本', !!m);
  const script = m[1];
  // 截取加密工具函数 + 两个密文常量，单独求值验证
  const start = script.indexOf('var __X_PASS__');
  const end = script.indexOf('// 这里把名字改成了');
  const cryptoPart = script.slice(start, end);
  const ctx = { Math: Math, console: console };
  vm.createContext(ctx);
  vm.runInContext(cryptoPart, ctx);
  const url = vm.runInContext('__x_dec__("XU1:AZZftICREnl9S4fPuE7awZ3u87ZVtHLMKmG4QJG6GKNIsBjOwYJ5SDj1dy0c")', ctx);
  const key = vm.runInContext('__x_dec__("XU1:AbeNHLoyp6bsZ5ieZsBFn8Yecp5tzxaoBdsszIgjLlA+pLWuPFlFSf6OKJ5u+p5p0vPt")', ctx);
  assert('invite.html 解密 SUPABASE_URL', url === 'https://itqigfuhxaqglnergizc.supabase.co');
  assert('invite.html 解密 ANON_KEY', key === 'sb_publishable_el5tQonGZp4ymQunND3Cqw_WSs5h8Bg');
}

// 2. 全仓 assets 无明文账密残留（允许出现的地方：invite.html 与 app_auth.js 仅密文；README 等说明文档除外）
{
  const targets = [
    'app/src/main/assets/app_auth.js',
    'app/src/main/assets/invite.html',
    'app/src/main/assets/url_ban_list.js',
    'app/src/main/assets/app_crypto.js',
    'app/src/main/assets/app_url_ban.js'
  ];
  for (const f of targets) {
    const s = fs.readFileSync(path.join(ROOT, f), 'utf8');
    if (s.includes('sb_publishable_el5tQonGZp4ymQunND3Cqw_WSs5h8Bg')) { assert(f + ' 无明文 ANON_KEY', false); failed = true; }
    else assert(f + ' 无明文 ANON_KEY', true);
  }
}

console.log(failed ? '\n== 校验未通过 ==' : '\n== 账密加密校验通过 ==');
process.exit(failed ? 1 : 0);
