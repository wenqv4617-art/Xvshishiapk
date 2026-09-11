const CACHE_NAME = 'story-phone-v115'; // v115: 热区涂抹编辑器（缩放/画笔/橡皮擦/撤销，14 个部位可留空）+ 涂抹结果真正参与看板命中; v1.5.37

// 包含所有平铺引用的功能文件和图标（强制更新 Cache-Key 迫使浏览器重新拉取并应用）
const ASSETS = [
  './index.html',
  './manifest.json',
  './app_splash.js',      // 开屏启动动画（通用路径 SVG + 进度条，无 emoji）
  './app_api_routes.js',  // 专用 API 路由（按功能指定预设）
  './app_chat_reverse_check.js', // 反查手机（角色偷看 user 手机）
  './style.css',
  './app.css',
  './chat.css',
  './group.css',          // 群聊专属样式（公告条/投票卡/机器人卡/成员卡/自绘弹层）
  './sticker.css',
  './app_quicktravel.js',
  './app_ritual.js',      // 仪轨（日程/穿着/随身物品/位置 四维状态）
  './app_heartgame.js',   // 心动游戏主界面看板 + 生命周期（玩法本体入口）
  './app_heartgame_core.js',      // 心动游戏内核：状态中枢 K + 自绘 UI 组件库 H
  './app_heartgame_portraits.js', // 立绘/背景/热区涂抹/后台管理
  './app_heartgame_gacha.js',     // 抽卡工坊 + 锁脸生图 + 钱包
  './app_heartgame_story.js',     // 主线 VN + 分支树 + 剧情小手机
  './app_heartgame_quiet.js',     // 静室 + 赠礼 + 双轨 Prompt 注入
  './app_heartgame_panels.js',    // 任务 / 商店 / 牵绊
  './app_workbench.js',   // 工作台 Agent（多对话 + 本地工作区 + GitHub）
  './app_workbench_agent.js', // 工作台 Agent 引擎（Skill/Agent 配置 + MCP http+sse + @引用 + 成熟模式渲染）
  './workbench.css',      // 工作台样式
  './db.js',
  './app_prompts.js',
  './app_context_manager.js', // 上下文管理中枢（结构化 Prompt 可见/可开关/可排序）
  './app_world_book_engine.js', // 世界书激活引擎（对标酒馆 World Info）
  './app_chat_share_log.js', // 多选分享聊天记录（打包 → 转发到同面具其它会话）
  './app_desktop.js',
  './app_settings.js',
  './app_archive.js',
  './app_world_book.js',
  './app_chat.js',
  './app_wallet.js',
  './app_chat_quote.js',
  './app_summary_memory.js',
  './deeptalk.css',          // 深谈样式
  './app_deeptalk.js',       // 深谈逻辑
  './chat_html.css',         // HTML 互动舱样式
  './app_chat_html_widget.js',// HTML 互动舱逻辑
  './app_chat_plot_engine.js',// 剧情引擎逻辑
  './app_chat_mcp.js',
  './app_mcp_client.js',     // MCP 客户端逻辑 (新加入)
  './app_chat_cot.js',       // 思维链 CoT 逻辑 (新加入)
  './app_desktop_pet.js',
  './app_reader.js',
  './app_chat_focus.js',
  './app_chat_check_phone.js',
  './app_chat_search.js',
  './app_chat_beautify.js',
  './app_auth.js',
  './app_miniprogram.js',          // 小程序系统核心（链接安装/应用商店/权限模型/MCP 安全桥）
  './app_miniprogram_workshop.js', // 小程序工坊（链接安装/应用商店 UI）
  './app_miniprogram.css',         // 小程序系统样式
  './app_chat_couples.js',
  './couples.css',
  './check_phone.css',
  './forum.css',             // 论坛主题样式表 (新加入)
  './app_forum_loader.js',   // 论坛层栈管理器 (新加入)
  './app_forum_posts.js',    // 论坛帖子与互动机制 (新加入)
  './app_forum_messages.js', // 论坛私信机制 (新加入)
  './music.css',             // 听歌网易云样式表 (新加入)
  './app_music.js',          // 听歌与陪听中枢逻辑 (新加入)
  './images/wallpaper_summer.jpg',
  './images/widget_top_photo.jpg',
  './images/widget_polaroid_photo.jpg',
  './images/avatar_char1.jpg',
  './images/avatar_char2.jpg',
  // 心动游戏 · 生成式插画素材（立绘 / 场景 / 卡池主视觉；缺失时自动回落纯 CSS）
  // 注：UI 装饰（按钮玻璃底 / 面板底 / 弹窗底）一律改为纯 CSS + 内联 SVG，不再用生成图 ——
  //     玻璃元件自身是白的，白底图非抠即留边，CSS 在浅色底上反而更干净且不占体积。
  './images/heartgame/gacha/entry.png',
  './images/heartgame/gacha/banner.png',
  './images/heartgame/portrait/default.png',
  './images/heartgame/stage/bg-night.png',
  './images/heartgame/stage/bg-rain.png',
  './images/heartgame/stage/bg-dusk.png',
  './icon-144.png',
  './icon-512.png',
  'https://unpkg.com/dexie@4.0.1/dist/dexie.js',
  'https://unpkg.com/jszip@3.10.1/dist/jszip.min.js'
];

// 安装阶段：预缓存所有资源
self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS);
    }).then(() => self.skipWaiting())
  );
});

// 激活阶段：清理旧版本的缓存
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

// 请求拦截：优先使用缓存，若无则发起网络请求
self.addEventListener('fetch', (e) => {
  // 排除对外部 API 请求的拦截，仅缓存本地应用静态资源
  if (e.request.url.startsWith('http') && !e.request.url.includes('unpkg.com')) {
    return;
  }

  e.respondWith(
    caches.match(e.request).then((cachedResponse) => {
      return cachedResponse || fetch(e.request);
    })
  );
});

// 通知点击：聚焦已打开的页面，否则打开 index.html
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow('./index.html');
    })
  );
});