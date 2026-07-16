/**
 * app_reader.js - 独立自闭环“阅读”应用核心业务控制器 (完全解耦、不污染全局)
 */

let readerCurrentTab = 'bookshelf';
let currentReadingBookId = null;
let currentReadingChapterNum = 1;
let currentReadingBookObj = null;

// 伴读配置
let isCompanionEnabled = false;
let companionCharId = null;

// 阅读计时
let readerStartTime = null;

// ==========================================
//             0. 自愈型底层解析 Helper 函数
// ==========================================
function resolveAvatar(avatar) {
  if (!avatar) {
    return 'data:image/svg+xml;utf8,<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"><circle cx="50" cy="50" r="50" fill="%23ccc"/></svg>';
  }
  if (avatar instanceof Blob) {
    return URL.createObjectURL(avatar);
  }
  return avatar;
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
}

// ==========================================
//             1. 初始化与导航切签
// ==========================================
async function initReaderApp() {
  await db.reader_books.count().then(async count => {
    if (count === 0) {
      // 预置默认分类标签
      const defaultTags = ["仙侠修真", "科幻星际", "悬疑密室", "现代都市", "末日生存"];
      for (let tag of defaultTags) {
        await db.reader_tags.add({ name: tag });
      }
    }
  });

  // 开始计时
  readerStartTime = Date.now();
  startReadingTimerInterval();

  await renderReaderTab();

  const tabs = document.querySelectorAll("#win-reader .chat-tabs .tab-item");
  tabs.forEach(tab => {
    tab.onclick = () => {
      tabs.forEach(t => t.classList.remove("active"));
      tab.classList.add("active");
      readerCurrentTab = tab.getAttribute("data-tab");

      const mainTitle = document.getElementById("reader-main-title");
      if (mainTitle) {
        if (readerCurrentTab === 'bookshelf') mainTitle.innerText = "书架";
        else if (readerCurrentTab === 'bookstore') mainTitle.innerText = "书城";
        else if (readerCurrentTab === 'mine') mainTitle.innerText = "我的";
      }

      renderReaderTab();
    };
  });
}

async function renderReaderTab() {
  document.querySelectorAll(".reader-tab-panel").forEach(p => p.classList.remove("active"));
  const targetPanel = document.getElementById(`reader-tab-${readerCurrentTab}`);
  if (targetPanel) {
    targetPanel.classList.add("active");
  }

  if (readerCurrentTab === 'bookshelf') {
    await renderBookshelf();
  } else if (readerCurrentTab === 'bookstore') {
    await renderBookstore();
  } else if (readerCurrentTab === 'mine') {
    await renderReaderMine();
  }
}

// 定时保存阅读时间片
function startReadingTimerInterval() {
  if (window.readerTimerId) clearInterval(window.readerTimerId);
  window.readerTimerId = setInterval(() => {
    if (document.getElementById("win-reader").classList.contains("active")) {
      const now = Date.now();
      const elapsed = Math.round((now - readerStartTime) / 1000);
      readerStartTime = now;
      
      const todayStr = new Date().toISOString().slice(0, 10);
      let todaySec = parseInt(localStorage.getItem(`reader_sec_${todayStr}`) || "0");
      todaySec += elapsed;
      localStorage.setItem(`reader_sec_${todayStr}`, todaySec.toString());
      
      let weekSec = parseInt(localStorage.getItem(`reader_sec_week`) || "0");
      weekSec += elapsed;
      localStorage.setItem(`reader_sec_week`, weekSec.toString());
    } else {
      readerStartTime = Date.now(); // 如果没开窗口，每次检查重新校对原点
    }
  }, 10000);
}

// ==========================================
//             2. 书架模块 (Bookshelf)
// ==========================================
async function renderBookshelf() {
  const grid = document.getElementById("bookshelf-grid-container");
  if (!grid) return;
  grid.innerHTML = "";

  const books = await db.reader_books.where('collected').equals(1).toArray();
  books.forEach(b => {
    const item = document.createElement("div");
    item.className = "bookshelf-item";
    item.onclick = () => openBookDetails(b.id);
    
    const coverHtml = b.coverUrl 
      ? `<img class="book-cover-img" src="${b.coverUrl}">`
      : `<div class="book-cover-title-fallback">${escapeHtml(b.title.slice(0, 8))}</div>`;

    // 限制书名最长显示 8 个字，防范撑大网格 [1]
    const displayTitle = b.title.length > 8 ? b.title.slice(0, 8) + "..." : b.title;

    item.innerHTML = `
      <div class="book-cover-wrapper">
        ${coverHtml}
      </div>
      <div class="book-meta-title">${escapeHtml(displayTitle)}</div>
    `;
    grid.appendChild(item);
  });

  // 最后一格放导入按钮
  const importItem = document.createElement("div");
  importItem.className = "bookshelf-item import-placeholder";
  importItem.onclick = () => {
    // 安全防护锁：防止用户在桌面双击启动应用时，第二下点击直接穿透击中书架的导入按钮 [1]
    if (Date.now() - (window.readerOpenTime || 0) < 350) return;
    document.getElementById("reader-file-importer").click();
  };
  importItem.innerHTML = `
    <div class="book-cover-wrapper">
      <svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <line x1="12" y1="5" x2="12" y2="19"></line>
        <line x1="5" y1="12" x2="19" y2="12"></line>
      </svg>
    </div>
    <div class="book-meta-title">本地导入</div>
  `;
  grid.appendChild(importItem);
}

// 自动识别编码自愈导入器
async function handleLocalFileImport(inputEl) {
  const file = inputEl.files[0];
  if (!file) return;

  const fileName = file.name;
  const ext = fileName.split('.').pop().toLowerCase();
  
  if (!['txt', 'doc', 'docx', 'pdf'].includes(ext)) {
    showToast("系统提示：当前支持导入txt, doc, docx, pdf格式文件。");
    return;
  }

  const reader = new FileReader();
  reader.onload = async (e) => {
    const rawResult = e.target.result;
    
    // 乱码与编码自愈检测机制：若读取结果中包含了代表 UTF-8 解码失败的特有标志 \uFFFD (即 ），则判定编码为 GBK，强制进行无损二次重读 [1]
    if (rawResult.includes("\uFFFD") || rawResult.includes("")) {
      const gbkReader = new FileReader();
      gbkReader.onload = async (gbkEvent) => {
        await saveImportedBook(gbkEvent.target.result, fileName, ext);
      };
      gbkReader.readAsText(file, "GBK");
    } else {
      await saveImportedBook(rawResult, fileName, ext);
    }
    inputEl.value = "";
  };

  reader.readAsText(file, "UTF-8");
}

async function saveImportedBook(textContent, fileName, ext) {
  // 如果是 doc, docx, pdf 做文本解析降级，txt 直接读取
  if (ext !== 'txt') {
    textContent = `[本电子书为 ${ext.toUpperCase()} 文件导入，以下为提取的纯文本段落] \n\n` + textContent.slice(0, 5000) + "\n\n(系统提示：该非txt文件超过试读字数部分已精简，推荐导入纯txt文件以获得完整排版)";
  }

  const title = fileName.replace(`.${ext}`, "");
  const bookId = await db.reader_books.add({
    title,
    author: "本地导入",
    summary: "用户上传的本地电子书，文件格式为 " + ext.toUpperCase(),
    coverUrl: "",
    isImported: 1,
    fileType: ext,
    currentChapterId: 0,
    collected: 1
  });

  // 默认拆分一章导入
  await db.reader_chapters.add({
    bookId,
    chapterNum: 1,
    title: "第一章",
    content: textContent,
    summary: "本地导入图书的初始文本部分。"
  });

  showToast("成功导入电子书：" + title);
  await renderBookshelf();
}

// ==========================================
//             3. 书城模块 (Bookstore)
// ==========================================
async function renderBookstore() {
  // 1. 刷新排行榜 (自愈式状态保护：若已有榜单书籍卡片，则保持现状，仅通过手动点击“刷新”按钮触发更新) [1]
  const container = document.getElementById("store-trending-container");
  if (!container || container.children.length === 0) {
    await refreshTrendingBoard();
  }
  // 2. 刷新分类标签及榜单
  await refreshCategories();
}

async function refreshTrendingBoard() {
  const container = document.getElementById("store-trending-container");
  if (!container) return;
  container.innerHTML = `<div style="text-align:center;padding:12px;font-size:11px;color:#94a3b8;">加载排行榜中...</div>`;

  // 榜单AI随机生成不依赖人设
  try {
    const api = await getActiveApiPreset();
    if (!api) {
      container.innerHTML = `<div style="text-align:center;padding:12px;font-size:11px;color:#ef4444;">请先配置全局大模型API</div>`;
      return;
    }

    const prompt = `你是一个小说风向标，请随机推荐2个在当前极为火热、符合大众潮流的小说。
请严格按照以下JSON格式返回：
[
  {"title": "书名", "author": "笔名", "summary": "200-300字精彩剧情大纲"}
]
绝对不允许附带任何 markdown 或 Emoji 代码！`;

    const res = await fetchAIResponse(api, prompt);
    const books = parseAIJsonList(res);
    
    container.innerHTML = "";
    books.forEach(b => {
      const card = createHorizontalBookCard(b, false);
      container.appendChild(card);
    });
  } catch(e) {
    container.innerHTML = `<div style="text-align:center;padding:12px;font-size:11px;color:#ef4444;">榜单加载异常</div>`;
  }
}

async function refreshCategories() {
  const tagsGrid = document.getElementById("store-tags-grid");
  if (!tagsGrid) return;
  tagsGrid.innerHTML = "";

  const tags = await db.reader_tags.toArray();
  tags.forEach(t => {
    const tagEl = document.createElement("div");
    tagEl.className = "category-tag-item";
    tagEl.innerText = t.name;
    tagEl.onclick = () => triggerCategorySearch(t.name);
    
    // 长按编辑标签
    tagEl.oncontextmenu = (e) => {
      e.preventDefault();
      triggerTagEditDialog(t.id, t.name);
    };

    tagsGrid.appendChild(tagEl);
  });
}

async function triggerCategorySearch(tagName) {
  const container = document.getElementById("store-category-list-container");
  if (!container) return;
  container.innerHTML = `<div style="text-align:center;padding:12px;font-size:11px;color:#94a3b8;">分类推演中...</div>`;

  try {
    const api = await getActiveApiPreset();
    const prompt = `你是一个分类小说大图景。请根据分类标签「${tagName}」，为我随机推演2本此分类下的小说。
请严格按照以下JSON格式返回：
[
  {"title": "书名", "author": "笔名", "summary": "200-300字精彩大纲"}
]
绝对不允许附带任何 markdown 或是 Emoji 代码！`;

    const res = await fetchAIResponse(api, prompt);
    const books = parseAIJsonList(res);
    
    container.innerHTML = "";
    books.forEach(b => {
      const card = createHorizontalBookCard(b, false);
      container.appendChild(card);
    });
  } catch(e) {
    container.innerHTML = `<div style="text-align:center;padding:12px;font-size:11px;color:#ef4444;">分类小说生成失败</div>`;
  }
}

function createHorizontalBookCard(b, isSearch) {
  const card = document.createElement("div");
  card.className = "book-card-horizontal";
  card.onclick = () => openBookDetailsFromData(b.title, b.author, b.summary);

  card.innerHTML = `
    <div class="book-card-cover">${escapeHtml(b.title.slice(0, 4))}</div>
    <div class="book-card-info">
      <div class="book-card-title">${escapeHtml(b.title)}</div>
      <div class="book-card-author">作者：${escapeHtml(b.author)}</div>
      <div class="book-card-summary">${escapeHtml(b.summary)}</div>
    </div>
  `;
  return card;
}

// 标签分类编辑/增加/删除弹窗
function triggerTagEditDialog(id, currentName) {
  showCustomConfirm("编辑标签", `您想要对分类标签「${currentName}」进行何种操作？`, 
    () => {
      showCustomPrompt("重命名分类标签", currentName, async (newVal) => {
        if (newVal.trim()) {
          await db.reader_tags.update(id, { name: newVal.trim() });
          await refreshCategories();
        }
      });
    },
    () => {
      showCustomConfirm("确认删除", `确定要删除标签「${currentName}」吗？`, async () => {
        await db.reader_tags.delete(id);
        await refreshCategories();
      });
    }
  );
}

function triggerAddTagDialog() {
  showCustomPrompt("添加新分类标签", "", async (val) => {
    if (val.trim()) {
      await db.reader_tags.add({ name: val.trim() });
      await refreshCategories();
    }
  });
}

// ==========================================
//             4. 搜索组件舱 (Search)
// ==========================================
async function openReaderSearch() {
  const overlay = document.getElementById("reader-search-overlay");
  overlay.classList.add("active");

  // 1. 载入预设下拉菜单
  const presetSelect = document.getElementById("search-preset-select");
  presetSelect.innerHTML = '<option value="">-- 选择写书提示词预设 --</option>';
  const presets = await db.reader_presets.toArray();
  presets.forEach(p => {
    const opt = document.createElement("option");
    opt.value = p.id;
    opt.innerText = p.name;
    presetSelect.appendChild(opt);
  });

  // 2. 载入主角选择器 (展示头像、真名、备注名)
  const charGrid = document.getElementById("search-char-select-grid");
  charGrid.innerHTML = "";

  const sessions = await db.sessions.toArray();
  for (let s of sessions) {
    const char = await db.archives.get(s.charId);
    if (!char) continue;
    
    const card = document.createElement("div");
    card.className = "reader-char-option-card";
    card.setAttribute("data-char-id", s.charId);
    card.onclick = () => {
      document.querySelectorAll(".reader-char-option-card").forEach(c => c.classList.remove("selected"));
      card.classList.add("selected");
    };

    const avatarUrl = resolveAvatar(s.customCharAvatar || char.avatar);
    card.innerHTML = `
      <img class="reader-char-option-avatar" src="${avatarUrl}">
      <div class="reader-char-option-names">
        <span class="reader-char-option-real">${escapeHtml(s.customCharName || char.name)}</span>
        <span class="reader-char-option-remark">${escapeHtml(char.remark || "无备注")}</span>
      </div>
    `;
    charGrid.appendChild(card);
  }
}

function closeReaderSearch() {
  document.getElementById("reader-search-overlay").classList.remove("active");
}

async function triggerReaderAIBookSearch() {
  const inputKeyword = document.getElementById("search-keyword-input").value.trim();
  const extraRequirement = document.getElementById("search-extra-requirement").value.trim();
  const presetId = document.getElementById("search-preset-select").value;
  
  const selectedCard = document.querySelector(".reader-char-option-card.selected");
  if (!selectedCard) {
    showCustomAlert("信息不足", "请先在下方列表中选择一位会话角色作为主角设定！");
    return;
  }
  
  const charId = Number(selectedCard.getAttribute("data-char-id"));
  const charArc = await db.archives.get(charId);

  const activeMeId = localStorage.getItem("active_me_id");
  const userArc = activeMeId ? await db.archives.get(Number(activeMeId)) : null;

  const btnSearch = document.getElementById("btn-trigger-reader-search");
  btnSearch.disabled = true;
  btnSearch.innerText = "检索推演中...";

  const resultsList = document.getElementById("search-results-list");
  resultsList.innerHTML = `<div style="text-align:center;padding:24px;font-size:12px;color:#94a3b8;">AI 正在读取角色背景设定并生成对应对局图书...</div>`;

  try {
    const api = await getActiveApiPreset();
    let promptPresetText = "";
    if (presetId) {
      const presetObj = await db.reader_presets.get(Number(presetId));
      if (presetObj) promptPresetText = presetObj.prompt;
    }

    const mainPrompt = `你是一个深层灵魂小说构筑机。请根据以下主角设定与限制，为我生成2本专属的定制小说。
【男/女主角1 (Char 人设)】：
姓名：${charArc?.name}
设定背景：${charArc?.persona}

【主角2 (User 扮演人设)】：
姓名：${userArc?.name || "用户"}
设定背景：${userArc?.persona || "普通体验者"}

【设定主题/关键词】：${inputKeyword || "未限定"}
【附加要求】：${extraRequirement || "无"}
【写作指导预设】：${promptPresetText || "无"}

请严格按照以下纯净的JSON数组格式返回（绝对不要添加任何 markdown 代码包裹，也不要有任何 Emoji 字符）：
[
  {"title": "书名", "author": "随机生成的笔名", "summary": "200-300字精彩剧情大纲，重点描写两位主角之间的命运交织"}
]`;

    const res = await fetchAIResponse(api, mainPrompt);
    const books = parseAIJsonList(res);

    resultsList.innerHTML = "";
    if (books.length === 0) {
      resultsList.innerHTML = `<div style="text-align:center;padding:24px;font-size:12px;color:#ef4444;">未能成功提炼数据，请重新检索！</div>`;
    } else {
      books.forEach(b => {
        const card = createHorizontalBookCard(b, true);
        resultsList.appendChild(card);
      });
    }
  } catch(e) {
    resultsList.innerHTML = `<div style="text-align:center;padding:24px;font-size:12px;color:#ef4444;">检索失败: ${e.message}</div>`;
  } finally {
    btnSearch.disabled = false;
    btnSearch.innerText = "开始检索定制图书";
  }
}

// ==========================================
//             5. 书籍详情页 (Details)
// ==========================================
let detailsTempBook = null;

function openBookDetailsFromData(title, author, summary) {
  detailsTempBook = { title, author, summary, collected: 0 };
  
  document.getElementById("detail-book-title").innerText = title;
  document.getElementById("detail-book-author").innerText = "作者：" + author;
  document.getElementById("detail-book-summary").innerText = summary;
  
  const btnCollect = document.getElementById("btn-detail-collect");
  btnCollect.innerText = "加入书架";
  btnCollect.disabled = false;

  document.getElementById("reader-details-overlay").classList.add("active");
}

async function openBookDetails(bookId) {
  const b = await db.reader_books.get(bookId);
  if (!b) return;
  
  detailsTempBook = b;
  
  document.getElementById("detail-book-title").innerText = b.title;
  document.getElementById("detail-book-author").innerText = "作者：" + b.author;
  document.getElementById("detail-book-summary").innerText = b.summary;

  const btnCollect = document.getElementById("btn-detail-collect");
  if (b.collected === 1) {
    btnCollect.innerText = "移除书架";
  } else {
    btnCollect.innerText = "加入书架";
  }
  btnCollect.disabled = false;

  document.getElementById("reader-details-overlay").classList.add("active");
}

function closeBookDetails() {
  document.getElementById("reader-details-overlay").classList.remove("active");
}

async function toggleCollectBook() {
  if (!detailsTempBook) return;

  const btnCollect = document.getElementById("btn-detail-collect");

  if (detailsTempBook.collected === 1) {
    // 双向自愈：执行物理移除收藏 [1]
    await db.reader_books.update(detailsTempBook.id, { collected: 0 });
    detailsTempBook.collected = 0;
    showToast(`已从书架移除「${detailsTempBook.title}」`);
    btnCollect.innerText = "加入书架";
  } else {
    // 增加/补回收藏
    let bookId = detailsTempBook.id;
    if (bookId) {
      await db.reader_books.update(bookId, { collected: 1 });
    } else {
      bookId = await db.reader_books.add({
        title: detailsTempBook.title,
        author: detailsTempBook.author,
        summary: detailsTempBook.summary,
        coverUrl: "",
        isImported: 0,
        collected: 1
      });
    }
    detailsTempBook.id = bookId;
    detailsTempBook.collected = 1;
    showToast(`已将「${detailsTempBook.title}」加入书架！`);
    btnCollect.innerText = "移除书架";
  }
  await renderBookshelf();
}

// 兼容老调用映射
window.collectTempBookToShelf = toggleCollectBook;

// ==========================================
//             6. 主流阅读房间 (Reading Room)
// ==========================================
async function startReadingRoom() {
  if (!detailsTempBook) return;

  // 1. 如果是临时未收藏书籍，先强制建档入库，保障阅读进度索引完整
  let bookId = detailsTempBook.id;
  if (!bookId) {
    bookId = await db.reader_books.add({
      title: detailsTempBook.title,
      author: detailsTempBook.author,
      summary: detailsTempBook.summary,
      coverUrl: "",
      isImported: 0,
      collected: 1
    });
    await renderBookshelf();
  }

  currentReadingBookId = bookId;
  currentReadingBookObj = await db.reader_books.get(bookId);
  currentReadingChapterNum = 1;

  closeBookDetails();
  closeReaderSearch();

  document.getElementById("reading-room-title").innerText = currentReadingBookObj.title;
  document.getElementById("win-reading-room").classList.add("active");

  // 载入历史阅读偏好
  applyReadingPreferences();

  // 载入第一章
  await loadChapter(currentReadingChapterNum);
}

function exitReadingRoom() {
  document.getElementById("win-reading-room").classList.remove("active");
  // 重置伴读挂载
  isCompanionEnabled = false;
  companionCharId = null;
  document.getElementById("btn-companion-toggle-indicator").style.color = "#64748b";
}

async function loadChapter(chapterNum) {
  const container = document.getElementById("reading-content-container");
  container.innerHTML = `<div style="text-align:center;padding:100px 0;font-size:14px;color:#94a3b8;">正在加载本章对决正文...</div>`;
  container.scrollTop = 0;

  let chap = await db.reader_chapters
    .where('[bookId+chapterNum]')
    .equals([currentReadingBookId, chapterNum])
    .first();

  if (!chap) {
    if (currentReadingBookObj.isImported === 1) {
      container.innerHTML = `<div style="text-align:center;padding:100px 0;font-size:14px;color:#94a3b8;">未导入此章节。</div>`;
      return;
    }
    // 线上定制小说：自动调用API生成新一章
    await generateChapterViaAI(chapterNum, "");
    return;
  }

  renderChapterDOM(chap);
}

async function generateChapterViaAI(chapterNum, userRequirement) {
  const container = document.getElementById("reading-content-container");
  container.innerHTML = `<div style="text-align:center;padding:100px 0;font-size:14px;color:#cbd5e1;">AI 正在深度推演第 ${chapterNum} 章剧情对白...</div>`;

  try {
    const api = await getActiveApiPreset();
    
    // 获取前一章的摘要
    let prevSummary = "这是开篇第一章，无前置摘要。";
    if (chapterNum > 1) {
      const prevChap = await db.reader_chapters
        .where('[bookId+chapterNum]')
        .equals([currentReadingBookId, chapterNum - 1])
        .first();
      if (prevChap) prevSummary = prevChap.summary;
    }

    const prompt = `你是一个资深的小说大师。请根据以下大纲与要求，为我撰写第 ${chapterNum} 章的精彩正文内容。
【书名】：${currentReadingBookObj.title}
【小说大纲】：${currentReadingBookObj.summary}
【前置剧情提要（极为重要，保障连贯性）】：
${prevSummary}

【本章情节指导要求（最高优先级，在小说里优先展示）】：${userRequirement || "无特别要求，让剧情自然推进"}

请你直接输出本章的正文文字，正文必须在 1500 字以上。
【特别要求】：
1. 绝对不要包含任何 Emoji 字符。
2. 在正文的所有内容输出完毕后，空一行，在最底部独占一行输出本章的【剧情摘要】。
格式如下：
[SUMMARY]这里输入150字左右的本章情节摘要提要

【输出示例】：
第一章...
正文内容...
正文结束...

[SUMMARY]本章写了主角在雨中重逢，彼此心生芥蒂，故事陷入了沉重。`;

    const res = await fetchAIResponse(api, prompt);
    
    let content = res;
    let summary = "本章未成功提炼摘要。";

    const summaryMatch = res.match(/\[SUMMARY\]([\s\S]*?)$/i);
    if (summaryMatch) {
      summary = summaryMatch[1].trim();
      content = res.replace(/\[SUMMARY\][\s\S]*?$/i, "").trim();
    }

    // 写入数据库
    const chapId = await db.reader_chapters.add({
      bookId: currentReadingBookId,
      chapterNum,
      title: `第 ${chapterNum} 章`,
      content: content.trim(),
      summary: summary.trim()
    });

    await db.reader_books.update(currentReadingBookId, { currentChapterId: chapId });

    // 重绘
    await loadChapter(chapterNum);

  } catch(e) {
    container.innerHTML = `
      <div style="text-align:center;padding:80px 16px;font-size:14px;color:#ef4444;">
        章节生成失败: ${e.message}<br><br>
        <button class="btn btn-primary" onclick="loadChapter(${chapterNum})" style="margin-top:10px;">点击重新生成</button>
      </div>
    `;
  }
}

function renderChapterDOM(chap) {
  const container = document.getElementById("reading-content-container");
  container.innerHTML = "";

  const titleEl = document.createElement("h2");
  titleEl.style.cssText = "font-size: 20px; font-weight: 700; margin-bottom: 24px; text-align: left;";
  titleEl.innerText = chap.title;
  container.appendChild(titleEl);

  const paragraphs = chap.content.split(/\n+/);
  paragraphs.forEach((p, idx) => {
    const text = p.trim();
    if (!text) return;

    const pEl = document.createElement("p");
    pEl.className = "read-para";
    pEl.setAttribute("data-para-idx", idx);
    pEl.innerText = text;

    // 伴读双击触发
    pEl.ondblclick = (e) => {
      e.preventDefault();
      triggerCompanionReview(pEl, text, idx);
    };

    container.appendChild(pEl);
  });

  // 渲染摘要展示卡
  const summaryBox = document.createElement("div");
  summaryBox.className = "chapter-summary-card-box";
  summaryBox.innerHTML = `
    <div class="chapter-summary-card-title">💡 本章 AI 剧情摘要 (可编辑)</div>
    <div class="chapter-summary-card-content" id="chapter-summary-text-val" onclick="editChapterSummary(${chap.id})">${escapeHtml(chap.summary)}</div>
  `;
  container.appendChild(summaryBox);

  // 下方控制行 (重新生成、下一章)
  if (currentReadingBookObj.isImported !== 1) {
    const controlRow = document.createElement("div");
    controlRow.style.cssText = "display: flex; gap: 10px; margin-top: 24px; margin-bottom: 40px;";
    controlRow.innerHTML = `
      <button class="btn btn-outline" style="flex: 1; padding: 10px; font-size: 12px; border-radius: 8px;" onclick="promptRegenerateCurrentChapter(${chap.chapterNum})">重新生成本章</button>
      <button class="btn btn-primary" style="flex: 1; padding: 10px; font-size: 12px; border-radius: 8px; background-color:#0f766e; border:none;" onclick="promptGenerateNextChapter(${chap.chapterNum + 1})">生成下一章</button>
    `;
    container.appendChild(controlRow);
  }
}

// 编辑摘要
async function editChapterSummary(chapId) {
  const chap = await db.reader_chapters.get(chapId);
  if (!chap) return;

  showCustomPrompt("编辑本章剧情摘要", chap.summary, async (newVal) => {
    if (newVal.trim()) {
      await db.reader_chapters.update(chapId, { summary: newVal.trim() });
      const el = document.getElementById("chapter-summary-text-val");
      if (el) el.innerText = newVal.trim();
      showToast("摘要修改已保存！");
    }
  });
}

// 重新生成当前章节
function promptRegenerateCurrentChapter(chapterNum) {
  showCustomPrompt("请输入本章剧情指导大纲 (AI 优先参考)", "", async (requirement) => {
    // 先物理擦除本地当前章节记录，强迫冷启动重新生成
    await db.reader_chapters
      .where('[bookId+chapterNum]')
      .equals([currentReadingBookId, chapterNum])
      .delete();
    await generateChapterViaAI(chapterNum, requirement);
  });
}

// 生成下一章
function promptGenerateNextChapter(nextChapterNum) {
  showCustomPrompt("请输入下一章剧情剧情大纲 (AI 优先参考)", "", async (requirement) => {
    await generateChapterViaAI(nextChapterNum, requirement);
    currentReadingChapterNum = nextChapterNum;
  });
}

// ==========================================
//             7. 伴读评价系统 (Companion)
// ==========================================
// 全局缓存伴读高亮选择状态
window.tempCompanionCharId = null;

function openCompanionSelector() {
  const overlay = document.createElement("div");
  overlay.id = "companion-selector-overlay";
  overlay.className = "modal-overlay";
  overlay.style.zIndex = "1500";
  
  // 载入当前的伴读选择作为初始高亮
  window.tempCompanionCharId = companionCharId;

  let html = `<div class="modal" style="max-width: 300px; padding: 16px;">
    <header class="modal-header" style="border-bottom:none; margin-bottom:12px;">
      <h4 style="font-weight:700;">选择伴读角色</h4>
    </header>
    <div class="reader-character-select-grid" style="max-height: 200px; margin-bottom: 16px;">`;

  db.sessions.toArray().then(async sessions => {
    for (let s of sessions) {
      const char = await db.archives.get(s.charId);
      if (!char) continue;
      
      const isSelectedClass = (companionCharId === s.charId) ? "selected" : "";

      html += `
        <div class="reader-char-option-card companion-opt-card ${isSelectedClass}" data-char-id="${s.charId}" onclick="readerSystem.selectCompanionToHighlight(this, ${s.charId})">
          <img class="reader-char-option-avatar" src="${resolveAvatar(s.customCharAvatar || char.avatar)}">
          <div class="reader-char-option-names">
            <span class="reader-char-option-real">${escapeHtml(s.customCharName || char.name)}</span>
            <span class="reader-char-option-remark">${escapeHtml(char.remark || "无备注")}</span>
          </div>
        </div>
      `;
    }

    html += `</div>
      <div style="display:flex; gap:10px;">
        <button class="btn btn-outline" style="flex:1;" onclick="document.getElementById('companion-selector-overlay').remove()">取消</button>
        <button class="btn btn-primary" style="flex:1; background-color:#0f766e; border:none;" onclick="readerSystem.saveCompanionSelection()">保存</button>
      </div>
    </div>`;

    overlay.innerHTML = html;
    document.getElementById("win-reader").appendChild(overlay); // 将挂载点由全局 phone-container 更改为 win-reader 应用视口内，从物理层级上解决叠加位移与泄漏异常 [1]
    
    // 异步执行完成后，必须添加 active 类名，以此物理激活 modal-overlay 的透明度与高抗干扰交互通道 [1]
    setTimeout(() => overlay.classList.add("active"), 10);
  });
}

function selectCompanionToHighlight(cardEl, charId) {
  const wasSelected = cardEl.classList.contains("selected");
  document.querySelectorAll(".companion-opt-card").forEach(c => c.classList.remove("selected"));
  if (!wasSelected) {
    cardEl.classList.add("selected");
    window.tempCompanionCharId = charId;
  } else {
    window.tempCompanionCharId = null;
  }
}

function saveCompanionSelection() {
  if (window.tempCompanionCharId) {
    isCompanionEnabled = true;
    companionCharId = window.tempCompanionCharId;
    document.getElementById("btn-companion-toggle-indicator").style.color = "#0f766e";
    showToast("伴读角色选择已应用！双击正文段落获取书评。");
  } else {
    isCompanionEnabled = false;
    companionCharId = null;
    document.getElementById("btn-companion-toggle-indicator").style.color = "#64748b";
    showToast("伴读角色已卸载。");
  }
  document.getElementById("companion-selector-overlay").remove();
}

// 伴读系统卸载
function disableCompanionSystem() {
  isCompanionEnabled = false;
  companionCharId = null;
  document.getElementById("btn-companion-toggle-indicator").style.color = "#64748b";
  showToast("伴读系统已关闭。");
}

async function triggerCompanionReview(pEl, paraText, paraIdx) {
  if (!isCompanionEnabled || !companionCharId) return;

  // 检查是否已经生成过书评气泡
  let commentBubble = pEl.querySelector(".para-comment-anchor");
  if (commentBubble) {
    commentBubble.remove();
  }

  const anchor = document.createElement("span");
  anchor.className = "para-comment-anchor";
  anchor.innerHTML = `
    <span class="para-comment-bubble-trigger" onclick="toggleCommentBalloon(this, event)">
      <svg viewBox="0 0 24 24" width="10" height="10" fill="currentColor">
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
      </svg>
    </span>
  `;
  pEl.appendChild(anchor);

  const char = await db.archives.get(companionCharId);
  const sess = await db.sessions.where('charId').equals(companionCharId).first();

  const activeMeId = localStorage.getItem("active_me_id");
  const userArc = activeMeId ? await db.archives.get(Number(activeMeId)) : null;
  const userName = userArc ? userArc.name : "用户";
  const userPersona = userArc ? userArc.persona : "普通人背景设定";

  try {
    const api = await getActiveApiPreset();
    const prompt = `【伴读核心情境指令】
你是 [${char.name}]。此时此刻，你和 [${userName}] 正在共同阅读一本书。
你的伴读伙伴 [${userName}] 刚刚向你分享了书中的一段文字。请你根据你自身的性格设定、态度、情感以及对 [${userName}] 的羁绊关系，写出对这段文字的一句短小点评。

【你们双方的人设档案】：
你的扮演设定（${char.name}）：
${sess?.customCharPersona || char.persona}

你的伴读伙伴设定（${userName}）：
${userPersona}

【当前所读书名】：${currentReadingBookObj.title}
【正文选中段落】：
“ ${paraText} ”

【伴读书评输出守则】：
1. 必须完全用你（[${char.name}]）的口吻与第一人称做出点评（如感到鄙意、赞赏、调侃、戏谑、吃惊或产生情感共鸣，且点评应当表现出你正在与 ${userName} 互动）。
2. 字数必须严控在 50 字以内。
3. 绝对不要出现任何 Emoji，不要有任何 Markdown 代码块或额外引言，直接输出对白书评内容本身。`;

    const res = await fetchAIResponse(api, prompt);

    // 缓存书评文本于 DOM 节点上
    anchor.setAttribute("data-comment-text", res.trim());
    anchor.setAttribute("data-char-name", char.name);
    anchor.setAttribute("data-char-avatar", resolveAvatar(sess?.customCharAvatar || char.avatar));

  } catch(e) {
    anchor.setAttribute("data-comment-text", "伴读评阅超时。");
    anchor.setAttribute("data-char-name", char.name);
    anchor.setAttribute("data-char-avatar", resolveAvatar(sess?.customCharAvatar || char.avatar));
  }
}

window.toggleCommentBalloon = function(triggerEl, event) {
  event.stopPropagation();
  const anchor = triggerEl.parentNode;
  const pEl = anchor.parentNode;
  
  // 检查是否已经展示了书评气泡气球
  let existingBalloon = pEl.nextSibling;
  if (existingBalloon && existingBalloon.className === "para-comment-balloon") {
    existingBalloon.remove();
    return;
  }

  const commentText = anchor.getAttribute("data-comment-text") || "正在审阅段落中...";
  const charName = anchor.getAttribute("data-char-name") || "伙伴";
  const avatar = anchor.getAttribute("data-char-avatar") || "";

  const balloon = document.createElement("div");
  balloon.className = "para-comment-balloon";
  balloon.innerHTML = `
    <div class="para-comment-balloon-header">
      <img src="${avatar}" style="width:18px; height:18px; border-radius:50%; object-fit:cover;">
      <span>${escapeHtml(charName)} 的短评</span>
    </div>
    <div style="font-style:italic;">“ ${escapeHtml(commentText)} ”</div>
  `;

  // 插入到段落下方
  pEl.parentNode.insertBefore(balloon, pEl.nextSibling);
};

// ==========================================
//             8. 阅读设置面板 (Settings)
// ==========================================
function toggleReadingMenuBar(event) {
  if (event) {
    // 防止点击书评气泡、按钮、或者伴读触发器时误唤醒设置栏，彻底释放正文文字的所有点击响应区间 [1]
    if (event.target.closest(".para-comment-balloon") || event.target.closest("button") || event.target.closest(".para-comment-bubble-trigger")) {
      return;
    }
  }

  const menu = document.getElementById("reading-menu-bar");
  menu.classList.toggle("active");
}

function applyReadingPreferences() {
  const prefs = JSON.parse(localStorage.getItem("reader_preferences") || "{}");
  const bgTheme = prefs.bgTheme || "light_green";
  const textHex = prefs.textColor || "";

  const flowBody = document.getElementById("reading-content-container");
  
  // 1. 应用背景色主题类
  flowBody.className = "reading-flow-body";
  flowBody.classList.add(`read-theme-${bgTheme}`);
  
  // 2. 文本颜色
  if (textHex) {
    flowBody.style.color = textHex;
  } else {
    flowBody.style.color = "";
  }

  // 3. 统一规范上下滑动阅读空间排版
  flowBody.style.overflowX = "hidden";
  flowBody.style.overflowY = "auto";

  // 同步高亮设置点
  document.querySelectorAll(".theme-color-dot").forEach(dot => {
    dot.classList.toggle("active", dot.getAttribute("data-theme") === bgTheme);
  });
}

function selectReadingThemeColor(themeName) {
  const prefs = JSON.parse(localStorage.getItem("reader_preferences") || "{}");
  prefs.bgTheme = themeName;
  prefs.textColor = ""; // 重置十六进制自定色
  localStorage.setItem("reader_preferences", JSON.stringify(prefs));
  applyReadingPreferences();
}

function selectReadingTextCustomColor() {
  showCustomPrompt("请输入文本自定义十六进制色值", "#1e293b", (val) => {
    if (val.trim()) {
      const prefs = JSON.parse(localStorage.getItem("reader_preferences") || "{}");
      prefs.textColor = val.trim();
      localStorage.setItem("reader_preferences", JSON.stringify(prefs));
      applyReadingPreferences();
    }
  });
}

function changeReadingFlipStyle(style) {
  const prefs = JSON.parse(localStorage.getItem("reader_preferences") || "{}");
  prefs.flipStyle = style;
  localStorage.setItem("reader_preferences", JSON.stringify(prefs));
  applyReadingPreferences();
  showToast("翻页方式已更改！");
}

// ==========================================
//             9. 目录管理 (Directory)
// ==========================================
async function openReadingDirectory() {
  const drawer = document.getElementById("reading-directory-drawer");
  const mask = document.getElementById("reading-directory-mask");
  drawer.classList.add("active");
  mask.classList.add("active");

  const listContainer = document.getElementById("reading-directory-list");
  listContainer.innerHTML = "";

  const chapters = await db.reader_chapters.where('bookId').equals(currentReadingBookId).toArray();
  chapters.sort((a,b) => a.chapterNum - b.chapterNum).forEach(chap => {
    const item = document.createElement("div");
    item.className = "menu-item";
    item.style.fontSize = "13px";
    item.innerText = chap.title;
    item.onclick = () => {
      currentReadingChapterNum = chap.chapterNum;
      loadChapter(chap.chapterNum);
      closeReadingDirectory();
      document.getElementById("reading-menu-bar").classList.remove("active");
    };
    listContainer.appendChild(item);
  });
}

function closeReadingDirectory() {
  document.getElementById("reading-directory-drawer").classList.remove("active");
  document.getElementById("reading-directory-mask").classList.remove("active");
}

// ==========================================
//             10. 我的页管理 (Mine)
// ==========================================
async function renderReaderMine() {
  // 同步我的最上方信息
  const meAvatar = document.getElementById("reader-mine-active-avatar");
  const meName = document.getElementById("reader-mine-active-name");
  const meRemark = document.getElementById("reader-mine-active-remark");

  const activeMeId = localStorage.getItem("active_me_id");
  if (activeMeId) {
    const user = await db.archives.get(Number(activeMeId));
    if (user) {
      if (meAvatar) meAvatar.src = resolveAvatar(user.avatar);
      if (meName) meName.innerText = user.name;
      if (meRemark) meRemark.innerText = user.remark || "默认身份";
    }
  }

  // 统计时长
  const todayStr = new Date().toISOString().slice(0, 10);
  const todaySec = parseInt(localStorage.getItem(`reader_sec_${todayStr}`) || "0");
  const weekSec = parseInt(localStorage.getItem(`reader_sec_week`) || "0");

  document.getElementById("reader-stat-today-val").innerText = formatReadingTime(todaySec);
  document.getElementById("reader-stat-week-val").innerText = formatReadingTime(weekSec);

  // 渲染预设列表
  await renderReaderPresetsList();
}

function formatReadingTime(totalSec) {
  if (totalSec < 60) return `${totalSec}秒`;
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  if (mins < 60) return `${mins}分${secs}秒`;
  const hrs = Math.floor(mins / 60);
  const remainMins = mins % 60;
  return `${hrs}小时${remainMins}分`;
}

async function renderReaderPresetsList() {
  const container = document.getElementById("reader-presets-container");
  if (!container) return;
  container.innerHTML = "";

  const presets = await db.reader_presets.toArray();
  if (presets.length === 0) {
    container.innerHTML = `<p style="font-size:12px;color:#94a3b8;text-align:center;padding:12px 0;">暂无提示词预设，请点击下方增加。</p>`;
    return;
  }

  presets.forEach(p => {
    const row = document.createElement("div");
    row.className = "menu-item";
    row.style.justifyContent = "space-between";
    row.innerHTML = `
      <div style="display:flex; flex-direction:column; text-align:left; flex:1; cursor:pointer;" onclick="editReaderPreset(${p.id})">
        <span style="font-size:13px; font-weight:700; color:#1e293b;">${escapeHtml(p.name)}</span>
        <span style="font-size:11px; color:#94a3b8; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:200px;">${escapeHtml(p.prompt)}</span>
      </div>
      <button class="btn btn-danger-outline" style="padding:4px 8px; font-size:10px; border-radius:6px;" onclick="deleteReaderPreset(${p.id})">删除</button>
    `;
    container.appendChild(row);
  });
}

function triggerAddReaderPresetDialog() {
  showCustomPrompt("请输入新写书提示词预设名称", "", async (name) => {
    if (!name.trim()) return;
    showCustomPrompt("请输入提示词正文", "要求剧情冲突激烈...", async (promptText) => {
      if (promptText.trim()) {
        await db.reader_presets.add({ name: name.trim(), prompt: promptText.trim() });
        await renderReaderPresetsList();
      }
    });
  });
}

async function editReaderPreset(id) {
  const p = await db.reader_presets.get(id);
  if (!p) return;

  showCustomPrompt("修改预设名称", p.name, async (newName) => {
    if (!newName.trim()) return;
    showCustomPrompt("修改预设提示词正文", p.prompt, async (newPrompt) => {
      if (newPrompt.trim()) {
        await db.reader_presets.update(id, { name: newName.trim(), prompt: newPrompt.trim() });
        await renderReaderPresetsList();
      }
    });
  });
}

async function deleteReaderPreset(id) {
  showCustomConfirm("确认删除", "确定要彻底删除该写书预设吗？", async () => {
    await db.reader_presets.delete(id);
    await renderReaderPresetsList();
  });
}

// ==========================================
//             10. 通用底层桥接器
// ==========================================
async function getActiveApiPreset() {
  const presetId = localStorage.getItem("global_api_preset_id");
  if (!presetId) throw new Error("未配置全局 API 预设，请前往系统设置配置！");
  return await db.api_presets.get(Number(presetId));
}

async function fetchAIResponse(api, promptText) {
  const response = await fetch(`${api.url}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${api.key}` },
    body: JSON.stringify({
      model: api.model,
      messages: [{ role: "user", content: promptText }],
      temperature: api.temperature
    })
  });
  if (!response.ok) throw new Error("大模型交互响应失败");
  const data = await response.json();
  return data.choices[0].message.content.trim();
}

function parseAIJsonList(text) {
  // 提取 JSON 块
  const jsonMatch = text.match(/\[\s*\{[\s\S]*?\}\s*\]/);
  if (jsonMatch) {
    try {
      return JSON.parse(jsonMatch[0]);
    } catch(e) {}
  }
  
  // 降级文本分行正则提取
  const books = [];
  const lines = text.split(/\n+/);
  let currentBook = null;
  
  lines.forEach(line => {
    const cleaned = line.replace(/^[\s\d.、*-]+/, "").trim();
    if (cleaned.startsWith("书名") || cleaned.startsWith("title")) {
      if (currentBook) books.push(currentBook);
      currentBook = { title: cleaned.split(/[:：]/).slice(1).join(":").trim(), author: "风流客", summary: "剧情介绍中..." };
    } else if (cleaned.startsWith("作者") || cleaned.startsWith("author")) {
      if (currentBook) currentBook.author = cleaned.split(/[:：]/).slice(1).join(":").trim();
    } else if (cleaned.startsWith("简介") || cleaned.startsWith("summary")) {
      if (currentBook) currentBook.summary = cleaned.split(/[:：]/).slice(1).join(":").trim();
    }
  });
  if (currentBook) books.push(currentBook);
  return books.slice(0, 3);
}

// 暴露出接口至全局
window.readerSystem = {
  init: initReaderApp,
  handleLocalFileImport,
  openReaderSearch,
  closeReaderSearch,
  triggerReaderAIBookSearch,
  collectTempBookToShelf,
  closeBookDetails,
  startReadingRoom,
  exitReadingRoom,
  toggleReadingMenuBar,
  selectReadingThemeColor,
  selectReadingTextCustomColor,
  changeReadingFlipStyle,
  openReadingDirectory,
  closeReadingDirectory,
  openCompanionSelector,
  triggerAddReaderPresetDialog,
  triggerAddTagDialog,
  refreshTrendingBoard,
  selectCompanionToHighlight,
  saveCompanionSelection
};