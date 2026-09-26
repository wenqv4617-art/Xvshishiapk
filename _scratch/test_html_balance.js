/**
 * HTML 配平 + 交互结构检查
 * 目的：抓「多余的 </div>」这类会让整块 UI 静默不渲染的错误，
 *       以及验证「导出选择器是内嵌的、不再是独立浮层」这一结构决策。
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

/** 只统计 div 标签，跳过注释与自闭合标签 */
function divBalance(html) {
  const noComment = html.replace(/<!--[\s\S]*?-->/g, "");
  let depth = 0, minDepth = 0;
  const re = /<(\/?)div\b[^>]*?(\/?)>/gi;
  let m;
  while ((m = re.exec(noComment)) !== null) {
    if (m[2] === "/") continue;
    if (m[1] === "/") { depth--; if (depth < minDepth) minDepth = depth; }
    else depth++;
  }
  return { depth, minDepth };
}

/** 取某个 id 元素所属的配平片段 */
function elementFragment(html, id) {
  const start = html.indexOf('id="' + id + '"');
  if (start < 0) return null;
  const open = html.lastIndexOf("<div", start);
  if (open < 0) return null;
  let depth = 0, end = -1;
  const re = /<(\/?)div\b[^>]*?(\/?)>/gi;
  re.lastIndex = open;
  let m;
  while ((m = re.exec(html)) !== null) {
    if (m[2] === "/") continue;
    if (m[1] === "/") { depth--; if (depth === 0) { end = re.lastIndex; break; } }
    else depth++;
  }
  return end > 0 ? html.slice(open, end) : null;
}

const ld = fs.readFileSync(path.join(ASSETS, "app_local_deploy.js"), "utf8");
const idx = fs.readFileSync(path.join(ASSETS, "index.html"), "utf8");
const ec = fs.readFileSync(path.join(ASSETS, "app_export_center.js"), "utf8");
const ar = fs.readFileSync(path.join(ASSETS, "app_archive.js"), "utf8");
const wb = fs.readFileSync(path.join(ASSETS, "app_world_book.js"), "utf8");

console.log("\n[1] app_local_deploy.js 的面板模板（曾因多余 </div> 整页死掉）");
{
  const tpl = ld.match(/getPanelHTML:\s*function\s*\(\)\s*\{\s*return\s*`([\s\S]*?)`;/);
  ok(!!tpl, "取到 getPanelHTML 模板");
  if (tpl) {
    const r = divBalance(tpl[1]);
    ok(r.depth === 0, `面板模板 div 配平（结余 ${r.depth}，最小深度 ${r.minDepth}）`);
    ok(r.minDepth >= 0, "过程中没有「先多闭合」");
  }
}

console.log("\n[2] index.html 整页 div 配平");
{
  const r = divBalance(idx);
  ok(r.depth === 0, `整页 div 配平（结余 ${r.depth}，最小深度 ${r.minDepth}）`);
  ok(r.minDepth >= 0, "整页没有「先多闭合」");
}

console.log("\n[3] 两个「导入 / 导出」浮层");
["archive-import-choice-overlay", "wb-io-overlay"].forEach((id) => {
  const frag = elementFragment(idx, id);
  ok(!!frag, `#${id} 能找到配平片段`);
  if (frag) {
    const r = divBalance(frag);
    ok(r.depth === 0, `#${id} 片段配平（结余 ${r.depth}）`);
    ok(/class="modal-overlay"/.test(frag), `#${id} 仍是 modal-overlay`);
  }
  const pos = idx.indexOf('id="' + id + '"');
  ok(idx.slice(pos).search(/class="app-window"/) === -1, `#${id} 排在所有 .app-window 之后`);
});

console.log("\n[4] 导出选择器必须是**内嵌**的（不再是独立浮层）");
ok(ec.indexOf("ensureUiDom") === -1, "旧的浮层构建函数已移除");
ok(ec.indexOf("export-center-overlay") === -1, "不再创建独立浮层 export-center-overlay");
ok(/mountExportPicker/.test(ec), "导出模块暴露 mountExportPicker（内嵌挂载）");
// 注意只看「创建元素 → append」这一对，别把 deliver() 里的 Blob 下载锚点误判成浮层
ok(!/createElement\("div"\)[\s\S]{0,400}document\.body\.appendChild/.test(ec),
  "导出模块不再创建并挂载浮层 div 到 body");
["ar", "wb"].forEach((p) => {
  ["fmt-txt", "fmt-docx", "count", "all", "none", "list", "go"].forEach((suffix) => {
    const id = p + "-ex-" + suffix;
    ok(idx.indexOf('id="' + id + '"') !== -1, `index.html 里有选择器元素 #${id}`);
  });
});
// 每个选择器元素必须落在导出页内部（而不是别处）
["ar", "wb"].forEach((p) => {
  const panel = elementFragment(idx, p + "-io-panel-export") || elementFragment(idx, p === "ar" ? "archive-io-panel-export" : "wb-io-panel-export");
  ok(!!panel, `${p} 的导出页片段可取`);
});
ok(/archive-io-panel-export[\s\S]*?id="ar-ex-list"/.test(idx), "#ar-ex-list 位于档案库导出页内部");
ok(/wb-io-panel-export[\s\S]*?id="wb-ex-list"/.test(idx), "#wb-ex-list 位于世界书导出页内部");

console.log("\n[5] 展开/收起与整组勾选的职责分离（用户反馈：点一下自己就收起）");
ok(/data-ex-toggle-btn/.test(ec), "存在独立的分组展开/收起按钮 data-ex-toggle-btn");
ok(/data-ex-arrow/.test(ec), "展开按钮带方向箭头 data-ex-arrow");
ok(/togglePickerGroup/.test(ec), "有专门的展开/收起函数");
ok(/renderPickerListKeepOpen/.test(ec), "整组勾选后保持展开状态（不整表重绘丢状态）");
ok(/syncGroupCheckbox/.test(ec), "单条勾选只同步该组状态（不整表重绘）");
ok(/ev\.stopPropagation\(\)/.test(ec), "展开按钮阻止冒泡，不会误触整行");
ok(/▸/.test(ec) && /▾/.test(ec), "箭头有收起/展开两态");

console.log("\n[6] 调用方接线");
ok(/mountExportPicker\("ar"/.test(ar), "档案库挂载前缀 ar");
ok(/mountExportPicker\("wb"/.test(wb), "世界书挂载前缀 wb");
ok(/switchArchiveIoTab[\s\S]*?mountArchiveExportPicker\(\)/.test(ar), "档案库切到导出页时挂载选择器");
ok(/switchWbIoTab[\s\S]*?mountWorldBookExportPicker\(\)/.test(wb), "世界书切到导出页时挂载选择器");
ok(ar.indexOf("openExportPanel") === -1, "档案库已无旧接口调用");
ok(wb.indexOf("openExportPanel") === -1, "世界书已无旧接口调用");

console.log("\n[7] 图片管理卡片外框（用户反馈：只做了高度没做外框）");
const st = fs.readFileSync(path.join(ASSETS, "app_settings.js"), "utf8");
ok(/border-radius:14px;overflow:hidden;background:#ffffff;border:1\.5px solid/.test(st),
  "缩略图单元有白底卡片 + 描边 + 圆角");
ok(/padding:4px;box-shadow/.test(st), "卡片有内边距与阴影（缩略图不再顶到边框）");
ok(/IMG_THUMB_H = 104/.test(st), "缩略图高度仍是确定像素值");

console.log(`\n===== 结果：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
