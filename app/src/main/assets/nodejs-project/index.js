/**
 * index.js - 内置网易云音乐 API 启动器
 *
 * 运行环境：nodejs-mobile（Node.js 运行时内嵌在 APK 内，与 App 同进程）
 * 作用：启动 NeteaseCloudMusicApi，监听 127.0.0.1:3000，
 *       WebView 内的前端代码直接通过 http://localhost:3000 调用，
 *       无需外部服务、无需 Termux、无需局域网 IP。
 *
 * 注意：此文件由 app_chat_mcp.js / app_music.js 的 ncmApiBase
 *       （默认 http://localhost:3000）直接对接，无需额外配置。
 */

// 监听端口与地址（App 内 WebView 通过 localhost 访问）
process.env.PORT = process.env.PORT || '3000';
process.env.HOST = process.env.HOST || '127.0.0.1';

// 静默启动：不打印 Logo，保持后台干净
process.env.NCM_NO_LOG = process.env.NCM_NO_LOG || 'true';

try {
  // 加载 NeteaseCloudMusicApi（走 package.json 的 main 入口，自动 listen）
  require('NeteaseCloudMusicApi');
  console.log('[NCM-Embedded] 网易云音乐 API 已内置启动: http://' + process.env.HOST + ':' + process.env.PORT);
} catch (e) {
  console.error('[NCM-Embedded] 启动失败: ' + (e && e.message ? e.message : e));
}
