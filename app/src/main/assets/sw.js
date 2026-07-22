const CACHE_NAME = 'story-phone-v20'; // 离线 PWA 升级至 v20 引入情侣空间桌面主应用

// 包含所有平铺引用的功能文件和图标（强制更新 Cache-Key 迫使浏览器重新拉取并应用）
const ASSETS = [
  './index.html',
  './manifest.json',
  './style.css',
  './app.css',
  './chat.css',
  './db.js',
  './app_prompts.js',
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
  './app_desktop_pet.js',
  './app_reader.js',
  './app_chat_focus.js',
  './app_chat_check_phone.js',
  './app_chat_search.js',
  './app_chat_beautify.js',
  './app_auth.js',
  './app_chat_couples.js',
  './couples.css',
  './check_phone.css',
  './forum.css',             // 论坛主题样式表 (新加入)
  './app_forum_loader.js',   // 论坛层栈管理器 (新加入)
  './app_forum_posts.js',    // 论坛帖子与互动机制 (新加入)
  './app_forum_messages.js', // 论坛私信机制 (新加入)
  './icon-144.png',
  './icon-512.png',
  'https://unpkg.com/dexie@4.0.1/dist/dexie.js'
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