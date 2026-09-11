/**
 * app_heartgame.js - 心动游戏（主界面入口 · v1.5.21 新增）
 *
 * 现状：本文件目前只负责**入口的落地**——桌面图标、路由页面、占位页面、关闭按钮。
 *       「心动游戏」的具体玩法（小游戏本体、与角色的互动机制、结算与记忆回写）
 *       留待后续窗口实装，届时从 initHeartGameApp() 内部展开即可。
 *
 * 设计约束（与本项目其它应用一致）：
 *   · 纯经典脚本，无模块 / 无构建；顶层函数即为全局函数
 *   · 无 emoji 图标，一律内联 SVG
 *   · 无原生 alert / confirm / prompt，一律自绘卡片
 *   · 淡彩配色，不引入米黄 / 棕橙等暖色（沿用心动粉莓 + 雾蓝）
 */
(function () {
  'use strict';

  // 占位页共用的卡片渲染：一个图标 + 标题 + 说明 + 预留的挂载点
  function renderStubPage(bodyEl, opts) {
    if (!bodyEl) return;
    const config = opts || {};
    const accent = config.accent || '#D97FA8';
    const soft = config.soft || '#FFEBF3';
    const iconSvg = config.icon || '';
    const bullets = Array.isArray(config.bullets) ? config.bullets : [];

    bodyEl.innerHTML =
      '<div style="min-height:100%; box-sizing:border-box; padding:28px 20px 40px; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:16px;">' +
        '<div style="width:84px; height:84px; border-radius:26px; background:' + soft + '; display:flex; align-items:center; justify-content:center; box-shadow:0 8px 24px rgba(120,140,190,0.10);">' +
          '<span style="width:42px; height:42px; color:' + accent + '; display:flex;">' + iconSvg + '</span>' +
        '</div>' +
        '<div style="font-size:17px; font-weight:800; color:#4a5364; letter-spacing:0.02em;">' + (config.title || '') + '</div>' +
        '<div style="font-size:12.5px; line-height:1.75; color:#8b93a7; text-align:center; max-width:280px;">' + (config.desc || '') + '</div>' +
        (bullets.length
          ? '<div style="width:100%; max-width:300px; display:flex; flex-direction:column; gap:8px; margin-top:4px;">' +
              bullets.map(function (t) {
                return '<div style="display:flex; align-items:flex-start; gap:8px; background:rgba(255,255,255,0.78); border:1px solid rgba(148,163,184,0.18); border-radius:14px; padding:10px 12px; font-size:11.5px; line-height:1.6; color:#6b7488;">' +
                  '<span style="flex-shrink:0; width:16px; height:16px; border-radius:50%; background:' + soft + '; color:' + accent + '; font-size:10px; font-weight:800; display:flex; align-items:center; justify-content:center; margin-top:1px;">·</span>' +
                  '<span>' + t + '</span>' +
                '</div>';
              }).join('') +
            '</div>'
          : '') +
        '<div id="' + (config.mountId || 'heartgame-mount') + '" style="width:100%; max-width:320px; margin-top:6px;"></div>' +
        '<div style="margin-top:8px; font-size:10.5px; color:#aab2c4; letter-spacing:0.04em;">功能开发中</div>' +
      '</div>';
  }

  /**
   * 心动游戏：初始化入口
   * 后续实装时，把玩法挂到心跳游戏自己的模块上，并在这里调用它渲染。
   */
  window.initHeartGameApp = function () {
    const closeBtn = document.getElementById('heartgame-close-btn');
    if (closeBtn) closeBtn.onclick = () => { if (typeof closeApp === 'function') closeApp('heartgame'); };

    const body = document.getElementById('heartgame-body');
    renderStubPage(body, {
      title: '心动游戏',
      desc: '这里会是一组只属于你们两个人的小游戏：用它来试探心意、制造暧昧、留下只属于你们的记录。',
      accent: '#D97FA8',
      soft: '#FFEBF3',
      mountId: 'heartgame-mount',
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 10a2 2 0 0 0-2 2c0 1.02-.1 2.51-.26 4"/><path d="M14 13.12c0 2.38 0 6.38-1 8.88"/><path d="M17.29 21.02c.12-.6.43-2.3.5-3.02"/><path d="M2 12a10 10 0 0 1 18-6"/><path d="M2 16h.01"/><path d="M21.8 16c.2-2 .131-5.354 0-6"/><path d="M5 19.5C5.5 18 6 15 6 12a6 6 0 0 1 .34-2"/><path d="M8.65 22c.21-.66.45-1.32.57-2"/><path d="M9 6.8a6 6 0 0 1 9 5.2v2"/></svg>',
      bullets: [
        '入口已就位：桌面图标、路由页面、上下文都已接好',
        '玩法本体（小游戏 / 结算 / 记忆回写）在后续窗口实装',
        '实装时直接替换本页内容即可，不影响桌面与设置'
      ]
    });
  };

  /**
   * 占位图标：预留给下一个功能的入口
   */
  window.initPlaceholderApp = function () {
    const closeBtn = document.getElementById('placeholder-close-btn');
    if (closeBtn) closeBtn.onclick = () => { if (typeof closeApp === 'function') closeApp('placeholder'); };

    const body = document.getElementById('placeholder-body');
    renderStubPage(body, {
      title: '占位图标',
      desc: '这是一个预留的入口，等你决定下一个功能放什么，直接把它接在这里就行。',
      accent: '#7E97C9',
      soft: '#EDF2FB',
      mountId: 'placeholder-mount',
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="7.5" cy="15.5" r="4.5"/><path d="m21 2-9.6 9.6"/><path d="m15.5 7.5 3 3L22 7l-3-3"/></svg>',
      bullets: [
        '图标、桌面落位、路由与设置里的图标位都已就绪',
        '改名只需改 app_desktop.js 里的 name 与 index.html 里的标题'
      ]
    });
  };
})();
