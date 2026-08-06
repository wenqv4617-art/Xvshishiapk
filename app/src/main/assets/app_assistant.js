/**
 * app_assistant.js - 应用内小助手（API Agent 驱动 + 关键词回退）
 *
 * 设计目标：
 * 1. 优先调用用户配置的对话 API，像 Agent 一样自主理解问题、查询手册、找/改 CSS 代码
 * 2. AI 回复中可用 [[BTN:按钮文字|目标]] 标记输出跳转按钮，前端解析为可点击按钮
 * 3. 气泡支持 Markdown 解析（含代码块一键复制）
 * 4. API 未配置或调用失败时，回退到内置关键词匹配（保证基础可用）
 */

const AppAssistant = {
  // 会话历史（仅内存，不持久化）
  messages: [],
  isLoading: false,
  abortController: null,

  // ===== 跳转目标白名单（AI 输出的按钮 target 必须在此列表内）=====
  validTargets: {
    'settings': '设置主页',
    'settings-api': 'API 协议设置',
    'settings-tts': 'TTS 语音设置',
    'settings-vector': '向量化记忆设置',
    'settings-imagegen': '生图设置',
    'settings-desktop': '桌面美化设置',
    'chat-sessions': '聊天会话列表',
    'chat-me': '聊天-我的',
    'chat-moments': '朋友圈',
    'archive': '档案馆',
    'reader': '阅读',
    'deeptalk': '深谈',
    'music': '听歌',
    'forum': '论坛',
    'couples': '情侣空间',
    'encounter': '邂逅',
    'shopping': '购物',
    'quicktravel': '快穿局',
    'worldbook': '世界书'
  },

  // ===== 命令白名单（AI 输出的命令必须在此列表内，前端匹配执行）=====
  // 通过 [[CMD:按钮文字|命令名]] 标记触发，执行后小助手自动收起为悬浮小窗
  commandMap: {
    // 档案库 - 新建角色/用户/npc
    'create_char': () => {
      window.openApp('archive');
      setTimeout(() => {
        const tab = document.querySelector('#win-archive .archive-tabs .tab-item[data-tab="character"]');
        if (tab) tab.click();
        setTimeout(() => { if (typeof openArchiveForm === 'function') openArchiveForm(); }, 250);
      }, 300);
    },
    'create_user': () => {
      window.openApp('archive');
      setTimeout(() => {
        const tab = document.querySelector('#win-archive .archive-tabs .tab-item[data-tab="user"]');
        if (tab) tab.click();
        setTimeout(() => { if (typeof openArchiveForm === 'function') openArchiveForm(); }, 250);
      }, 300);
    },
    'create_npc': () => {
      window.openApp('archive');
      setTimeout(() => {
        const tab = document.querySelector('#win-archive .archive-tabs .tab-item[data-tab="npc"]');
        if (tab) tab.click();
        setTimeout(() => { if (typeof openArchiveForm === 'function') openArchiveForm(); }, 250);
      }, 300);
    },
    // 世界书 - 新建条目
    'create_worldbook': () => {
      window.openApp('world_book');
      setTimeout(() => { if (typeof openWorldBookForm === 'function') openWorldBookForm(); }, 400);
    },
    // 深谈 - 新建（打开深谈应用，由用户继续选择会话）
    'create_deeptalk': () => {
      window.openApp('deeptalk');
    },
    // 快穿局 - 新建世界观（闭包函数，通过模拟点击触发）
    'create_quicktravel_worldview': () => {
      window.openApp('quicktravel');
      setTimeout(() => {
        const btn = document.getElementById('qt-wv-new');
        if (btn) btn.click();
      }, 500);
    },
    // 论坛 - 发帖
    'create_forum_post': () => {
      window.openApp('forum');
      setTimeout(() => { if (typeof forumPushLayer === 'function') forumPushLayer('new-post'); }, 400);
    },
    // 朋友圈 - 发动态
    'create_moments_post': () => {
      window.openApp('chat');
      setTimeout(() => {
        const tab = document.querySelector('#win-chat .chat-tabs .tab-item[data-chat-tab="moments"]');
        if (tab) tab.click();
        setTimeout(() => {
          if (window.momentSystem && window.momentSystem.openPostModal) window.momentSystem.openPostModal();
        }, 250);
      }, 300);
    },
    // 聊天 - 新建会话
    'new_chat': () => {
      window.openApp('chat');
      setTimeout(() => {
        const tab = document.querySelector('#win-chat .chat-tabs .tab-item[data-chat-tab="sessions"]');
        if (tab) tab.click();
        setTimeout(() => {
          const btn = document.getElementById('btn-new-chat');
          if (btn) btn.click();
        }, 250);
      }, 300);
    },
    // 聊天 - 打开加号展开栏（需先进入一个对话）
    'open_chat_expand': () => {
      window.openApp('chat');
      setTimeout(() => {
        const btn = document.getElementById('btn-chat-expand-toggle');
        if (btn) btn.click();
      }, 400);
    }
  },

  // ===== 应用使用手册（作为系统提示词的一部分，供 AI 查询）=====
  // 注意：所有路径必须真实存在，AI 只能基于此手册回答，禁止瞎编
  manualText: `# 叙事诗小手机 完整使用手册（路径总览）

所有功能路径都以「桌面 → 应用」为起点。下方 [跳转:目标标识] 表示可以用按钮直接跳转；[命令:命令名] 表示可以执行操作并自动收起为小窗。

## 0. 快速开始
- 注册: 使用本群内的 QQ 邮箱，自己设置密码，第一次注册点击「注册新账户」，有报错带图来找 @雨中见
- 内置桌面: 设置 → 桌面美化设置 → 系统内置 UI  [跳转:settings-desktop]
- API 在哪: 对话 API / TTS API / 向量记忆 API / 生图 API，都在「设置」里 [跳转:settings-api]
- 快速开始对话: 先在档案馆建立至少一个 user 面具 → 在「聊天-我的」中选择该 user 面具全局应用
- 查手机、mcp、html、思维链与提示词: 都在「聊天对话内的加号展开栏」里
- 唤出气泡工具栏: 双击气泡/头像
- 贴表情: 长按气泡
- 引用: 左滑气泡
- 心声、翻译、美化、生图、tts: 对话详情页

## 1. 聊天应用（桌面 → 聊天）[跳转:chat-sessions]
底部三个 tab: 会话 / 朋友圈 / 我的

### 1.1 会话 tab [跳转:chat-sessions]
- 新建会话: 点击右上角「+」→ 选择单聊/群聊 [命令:new_chat]
- 进入对话后:
  - 加号展开栏（18 项）: 表情包/图片/语音/语音通话/转账/红包/专注/线下/位置/查手机/记忆/总结/html/剧情引擎/mcp中枢/思维链(提示词在里面) [命令:open_chat_expand]
  - 双击气泡工具栏: 格式修复/翻译此条/编辑/重回/收藏/多选(删除/翻译)/删除
  - 对话详情页（右上角进入）: 双方头像、双方人设、世界书/心声/翻译/tts音色设置/主动语音图片/主动通话/表情包挂载/自动发朋友圈/自动发论坛/时间感知/消息分句/允许撤回/允许表情反应/允许拉黑/对话美化/生图/保存/拉黑/删除对话/删除聊天记录

### 1.2 群聊
- 有 user: 加号展开栏: 表情包/图片/语音/转账/红包(拼手气)/位置/线下/剧情引擎/群投票/群公告/群助手/成员管理(转让群主，禁言，头衔…)/记忆/总结
- 群聊后台: 群名称/群头像/世界书/表情包/记忆漫游/美化入口/保存/清除记录/删除群聊
- 无 user: 注入旁白

### 1.3 朋友圈 tab [跳转:chat-moments]
- 可转发到聊天，点击可跳转，选择角色发动态
- 发动态 [命令:create_moments_post]

### 1.4 我的 tab [跳转:chat-me]
- 上方: 搜索聊天记录
- 下方: 切换当前 user 面具（点头像卡片展开候选列表）
- 表情包管理(互通) / 收藏室管理(不互通) / 钱包(不互通)

## 2. 设置应用（桌面 → 设置）[跳转:settings]
二级面板（在设置主页点对应菜单进入）:
- 账号安全管理 [跳转:settings-account]
- API 协议设置 [跳转:settings-api]: 对话 API / TTS / 向量记忆 / 生图
- TTS 语音设置 [跳转:settings-tts]
- 向量化记忆设置 [跳转:settings-vector]
- 生图设置 [跳转:settings-imagegen]
- 桌面美化设置 [跳转:settings-desktop]: 桌面壁纸/图标/Dock 不透明度/系统内置 UI 预设
- 全局 CSS 注入: 自定义 CSS 代码编辑与预设
- 组件工坊: 编译/保存自定义桌面小部件
- 数据分区管理: 导入导出备份、压缩图片体积（7 块隔离）
- 系统强更新 / 更新日志

## 3. 档案馆（桌面 → 档案馆）[跳转:archive]
顶部四个 tab: 角色 / 用户 / npc / 关系网
- 角色(char)/用户(user): 姓名/母语/人设/外貌/锁脸
  - 新建角色 [命令:create_char]
  - 新建用户 [命令:create_user]
- npc: 挂载到角色/用户
  - 新建 npc [命令:create_npc]
- 关系网: 建立多个关系网，可视化编辑器
- 导入/导出 docx/txt

## 4. 世界书（桌面 → 世界书）[跳转:worldbook]
- 三态挂载: 始终/关键词/禁用，可整组开关
- 新建条目 [命令:create_worldbook]

## 5. 阅读（桌面 → 阅读）[跳转:reader]
- 跟随聊天面具
- 书架: 导入 txt/docx
- 书城: 搜索栏定制同人文/热榜图书与标签分类(标签可管理)
- 我的: 新增文风预设
- 阅读视图: 右上角挂载伴读角色，双击段落发表段评，下方调整主题与字体颜色
- 章节末尾: 续写设置

## 6. 深谈（桌面 → 深谈）[跳转:deeptalk]
- 跟随聊天面具
- 新建深谈 [命令:create_deeptalk]
- 归档后可把记忆同步到聊天里

## 7. 听歌（桌面 → 听歌）[跳转:music]
- 听歌功能(共听功能 char 可切进度切歌)
- 登录网易云还没做好，可导入网易云歌单(前10首)
- 创建歌单，同步到专注 BGM 与「聊天-加号展开栏-mcp中枢-歌曲列表」

## 8. 论坛（桌面 → 论坛）[跳转:forum]
- 可建立多个账号，论坛后台设置世界观
- npc 管理引入 char
- 清理路人帖子
- 私信: 双击工具栏，加号展开栏
- 账号信息编辑: 是否同步聊天身份/是否将身份同步给 char/是否让 char 携带记忆
- 发帖 [命令:create_forum_post]

## 9. 情侣空间（桌面 → 情侣空间）[跳转:couples]
- 跟随当前面具
- 纪念日: 一键生成日程，user 手动添加，同步到当前面具所有情侣空间，可选挂载到聊天记忆
- 相册: 纪念相册，可评论
- 手账: 建立手账，上传帖纸与底纹，让 char 参与写手账
- 悄悄话: 私密话题对话
- 愿望清单: 可同步到聊天

## 10. 邂逅（桌面 → 邂逅）[跳转:encounter]
- 首页增加标签，刷新时选择标签生成 npc
- 点击头像展开人设卡片: 擦肩而过(删除此 npc) / 加入档案库(转正进入 char 列表)
- 广场: 刷帖子，自己增加分类，每个帖子可刷新互动
- 可自己发帖并生成 npc 互动

## 11. 购物（桌面 → 购物）[跳转:shopping]
- 跟随聊天的当前面具切换
- 首页切换购物/外卖，可选我付/他付，可选 char 的地址送礼(char 也可发起代付与送礼)
- 物流动态跟踪，可查看店铺
- 买外卖可加购神券，使用神券有 80% 概率膨胀 2-3 倍
- 抽奖活动，满 700 提现，可通过转发获取抽奖次数

## 12. 快穿局（桌面 → 快穿局）[跳转:quicktravel]
- 首次进入建立身份(后面可改)
- 领任务: 世界观列表，新建世界观 [命令:create_quicktravel_worldview]
  - 可 ai 一键填充，挂载多个世界书，下方填多个开场白(留空则首轮调用 api 生成)
  - 可导入/导出 .json
- 系统空间: 当前身份信息，选择系统个性，下方为已完成任务列表
- 当前任务: 已开启的进行中任务，最多五个
- 美化: 开始游戏时挂载，可自行编写，可上传文游背景，内置线上消息格式和 npc 状态栏，可导入导出
- 在世界观下点「开始游戏」→ 配置美化、世界书 → 进入副本
- 副本内右上角工具栏: 显示/隐藏系统、弹幕系统(每轮额外调用一次api/随动/禁用)、总结管理、变量控制、剧情引擎、完结剧本
- 长按气泡: 工具栏(重回/编辑/删除)
- 系统球: 点一下互动(调用api)，长按唤出面板: 随机道具(内置10个，用完后调用api生成，使用后下一轮生效)/求助(跟系统说需要什么帮助，下一轮开金手指)`

  // ===== CSS 美化代码库（供 AI 查询和参考）=====
  ,
  cssLibraryText: `### 微信式消息气泡 (文件: chat.css)
关键词: 气泡, msg-bubble, 微信气泡, 聊天气泡
\`\`\`css
.msg-bubble { display: flex; align-items: flex-start; max-width: 85%; cursor: pointer; user-select: none; }
.msg-bubble.self { align-self: flex-end; flex-direction: row-reverse; }
.msg-bubble.other { align-self: flex-start; }
.msg-text { padding: 10px 14px; border-radius: 6px; font-size: 14px; line-height: 1.4; word-break: break-all; box-shadow: 0 1px 2px rgba(0,0,0,0.05); }
.msg-bubble.self .msg-text { background-color: #95ec69; color: #191919; }
.msg-bubble.other .msg-text { background-color: #ffffff; color: #191919; }
\`\`\`

### 线下状态栏 (文件: chat.css)
关键词: 状态栏, status-bar, 好感度, 兴奋值, 进度条, 心声
\`\`\`css
.chat-offline-status-bar { margin-top: 10px; padding: 10px 12px; background: linear-gradient(135deg, #f0f9ff, #e0f2fe); border: 1px solid #bae6fd; border-radius: 10px; }
.chat-offline-status-npc { font-size: 13px; font-weight: 700; color: #0369a1; margin-bottom: 8px; }
.chat-offline-status-row { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
.chat-offline-status-label { font-size: 11px; color: #475569; font-weight: 600; width: 42px; flex-shrink: 0; }
.chat-offline-status-meter { flex: 1; height: 8px; background: #e2e8f0; border-radius: 4px; overflow: hidden; }
.chat-offline-status-fill { height: 100%; background: linear-gradient(90deg, #38bdf8, #0ea5e9); border-radius: 4px; transition: width 0.3s; }
.chat-offline-status-fill-excited { background: linear-gradient(90deg, #fb7185, #e11d48); }
.chat-offline-status-val { font-size: 11px; color: #1e293b; font-weight: 700; width: 28px; text-align: right; }
.chat-offline-status-thought-text { font-size: 12px; color: #6d28d9; font-style: italic; flex: 1; }
\`\`\`

### 线下白描卡片 (文件: chat.css)
关键词: 卡片, offline-card, 线下卡片, 白描卡片
\`\`\`css
.offline-card { background: #ffffff; border-radius: 12px; padding: 14px; margin-bottom: 12px; box-shadow: 0 1px 3px rgba(0,0,0,0.06); }
.offline-card-header { display: flex; justify-content: space-between; font-size: 12px; color: var(--text-secondary); margin-bottom: 8px; padding-bottom: 8px; border-bottom: 1px solid var(--border); }
.offline-card-body { font-size: 14px; line-height: 1.6; color: var(--text-primary); }
\`\`\`

### 微信会话列表项 (文件: chat.css)
关键词: 会话列表, session-item, session-list
\`\`\`css
.session-list { display: flex; flex-direction: column; }
.session-item { background-color: var(--surface); padding: 14px 16px; display: flex; align-items: center; border-bottom: 1px solid var(--border); cursor: pointer; }
.session-avatar { width: 48px; height: 48px; border-radius: 6px !important; object-fit: cover; margin-right: 12px; }
.session-name { font-size: 15px; font-weight: 700; color: var(--text-primary); }
.session-time { font-size: 11px; color: var(--text-secondary); }
.session-msg { font-size: 12px; color: var(--text-secondary); margin-top: 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; width: 220px; }
\`\`\`

### 微信输入控制栏 (文件: chat.css)
关键词: 输入框, 输入栏, dialog-input
\`\`\`css
.dialog-input-container { background-color: #f7f7f7; border-top: 1px solid var(--border); padding: 8px 12px; display: flex; flex-direction: column; }
.input-main-row { display: flex; align-items: center; gap: 8px; }
.dialog-input-container textarea { flex: 1; border-radius: 8px; padding: 8px 10px; border: none; background-color: #ffffff; resize: none; font-size: 14px; max-height: 80px; }
.chat-send-btn { width: 38px; height: 38px; border-radius: 50%; border: none; background-color: #07c160; color: white; display: flex; align-items: center; justify-content: center; cursor: pointer; transition: background-color 0.2s, transform 0.1s; flex-shrink: 0; }
.chat-send-btn:active { transform: scale(0.92); }
\`\`\`

### 模态弹窗基础样式 (文件: app.css)
关键词: 模态, modal, 弹窗, overlay
\`\`\`css
.modal-overlay { position: fixed; top: 0; left: 0; width: 100%; height: 100%; background-color: rgba(0,0,0,0.5); display: flex; align-items: center; justify-content: center; z-index: 1000; opacity: 0; visibility: hidden; transition: opacity 0.2s, visibility 0s linear 0.2s; }
.modal-overlay.active { opacity: 1; visibility: visible; transition: opacity 0.2s, visibility 0s linear 0s; }
.modal { background-color: var(--surface); border-radius: var(--radius); padding: 20px; width: 90%; max-width: 400px; box-shadow: var(--shadow-md); }
\`\`\`

### 按钮基础样式 (文件: app.css)
关键词: 按钮, btn, button
\`\`\`css
.btn-primary { background-color: var(--primary); color: #fff; border: none; padding: 10px 16px; border-radius: 8px; font-size: 14px; font-weight: 600; cursor: pointer; transition: background-color 0.2s; }
.btn-primary:hover { background-color: var(--primary-dark); }
.btn-outline { background: none; color: var(--primary); border: 1.5px solid var(--primary); padding: 10px 16px; border-radius: 8px; font-size: 14px; font-weight: 600; cursor: pointer; }
.btn-danger-outline { background: none; color: #ef4444; border: 1.5px solid #fca5a5; padding: 10px 16px; border-radius: 8px; font-size: 14px; font-weight: 600; cursor: pointer; }
\`\`\`

### 全局 CSS 变量 (文件: app.css)
关键词: css变量, 主题色, primary, surface, border
\`\`\`css
:root {
  --primary: #6366f1; --primary-light: #e0e7ff; --primary-dark: #4f46e5;
  --surface: #ffffff; --bg-main: #f7f7f7; --border: #e5e7eb;
  --text-primary: #1f2937; --text-secondary: #6b7280;
  --radius: 12px; --shadow-sm: 0 1px 2px rgba(0,0,0,0.05); --shadow-md: 0 4px 6px rgba(0,0,0,0.1);
}
\`\`\`

### 小助手气泡样式 (文件: assistant.css)
关键词: 助手气泡, assistant-bubble
\`\`\`css
.assistant-bubble-user { background: linear-gradient(135deg, #6366f1, #8b5cf6); color: #fff; padding: 10px 14px; border-radius: 16px 16px 4px 16px; font-size: 14px; max-width: 78%; box-shadow: 0 2px 6px rgba(99,102,241,0.25); }
.assistant-bubble-bot { background: #ffffff; color: #1f2937; padding: 12px 14px; border-radius: 4px 16px 16px 16px; font-size: 14px; max-width: 88%; box-shadow: 0 1px 3px rgba(0,0,0,0.06); border-left: 3px solid #6366f1; }
.assistant-action-btn { background: linear-gradient(135deg, #6366f1, #8b5cf6); color: #fff; border: none; padding: 7px 14px; border-radius: 16px; font-size: 12px; font-weight: 600; cursor: pointer; }
\`\`\``

  // ===== 构建系统提示词 =====
  ,
  buildSystemPrompt: function() {
    const targetList = Object.entries(this.validTargets)
      .map(([k, v]) => `   - ${k} (${v})`).join('\n');
    const cmdList = Object.keys(this.commandMap)
      .map(k => `   - ${k}`).join('\n');

    return `你是「叙事诗小手机」应用内置的小助手。你的职责是帮助用户快速了解应用功能、跳转到对应页面、执行操作、查询和生成 CSS 美化代码。

## 最高原则：禁止瞎编
1. 你只能基于下方「应用使用手册」回答问题。手册里没有的功能、路径、页面，一律不许编造。
2. 如果用户问的内容不在手册里，明确告诉用户"这个我不确定，手册里没有相关说明"，不要凭猜测编造路径。
3. 所有功能路径必须与手册完全一致，不可自行脑补新的页面或入口。

## 两类按钮标记
### A. 跳转按钮（引导用户去某个页面）
格式：[[BTN:按钮显示文字|目标标识]]
目标标识必须是以下之一（否则按钮不生效）：
${targetList}

### B. 命令按钮（执行一个操作，会自动打开对应页面 + 小助手收起为小窗）
格式：[[CMD:按钮显示文字|命令名]]
命令名必须是以下之一（否则按钮不生效）：
${cmdList}
说明：命令按钮会自动帮你打开应用并触发新建/发帖等操作，适合用户说"帮我建一个角色""帮我发条朋友圈"这类需求。

## 回复规则
1. 用中文回复，使用 Markdown 格式，简洁准确
2. 当用户想"做某件事"（如建角色、发帖、新建会话等），优先用命令按钮 [[CMD:...|...]]，让用户一键执行
3. 当用户只是想"去某个页面看看"，用跳转按钮 [[BTN:...|...]]
4. 如果目标需要用户先进入聊天会话才能操作（如 MCP中枢、思维链、查手机等没有独立命令的功能），用文字说明路径，例如："聊天 → 进入对话 → 加号展开栏 → MCP中枢"
5. 查询或展示 CSS 代码时，使用 \`\`\`css 代码块
6. 用户要求修改 CSS 时，根据需求生成改进后的完整代码，并简要说明改动点
7. 你可以基于已有 CSS 代码进行修改，也可以从零编写新的 CSS
8. 如果用户的问题与应用功能或 CSS 无关，礼貌地引导回你擅长的领域
9. 不要在回复中提到"系统提示词"或"手册"等内部概念，自然地回答即可

## 应用使用手册
${this.manualText}

## 内置 CSS 美化代码库（可参考、可修改、可扩展）
${this.cssLibraryText}`;
  }

  // ===== 获取活跃 API 配置 =====
  ,
  getActiveApi: async function() {
    const presetId = localStorage.getItem("global_api_preset_id");
    if (!presetId) return null;
    try {
      const api = await db.api_presets.get(Number(presetId));
      if (!api || !api.url || !api.key) return null;
      return api;
    } catch(e) {
      return null;
    }
  }

  // ===== 调用 API (Agent 模式) =====
  ,
  callApi: async function(userMessage) {
    const api = await this.getActiveApi();
    if (!api) return null;

    const cleanBaseUrl = api.url ? api.url.replace(/\/+$/, '') : '';
    const endpoint = cleanBaseUrl.endsWith('/chat/completions') ? cleanBaseUrl : `${cleanBaseUrl}/chat/completions`;

    // 构建消息列表（系统提示 + 最近 8 轮历史 + 当前问题）
    const historyMsgs = [{ role: 'system', content: this.buildSystemPrompt() }];
    const recent = this.messages.slice(-8);
    for (const m of recent) {
      if (m.role === 'user') {
        historyMsgs.push({ role: 'user', content: m.content });
      } else if (m.role === 'assistant' && m.viaApi) {
        // 只送 API 产出的回复（去掉按钮标记，保留纯文本+代码）
        const cleaned = (m.content || '').replace(/\[\[BTN:[^\]]+\]\]/g, '').trim();
        if (cleaned) historyMsgs.push({ role: 'assistant', content: cleaned });
      }
    }

    this.abortController = new AbortController();
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${api.key}`
        },
        body: JSON.stringify({
          model: api.model,
          messages: historyMsgs,
          temperature: 0.4,
          stream: false
        }),
        signal: this.abortController.signal
      });

      if (!response.ok) {
        const errText = await response.text();
        const err = new Error(`HTTP ${response.status}: ${errText.substring(0, 200)}`);
        if (typeof window.fwTrackError === "function") window.fwTrackError(err);
        throw err;
      }

      const result = await response.json();
      // 上报 token 用量给悬浮窗
      if (result && result.usage && typeof window.fwTrackUsage === "function") {
        window.fwTrackUsage(result.usage, api.model);
      }
      const content = result.choices && result.choices[0] && result.choices[0].message
        ? result.choices[0].message.content.trim()
        : '';
      if (!content) {
        const err = new Error('API 返回空内容');
        if (typeof window.fwTrackError === "function") window.fwTrackError(err);
        throw err;
      }
      return content;
    } finally {
      this.abortController = null;
    }
  }

  // ===== 跳转动作执行 =====
  ,
  navigate: function(target) {
    if (!target || !this.validTargets[target]) {
      console.warn('[Assistant] invalid target:', target);
      return;
    }
    // 收起为悬浮小窗（而非完全关闭，方便用户继续追问）
    this.collapseToFloat();

    // 聊天内部 tab（不需要关闭 win-chat）
    const isChatInternal = target.startsWith('chat-');

    if (!isChatInternal) {
      // 导航到聊天外的页面 → 关闭 win-chat 让目标页面可见
      setTimeout(() => {
        if (typeof window.closeApp === 'function') {
          window.closeApp('chat');
        } else if (typeof closeApp === 'function') {
          closeApp('chat');
        }
      }, 50);
    }

    // 通用：打开桌面应用窗口
    const openWin = (appId) => {
      setTimeout(() => {
        if (typeof window.openApp === 'function') window.openApp(appId);
        else if (typeof openApp === 'function') openApp(appId);
      }, isChatInternal ? 0 : 150);
    };

    // 通用：进入设置二级面板
    const openSettings = (subTab) => {
      openWin('settings');
      setTimeout(() => {
        if (typeof window.openSettingsLv2 === 'function') window.openSettingsLv2(subTab);
        else if (typeof openSettingsLv2 === 'function') openSettingsLv2(subTab);
      }, isChatInternal ? 200 : 350);
    };

    // 通用：切换聊天底部 tab
    const switchChatTab = (tabName) => {
      openWin('chat');
      setTimeout(() => {
        const tab = document.querySelector('#win-chat .chat-tabs .tab-item[data-chat-tab="' + tabName + '"]');
        if (tab) tab.click();
      }, 200);
    };

    const navMap = {
      'settings': () => openWin('settings'),
      'settings-api': () => openSettings('api'),
      'settings-tts': () => openSettings('tts'),
      'settings-vector': () => openSettings('vector-memory'),
      'settings-imagegen': () => openSettings('imagegen'),
      'settings-desktop': () => openSettings('beautify'),
      'chat-sessions': () => switchChatTab('sessions'),
      'chat-me': () => switchChatTab('me'),
      'chat-moments': () => switchChatTab('moments'),
      'archive': () => openWin('archive'),
      'reader': () => openWin('reader'),
      'deeptalk': () => openWin('deeptalk'),
      'music': () => openWin('music'),
      'forum': () => openWin('forum'),
      'couples': () => openWin('couples'),
      'encounter': () => openWin('encounter'),
      'shopping': () => openWin('shopping'),
      'quicktravel': () => openWin('quicktravel'),
      'worldbook': () => openWin('world_book')
    };

    const fn = navMap[target];
    if (fn) {
      try { fn(); } catch(e) { console.warn('[Assistant] navigate failed:', e); }
    }
  }

  // ===== 执行命令（AI 输出 [[CMD:文字|命令名]] 触发）=====
  ,
  executeCommand: function(command) {
    const fn = this.commandMap[command];
    if (!fn) {
      console.warn('[Assistant] invalid command:', command);
      if (typeof showToast === 'function') showToast('未知的指令: ' + command);
      return;
    }
    // 收起为悬浮小窗
    this.collapseToFloat();
    // 关闭聊天窗口（命令通常会打开其他应用）
    setTimeout(() => {
      if (typeof window.closeApp === 'function') window.closeApp('chat');
      else if (typeof closeApp === 'function') closeApp('chat');
    }, 50);
    // 执行命令
    setTimeout(() => {
      try { fn(); } catch(e) { console.warn('[Assistant] command failed:', e); }
    }, 150);
  }

  // ===== 悬浮小窗：收起面板为小窗（保留完整对话，可在小窗内继续交流）=====
  ,
  collapseToFloat: function() {
    const panel = document.getElementById('assistant-panel');
    if (panel) panel.classList.remove('active');
    // 把对话渲染进小窗并显示
    this.renderMessages();
    const float = document.getElementById('assistant-float');
    if (float) float.classList.add('active');
    setTimeout(() => {
      const messages = document.getElementById('assistant-float-messages');
      if (messages) messages.scrollTop = messages.scrollHeight;
    }, 50);
  }

  // ===== 悬浮小窗：隐藏 =====
  ,
  hideFloat: function() {
    const float = document.getElementById('assistant-float');
    if (float) float.classList.remove('active');
  }

  // ===== 悬浮小窗：展开（关闭小窗，回到小助手原始全屏面板）=====
  ,
  expandFromFloat: function() {
    this.hideFloat();
    // assistant-panel 是 win-chat 的子元素，需先确保 win-chat 可见，
    // 否则在其他应用页面（如阅读）展开时，focus 会让 #desktop 自动滚动导致主页面上抬
    const chatWin = document.getElementById('win-chat');
    if (chatWin && !chatWin.classList.contains('active')) {
      if (typeof window.openApp === 'function') window.openApp('chat');
      else if (typeof openApp === 'function') openApp('chat');
    }
    this.openPanel();
  }

  // ===== 悬浮小窗：初始化拖拽 / 缩放 / 按钮事件（只绑定一次）=====
  ,
  floatInited: false,
  initFloat: function() {
    if (this.floatInited) return;
    const float = document.getElementById('assistant-float');
    const header = document.getElementById('assistant-float-header');
    const resizeHandle = document.getElementById('assistant-float-resize');
    const btnExpand = document.getElementById('assistant-float-expand');
    const btnClose = document.getElementById('assistant-float-close');
    if (!float || !header) return;
    this.floatInited = true;

    // 展开按钮：关闭小窗，回到小助手原始全屏面板
    if (btnExpand) btnExpand.addEventListener('click', (e) => { e.stopPropagation(); this.expandFromFloat(); });
    // 关闭按钮
    if (btnClose) btnClose.addEventListener('click', (e) => { e.stopPropagation(); this.hideFloat(); });

    // 全屏输入框：发送 + 回车
    const floatInput = document.getElementById('assistant-float-input');
    const floatSend = document.getElementById('assistant-float-send');
    if (floatSend) floatSend.addEventListener('click', (e) => { e.stopPropagation(); this.send(true); });
    if (floatInput) {
      floatInput.addEventListener('click', (e) => e.stopPropagation());
      floatInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this.send(true); }
      });
    }

    // ===== 拖拽（Pointer 事件，兼容触屏+鼠标）=====
    let dragStartX = 0, dragStartY = 0, floatStartX = 0, floatStartY = 0, dragging = false;
    header.addEventListener('pointerdown', (e) => {
      // 不拦截按钮点击
      if (e.target.closest('.assistant-float-btn')) return;
      dragging = true;
      const rect = float.getBoundingClientRect();
      const parentRect = float.offsetParent ? float.offsetParent.getBoundingClientRect() : { left: 0, top: 0 };
      dragStartX = e.clientX;
      dragStartY = e.clientY;
      // 当前相对位置
      floatStartX = rect.left - parentRect.left;
      floatStartY = rect.top - parentRect.top;
      float.classList.add('dragging');
      // 切换为 left/top 定位以便自由拖拽
      float.style.right = 'auto';
      float.style.bottom = 'auto';
      float.style.left = floatStartX + 'px';
      float.style.top = floatStartY + 'px';
      header.setPointerCapture(e.pointerId);
    });
    header.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - dragStartX;
      const dy = e.clientY - dragStartY;
      let newX = floatStartX + dx;
      let newY = floatStartY + dy;
      // 边界约束
      const parent = float.offsetParent;
      const maxX = parent ? parent.clientWidth - float.offsetWidth : window.innerWidth - float.offsetWidth;
      const maxY = parent ? parent.clientHeight - float.offsetHeight : window.innerHeight - float.offsetHeight;
      newX = Math.max(0, Math.min(newX, Math.max(0, maxX)));
      newY = Math.max(0, Math.min(newY, Math.max(0, maxY)));
      float.style.left = newX + 'px';
      float.style.top = newY + 'px';
    });
    const endDrag = (e) => {
      if (!dragging) return;
      dragging = false;
      float.classList.remove('dragging');
      try { header.releasePointerCapture(e.pointerId); } catch(err) {}
    };
    header.addEventListener('pointerup', endDrag);
    header.addEventListener('pointercancel', endDrag);

    // ===== 缩放（右下角句柄）=====
    let resizeStartX = 0, resizeStartY = 0, resizeStartW = 0, resizeStartH = 0, resizing = false;
    if (resizeHandle) {
      resizeHandle.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
        resizing = true;
        resizeStartX = e.clientX;
        resizeStartY = e.clientY;
        resizeStartW = float.offsetWidth;
        resizeStartH = float.offsetHeight;
        resizeHandle.setPointerCapture(e.pointerId);
      });
      resizeHandle.addEventListener('pointermove', (e) => {
        if (!resizing) return;
        const dx = e.clientX - resizeStartX;
        const dy = e.clientY - resizeStartY;
        const newW = Math.max(160, Math.min(resizeStartW + dx, window.innerWidth - 20));
        const newH = Math.max(180, Math.min(resizeStartH + dy, window.innerHeight - 20));
        float.style.width = newW + 'px';
        float.style.height = newH + 'px';
      });
      const endResize = (e) => {
        if (!resizing) return;
        resizing = false;
        try { resizeHandle.releasePointerCapture(e.pointerId); } catch(err) {}
      };
      resizeHandle.addEventListener('pointerup', endResize);
      resizeHandle.addEventListener('pointercancel', endResize);
    }
  }

  // ===== 打开/关闭面板 =====
  ,
  openPanel: function() {
    this.initFloat();
    const panel = document.getElementById('assistant-panel');
    if (!panel) return;
    panel.classList.add('active');
    this.renderMessages();
    setTimeout(() => {
      const input = document.getElementById('assistant-input');
      // preventScroll 防止浏览器为把聚焦元素拉入视口而自动滚动 #desktop（主页面上抬 bug 的根因）
      if (input) { try { input.focus({ preventScroll: true }); } catch(e) { input.focus(); } }
    }, 300);
  }

  ,
  closePanel: function() {
    const panel = document.getElementById('assistant-panel');
    if (panel) panel.classList.remove('active');
  }

  // ===== 发送消息（主入口：优先 API，回退关键词）=====
  ,
  send: async function(fromFloat) {
    // 兼容面板输入框与悬浮窗全屏输入框
    const input = fromFloat
      ? document.getElementById('assistant-float-input')
      : document.getElementById('assistant-input');
    if (!input) return;
    const text = input.value.trim();
    if (!text || this.isLoading) return;

    // 加入用户消息
    this.messages.push({ role: 'user', content: text });
    input.value = '';
    input.style.height = 'auto';

    // 显示 loading
    this.isLoading = true;
    this.renderMessages();

    let replyText = null;
    let viaApi = false;

    // 1. 尝试调用 API
    try {
      replyText = await this.callApi(text);
      if (replyText) viaApi = true;
    } catch(e) {
      console.warn('[Assistant] API call failed, falling back to keyword matching:', e.message);
      if (typeof window.fwTrackError === "function") window.fwTrackError(e);
    }

    // 2. API 不可用或失败 → 回退关键词匹配
    if (!replyText) {
      const fallback = this.matchQuery(text);
      replyText = fallback.answer;
      // 关键词回退时附加提示
      if (!viaApi) {
        replyText += '\n\n---\n> ⚠️ 当前未连接 API，以上为关键词匹配结果。配置对话 API 后我可提供更智能的回答。';
      }
    }

    // 加入助手回复
    this.messages.push({
      role: 'assistant',
      content: replyText,
      viaApi: viaApi
    });

    this.isLoading = false;
    this.renderMessages();
  }

  // ===== 渲染消息列表 =====
  ,
  renderMessages: function() {
    // 首次进入注入欢迎语
    if (this.messages.length === 0 && !this.isLoading) {
      this.messages.push({
        role: 'assistant',
        content: '## 你好，我是小助手\n\n我可以帮你：\n\n- **一键执行操作**（如"帮我建个角色""发条朋友圈"）\n- **快速跳转** 到应用内的任意功能页面\n- **查询功能位置**（比如"mcp 在哪？"）\n- **查看 / 修改 CSS 美化代码**\n\n跳转或执行操作时，我会收成小窗悬浮在角落，随时点开继续问。直接用自然语言提问即可，比如：\n- "帮我建立一个 char"\n- "在哪里能连 mcp？"\n- "帮我把聊天气泡改成圆角"',
        viaApi: false
      });
    }
    // 渲染到面板容器
    this._renderInto(document.getElementById('assistant-messages'));
    // 同步渲染到悬浮小窗容器（小窗常驻可见对话）
    this._renderInto(document.getElementById('assistant-float-messages'));
  }

  // 核心渲染：把消息列表渲染进指定容器
  ,
  _renderInto: function(container) {
    if (!container) return;
    container.innerHTML = '';

    for (const msg of this.messages) {
      const wrap = document.createElement('div');
      wrap.className = 'assistant-msg ' + (msg.role === 'user' ? 'assistant-msg-user' : 'assistant-msg-bot');

      if (msg.role === 'user') {
        wrap.innerHTML = '<div class="assistant-bubble-user">' + escapeHtml(msg.content) + '</div>';
      } else {
        const bubble = this.buildBotBubble(msg.content);
        wrap.appendChild(bubble);
      }

      container.appendChild(wrap);
    }

    // loading 气泡
    if (this.isLoading) {
      const loadingWrap = document.createElement('div');
      loadingWrap.className = 'assistant-msg assistant-msg-bot';
      loadingWrap.innerHTML = '<div class="assistant-bubble-bot assistant-bubble-loading"><span class="assistant-dot"></span><span class="assistant-dot"></span><span class="assistant-dot"></span></div>';
      container.appendChild(loadingWrap);
    }

    // 滚动到底
    container.scrollTop = container.scrollHeight;
  }

  // ===== 构建助手气泡（解析按钮/命令标记 + Markdown + 代码块复制）=====
  ,
  buildBotBubble: function(content) {
    const bubble = document.createElement('div');
    bubble.className = 'assistant-bubble-bot';

    let text = String(content || '');

    // 1. 提取跳转按钮 [[BTN:文字|target]]，用占位符替换
    const buttons = [];
    text = text.replace(/\[\[BTN:([^|\]]+)\|([^\]]+)\]\]/g, (m, label, target) => {
      const t = target.trim();
      if (this.validTargets[t]) {
        const idx = buttons.length;
        buttons.push({ label: label.trim(), target: t });
        return '\u0002BTN' + idx + '\u0002';
      }
      return ''; // 无效 target 直接移除
    });

    // 2. 提取命令按钮 [[CMD:文字|命令名]]，用占位符替换
    const commands = [];
    text = text.replace(/\[\[CMD:([^|\]]+)\|([^\]]+)\]\]/g, (m, label, cmd) => {
      const c = cmd.trim();
      if (this.commandMap[c]) {
        const idx = commands.length;
        commands.push({ label: label.trim(), command: c });
        return '\u0003CMD' + idx + '\u0003';
      }
      return ''; // 无效命令直接移除
    });

    // 3. Markdown 渲染
    bubble.innerHTML = this.renderMarkdown(text);

    // 4. 代码块加复制按钮
    const codeBlocks = bubble.querySelectorAll('pre code');
    codeBlocks.forEach((block) => {
      const pre = block.parentElement;
      pre.classList.add('assistant-code-block');
      const btn = document.createElement('button');
      btn.className = 'assistant-copy-btn';
      btn.innerText = '复制';
      btn.onclick = () => {
        const code = block.innerText;
        if (navigator.clipboard) {
          navigator.clipboard.writeText(code).then(() => {
            btn.innerText = '已复制';
            setTimeout(() => { btn.innerText = '复制'; }, 1500);
          });
        } else {
          const ta = document.createElement('textarea');
          ta.value = code; document.body.appendChild(ta);
          ta.select(); document.execCommand('copy');
          document.body.removeChild(ta);
          btn.innerText = '已复制';
          setTimeout(() => { btn.innerText = '复制'; }, 1500);
        }
      };
      pre.appendChild(btn);
    });

    // 5. 还原占位符为真实按钮
    const hasActions = buttons.length > 0 || commands.length > 0;
    if (hasActions) {
      const actionsWrap = document.createElement('div');
      actionsWrap.className = 'assistant-actions';

      // 跳转按钮（紫色）
      for (let i = 0; i < buttons.length; i++) {
        const b = buttons[i];
        const btn = document.createElement('button');
        btn.className = 'assistant-action-btn';
        btn.innerText = b.label;
        btn.onclick = () => this.navigate(b.target);
        actionsWrap.appendChild(btn);

        // 移除占位符文本节点
        const walker = document.createTreeWalker(bubble, NodeFilter.SHOW_TEXT, null, null);
        while (walker.nextNode()) {
          const node = walker.currentNode;
          if (node.nodeValue.indexOf('\u0002BTN' + i + '\u0002') >= 0) {
            node.nodeValue = node.nodeValue.replace('\u0002BTN' + i + '\u0002', '');
          }
        }
      }

      // 命令按钮（绿色，区别于跳转）
      for (let i = 0; i < commands.length; i++) {
        const c = commands[i];
        const btn = document.createElement('button');
        btn.className = 'assistant-action-btn assistant-cmd-btn';
        btn.innerText = c.label;
        btn.onclick = () => this.executeCommand(c.command);
        actionsWrap.appendChild(btn);

        // 移除占位符文本节点
        const walker = document.createTreeWalker(bubble, NodeFilter.SHOW_TEXT, null, null);
        while (walker.nextNode()) {
          const node = walker.currentNode;
          if (node.nodeValue.indexOf('\u0003CMD' + i + '\u0003') >= 0) {
            node.nodeValue = node.nodeValue.replace('\u0003CMD' + i + '\u0003', '');
          }
        }
      }

      bubble.appendChild(actionsWrap);
    }

    return bubble;
  }

  // ===== 简易 Markdown 渲染 =====
  ,
  renderMarkdown: function(md) {
    if (!md) return '';
    let html = String(md);

    const codeStash = [];
    const stashCode = (code, lang) => {
      const idx = codeStash.length;
      codeStash.push({ code, lang });
      return '\u0001CODE' + idx + '\u0001';
    };

    html = html.replace(/```(\w*)\n?([\s\S]*?)```/g, (m, lang, code) => {
      return stashCode(code.replace(/\n$/, ''), lang);
    });

    const inlineStash = [];
    html = html.replace(/`([^`\n]+)`/g, (m, code) => {
      const idx = inlineStash.length;
      inlineStash.push(code);
      return '\u0001INLINE' + idx + '\u0001';
    });

    html = escapeHtml(html);

    html = html.replace(/\u0001INLINE(\d+)\u0001/g, (m, idx) => {
      return '<code class="assistant-inline-code">' + escapeHtml(inlineStash[parseInt(idx)]) + '</code>';
    });

    html = html.replace(/^######\s+(.+)$/gm, '<h6>$1</h6>');
    html = html.replace(/^#####\s+(.+)$/gm, '<h5>$1</h5>');
    html = html.replace(/^####\s+(.+)$/gm, '<h4>$1</h4>');
    html = html.replace(/^###\s+(.+)$/gm, '<h3>$1</h3>');
    html = html.replace(/^##\s+(.+)$/gm, '<h2>$1</h2>');
    html = html.replace(/^#\s+(.+)$/gm, '<h1>$1</h1>');

    html = html.replace(/^&gt;\s?(.+)$/gm, '<blockquote>$1</blockquote>');

    html = html.replace(/^[\-\*]\s+(.+)$/gm, '<li>$1</li>');
    html = html.replace(/(<li>[\s\S]*?<\/li>)(?!\s*<li>)/g, '<ul>$1</ul>');

    html = html.replace(/^\d+\.\s+(.+)$/gm, '<li>$1</li>');

    html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/(^|[^\*])\*([^\*\n]+)\*([^\*]|$)/g, '$1<em>$2</em>$3');

    html = html.replace(/\n\n/g, '</p><p>');
    html = html.replace(/\n/g, '<br>');

    html = html.replace(/<\/p><p>(<li>)/g, '$1');
    html = html.replace(/(<\/li>)<\/p><p>(<li>)/g, '$1$2');
    html = html.replace(/(<\/ul>)<\/p><p>/g, '$1');
    html = html.replace(/<\/p><p>(<ul>)/g, '$1');
    html = html.replace(/<\/p><p>(<blockquote>)/g, '$1');
    html = html.replace(/(<\/blockquote>)<\/p><p>/g, '$1');

    html = '<p>' + html + '</p>';
    html = html.replace(/<p>\s*<\/p>/g, '');

    html = html.replace(/\u0001CODE(\d+)\u0001/g, (m, idx) => {
      const item = codeStash[parseInt(idx)];
      const langClass = item.lang ? ' class="language-' + escapeHtml(item.lang) + '"' : '';
      return '<pre><code' + langClass + '>' + escapeHtml(item.code) + '</code></pre>';
    });

    html = html.replace(/<p>(<pre>)/g, '$1');
    html = html.replace(/(<\/pre>)<\/p>/g, '$1');

    return html;
  }

  // ===== 关键词匹配（API 回退用）=====
  ,
  matchQuery: function(query) {
    const q = (query || '').trim();
    if (!q) return { answer: '请输入问题。', actions: [] };

    const ql = q.toLowerCase();

    // 建立角色/用户/npc（命令）
    if (ql.includes('建') && (ql.includes('角色') || ql.includes('char'))) {
      return {
        answer: '## 新建角色\n\n我来帮你打开档案馆的新建角色表单，填写姓名/母语/人设/外貌/锁脸后保存即可。\n\n[[CMD:新建角色|create_char]]',
        actions: []
      };
    }
    if (ql.includes('建') && ql.includes('用户')) {
      return {
        answer: '## 新建用户面具\n\n我来帮你打开档案馆的新建用户表单。user 面具建好后，可在「聊天-我的」里全局应用。\n\n[[CMD:新建用户|create_user]]',
        actions: []
      };
    }
    if (ql.includes('建') && ql.includes('npc')) {
      return {
        answer: '## 新建 NPC\n\nNPC 需要挂载到角色或用户上。我来帮你打开新建 NPC 表单。\n\n[[CMD:新建NPC|create_npc]]',
        actions: []
      };
    }
    if (ql.includes('发') && (ql.includes('朋友圈') || ql.includes('动态'))) {
      return {
        answer: '## 发朋友圈\n\n我来帮你打开发布朋友圈的窗口。\n\n[[CMD:发朋友圈|create_moments_post]]',
        actions: []
      };
    }
    if (ql.includes('发帖') || (ql.includes('论坛') && ql.includes('发'))) {
      return {
        answer: '## 论坛发帖\n\n我来帮你打开论坛发帖页面。\n\n[[CMD:去发帖|create_forum_post]]',
        actions: []
      };
    }
    if (ql.includes('新建会话') || ql.includes('新建聊天') || (ql.includes('建') && ql.includes('会话'))) {
      return {
        answer: '## 新建聊天会话\n\n我来帮你打开新建会话面板，可选择单聊或群聊。\n\n[[CMD:新建会话|new_chat]]',
        actions: []
      };
    }
    if (ql.includes('世界书') && (ql.includes('建') || ql.includes('新建') || ql.includes('添加'))) {
      return {
        answer: '## 新建世界书条目\n\n我来帮你打开世界书的新建条目表单。\n\n[[CMD:新建世界书|create_worldbook]]',
        actions: []
      };
    }

    // MCP 专门回答
    if (ql.includes('mcp') || ql.includes('连mcp') || ql.includes('放歌') || ql.includes('闹钟') || ql.includes('天气')) {
      return {
        answer: '## MCP 中枢位置\n\n**聊天 → 对话 → 加号展开栏 → MCP 中枢**\n\nMCP 可接入的设备传感器数据：\n\n- 物理坐标 / 城市\n- 外部实时气温 / 天气\n- 本地歌单（可让 char 主动放歌）\n- 自主设闹钟（char 可根据语境主动提醒）',
        actions: []
      };
    }

    // API 设置
    if (ql.includes('api') && (ql.includes('在哪') || ql.includes('设置') || ql.includes('配置'))) {
      return {
        answer: '## API 设置位置\n\n所有 API 都在 **设置** 里面：对话 API / TTS API / 向量记忆 API / 生图 API',
        actions: [{ label: '前往 API 设置', target: 'settings-api' }]
      };
    }

    // 状态栏
    if (ql.includes('状态栏') || ql.includes('好感度') || ql.includes('线下美化')) {
      return {
        answer: '## 状态栏美化（线下）\n\n**位置**：聊天 → 对话 → 右上角详情 → 思维链 → **线下美化正则**\n\n内置状态栏规则会渲染 AI 输出的 `[STATUS_BAR]` 标记为可视化状态栏卡片。',
        actions: []
      };
    }

    // 注册
    if (ql.includes('注册') || ql.includes('登录')) {
      return {
        answer: '## 注册新账户\n\n1. 使用本群内的 **QQ 邮箱**\n2. 自己设置密码\n3. 第一次注册点击 **注册新账户**\n4. 如有报错带图来找 @雨中见',
        actions: []
      };
    }

    // 思维链
    if (ql.includes('思维链') || ql.includes('cot')) {
      return {
        answer: '## 思维链（CoT）\n\n**位置**：聊天 → 对话 → 加号展开栏 → 思维链',
        actions: []
      };
    }

    // 兜底
    return {
      answer: '抱歉，我没能理解 **"' + escapeHtml(q) + '"**。\n\n你可以试试：\n- "mcp 在哪？"\n- "api 怎么设置？"\n- "状态栏怎么开？"\n- "怎么注册？"\n\n或者描述你想要的 CSS 美化效果。',
      actions: []
    };
  }

  // ===== 输入框自适应高度 =====
  ,
  autoResize: function() {
    const input = document.getElementById('assistant-input');
    if (!input) return;
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 100) + 'px';
  }

  // ===== 键盘事件 =====
  ,
  onKeydown: function(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      this.send();
    }
  }

  // ===== 清空对话 =====
  ,
  clearHistory: function() {
    if (typeof showCustomConfirm === 'function') {
      showCustomConfirm('清空对话', '确定清空与小助手的所有对话记录吗？', () => {
        if (this.abortController) {
          try { this.abortController.abort(); } catch(e) {}
        }
        this.messages = [];
        this.isLoading = false;
        this.hideFloat();
        this.renderMessages();
        showToast && showToast('已清空小助手对话');
      });
    } else {
      if (confirm('确定清空与小助手的所有对话记录吗？')) {
        this.messages = [];
        this.isLoading = false;
        this.hideFloat();
        this.renderMessages();
      }
    }
  }
};

// 暴露到全局
window.AppAssistant = AppAssistant;
