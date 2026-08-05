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
   - 2.5 char 社交动作集成系统 (`app_chat_social_actions.js`)
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

#### 双视图响应式尺寸约束
互动舱采用「列表小卡片 + 全屏大卡片预览」双视图模式，在 `HTML_WIDGET_INSTRUCTION` 提示词中明确要求 AI 生成的代码同时适配两种尺寸：
*   **列表小卡片**：高度 250px，宽度跟随容器，需紧凑布局。
*   **大卡片预览**：480×880px，需充分利用空间。
*   **实现要求**：使用 Flexbox/Grid 布局，字号、间距用 `clamp()`、`vh/vw/%` 等相对单位，避免固定像素。

#### 大卡片预览（`openPreview`）
*   点击卡片上的「⤢ 预览」按钮触发，创建 `position:fixed` 全屏浮层（100vw×100vh 深色半透明遮罩）。
*   顶部深色标题栏含卡片 ID、指令摘要、刷新/关闭按钮；中部居中 iframe（max-width:480px; max-height:880px），通过 `sandbox="allow-scripts allow-popups allow-forms"` 隔离执行。
*   预览复用 `extractCleanHtml` 提取的清洗态代码（若卡片处于清洗视图，预览也用清洗后代码，与列表所见一致）。
*   支持四种关闭方式：关闭按钮、刷新按钮、点击遮罩、ESC 键。

#### 指令折叠/展开（`togglePrompt`）
*   渲染卡片时，若 `card.prompt.length > 150`，指令文本默认折叠为一行（CSS `-webkit-line-clamp:1` + `text-overflow:ellipsis`），显示「▼ 展开」按钮。
*   点击切换 `data-collapsed` 属性：展开显示完整指令 +「▲ 收起」，折叠显示前 150 字 +「...」+「▼ 展开」，避免长指令撑高卡片破坏布局。

---

### 2.3b 情侣空间·悄悄话话题会话与归档机制 (`app_chat_couples.js`)

#### 概述
情侣空间的「悄悄话」模块升级为「话题会话」机制：双方（user 与 char）均可主动发起/结束话题，话题内消息独立成段，3 天后自动归档并总结进长期记忆库，对话中途也可手动归档。彻底解决原先"不读用户话""跨话题串味""无归档沉淀"的问题。

#### 指令格式（与朋友圈/论坛线上指令风格一致）
```
[WHISPER_TOPIC_START: 话题标题]    # 双方任一方发起一个新话题
[WHISPER_TOPIC_END]                # 双方任一方结束当前话题
```

#### 话题生命周期状态机
话题从创建到归档经历四个状态：**活动（active）→ 结束（ended）→ 归档（archived）→ 入库（summarized）**。
*   **活动→结束**：AI 输出 `[WHISPER_TOPIC_END]` 或用户点击结束按钮。
*   **活动→归档 / 结束→归档**：3 天到期自动触发（`autoArchiveExpiredTopics` 巡检），或用户手动归档。
*   **归档→入库**：`archiveTopic` 调用 LLM 总结话题内容，写入 `db.summaries`（category:'relationship'），并标记话题和消息 `archived:1`。

#### 对话连贯性保障
`triggerWhisperReply` 仅保留**当前活动话题内**的消息历史（按 `topicId` 过滤），并在 prompt 中强调"承接当前话题上下文回复"，避免跨话题消息混杂导致 AI 答非所问。

#### 核心方法
*   `parseWhisperCommands(text)`：用括号平衡法从 AI 回复中提取 `[WHISPER_TOPIC_START]` / `[WHISPER_TOPIC_END]` 指令。
*   `startWhisperTopic(title, initiator)` / `endWhisperTopic()`：创建/结束话题，写入 `couples_whisper_topics` 表。
*   `autoArchiveExpiredTopics()`：进入情侣空间时巡检，归档所有超 3 天的活动话题。
*   `archiveTopic(topicId, isAuto)`：拉取话题消息 → 调 LLM 总结 → 写入 `db.summaries` → 标记归档。
*   `summarizeWhisperTopic(topic, msgs)`：调用大模型生成话题总结文本。

---

### 2.4 主线剧情引导引擎 (`app_chat_plot_engine.js`)

#### 概述
“剧情引擎”是控制会话主线大方向的引导中枢，提供一个现代极简、浅色调的模态操作面板。用户写入的要求会被作为高优先级故事大纲实时拼装注入系统提示词链，在对话中引导大模型的态度演进和剧情。

---

### 2.5 char 社交动作集成系统 (`app_chat_social_actions.js`)

#### 概述
让 char 在聊天过程中具备跨应用的社交主动性：可以自发发布朋友圈、前往论坛发帖、自主建立论坛小号，并以系统消息形式把社交动作反馈到聊天里。同时打通论坛账户与聊天面具的"现实身份同步"通道，让被授权的 char 在论坛中知道 user 的真实身份。

#### 核心能力
*   **自动发朋友圈**：对话详情开启"允许自动发朋友圈"开关后，prompt 注入特权段落，char 在合适时机输出 `[AUTO_MOMENT: 内容]` 指令即可自发朋友圈（支持 `[MOMENT_IMAGE: 描述]` 附带图片）。无论开关是否开启，char 之前发过的朋友圈（含点赞、评论互动）都按时间并入聊天上下文。
*   **论坛漫游**：对话详情开启"允许论坛漫游"后，char 可输出 `[FORUM_POST: 标题|正文]` 用主号发帖、`[FORUM_POST_ALT: 序号|标题|正文]` 用指定身份发帖。开启"允许建立论坛小号"子开关后，char 可输出 `[FORUM_ALT_CREATE: 昵称|签名]` 自主建立小号，发一些大号不合适发的内容。
*   **3 小号上限**：每个 char 最多 3 个论坛分身（含主号），prompt 中实时告知剩余配额。NPC 管理中枢里每个 char 显示全部分身，主号标"主号"徽章，其余标"小号N"徽章。
*   **系统消息反馈**：char 发朋友圈 / 论坛发帖 / 建立小号后，以 `senderType='system'` 写入简短系统消息到 `db.messages`，聊天界面即时上屏。
*   **论坛账户同步聊天身份**：论坛账户编辑资料新增"同步聊天身份"开关 → 选择绑定面具（`db.archives type='user'`）→ "同步给 char"子开关 → char 多选列表（每行带头像/姓名/备注 + 独立"携带聊天记忆"小开关）。被选中的 char 在论坛私信/发帖/评论时会知道此账户的现实身份就是 user；携带记忆时注入核心心智摘要（关系、对用户印象），不携带时仅以档案馆人设为准。

#### 指令格式
```
[AUTO_MOMENT: 朋友圈文本内容]              # char 自动发一条朋友圈
[FORUM_POST: 帖子标题|帖子正文]            # char 用主号在论坛发帖
[FORUM_POST_ALT: 身份序号|标题|正文]       # char 用指定身份（1=主号, 2+=小号）发帖
[FORUM_ALT_CREATE: 昵称|个性签名]          # char 建立一个新的论坛小号
```

#### 数据字段
*   `sessions` 表新增动态字段（Dexie 无需 schema 升级）：`allowCharAutoMoment` / `allowCharForumRoam` / `allowCharForumAltAccount`（均为 0/1 整数）。
*   `forum_accounts` 表新增动态字段：`syncChatConfig`（JSON 字符串），结构 `{ enabled, boundPersonaId, syncToChar, syncChars: [{charId, carryMemory}] }`。

---

## 3. Dexie 数据库设计规范 (Version 10 & 扩充版)

系统数据库包含 22 张物理表（在 Version 10 标准上扩充了阅读与伴读书城四张关联表，保持高抗灾结构对齐）。执行任何二次开发和结构拓展时必须在此基础上进行升级。当前最新结构已迭代至 **Version 27**，主要新增了情侣空间·悄悄话话题会话与归档机制相关表，详见下方「Version 27 增补表」。

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

### Version 27 增补表：情侣空间·悄悄话话题会话与归档机制

```javascript
db.version(27).stores({
  // couples_whispers 增补 topicId / archived 索引（不丢旧数据，仅扩展索引）
  couples_whispers: 'id++, charId, timestamp, topicId, archived',

  // 新增：每个话题会话的元信息
  couples_whisper_topics: 'id++, charId, meId, startTime, endTime, archived, topicTitle'
});
```

**`couples_whisper_topics` 字段说明：**
| 字段 | 说明 |
| :--- | :--- |
| `charId` / `meId` | 关联的角色与用户 |
| `startTime` / `endTime` | 话题起止时间（endTime 归档时写入） |
| `archived` | 0=活动/结束，1=已归档 |
| `topicTitle` | 话题标题 |
| `initiator` | `'user'` 或 `'char'`（发起方） |
| `summary` | 归档时 LLM 生成的话题总结 |

**`couples_whispers` 增补字段：** `topicId`（关联话题 ID）、`archived`（是否已归档）。归档时该话题下所有消息 `archived` 置 1，但仍保留在表中可供历史查看。

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
*   **通话系统集成**：在 `appendMessageToDOM` 中新增 `contentType='call'` 渲染分支（通话记录系统卡片），在历史上下文构建中对通话记录进行可读摘要转换，并在 char 回复流中检测 `[AUTO_CALL:voice|video]` 指令触发主动通话。通话中的对白消息（带 `callId` 字段）不在主聊天列表上屏，仅在通话记录卡片内查看。

### 6.8 HTML 互动舱与安全沙盒：`app_chat_html_widget.js`
*   **交互卡片组件中枢**。允许用户基于当前的对话上下文、世界书以及核心心智，编译输出完全独立、高度交互运行的单文件 HTML/CSS/JS 卡片。支持一键重绘清洗和源码维修舱二级物理阻隔空间。
*   **双视图响应式（v3.2 新增）**：列表小卡片（高度 250px）+ 全屏大卡片预览（480×880 iframe）。`openPreview(id)` 创建全屏浮层渲染清洗态代码，支持刷新/关闭/ESC/点遮罩关闭；`togglePrompt(id)` 实现超 150 字指令折叠为一行、点击展开。`HTML_WIDGET_INSTRUCTION` 提示词明确双视图尺寸约束，要求 AI 生成代码用 Flexbox/Grid + 相对单位同时适配两种尺寸。

### 6.9 HTML 互动舱护眼样式：`chat_html.css`
*   **HTML 互动舱与代码维修舱专属样式**。采用护眼深石墨灰+优雅靛蓝科技感方案。将卡片的时间脚标移至卡片右下角，提供清爽规整的排版空间。
*   **预览与折叠样式（v3.2 新增）**：`.html-card-prompt-collapsed` 单行截断（`-webkit-line-clamp:1`）、`.html-card-prompt-toggle` 展开按钮、`@keyframes htmlPreviewFadeIn` 预览浮层淡入动画。

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

### 6.26 思维链解析与展示系统：`app_chat_cot.js` (最新扩充)
*   **CoT (Chain of Thought) 解析引擎**。从大模型回复中提取 `<think>`、`[THINKING]`、`【思考】`、`<thought>`、`<thinking>` 等多种思维链标签格式，将思考过程与最终对白安全分离。
*   **孤儿标签归一化**：增强 `parseThoughtWithRegex` 函数，支持对仅有结束标签（如 `</think>`）或仅有开始标签的残缺思维链进行自动补全归一化，大幅提升思维链识别的健壮性，解决频繁爆出的"思维链未识别"问题。
*   提取的思维链内容在气泡顶部以可折叠的灰色区块展示，清洗后的纯对白文本正常渲染。

### 6.27 MiniMax TTS 语音合成引擎：`app_tts.js` (最新扩充)
*   **多版本 TTS 接口支持**：支持 MiniMax 国内版 (`api.minimax.chat`) 与国际版 (`api.minimaxi.com`) 双线路切换，通过 `resolveApiBaseUrl()` 函数动态解析接口地址。
*   **自定义 URL 覆盖**：用户可在 TTS 设置面板中填写自定义接口 URL，留空时自动按所选版本填充默认地址。
*   **3 天本地缓存**：独立 Dexie 库 `TtsVoiceCacheDB.tts_cache` 缓存已合成的语音 Blob，按 model + voiceId + text 组合哈希作为缓存键，3 天自动过期清理。
*   **会话级 TTS 开关**：在对话详情中开启 TTS 并填写音色 ID 后，点击 AI 发送的语音消息即可展开文字卡片并播放该音色语音。

### 6.28 语音/视频通话系统：`app_chat_call.js` (最新扩充)
*   **仿微信全屏通话面板**：动态注入 DOM 构建 `#call-overlay` 全屏通话界面，支持语音通话与视频通话两种模式。包含头像、名称、通话计时器、消息列表与输入栏。
*   **视频通话大小屏布局**：仿微信视频通话，char 头像作为全屏背景（模糊渐变），user 小窗（90×130）固定右上角，实现大小屏视窗效果。
*   **通话中对白交互**：通话过程中可打字上屏，char 返回口语化回复（强约束无括号动作描写、无思维链标签）。若会话开启 TTS 且填写了音色 ID，回复气泡下方挂载播放按钮，可反复播放生成的语音。
*   **通话记录系统卡片**：通话结束后生成 `contentType='call'` 的系统通知样式消息，仅显示"语音/视频通话已结束 - 展开"，点击展开弹出卡片查看通话中的全部对话记录，对方语音可在 3 天缓存内反复播放。被拒来电显示"你拒绝了对方的通话请求"。
*   **通话记录渲染修复**：系统消息渲染分支（`senderType === 'system'`）已增加 `contentType !== 'call'` 守卫，确保通话记录卡片走专用渲染分支而非被当作纯文本显示 JSON 乱码。
*   **标签清洗双向通道**：`sanitizeForCallContext()` 函数在通话前清洗线上文本的括号动作、多媒体标签、思维链标签；回到线上对话时，通话残留的无关标签也能被正常清洗。
*   **char 主动发起通话**：对话详情新增"允许对方主动发起通话"开关及"同时允许视频通话"子开关。开启后通过 `buildAutoCallPromptSegment()` 注入 prompt 特权，char 在回复末尾输出 `[AUTO_CALL:voice|video]` 指令即可自动触发通话界面。prompt 中已明确区分 `[AUTO_CALL]` 与 MCP `[CALL_TOOL]` 指令，防止 char 误调 MCP 工具发起通话。
*   **来电卡片（仿微信）**：char 主动发起通话时弹出全屏来电卡片（`z-index: 100002`，任何页面可见），点击接通进入通话，点击挂断生成"你拒绝了对方的语音/视频通话请求"系统消息并计入上下文。
*   **通话气泡双击工具栏（全功能实装）**：通话过程中的气泡支持双击打开全局 `#bubble-context-menu` 工具栏，工具栏临时提升至 `z-index: 100003` 并挂到 `document.body` 顶层。所有功能（格式修复、翻译、编辑、收藏、删除、撤回）在通话上下文中完整可用，操作后自动通过 `refreshCallBubbles()` 刷新通话面板而非线上对话。回溯重回和多选消息按钮在通话中自动隐藏。
*   **编辑/格式修复弹层层级修复**：`elevateContextMenu()` 同步提升 `custom-edit-overlay` 和 `custom-format-repair-overlay` 的 z-index 到 `100004`（高于通话面板 100000 和工具栏 100003），并挂到 `document.body` 顶层，避免在通话中打开编辑/格式修复卡片时被通话面板遮挡。通话结束后 `restoreContextMenu()` 恢复原 z-index。
*   **通话内容计入上下文**：通话中的对白消息以 `contentType='text'` + `callId` 字段存入 `messages` 表，通话记录卡片在历史上下文构建中转为可读摘要，确保通话内容被大模型感知但不污染 JSON。

### 6.29 听歌应用搜索多通道容错：`app_music.js` (最新扩充)
*   **三通道搜索竞速**：`searchNcmMusic()` 从单点 Vercel 代理改为三通道容错架构：
    - 通道一：网易云官方搜索 API（`music.163.com/api/search/get`），走 `ncmNativeFetch` 含 allorigins 代理兜底
    - 通道二：Vercel 代理 API（原通道，作为备选）
    - 通道三：Meting 开源 API（`api.i-meto.com`，最终兜底）
*   **超时熔断**：每个通道均设置 5 秒硬超时，防止单通道挂起导致搜索永久卡死。
*   **搜索结果导入歌单**：搜索结果除播放外，新增"+"按钮可导入到指定歌单（`importSearchResult()`），解决了原搜索只播放不入歌单的问题。
*   **错误反馈优化**：所有通道均失败时显示"所有搜索通道均未响应"，部分失败时提示"在线搜索通道暂不可用"，不再静默吞掉错误。
*   **歌单范围播放**：新增 `currentPlaylistId` 属性和 `playSongFromPlaylist(playlistId, songId)` 方法。在歌单详情页点击播放时设置 `currentPlaylistId`，`playSongFromList()` 检测到该属性后只取歌单内歌曲作为 playlist，顺序/循环/随机模式均限定在此歌单内，不会跳到整个大曲库。
*   **一起听指令系统消息**：AI 输出的操控指令（`[PLAY_SONG:n]` 切歌、`[SEEK:n]` 拖进度条、`[NEXT]`/`[PREV]`/`[PAUSE]`/`[RESUME]`）执行后生成系统消息反馈（如"拖动进度条到 0:30""切歌到《xxx》"），以居中灰字样式渲染在聊天室小屏幕。`[PLAY_SONG:n]` 的 n 现在是当前歌单内索引而非全库索引。`renderIslandChatMessages()` 支持 `sender='system'` 类型的消息渲染。

### 6.30 情侣空间·悄悄话话题会话与归档系统：`app_chat_couples.js` (v3.2 最新扩充)
*   **话题会话机制**：悄悄话升级为「话题会话」，双方（user 与 char）均可主动发起/结束话题。AI 在回复中输出 `[WHISPER_TOPIC_START: 话题标题]` / `[WHISPER_TOPIC_END]` 指令（与朋友圈、论坛线上指令风格一致），由 `parseWhisperCommands(text)` 用括号平衡法提取后触发 `startWhisperTopic` / `endWhisperTopic`，用户也可通过 UI 按钮发起。
*   **3 天自动归档 + 手动归档**：`autoArchiveExpiredTopics()` 进入情侣空间时巡检，对所有 `archived !== 1` 且 `startTime` 距今超 3 天的话题调用 `archiveTopic(id, true)` 自动归档；用户可点击「归档」按钮调用 `archiveTopic(id, false)` 手动归档。
*   **归档总结入记忆库**：`archiveTopic` 拉取话题消息 → 调用 `summarizeWhisperTopic` 让 LLM 生成总结 → 写入 `db.summaries`（`category:'relationship'`，`content` 形如 `【情侣空间·悄悄话归档】话题《标题》（我发起/对方发起）：总结`）→ 标记话题和消息 `archived:1`。归档内容进入长期记忆库后可被 RAG 召回，让 char 真正"记住"悄悄话。
*   **对话连贯性修复**：`triggerWhisperReply` 仅保留当前活动话题内的消息历史（按 `topicId` 过滤），并在 prompt 中强调"承接当前话题上下文回复"，解决原先跨话题消息混杂导致 AI"不读用户话"、答非所问的问题。
*   **数据表**：依赖 `db.js` Version 27 的 `couples_whisper_topics`（话题元信息）与 `couples_whispers`（增补 `topicId`/`archived` 索引）两张表。

### 6.31 全局空头像安全渲染修复 (v3.2 最新扩充)
*   **问题**：头像为空时显示破损图片，名字区域出现残破「>」字样。根因是 `resolveAvatar` 返回的 SVG 数据 URL 内部属性用双引号，插入 `<img src="data:image/svg+xml;utf8,<svg viewBox="...">">` 时双引号提前闭合 `src` 属性，剩余 SVG 标记（含 `>`）泄漏到 HTML。
*   **修复范围**：统一 `app_archive.js`、`app_reader.js`、`app_deeptalk.js`、`app_world_book.js` 中所有 `resolveAvatar` 函数，SVG 内部属性改用单引号（`viewBox='0 0 100 100'`），`#` 做 URL 编码（`%23`），并新增"人"字默认灰色图标兜底。
*   **`app_chat.js` 增强**：新增 `avatarFallback(el)` 函数处理 `<img onerror>` 回退；会话列表头像 `src` 与名字均加 `escapeHtml`，防止残破字符泄漏到名字区域。