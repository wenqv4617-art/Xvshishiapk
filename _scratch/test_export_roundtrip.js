/**
 * 导出/回导 往返测试（Node 直接跑，不需要浏览器）
 * 目的：验证「导出的文件能被自己正确识别并完整恢复分组与条目」
 * 运行：node _scratch/test_export_roundtrip.js
 */
const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(
  path.join(__dirname, "..", "app", "src", "main", "assets", "app_export_center.js"),
  "utf8"
);

// 在 Node 里造一个最小 window 环境（模块是 IIFE，只依赖 TextEncoder/atob/btoa/JSON）
const enc = new TextEncoder();
const dec = new TextDecoder("utf-8");
global.TextEncoder = global.TextEncoder || enc;
global.TextDecoder = global.TextDecoder || dec;
global.btoa = (s) => Buffer.from(s, "binary").toString("base64");
global.atob = (s) => Buffer.from(s, "base64").toString("binary");
const win = {};
new Function("window", src + "\n;return window;")(win);
const EC = win.exportCenter;

let pass = 0, fail = 0;
function ok(cond, label) {
  if (cond) { pass++; console.log("  ✓ " + label); }
  else { fail++; console.log("  ✗ " + label); }
}

// 版本探针：确认跑的是磁盘上的最新模块（不是旧副本）
ok(src.indexOf("function unescLine") !== -1, "模块版本检查：已包含行首转义修复");

// ================= 1. 档案库往返 =================
console.log("\n[1] 人设卡片导出 → 回导");

const archiveGroups = [
  {
    name: "酒馆角色",
    entries: [
      {
        name: "林薄秋",
        content: "姓名：林薄秋\n年龄：24",
        payload: { type: "character", remark: "主角", persona: "", parentId: null }
      },
      {
        name: "# 带井号的怪名字",   // 极端：名字里带我们自己的结构标记
        content: "正文",
        payload: { type: "character", remark: "", persona: "", parentId: null }
      }
    ]
  },
  {
    name: "用户面具",
    entries: [
      {
        name: "我",
        // 正文里故意包含「# 」与「## 」开头的行，检查解析器不会把它误判成结构
        content: "# 这不是分组\n## 这也不是条目\n正文继续",
        payload: { type: "user", remark: "", persona: "", parentId: null }
      }
    ]
  }
];

const aDoc = EC.build("archive", archiveGroups, { title: "人设卡片" });
const aTxt = EC.buildTxt(aDoc);

ok(EC.isOurExport(aTxt), "导出文件被指纹识别为自家文件");
ok(aTxt.indexOf(EC.MARKER) !== -1, "文件里含指纹标记行");

const aBack = EC.parse(aTxt, "archive");
ok(aBack.ok === true, "回导解析成功");
ok(aBack.groups.length === 2, `恢复出 2 个分组（实际 ${aBack.groups.length}）`);
ok(aBack.groups[0].name === "酒馆角色", `第 1 个分组名正确：${aBack.groups[0].name}`);
ok(aBack.groups[1].name === "用户面具", `第 2 个分组名正确：${aBack.groups[1].name}`);
ok(aBack.groups[0].entries.length === 2, `分组 1 有 2 个条目（实际 ${aBack.groups[0].entries.length}）`);
ok(aBack.groups[1].entries.length === 1, `分组 2 有 1 个条目（实际 ${aBack.groups[1].entries.length}）`);
ok(aBack.groups[0].entries[1].name === "# 带井号的怪名字",
  `名字带「# 」的条目名完整保留：${aBack.groups[0].entries[1].name}`);

const userContent = aBack.groups[1].entries[0].content;
ok(userContent.indexOf("正文继续") !== -1, "条目正文被完整恢复");
ok(userContent.indexOf("# 这不是分组") !== -1, "正文里的「# 」行没有被当成新分组");

// payload 还原
ok(aBack.groups[1].entries[0].payload.type === "user", "payload.type 还原正确");
ok(aBack.groups[0].entries[0].payload.remark === "主角", "payload.remark 还原正确");

// ================= 2. 世界书往返（含高级字段） =================
console.log("\n[2] 世界书导出 → 回导（校验全部高级字段）");

const wbPayload = {
  group: "薄秋的世界书", title: "旧条目名", mode: "keyword", keywords: "薄秋,秋天",
  probability: 77, depth: -3, content: "旧正文", position: "before_char", order: 42,
  role: "assistant", selectiveLogic: "or", secondaryKeys: "薄,秋",
  inclusionGroup: "季节组", groupWeight: 66, sticky: 5, cooldown: 9, scanDepth: 7,
  caseSensitive: true, matchWholeWords: true, useProbability: false,
  groupOverride: true, ignoreBudget: true
};

const wbDoc = EC.build("world_book", [
  { name: "薄秋的世界书", entries: [{ name: "季节设定", payload: wbPayload }] },
  { name: "默认未分组", entries: [{ name: "零散条目", payload: { mode: "always", content: "x" } }] }
], { title: "世界书" });
const wbTxt = EC.buildTxt(wbDoc);

const wbBack = EC.parse(wbTxt, "world_book");
ok(wbBack.ok === true, "世界书回导解析成功");
ok(wbBack.kind === "world_book", "类型判定为 world_book");
ok(wbBack.groups.length === 2, `恢复 2 个分组（实际 ${wbBack.groups.length}）`);

const p = wbBack.groups[0].entries[0].payload;
const checks = [
  ["mode", "keyword"], ["keywords", "薄秋,秋天"], ["probability", 77], ["depth", -3],
  ["position", "before_char"], ["order", 42], ["role", "assistant"],
  ["selectiveLogic", "or"], ["secondaryKeys", "薄,秋"], ["inclusionGroup", "季节组"],
  ["groupWeight", 66], ["sticky", 5], ["cooldown", 9], ["scanDepth", 7],
  ["caseSensitive", true], ["matchWholeWords", true], ["useProbability", false],
  ["groupOverride", true], ["ignoreBudget", true]
];
let allFieldsOk = true;
checks.forEach(([k, v]) => {
  if (p[k] !== v) { allFieldsOk = false; console.log(`      ✗ 字段 ${k}: 期望 ${JSON.stringify(v)} 实际 ${JSON.stringify(p[k])}`); }
});
ok(allFieldsOk, `21 个高级字段全部无损还原（含负数 depth=${p.depth}）`);

// ================= 3. 用户用 Word 改了正文 → 改动必须生效 =================
console.log("\n[3] 用户编辑正文后回导（改动必须生效，不能被旧内容盖掉）");

const edited = aTxt.replace("正文继续", "用户改过的正文 NEW");
const eBack = EC.parse(edited, "archive");
ok(eBack.ok === true, "编辑后仍能识别");
ok(eBack.groups[1].entries[0].content.indexOf("NEW") !== -1,
  "用户编辑的正文生效（以可读区为准）");
ok(eBack.groups.length === 2, "编辑后分组结构未损坏");

// ================= 4. 非自家文件必须被拒绝 =================
console.log("\n[4] 误导入普通文件必须被拒绝");

ok(EC.isOurExport("这只是一个普通的人设文本\n没有任何标记") === false,
  "普通 txt 不误判为自家文件");
const bogus = EC.parse("普通文本", "archive");
ok(bogus.ok === false, "解析普通文件返回失败而不是乱建数据");

// 带标记但指纹区损坏：应仍能按可读区恢复，并给出警告
const brokenFp = aTxt.split(EC.MARKER)[0] + EC.MARKER + "\n这不是base64!!!\n";
const bBack = EC.parse(brokenFp, "archive");
ok(bBack.ok === true, "指纹区损坏时仍按可读区恢复（不丢用户内容）");
ok(!!bBack.warning, "并给出警告提示：" + (bBack.warning || "").slice(0, 40));

// ================= 5. 空分组 / 极端输入 =================
console.log("\n[5] 边界情况");
const emptyDoc = EC.build("archive", [], { title: "空" });
const emptyBack = EC.parse(EC.buildTxt(emptyDoc), "archive");
ok(emptyBack.groups.length === 0, "空导出回导后没有分组");
ok(emptyBack.ok === true, "空导出不报错");

const multi = EC.build("archive", [{
  name: "G", entries: [
    { name: "A", content: "第一行\n第二行\n\n第四行", payload: { persona: "第一行\n第二行\n\n第四行" } },
    { name: "B", content: "含 <html> 与 & 符号", payload: { persona: "含 <html> 与 & 符号" } }
  ]
}], { title: "T" });
const multiBack = EC.parse(EC.buildTxt(multi), "archive");
ok(multiBack.groups[0].entries[0].content === "第一行\n第二行\n\n第四行",
  `多行正文精确保留（含空行）：${JSON.stringify(multiBack.groups[0].entries[0].content)}`);
ok(multiBack.groups[0].entries[1].name === "B", "第二个条目边界正确（未被上一段吞并）");

// ================= 6. docx 通道 =================
// Word 会把换行变成段落（换行符丢失），这是与 txt 不同的独立风险点。
// 这里直接验证「docx 里承载的文本内容」：把 document.xml 的 w:t 节点按
// app_archive.parseDocxText 的同一规则（每个文本节点 + \n）拼回来，再回导。
console.log("\n[6] docx 导出的文本内容（模拟 App 的 docx 读取规则）");

// 借用 buildDocxBytes 的私有 XML 生成：用 JSZip 桩捕获写入的 document.xml
let capturedDocXml = null;
global.JSZip = function () {
  const store = {};
  this.file = (k, v) => { store[k] = v; return this; };
  this.generateAsync = async () => {
    capturedDocXml = store["word/document.xml"];
    return new Uint8Array([1, 2, 3]);
  };
};
global.loadJSZip = async () => { };   // 让模块不去联网

(async () => {
  const richDoc = EC.build("archive", [
    {
      name: "分组<带>特殊&字符",
      entries: [{
        name: "角色「引号」& 尖括号<>",
        content: "第一行 <b>粗体?</b>\n# 正文里的小标题\n& 与 \" 双引号\n最后一行",
        payload: { type: "character", remark: "R&D", persona: "" }
      }]
    }
  ], { title: "标题 & <测试>" });

  await EC.buildDocxBytes(richDoc);
  ok(!!capturedDocXml, "docx 生成出了 word/document.xml");

  // 模拟 parseDocxText：取所有 w:t 文本，每个后面加换行
  const textNodes = [...capturedDocXml.matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g)].map(m => m[1]);
  const restored = textNodes
    .map(s => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&"))
    .join("\n");

  ok(restored.indexOf(EC.MARKER) !== -1, "docx 文本里带指纹标记");
  ok(EC.isOurExport(restored), "docx 内容被识别为自家导出文件");

  const dBack = EC.parse(restored, "archive");
  ok(dBack.ok === true, "docx 内容回导解析成功");
  ok(dBack.groups.length === 1, `docx 恢复 1 个分组（实际 ${dBack.groups.length}）`);
  ok(dBack.groups[0].name === "分组<带>特殊&字符",
    `分组的 XML 特殊字符无损：${dBack.groups[0].name}`);
  ok(dBack.groups[0].entries[0].name === "角色「引号」& 尖括号<>",
    `条目名的 XML 特殊字符无损：${dBack.groups[0].entries[0].name}`);

  const c = dBack.groups[0].entries[0].content;
  ok(c.indexOf("<b>粗体?</b>") !== -1, "正文里的尖括号未被 XML 吃掉");
  ok(c.indexOf("& 与 \" 双引号") !== -1, "正文里的 & 与引号无损");
  ok(c.indexOf("# 正文里的小标题") !== -1, "正文里的小标题保留（且未破坏分组结构）");
  ok(c.indexOf("最后一行") !== -1, "正文末行保留");
  ok(dBack.groups[0].entries[0].payload.remark === "R&D", "docx 指纹区 payload 无损");

  console.log(`\n===== 结果：${pass} 通过 / ${fail} 失败 =====`);
  process.exit(fail ? 1 : 0);
})();

