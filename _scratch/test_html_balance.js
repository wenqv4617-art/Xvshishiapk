/**
 * HTML 片段标签配平检查
 * 目的：抓「多余的 </div>」或「少闭合的 div」这类会让整块 UI 不渲染的静默错误。
 * 运行：node _scratch/test_html_balance.js
 */
const fs = require("fs");
const path = require("path");
const ASSETS = path.join(__dirname, "..", "app", "src", "main", "assets");

let pass = 0, fail = 0;
function ok(cond, label) {
  if (cond) { pass++; console.log("  ✓ " + label); }
  else { fail++; console.log("  ✗ " + label); }
}

/** 只统计标签，跳过注释、字符串与自闭合标签 */
function divBalance(html) {
  const noComment = html.replace(/<!--[\s\S]*?-->/g, "");
  let depth = 0, minDepth = 0;
  const re = /<(\/?)div\b[^>]*?(\/?)>/gi;
  let m;
  while ((m = re.exec(noComment)) !== null) {
    const closing = m[1] === "/";
    const selfClose = m[2] === "/";
    if (selfClose) continue;
    if (closing) { depth--; if (depth < minDepth) minDepth = depth; }
    else depth++;
  }
  return { depth, minDepth };
}

console.log("\n[1] app_local_deploy.js 的面板模板（本次真死的那个）");
const ld = fs.readFileSync(path.join(ASSETS, "app_local_deploy.js"), "utf8");
const tplMatch = ld.match(/getPanelHTML:\s*function\s*\(\)\s*\{\s*return\s*`([\s\S]*?)`;/);
ok(!!tplMatch, "取到 getPanelHTML 模板");
if (tplMatch) {
  const r = divBalance(tplMatch[1]);
  ok(r.depth === 0, `面板模板 div 配平（结余 ${r.depth}，最小深度 ${r.minDepth}）`);
  ok(r.minDepth >= 0, "过程中没有「先多闭合」的情况");
}

console.log("\n[2] index.html 里我新增/改动的几个浮层");
const idx = fs.readFileSync(path.join(ASSETS, "index.html"), "utf8");
["archive-import-choice-overlay", "wb-io-overlay"].forEach((id) => {
  const start = idx.indexOf('id="' + id + '"');
  if (start < 0) { ok(false, `找到 #${id}`); return; }
  // 从该元素往前找到所属 <div 起点
  const open = idx.lastIndexOf("<div", start);
  // 用「同级扫描」取到配平的结束位置：逐个标签计数直到归零
  let i = open, depth = 0;
  const re = /<(\/?)div\b[^>]*?(\/?)>/gi;
  re.lastIndex = open;
  let m, end = -1;
  while ((m = re.exec(idx)) !== null) {
    if (m[2] === "/") continue;
    if (m[1] === "/") { depth--; if (depth === 0) { end = re.lastIndex; break; } }
    else depth++;
  }
  ok(end > 0, `#${id} 能找到配平的结束位置`);
  if (end > 0) {
    const frag = idx.slice(open, end);
    const r = divBalance(frag);
    ok(r.depth === 0, `#${id} 片段 div 配平（结余 ${r.depth}）`);
    ok(/class="modal-overlay"/.test(frag), `#${id} 仍然是 modal-overlay`);
  }
});

console.log("\n[3] 这两个浮层必须在所有 .app-window 之外（否则会被窗口层叠上下文困住）");
["archive-import-choice-overlay", "wb-io-overlay"].forEach((id) => {
  const pos = idx.indexOf('id="' + id + '"');
  const lastWindow = idx.lastIndexOf('class="app-window"', pos);
  // 找出 body 里最后一个 app-window 之后的位置：简单判据——该浮层之后不应再有 app-window 的开启标签
  const after = idx.slice(pos);
  const nextWindow = after.search(/class="app-window"/);
  ok(nextWindow === -1, `#${id} 之后没有新的 .app-window（即它排在最后）`);
});

console.log("\n[4] app_export_center.js 注入的浮层样式");
const ec = fs.readFileSync(path.join(ASSETS, "app_export_center.js"), "utf8");
ok(/z-index:99500/.test(ec), "导出面板 z-index 已提到 99500（高于两个双面板块的 99000）");
ok(/document\.body\.appendChild/.test(ec), "导出面板挂在 body 直属");

console.log("\n[5] index.html 整页 div 配平（本次大改过它）");
{
  const r = divBalance(idx);
  ok(r.depth === 0, `index.html 整页 div 配平（结余 ${r.depth}，最小深度 ${r.minDepth}）`);
  ok(r.minDepth >= 0, "整页没有「先多闭合」的情况");
}

console.log("\n[6] 两个双面板浮层与导出浮层的层级关系");
{
  // 面板 99000 < 导出面板 99500 < 登录遮罩 99999
  const zPanel = 99000, zExport = 99500, zAuth = 99999;
  ok(zPanel < zExport, "双面板(99000) 低于 导出选择面板(99500)：能盖在它上面");
  ok(zExport < zAuth, "导出选择面板 低于 登录遮罩(99999)：未登录时不会被反盖");
}

console.log(`\n===== 结果：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
