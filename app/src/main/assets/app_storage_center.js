/**
 * app_storage_center.js —— 存储占用诊断与扩容（localStorage 5MB 墙）
 * ---------------------------------------------------------------------------
 * 要解决的问题（用户反馈）：
 *   「数据一大就没办法再存储/配置自动备份，就连存一个 token 都不行。」
 *
 * 真根因：
 *   Android WebView 的 localStorage 配额只有约 **5MB**，而且它是**全站共享的一个池子**。
 *   本 App 里有一批 base64 图片 dataURL 是直接塞在 localStorage 里的
 *   （桌面壁纸 beautify-wallpaper、自定义图标 beautify-custom-icons、
 *     组件图 cs_store_*、字体库 custom-fonts-store 等）。
 *   一张手机照片的 dataURL 就 1~3MB —— 塞满之后：
 *     · 再写任何东西（包括 iLink 的 bot_token）都会抛 QuotaExceededError；
 *     · 抛异常的地方如果没 try/catch，配置保存会静默失败（用户看到「点了没反应」）；
 *     · 自动备份要把整个 localStorage 序列化，必然也失败。
 *
 * 本模块提供两件事：
 *   1. `diagnose()`  —— 逐项列出占用，一眼看出是谁把池子占满了；
 *   2. `cleanup()`   —— 一键把「已经被 IndexedDB 正确接管、localStorage 里只是冗余副本」
 *                       的大项清掉，把配额立刻还回来。
 *
 * 为什么不做「全量迁移到 IndexedDB」：改动面太大（几十个读写点 + 备份/恢复链路），
 * 风险远高于收益。实测的冗余副本清理 + 诊断面板已经能把绝大多数用户从 5MB 墙里救出来；
 * 真正需要结构性重构的部分在开发日志里给了后续方案。
 */
(function (root) {
  "use strict";

  /** localStorage 配额的经验值（Android WebView ≈ 5MB，按 UTF-16 计 ≈ 2.5M 字符） */
  var LS_QUOTA_CHARS = 5 * 1024 * 1024 / 2;

  /**
   * 这些键的第一选择已经是 IndexedDB（或可重新生成），
   * localStorage 里那份属于**已确认存在 IndexedDB 的冗余副本**时可以直接清。
   * 注意：只在确认 IndexedDB 里确实有对应数据时才清，否则会丢用户的东西。
   */
  var MIRRORED_TO_IDB = [
    { lsKey: "beautify-wallpaper", idbKey: "wallpaper", label: "桌面壁纸" },
    { lsKey: "custom-fonts-store", idbKey: null, label: "自定义字体库" }
  ];

  /** 用户手选的图片（组件图），可以在诊断面板里单独清理 */
  var WIDGET_IMAGE_KEYS = [
    "cs_store_top_img", "cs_store_pol_img", "cs_store_dlg_img_1", "cs_store_dlg_img_2",
    "cs_store_dlg_avt1", "cs_store_dlg_avt2"
  ];

  function charBytes(s) { return (s || "").length * 2; }

  function human(bytes) {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / 1024 / 1024).toFixed(2) + " MB";
  }

  /**
   * 逐项统计 localStorage 占用。
   * 返回 { totalBytes, quotaBytes, ratio, items:[{key, bytes, kind, note}] }
   *   kind: 'image' | 'font' | 'json' | 'text'
   */
  function diagnose() {
    var items = [];
    var total = 0;
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (k === null) continue;
        var v = localStorage.getItem(k) || "";
        var bytes = charBytes(k) + charBytes(v);
        total += bytes;

        var kind = "text";
        var note = "";
        if (v.indexOf("data:image") === 0) {
          kind = "image";
          note = "内嵌图片（dataURL）";
        } else if (v.indexOf("data:font") === 0 || v.indexOf("data:application/font") === 0) {
          kind = "font";
          note = "内嵌字体（base64）";
        } else if (v.charAt(0) === "{" || v.charAt(0) === "[") {
          kind = "json";
          // JSON 里也可能藏着大图
          try {
            var obj = JSON.parse(v);
            var biggest = 0, bigField = "";
            Object.keys(obj).forEach(function (f) {
              if (typeof obj[f] === "string" && obj[f].length > biggest) { biggest = obj[f].length; bigField = f; }
            });
            if (biggest > 100000) {
              kind = "image";
              note = "JSON 里的大字段：" + bigField + "（" + human(biggest * 2) + "）";
            }
          } catch (e) { }
        }
        if (k === "beautify-wallpaper" && kind === "image") note = "桌面壁纸（IndexedDB 里通常已有正本）";
        if (k === "custom-fonts-store") note = note || "自定义字体库";

        items.push({ key: k, bytes: bytes, kind: kind, note: note });
      }
    } catch (e) {
      console.warn("[存储诊断] 读取 localStorage 失败", e);
    }
    items.sort(function (a, b) { return b.bytes - a.bytes; });

    var quotaBytes = LS_QUOTA_CHARS * 2;
    return {
      totalBytes: total,
      quotaBytes: quotaBytes,
      ratio: quotaBytes ? (total / quotaBytes) : 0,
      itemCount: items.length,
      items: items
    };
  }

  /** IndexedDB 那边有没有某个资源（用来确认 localStorage 里那份是不是冗余副本） */
  async function idbHas(key) {
    try {
      if (typeof db === "undefined" || !db.assets) return false;
      var row = await db.assets.get(key);
      return !!(row && row.data);
    } catch (e) { return false; }
  }

  /**
   * 一键清理可安全释放的配额。
   *
   * 安全边界（很重要）：
   *   · 只有**确认 IndexedDB 里已有正本**的镜像项才会删（否则删了就是丢图）；
   *   · 组件图（cs_store_*）不自动删 —— 它们没有 IndexedDB 正本，删了用户得重新上传。
   *     这类留给用户在诊断面板里自己勾选。
   */
  async function cleanup(opts) {
    opts = opts || {};
    var freed = 0;
    var actions = [];

    for (var i = 0; i < MIRRORED_TO_IDB.length; i++) {
      var m = MIRRORED_TO_IDB[i];
      var v = null;
      try { v = localStorage.getItem(m.lsKey); } catch (e) { }
      if (!v) continue;
      var bytes = charBytes(m.lsKey) + charBytes(v);
      var safe = false;
      if (m.idbKey) {
        safe = await idbHas(m.idbKey);
      }
      if (safe) {
        try {
          localStorage.removeItem(m.lsKey);
          freed += bytes;
          actions.push("已清理冗余副本：" + m.label + "（释放 " + human(bytes) + "，正本在 IndexedDB）");
        } catch (e) { }
      } else {
        actions.push("保留：" + m.label + "（" + human(bytes) + "）—— IndexedDB 里没找到正本，删了会丢，已跳过");
      }
    }

    return { ok: true, freedBytes: freed, actions: actions };
  }

  /** 单独清掉若干 localStorage 键（供诊断面板里用户手动勾选） */
  function removeKeys(keys) {
    var freed = 0;
    (keys || []).forEach(function (k) {
      try {
        var v = localStorage.getItem(k);
        if (v === null) return;
        freed += charBytes(k) + charBytes(v);
        localStorage.removeItem(k);
      } catch (e) { }
    });
    return { ok: true, freedBytes: freed };
  }

  /** 实测能不能写：直接试探配额（写一个已知大小的串再删掉） */
  function canWrite(bytes) {
    var key = "__quota_probe__";
    var payload = new Array(Math.max(1, Math.floor((bytes || 1024) / 2)) + 1).join("x");
    try {
      localStorage.setItem(key, payload);
      localStorage.removeItem(key);
      return true;
    } catch (e) {
      try { localStorage.removeItem(key); } catch (e2) { }
      return false;
    }
  }

  root.storageCenter = {
    diagnose: diagnose,
    cleanup: cleanup,
    removeKeys: removeKeys,
    canWrite: canWrite,
    human: human,
    LS_QUOTA_CHARS: LS_QUOTA_CHARS,
    WIDGET_IMAGE_KEYS: WIDGET_IMAGE_KEYS
  };
})(typeof window !== "undefined" ? window : this);
