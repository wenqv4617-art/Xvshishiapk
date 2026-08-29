// 综合校验：加密体系（App 共享模块 / 禁止列表 / 登录账密字段 / CLI 工具 / 独立工作台）互通一致
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.resolve(__dirname, '..');

let failed = false;
const assert = (name, cond) => { if (cond) console.log('✓ ' + name); else { console.error('✗ ' + name); failed = true; } };

const readf = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const KNOWN_URL = 'https://itqigfuhxaqglnergizc.supabase.co';
const KNOWN_KEY = 'sb_publishable_el5tQonGZp4ymQunND3Cqw_WSs5h8Bg';

// 通用浏览器沙箱
function makeSandbox(extra) {
  const sandbox = {
    window: {},
    TextEncoder: require('util').TextEncoder,
    TextDecoder: require('util').TextDecoder,
    URL: URL,
    Date: Date,
    Promise: Promise,
    TypeError: TypeError,
    console: console
  };
  Object.assign(sandbox, extra || {});
  sandbox.window.window = sandbox.window;
  vm.createContext(sandbox);
  return sandbox;
}

// 1. app_crypto.js 基本能力
{
  const sb = makeSandbox();
  vm.runInContext(readf('app/src/main/assets/app_crypto.js'), sb);
  const c = sb.window.xvshishiCrypto;
  assert('app_crypto.js 暴露 xvshishiCrypto', !!c);
  const enc = c.encrypt('hello');
  assert('encrypt 输出 XU1 格式', enc.indexOf('XU1:') === 0);
  assert('decrypt(encrypt(x)) 往返一致', c.decrypt(enc) === 'hello');
  assert('默认口令指纹 = 0x35c85d85', c.fingerprint().hex === '0x35c85d85');
  assert('错误口令无法解密', c.decrypt(enc, 'wrong-pass') !== 'hello');
  assert('非 XU1 输入返回 null', c.decrypt('plain-text') === null);
}

// 2. 禁止列表：url_ban_list.js 可被 app_crypto 解密；app_url_ban.js 匹配正确
{
  const sb = makeSandbox({ document: { body: { appendChild() {} }, createElement() { return { style: {}, addEventListener() {}, set innerHTML(v) { this._h = v; } }; }, getElementById() { return null; } } });
  vm.runInContext(readf('app/src/main/assets/app_crypto.js'), sb);
  const listSrc = readf('app/src/main/assets/url_ban_list.js');
  const m = listSrc.match(/window\.__URL_BAN_LIST__\s*=\s*"([^"]+)"/);
  sb.window.__URL_BAN_LIST__ = m[1];
  vm.runInContext(readf('app/src/main/assets/app_url_ban.js'), sb);
  const urlBan = sb.window.urlBan;
  assert('urlBan 暴露', !!urlBan);
  assert('getBannedList 解密出 1 条', urlBan.getBannedList().length === 1);
  assert('精确匹配命中', !!urlBan.isBanned('https://blocked.example.com'));
  assert('主机匹配（不同路径）', !!urlBan.isBanned('https://blocked.example.com/x?q=1'));
  assert('无关站点不命中', !urlBan.isBanned('https://api.openai.com/v1'));
  assert('guard 对禁止 URL 返回 false', urlBan.guard('https://blocked.example.com/x') === false);
  assert('guard 对正常 URL 返回 true', urlBan.guard('https://ok.example.com') === true);
}

// 3. 登录账密字段：app_auth.js 内嵌密文可被 app_crypto 解密为已知明文
{
  const sb = makeSandbox();
  vm.runInContext(readf('app/src/main/assets/app_crypto.js'), sb);
  const c = sb.window.xvshishiCrypto;
  const authSrc = readf('app/src/main/assets/app_auth.js');
  const blobs = [];
  const re = /decrypt\("(XU1:[^"]+)"\)/g;
  let mm;
  while ((mm = re.exec(authSrc)) !== null) blobs.push(mm[1]);
  assert('app_auth.js 找到 2 个加密字段', blobs.length === 2);
  const url = c.decrypt(blobs[0]);
  const key = c.decrypt(blobs[1]);
  assert('SUPABASE_URL 解密正确', url === KNOWN_URL);
  assert('SUPABASE_ANON_KEY 解密正确', key === KNOWN_KEY);
  // 缓存密码加密往返
  const passEnc = c.encrypt('test-pass-123');
  assert('cached_user_password 加密往返', c.decrypt(passEnc) === 'test-pass-123');
}

// 4. CLI 工具与 App 共享模块互通（进程内加载工具源码）
{
  const toolSrc = readf('scripts/urlban-tool.js').replace(/\nmain\(\);\s*$/, '');
  const toolCtx = { require: require, console: console, URL: URL, process: { argv: [] }, Buffer: Buffer };
  vm.createContext(toolCtx);
  vm.runInContext(toolSrc, toolCtx);
  const sb = makeSandbox();
  vm.runInContext(readf('app/src/main/assets/app_crypto.js'), sb);
  const c = sb.window.xvshishiCrypto;
  const toolEnc = vm.runInContext("encrypt('https://blocked.example.com', DEFAULT_PASSPHRASE)", toolCtx);
  assert('工具加密 → App 模块解密', c.decrypt(toolEnc) === 'https://blocked.example.com');
  const appEnc = c.encrypt('https://blocked.example.com');
  assert('App 模块加密 → 工具解密', vm.runInContext("decrypt(" + JSON.stringify(appEnc) + ", DEFAULT_PASSPHRASE)", toolCtx) === 'https://blocked.example.com');
  assert('确定性：同明文同密文', toolEnc === appEnc);
}

// 5. 独立工作台：内嵌 CRYPTO 段与 App 模块互通
{
  const wb = readf('tools/dev-workbench/index.html');
  const start = wb.indexOf('/* ================= CRYPTO');
  const end = wb.indexOf('/* ================= UTIL');
  assert('工作台包含 CRYPTO 段', start > 0 && end > start);
  const cryptoSection = wb.slice(start, end);
  const ctx = { TextEncoder: require('util').TextEncoder, TextDecoder: require('util').TextDecoder, URL: URL };
  vm.createContext(ctx);
  vm.runInContext(cryptoSection, ctx);
  const sb = makeSandbox();
  vm.runInContext(readf('app/src/main/assets/app_crypto.js'), sb);
  const c = sb.window.xvshishiCrypto;
  const wbEnc = vm.runInContext("encrypt('https://blocked.example.com', DEFAULT_PASSPHRASE)", ctx);
  assert('工作台加密 → App 模块解密', c.decrypt(wbEnc) === 'https://blocked.example.com');
  assert('工作台默认口令与 App 一致（指纹相同）',
    vm.runInContext("fingerprint(DEFAULT_PASSPHRASE)", ctx) === c.fingerprint().dec + ' (0x' + c.fingerprint().hex.slice(2) + ')');
  assert('工作台破译能还原 App 密文', vm.runInContext("decrypt(" + JSON.stringify(c.encrypt('auth-field-test')) + ", DEFAULT_PASSPHRASE)", ctx) === 'auth-field-test');
}

console.log(failed ? '\n== 校验未通过 ==' : '\n== 加密体系全部校验通过 ==');
process.exit(failed ? 1 : 0);
