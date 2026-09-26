/**
 * app_export_center.js —— 人设卡片 / 世界书 的导出与回导（带指纹识别）
 * ---------------------------------------------------------------------------
 * 设计目标（用户需求）：
 *   1. 档案库的人设卡片、世界书的编辑面板，都要能导出；
 *   2. 格式可选 .txt 或 .docx；
 *   3. 导出的文件必须能被本 App **正确识别并回导**，完整恢复分组与条目；
 *   4. 导出文件能拉起系统分享面板。
 *
 * 为什么要有「指纹」
 * ----------------
 * 只导出成人能读的文本，回导时就没法区分「分组标题」和「条目正文」——
 * 一旦某个条目的正文里出现类似「# 分组」的行，结构就崩了。
 * 只导出成 JSON，用户拿 Word 打开是一堆乱码，也没法自己改内容。
 *
 * 所以本模块的格式是**双段式**：
 *
 *   ┌─ 第 1 段：人类可读区（也是回导时真正采用的内容）
 *   │   # 分组名
 *   │   ## 条目名
 *   │   正文（原样保留）
 *   │
 *   └─ 第 2 段：指纹区（机器用）
 *       标记行 ===XVSHSH-EXPORT-v1===
 *       之后若干行：该条目的**结构化原始字段**（Base64(UTF-8 JSON)）
 *
 * 关键权衡：**回导时以「人类可读区」的内容为准，「指纹区」只用来确定
 * 分组/条目边界与那些没法用纯文本表达的字段**。这样用户用 Word 改完正文
 * 再导回来，改动是生效的 —— 而不是被指纹区里的旧内容静默盖掉。
 * （docx 的换行会被 Word 改写，纯靠结构分会错位；但我们的「# / ##」标记行
 *  足够显眼，Word 不会吞掉，所以这个策略在两种格式下都成立。）
 */
(function (root) {
  "use strict";

  /** 指纹标记行。只要文件里出现这一行，就认定是「本 App 导出的文件」。 */
  var MARKER = "===XVSHSH-EXPORT-v1===";
  var FORMAT = 1;

  /** 导出类型 → 中文名（用于标题、文件名、导入提示） */
  var KIND_LABEL = {
    archive: "人设卡片",
    world_book: "世界书"
  };

  // =========================================================================
  // 基础工具
  // =========================================================================

  function utf8ToB64(str) {
    try {
      var bytes = new TextEncoder().encode(String(str));
      var bin = "";
      for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
      return btoa(bin);
    } catch (e) {
      return "";
    }
  }

  function b64ToUtf8(b64) {
    try {
      var bin = atob(String(b64));
      var bytes = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return new TextDecoder("utf-8").decode(bytes);
    } catch (e) {
      return "";
    }
  }

  function stamp() {
    var d = new Date();
    function p(n) { return (n < 10 ? "0" : "") + n; }
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) +
      " " + p(d.getHours()) + ":" + p(d.getMinutes());
  }

  function fileStamp() {
    var d = new Date();
    function p(n) { return (n < 10 ? "0" : "") + n; }
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + "-" +
      p(d.getHours()) + p(d.getMinutes());
  }

  /** 文件名里不能出现这些字符（各平台通用限制） */
  function sanitizeFileName(name) {
    return String(name || "导出")
      .replace(/[\\/:*?"<>|\r\n\t]/g, "_")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 60) || "导出";
  }

  // =========================================================================
  // 组装：结构化数据 → 导出对象
  // =========================================================================

  /**
   * @param kind  'archive' | 'world_book'
   * @param groups  [{ name: "分组名", entries: [ {name, content, payload} ] }]
   *        · archive 的 payload = 角色档案原始字段
   *        · world_book 的 payload = 世界书条目原始字段
   * @param opts   { title }
   */
  function build(kind, groups, opts) {
    opts = opts || {};
    var total = 0;
    (groups || []).forEach(function (g) { total += (g.entries || []).length; });
    return {
      marker: MARKER,
      format: FORMAT,
      kind: kind,
      kindLabel: KIND_LABEL[kind] || kind,
      title: opts.title || (KIND_LABEL[kind] || "导出"),
      exportedAt: Date.now(),
      exportedAtText: stamp(),
      groupCount: (groups || []).length,
      entryCount: total,
      groups: groups || []
    };
  }

  // =========================================================================
  // 生成 .txt
  // =========================================================================

  /**
   * 转义：行首的 `#` 与 `\` 必须加反斜杠。
   *
   * 为什么：可读区用「# 分组名」「## 条目名」表达结构。如果某个条目的**正文**里有
   * 一行以 `# ` 开头（比如人设里写了「# 性格」「## 背景」这种小标题，非常常见），
   * 不加转义的话回导时会被误判成新分组/新条目，把一份完整档案拆散。
   * 这是往返测试第一轮就抓到的真 bug。
   */
  function escLine(line) {
    var s = String(line == null ? "" : line);
    if (/^[#\\]/.test(s)) return "\\" + s;
    return s;
  }

  /** 与 escLine 相反的还原操作 */
  function unescLine(line) {
    var s = String(line == null ? "" : line);
    if (/^\\[#\\]/.test(s)) return s.slice(1);
    return s;
  }

  function buildTxt(doc) {
    var L = [];
    L.push("# " + doc.title);
    L.push("");
    L.push("> 导出时间：" + doc.exportedAtText +
      "　·　共 " + doc.groupCount + " 个分组、" + doc.entryCount + " 个条目");
    L.push("> 本文件由「叙事诗小手机」导出，可直接导回 App 并完整恢复分组与条目。");
    L.push("> 下方内容可自由编辑；导回时会以你编辑后的正文为准。");
    L.push("");

    (doc.groups || []).forEach(function (g) {
      L.push("# " + (g.name || "未分组"));
      L.push("");
      (g.entries || []).forEach(function (e) {
        L.push("## " + (e.name || "未命名"));
        L.push("");
        if (e.content) {
          String(e.content).replace(/\r\n/g, "\n").split("\n").forEach(function (ln) {
            L.push(escLine(ln));
          });
        }
        L.push("");
      });
    });

    // ---- 指纹区 ----
    L.push(MARKER);
    (doc.groups || []).forEach(function (g) {
      (g.entries || []).forEach(function (e) {
        // 每行一条：Base64(UTF-8 JSON)。用 Base64 是为了让整条占一行，
        // 这样任何「按行取内容」的解析（含 docx 的 w:t 提取）都不会把它切断。
        L.push(utf8ToB64(JSON.stringify({
          g: g.name || "未分组",
          n: e.name || "未命名",
          p: e.payload || {}
        })));
      });
    });
    L.push("");

    return L.join("\n");
  }

  // =========================================================================
  // 生成 .docx（依赖 JSZip，由 app_archive.js 的 loadJSZip() 提供）
  // =========================================================================

  function xmlEsc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
  }

  /** 每个段落跑一次，显式写 UTF-8，避免 Word 打开中文乱码 */
  function para(text, opts) {
    opts = opts || {};
    var runs = [];
    // 粗体只包住文字本身，不能把节点边界也包进去（Word 对畸形 run 会丢内容）
    if (opts.bold) {
      runs.push('<w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">' + xmlEsc(text) + '</w:t></w:r>');
    } else {
      runs.push('<w:r><w:t xml:space="preserve">' + xmlEsc(text) + '</w:t></w:r>');
    }
    return '<w:p>' + runs.join("") + '</w:p>';
  }

  function buildDocxXml(doc) {
    var body = [];
    body.push(para(doc.title, { bold: true }));
    body.push(para("导出时间：" + doc.exportedAtText + "　·　共 " +
      doc.groupCount + " 个分组、" + doc.entryCount + " 个条目"));
    body.push(para("本文件由「叙事诗小手机」导出，可直接导回 App 并完整恢复分组与条目。"));
    body.push(para("下方内容可自由编辑；导回时会以你编辑后的正文为准。"));
    body.push(para(""));

    (doc.groups || []).forEach(function (g) {
      body.push(para("# " + (g.name || "未分组"), { bold: true }));
      (g.entries || []).forEach(function (e) {
        body.push(para("## " + (e.name || "未命名"), { bold: true }));
        String(e.content || "").replace(/\r\n/g, "\n").split("\n").forEach(function (line) {
          // 与 txt 导出用同一套行首转义：Word 里正文的「# 小标题」同样不能被当成分组
          body.push(para(escLine(line)));
        });
      });
      body.push(para(""));
    });

    // ---- 指纹区 ----
    body.push(para(MARKER));
    (doc.groups || []).forEach(function (g) {
      (g.entries || []).forEach(function (e) {
        body.push(para(utf8ToB64(JSON.stringify({
          g: g.name || "未分组",
          n: e.name || "未命名",
          p: e.payload || {}
        }))));
      });
    });

    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
      '<w:body>' + body.join("") + '</w:body></w:document>';
  }

  function buildDocxBinaryParts() {
    return {
      "[Content_Types].xml":
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
        '</Types>',
      "_rels/.rels":
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
        '</Relationships>'
    };
  }

  /** 生成 docx 的字节（Uint8Array）。需要 JSZip 已加载。 */
  async function buildDocxBytes(doc) {
    if (typeof loadJSZip === "function") await loadJSZip();
    if (typeof JSZip === "undefined") {
      throw new Error("Word 导出组件未加载（需要网络加载一次 JSZip），可先用 .txt 导出");
    }
    var zip = new JSZip();
    var parts = buildDocxBinaryParts();
    Object.keys(parts).forEach(function (k) { zip.file(k, parts[k]); });
    zip.file("word/document.xml", buildDocxXml(doc));
    var blob = await zip.generateAsync({
      type: "uint8array",
      compression: "DEFLATE",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    });
    return blob;
  }

  // =========================================================================
  // 解析：读回文件（检测指纹 → 还原分组与条目）
  // =========================================================================

  /** 文件内容是否是本 App 导出的（只看指纹标记行） */
  function isOurExport(text) {
    return typeof text === "string" && text.indexOf(MARKER) !== -1;
  }

  /**
   * 解析人类可读区，得到 [{name, entries:[{name, content}]}]
   *
   * 规则（刻意做得宽容，因为用户可能用 Word 改过）：
   *   · 以「## 」开头的行 = 条目名（必须先判 ##，否则会被当成 # 分组）
   *   · 以「# 」开头的行 = 分组标题
   *   · 其余行 = 当前条目的正文；行首的 `\#` `\\` 还原为 `#` `\`
   *   · 第一条分组标题之前的内容全部忽略（那是文件头说明）
   */
  function parseReadableSection(text) {
    var lines = String(text || "").replace(/\r\n/g, "\n").split("\n");
    // 只处理指纹区之前的部分
    var markerIdx = lines.findIndex(function (l) { return l.trim() === MARKER; });
    var head = markerIdx >= 0 ? lines.slice(0, markerIdx) : lines;

    var groups = [];
    var curGroup = null;
    var curEntry = null;

    for (var i = 0; i < head.length; i++) {
      var line = head[i];
      var t = line.trim();

      // ⚠ 顺序很关键：必须**先在原始行上判结构，再做转义还原**。
      //   反过来会把正文里被转义的 `\# 这不是分组` 先还原成 `# 这不是分组`，
      //   然后又当成新分组 —— 这正是往返测试抓到的那个 bug（结构被拆散）。
      if (t.indexOf("## ") === 0) {
        if (!curGroup) { curGroup = { name: "未分组", entries: [] }; groups.push(curGroup); }
        curEntry = { name: unescLine(t.slice(3).trim()), content: "" };
        curGroup.entries.push(curEntry);
        continue;
      }
      if (t.indexOf("# ") === 0) {
        curGroup = { name: unescLine(t.slice(2).trim()) || "未分组", entries: [] };
        groups.push(curGroup);
        curEntry = null;
        continue;
      }
      if (curEntry) {
        // 正文行：这一步才做转义还原
        curEntry.content += (curEntry.content ? "\n" : "") + unescLine(line);
      }
    }

    // 收尾：去掉条目正文末尾多出来的空行（导出时为了美观加了一个空行）
    groups.forEach(function (g) {
      g.entries.forEach(function (e) { e.content = e.content.replace(/\s+$/, ""); });
    });
    // 丢掉空分组（除用户真的建了空分组，正常导出不会出现）
    return groups.filter(function (g) { return g.entries.length > 0; });
  }

  /** 解析指纹区里的结构化原始字段（每行一个 Base64 JSON） */
  function parseFingerprintPayloads(text) {
    var lines = String(text || "").replace(/\r\n/g, "\n").split("\n");
    var markerIdx = lines.findIndex(function (l) { return l.trim() === MARKER; });
    if (markerIdx < 0) return [];
    var out = [];
    for (var i = markerIdx + 1; i < lines.length; i++) {
      var t = lines[i].trim();
      if (!t) continue;
      var json = b64ToUtf8(t);
      if (!json) continue;
      try {
        var o = JSON.parse(json);
        if (o && typeof o === "object") out.push(o);
      } catch (e) { /* 不是我们的一行就跳过 */ }
    }
    return out;
  }

  /**
   * 完整解析一个导出文件。
   *
   * 返回 { ok, kind, groups, payloadCount, warning }
   *   groups: [{name, entries:[{name, content, payload}]}]
   *
   * 策略（重要）：
   *   · 分组与条目的**正文以人类可读区为准**（用户可能用 Word 改过，改动要生效）；
   *   · 指纹区提供**结构化原始字段**（世界书的插入深度/概率/关键词这类没法用
   *     纯文本表达的东西），按「分组名 + 条目名」顺序对齐回去。
   */
  function parse(text, expectKind) {
    if (!isOurExport(text)) {
      return { ok: false, error: "这不是「叙事诗小手机」导出的文件（缺少识别标记）" };
    }

    var groups = parseReadableSection(text);
    var payloads = parseFingerprintPayloads(text);

    // 推断类型：优先用调用方期望的类型，否则看 payload 的特征字段
    var kind = expectKind || "";
    if (!kind) {
      var hasArchiveField = payloads.some(function (p) {
        return p.p && (p.p.persona !== undefined || p.p.type !== undefined || p.p.avatar !== undefined);
      });
      kind = hasArchiveField ? "archive" : "world_book";
    }

    // 把结构化字段按顺序贴回条目
    var idx = 0;
    for (var gi = 0; gi < groups.length; gi++) {
      for (var ei = 0; ei < groups[gi].entries.length; ei++) {
        var pay = payloads[idx++];
        if (pay && pay.p && typeof pay.p === "object") {
          groups[gi].entries[ei].payload = pay.p;
        } else {
          groups[gi].entries[ei].payload = {};
        }
      }
    }

    var warnings = [];
    if (groups.length === 0) warnings.push("没有解析到任何分组或条目");
    if (payloads.length !== countEntries(groups)) {
      warnings.push("指纹区条目数（" + payloads.length + "）与正文条目数（" +
        countEntries(groups) + "）不一致，已按正文为准，部分高级字段可能回落到默认值");
    }

    return {
      ok: true,
      kind: kind,
      kindLabel: KIND_LABEL[kind] || kind,
      groups: groups,
      payloadCount: payloads.length,
      warning: warnings.join("；")
    };
  }

  function countEntries(groups) {
    var n = 0;
    (groups || []).forEach(function (g) { n += (g.entries || []).length; });
    return n;
  }

  // =========================================================================
  // 交付：写文件 + 拉起系统分享面板
  // =========================================================================

  var DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

  function bytesToB64(bytes) {
    var bin = "";
    var chunk = 0x8000;
    for (var i = 0; i < bytes.length; i += chunk) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(bin);
  }

  /**
   * 生成文件并交付。
   *
   * 交付优先级：
   *   1. APK 内：原生 shareFile() → content:// + 系统分享面板（用户明确要的效果）；
   *   2. 同时落一份到 Download/Storypoem/ 留档（失败不影响分享）；
   *   3. 网页版：Blob 下载（没有系统分享面板，但至少能存下来）。
   *
   * @param doc   build() 的返回值
   * @param fmt   'txt' | 'docx'
   */
  async function deliver(doc, fmt) {
    var base = sanitizeFileName(doc.title + "（" + doc.entryCount + "条）") + "-" + fileStamp();
    var fileName, bytes, mime;

    if (fmt === "docx") {
      bytes = await buildDocxBytes(doc);
      fileName = base + ".docx";
      mime = DOCX_MIME;
    } else {
      var text = buildTxt(doc);
      bytes = new TextEncoder().encode(text);
      fileName = base + ".txt";
      mime = "text/plain";
    }

    var native = (typeof window !== "undefined") && window.AndroidMCP;

    if (native && typeof window.AndroidMCP.shareFile === "function") {
      var b64 = bytesToB64(bytes);
      var res = { ok: false };
      try {
        res = JSON.parse(window.AndroidMCP.shareFile(fileName, b64, mime, "分享「" + doc.title + "」") || "{}");
      } catch (e) {
        res = { ok: false, error: String(e && e.message || e) };
      }
      // 顺手留档一份（失败无所谓）
      try {
        if (typeof window.AndroidMCP.saveExportFile === "function") {
          window.AndroidMCP.saveExportFile(fileName, b64);
        }
      } catch (e) { }
      if (res && res.ok) {
        return { ok: true, fileName: fileName, via: "share" };
      }
      return {
        ok: false,
        fileName: fileName,
        via: "share",
        error: (res && res.error) || "拉起分享面板失败"
      };
    }

    // 网页版：Blob 下载
    try {
      var blob = new Blob([bytes], { type: mime });
      var url = URL.createObjectURL(blob);
      var a = document.createElement("a");
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
      return { ok: true, fileName: fileName, via: "download" };
    } catch (e) {
      return { ok: false, fileName: fileName, via: "download", error: String(e && e.message || e) };
    }
  }

  root.exportCenter = {
    MARKER: MARKER,
    KIND_LABEL: KIND_LABEL,
    build: build,
    buildTxt: buildTxt,
    buildDocxBytes: buildDocxBytes,
    isOurExport: isOurExport,
    parse: parse,
    deliver: deliver,
    sanitizeFileName: sanitizeFileName,
    openExportPanel: openExportPanel,
    _parseReadable: parseReadableSection
  };

  // =========================================================================
  // 导出面板 UI（档案库 / 世界书 共用）
  //
  // 需求：点导入按钮后弹出的卡片里，能在「导入 / 导出」两个面板之间切换；
  //       导出面板要有「按分组可展开的勾选器」，支持整组多选，也支持只勾单条。
  //
  // 为什么做成浮层注入而不是写进 index.html：
  //   两个应用（档案库 / 世界书）用同一套选择器逻辑，集中在一个文件里维护，
  //   以后加第三种导出对象也不用再复制一遍 UI。
  // =========================================================================

  var uiState = {
    kind: "",
    fmt: "txt",
    title: "",
    groups: [],
    // 选择状态：sel[groupName][entryName] = true/false
    sel: {},
    open: false,
    provider: null,
    onDone: null
  };

  function uiEsc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function ensureUiDom() {
    var old = document.getElementById("export-center-overlay");
    if (old) old.remove();

    var div = document.createElement("div");
    div.id = "export-center-overlay";
    div.className = "modal-overlay";
    div.style.cssText = "z-index:1350; align-items:center !important; justify-content:center !important;";
    div.innerHTML = '' +
      '<div class="modal" style="max-width:380px; width:92%; max-height:82vh; display:flex; flex-direction:column; padding:16px; border-radius:16px; background:#fff;">' +
      '  <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:10px;">' +
      '    <h4 id="export-center-title" style="margin:0; font-size:15px; font-weight:800; color:var(--text-primary);">导出</h4>' +
      '    <button class="btn-icon" id="export-center-close">' +
      '      <svg viewBox="0 0 24 24"><path fill="currentColor" d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>' +
      '    </button>' +
      '  </div>' +
      // 格式选择
      '  <div style="display:flex; gap:8px; margin-bottom:10px;">' +
      '    <button class="btn" id="export-center-fmt-txt" style="flex:1; padding:9px 0; font-size:12px; font-weight:700;">TXT 纯文本</button>' +
      '    <button class="btn" id="export-center-fmt-docx" style="flex:1; padding:9px 0; font-size:12px; font-weight:700;">DOCX 文档</button>' +
      '  </div>' +
      '  <div style="display:flex; align-items:center; justify-content:space-between; gap:8px; padding:7px 9px; background:#f8fafc; border-radius:9px; margin-bottom:8px;">' +
      '    <span id="export-center-count" style="font-size:11px; color:var(--text-secondary);">已选 0 项</span>' +
      '    <span style="display:flex; gap:6px;">' +
      '      <button class="btn btn-outline" id="export-center-all" style="padding:4px 9px; font-size:11px;">全选</button>' +
      '      <button class="btn btn-outline" id="export-center-none" style="padding:4px 9px; font-size:11px;">清空</button>' +
      '    </span>' +
      '  </div>' +
      '  <div id="export-center-list" style="flex:1; overflow-y:auto; border:1.5px solid var(--border); border-radius:11px; padding:6px; min-height:120px;"></div>' +
      '  <button class="btn btn-primary" id="export-center-go" style="width:100%; margin-top:12px; padding:12px 0; font-size:13px; font-weight:800;">导出并分享</button>' +
      '</div>';
    document.body.appendChild(div);

    document.getElementById("export-center-close").onclick = closeExportPanel;
    document.getElementById("export-center-all").onclick = function () {
      uiState.groups.forEach(function (g) {
        uiState.sel[g.name] = {};
        g.entries.forEach(function (e) { uiState.sel[g.name][e.name] = true; });
      });
      renderList();
    };
    document.getElementById("export-center-none").onclick = function () {
      uiState.sel = {};
      renderList();
    };
    document.getElementById("export-center-fmt-txt").onclick = function () { setFmt("txt"); };
    document.getElementById("export-center-fmt-docx").onclick = function () { setFmt("docx"); };
    document.getElementById("export-center-go").onclick = doExport;

    // 点遮罩空白处关闭
    div.addEventListener("click", function (ev) {
      if (ev.target === div) closeExportPanel();
    });
  }

  function setFmt(fmt) {
    uiState.fmt = fmt;
    var t = document.getElementById("export-center-fmt-txt");
    var d = document.getElementById("export-center-fmt-docx");
    if (t) {
      t.className = "btn " + (fmt === "txt" ? "btn-primary" : "btn-outline");
    }
    if (d) {
      d.className = "btn " + (fmt === "docx" ? "btn-primary" : "btn-outline");
    }
  }

  function selectedCount() {
    var n = 0;
    Object.keys(uiState.sel).forEach(function (g) {
      Object.keys(uiState.sel[g] || {}).forEach(function (e) {
        if (uiState.sel[g][e]) n++;
      });
    });
    return n;
  }

  function renderList() {
    var host = document.getElementById("export-center-list");
    if (!host) return;

    if (!uiState.groups.length) {
      host.innerHTML = '<div style="padding:22px 10px; text-align:center; font-size:12px; color:var(--text-secondary);">暂无可导出的内容</div>';
      updateCount();
      return;
    }

    var html = "";
    uiState.groups.forEach(function (g, gi) {
      var gid = "export-g-" + gi;
      var selG = uiState.sel[g.name] || {};
      var picked = g.entries.filter(function (e) { return selG[e.name]; }).length;
      var gChecked = picked === g.entries.length && g.entries.length > 0;
      var gPartial = picked > 0 && !gChecked;

      html += '<div style="border-bottom:1px solid #f1f5f9;">';
      // 分组行：点击整行 = 展开/收起；左侧勾选框 = 整组选择
      html += '<div style="display:flex; align-items:center; gap:8px; padding:9px 6px;">' +
        '<input type="checkbox" data-export-group="' + uiEsc(g.name) + '" ' + (gChecked ? "checked" : "") +
        ' style="width:16px; height:16px; flex-shrink:0;' + (gPartial ? 'opacity:.5;' : '') + '">' +
        '<div data-export-toggle="' + gid + '" style="flex:1; display:flex; align-items:center; justify-content:space-between; cursor:pointer; min-width:0;">' +
        '  <span style="font-size:12.5px; font-weight:700; color:var(--text-primary); overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">' + uiEsc(g.name) + '</span>' +
        '  <span style="font-size:10.5px; color:var(--text-secondary); flex-shrink:0; margin-left:6px;">' +
        picked + '/' + g.entries.length +
        ' <span data-export-arrow="' + gid + '" style="display:inline-block; transition:transform .15s;">▸</span></span>' +
        '</div></div>';
      // 条目列表（默认收起）
      html += '<div id="' + gid + '" style="display:none; padding:0 0 8px 30px;">';
      g.entries.forEach(function (e, ei) {
        html += '<label style="display:flex; align-items:center; gap:7px; padding:6px 4px; cursor:pointer;">' +
          '<input type="checkbox" data-export-entry="' + uiEsc(g.name) + '\u0001' + uiEsc(e.name) + '" ' +
          (selG[e.name] ? "checked" : "") + ' style="width:15px; height:15px; flex-shrink:0;">' +
          '<span style="font-size:12px; color:var(--text-primary); overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">' +
          uiEsc(e.name) + '</span></label>';
      });
      html += '</div></div>';
    });
    host.innerHTML = html;

    // 展开/收起
    host.querySelectorAll("[data-export-toggle]").forEach(function (el) {
      el.onclick = function () {
        var id = el.getAttribute("data-export-toggle");
        var box = document.getElementById(id);
        var arrow = host.querySelector('[data-export-arrow="' + id + '"]');
        if (!box) return;
        var open = box.style.display !== "none";
        box.style.display = open ? "none" : "block";
        if (arrow) arrow.style.transform = open ? "" : "rotate(90deg)";
      };
    });
    // 整组勾选
    host.querySelectorAll("[data-export-group]").forEach(function (el) {
      el.onchange = function () {
        var gname = el.getAttribute("data-export-group");
        var grp = uiState.groups.find(function (x) { return x.name === gname; });
        if (!grp) return;
        uiState.sel[gname] = uiState.sel[gname] || {};
        grp.entries.forEach(function (e) { uiState.sel[gname][e.name] = el.checked; });
        renderList();
      };
    });
    // 单条勾选
    host.querySelectorAll("[data-export-entry]").forEach(function (el) {
      el.onchange = function () {
        var parts = el.getAttribute("data-export-entry").split("\u0001");
        var gname = parts[0], ename = parts[1];
        uiState.sel[gname] = uiState.sel[gname] || {};
        uiState.sel[gname][ename] = el.checked;
        renderList();
      };
    });

    updateCount();
  }

  function updateCount() {
    var el = document.getElementById("export-center-count");
    if (el) el.innerText = "已选 " + selectedCount() + " 项";
  }

  /**
   * 打开导出面板。
   *
   * @param opts.kind      'archive' | 'world_book'
   * @param opts.title     面板标题与默认文件名
   * @param opts.provider  async () => [{ name, entries:[{name, payload}] }]
   *                       由各应用提供「分组 + 条目」数据（payload 是原始字段）
   */
  async function openExportPanel(opts) {
    uiState.kind = opts.kind;
    uiState.title = opts.title || (KIND_LABEL[opts.kind] || "导出");
    uiState.provider = opts.provider;
    uiState.sel = {};

    ensureUiDom();
    var titleEl = document.getElementById("export-center-title");
    if (titleEl) titleEl.innerText = "导出「" + uiState.title + "」";
    setFmt(uiState.fmt);
    var list = document.getElementById("export-center-list");
    if (list) list.innerHTML = '<div style="padding:22px 10px; text-align:center; font-size:12px; color:var(--text-secondary);">正在读取数据…</div>';

    var overlay = document.getElementById("export-center-overlay");
    if (overlay) overlay.classList.add("active");

    try {
      var groups = await opts.provider();
      // 过滤掉空分组，并按名称排序（列表稳定，用户好找）
      groups = (groups || []).filter(function (g) { return g.entries && g.entries.length; });
      groups.sort(function (a, b) { return String(a.name).localeCompare(String(b.name), "zh"); });
      uiState.groups = groups;
      // 默认全选：多数场景是「全部导出」，少选比多选麻烦
      groups.forEach(function (g) {
        uiState.sel[g.name] = {};
        g.entries.forEach(function (e) { uiState.sel[g.name][e.name] = true; });
      });
      renderList();
    } catch (e) {
      if (list) list.innerHTML = '<div style="padding:22px 10px; text-align:center; font-size:12px; color:#dc2626;">读取失败：' + uiEsc(e && e.message || e) + '</div>';
    }
  }

  function closeExportPanel() {
    var overlay = document.getElementById("export-center-overlay");
    if (overlay) overlay.classList.remove("active");
    uiState.open = false;
  }

  async function doExport() {
    var btn = document.getElementById("export-center-go");
    try {
      var picked = [];
      uiState.groups.forEach(function (g) {
        var selG = uiState.sel[g.name] || {};
        var entries = g.entries.filter(function (e) { return selG[e.name]; });
        if (entries.length) picked.push({ name: g.name, entries: entries });
      });

      if (!picked.length) {
        if (typeof showToast === "function") showToast("请至少勾选一个条目");
        return;
      }

      if (btn) { btn.disabled = true; btn.innerText = "正在生成…"; }

      var doc = build(uiState.kind, picked, { title: uiState.title });
      var res = await deliver(doc, uiState.fmt);

      if (res && res.ok) {
        if (typeof showToast === "function") {
          showToast(res.via === "share"
            ? ("已生成 " + doc.entryCount + " 条，请在分享面板里选择去向")
            : ("已导出 " + res.fileName));
        }
        closeExportPanel();
      } else {
        if (typeof showToast === "function") showToast("导出失败：" + ((res && res.error) || "未知原因"));
      }
    } catch (e) {
      if (typeof showToast === "function") showToast("导出失败：" + (e && e.message || e));
    } finally {
      if (btn) { btn.disabled = false; btn.innerText = "导出并分享"; }
    }
  }
})(typeof window !== "undefined" ? window : this);
