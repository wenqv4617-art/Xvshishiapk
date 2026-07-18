# 叙事诗小手机 开发与架构参考手册 (2026年修订版)

本手册是“叙事诗小手机”系统的核心开发和维护指南。本系统是一个完全运行在客户端（Client-Side）的仿移动端操作系统 PWA 扮演应用。系统采用 **HTML5 + CSS3 + 纯原生 JavaScript** 构建，底层依赖 **Dexie.js (IndexedDB)** 保证数据的事务级存储与持久化，并通过大语言模型提供拟真社交、多媒体交互、内心世界窥探、线下白描、长周期记忆库、专属空间深谈以及高约束交互卡片组件与剧本引导功能。

---

## 目录
1. **核心重构组件深度剖析**
   - 1.1 系统设置与工具组件 (`app_settings.js`)
   - 1.2 桌面网格与容器控制 (`app_desktop.js`)
   - 1.3 社交聊天与剧场交互 (`app_chat.js`)
   - 1.4 消息滑动引用引擎 (`app_chat_quote.js`)
   - 1.5 微信账务随动与多态隔离引擎 (`app_wallet.js`)
   - 1.6 朋友圈社交反应链与定时自发动态系统 (`app_moments.js`)
   - 1.7 沉浸式旋转专注中枢与物理转盘 (`app_chat_focus.js` & `focus.css`)
   - 1.8 独立自闭环“阅读”应用核心业务与伴读生态 (`app_reader.js` & `reader.css`)
2. **其它协同组件明细索引**
   - 2.1 会话总结与长久记忆库 (`app_summary_memory.js`)
   - 2.2 深度对话剖析空间 (`app_deeptalk.js`)
   - 2.3 HTML 互动舱生成与安全沙盘 (`app_chat_html_widget.js` & `chat_html.css`)
   - 2.4 主线剧情引导引擎 (`app_chat_plot_engine.js`)
3. **Dexie 数据库设计规范 (Version 10 & 扩充版)**
4. **长周期记忆 RAG 检索与深谈闪念提取数据流向**
   - 4.1 长周期记忆 RAG 检索召回
   - 4.2 深谈思想闪念截获
   - 4.3 HTML 互动卡片生成与零写入清洗流
   - 4.4 主线剧情引擎剧本引导流
   - 4.5 自研 PWA 视觉提示、自定义 Dialog 与 API 请求中断控制流
   - 4.6 专注空间白噪音伴奏与物理切屏事件挂起控制流
   - 4.7 书城定制图书推演与多端同步伴读书评生成流
5. **无限拓展开发蓝图（Where & How to Add Features）**
   - 蓝图 A：添加新数据库表 / 字段 (数据持久层拓展)
   - 蓝图 B：在桌面添加一个新应用图标/弹出窗口 (UI & 桌面层拓展)
   - 蓝图 C：在聊天底栏展开项加号中增加一个交互功能 (聊天应用层拓展)
   - 蓝图 D：在 Service Worker 中增加离线资源缓存 (PWA 线程层拓展)
6. **叙事诗小手机 逐文件技术功能详解 (Version 10 & 最新核心扩充)**

---

## 1. 核心重构组件深度剖析

### 1.1 系统设置与工具组件 (`app_settings.js`)

#### 概述
`app_settings.js` 承担整个虚拟手机的控制中枢职能，负责大模型 API 预设（CRUD、网络连接测试与模型在线拉取）、桌面主题美化（壁纸与多应用图标 Blob/Base64 持久化）、自定义全局 CSS 编译生效、代码组件工坊、各模块数据分区隔离导出/导入以及离线线程缓存强更新等功能。

```
                    ┌──> IndexedDB [api_presets] (API 协议/Key/模型列表)
                    ├──> LocalStorage [beautify-wallpaper] (Base64壁纸数据)
[设置控制器 (settings)] ───┼──> LocalStorage [beautify-custom-icons] (应用自定图标，包含 deeptalk)
                    ├──> LocalStorage [beautify-active-css] (注入自定义样式)
                    ├──> LocalStorage [beautify-widgets] (小部件 HTML 代码库)
                    └──> IndexedDB [html_cards] (备份、格式化与 RW 事务锁)
```

#### 内部关键变量
*   `isSettingsInitialized` (*Boolean*)：防重锁，确保 PWA 设置页初始化事件绑定在生命周期内仅执行一次。
*   `tempBgBlob` (*Blob/File*)：临时物理指针，保存用户最新选择尚未应用保存的本地桌面背景壁纸文件。
*   `activeCustomizingAppId` (*String*)：记录当前正在上传自定义图标的应用 ID（如 `'settings'`、`'deeptalk'` 等）。

#### 关键函数与接口解析
*   `initSettingsApp()`
    *   **功能**：设置页初始化主入口，挂载壁纸选择、自定义图标文件通道、CSS 预设切换、组件工坊编译、深谈预设设置、强更新等 DOM 事件。
*   `loadPresetsList()`
    *   **功能**：从 `db.api_presets` 读取全表重新装载 API 预设，并根据 LocalStorage 的 `'global_api_preset_id'` 激活默认连接。
*   `computeStorageUsage()`
    *   **功能**：容量计算。异步查询所有 IndexedDB 物理表的数据总数（含 `html_cards`、深谈及朋友圈相关表），并遍历 `archives` 的头像及 `sticker_items` 的大二进制 Base64 数据，输出精确的字节占用。
*   `serializeRecord(obj)` / `deserializeRecord(obj)`
    *   **功能**：无损序列化层。由于 IndexedDB 支持直接存储原生 Blob 实例而 JSON 标准不支持，此函数负责在导出时将原生 Blob 实例编码为带标志的 Base64 容器 `{ __type: "Blob", data: "..." }`，导入时逆向解码还原为物理二进制 Blob，防止备份损坏。
*   `exportBackup()` / `importBackup(e)`
    *   **功能**：全局全量级完整备份导出/导入。导入时利用 Dexie 的事务特性，声明 RW 事务锁（包含新追加的 `html_cards` 表锁），清空并物理重写 18 张 IndexedDB 物理表，并恢复 LocalStorage。

---

### 1.2 桌面网格与容器控制 (`app_desktop.js`)

#### 概述
`app_desktop.js` 负责桌面及底部快捷 Dock 栏的网格宿主排版、编辑状态切换、动态增删应用/代码小部件。此外，该文件承载了触控/鼠标 Pointer 级手势拖拽引擎，并注册了全站 PWA Service Worker。

```
                      ┌──> 检查 placed-widgets-desktop / -dock (小部件代码)
[网格排版渲染 (layout)] ──┼──> 检查 desktop-layout-v3 / dock-layout-v3 (应用图标)
                      └──> 编辑状态下：输出 "+" (应用/小部件添加) 或 "×" (删除)
```

#### 关键函数与接口解析
*   `loadDesktopLayout()`
    *   **功能**：桌面整体初始化。从 LocalStorage 读取高吸附性 `'desktop-layout-v3'`（20网格槽）及 `'dock-layout-v3'`（4网格槽）排版映射。若为空则将 `deeptalk` 默认编排至桌面第 4 个格子。
*   `renderLayout(container, layoutArray, slotClass)`
    *   **功能**：物理网格去挤兑排版渲染。如果网格索引被代码小部件占用，则根据设定的 `widthSpan` 和 `heightSpan` 合理占用格子，自动隐藏下属被覆盖的物理 slot 槽位。
*   `initDragEvents()`
    *   **功能**：Pointer Events 触控拖放手势。
    *   **隔离原则**：由于 Dock 栏应用了 `-webkit-backdrop-filter` 模糊，其会强制形成一个 Containing Block 导致子元素绝对定位偏移。拖放手势在 `pointermove` 阶段，**直接将正在拖拽的 `activeIcon` 节点物理剪切挂载到 `document.body` 顶层层级**，并将 `pointerEvents` 设为 `"none"`。结束拖放时，调用 `document.elementFromPoint` 探测下方坐标槽位，进行吸附与重新落盘。

---

### 1.3 社交聊天与剧场交互 (`app_chat.js`)

#### 概述
本系统的主体。提供微信式多页签路由，仿真的对话消息渲染（含普通消息、表情包、转账及红包等），大模型回复处理，拟真的时序级联分句上屏。此外，它支持线下约会（赴约模式）和独立剧场，可在断开连接时进行白描文本交互。

#### 关键函数与接口解析
*   `renderDialogMessages()`
    *   **功能**：对单聊内的全量消息（含普通文本、多媒体、红包/转账及滑动引用）进行渲染。红包和转账卡片双击后变灰半透明，并在领取后通过 `pointer-events: none` 防止二次刷钱。
*   `btnReply.onclick` (在线大模型回复)
    *   **核心逻辑**：
        1. API 发送前，自动扫描会话中对方发送且当前处于 `'pending'` 状态的红包/转账，改变其状态。
        2. 向 API 提示词追加收钱语境。
        3. 大模型生成回复后，利用宽容正则 `transactionRegex` 捕获代词指令。若检测到转账/红包/语音/图片指令，调用 `db.messages.add` 在数据库中为其**独立创建一条对应的 contentType 记录，并直接追加渲染（append）到屏幕上**。
        4. 擦除回复中已被解析的交易指令后，通过 `setTimeout` 时序延迟队列将对白递归调用渲染上屏，实现打字机级联。
        5. 在最后句渲染完成后，调用自动总结钩子 `checkAndTriggerAutoSummary(activeSessionId)`。
*   `endAppointment()` (结束线下赴约)
    *   **功能**：获取线下赴约期间产生的卡片记录，向 AI 申请生成一段不带 emoji、以第三人称总结的约会经历，以 `[来自深谈总结]` 或 `source: 'deeptalk'` 的形式写入长期记忆，并清空线下记录，实现记忆的无缝回写。

---

### 1.4 消息滑动引用引擎 (`app_chat_quote.js`)

#### 概述
这是一个自闭环的独立交互引擎。它通过注入样式和事件代理，为线上聊天气泡挂载 QQ 风格的“向左滑动”引动指令。它能够解析带有特定 ID 指令的文本，在对话气泡内部渲染出精致的引用预览。

#### 核心函数与接口解析
*   `QuoteSystem` (*Class*)
    *   `setQuote(msgId)`：将 `activeQuoteMsgId` 设置为对应 ID，读取被引用消息，转换消息类型，动态拼装 DOM 插入到输入框头部。
    *   `initGestureListener()`：挂载触摸手势。监听气泡的 `touchstart`、`touchmove` 和 `touchend`。当确定为向左横滑时，调用 `e.preventDefault()` 阻止父级容器滚动。
    *   `parseQuote(content)`：对微信引用语法做检测。若检测到 `[QUOTE: ID]` 或全角 `【QUOTE: ID】`，提取 ID，读取原消息对应的发送端姓名并渲染。

---

### 1.5 微信账务随动与多态隔离引擎 (`app_wallet.js`)

#### 概述
提供完全不依赖浏览器底层原生 `prompt()` 的卡片式零钱充值、提现 Dialog 账单交互面板。同时支持基于当前人设身份（`active_me_id`）的数据随动与财务隔离，保障不同面具之间的资产、明细相互独立不交叉。

```
                         ┌──> 获取 active_me_id ──> 拼接 wallet_balance_v1_[id] (财务随动)
[钱包零钱中心 (Wallet)] ───┼──> 提供 showCustomPrompt 进行卡片式充值与提现数字录入
                         └──> 拦截 [TRANSFER] / [RED_ENVELOPE] 变动，在 Ledger 中追加入账明细
```

#### 关键接口与实现
*   `getBalance()` / `setBalance(num)`
    *   **功能**：多态资产读取。根据内存中当前面具 ID 动态定位到专属 LocalStorage 键名进行资产维护，防止面具切换产生坏账。
*   `claimTransfer(msgId)` / `claimRedEnvelope(msgId)`
    *   **功能**：资金安全网关。在领取对方款项时，实时抓取该单聊会话中对方角色（Char）的真实备注名并记入零钱明细。点击后通过 `statusClass` 改变卡片透明度，并在物理层级上卸载该气泡后续的点击事件，彻底防范二次刷钱和逻辑穿透。

---

### 1.6 朋友圈社交反应链与定时自发动态系统 (`app_moments.js`)

#### 概述
模拟朋友圈发布、可见人限制，并基于大语言模型提供极具张力的群友（Char）评论、点赞反应，提供 1:N 深度级联反应网。同时搭载无痕定时器巡航系统，模拟好友自发性、时间跨度级发朋友圈的行为。

#### 关键接口与实现
*   `openSettingsModal()`
    *   **功能**：朋友圈巡航开关。提供活跃角色池勾选卡片。利用物理穿透防护机制（pointer-events: none），保障多选卡片在按压瞬间即时高亮。
*   `triggerAIsFeedbacksOnPost(momentId, charIds)`
    *   **功能**：动态自反应网。当用户发表新朋友圈后，可见范围内的 AI 角色（Char）会利用 `fetch` 时序级联队列（每隔 3.5秒）自发性地进行性格化评赞反应。
*   `triggerAIReactionsOnComment(momentId, commentId)`
    *   **功能**：级联社交链。当朋友圈产生新的二级回复时，可见的好友会继续以此为上下文产生二级回复或点赞，构建多级嵌套反应网络。
*   `startBackgroundTimer()`
    *   **功能**：后台定时器。每 60 秒轮询检测。在开启定时发动态后，系统将计算上条朋友圈与当前的时差，一旦超过时差限制，则随机抽取打勾角色调用大模型自发一条白描图文朋友圈，重绘 Feed流。

---

### 1.7 沉浸式旋转专注中枢与物理转盘 (`app_chat_focus.js` & `focus.css`)

#### 概述
`app_chat_focus.js` 与 `focus.css` 双剑合璧，构建出极具物理交互质感的专注空间，负责配置专注时长、今日目标、自愈挂起环境白噪音以及历史轨迹归档。

```
                         ┌──> 计算旋转极角 Math.atan2 ──> 换算 0 ~ 360deg 旋转弧度
[刻度旋转仪 (Dial Wheel)] ──┼──> 映射 5 ~ 120 分钟并回写 focus-config-duration-val
                         └──> 双向映射：当重新载入时，根据历史配置逆向旋转至对齐刻度
```

#### 关键功能与实现：
*   **物理刻度转盘旋转仪 (Tactile Conic Dial)**：摒弃了原生粗暴的 `input[type="range"]` 滑条，使用纯 Pointer Tracking 跟踪指针。当检测到在 `#focus-dial-wheel` 圆环上点击并旋转拖拽时，调用 `Math.atan2` 计算极角偏移并映射为 `5~120` 分钟。同时使用 CSS 的 `will-change: transform` 顺滑带动指示表盘外环旋转。
*   **泡泡玻璃扁平极细分割线**：在 `focus.css` 的视觉重构下，摒弃了原有模块各自独立、堆叠的多重磨砂外边框，将整体面板收纳至一个优雅的 `.win-body` 浅色磨砂泡壳（Blur: 24px）中。卡片内部模块通过单条 `rgba(0,0,0,0.06)` 横线精细切割，轻盈不突兀。
*   **多态伴随环境音 (IndexedDB 物理存储)**：支持用户点击右上角“耳机图标”导入自定义 MP3 格式音频作为伴奏。Dexie 引擎将音轨文件转为原生 Blob 存入会话档案中，在专注开始时自动唤起 ObjectURL 驱动 `<audio id="focus-ambient-player">` 循环播音。

---

### 1.8 独立自闭环“阅读”应用核心业务与伴读生态 (`app_reader.js` & `reader.css`)

#### 概述
提供完全独立、包含书架网格导入、书城 AI 故事定制与多态伴随点评系统，实现极富扮演沉浸感的小说追更阅读环境。

```
                         ┌──> Bookshelf (文本流导入与自愈编码分析器)
[闭环书架应用 (Reader)] ───┼──> Bookstore (载入大模型，结合两端人设背景推演故事走向)
                         └──> Mine & Companion (伴读系统：双击正文生成 AI 性格化短评)
```

#### 关键业务机制：
*   **GBK/UTF-8 自动识别自愈导入器**：由于部分本地 TXT 小说使用 GBK、GB2312 编码在 UTF-8 环境中极易产生乱码，系统在 FileReader 载入中置入**断言防护钩子**。当检测到读取流中出现 UTF-8 解码失败特有的占位块标志 `\uFFFD`（即 `` 乱码）时，立即废弃当前读取并强制转为 "GBK" 进行二次重新加载，实现自愈导入。
*   **AI 专属定制小说追更 (Context-aware Noveling)**：大模型写书提示词（可利用 `reader_presets` 进行多模板维护）不仅参考大纲，还自动抓取当前“我的人设 (active_me_id)”以及会话中所选择的“对方人设 (charId)”两端的世界设定、背景底料，在生成后续正文章节时极具互动张力。
*   **段落伴读书评气球 (Paragraph Companion Reviews)**：在阅读正文视图双击任意文本段落，若开启伴读角色（伴读高亮选择挂载于 `win-reader` 视口内部，防沙箱位移污染），系统将大模型融入该角色性格，并以其独有的口吻对当前段落生成一段 50 字以内的一句话短评气球（Balloon），可随时收起与展开，体验与爱人共读的伴随温暖。

---

## 2. 其它协同组件明细索引

### 2.1 会话总结与长久记忆库 (`app_summary_memory.js`)

#### 概述
这是主聊天系统的长效记忆支撑层。它不使用任何全局污染的变量，负责对话轮次提取、静默自动/手动范围事件总结、AI 长周期核心记忆库（我的现状、目的、变化、关系、在眼里的用户）的 synthesis 提炼，以及基于关键词模糊匹配的长效记忆 RAG 检索召回。

---

### 2.2 深度对话剖析空间 (`app_deeptalk.js`)

#### 概述
“深谈”是一个服务于单个面具的闭环空间，用于挖掘和剥离角色的内心深层自白。提供“择选”和“小宇宙”两页式双签切换。

---

### 2.3 HTML 互动舱生成与安全沙盘 (`app_chat_html_widget.js` & `chat_html.css`)

#### 概述
“HTML 互动舱”是会话专属的独立代码容器组件，允许用户向 API 请求根据上下文、世界书以及核心心智，编译输出完全独立、高度交互的单文件 HTML/CSS/JS 代码卡片，实现会话组件的无障碍生成。

---

### 2.4 主线剧情引导引擎 (`app_chat_plot_engine.js`)

#### 概述
“剧情引擎”是控制会话主线大方向的引导中枢，提供一个现代极简、浅色调的模态操作面板。用户写入的要求会被作为高优先级故事大纲实时拼装注入系统提示词链，在对话中引导大模型的态度演进和剧情。

---

## 3. Dexie 数据库设计规范 (Version 10 & 扩充版)

系统数据库包含 22 张物理表（在 Version 10 标准上扩充了阅读与伴读书城四张关联表，保持高抗灾结构对齐）。执行任何二次开发和结构拓展时必须在此基础上进行升级：

```javascript
db.version(10).stores({
  // 1. 大模型 API 预设表
  api_presets: 'id++, name, protocol, url, key, model, temperature',

  // 2. 档案表 (包含角色、用户、NPC 分区)
  archives: 'id++, type, name, avatar, remark, group, persona, parentId', 

  // 3. 社会关系映射表 (连接 character 与 user)
  relations: 'id++, fromId, toId, relation',

  // 4. 会话配置与偏好设置表 (包含伴随环境音 focusAmbientSounds 数组等隐式扩展属性)
  sessions: 'id++, userId, charId, customCharName, customCharAvatar, customCharPersona, customUserAvatar, customUserPersona, lastMessageTime, mountedEntryIds, offlineMinWordCount, offlineMaxWordCount, offlineAutoSummaryCount, offlineMountedEntryIds, stickerMountedGroupIds, autoSummaryToggle, autoSummaryInterval, bufferRounds, summarySystemPrompt, coreSelfStatus, coreSelfPurpose, coreSelfChanges, coreRelationship, coreUserInEyes',

  // 5. 线上对话消息全纪录表
  messages: 'id++, sessionId, senderType, senderId, content, contentType, timestamp, isFavorite',

  // 6. 世界书词条库
  world_book_entries: 'id++, group, title, content, depth, isActive',

  // 7. 线下剧场实例表
  theaters: 'id++, sessionId, name, scenario, minWordCount, maxWordCount, carryMemory, createdAt',

  // 8. 线下段落卡片流表
  offline_messages: 'id++, theaterId, sessionId, isTheater, senderType, content, timestamp, isFavorite',

  // 9. 窥秘内心状态变化切片历史表
  status_history: 'id++, sessionId, theaterId, isTheater, timestamp, attire, affection, excitement, thoughts, hiddenCorners',

  // 10. 表情包分组表
  sticker_groups: 'id++, name, sortOrder',

  // 11. 表情包单条数据表 (imageUrl 支持 Base64 二进制)
  sticker_items: 'id++, groupId, sortOrder, imageUrl, caption',

  // 12. 阶段性会话总结记录表
  summaries: 'id++, sessionId, startRound, endRound, content, keywords, source, timestamp',

  // 13. 深谈记录主表
  deeptalks: 'id++, sessionId, userId, charId, topic, status, createdAt',

  // 14. 深谈消息内容表
  deeptalk_messages: 'id++, deeptalkId, senderType, timestamp',

  // 15. 思想小宇宙闪念切片表
  deeptalk_thoughts: 'id++, deeptalkId, sessionId, timestamp',

  // 16. 全局深谈附加提示词预设表
  deeptalk_presets: 'id++, name',

  // 17. 朋友圈系统主动态表
  moments: 'id++, userId, senderType, senderId, timestamp',

  // 18. 朋友圈评论与点赞表
  moment_comments: 'id++, momentId, senderType, senderId, timestamp',

  // 19. 朋友圈时间流与巡航控制表
  moment_settings: 'id++, userId',

  // 20. HTML 互动卡片存储表
  html_cards: 'id++, sessionId, timestamp',

  // 21. === 阅读书城主书本表 (新增) ===
  reader_books: 'id++, title, author, summary, coverUrl, isImported, fileType, currentChapterId, collected',

  // 22. === 书城定制章节表 (新增) ===
  reader_chapters: 'id++, bookId, chapterNum, [bookId+chapterNum]',

  // 23. === 书籍分类个性标签表 (新增) ===
  reader_tags: 'id++, name',

  // 24. === 智能写书提示词模板预设表 (新增) ===
  reader_presets: 'id++, name, prompt'
});
```

---

## 4. 关键数据流向说明

### 4.1 长周期记忆 RAG 检索召回
```
[用户在主聊天发送消息] ──> 获取其文本 latestUserMsgText
                               │
                               ▼
                    retrieveSummaries(sessionId, latestUserMessageText)
                               │
                               ├──> 1. 读取最后 5 条总结
                               └──> 2. 匹配 s.keywords，若 >20 轮则均匀 RAG 跨度抽取 20 条
                               │
                               ▼
                    [合并并转为 Text 格式]
                               │
                               ▼
               segments.push({ depth: -600, content: 记忆总结 }) ──> 拼入 Global System Prompt
```

### 4.2 深谈思想闪念截获
```
[深谈空间 AI 回复] ──> 正则匹配 /\[THOUGHT\]([\s\S]*?)\[\/THOUGHT\]/i
                             │
                             ├──> 命中的思想内容：直接写入 db.deeptalk_thoughts (小宇宙)
                             │
                             ▼
                    将 [THOUGHT] 标识符从文本中替换抹除 ──> 写入 db.deeptalk_messages
                             │
                             ▼
                    重绘卡片 (deeptalk-card 只渲染纯净内心剖白文本)
```

### 4.3 HTML 互动卡片生成与零写入清洗流
```
[HTML构建请求] ──> 提取 Global System Prompt + HTML编译专有提示词 
                        │
                        ▼
           大模型返回带有多余Conversational说明的源码
                        │
                        ▼
           1. 原始数据 100% 完整保留入库 [db.html_cards] (防损坏备份)
           2. 运行时清洗 [cleanedCardIds.add(id)] ──> extractCleanHtml() ──> Iframe.srcdoc 
```

### 4.4 主线剧情引擎剧本引导流
```
[输入框填入环境约束] ──> sessions.update(plotRequirement)
                              │
                              ▼
           buildGlobalSystemPrompt(sessionId) [提示词汇集期]
                              │
               -480 深度优先注入大纲 ──> 合并输出 System Prompt
                              │
                              ▼
           大模型回复顺从此大纲约束 ──> 平滑演进
```

### 4.5 自研 PWA 视觉提示、自定义 Dialog 与 API 请求中断控制流

#### PWA 自研对话框设计
为了彻底剥离浏览器自带的 `alert`、`confirm` 和 `prompt` 灰色弹窗对 PWA 扮演应用沉浸感的破坏，系统在 `app_chat.js` 中构建了一套高发光、微发散的轻量卡片式 Dialog 以及 Toast 提示机制。

#### 接口定义：
*   `showToast(msg, duration)`: 在底部 120px 处，渲染具有半透明磨砂质感（`rgba(0,0,0,0.8)`）的悬浮提示条，动画结束会自动卸载。
*   `showCustomAlert(title, message, callback)`: 生成全屏淡入遮罩，展示具体的故障及操作提醒，附带单确定按钮。
*   `showCustomConfirm(title, message, onConfirm, onCancel)`: 自定义卡片确认框。
*   `showCustomPrompt(title, defaultValue, callback)`: 卡片式数值输入对话框，常用于钱包充值与提现。

#### AbortController 中断网络与状态切换流：
```
[点击获取回复 (✨)] ──> 创建 AbortController ──> 注入 fetch(..., { signal }) 
                             │
                             ├──> 1. 按钮图标切换为浅红停止方块
                             └──> 2. 页头显示 header-typing 正在打字中...
                             │
[再次点击(点击停止)] ──> 执行 onlineAbortController.abort() 
                             │
                             ├──> 1. 瞬时切断 Fetch 网络请求
                             ├──> 2. 中断页头 typing，按钮还原为闪烁星
                             └──> 3. 拦截 AbortError 错误并抛出 Toast「当前请求已终止」
```

#### 两阶段长按弹性反馈手势流：
为了提供真实的物理回弹与按压深度反馈，长按手势（Bubble Long-press）采用如下双定时器方案：
```
[手指按住气泡 (touchstart)] ──> 启动 bubbleScaleTimer (1000ms) ──> 启动 bubbleLongPressTimer (1300ms)
                                     │                                      │
                                     ▼                                      ▼
                        [达 1000ms：气泡缩紧]                     [达 1300ms：触发完成]
                        添加 .bubble-longpressing class         还原气泡大小，弹出 Emoji 贴图选择器
                        (scale 0.95 平滑回弹动效)
                                     │
                        [按压不足 1000ms 松手 (touchend)]
                                     │
                                     ▼
                        直接 clearTimeout 两个定时器，气泡无变化，响应正常双击
```

### 4.6 专注空间白噪音伴奏与物理切屏事件挂起控制流
```
[切屏隐藏 (visibilitychange: hidden)] ──> 1. 挂起计时器 (state.isActive = false)
                                            ├──> 2. 暂停 MP3 伴奏 (focus-ambient-player.pause())
                                            └──> 3. 展示 [继续] 恢复按钮，隐藏进度文字
                                                     │
[切屏回归 (visibilitychange: visible)] ──> 保持挂起 ──> 等待用户轻触 [继续]
                                                     │
                                                     ▼
                                        1. 恢复计时 (state.isActive = true)
                                        2. 恢复 MP3 播音 (focus-ambient-player.play())
                                        3. 收起 [继续] 按钮，重显百分比
```

### 4.7 书城定制图书推演与多端同步伴读书评生成流
```
[书城选取书籍 / AI 检索主角档案] ──> 获取两端人设 (Archives / Sessions) 
                                           │
                                           ▼
                             调用 API 自动推演生成后续大章
                                           │
                                           ▼
                             [阅读房间双击特定段落文本]
                                           │
                                           ▼
                             大模型读取伴读伙伴档案与羁绊关系
                                           │
                                           ▼
                             生成 50 字以内段落实时吐槽/暖心伴读书评 
```

---

## 5. 无限拓展开发蓝图（Where & How to Add Features）

### 蓝图 A：添加新数据库表 / 字段 (数据持久层拓展)

#### 开发诉求
我想在数据库里新增一个表（例如 `favorites_folder`），或者给 `sessions` 会话表新增一个属性。

#### 开发路径
1.  **修改数据库 schema**：
    打开 `db.js`。将版本号升级（如 `db.version(11)`），并在 stores 里定义您的新表结构。
2.  **防止备份损坏 (极其重要！)**：
    任何新增的数据库表**必须手动在备份体系中注册**。
    打开 `app_settings.js`：
    *   In `computeStorageUsage()` 函数的 `totalRecords` 累加和 `fullDataObj` 中**加入新表**，避免容量统计遗漏。
    *   In `exportBackup()` 导出的 `rawBackup` 结构体中，加入新表的导出逻辑：
        ```javascript
        favorites_folder: await db.favorites_folder.toArray(),
        ```
    *   In `importBackup()` 导入还原时的事务拦截区中，加入清空并写入新表的事务。**不加入的话，事务在检测到未声明表时会抛出空指针，导致数据还原彻底假死**：
        ```javascript
        await db.transaction('rw', [
          db.api_presets, ..., db.favorites_folder // 声明 RW 锁，包含所有相关表
        ], async () => {
          if (data.favorites_folder) {
            await db.favorites_folder.clear();
            await db.favorites_folder.bulkAdd(data.favorites_folder);
          }
        });
        ```

---

### 蓝图 B：在桌面添加一个新应用图标/弹出窗口 (UI & 桌面层拓展)

#### 开发诉求
我想增加一个“日记本”应用，点击图标后，屏幕从下方弹出一个属于它的二级滑入日记本窗口。

#### 开发路径
1.  **在配置表注册应用**：
    打开 `app_desktop.js`。在 `DESKTOP_APPS_CONFIG` 变量中追加应用 ID 与默认 SVG 图标代码。同时在 `openAddSelector()` 的 `appsList` 数组中写入应用 ID，以允许在长按添加面板中能正确重新添加。
2.  **在 HTML 中编写应用 DOM 窗口**：
    打开 `index.html` 的 `#app-window-container` 内部，追加应用全屏弹出窗 HTML 结构。其 ID 必须符合 `win-[appId]` 的规范，以便桌面引擎调用 `openApp` 自动捕获：
    ```html
    <div id="win-diary" class="app-window">
      <header class="win-header">
        <button class="btn-icon" onclick="closeApp('diary')">
          <svg viewBox="0 0 24 24"><path fill="currentColor" d="M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z"/></svg>
        </button>
        <h3 style="position: absolute; left: 50%; transform: translateX(-50%); font-size: 16px; font-weight: 700; pointer-events: none;">我的日记</h3>
        <div style="width:40px;"></div>
      </header>
      <div class="win-body">
        <!-- 编写应用自己的内容 -->
      </div>
    </div>
    ```
3.  **隔离原则规范（极高优先级）**：
    日记本内部若有独立的绝对定位遮罩或详情侧滑面板，**绝对不能写在 `index.html` 根节点的 body 底部**！它们必须作为子节点放置在 `#win-diary` 这个主要的 App 容器内部。
4.  **初始化事件绑定**：
    新建一个独立的 `app_diary.js` 文件，并在 `index.html` 底部引入。在 `app_desktop.js` 的 `openApp` 里挂载初始化生命周期：
    ```javascript
    // app_desktop.js -> openApp()
    if (app === 'diary' && typeof initDiaryApp === 'function') initDiaryApp(); // 懒加载初始化事件
    ```

---

### 蓝图 C：在聊天底栏展开项加号中增加一个交互功能 (聊天应用层拓展)

#### 开发诉求
我想在聊天加号面板上加一个“投掷硬币（Coin Flip）”按键，点击后发送一轮投掷硬币的交互。

#### 开发路径
1.  **在 HTML 面板中增加按钮**：
    打开 `index.html` 的加号常用功能分页区（`#chat-expand-panel` 内的 `.expand-page` 中），追加按键 DOM。为新功能分配唯一的 `id`（例如：`id="btn-chat-coin"`）。
    *   *排版优化注意*：第二页底部的小圆点指示器必须在 `DOMContentLoaded` 时绑定点击跳转监听，确保 PC 鼠标操作能顺畅点按页码。
2.  **创建闭环自注册脚本**：
    新建 `app_chat_coin.js`，通过双层自注册机制防御性地在脚本就位时即时监听点击。**禁止将交互窗口写在全局 body 底端，必须嵌套收纳于 win-chat 容器中**。
3.  **在大模型对齐中注册提示词分支**：
    在 `app_prompts.js` 的 `PROMPT_TEMPLATES` 线上聊天规则中写入对硬币结果类型的识别说明，让 AI 能够针对投掷出的正反面展开合乎人设的对白反馈。

---

### 蓝图 D：在 Service Worker 中增加离线资源缓存 (PWA 线程层拓展)

#### 开发诉求
我新增了一个脚本或样式文件，需要应用在完全离线模式下能够正常开启并渲染。

#### 开发路径
打开 `sw.js` 文件，找到其缓存资源列表 `ASSETS`，将资源路径以 `./` 相对路径写入该数组。同时，为了强制让现役浏览器卸载旧版的 Service Worker 缓存，必须手动向上递增并升级 `CACHE_NAME` 版本标识符：

```javascript
// sw.js 
const CACHE_NAME = 'story-phone-v13'; // 升级版本号，强推热更新

const ASSETS = [
  './index.html',
  ...
  './app_chat_plot_engine.js', // 必须写入 ASSETS 中，浏览器安装（install）时才会拉取此资源写入离线 Cache 容器
  './chat_html.css',
  './app_reader.js',
  './reader.css'
];
```

---

## 6. 叙事诗小手机 逐文件技术功能详解 (Version 10 & 最新核心扩充)

### 6.1 数据库定义与网关：`db.js`
*   系统本地持久化存储（IndexedDB）的总入口。利用 Dexie.js 建立事务级读写连接，声明数据库结构，在 **Version 10** 中增加了自动总结、深谈对话、小宇宙闪念、深谈全局预设、朋友圈组件，并预留了书城所需要的四张物理表支持。

### 6.2 全局提示词编译器：`app_prompts.js`
*   负责拼装、编译大模型的 System Prompt。将用户与角色的背景、关系描述、常驻/挂载世界书、时间流逝引擎、**核心长久记忆库（Core Memory）**以及**长周期 RAG 检索总结**，按照物理深度从低到高（由小到大）合并排序输出。

### 6.3 桌面与拖拽物理手势引擎：`app_desktop.js`
*   桌面及 Dock 栏的网格排版渲染，代码小部件（Widget）的初始化执行与容灾注销。通过 Pointer Capture 技术构建不粘连、无阻滞的跟手拖拽引擎。

### 6.4 系统设置与高级备份：`app_settings.js`
*   配置中心。负责 API 渠道调测与模型在线获取、桌面背景壁纸上传与预览更新、不透明度控制、全局 CSS 热注入、组件工坊编译，以及数据无损大二进制 Base64 分区导入/导出。

### 6.5 档案库管理器：`app_archive.js`
*   用户、角色、NPC档案及双端社会关系网（Relations）的 CRUD 维护。通过内存对象 ObjectURL 避免 Base64 引起的内存阻塞，支持文件拖放/截图粘贴快速加载头像。

### 6.6 世界书控制器：`app_world_book.js`
*   全局设定背景条目的 CRUD 管理。常驻分组词条提供滑动开关，开关状态将原子化即时同步至 `db.world_book_entries` 表中，以此决定是否参与 System Prompt 的编译注入。

### 6.7 聊天消息与时序级联引擎：`app_chat.js`
*   微信式对话列表加载、仿真多媒体消息（语音/场景画面图片）与微信红包/转账卡片生成和领取逻辑。配合 `app_prompts.js` 的时间流逝，处理大模型防掉格式指令解析和时序分句级联打字上屏。集成两阶段长按缩紧回弹动效与 AbortController 实时 API 请求中断控制。

### 6.8 HTML 互动舱与安全沙盒：`app_chat_html_widget.js`
*   **交互卡片组件中枢**。允许用户基于当前的对话上下文、世界书以及核心心智，编译输出完全独立、高度交互运行的单文件 HTML/CSS/JS 卡片。支持一键重绘清洗和源码维修舱二级物理阻隔空间。

### 6.9 HTML 互动舱护眼样式：`chat_html.css`
*   **HTML 互动舱与代码维修舱专属样式**。采用护眼深石墨灰+优雅靛蓝科技感方案。将卡片的时间脚标移至卡片右下角，提供清爽规整的排版空间。

### 6.10 主线剧情引导引擎：`app_chat_plot_engine.js`
*   **主线剧本控制中心**。提供剧情引导弹窗，将用户输入的走向约束写入 `db.sessions`。

### 6.11 会话总结与长久记忆系统：`app_summary_memory.js`
*   **总结、记忆模块**。独立于主聊天逻辑，负责对长周期对话事件进行切割提炼，管理角色的核心记忆库，并在大模型请求前，执行基于关键词匹配与跨度采样平铺的长效记忆 RAG 召回。

### 6.12 深度对话剖析空间：`app_deeptalk.js`
*   **深谈应用**。提供独立的全屏深谈探究空间，支持面具多角色无缝切换与数据隔离。集成卡片弹性回溯重回、手动闪念提取等核心机制。

### 6.13 消息滑动引用引擎：`app_chat_quote.js`
*   为线上微信气泡提供 QQ 风格的“左滑引用”操作。

### 6.14 心声与窥密组件：`app_status.js`
*   内心窥密自白卡片控制器。

### 6.15 表情包挂载器：`app_sticker.js`
*   表情包单图/批量上传与词典映射管理。

### 6.16 微信账务与交易网关：`app_wallet.js`
*   微信钱包零钱、消费账单的多态隔离维护，提现充值卡片 Dialog 模拟器生成，转账与红包的领取记账与防刷防穿透安全保护。

### 6.17 PWA 离线线程：`sw.js` (Version 12 升级)
*   Service Worker 离线网络静态资源拦截层。支持离线资源的强制拉取、旧缓存彻底卸载、Origin 绕过等，已同步完成对阅读应用与专注环境音离线缓存的支持。

### 6.18 界面样式矩阵：CSS 文件详解
*   `style.css`：全面屏视口约束，自动适配异形屏和底部横条（iOS Home indicator）。
*   `app.css`：磨砂 `.active` 激活态三维阻尼缓动。
*   `chat.css`：微信仿真气泡、双击右键操作项展示、底栏极简网格。
*   `deeptalk.css`：深谈空间横向滑块容器 `scroll-snap` 强吸附对齐特性定义。
*   `status.css`：脑电波跳跃、内心想法及暗黑隐藏心声渐变色块定义。
*   `sticker.css`：表情包选择器触摸滚动层定义。

### 6.19 主页面承载：`index.html`
*   全应用唯一主视图承载。包含了桌面的网格结构 `#desktop-grid`、底部小工具面板滑动页指示器圆点，以及所有二级 App 窗口，完成了电脑端点击导航圆点（Pagination Dots）的指针兼容，并将专注空间完美移入会话窗口内嵌套收纳。

### 6.20 离线入口：`manifest.json`
*   声明 PWA 标准元数据，锁定竖屏（portrait）及强制剥离浏览器地址栏（standalone）。

### 6.21 朋友圈业务控制器：`app_moments.js`
*   **朋友圈核心中枢**。承载朋友圈 Feed 流绘制、评论长按高亮、多级级联 AI 性格评赞反应、转发朋友圈卡片至单聊等全套微信社交链路，并提供后台定时自发动态巡航。

### 6.22 沉浸式旋转专注中枢：`app_chat_focus.js` (最新扩充)
*   **物理心流时空控制台**。提供一整套带有 Conic 指针物理旋转仪的拖拽式时长设定、多维时空统计差值对比图、后台切屏事件马达挂起拦截、自定义环境白噪音导入与静音播放控制，且轨迹明细卡片支持手势折叠收拢。

### 6.23 专注泡泡玻璃样式表：`focus.css` (最新扩充)
*   **简美泡泡美学模块**。定制整个专注中枢的渐变多态背景、统一磨砂玻璃面板，并将传统的模块外置泡壳转换为极其轻盈雅致的半透明水平分割极细线条。

### 6.24 自闭环 AI 伴读书城：`app_reader.js` (最新扩充)
*   **虚拟故事自推演生态**。提供“书架、书城、我的”三签式自闭环电子书架。搭载多态编码自愈 txt/doc 导入解析器、根据用户人设和当前 Char 设定自推演剧情生成后续长文章正文大章、双击段落触发 AI 实时吐槽/毒舌吐槽书评反馈。

### 6.25 书城多端自适应布局样式：`reader.css` (最新扩充)
*   **书城排版美学规范**。锁定标准的 3:4 书籍封面黄金比例，隔离相对定位下的点击穿透异常，并对阅读主题提供护眼浅绿、浅蓝、古董米黄、调色盘自定 Hex 进制文本色等多态配色支持。
```