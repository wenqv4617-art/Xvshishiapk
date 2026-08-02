/**
 * app_changelog.js - 面向用户的更新日志
 * 专供用户查看每次更新的内容，使用通俗语言描述新增功能、修复的问题和改善的体验。
 */

const CHANGELOG_DATA = [
  {
    version: "v2.5",
    date: "2026-08-02",
    title: "闹钟输入升级与更新日志上线",
    features: [
      "闹钟设置改成「时 / 分 / 秒」三个输入框，不用再换算成总秒数，想设几小时几分几秒直接填",
      "设置页新增「更新日志」入口，随时查看每次更新了什么功能、修了什么问题"
    ],
    improvements: [
      "更新日志从更早的版本开始记录，补齐了之前没同步的更新内容"
    ]
  },
  {
    version: "v2.4",
    date: "2026-08-02",
    title: "AI 闹钟、音乐中枢与通知升级",
    features: [
      "AI 现在可以自主给你设定闹钟了——跟它说「半小时后叫我」或「明早 8 点喊我起床」，它就会帮你设好闹钟，还会在聊天里告诉你设了多久",
      "闹钟铃声支持自定义：可以从本地音乐或听歌乐库里选一首歌当闹钟铃声，不再只有系统默认提示音",
      "闹钟支持按分钟、小时设置，不用再换算成秒数（比如「2 小时」「30 分钟」都能直接设）",
      "听歌乐库里的歌单和歌曲现在会同步到 MCP 中枢，AI 放歌时可以从乐库里挑",
      "MCP 音乐列表改成手风琴分类样式，本地歌曲和乐库歌单分开折叠显示，更清晰好看",
      "MCP 闹钟模块新增倒计时显示：设了闹钟后会实时显示还剩多久响铃，还能一键取消"
    ],
    fixes: [
      "修复了 AI 放歌指令有时显示在聊天气泡里的问题，现在指令会被自动隐藏",
      "修复了 AI 设闹钟失败的问题（之前提示词格式导致 AI 生成了错误的指令）",
      "修复了听歌乐库歌单没有同步到 MCP 中枢的问题",
      "修复了 MCP 歌曲列表条目高度为 0、显示不全的问题"
    ],
    improvements: [
      "通知改成跟微信、QQ 一样的弹出式卡片，会从屏幕顶端弹出来，带振动和声音，不再静默",
      "AI 主动发消息时现在能看到之前聊了什么、隔了多久，不会再重复回复你上一句话",
      "AI 主动发消息时也可以放歌、设闹钟了，而且指令不会显示在气泡里",
      "闹钟到点时如果设了自定义铃声，会自动播放你选的那首歌"
    ]
  },
  {
    version: "v2.3",
    date: "2026-08-01",
    title: "语音视频通话、TTS 与听歌陪听",
    features: [
      "新增语音通话和视频通话功能：可以和 AI 角色打电话，通话中还能继续打字聊天",
      "AI 可以主动给你打电话（需要在对话设置里开启）",
      "通话记录会显示成系统消息卡片，可以点开看记录、反复播放通话语音",
      "TTS 语音合成支持 MiniMax 国内版和国际版切换，还能自定义接口地址",
      "听歌功能升级：搜索歌曲改成三通道容错，更稳定；搜索结果可以一键导入到歌单",
      "AI 陪听功能：歌单内点歌后播放范围限定在该歌单内，支持顺序/循环/随机",
      "AI 可以拖动进度条、切歌，并生成系统消息反馈（如「拖动到 0:30」「切歌到《xxx》」）"
    ],
    improvements: [
      "全局图标从 emoji 改成 SVG 图标，更清爽统一",
      "思维链识别增强：残缺的思维链标签会自动补全，不再频繁报错",
      "桌面美化设置新增「听歌」应用图标自定义"
    ]
  },
  {
    version: "v2.2",
    date: "2026-07-18",
    title: "系统级多媒体控制与账号安全",
    features: [
      "音乐播放接入 Android 系统级多媒体控制：锁屏和状态栏可以直接拖进度条、暂停、播放，跟主流音乐软件一样",
      "新增账号安全系统：支持邮箱密码登录，每个账号最多同时登录 2 台设备",
      "新设备登录会自动挤掉最旧的设备，被挤下线时会立即收到提醒",
      "注册需要激活码（邀请码），从底层防止越权注册",
      "设置页新增「账号安全管理」入口，可以查看在线设备、主动退登"
    ],
    fixes: [
      "修复了登录界面看不到弹窗提示的问题（弹窗层级调整到登录层之上）"
    ]
  },
  {
    version: "v2.1",
    date: "2026-07-17",
    title: "社交论坛与私信多媒体升级",
    features: [
      "论坛私信完全重做：仿照推特 DM 样式，支持发送语音、图片、转账消息",
      "双击私信气泡可以编辑、删除、重新生成（Reroll）、多选管理",
      "Reroll 会自动回溯到上一条你的消息，重新生成后续对话，实现真正的时空线回溯",
      "论坛点赞状态真实保存到数据库，红心对齐显示",
      "Timeline 反向隔离：不同账户的 NPC 帖子互相隔离，公共路人帖子共享",
      "原生端新增流式分片写入：大文件备份不再崩溃（支持 40MB 级别导出）",
      "PWA 网页端支持 ZIP 压缩包下载和智能还原导入（压缩率 90% 以上）"
    ],
    fixes: [
      "修复了私信最后一条显示成自己发的 Bug（ID 碰撞导致身份篡改）",
      "修复了论坛侧边栏打不开、全局变量报错的问题",
      "修复了发帖、刷新、发送消息时的白屏闪动",
      "修复了私信底部气泡被输入栏遮挡的问题"
    ],
    improvements: [
      "论坛 NPC 引入基于当前账户隔离，自动关注",
      "趋势页支持防自动刷新缓存，支持提现论坛背景资料"
    ]
  },
  {
    version: "v2.0",
    date: "2026-07-16",
    title: "专注中枢、伴读书城与查手机重构",
    features: [
      "新增「专注中枢」：旋转转盘设定时长，搭配白噪音和人物陪伴，营造心流体验",
      "专注时可以上传自定义背景图片，支持切屏挂起和「戳一戳」人物反馈",
      "新增「伴读书城」：可以导入本地 TXT 小说，或让 AI 根据双方人设定制生成小说",
      "双击书籍段落可以触发 AI 角色跨时空点评，产生情感共鸣",
      "「查手机」功能深度重构：数据持久化保存，不再每次重开重置",
      "查手机新增家电控制（可自定义家电）、浏览器搜索生成",
      "查手机桌面新增毛玻璃日历时间与设备状态小组件"
    ],
    fixes: [
      "修复了本地 TXT 导入 GBK 编码乱码崩溃的问题（自动识别编码并切换）",
      "修复了专注面板被聊天层遮挡、点击穿透的问题",
      "修复了上传图片时配置损坏变成 [object Object] 的问题",
      "修复了转盘手势在 180° 边界数值突跳的问题",
      "修复了家电控制触发异常报错的问题"
    ],
    improvements: [
      "查手机 API 生成内容与线上聊天格式完全隔离，不再混淆",
      "查手机数据接入备份/导入/格式化/容量统计"
    ]
  },
  {
    version: "v1.9",
    date: "2026-07-14",
    title: "桌宠系统与后台主动发信",
    features: [
      "全新桌宠系统：支持 9 种动作状态（默认/开心/难过/生气/犹豫/洗漱/吃饭/睡觉/观看），每种都可单独上传图片",
      "桌宠支持加权随机自定义台词，也可以调用大模型生成状态跳转",
      "每个角色的桌宠配置完全隔离，切换角色不互相影响",
      "即使退出 App 或锁屏，活跃桌宠也会持续浮现在手机桌面",
      "新增后台主动发信：AI 会按设定间隔主动给你发消息，各角色间隔独立",
      "双击桌宠直接在后台触发交互，App 不弹出打扰"
    ],
    fixes: [
      "修复了 App 内网页桌宠和原生悬浮窗视觉重叠的问题",
      "修复了拖拽桌宠时误触发点击的问题（位移差小于 15px 才算点击）"
    ],
    improvements: [
      "主动发信调度全面收拢到前端 JS，发信时能调取 RAG 记忆和世界书，消息质量大幅提升",
      "数据库升级至 V11，新增 desktop_pets 表"
    ]
  },
  {
    version: "v1.8",
    date: "2026-07-13",
    title: "微信社交拟真体验",
    features: [
      "聊天新增智能时间戳：关闭时间感知时按设定时间 1:1 流逝，开启时跟随真实时钟",
      "新增 2 分钟限时撤回（含 AI 撤回），撤回消息可点击查看原文",
      "新增长按 Emoji 表情反应：长按气泡 2 秒呼出表情面板，可贴可删",
      "AI 可以智能响应你的表情反应",
      "朋友圈评论支持长按删除（高亮+垃圾桶）",
      "朋友圈转发修复，支持同分组角色自发社交反应",
      "钱包余额和账单根据当前人设随动切换，不同面具财务隔离"
    ],
    fixes: [
      "修复了单双击事件冲突（朋友圈转发与双击菜单）",
      "修复了气泡二次折叠换行的问题",
      "修复了表情选择器横向滑动与左滑引用的冲突"
    ],
    improvements: [
      "全面移除原生 alert/confirm/prompt，改用自研毛玻璃 Toast 和卡片 Dialog",
      "发送消息时不退焦，支持回车上屏（可在美化设置开启）",
      "新增请求中断网关：模型卡住时可以点击停止按钮中断",
      "长按动效改成两阶段弹性回弹，反馈更生动"
    ]
  },
  {
    version: "v1.7",
    date: "2026-07-13",
    title: "情侣空间、聊天搜索与美化",
    features: [
      "新增「情侣空间」：可以和 AI 角色绑定情侣关系，设置纪念日程和愿望清单",
      "情侣空间的日程和愿望会自动注入 AI 上下文，AI 会自然提及并关心",
      "新增微信/QQ 风格聊天记录搜索：支持按人设隔离，关键词高亮，点击跳转定位",
      "新增聊天个性化美化：可调整气泡圆角、头像圆角、颜色、挂件等，支持左右镜像对称",
      "美化支持实时预览，拖动滑块时真实聊天气泡同步变化",
      "新增微信消息引用功能：可以引用某条消息回复，AI 也会使用引用",
      "档案头像上传自动压缩（2.5MB → 12KB），壁纸上传自动压缩（5.2MB → 140KB）",
      "世界书导入支持 TXT 双编码自愈（UTF-8/GBK 自动切换）和 Word 文档解析"
    ],
    fixes: [
      "修复了壁纸体积过大导致 LocalStorage 5MB 爆仓崩溃的问题",
      "修复了 AI 引用消息时复读原文的穿帮 Bug",
      "修复了红包转账气泡上表情贴纸被裁切的问题",
      "修复了心声里 User 占位符没有替换成真实名字的问题"
    ],
    improvements: [
      "美化样式编译器纯净隔离，不再影响系统爱心、通知灰字等基础元素",
      "搜索结果按时间由远及近排列，点击跳转后高亮闪烁定位"
    ]
  }
];

window.changelogSystem = {
  /**
   * 渲染更新日志到指定容器
   */
  renderChangelog: function(containerId) {
    const container = document.getElementById(containerId);
    if (!container) return;

    let html = '';
    CHANGELOG_DATA.forEach((entry, idx) => {
      const isLatest = idx === 0;
      const badge = isLatest
        ? '<span style="display:inline-block; padding:2px 8px; font-size:10px; font-weight:700; color:#fff; background:linear-gradient(135deg,#6366f1,#8b5cf6); border-radius:10px; margin-left:8px; vertical-align:middle;">最新</span>'
        : '';

      html += `<div style="background:#fff; border:1.5px solid var(--border); border-radius:14px; padding:16px; margin-bottom:14px; ${isLatest ? 'border-color:#6366f1; box-shadow:0 2px 12px rgba(99,102,241,0.12);' : ''}">`;

      // 版本头
      html += `<div style="display:flex; align-items:center; flex-wrap:wrap; gap:4px; margin-bottom:12px; padding-bottom:10px; border-bottom:1px dashed var(--border);">`;
      html += `<span style="font-size:16px; font-weight:800; color:var(--text-primary);">${entry.version}</span>`;
      html += `<span style="font-size:12px; color:var(--text-secondary); margin-left:2px;">${entry.date}</span>`;
      html += badge;
      html += `<span style="font-size:13px; color:var(--text-primary); font-weight:600; margin-left:8px;">${entry.title}</span>`;
      html += `</div>`;

      // 新功能
      if (entry.features && entry.features.length > 0) {
        html += `<div style="margin-bottom:12px;">`;
        html += `<div style="font-size:12px; font-weight:700; color:#16a34a; margin-bottom:6px; display:flex; align-items:center; gap:4px;">`;
        html += `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v20M2 12h20" opacity="0"/><path d="M9 12l2 2 4-4"/><circle cx="12" cy="12" r="10"/></svg>`;
        html += `新增功能</div>`;
        html += `<ul style="margin:0; padding-left:18px; list-style:disc;">`;
        entry.features.forEach(f => {
          html += `<li style="font-size:12px; color:var(--text-primary); line-height:1.7; margin-bottom:3px;">${f}</li>`;
        });
        html += `</ul></div>`;
      }

      // 问题修复
      if (entry.fixes && entry.fixes.length > 0) {
        html += `<div style="margin-bottom:12px;">`;
        html += `<div style="font-size:12px; font-weight:700; color:#dc2626; margin-bottom:6px; display:flex; align-items:center; gap:4px;">`;
        html += `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>`;
        html += `问题修复</div>`;
        html += `<ul style="margin:0; padding-left:18px; list-style:disc;">`;
        entry.fixes.forEach(f => {
          html += `<li style="font-size:12px; color:var(--text-primary); line-height:1.7; margin-bottom:3px;">${f}</li>`;
        });
        html += `</ul></div>`;
      }

      // 体验优化
      if (entry.improvements && entry.improvements.length > 0) {
        html += `<div style="margin-bottom:0;">`;
        html += `<div style="font-size:12px; font-weight:700; color:#2563eb; margin-bottom:6px; display:flex; align-items:center; gap:4px;">`;
        html += `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>`;
        html += `体验优化</div>`;
        html += `<ul style="margin:0; padding-left:18px; list-style:disc;">`;
        entry.improvements.forEach(f => {
          html += `<li style="font-size:12px; color:var(--text-primary); line-height:1.7; margin-bottom:3px;">${f}</li>`;
        });
        html += `</ul></div>`;
      }

      html += `</div>`;
    });

    // 底部说明
    html += `<div style="text-align:center; padding:16px 0 8px; font-size:11px; color:var(--text-secondary);">`;
    html += `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="vertical-align:middle; margin-right:4px; opacity:0.5;"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg>`;
    html += `感谢使用叙事诗小手机，我们会持续迭代优化体验`;
    html += `</div>`;

    container.innerHTML = html;
  },

  /**
   * 初始化更新日志面板（由 openSettingsLv2 调用）
   */
  initChangelogPanel: function() {
    this.renderChangelog("changelog-content");
  }
};
