/**
 * app_heartgame.js - 心动游戏 · 主界面看板与生命周期入口
 * ============================================================================
 * 本文件是整个模组的装配层，把下面五个文件接成一个可运行的应用：
 *   app_heartgame_core.js       —— 状态中枢 K + 自绘 UI 组件库 H
 *   app_heartgame_portraits.js  —— 立绘 / 背景 / 热区涂抹 / 后台管理（window.HeartGame.Portraits）
 *   app_heartgame_gacha.js      —— 抽卡工坊 + 锁脸生图 + 钱包（window.HeartGame.Gacha）
 *   app_heartgame_story.js      —— 主线 VN + 分支树 + 剧情小手机（window.HeartGame.Story）
 *   app_heartgame_quiet.js      —— 静室 + 赠礼 + 双轨 Prompt 注入（window.HeartGame.Quiet）
 *   app_heartgame_panels.js     —— 任务 / 商店 / 牵绊（window.HeartGame.Panels）
 *
 * 界面拓扑（严格按设计稿）：
 *   中部        —— Live2D / 高精度立绘 看板，7 处身体热区触控（戳戳交互）
 *   左上角      —— 角色切换器 + 下拉展开的好感度面板
 *   右上角      —— 透明浮动「切换背景」按钮（呼出平铺式背景切换抽屉）
 *   右侧中下方  —— 竖向玻璃拟态图标组：每日任务 / 商店 / 牵绊 / 主线剧情
 *   右下角      —— 抽卡：大尺寸动态悬浮光晕入口
 *   底部右对齐  —— 退出 | 后台管理 | 立绘管理 | 静室
 *
 * 工程红线：纯经典脚本 / 无 emoji / 无原生 alert·confirm·prompt / 淡彩配色 / LF 换行
 */
(function () {
  'use strict';

  var HG = window.HeartGame;

  // ==========================================================================
  //  0. 占位页工具（保留给「占位图标」应用使用）
  // ==========================================================================

  function renderStubPage(bodyEl, opts) {
    if (!bodyEl) return;
    var config = opts || {};
    var accent = config.accent || '#D97FA8';
    var soft = config.soft || '#FFEBF3';
    var iconSvg = config.icon || '';
    var bullets = Array.isArray(config.bullets) ? config.bullets : [];

    bodyEl.innerHTML =
      '<div style="min-height:100%; box-sizing:border-box; padding:28px 20px 40px; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:16px;">'
        + '<div style="width:84px; height:84px; border-radius:26px; background:' + soft + '; display:flex; align-items:center; justify-content:center; box-shadow:0 8px 24px rgba(120,140,190,0.10);">'
          + '<span style="width:42px; height:42px; color:' + accent + '; display:flex;">' + iconSvg + '</span>'
        + '</div>'
        + '<div style="font-size:17px; font-weight:800; color:#4a5364; letter-spacing:0.02em;">' + (config.title || '') + '</div>'
        + '<div style="font-size:12.5px; line-height:1.75; color:#8b93a7; text-align:center; max-width:280px;">' + (config.desc || '') + '</div>'
        + (bullets.length
          ? '<div style="width:100%; max-width:300px; display:flex; flex-direction:column; gap:8px; margin-top:4px;">'
              + bullets.map(function (t) {
                return '<div style="display:flex; align-items:flex-start; gap:8px; background:rgba(255,255,255,0.78); border:1px solid rgba(148,163,184,0.18); border-radius:14px; padding:10px 12px; font-size:11.5px; line-height:1.6; color:#6b7488;">'
                  + '<span style="flex-shrink:0; width:16px; height:16px; border-radius:50%; background:' + soft + '; color:' + accent + '; font-size:10px; font-weight:800; display:flex; align-items:center; justify-content:center; margin-top:1px;">·</span>'
                  + '<span>' + t + '</span>'
                + '</div>';
              }).join('')
            + '</div>'
          : '')
        + '<div id="' + (config.mountId || 'heartgame-mount') + '" style="width:100%; max-width:320px; margin-top:6px;"></div>'
        + '<div style="margin-top:8px; font-size:10.5px; color:#aab2c4; letter-spacing:0.04em;">' + (config.footer || '功能开发中') + '</div>'
      + '</div>';
  }

  // ==========================================================================
  //  1. 心动游戏主控
  // ==========================================================================

  var App = {
    initialized: false,
    bound: false,
    mounted: false,
    onlineTimer: null,
    onlineSeconds: 0,
    _dom: null,
    _unsubs: [],

    // ------------------------------------------------------------------
    //  1.1 启动
    // ------------------------------------------------------------------

    /**
     * 入口（openApp('heartgame') → initHeartGameApp()）
     * 幂等：多次打开只重建视图，不重复绑定全局事件
     */
    boot: async function () {
      var closeBtn = document.getElementById('heartgame-close-btn');
      if (closeBtn) {
        // 关闭按钮直接接线全局 closeApp('heartgame')；
        // 资源释放由 bindLifecycle() 里包住的 closeApp 与 MutationObserver 兜底完成。
        closeBtn.onclick = function () {
          App.teardown();
          if (typeof closeApp === 'function') closeApp('heartgame');
        };
      }
      var body = document.getElementById('heartgame-body');
      if (!body) return;

      if (!HG) {
        body.innerHTML = '<div style="padding:28px; font-size:12px; color:#8b93a7; line-height:1.8;">'
          + '心动游戏内核未加载。请确认 index.html 已按顺序引入 '
          + 'app_heartgame_core.js / app_heartgame_portraits.js / app_heartgame_gacha.js / '
          + 'app_heartgame_story.js / app_heartgame_quiet.js / app_heartgame_panels.js。</div>';
        return;
      }

      App.bindLifecycle();

      // 载入状态
      body.innerHTML = '';
      body.appendChild(HG.H.loading('正在校准心动频率…'));

      var sessionId = null;
      try {
        if (typeof activeSessionId !== 'undefined' && activeSessionId) sessionId = Number(activeSessionId);
      } catch (e) { }

      var meId = HG.K.resolveMeId();
      var charId = await HG.K.resolveCharIdAsync(sessionId);
      await HG.K.bind({ charId: charId, meId: meId, sessionId: sessionId });

      // 兜底：IndexedDB 不可用 / 档案库为空时 charId 可能是 null，
      // 但主界面（立绘、热区、任务、商店、静室）在「无角色」状态下也必须可用，
      // 所以这里绝不允许 state 为 null —— 否则后续任何 K.state.x 都会炸。
      if (!HG.K.state) {
        HG.K.state = HG.K.blank(charId || 0, meId || 0);
        HG.K._sessionRow = HG.K._stateKey(charId || 0, meId || 0);
      }

      HG.K.rollQuests();
      HG.K.state.stats.sessions = HG.U.int(HG.K.state.stats.sessions, 0) + 1;
      if (!HG.K.state.bond.firstMeetAt) {
        HG.K.state.bond.firstMeetAt = Date.now();
        HG.K.pushTimeline({ type: 'meet', title: '初遇', text: '你第一次打开了心动游戏，屏幕里的人抬起头看了你一眼。' });
      }
      HG.K.save();

      App.initialized = true;
      await App.render();
      await App.probeSkin();
      App.startOnlineTracking();
    },

    /** 生成式 UI 素材探测：不阻塞首屏，素材到位后补一次重绘 */
    probeSkin: async function () {
      if (!HG.Skin || !HG.SKIN_MANIFEST) return;
      try {
        var found = await HG.Skin.probeAll(HG.SKIN_MANIFEST);
        var n = Object.keys(found).reduce(function (a, g) { return a + Object.keys(found[g]).length; }, 0);
        if (n > 0 && !App._skinApplied) {
          App._skinApplied = true;
          await App.render();
        }
      } catch (e) {
        console.warn('[心动游戏] 皮肤素材探测失败（继续用内联 SVG / 纯 CSS）:', e);
      }
    },

    /** 关闭 */
    exit: function () {
      App.teardown();
      if (typeof closeApp === 'function') closeApp('heartgame');
    },

    /**
     * 生命周期接缝：
     * 项目里 closeApp 只做一次 classList.remove('active')（无 teardown 钩子），
     * 所以这里用两重保险来确保 Live2D 实例 / 资源池 / 定时器一定被释放。
     */
    bindLifecycle: function () {
      if (App.bound) return;
      App.bound = true;

      // ① 包一层 closeApp
      try {
        if (typeof window.closeApp === 'function' && !window.__hgCloseWrapped) {
          window.__hgCloseWrapped = true;
          var origClose = window.closeApp;
          window.closeApp = function (app) {
            if (app === 'heartgame') App.teardown();
            return origClose.apply(this, arguments);
          };
        }
      } catch (e) { }

      // ② 兜底：win-heartgame 失去 .active 时也清理（覆盖 Router.back 等旁路）
      try {
        var win = document.getElementById('win-heartgame');
        if (win && typeof MutationObserver === 'function' && !win.__hgObserved) {
          win.__hgObserved = true;
          var wasActive = win.classList.contains('active');
          var mo = new MutationObserver(function () {
            var nowActive = win.classList.contains('active');
            if (wasActive && !nowActive) App.teardown();
            wasActive = nowActive;
          });
          mo.observe(win, { attributes: true, attributeFilter: ['class'] });
          App._mo = mo;
        }
      } catch (e) { }

      // ③ 页面卸载（进程被杀 / 刷新）
      try {
        window.addEventListener('pagehide', function () { App.teardown(); });
      } catch (e) { }
    },

    /** 释放一切副作用：Live2D 实例、资源池、定时器、K 的事件订阅、浮层 */
    teardown: function () {
      App.stopOnlineTracking();
      if (HG && HG.Portraits) { try { HG.Portraits.teardown(); } catch (e) { } }
      if (HG && HG.H) { try { HG.H.closeAllLayers(); } catch (e) { } }
      if (HG && HG.U) { try { HG.U.clearTimers(); } catch (e) { } }
      if (HG && HG.Quiet && HG.Quiet.UI) { try { HG.Quiet.close(); } catch (e) { } }
      App._unsubs.forEach(function (fn) { try { fn(); } catch (e) { } });
      App._unsubs = [];
      App.mounted = false;
      App._dom = null;
    },

    /** 在线挂机时长统计（每 30 秒结算一次，写入任务进度） */
    startOnlineTracking: function () {
      App.stopOnlineTracking();
      App.onlineSeconds = 0;
      App.onlineTimer = setInterval(function () {
        App.onlineSeconds += 30;
        HG.K.state.stats.totalOnlineSec = HG.U.int(HG.K.state.stats.totalOnlineSec, 0) + 30;
        // 每累计 30 秒推进一次「在线相伴」进度
        HG.K.progressQuest('online', 30);
      }, 30000);
    },

    stopOnlineTracking: function () {
      if (App.onlineTimer) { clearInterval(App.onlineTimer); App.onlineTimer = null; }
    },

    // ------------------------------------------------------------------
    //  1.2 主渲染
    // ------------------------------------------------------------------

    render: async function () {
      var body = document.getElementById('heartgame-body');
      if (!body) return;
      var H = HG.H, K = HG.K, U = HG.U, C = HG.C;
      // 防御：state 未绑定完成时直接跳过（boot 是异步的，期间可能有并发重绘请求）
      if (!K.state) return;
      // 档案读取一律带超时兜底：任何一次底层存储挂起都不允许把整个看板卡死
      var profile = await HG.K.readGuarded(function () { return K.charProfile(); }, 6000,
        { id: K.charId, name: 'TA', avatar: '', persona: '', remark: '', raw: null });
      var user = await HG.K.readGuarded(function () { return K.userProfile(); }, 6000,
        { id: K.meId, name: '你', avatar: '', persona: '', tags: [], reactPref: '', raw: null });
      var st = K.state;

      body.innerHTML = '';
      var root = H.el('div', { id: 'heartgame-mount', class: 'hg-lobby hg-rise' });
      // 高度写成「100% 撑满 + 不低于 560px」：只看板容器本身撑不住，
      // 祖先链任何一环没有确定高度时 100% 会塌成 0，用户看到的就只是「打开了但一片空白」。
      root.style.cssText = 'position:relative; width:100%; height:100%; min-height:560px;'
        + 'display:flex; flex-direction:column; box-sizing:border-box; overflow:hidden;'
        + 'background:linear-gradient(170deg,#FFF7FB 0%,#FBF4FA 52%,#F4F2FB 100%);';
      App._dom = { root: root };

      // ---------- 舞台（立绘 + 热区） ----------
      var stage = H.el('div', { class: 'hg-lobby-stage' });
      stage.style.cssText = 'position:absolute; inset:0; overflow:hidden;';
      // 背景层
      // 背景层：**主页刻意不铺场景插画** —— 看板已经有立绘，
      // 再叠一张写实场景会喧宾夺主（画面里会出现两个视觉中心）。
      // 场景插画只服务于 VN 剧情舞台与静室（那里没有立绘抢焦点）。
      var bgLayer = H.el('div');
      bgLayer.style.cssText = 'position:absolute; inset:0; transition:opacity .5s ease;'
        + 'background-size:cover; background-position:center;';
      var userBg = K.currentBackground();
      var bgIsBuiltin = !!(userBg && userBg.builtin);
      if (userBg && userBg.src && !bgIsBuiltin) {
        bgLayer.style.backgroundImage = 'url(' + userBg.src + ')';
        bgLayer.style.opacity = '.92';
      } else {
        bgLayer.style.backgroundImage = 'linear-gradient(170deg,#FFF3F8 0%,#F6F1FB 48%,#EFF3FB 100%)';
      }
      stage.appendChild(bgLayer);
      // 氛围光
      var aura = H.el('div');
      aura.style.cssText = 'position:absolute; inset:0; pointer-events:none;'
        + 'background:radial-gradient(circle at 50% 30%, rgba(255,255,255,0.55) 0%, rgba(255,255,255,0) 56%),'
        + 'linear-gradient(180deg, rgba(255,255,255,0.30) 0%, rgba(255,255,255,0) 22%, rgba(255,247,251,0.92) 100%);';
      stage.appendChild(aura);
      // 立绘挂载点
      var portraitHost = H.el('div', { id: 'hg-portrait-host' });
      portraitHost.style.cssText = 'position:absolute; left:0; right:0; top:6%; bottom:104px;';
      stage.appendChild(portraitHost);
      root.appendChild(stage);
      App._dom.bgLayer = bgLayer;
      App._dom.portraitHost = portraitHost;

      // 气泡（戳戳反馈）
      var bubbleHost = H.el('div', { id: 'hg-touch-bubble' });
      bubbleHost.style.cssText = 'position:absolute; left:16px; right:16px; top:16%; z-index:8;'
        + 'display:flex; justify-content:center; pointer-events:none; opacity:0; transition:opacity .3s ease;';
      root.appendChild(bubbleHost);
      App._dom.bubbleHost = bubbleHost;

      var title = document.querySelector('#win-heartgame .win-header h3');
      if (title) {
        var appV = appVersionLabel();
        title.textContent = '心动游戏' + (appV ? ' · ' + appV : '');
      }

      // 顶部栏
      var topbar = H.el('div', { class: 'hg-lobby-top' });
      topbar.style.cssText = 'position:relative; z-index:10; display:flex; align-items:flex-start;'
        + 'justify-content:space-between; gap:10px; padding:12px 13px 0; pointer-events:none;';
      root.appendChild(topbar);

      // 左上：角色切换 + 好感面板
      var leftCol = H.el('div');
      leftCol.style.cssText = 'pointer-events:auto; display:flex; flex-direction:column; gap:8px; max-width:74%;';
      var charRow = H.el('div');
      charRow.style.cssText = 'display:flex; align-items:center; gap:9px; padding:7px 12px 7px 7px; border-radius:999px;'
        + 'background:rgba(255,255,255,0.72); border:1px solid rgba(216,160,190,0.30);'
        + 'backdrop-filter:blur(14px); -webkit-backdrop-filter:blur(14px); cursor:pointer;'
        + 'box-shadow:0 6px 20px rgba(150,120,150,0.12); transition:transform .18s ease;';
      charRow.appendChild(H.avatar(profile.avatar, profile.name, 34));
      var nameBox = H.el('div');
      nameBox.style.cssText = 'min-width:0;';
      nameBox.innerHTML = '<div style="font-size:12.6px; font-weight:800; color:#553f4c; white-space:nowrap;'
        + 'overflow:hidden; text-overflow:ellipsis; max-width:104px;">' + U.esc(profile.name) + '</div>'
        + '<div style="font-size:9.4px; color:#a99fae; margin-top:1px;">' + U.esc(C.MODE_LABEL[st.mode]) + '</div>';
      charRow.appendChild(nameBox);
      var swIcon = H.el('span');
      swIcon.style.cssText = 'color:#c3b6c6; display:flex;';
      swIcon.innerHTML = H.icon('down', 14, { strokeWidth: 2.4 });
      charRow.appendChild(swIcon);
      charRow.onpointerdown = function () { charRow.style.transform = 'scale(0.97)'; };
      charRow.onpointerup = function () { charRow.style.transform = ''; };
      charRow.onpointerleave = function () { charRow.style.transform = ''; };
      charRow.onclick = function () { App.openCharSwitcher(); };
      leftCol.appendChild(charRow);

      // 好感度面板（下拉）
      var affWrap = H.el('div');
      affWrap.style.cssText = 'pointer-events:auto;';
      leftCol.appendChild(affWrap);
      App._dom.affWrap = affWrap;
      topbar.appendChild(leftCol);

      // 右上：透明浮动「切换背景」
      var rightCol = H.el('div');
      rightCol.style.cssText = 'pointer-events:auto; display:flex; flex-direction:column; gap:8px; align-items:flex-end;';
      var bgBtn = H.iconButton('bg', {
        size: 38, color: '#8f6a80', bg: 'rgba(255,255,255,0.60)',
        border: 'rgba(216,160,190,0.32)', title: '切换背景'
      });
      bgBtn.style.backdropFilter = 'blur(12px)';
      bgBtn.onclick = function () { App.openBackgroundDrawer(); };
      rightCol.appendChild(bgBtn);
      topbar.appendChild(rightCol);

      // ---------- 右侧中下：竖向玻璃拟态图标组 ----------
      var rail = H.el('div', { class: 'hg-lobby-rail' });
      rail.style.cssText = 'position:absolute; right:12px; top:50%; transform:translateY(-46%); z-index:9;'
        + 'display:flex; flex-direction:column; gap:10px;';
      var RAIL = [
        { key: 'task', label: '每日任务', icon: 'task', color: '#7E97C9', soft: '#EDF2FB', open: function () { HG.Panels.openTasks(); } },
        { key: 'shop', label: '商店', icon: 'shop', color: '#D97FA8', soft: '#FFEBF3', open: function () { HG.Panels.openShop(); } },
        { key: 'bond', label: '牵绊', icon: 'bond', color: '#B79EDC', soft: '#F3EEFF', open: function () { HG.Panels.openBond(); } },
        { key: 'story', label: '主线剧情', icon: 'book', color: '#8FB8DE', soft: '#EAF3FF', open: function () { HG.Story.open(); } }
      ];
      App._dom.rail = {};
      RAIL.forEach(function (item) {
        var btn = App.buildRailButton(item);
        rail.appendChild(btn);
        App._dom.rail[item.key] = btn;
      });
      root.appendChild(rail);

      // ---------- 右下角：抽卡（大尺寸动态悬浮光晕） ----------
      var gachaWrap = H.el('div', { class: 'hg-lobby-gacha' });
      gachaWrap.style.cssText = 'position:absolute; right:14px; bottom:74px; z-index:10;';
      var pool = HG.Gacha && HG.Gacha.Pools ? HG.Gacha.Pools.active() : null;
      var upCard = pool ? ((pool.cards || []).filter(function (c) { return c.up; })[0] || (pool.cards || [])[0]) : null;
      var gachaBtn = H.el('div');
      gachaBtn.style.cssText = 'position:relative; width:84px; height:84px; border-radius:26px; cursor:pointer;'
        + 'overflow:hidden; border:1.8px solid rgba(255,255,255,0.85);'
        + 'background:linear-gradient(150deg,#D97FA8,#B79EDC);'
        + 'box-shadow:0 12px 32px rgba(217,127,168,0.42), 0 0 0 6px rgba(217,127,168,0.10);'
        + 'transition:transform .2s cubic-bezier(.22,1,.36,1);';
      if (upCard && (upCard.thumb || upCard.image)) {
        var gim = H.el('img', { alt: '' });
        gim.src = upCard.thumb || upCard.image;
        gim.style.cssText = 'position:absolute; inset:0; width:100%; height:100%; object-fit:cover;';
        gachaBtn.appendChild(gim);
      }
      var gshine = H.el('div');
      gshine.className = 'hg-shimmer';
      gshine.style.cssText = 'position:absolute; inset:0; pointer-events:none; opacity:.5;';
      gachaBtn.appendChild(gshine);
      var glabel = H.el('div');
      glabel.style.cssText = 'position:absolute; left:0; right:0; bottom:0; padding:5px 0 6px; text-align:center;'
        + 'background:linear-gradient(180deg,transparent,rgba(40,20,36,0.78));';
      glabel.innerHTML = '<div style="font-size:10.4px; font-weight:900; color:#fff; letter-spacing:.16em;">抽卡</div>';
      gachaBtn.appendChild(glabel);
      var ghalo = H.el('div');
      ghalo.style.cssText = 'position:absolute; inset:-12px; border-radius:34px; pointer-events:none;'
        + 'background:radial-gradient(circle, rgba(217,127,168,0.42) 0%, transparent 68%);'
        + 'animation:hg-pulse 2.6s ease-in-out infinite; z-index:-1;';
      gachaBtn.appendChild(ghalo);
      gachaBtn.onpointerdown = function () { gachaBtn.style.transform = 'scale(0.94)'; };
      gachaBtn.onpointerup = function () { gachaBtn.style.transform = ''; };
      gachaBtn.onpointerleave = function () { gachaBtn.style.transform = ''; };
      gachaBtn.onclick = function () { HG.Gacha.open(); };
      gachaWrap.appendChild(gachaBtn);
      root.appendChild(gachaWrap);

      // ---------- 底部右对齐工具栏 ----------
      var bottom = H.el('div', { class: 'hg-lobby-bottom' });
      bottom.style.cssText = 'position:absolute; left:0; right:0; bottom:0; z-index:11; padding:10px 12px 12px;'
        + 'display:flex; align-items:center; justify-content:flex-end; gap:7px;'
        + 'background:linear-gradient(0deg, rgba(255,247,251,0.96) 0%, rgba(255,247,251,0.72) 62%, rgba(255,247,251,0) 100%);';
      var TOOLS = [
        { key: 'exit', label: '退出', icon: 'exit', color: '#9a919f', soft: 'rgba(240,236,244,0.9)', open: function () { App.exit(); } },
        { key: 'admin', label: '后台管理', icon: 'admin', color: '#7E97C9', soft: '#EDF2FB', open: function () { HG.Portraits.openAdmin(function () { App.render(); }); } },
        { key: 'portrait', label: '立绘管理', icon: 'portrait', color: '#B79EDC', soft: '#F3EEFF', open: function () { HG.Portraits.openManager(function () { App.render(); }); } },
        { key: 'quiet', label: '静室', icon: 'quiet', color: '#D97FA8', soft: '#FFEBF3', open: function () { HG.Quiet.open(); } }
      ];
      TOOLS.forEach(function (t) {
        var b = H.el('button', { class: 'hg-tool-btn', type: 'button' });
        // 同样刻意用纯 CSS：见 buildRailButton 的说明
        b.style.cssText = 'display:inline-flex; align-items:center; gap:5px; padding:8px 12px; border-radius:13px;'
          + 'font-size:11px; font-weight:700; cursor:pointer;'
          + 'transition:transform .16s ease, box-shadow .2s ease;'
          + 'border:1px solid rgba(190,180,195,0.24); background:' + t.soft + '; color:' + t.color + ';'
          + 'backdrop-filter:blur(10px); -webkit-backdrop-filter:blur(10px);';
        b.innerHTML = H.icon(t.icon, 14, { strokeWidth: 2 }) + '<span>' + t.label + '</span>';
        b.onpointerdown = function () { b.style.transform = 'scale(0.95)'; };
        b.onpointerup = function () { b.style.transform = ''; };
        b.onpointerleave = function () { b.style.transform = ''; };
        b.onclick = function () { t.open(); };
        bottom.appendChild(b);
      });
      root.appendChild(bottom);

      body.appendChild(root);

      // 好感面板 + 立绘挂载 + 事件订阅
      App.renderAffinityPanel();
      // 立绘挂载必须带超时：档案读取走的是带兜底的 _withTimeout，
      // 但若底层存储整体挂起，这里会把整个 render 卡在半路 ——
      // 那样底部工具栏与皮肤重绘都到不了，界面就永久停在旧一帧。
      await App.mountPortraitSafe();
      App.subscribe();
    },

    /** 挂载立绘，带 5 秒硬超时（超时就用剪影占位继续） */
    mountPortraitSafe: async function () {
      try {
        await Promise.race([
          App.mountPortrait(),
          new Promise(function (resolve) { setTimeout(resolve, 5000); })
        ]);
      } catch (e) {
        console.warn('[心动游戏] 立绘挂载失败（继续渲染其余部分）:', e);
      }
    },

    /** 右侧图标组按钮（纯 CSS 玻璃拟态 + 内联 SVG glyph）
     *  说明：这里刻意不用生成式素材做按钮底。玻璃元件本身是白的，
     *  生成图只能输出白底，抠白会把元件高光一起抠掉、不抠就留白边；
     *  而纯 CSS 在浅色底上无色差、无白边、不占体积，观感更干净。 */
    buildRailButton: function (item) {
      var H = HG.H;
      var btn = H.el('div', { class: 'hg-rail-btn' });
      btn.style.cssText = 'position:relative; width:52px; height:52px; border-radius:18px; cursor:pointer;'
        + 'display:flex; flex-direction:column; align-items:center; justify-content:center; gap:2px;'
        + 'background:linear-gradient(150deg, rgba(255,255,255,0.86), rgba(255,255,255,0.62));'
        + 'border:1px solid ' + item.color + '33;'
        + 'backdrop-filter:blur(16px); -webkit-backdrop-filter:blur(16px);'
        + 'box-shadow:0 8px 22px rgba(150,120,150,0.14), inset 0 1px 0 rgba(255,255,255,0.9);'
        + 'transition:transform .18s cubic-bezier(.22,1,.36,1), box-shadow .22s ease;';
      var ic = H.el('span');
      ic.style.cssText = 'color:' + item.color + '; display:flex;';
      ic.innerHTML = H.icon(item.icon, 19, { strokeWidth: 1.7 });
      btn.appendChild(ic);
      var lb = H.el('span');
      lb.style.cssText = 'font-size:8.2px; font-weight:800; color:#8b8292; letter-spacing:.01em; line-height:1;';
      lb.textContent = item.label.length > 4 ? item.label.slice(0, 4) : item.label;
      btn.appendChild(lb);
      // 角标（待领取数量）
      if (item.key === 'task') {
        var ready = HG.K.chestReady().length + (HG.K.state.quests.dynamic || []).filter(function (q) { return q.done; }).length;
        var claimable = 0;
        HG.C.BASE_QUESTS.forEach(function (q) {
          var rec = HG.K.state.quests.base[q.key];
          if (rec && rec.done && !rec.claimed) claimable++;
        });
        var total = ready + claimable;
        if (total > 0) {
          var badge = H.el('span');
          badge.style.cssText = 'position:absolute; right:-3px; top:-3px; min-width:17px; height:17px; border-radius:9px;'
            + 'background:linear-gradient(135deg,#D97FA8,#B79EDC); color:#fff; font-size:9px; font-weight:900;'
            + 'display:flex; align-items:center; justify-content:center; padding:0 4px;'
            + 'box-shadow:0 3px 9px rgba(217,127,168,0.45);';
          badge.textContent = total;
          btn.appendChild(badge);
        }
      }
      btn.onpointerdown = function () { btn.style.transform = 'scale(0.93)'; };
      btn.onpointerup = function () { btn.style.transform = ''; };
      btn.onpointerleave = function () { btn.style.transform = ''; };
      btn.onclick = function () { item.open(); };
      return btn;
    },

    /**
     * 好感度面板：默认收起为「一行条」，点一下展开完整卡片。
     * 收起状态持久化在 localStorage（按 面具×角色 不区分，全局一个偏好即可）。
     */
    renderAffinityPanel: function () {
      var H = HG.H, K = HG.K, U = HG.U, C = HG.C;
      var wrap = App._dom && App._dom.affWrap;
      if (!wrap) return;
      var st = K.state;
      wrap.innerHTML = '';

      var LS_KEY = 'hg-affinity-collapsed';
      var collapsed = true;
      try {
        var saved = localStorage.getItem(LS_KEY);
        collapsed = (saved === null) ? true : (saved === '1');
      } catch (e) { }

      function setCollapsed(v) {
        collapsed = v;
        try { localStorage.setItem(LS_KEY, v ? '1' : '0'); } catch (e) { }
        App.renderAffinityPanel();
      }

      // ---- 收起态：一行薄条（等级 + 数值 + 迷你进度） ----
      if (collapsed) {
        var bar = H.el('div', { id: 'hg-affinity-panel', class: 'hg-aff-mini' });
        bar.style.cssText = 'display:flex; align-items:center; gap:8px; padding:6px 10px 6px 7px; border-radius:999px;'
          + 'cursor:pointer; max-width:230px; box-sizing:border-box;'
          + 'background:linear-gradient(150deg, rgba(255,255,255,0.88), rgba(255,247,251,0.72));'
          + 'border:1px solid rgba(216,160,190,0.30); backdrop-filter:blur(14px); -webkit-backdrop-filter:blur(14px);'
          + 'box-shadow:0 6px 18px rgba(150,120,150,0.12); transition:transform .16s ease;';
        var isRev = st.mode === C.MODE.REVERSE_STRATEGY;
        var tier = K.tier();
        var mood = K.moodOf(st.verdict.mood);
        var accent = isRev ? mood.color : tier.color;
        var ic = H.el('span');
        ic.style.cssText = 'width:20px; height:20px; border-radius:50%; flex-shrink:0; display:flex; align-items:center;'
          + 'justify-content:center; background:' + accent + '22; color:' + accent + ';';
        ic.innerHTML = H.icon(isRev ? mood.icon : 'heart', 12, { strokeWidth: 2.2 });
        bar.appendChild(ic);
        var txt = H.el('span');
        txt.style.cssText = 'font-size:10.6px; font-weight:800; color:#7d7484; white-space:nowrap;';
        txt.textContent = isRev
          ? (mood.name + ' ' + U.int(st.verdict.value, 0) + '%')
          : (tier.name + ' ' + U.comma(st.affinity));
        bar.appendChild(txt);
        var dash = H.el('span');
        dash.style.cssText = 'flex:1; min-width:24px; height:5px; border-radius:99px; overflow:hidden;'
          + 'background:rgba(216,190,210,0.28); position:relative;';
        var fill = H.el('span');
        fill.style.cssText = 'position:absolute; left:0; top:0; bottom:0; width:'
          + (isRev ? U.int(st.verdict.value, 0) : K.tierProgress()) + '%;'
          + 'background:linear-gradient(90deg,' + accent + ',#B79EDC);';
        dash.appendChild(fill);
        bar.appendChild(dash);
        var exp = H.el('span');
        exp.style.cssText = 'color:#b7adc0; display:flex; flex-shrink:0;';
        exp.innerHTML = H.icon('down', 13, { strokeWidth: 2.4 });
        bar.appendChild(exp);
        bar.onpointerdown = function () { bar.style.transform = 'scale(0.97)'; };
        bar.onpointerup = function () { bar.style.transform = ''; };
        bar.onpointerleave = function () { bar.style.transform = ''; };
        bar.onclick = function () { setCollapsed(false); };
        wrap.appendChild(bar);
        return;
      }

      var card = H.el('div', { id: 'hg-affinity-panel' });
      card.style.cssText = 'border-radius:18px; padding:11px 12px; max-width:230px; box-sizing:border-box;'
        + 'background:linear-gradient(150deg, rgba(255,255,255,0.88), rgba(255,247,251,0.74));'
        + 'border:1px solid rgba(216,160,190,0.30); backdrop-filter:blur(16px); -webkit-backdrop-filter:blur(16px);'
        + 'box-shadow:0 10px 26px rgba(150,120,150,0.14);';
      wrap.appendChild(card);

      // 收起按钮（右上角小箭头）
      var fold = H.el('button', { type: 'button', title: '收起好感度面板' });
      fold.style.cssText = 'position:absolute; right:8px; top:8px; width:22px; height:22px; border-radius:50%;'
        + 'border:1px solid rgba(216,160,190,0.35); background:rgba(255,255,255,0.9); color:#b7adc0;'
        + 'display:flex; align-items:center; justify-content:center; cursor:pointer; padding:0; z-index:2;';
      fold.innerHTML = H.icon('up', 12, { strokeWidth: 2.4 });
      fold.onclick = function (e) { e.stopPropagation(); setCollapsed(true); };
      card.style.position = 'relative';
      card.appendChild(fold);

      if (st.mode === C.MODE.REVERSE_STRATEGY) {
        // —— 被攻略模式：User 对 Char 的好感裁定器 ——
        var mood = K.moodOf(st.verdict.mood);
        var head = H.el('div');
        head.style.cssText = 'display:flex; align-items:center; justify-content:space-between; gap:8px;';
        head.innerHTML = '<span style="font-size:9.6px; letter-spacing:.16em; color:#B79EDC; font-weight:900;">心意裁定</span>'
          + '<span style="display:inline-flex; align-items:center; gap:4px; font-size:10px; font-weight:800; color:'
          + mood.color + ';">' + H.icon(mood.icon, 11, { strokeWidth: 2.2 }) + mood.name + '</span>';
        card.appendChild(head);

        var val = H.el('div');
        val.style.cssText = 'display:flex; align-items:baseline; gap:4px; margin:8px 0 6px;';
        val.innerHTML = '<span style="font-size:26px; font-weight:900; color:#D97FA8; line-height:1;">'
          + U.int(st.verdict.value, 0) + '</span>'
          + '<span style="font-size:11px; color:#a99fae;">/ 100</span>';
        card.appendChild(val);

        card.appendChild(H.progress({
          value: U.int(st.verdict.value, 0), height: 7, color: mood.color, color2: '#B79EDC'
        }));

        var quick = H.el('div');
        quick.style.cssText = 'display:flex; gap:5px; margin-top:9px;';
        [-5, -1, 1, 5].forEach(function (n) {
          var b = H.el('button', { type: 'button' });
          b.style.cssText = 'flex:1; padding:5px 0; border-radius:9px; font-size:10.4px; font-weight:800; cursor:pointer;'
            + 'border:none;'
            + (n > 0 ? 'background:#FFEBF3; color:#B0728F;' : 'background:#EDF2FB; color:#5f7aa8;');
          b.textContent = (n > 0 ? '+' : '') + n;
          b.onclick = function () {
            K.nudgeVerdict(n);
            App.renderAffinityPanel();
            H.floatText((n > 0 ? '+' : '') + n, { host: card, x: '70%', y: '20%', color: n > 0 ? '#D97FA8' : '#7E97C9' });
          };
          quick.appendChild(b);
        });
        card.appendChild(quick);

        var setMood = H.el('button', { type: 'button' });
        setMood.style.cssText = 'width:100%; margin-top:7px; padding:6px 0; border-radius:10px; font-size:10.4px;'
          + 'font-weight:800; cursor:pointer; border:1px dashed rgba(183,158,220,0.5); background:rgba(243,238,255,0.7);'
          + 'color:#7d63a8;';
        setMood.textContent = '设定心情指数';
        setMood.onclick = function () { App.openMoodPicker(); };
        card.appendChild(setMood);
      } else {
        // —— 攻略模式：阶梯式好感进阶条 ——
        var tier = K.tier();
        var pct = K.tierProgress();
        var head2 = H.el('div');
        head2.style.cssText = 'display:flex; align-items:center; justify-content:space-between; gap:8px;';
        head2.innerHTML = '<span style="font-size:9.6px; letter-spacing:.16em; color:' + tier.color + '; font-weight:900;">'
          + '心动等级 · ' + tier.name + '</span>'
          + '<span style="font-size:9.4px; color:#a99fae;">' + (K.tierIndex() + 1) + '/6</span>';
        card.appendChild(head2);

        var val2 = H.el('div');
        val2.style.cssText = 'margin:8px 0 7px;';
        val2.innerHTML = '<span style="font-size:22px; font-weight:900; color:' + tier.color + '; line-height:1;">'
          + U.comma(st.affinity) + '</span>'
          + '<span style="font-size:9.6px; color:#a99fae; margin-left:5px;">/ ' + U.comma(tier.max) + '</span>';
        card.appendChild(val2);

        card.appendChild(H.progress({
          value: pct, height: 8, color: tier.color, color2: '#B79EDC', glow: tier.glow,
          nodes: [{ pct: 100 }]
        }));

        var tip2 = H.el('div');
        tip2.style.cssText = 'font-size:9.6px; color:#a99fae; margin-top:7px; line-height:1.6;';
        tip2.textContent = K.isGated()
          ? '经验槽已满 · 完成晋阶任务可推进'
          : (K.tierIndex() >= C.AFFINITY_TIERS.length - 1
            ? '已抵达终局契约'
            : '距「' + C.AFFINITY_TIERS[K.tierIndex() + 1].name + '」还需 ' + U.comma(K.toNextTier()));
        card.appendChild(tip2);

        var detail = H.el('button', { type: 'button' });
        detail.style.cssText = 'width:100%; margin-top:8px; padding:6px 0; border-radius:10px; font-size:10.4px;'
          + 'font-weight:800; cursor:pointer; border:1px dashed rgba(217,127,168,0.45); background:rgba(255,241,247,0.75);'
          + 'color:#B0728F;';
        detail.textContent = '展开牵绊面板';
        detail.onclick = function () { HG.Panels.openBond('ladder'); };
        card.appendChild(detail);
      }

      // 代币条
      var wallet = H.el('div');
      wallet.style.cssText = 'display:flex; gap:8px; margin-top:9px; padding-top:9px;'
        + 'border-top:1px solid rgba(216,160,190,0.18);';
      [['heart', U.comma(st.wallet.tokens), '#D97FA8'], ['cards', U.comma(st.wallet.draws), '#B79EDC']].forEach(function (w) {
        var cell = H.el('span');
        cell.style.cssText = 'display:inline-flex; align-items:center; gap:4px; font-size:10.2px; font-weight:800; color:'
          + w[2] + ';';
        cell.innerHTML = H.icon(w[0], 12, { strokeWidth: 2.2 }) + '<span>' + w[1] + '</span>';
        wallet.appendChild(cell);
      });
      card.appendChild(wallet);
    },

    /** 挂载立绘 + 热区触控 */
    mountPortrait: async function () {
      var H = HG.H, K = HG.K;
      var host = App._dom && App._dom.portraitHost;
      if (!host) return null;
      var res = await HG.Portraits.mount(host, {
        fit: 'contain',
        onTouch: function (key, ev, spot) { App.handleTouch(key, ev, spot); }
      });
      App.mounted = true;
      return res;
    },

    /**
     * 热区触控（戳戳交互）
     * 攻略模式：好感上升 + 专属反应；被攻略模式：TA 反过来向你讨要回应
     */
    handleTouch: async function (key, ev, spot) {
      var H = HG.H, K = HG.K, U = HG.U, C = HG.C, st = K.state;
      var profile = await K.charProfile();

      st.stats.touches = U.int(st.stats.touches, 0) + 1;
      K.progressQuest('touch', 1);

      // 好感：不同部位权重不同，同一天反复戳同一处收益衰减
      var WEIGHT = { hair: 3, face: 5, neck: 6, chest: 7, arm: 4, hand: 6, leg: 5 };
      var todayKey = 'touch_' + U.dayKey() + '_' + key;
      st.stats.touchToday = st.stats.touchToday || {};
      var times = U.int(st.stats.touchToday[todayKey], 0);
      st.stats.touchToday[todayKey] = times + 1;
      var decay = times < 3 ? 1 : (times < 6 ? 0.5 : 0.2);
      var base = Math.max(1, Math.round((WEIGHT[key] || 4) * decay));

      var result = await HG.Portraits.react(key, { mood: st.quiet.mood });
      var res = K.addAffinity(base, { reason: '戳戳 · ' + (spot ? spot.name : key), silent: false });

      // 心情随动
      st.quiet.mood = K.deriveMood().key;
      K.save();

      // 命中动画
      if (HG.Portraits.renderer && HG.Portraits.renderer.react) {
        HG.Portraits.renderer.react(key, result.expression);
      }

      // 气泡演出
      App.showTouchBubble(result.text, profile);

      // 日志卡（静室流）
      K.pushQuietSystem('*你' + (spot ? spot.hint : '碰了碰 TA') + '，'
        + (res.applied > 0 ? '对方的心跳乱了一拍' : '对方没什么反应') + '*', 'touch');

      // 反客为主：被攻略模式下 TA 会顺势索要回应
      if (K.isReverse() && Math.random() < 0.4) {
        var extraPrompt = HG.Quiet.Prompt.buildSystem(profile, await K.userProfile(), st) + '\n\n'
          + '事件：' + (await K.userProfile()).name + ' 刚刚在看板上碰了你的「' + (spot ? spot.name : '身体') + '」。\n'
          + '要求：第一人称，20~50 字，把它当成一次「互动反馈」，'
          + '顺带汇报一句你为此做的事（例如又氪了一单）。不要旁白。';
        var api = await K.resolveApi();
        if (api && typeof window.fwCallLLM === 'function') {
          try {
            var out = await window.fwCallLLM(api, [{ role: 'system', content: extraPrompt }], { temperature: 0.95 });
            if (out) K.pushQuiet({ role: 'char', text: String(out).trim(), tone: 'touch' });
          } catch (e) { }
        }
      }

      App.renderAffinityPanel();
      if (res.tierUp) {
        var tier = K.tier();
        H.toast('心动等级提升：' + tier.name);
      }
      if (res.gated) H.toast('经验槽已满，去牵绊面板完成晋阶任务');
    },

    /** 戳戳气泡 */
    showTouchBubble: function (text, profile) {
      var H = HG.H, U = HG.U;
      var host = App._dom && App._dom.bubbleHost;
      if (!host) return;
      host.innerHTML = '';
      var bubble = H.el('div');
      bubble.style.cssText = 'position:relative; max-width:86%; padding:11px 14px; border-radius:18px 18px 18px 5px;'
        + 'background:linear-gradient(150deg, rgba(255,255,255,0.97), rgba(255,246,250,0.92));'
        + 'border:1px solid rgba(216,160,190,0.32); border-left:3px solid #D97FA8;'
        + 'box-shadow:0 10px 28px rgba(150,120,150,0.18);'
        + 'font-size:12.4px; line-height:1.8; color:#5c4450;'
        + 'backdrop-filter:blur(14px); -webkit-backdrop-filter:blur(14px);';
      var who = H.el('div');
      who.style.cssText = 'display:flex; align-items:center; gap:5px; margin-bottom:5px;';
      who.innerHTML = '<span style="width:13px; height:13px; color:#D97FA8; display:inline-flex;">'
        + H.icon('heart', 13, { strokeWidth: 2 }) + '</span>'
        + '<span style="font-size:9.8px; font-weight:800; color:#B0728F;">' + U.esc(profile.name) + '</span>';
      bubble.appendChild(who);
      var t = H.el('div');
      t.textContent = text || '';
      bubble.appendChild(t);
      host.appendChild(bubble);
      host.style.opacity = '1';
      if (App._bubbleTimer) clearTimeout(App._bubbleTimer);
      App._bubbleTimer = setTimeout(function () {
        host.style.opacity = '0';
      }, 5200);
    },

    // ------------------------------------------------------------------
    //  1.3 子面板入口
    // ------------------------------------------------------------------

    /** 角色切换器 */
    openCharSwitcher: async function () {
      var H = HG.H, K = HG.K, U = HG.U;
      var body = H.el('div');
      var chars = await K.listCharacters();
      var personas = await K.listPersonas();

      if (!chars.length) {
        body.appendChild(H.empty('档案库里还没有角色。先去档案馆新建一个角色，再回来。', { icon: 'mask' }));
      }
      body.appendChild(H.sectionTitle('选择角色', { color: '#D97FA8' }));
      chars.forEach(function (c) {
        var on = Number(c.id) === Number(K.charId);
        var row = H.listRow({
          icon: on ? 'heart' : 'mask',
          color: on ? '#D97FA8' : '#9FB3D9',
          soft: on ? '#FFEBF3' : '#EDF2FB',
          title: c.name || '未命名角色',
          subtitle: U.cut(c.persona || c.remark || '（未填写人设）', 40),
          leftNode: null,
          rightNode: on ? H.chip('当前', { color: '#D97FA8', soft: '#FFEBF3' }) : H.iconButton('next', { size: 26, color: '#c3b6c6' })
        });
        // 用头像替换左侧图标
        var avatar = H.avatar(c.avatar, c.name, 34);
        row.insertBefore(avatar, row.firstChild);
        var ic = row.querySelector('span');
        row.onclick = async function () {
          if (on) { H.closeAllLayers(); return; }
          await K.bind({ charId: Number(c.id), meId: K.meId, sessionId: null });
          H.closeAllLayers();
          H.toast('已切换到 ' + (c.name || '角色'));
          App.render();
        };
        body.appendChild(row);
      });

      // User 面具
      body.appendChild(H.sectionTitle('你的面具（User 身份）', { color: '#7E97C9' }));
      personas.forEach(function (p) {
        var on = Number(p.id) === Number(K.meId);
        var row = H.listRow({
          icon: on ? 'check' : 'mask',
          color: on ? '#7E97C9' : '#9FB3D9',
          soft: on ? '#EDF2FB' : '#F6F4F8',
          title: p.name || '未命名面具',
          subtitle: U.cut(p.persona || '（未填写人设）', 40),
          rightNode: on ? H.chip('使用中', { color: '#5f7aa8', soft: '#EDF2FB' }) : H.iconButton('next', { size: 26, color: '#c3b6c6' })
        });
        row.onclick = async function () {
          if (on) { H.closeAllLayers(); return; }
          try { localStorage.setItem('active_me_id', p.id); } catch (e) { }
          await K.bind({ charId: K.charId, meId: Number(p.id), sessionId: null });
          H.closeAllLayers();
          H.toast('已切换面具：' + (p.name || ''));
          App.render();
        };
        body.appendChild(row);
      });

      if (!personas.length) {
        body.appendChild(H.empty('还没有 User 面具。去档案馆的「我的」新建一个。', { icon: 'mask' }));
      }

      H.sheet({
        title: '角色与面具',
        subtitle: '心动游戏的数据按 角色 × 面具 双键隔离',
        icon: 'mask',
        height: '88%',
        content: body
      });
    },

    /** 心情指数选择（反向模式） */
    openMoodPicker: function () {
      var H = HG.H, K = HG.K, C = HG.C;
      var body = H.el('div');
      var note = H.el('div');
      note.style.cssText = 'font-size:10.8px; line-height:1.72; color:#8b8292; background:rgba(255,241,247,0.8);'
        + 'border:1px solid rgba(217,127,168,0.22); border-radius:13px; padding:11px 12px; margin-bottom:12px;';
      note.textContent = '设定 TA 此刻的心境。TA 的静室回应、抽卡反应与任务汇报都会围绕这个心境展开。';
      body.appendChild(note);

      C.MOODS.forEach(function (m) {
        var on = K.state.verdict.mood === m.key;
        var row = H.listRow({
          icon: m.icon, color: m.color, soft: m.soft,
          title: m.name,
          subtitle: m.key === 'ecstatic' ? '好感 90+ 时的常态' :
            m.key === 'happy' ? '好感 72+ 时的常态' :
              m.key === 'calm' ? '好感 48+ 时的常态' :
                m.key === 'anxious' ? '好感偏低时的常态' :
                  m.key === 'jealous' ? '同类刺激下的应激反应' : '极致独占欲',
          rightNode: on ? H.chip('当前', { color: m.color, soft: m.soft }) : H.iconButton('next', { size: 26, color: '#c3b6c6' })
        });
        row.onclick = function () {
          K.setVerdict(K.state.verdict.value, { mood: m.key, note: K.state.verdict.note });
          H.closeAllLayers();
          H.toast('心情已设为「' + m.name + '」');
          App.renderAffinityPanel();
        };
        body.appendChild(row);
      });

      H.sheet({ title: '心情指数', subtitle: '你为 TA 设定的心境', icon: 'smile', height: '76%', content: body });
    },

    /** 平铺式背景切换抽屉 */
    openBackgroundDrawer: function () {
      var H = HG.H, K = HG.K, U = HG.U;
      var body = H.el('div');
      var list = K.state.assets.backgrounds || [];

      if (!list.length) {
        body.appendChild(H.empty('还没有自定义背景。上传一张图，它会同时供主页看板与 VN 剧情引擎调用。', { icon: 'bg' }));
      }
      var grid = H.el('div');
      grid.style.cssText = 'display:grid; grid-template-columns:1fr 1fr; gap:9px;';
      // 「无背景」项
      var none = H.el('div');
      none.style.cssText = 'position:relative; aspect-ratio:16/10; border-radius:14px; cursor:pointer;'
        + 'background:linear-gradient(150deg,#FFF3F8,#EFF3FB); border:1.5px solid '
        + (!K.state.assets.currentBackgroundId ? 'rgba(217,127,168,0.7)' : 'rgba(190,180,195,0.24)') + ';'
        + 'display:flex; align-items:center; justify-content:center; color:#B0728F;';
      none.innerHTML = '<span style="font-size:10.6px; font-weight:800;">默认流光底</span>';
      none.onclick = function () {
        K.setCurrentBackground(null);
        App.render();
        H.closeAllLayers();
      };
      grid.appendChild(none);

      list.forEach(function (b) {
        var on = K.state.assets.currentBackgroundId === b.id;
        var cell = H.el('div');
        cell.style.cssText = 'position:relative; aspect-ratio:16/10; border-radius:14px; overflow:hidden;'
          + 'cursor:pointer; border:1.6px solid ' + (on ? 'rgba(217,127,168,0.8)' : 'rgba(190,180,195,0.24)') + ';'
          + 'box-shadow:' + (on ? '0 8px 22px rgba(217,127,168,0.28)' : '0 4px 12px rgba(150,120,150,0.10)') + ';';
        var im = H.el('img', { alt: '' });
        im.src = b.src;
        im.style.cssText = 'width:100%; height:100%; object-fit:cover;';
        cell.appendChild(im);
        var tag = H.el('div');
        tag.style.cssText = 'position:absolute; left:0; right:0; bottom:0; padding:5px 7px;'
          + 'background:linear-gradient(180deg,transparent,rgba(40,24,36,0.8));';
        tag.innerHTML = '<div style="font-size:9.8px; font-weight:800; color:#fff; white-space:nowrap; overflow:hidden;'
          + 'text-overflow:ellipsis;">' + U.esc(b.name) + '</div>'
          + '<div style="font-size:8.4px; color:rgba(255,255,255,0.72);">' + U.esc(b.scene) + '</div>';
        cell.appendChild(tag);
        if (on) {
          var dot = H.el('span');
          dot.style.cssText = 'position:absolute; right:6px; top:6px; width:18px; height:18px; border-radius:50%;'
            + 'background:#D97FA8; color:#fff; display:flex; align-items:center; justify-content:center;';
          dot.innerHTML = H.icon('check', 11, { strokeWidth: 3 });
          cell.appendChild(dot);
        }
        cell.onclick = function () {
          K.setCurrentBackground(b.id);
          H.toast('场景已切换：' + b.name);
          App.render();
          H.closeAllLayers();
        };
        grid.appendChild(cell);
      });
      body.appendChild(grid);

      H.sheet({
        title: '切换背景',
        subtitle: '主页看板与 VN 剧情引擎共用这套场景',
        icon: 'bg',
        height: '80%',
        content: body,
        buttons: [
          {
            text: '管理场景', icon: 'portrait', kind: 'soft', soft: '#EDF2FB', color: '#5f7aa8',
            onClick: function () {
              H.closeAllLayers();
              HG.Portraits.openBackgroundManager(function () { App.render(); });
            }
          },
          {
            text: '上传新背景', icon: 'upload', kind: 'primary',
            onClick: function () {
              H.closeAllLayers();
              HG.Portraits.openBackgroundManager(function () { App.render(); });
            }
          }
        ]
      });
    },

    // ------------------------------------------------------------------
    //  1.4 事件订阅
    // ------------------------------------------------------------------

    subscribe: function () {
      // 清理旧订阅（重复 render 时避免叠加）
      App._unsubs.forEach(function (fn) { try { fn(); } catch (e) { } });
      App._unsubs = [];
      var K = HG.K;
      // 钱包 / 好感 / 模式变化时刷新左上角面板
      App._unsubs.push(K.on('affinity', function () { App.renderAffinityPanel(); }));
      App._unsubs.push(K.on('wallet', function () { App.renderAffinityPanel(); }));
      App._unsubs.push(K.on('verdict', function () { App.renderAffinityPanel(); }));
      App._unsubs.push(K.on('mode', function () { App.render(); }));
    }
  };

  // ==========================================================================
  //  2. 对外入口
  // ==========================================================================

  /**
   * 心动游戏：初始化入口（openApp('heartgame') 会调到这里）
   * 每次打开都重建视图，但全局事件只绑定一次。
   * 真正的界面挂在 #heartgame-mount（id="heartgame-mount"）。
   */
  /**
   * 取用户可识别的「应用版本号」＝更新日志最新一条（如 v4.40）。
   * 这个号在设置-更新日志里也看得到，方便一眼对齐「设备上跑的是哪一版」。
   */
  function appVersionLabel() {
    try {
      if (typeof CHANGELOG_DATA !== 'undefined' && CHANGELOG_DATA && CHANGELOG_DATA[0] && CHANGELOG_DATA[0].version) {
        return CHANGELOG_DATA[0].version;
      }
    } catch (e) { }
    try {
      if (window.CHANGELOG_DATA && window.CHANGELOG_DATA[0]) return window.CHANGELOG_DATA[0].version;
    } catch (e) { }
    return '';
  }

  /**
   * 心动游戏：初始化入口（openApp('heartgame') 会调到这里）
   * 每次打开都重建视图，但全局事件只绑定一次。
   * 真正的界面挂在 #heartgame-mount（id="heartgame-mount"）。
   */
  window.initHeartGameApp = function () {
    // 把版本号打到标题栏，方便一眼确认设备上跑的是哪一版
    // （排查「改了没生效 / 打不开」时，第一步永远是确认版本）
    try {
      var appV = appVersionLabel();
      if (appV) document.title = '叙事诗小手机 · ' + appV;
    } catch (e) { }
    // 同步异常也必须可见：以前只有 Promise 的 catch，
    // 若同步阶段抛错就会「点了图标毫无反应」，非常难排查。
    try {
      App._heartgameBooted = true;
      App.boot().catch(function (e) {
        App.showBootFailure(e);
      });
    } catch (e) {
      App.showBootFailure(e);
    }
  };

  /** 启动失败：把真实原因写到页面上（而不是留一片空白） */
  App.showBootFailure = function (e) {
    App.bootError = (e && e.message) ? e.message : String(e);
    console.error('[心动游戏] 启动失败:', e);
    var body = document.getElementById('heartgame-body');
    if (!body) return;
    if (window.HeartGame && window.HeartGame.H) {
      var box = window.HeartGame.H.empty(
        '心动游戏启动失败：' + App.bootError + '\n\n（请把这段提示反馈给开发者）',
        { icon: 'info' });
      box.style.whiteSpace = 'pre-wrap';
      body.innerHTML = '';
      body.appendChild(box);
    } else {
      body.style.padding = '24px';
      body.textContent = '心动游戏启动失败：' + App.bootError;
    }
  };

  // 入口挂载点常量（供自检与外部集成引用）
  App.MOUNT_ID = 'heartgame-mount';
  App.PLACEHOLDER_MOUNT_ID = 'placeholder-mount';

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

  /** 调试 / 外部集成用 */
  window.heartGameApp = App;
})();
