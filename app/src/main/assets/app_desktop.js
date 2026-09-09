/**
 * app_desktop.js - 桌面网格、桌面美化、组件工坊宽高占位自适应与长按编辑 (安全防护与函数补全版)
 */

let isDesktopEditMode = false;
let currentDesktopPage = 0;
let lastRenderedDesktopPage = -1;   // 用于翻页滑入动效的方向判定

// ===== 桌面网格规格：列数固定 4，行数随桌面风格变化 =====
//   M3 桌面（默认）= 4 列 × 7 行 = 每页 28 格
//   清透凉夏等旧预设 = 4 列 × 5 行 = 每页 20 格（不能改，否则它的小部件排版会乱）
const DESKTOP_COLS = 4;
const DESKTOP_DEFAULT_ROWS = 7;
const DESKTOP_LEGACY_PAGE_SIZE = 20;                     // 旧版每页 20 格（4 列 × 5 行）
let DESKTOP_ROWS = DESKTOP_DEFAULT_ROWS;
let DESKTOP_PAGE_SIZE = DESKTOP_COLS * DESKTOP_ROWS;

/** 当前桌面行数（存 localStorage，随预设切换） */
function getDesktopRows() {
  let r = 0;
  try { r = parseInt(localStorage.getItem("desktop-rows"), 10) || 0; } catch (e) {}
  if (!r) r = DESKTOP_DEFAULT_ROWS;
  return Math.max(3, Math.min(10, r));
}
/** 切换桌面行数（同步页宽），预设切换时调用 */
function setDesktopGridRows(rows) {
  const r = Math.max(3, Math.min(10, parseInt(rows, 10) || DESKTOP_DEFAULT_ROWS));
  DESKTOP_ROWS = r;
  DESKTOP_PAGE_SIZE = DESKTOP_COLS * r;
  window.DESKTOP_PAGE_SIZE = DESKTOP_PAGE_SIZE;
  try { localStorage.setItem("desktop-rows", String(r)); } catch (e) {}
  return r;
}
window.setDesktopGridRows = setDesktopGridRows;

/** 把一份「旧页宽」的扁平布局按页重排到当前页宽，保持每一页的图标仍留在该页 */
function remapDesktopLayout(arr, fromSize, toSize) {
  if (!Array.isArray(arr) || !arr.length || fromSize === toSize) return arr;
  const pages = Math.max(1, Math.ceil(arr.length / fromSize));
  const next = new Array(pages * toSize).fill(null);
  for (let p = 0; p < pages; p++) {
    for (let i = 0; i < fromSize; i++) {
      const v = arr[p * fromSize + i];
      if (v !== undefined) next[p * toSize + i] = v;
    }
  }
  return next;
}
window.remapDesktopLayout = remapDesktopLayout;
window.DESKTOP_PAGE_SIZE = DESKTOP_PAGE_SIZE;
window.DESKTOP_LEGACY_PAGE_SIZE = DESKTOP_LEGACY_PAGE_SIZE;

/** 一次性幂等迁移：桌面布局与小部件槽位从旧页宽换成当前页宽 */
function migrateDesktopPageSize() {
  let stored = 0;
  try { stored = parseInt(localStorage.getItem("desktop-page-size"), 10) || 0; } catch (e) {}
  if (stored === DESKTOP_PAGE_SIZE) return;
  const fromSize = stored > 0 ? stored : DESKTOP_LEGACY_PAGE_SIZE;
  if (fromSize === DESKTOP_PAGE_SIZE) { try { localStorage.setItem("desktop-page-size", String(DESKTOP_PAGE_SIZE)); } catch (e) {} return; }

  try {
    const raw = JSON.parse(localStorage.getItem("desktop-layout-v3"));
    if (Array.isArray(raw) && raw.length) {
      localStorage.setItem("desktop-layout-v3", JSON.stringify(remapDesktopLayout(raw, fromSize, DESKTOP_PAGE_SIZE)));
    }
  } catch (e) {}

  try {
    const placed = JSON.parse(localStorage.getItem("placed-widgets-desktop")) || {};
    const next = {};
    Object.keys(placed).forEach((k) => {
      const idx = parseInt(k, 10);
      if (isNaN(idx)) return;
      const p = Math.floor(idx / fromSize);
      const i = idx % fromSize;
      next[p * DESKTOP_PAGE_SIZE + i] = placed[k];
    });
    localStorage.setItem("placed-widgets-desktop", JSON.stringify(next));
  } catch (e) {}

  try { localStorage.setItem("desktop-page-size", String(DESKTOP_PAGE_SIZE)); } catch (e) {}
}

/** 行数随主题变化；用 1fr 让网格等于容器高度（薄秋主题），清透凉夏沿用原来的内容高度 */
function applyDesktopGridMetrics() {
  const desktop = document.getElementById("desktop");
  const grid = document.getElementById("desktop-grid");
  if (!desktop || !grid) return;
  // 行数随主题变化，必须由 JS 写 inline !important（CSS 里不能写 repeat(var(--n), …)）
  grid.style.setProperty("grid-template-rows", "repeat(" + DESKTOP_ROWS + ", 1fr)", "important");
  // 用真实渲染出来的槽位高度反推图标尺寸（薄秋主题会把槽位撑满整行）
  const slot = grid.querySelector(".desktop-slot");
  const rowH = slot ? slot.getBoundingClientRect().height : 0;
  if (!rowH) {
    // 桌面还没显示（开屏期间 display:none）时测不到高度，稍后重试一次
    if (!applyDesktopGridMetrics._retried) {
      applyDesktopGridMetrics._retried = true;
      setTimeout(applyDesktopGridMetrics, 500);
    }
    return;
  }
  applyDesktopGridMetrics._retried = false;
  const icon = Math.max(28, Math.min(56, Math.floor(rowH - 12)));
  const cell = Math.max(48, Math.min(80, Math.floor(rowH)));
  [desktop, grid].forEach((el) => {
    el.style.setProperty("--desktop-icon", icon + "px");
    el.style.setProperty("--desktop-cell", cell + "px");
  });
}
window.applyDesktopGridMetrics = applyDesktopGridMetrics;
window.__desktopDebug = function () {
  return {
    pageSize: DESKTOP_PAGE_SIZE, cols: DESKTOP_COLS, rows: DESKTOP_ROWS,
    page: currentDesktopPage, edit: isDesktopEditMode, lastRendered: lastRenderedDesktopPage
  };
};

// 核心初始化保护锁，彻底杜绝重复绑定事件导致的浏览器线程阻塞与死锁
let isDragEventsInitialized = false;
let isAppClickEventsInitialized = false;

// 1. 主动注入网格槽位、长按编辑模式微章 CSS 规范样式，保障顶级质感
(function() {
  const desktopDragStyle = document.createElement("style");
  desktopDragStyle.textContent = `
    #desktop {
      touch-action: none !important; /* 彻底拦截原生手势抢占，解放高精度左右切页滑屏 */
    }
    #desktop-grid {
      display: grid !important;
      grid-template-columns: repeat(4, 1fr) !important;
      /* 行数随主题变化（薄秋 7 行 / 清透凉夏 5 行），由 applyDesktopGridMetrics() 写 inline !important */
      gap: 16px 12px !important;
      min-height: auto !important;
      width: 100% !important;
      max-width: 100% !important;
      margin: 0 auto !important;
      padding: 0 !important;
      box-sizing: border-box !important;
      touch-action: none !important; /* 彻底拦截原生横屏滑动翻页的触控权冲突 */
    }
    #dock-grid {
      /* 与 .dock-container 同源定位：使用 flex+center 居中 4 个图标，
         杜绝 grid 1fr 拉伸造成的容器偏移；固定每格宽度保证视觉锁定正中 */
      display: flex !important;
      flex-direction: row !important;
      justify-content: center !important;
      align-items: center !important;
      gap: 18px !important;
      width: auto !important;
      max-width: 100% !important;
      margin: 0 auto !important;
      padding: 0 !important;
      box-sizing: border-box !important;
    }
    #dock-grid > .dock-slot {
      /* 固定每个 dock 槽位宽度，确保 4 个图标在 dock 中均匀居中 */
      width: 64px !important;
      flex: 0 0 64px !important;
      aspect-ratio: 1 / 1 !important;
    }
    
    /* 桌面和 Dock 的专属网格槽 */
    .desktop-slot, .dock-slot {
      display: flex !important;
      justify-content: center !important;
      align-items: center !important;
      width: 100% !important;
      aspect-ratio: 4 / 5 !important; /* 黄金比例锁，防止拉伸 */
      border-radius: 18px !important;
      transition: background-color 0.15s ease, border-color 0.15s ease !important;
      box-sizing: border-box !important;
      border: 1.5px dashed transparent !important;
      position: relative !important;
      margin: 0 !important;
      padding: 0 !important;
    }
    /* 当槽位摆放了自定义小部件组件时，解除比例限制，由小部件本身的行高列宽完全决定占位大小 */
    .desktop-slot.has-widget {
      aspect-ratio: auto !important;
      height: 100% !important;
    }
    
    .app-icon {
      display: flex !important;
      flex-direction: column !important;
      align-items: center !important;
      justify-content: center !important;
      text-align: center !important;
      width: 72px !important; /* 核心修正：固定宽度为标准的72px，绝不使用 100% 从而杜绝追加到body时膨胀 */
      height: auto !important; /* 核心修正：高度完全自适应，绝不使用 100% 从而杜绝追加到body时膨胀 */
      margin: 0 !important;
      padding: 0 !important;
      box-sizing: border-box !important;
      user-select: none !important;
      -webkit-user-select: none !important;
      -webkit-user-drag: none !important;
      touch-action: none !important; /* 拦截原生触控滑动，确保 pointermove 在滑动切页时被 100% 触发 */
    }
    .app-icon .icon-wrapper {
      display: flex !important;
      align-items: center !important;
      justify-content: center !important;
      margin: 0 auto 6px auto !important;
      box-sizing: border-box !important;
    }
    .app-icon span {
      display: block !important;
      width: 100% !important;
      text-align: center !important;
      margin: 0 auto !important;
      box-sizing: border-box !important;
    }
    .edit-mode .app-icon {
      /* 仅在编辑模式下激活触控阻断，以便进行拖动重排 */
      touch-action: none !important; 
      cursor: grab;
    }
    .app-icon.dragging {
      width: 72px !important;
      height: auto !important;
      opacity: 0.82;
      transform: scale(1.15) !important;
      box-shadow: 0 10px 25px rgba(0,0,0,0.2) !important;
      transition: none !important; /* 拖拽过程中严禁任何过渡动画，保证 1:1 跟随 */
    }
    .app-icon-placeholder {
      opacity: 0 !important; /* 幽灵占位符 */
    }

    /* 组件编辑微章 */
    .widget-add-badge, .widget-delete-badge {
      position: absolute !important;
      top: -4px !important;
      right: -4px !important;
      width: 22px !important;
      height: 22px !important;
      border-radius: 50% !important;
      border: none !important;
      color: white !important;
      font-size: 15px !important;
      font-weight: bold !important;
      display: flex !important;
      align-items: center !important;
      justify-content: center !important;
      cursor: pointer !important;
      z-index: 100 !important;
      box-shadow: 0 2px 6px rgba(0,0,0,0.2) !important;
      line-height: 1 !important;
    }
    .widget-add-badge {
      background-color: #07c160 !important;
    }
    .widget-delete-badge {
      background-color: #ef4444 !important;
    }

    /* 桌面放置组件的卡片容器 */
    .desktop-widget-container {
      width: 100% !important;
      height: 100% !important;
      display: flex !important;
      justify-content: center !important;
      align-items: center !important;
      overflow: hidden !important;
      border-radius: 12px !important;
      pointer-events: auto !important;
    }
  `;
  document.head.appendChild(desktopDragStyle);
})();

document.addEventListener("DOMContentLoaded", () => {
  // PWA 安全注册，在强更新开关激活时进行卸载处理
  if ('serviceWorker' in navigator) {
    if (localStorage.getItem("system-force-update") === "true") {
      navigator.serviceWorker.getRegistrations().then(registrations => {
        for (let reg of registrations) {
          reg.unregister();
        }
      });
    } else {
      navigator.serviceWorker.register('./sw.js')
        .then((reg) => {
          window._swRegistration = reg;
          console.log("PWA SW Online!");
        })
        .catch((e) => console.error("SW failed", e));
    }
  }

  loadDesktopLayout();
          
          // 核心：在初始化加载生命周期中，对点击和拖拽手势进行且仅进行单次安全绑定
          initAppClickEvents();
          initDragEvents();
          initDesktopSwipeEvents(); // 绑定手动滑动翻页事件
          
          applyGlobalSettingsOnLoad(); // 启动时应用壁纸与全局自定义 CSS
  
  // 初始化手机默认底栏颜色
  updateThemeColor("#f4f6fa");
  
  // 初始化网页免打扰全屏监听锁
  initBrowserFullscreenTrigger();
});

// 应用壁纸与全局注入 CSS 的渲染挂载
function applyGlobalSettingsOnLoad() {
  // 背景壁纸应用
  const bg = localStorage.getItem("beautify-wallpaper");
  const phone = document.getElementById("phone-container");
  if (phone) {
    if (bg) {
      phone.style.backgroundImage = `url(${bg})`;
      phone.style.backgroundSize = "cover";
      phone.style.backgroundPosition = "center";
    } else {
      phone.style.backgroundImage = "";
      phone.style.backgroundColor = "var(--bg-main)";
    }
  }

  // 底部 Dock 栏不透明度配置即时拉动渲染
  const opacity = localStorage.getItem("beautify-dock-opacity") || "70";
  const dockContainer = document.querySelector(".dock-container");
  if (dockContainer) {
    dockContainer.style.setProperty("background-color", `rgba(255, 255, 255, ${parseFloat(opacity) / 100})`, "important");
  }

  // 桌面整体放缩配置（解决部分手机型号图标缩小/Dock上移问题）
  const scale = localStorage.getItem("beautify-desktop-scale") || "100";
  applyDesktopScale(parseFloat(scale));

  // 注入式自定义 CSS 预设
  const activeCss = localStorage.getItem("beautify-active-css") || "";
  let styleTag = document.getElementById("global-injected-css");
  if (!styleTag) {
    styleTag = document.createElement("style");
    styleTag.id = "global-injected-css";
    document.head.appendChild(styleTag);
  }
  styleTag.textContent = activeCss;

  // 全局自定义字体（来自设置-桌面美化-全局字体板块）
  if (typeof window.applyActiveFont === "function") {
    try { window.applyActiveFont(); } catch (e) {}
  }
}

// 桌面整体放缩：通过 CSS transform: scale 对桌面网格与 Dock 栏整体等比放缩
// 解决部分手机型号因视口/DPR 差异导致图标缩小、Dock 栏上移的问题
function applyDesktopScale(scalePercent) {
  const scale = Math.max(0.5, Math.min(1.5, scalePercent / 100));
  const desktop = document.getElementById("desktop");
  const dock = document.getElementById("dock");
  if (desktop) {
    desktop.style.transformOrigin = "top center";
    desktop.style.transform = `scale(${scale})`;
  }
  if (dock) {
    dock.style.transformOrigin = "bottom center";
    dock.style.transform = `scale(${scale})`;
  }
}

// 浏览器免打扰全屏自锁函数 (隐藏工具栏与链接栏)
function initBrowserFullscreenTrigger() {
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone;
  
  if (!isStandalone) {
    // 监听首次交互
    const requestFullscreenMode = () => {
      const docEl = document.documentElement;
      let fullscreenPromise = null;
      try {
        if (docEl.requestFullscreen) {
          fullscreenPromise = docEl.requestFullscreen();
        } else if (docEl.webkitRequestFullscreen) { /* iOS Safari 兼容 */
          fullscreenPromise = docEl.webkitRequestFullscreen();
        } else if (docEl.mozRequestFullScreen) {
          fullscreenPromise = docEl.mozRequestFullScreen();
        } else if (docEl.msRequestFullscreen) {
          fullscreenPromise = docEl.msRequestFullscreen();
        }

        // 安全捕获拒绝异常 [2]
        if (fullscreenPromise && typeof fullscreenPromise.catch === 'function') {
          fullscreenPromise.catch(err => {
            console.warn("全屏申请被浏览器或安全机制拒绝:", err);
          });
        }
      } catch (err) {
        console.warn("同步环境下的全屏机制拦截:", err);
      }
      
      document.body.removeEventListener('click', requestFullscreenMode);
      document.body.removeEventListener('touchstart', requestFullscreenMode);
    };
    
    document.body.addEventListener('click', requestFullscreenMode);
    document.body.addEventListener('touchstart', requestFullscreenMode);
  }
}

// === 【补回关键缺失函数】：PWA 状态栏主题变色 ===
function updateThemeColor(color) {
  let meta = document.querySelector('meta[name="theme-color"]');
  if (!meta) {
    meta = document.createElement('meta');
    meta.name = 'theme-color';
    document.head.appendChild(meta);
  }
  meta.content = color;
}

const DESKTOP_APPS_CONFIG = {
  settings: { name: "设置", svg: '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/></svg>' },
  archive: { name: "档案库", svg: '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M4 6H2v14c0 1.1.9 2 2 2h14v-2H4V6zm16-4H8c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h12c1.1 0-2-.9-2-2V4c0-1.1-.9-2-2-2zm0 14H8V4h12v12z"/></svg>' },
  world_book: { name: "世界书", svg: '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.53c-.26-.81-1-1.4-1.9-1.4h-1v-3c0-.55-.45-1-1-1h-6v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.4z"/></svg>' }, 
  chat: { name: "聊天", svg: '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M20 2H4c-1.1 0-1.99.9-1.99 2L2 22l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zM6 9h12v2H6V9zm8 5H6v-2h8v2zm4-6H6V6h12v2z"/></svg>' },
  deeptalk: { name: "深谈", svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><path d="M8 10h.01"/><path d="M12 10h.01"/><path d="M16 10h.01"/></svg>' },
  reader: { name: "阅读", svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"></path><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 4z"></path></svg>' },
  forum: { name: "论坛", svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>' },
  couples: { name: "情侣空间", svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/></svg>' },
  music: { name: "听歌", svg: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg>' },
  shopping: { name: "购物", svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/><path d="M3 6h18"/><path d="M16 10a4 4 0 0 1-8 0"/></svg>' },
  encounter: { name: "邂逅", svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3" fill="currentColor" stroke="none"/><ellipse cx="12" cy="12" rx="10" ry="4" transform="rotate(-30 12 12)"/><ellipse cx="12" cy="12" rx="10" ry="4" transform="rotate(30 12 12)"/><circle cx="20" cy="9" r="1.2" fill="currentColor" stroke="none"/><circle cx="4" cy="15" r="1.2" fill="currentColor" stroke="none"/></svg>' },
  quicktravel: { name: "快穿局", svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/><path d="M5 5l3 3"/><path d="M19 5l-3 3"/><path d="M5 19l3-3"/><path d="M19 19l-3-3"/></svg>' },
  workbench: { name: "工作台", svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m7 8 3 3-3 3"/><path d="M12 16h5"/><rect x="3" y="4" width="18" height="16" rx="2"/></svg>' },
  yigui: { name: "仪轨", svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="17" rx="3"/><path d="M8 2v4M16 2v4M3 10h18"/><circle cx="8.5" cy="14.5" r="1.1" fill="currentColor" stroke="none"/><circle cx="12" cy="14.5" r="1.1" fill="currentColor" stroke="none"/><circle cx="15.5" cy="17.5" r="1.1" fill="currentColor" stroke="none"/></svg>' }
};

function loadDesktopLayout() {
  const grid = document.getElementById("desktop-grid");
  const dock = document.getElementById("dock-grid");

  // 0. 读取当前桌面风格的行数 / 页宽（M3 桌面 7 行 28 格；清透凉夏等旧预设 5 行 20 格）
  DESKTOP_ROWS = getDesktopRows();
  DESKTOP_PAGE_SIZE = DESKTOP_COLS * DESKTOP_ROWS;
  migrateDesktopPageSize();

  // 1. 读取并平滑迁移老用户的非网格版布局数据，自动将其校准为 v3 版吸附格式
  let desktopLayout = JSON.parse(localStorage.getItem("desktop-layout-v3"));
  if (!desktopLayout || !Array.isArray(desktopLayout)) {
    const oldLayout = JSON.parse(localStorage.getItem("desktop-layout"));
    desktopLayout = Array(DESKTOP_LEGACY_PAGE_SIZE).fill(null);
    if (oldLayout && Array.isArray(oldLayout)) {
      oldLayout.forEach((id, idx) => {
        if (idx < DESKTOP_LEGACY_PAGE_SIZE) desktopLayout[idx] = id;
      });
      // 老数据迁移后同样写回 v3，避免后续 isAppAlreadyPlaced / placeAppOnSlot 读到 null
      while (desktopLayout.length < DESKTOP_PAGE_SIZE * 2) desktopLayout.push(null);
      localStorage.setItem("desktop-layout-v3", JSON.stringify(desktopLayout));
    } else if (!window.__defaultPresetApplied && typeof window.applyPresetSilently === "function"
               && window.DESKTOP_PRESETS && window.DESKTOP_PRESETS.thin_autumn) {
      // 全新安装：默认就是「叙事诗 · 桌面 (M3)」——大时钟 + 照片卡 + 圆形图标
      window.__defaultPresetApplied = true;
      window.applyPresetSilently("thin_autumn");
      return loadDesktopLayout();
    } else {
            desktopLayout = Array(DESKTOP_PAGE_SIZE * 2).fill(null); // 两页，每页 4 列 × 7 行
            // 规则：chat / world_book / archive 只放 Dock 栏，不占主页面格子
            desktopLayout[0] = 'encounter';
            desktopLayout[1] = 'deeptalk';
            desktopLayout[2] = 'reader';
            desktopLayout[3] = 'forum';
            desktopLayout[4] = 'couples';
            // 第二页：听歌 + 购物 + 快穿局 + 工作台 + 仪轨
            desktopLayout[DESKTOP_PAGE_SIZE] = 'music';
            desktopLayout[DESKTOP_PAGE_SIZE + 1] = 'shopping';
            desktopLayout[DESKTOP_PAGE_SIZE + 2] = 'quicktravel';
            desktopLayout[DESKTOP_PAGE_SIZE + 3] = 'workbench';
            desktopLayout[DESKTOP_PAGE_SIZE + 4] = 'yigui';
            // 关键修复：默认布局必须立即写回 localStorage，否则 isAppAlreadyPlaced / placeAppOnSlot
            //   会读到 null，导致"添加图标列表显示全部"+"添加后覆盖成空数组使全部图标消失"
            localStorage.setItem("desktop-layout-v3", JSON.stringify(desktopLayout));
          }
        }

  let dockLayout = JSON.parse(localStorage.getItem("dock-layout-v3"));
  if (!dockLayout || !Array.isArray(dockLayout)) {
    const oldDock = JSON.parse(localStorage.getItem("dock-layout"));
    dockLayout = Array(4).fill(null);
    if (oldDock && Array.isArray(oldDock)) {
      oldDock.forEach((id, idx) => {
        if (idx < 4) dockLayout[idx] = id;
      });
      localStorage.setItem("dock-layout-v3", JSON.stringify(dockLayout));
    } else {
      // 默认 Dock：聊天 / 档案库 / 世界书 / 设置（chat/archive/world_book 只放 Dock）
      dockLayout[0] = 'chat';
      dockLayout[1] = 'archive';
      dockLayout[2] = 'world_book';
      dockLayout[3] = 'settings';
      // 同步写回，与 desktopLayout 保持一致，杜绝读取到 null 的隐患
      localStorage.setItem("dock-layout-v3", JSON.stringify(dockLayout));
    }
  }

  // 1.5 强制迁移：只要布局中没有"邂逅"图标就强制补入（不依赖一次性标记）
  //      之前的迁移标记可能导致用户永远拿不到邂逅，现改为幂等检查
  {
    const hasEncounter = (Array.isArray(desktopLayout) && desktopLayout.includes("encounter"))
                      || (Array.isArray(dockLayout) && dockLayout.includes("encounter"));
    if (!hasEncounter) {
      // 确保 desktopLayout 至少有 40 格（两页）
      while (desktopLayout.length < DESKTOP_PAGE_SIZE * 2) desktopLayout.push(null);
      // 找到第一个空位放置邂逅（避免覆盖已有 app 和 widget 占用区）
      // 优先尝试槽位 0；若 0 已被占用，则找第一个空槽
      let targetIdx = -1;
      // 检查槽位 0 是否被 widget 占用
      const placedWidgetsDesktop = (() => {
        try { return JSON.parse(localStorage.getItem("placed-widgets-desktop")) || {}; }
        catch(e) { return {}; }
      })();
      if (!desktopLayout[0] && !placedWidgetsDesktop["0"]) {
        targetIdx = 0;
      } else {
        // 找第一个既无 app 又无 widget 的空槽
        for (let i = 0; i < desktopLayout.length; i++) {
          if (!desktopLayout[i] && !placedWidgetsDesktop[String(i)]) {
            targetIdx = i;
            break;
          }
        }
      }
      if (targetIdx >= 0) {
        desktopLayout[targetIdx] = "encounter";
        localStorage.setItem("desktop-layout-v3", JSON.stringify(desktopLayout));
      }
    }
  }

  // 1.6 强制迁移：快穿局图标幂等补入（与邂逅同策略，老用户升级后自动出现在桌面空位）
  {
    const hasQt = (Array.isArray(desktopLayout) && desktopLayout.includes("quicktravel"))
               || (Array.isArray(dockLayout) && dockLayout.includes("quicktravel"));
    if (!hasQt) {
      while (desktopLayout.length < DESKTOP_PAGE_SIZE * 2) desktopLayout.push(null);
      const placedWidgetsDesktop2 = (() => {
        try { return JSON.parse(localStorage.getItem("placed-widgets-desktop")) || {}; }
        catch(e) { return {}; }
      })();
      let targetIdx2 = -1;
      for (let i = 0; i < desktopLayout.length; i++) {
        if (!desktopLayout[i] && !placedWidgetsDesktop2[String(i)]) {
          targetIdx2 = i;
          break;
        }
      }
      if (targetIdx2 >= 0) {
        desktopLayout[targetIdx2] = "quicktravel";
        localStorage.setItem("desktop-layout-v3", JSON.stringify(desktopLayout));
      }
    }
  }

  // 1.7 强制迁移：仪轨图标幂等补入（工作台之后优先，老用户升级后自动出现）
  {
    const hasYg = (Array.isArray(desktopLayout) && desktopLayout.includes("yigui"))
               || (Array.isArray(dockLayout) && dockLayout.includes("yigui"));
    if (!hasYg) {
      while (desktopLayout.length < DESKTOP_PAGE_SIZE * 2) desktopLayout.push(null);
      const placedWidgetsDesktop3 = (() => {
        try { return JSON.parse(localStorage.getItem("placed-widgets-desktop")) || {}; }
        catch(e) { return {}; }
      })();
      const wbIdx = desktopLayout.indexOf("workbench");
      let targetIdx3 = -1;
      // 优先放在工作台后面一格；被占用则找第一个空位
      if (wbIdx >= 0 && wbIdx + 1 < desktopLayout.length && !desktopLayout[wbIdx + 1] && !placedWidgetsDesktop3[String(wbIdx + 1)]) {
        targetIdx3 = wbIdx + 1;
      } else {
        for (let i = 0; i < desktopLayout.length; i++) {
          if (!desktopLayout[i] && !placedWidgetsDesktop3[String(i)]) { targetIdx3 = i; break; }
        }
      }
      if (targetIdx3 >= 0) {
        desktopLayout[targetIdx3] = "yigui";
        localStorage.setItem("desktop-layout-v3", JSON.stringify(desktopLayout));
      }
    }
  }

  // 2. 渲染网格 (支持多页切换及补位)
  const pageCount = Math.max(1, Math.ceil(desktopLayout.length / DESKTOP_PAGE_SIZE));
  if (currentDesktopPage >= pageCount) {
    currentDesktopPage = pageCount - 1;
  }
  
  const pageStart = currentDesktopPage * DESKTOP_PAGE_SIZE;
  const pageLayout = desktopLayout.slice(pageStart, pageStart + DESKTOP_PAGE_SIZE);
  while (pageLayout.length < DESKTOP_PAGE_SIZE) {
    pageLayout.push(null);
  }

  let isPageBlank = true;
  for (let i = 0; i < DESKTOP_PAGE_SIZE; i++) {
    if (pageLayout[i] !== null) {
      isPageBlank = false;
      break;
    }
    if (getPlacedWidget("desktop", i) !== null) {
      isPageBlank = false;
      break;
    }
  }

  renderLayout(grid, pageLayout, "desktop-slot");
  renderLayout(dock, dockLayout, "dock-slot");
  renderPageIndicator(pageCount, isPageBlank);
  // 4 列 × 7 行按可用高度自适应图标尺寸（保证 7 行刚好装进一屏，不出现滚动）
  applyDesktopGridMetrics();
  // 翻页滑入动效（只在页码真的变化时播放）
  if (lastRenderedDesktopPage !== currentDesktopPage) {
    const dir = currentDesktopPage > lastRenderedDesktopPage && lastRenderedDesktopPage >= 0 ? "r" : "l";
    grid.classList.remove("page-anim-r", "page-anim-l");
    void grid.offsetWidth;
    grid.classList.add(dir === "r" ? "page-anim-r" : "page-anim-l");
    lastRenderedDesktopPage = currentDesktopPage;
  }
  if (!window.__desktopMetricsBound) {
    window.__desktopMetricsBound = true;
    window.addEventListener("resize", () => applyDesktopGridMetrics());
    window.addEventListener("orientationchange", () => setTimeout(applyDesktopGridMetrics, 120));
  }

  // [3] 应用每页独立的 dock 栏 Y 轴偏移
  applyDockYOffset();

  // [3] 编辑模式下添加 dock 栏拖拽手柄
  setupDockDragHandle();

  // 清理任何残留的老版右上角删除按钮，保持 UI 清爽
  let delBtn = document.getElementById("btn-delete-page-indicator");
  if (delBtn) delBtn.remove();
}

// [3] dock 栏 Y 轴偏移：每页独立存储，解决部分浏览器 dock 栏缩到上方的问题
function getDockYOffsetKey() {
  return `dock-y-offset-page${currentDesktopPage}`;
}
function applyDockYOffset() {
  const dock = document.getElementById("dock");
  if (!dock) return;
  const offset = parseFloat(localStorage.getItem(getDockYOffsetKey()) || "0");
  dock.style.transform = offset ? `translateY(${offset}px)` : "";
}
// [3] 编辑模式下添加 dock 拖拽手柄，可上下移动整个 dock 栏
function setupDockDragHandle() {
  const dock = document.getElementById("dock");
  if (!dock) return;
  // 移除已有手柄
  const existingHandle = document.getElementById("dock-drag-handle");
  if (existingHandle) existingHandle.remove();

  if (!isDesktopEditMode) {
    dock.style.cursor = "";
    return;
  }

  // 创建拖拽手柄条
  const handle = document.createElement("div");
  handle.id = "dock-drag-handle";
  handle.style.cssText = "position:absolute; top:-28px; left:50%; transform:translateX(-50%); background:rgba(30,41,59,0.85); color:#fff; font-size:9px; font-weight:700; padding:3px 10px; border-radius:8px; white-space:nowrap; pointer-events:none; z-index:50;";
  handle.textContent = "↑↓ 拖动 Dock 栏";
  dock.style.position = "relative";
  dock.appendChild(handle);

  // 拖拽逻辑
  dock.style.cursor = "ns-resize";
  let startY = 0;
  let startOffset = 0;
  let isDragging = false;

  const onTouchStart = (e) => {
    // [3] 只在点击 dock 背景区域（非图标）时触发拖拽，避免与图标重排冲突
    if (e.target.closest(".app-icon") || e.target.closest(".desktop-widget-container")) return;
    isDragging = true;
    startY = (e.touches ? e.touches[0].clientY : e.clientY);
    startOffset = parseFloat(localStorage.getItem(getDockYOffsetKey()) || "0");
    dock.style.transition = "none";
    if (handle) {
      handle.style.pointerEvents = "none";
      handle.textContent = `偏移: ${Math.round(startOffset)}px`;
    }
    e.preventDefault();
  };
  const onTouchMove = (e) => {
    if (!isDragging) return;
    const currentY = (e.touches ? e.touches[0].clientY : e.clientY);
    let delta = currentY - startY;
    let newOffset = startOffset + delta;
    // 限制范围：向上最多移动 200px，向下最多 100px
    newOffset = Math.max(-200, Math.min(100, newOffset));
    dock.style.transform = `translateY(${newOffset}px)`;
    if (handle) handle.textContent = `偏移: ${Math.round(newOffset)}px`;
    e.preventDefault();
  };
  const onTouchEnd = () => {
    if (!isDragging) return;
    isDragging = false;
    dock.style.transition = "";
    // 读取最终偏移并保存
    const transform = dock.style.transform;
    const match = transform.match(/translateY\(([-\d.]+)px\)/);
    const finalOffset = match ? parseFloat(match[1]) : 0;
    localStorage.setItem(getDockYOffsetKey(), String(finalOffset));
    if (handle) {
      handle.textContent = "↑↓ 拖动 Dock 栏";
      handle.style.pointerEvents = "none";
    }
  };

  dock.onmousedown = onTouchStart;
  dock.onmousemove = onTouchMove;
  dock.onmouseup = onTouchEnd;
  dock.onmouseleave = onTouchEnd;
  dock.ontouchstart = onTouchStart;
  dock.ontouchmove = onTouchMove;
  dock.ontouchend = onTouchEnd;
}

function renderPageIndicator(pageCount, isPageBlank) {
  const indicator = document.getElementById("desktop-page-indicator");
  if (!indicator) return;
  indicator.innerHTML = "";

  // 只有一页且不在编辑模式时，指示器没必要占位置（也让 7 行网格多出一点高度）
  if (pageCount <= 1 && !isDesktopEditMode) {
    indicator.style.display = "none";
    return;
  }
  indicator.style.display = "flex";

  const isLastPage = currentDesktopPage === pageCount - 1;
  const canDeleteCurrentPage = isDesktopEditMode && pageCount > 1 && isLastPage && isPageBlank;

  for (let i = 0; i < pageCount; i++) {
    const dot = document.createElement("div");
    
    if (i === currentDesktopPage && canDeleteCurrentPage) {
      // 在编辑模式下，如果当前页是最后一页且是空白页，长条变成一个红色减号
      dot.className = "page-dot active delete-page-dot";
      dot.innerText = "-";
      dot.style.cssText = "background-color: #ef4444 !important; color: white !important; display: flex !important; align-items: center !important; justify-content: center !important; font-size: 12px !important; font-weight: 800 !important; cursor: pointer !important; border-radius: 99px !important; width: 20px !important; height: 20px !important; line-height: 1 !important;";
      dot.onclick = (e) => {
        e.stopPropagation();
        window.deleteCurrentDesktopPage();
      };
    } else {
      dot.className = `page-dot${i === currentDesktopPage ? " active" : ""}`;
      dot.onclick = () => {
        currentDesktopPage = i;
        loadDesktopLayout();
      };
    }
    indicator.appendChild(dot);
  }

  // 只有在无法删除当前页（即不是空白末页）时，编辑模式下才渲染 "+" 新增页按钮
  if (isDesktopEditMode && !canDeleteCurrentPage) {
    const addBtn = document.createElement("button");
    addBtn.className = "page-add-btn";
    addBtn.innerText = "+";
    addBtn.onclick = () => {
      addNewDesktopPage();
    };
    indicator.appendChild(addBtn);
  }
}

function addNewDesktopPage() {
  let desktopLayout = JSON.parse(localStorage.getItem("desktop-layout-v3")) || [];
  for (let i = 0; i < DESKTOP_PAGE_SIZE; i++) {
    desktopLayout.push(null);
  }
  localStorage.setItem("desktop-layout-v3", JSON.stringify(desktopLayout));
  currentDesktopPage = Math.floor(desktopLayout.length / DESKTOP_PAGE_SIZE) - 1;
  loadDesktopLayout();
}

window.deleteCurrentDesktopPage = function() {
  if (confirm("确定要删除当前空白页吗？")) {
    let desktopLayout = JSON.parse(localStorage.getItem("desktop-layout-v3")) || [];
    const pageStart = currentDesktopPage * DESKTOP_PAGE_SIZE;
    
    // 移除对应页面的20个数据槽
    desktopLayout.splice(pageStart, DESKTOP_PAGE_SIZE);
    localStorage.setItem("desktop-layout-v3", JSON.stringify(desktopLayout));
    
    // 同步清洗和偏移对应页面及后续页面的组件绑定位置
    try {
      const placed = JSON.parse(localStorage.getItem("placed-widgets-desktop")) || {};
      const newPlaced = {};
      Object.keys(placed).forEach(key => {
        const idx = parseInt(key);
        if (idx < pageStart) {
          newPlaced[idx] = placed[idx];
        } else if (idx >= pageStart + DESKTOP_PAGE_SIZE) {
          newPlaced[idx - DESKTOP_PAGE_SIZE] = placed[idx];
        }
      });
      localStorage.setItem("placed-widgets-desktop", JSON.stringify(newPlaced));
    } catch(e) {}

    if (currentDesktopPage > 0) {
      currentDesktopPage--;
    }
    loadDesktopLayout();
  }
};

// 检查某个槽位是否被自定义小部件组件占用
function getPlacedWidget(type, index) {
  try {
    const placed = JSON.parse(localStorage.getItem(`placed-widgets-${type}`)) || {};
    const realIndex = type === "desktop" ? (currentDesktopPage * DESKTOP_PAGE_SIZE + index) : index;
    const widgetId = placed[realIndex];
    if (widgetId) {
      const widgets = JSON.parse(localStorage.getItem("beautify-widgets")) || {};
      return widgets[widgetId] || null; // 返回整个 widget 对象，包含行高列宽
    }
  } catch(e) {}
  return null;
}
// ============================================================
//  桌面内置卡片（时钟 / 照片 / 横幅 / 搜索条）
//  这些卡片由 renderLayout 直接挂载，不是 HTML 字符串小部件；
//  内容存 localStorage（键前缀 desktop-tile-），重启后仍在，也会随自动备份一起走。
// ============================================================
const TILE_KEY_PREFIX = "desktop-tile-";
const TILE_ICON = {
  plus: '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  image: '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="8.5" cy="9.5" r="1.6"/><path d="M4 17l5-4.5 4 3.5 3-2.5 4 3.5"/></svg>',
  search: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.2-3.2"/></svg>',
  mic: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>',
  trash: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/></svg>'
};

function tileGet(key, fallback) {
  try { const v = localStorage.getItem(TILE_KEY_PREFIX + key); return v === null ? fallback : v; } catch (e) { return fallback; }
}
function tileSet(key, value) {
  try { localStorage.setItem(TILE_KEY_PREFIX + key, value); } catch (e) {}
}
/** 选一张图并压到最长边 maxPx 的 dataURL（PNG 保留透明） */
function tilePickImage(maxPx, cb) {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "image/*";
  input.style.display = "none";
  document.body.appendChild(input);
  input.onchange = () => {
    const file = input.files && input.files[0];
    input.remove();
    if (!file) return;
    const reader = new FileReader();
    reader.onerror = () => { if (typeof showToast === "function") showToast("图片读取失败"); };
    reader.onload = (e) => {
      const img = new Image();
      img.onerror = () => { if (typeof showToast === "function") showToast("图片解析失败"); };
      img.onload = () => {
        try {
          const scale = Math.min(1, maxPx / Math.max(img.width, img.height));
          const w = Math.max(1, Math.round(img.width * scale));
          const h = Math.max(1, Math.round(img.height * scale));
          const cv = document.createElement("canvas");
          cv.width = w; cv.height = h;
          const ctx = cv.getContext("2d");
          ctx.clearRect(0, 0, w, h);
          ctx.drawImage(img, 0, 0, w, h);
          const isPng = /image\/png/i.test(file.type);
          cb(cv.toDataURL(isPng ? "image/png" : "image/jpeg", 0.86));
        } catch (err) { if (typeof showToast === "function") showToast("图片处理失败：" + err.message); }
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  };
  input.click();
}
/** 自制卡片弹层（项目禁止原生弹窗） */
function tileSheet(opts) {
  const mask = document.createElement("div");
  mask.style.cssText = "position:fixed;inset:0;z-index:100900;display:flex;align-items:center;justify-content:center;padding:22px;box-sizing:border-box;background:rgba(15,23,42,.42);backdrop-filter:blur(3px);-webkit-backdrop-filter:blur(3px);";
  mask.innerHTML =
    '<div style="width:100%;max-width:340px;background:#fff;border-radius:24px;padding:18px;box-sizing:border-box;box-shadow:0 24px 60px rgba(15,23,42,.28);">' +
      '<div style="font-size:15px;font-weight:800;color:#1B1B1F;margin-bottom:12px;">' + (opts.title || "") + '</div>' +
      '<div class="tile-sheet-body">' + (opts.body || "") + '</div>' +
      '<div style="display:flex;gap:8px;margin-top:16px;">' +
        '<button data-v="0" style="flex:1;padding:11px;border-radius:14px;border:1.5px solid #E2E2E8;background:#fff;color:#464651;font-size:12.5px;font-weight:800;cursor:pointer;font-family:inherit;">取消</button>' +
        '<button data-v="1" style="flex:1.2;padding:11px;border-radius:14px;border:none;background:#9B87B8;color:#fff;font-size:12.5px;font-weight:800;cursor:pointer;font-family:inherit;">' + (opts.okText || "保存") + '</button>' +
      '</div>' +
    '</div>';
  document.body.appendChild(mask);
  const close = () => mask.remove();
  mask.querySelectorAll("button[data-v]").forEach((b) => {
    b.onclick = () => {
      const ok = b.getAttribute("data-v") === "1";
      if (ok && typeof opts.onOk === "function") opts.onOk(mask);
      close();
    };
  });
  mask.onclick = (e) => { if (e.target === mask) close(); };
  if (typeof opts.onReady === "function") opts.onReady(mask, close);
  return mask;
}

window.desktopTiles = {
  /** 挂载一张卡片，返回容器元素 */
  mount(slot, wData) {
    const type = wData.tile;
    const cfg = wData.config || {};
    slot.classList.add("has-widget");
    const box = document.createElement("div");
    // 同时带上 desktop-widget-container：长按编辑、拖拽落点判定等既有逻辑都认这个类
    box.className = "desktop-widget-container desktop-tile desktop-tile-" + type;
    box.style.cssText = "width:100%;height:100%;box-sizing:border-box;";
    slot.appendChild(box);
    const fn = this[type];
    if (typeof fn === "function") { try { fn.call(this, box, cfg, wData); } catch (e) { console.warn("[桌面卡片]", type, e); } }
    return box;
  },

  /** 大号实时时钟 + 可编辑的一行小字（年月日 / 天气等） */
  clock(box, cfg) {
    const key = "clock-" + (cfg.key || "main");
    box.style.display = "flex";
    box.style.flexDirection = "column";
    box.style.alignItems = "center";
    box.style.justifyContent = "center";
    box.style.gap = "8px";
    box.style.overflow = "hidden";
    box.style.cursor = "pointer";

    const t = document.createElement("div");
    const maxSize = cfg.size || 76;
    t.style.cssText = "font-weight:700;line-height:1;letter-spacing:-0.02em;white-space:nowrap;" +
      "color:" + (cfg.color || "#6B6275") + ";font-variant-numeric:tabular-nums;";
    const sub = document.createElement("div");
    sub.style.cssText = "font-size:12.5px;font-weight:600;letter-spacing:0.04em;color:" + (cfg.subColor || "#A79FAE") +
      ";white-space:nowrap;max-width:100%;overflow:hidden;text-overflow:ellipsis;";
    box.appendChild(t);
    box.appendChild(sub);

    const autoSub = () => {
      const n = new Date();
      const wk = ["日", "一", "二", "三", "四", "五", "六"][n.getDay()];
      return n.getFullYear() + "年" + (n.getMonth() + 1) + "月" + n.getDate() + "日 星期" + wk;
    };
    // 按卡片可用宽度收缩字号：宁可小一点，也不许换行把下面挤走
    const fit = () => {
      const w = box.clientWidth;
      if (!w) return;
      let fs = maxSize;
      t.style.fontSize = fs + "px";
      let guard = 0;
      while (t.scrollWidth > w - 8 && fs > 20 && guard++ < 60) {
        fs -= 2;
        t.style.fontSize = fs + "px";
      }
    };
    const tick = () => {
      if (t.__dead) return;
      const n = new Date();
      t.textContent = String(n.getHours()).padStart(2, "0") + (cfg.colon || ":") + String(n.getMinutes()).padStart(2, "0");
      let data = {};
      try { data = JSON.parse(tileGet(key, "{}")) || {}; } catch (e) { data = {}; }
      const custom = typeof data.sub === "string" ? data.sub.trim() : "";
      sub.textContent = custom || autoSub();
      fit();
      // 首次同步绘制时节点可能还没进 DOM（renderLayout 末尾才 appendChild），
      // 所以只在「已挂载过」之后才用 isConnected 判断是否已被移除并自停。
      if (t.__armed && !t.isConnected) { t.__dead = true; clearInterval(t.__timer); }
    };
    tick();
    requestAnimationFrame(() => { fit(); requestAnimationFrame(fit); });
    t.__armed = true;
    t.__timer = setInterval(tick, 20000);

    box.onclick = (e) => {
      if (isDesktopEditMode) return;
      e.stopPropagation();
      let data = {};
      try { data = JSON.parse(tileGet(key, "{}")) || {}; } catch (e) { data = {}; }
      tileSheet({
        title: "时钟下面的一行小字",
        okText: "保存",
        body:
          '<div style="font-size:11px;font-weight:800;color:#8b8f9c;margin-bottom:6px;">留空则自动显示今天的年月日与星期</div>' +
          '<input id="tile-ck-sub" value="' + String(data.sub || "").replace(/"/g, "&quot;") + '" placeholder="例如：9月9日 · 晴 24℃" style="width:100%;box-sizing:border-box;border:1.5px solid #E8E4EE;border-radius:12px;padding:10px 12px;font-size:13px;font-family:inherit;outline:none;">',
        onOk: (mask) => {
          const v = mask.querySelector("#tile-ck-sub").value.trim().slice(0, 40);
          tileSet(key, JSON.stringify({ sub: v }));
          tick();
          if (typeof showToast === "function") showToast(v ? "已保存" : "已恢复自动日期");
        }
      });
    };
  },

  /** 照片卡片：点击上传并持久保存 */
  photo(box, cfg) {
    const key = "photo-" + (cfg.key || "a");
    const radius = cfg.radius === undefined ? 26 : cfg.radius;
    const wrap = document.createElement("div");
    wrap.style.cssText = "position:relative;width:100%;height:100%;border-radius:" + radius + "px;overflow:hidden;cursor:pointer;" +
      "background:" + (cfg.emptyBg || "rgba(243,238,248,.8)") + ";display:flex;align-items:center;justify-content:center;box-sizing:border-box;";
    const render = () => {
      const src = tileGet(key, "");
      if (src) {
        wrap.innerHTML = '<img src="' + src + '" style="width:100%;height:100%;object-fit:cover;display:block;">' +
          '<div style="position:absolute;left:0;right:0;bottom:0;padding:7px 8px;font-size:10px;font-weight:700;color:#fff;text-align:center;background:linear-gradient(180deg,rgba(15,23,42,0),rgba(15,23,42,.55));">点击更换</div>';
      } else {
        wrap.innerHTML = '<div style="display:flex;flex-direction:column;align-items:center;gap:7px;color:#A08FB8;">' +
          TILE_ICON.plus + '<span style="font-size:11px;font-weight:700;">' + (cfg.hint || "添加照片") + '</span></div>';
      }
    };
    render();
    wrap.onclick = (e) => {
      if (isDesktopEditMode) return;          // 编辑模式下交给拖拽/删除
      e.stopPropagation();
      tilePickImage(cfg.maxPx || 900, (dataUrl) => {
        tileSet(key, dataUrl);
        render();
        if (typeof showToast === "function") showToast("照片已保存");
      });
    };
    box.appendChild(wrap);
  },

  /** 横幅卡片：背景图 + 可编辑标题/副标题 */
  banner(box, cfg) {
    const key = "banner-" + (cfg.key || "main");
    const wrap = document.createElement("div");
    wrap.style.cssText = "position:relative;width:100%;height:100%;border-radius:" + (cfg.radius === undefined ? 28 : cfg.radius) + "px;overflow:hidden;" +
      "background:rgba(243,238,248,.8);display:flex;flex-direction:column;justify-content:flex-end;cursor:pointer;box-sizing:border-box;";
    const render = () => {
      let data = {};
      try { data = JSON.parse(tileGet(key, "{}")) || {}; } catch (e) { data = {}; }
      const title = data.title !== undefined ? data.title : (cfg.title || "");
      const sub = data.sub !== undefined ? data.sub : (cfg.sub || "");
      const img = data.img || "";
      wrap.style.backgroundImage = img ? "url(" + img + ")" : "none";
      wrap.style.backgroundSize = "cover";
      wrap.style.backgroundPosition = "center";
      wrap.innerHTML =
        '<div style="position:absolute;inset:0;background:' + (img ? "linear-gradient(180deg,rgba(15,23,42,.05),rgba(15,23,42,.55))" : "linear-gradient(135deg,#FBEFE3,#EFE6F8)") + ';"></div>' +
        '<div style="position:relative;padding:16px 18px;color:' + (img ? "#fff" : "#1B1B1F") + ';">' +
          '<div style="font-size:20px;font-weight:800;letter-spacing:1px;text-shadow:' + (img ? "0 2px 8px rgba(0,0,0,.35)" : "none") + ';">' + (title || "叙事诗") + '</div>' +
          (sub ? '<div style="font-size:11.5px;margin-top:5px;opacity:.86;line-height:1.5;">' + sub + '</div>' : '') +
        '</div>';
    };
    render();
    wrap.onclick = (e) => {
      if (isDesktopEditMode) return;
      e.stopPropagation();
      let data = {};
      try { data = JSON.parse(tileGet(key, "{}")) || {}; } catch (e) { data = {}; }
      const title = data.title !== undefined ? data.title : (cfg.title || "");
      const sub = data.sub !== undefined ? data.sub : (cfg.sub || "");
      let newImg = data.img || "";
      tileSheet({
        title: "编辑横幅",
        okText: "保存",
        body:
          '<div style="font-size:11px;font-weight:800;color:#64748b;margin-bottom:5px;">标题</div>' +
          '<input id="tile-bn-title" value="' + String(title).replace(/"/g, "&quot;") + '" style="width:100%;box-sizing:border-box;border:1.5px solid #E2E2E8;border-radius:12px;padding:10px 12px;font-size:13px;font-family:inherit;outline:none;margin-bottom:12px;">' +
          '<div style="font-size:11px;font-weight:800;color:#64748b;margin-bottom:5px;">副标题</div>' +
          '<input id="tile-bn-sub" value="' + String(sub).replace(/"/g, "&quot;") + '" style="width:100%;box-sizing:border-box;border:1.5px solid #E2E2E8;border-radius:12px;padding:10px 12px;font-size:13px;font-family:inherit;outline:none;margin-bottom:12px;">' +
          '<div style="display:flex;gap:8px;">' +
            '<button id="tile-bn-pick" style="flex:1;padding:11px;border:1.5px solid #EDE6F2;background:#fff;border-radius:12px;font-size:12px;font-weight:800;color:#9B87B8;cursor:pointer;font-family:inherit;">选择背景图</button>' +
            '<button id="tile-bn-clear" style="flex:1;padding:11px;border:1.5px solid #F9DEDC;background:#fff;border-radius:12px;font-size:12px;font-weight:800;color:#B3261E;cursor:pointer;font-family:inherit;">清除背景</button>' +
          '</div>',
        onReady: (mask) => {
          mask.querySelector("#tile-bn-pick").onclick = () => {
            tilePickImage(1200, (dataUrl) => { newImg = dataUrl; if (typeof showToast === "function") showToast("背景图已选好，点保存生效"); });
          };
          mask.querySelector("#tile-bn-clear").onclick = () => { newImg = ""; };
        },
        onOk: (mask) => {
          const next = {
            title: mask.querySelector("#tile-bn-title").value.slice(0, 24),
            sub: mask.querySelector("#tile-bn-sub").value.slice(0, 40),
            img: newImg
          };
          tileSet(key, JSON.stringify(next));
          render();
          if (typeof showToast === "function") showToast("横幅已保存");
        }
      });
    };
    box.appendChild(wrap);
  },

  /** 搜索条：点一下跳到听歌并聚焦搜索框 */
  search(box, cfg) {
    box.style.display = "flex";
    box.style.alignItems = "center";
    const bar = document.createElement("div");
    bar.style.cssText = "width:100%;height:56px;border-radius:28px;background:#fff;box-shadow:0 3px 12px rgba(55,87,186,.12);" +
      "display:flex;align-items:center;gap:10px;padding:0 18px;box-sizing:border-box;cursor:pointer;color:#464651;";
    bar.innerHTML = '<span style="display:flex;color:#A08FB8;flex-shrink:0;">' + TILE_ICON.search + '</span>' +
      '<span style="flex:1;min-width:0;font-size:13px;color:#9A93A5;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + (cfg.label || "搜索歌曲") + '</span>' +
      '<span style="display:flex;color:#9A93A5;flex-shrink:0;">' + TILE_ICON.mic + '</span>';
    bar.onclick = (e) => {
      if (isDesktopEditMode) return;
      e.stopPropagation();
      try {
        if (typeof openApp === "function") openApp("music");
        setTimeout(() => {
          if (window.musicSystem && typeof window.musicSystem.switchTab === "function") window.musicSystem.switchTab("search");
          const inp = document.getElementById("ncm-search-keyword");
          if (inp) { try { inp.focus(); } catch (err) {} }
        }, 320);
      } catch (err) {}
    };
    box.appendChild(bar);
  }
};

function renderLayout(container, layoutArray, slotClass) {
  container.innerHTML = "";
  
  // 装载桌面图标自定义完美美化数据
  let customIcons = {};
  try {
    customIcons = JSON.parse(localStorage.getItem("beautify-custom-icons")) || {};
  } catch(e) {}

  // 主题图标覆盖（例如「薄秋」主题用设计稿里的 Material Symbols 图标）
  let themeIcons = {};
  try {
    themeIcons = JSON.parse(localStorage.getItem("beautify-icon-overrides")) || {};
  } catch(e) {}

  const isDesktopType = slotClass === "desktop-slot";
  const typeKey = isDesktopType ? "desktop" : "dock";
  const cols = 4;
  const totalCells = layoutArray.length;

  // === 【物理防挤占核心算法】：预先扫描计算所有被大组件覆盖需要跳过渲染的物理 Slot ===
  const skippedIndices = new Set();
  layoutArray.forEach((id, index) => {
    const wData = getPlacedWidget(typeKey, index);
    if (wData) {
      const w = parseInt(wData.widthSpan) || 1;
      const h = parseInt(wData.heightSpan) || 1;
      const row0 = Math.floor(index / cols);
      const col0 = index % cols;

      // 限制组件物理宽度不能溢出屏幕右边界，防止一维数组折行换算导致的排版破坏
      const actualW = Math.min(w, cols - col0);
      const actualH = h;

      for (let r = 0; r < actualH; r++) {
        for (let c = 0; c < actualW; c++) {
          if (r === 0 && c === 0) continue; // 跳过左上角原点，原点是实际挂载组件的容器
          const coveredIndex = (row0 + r) * cols + (col0 + c);
          if (coveredIndex < totalCells) {
            skippedIndices.add(coveredIndex);
          }
        }
      }
    }
  });

  // 2. 依次渲染未被遮盖的 Slot，从物理上消除“挤兑”现象
  layoutArray.forEach((id, index) => {
    // 核心拦截：如果格子被大组件完全遮盖，直接不渲染 DOM，使大组件自然住在上面
    if (skippedIndices.has(index)) {
      return;
    }

    const slot = document.createElement("div");
    slot.className = slotClass;
    slot.setAttribute("data-index", index);
    
    // 检查此网格槽位是否被自定义代码组件挂载
    const wData = getPlacedWidget(typeKey, index);
    if (wData) {
      slot.classList.add("has-widget");
      // 限制组件物理跨度
      const col0 = index % cols;
      const actualW = Math.min(parseInt(wData.widthSpan) || 1, cols - col0);

      slot.style.gridColumn = `span ${actualW}`;
      slot.style.gridRow = `span ${wData.heightSpan || 1}`;

      if (wData.tile && window.desktopTiles) {
        // 内置卡片（时钟/照片/横幅/搜索条）：由运行时直接挂载
        window.desktopTiles.mount(slot, wData);
      } else {
        const widgetDiv = document.createElement("div");
        widgetDiv.className = "desktop-widget-container";
        widgetDiv.innerHTML = wData.html;

        // 强制促使组件内部嵌套 script 在运行态重新注入执行
        const scripts = widgetDiv.querySelectorAll("script");
        scripts.forEach(oldScript => {
          const newScript = document.createElement("script");
          newScript.text = oldScript.innerHTML;
          oldScript.parentNode.replaceChild(newScript, oldScript);
        });

        slot.appendChild(widgetDiv);
      }

      // 编辑模式下显示红色叉号 (去 Emoji 风格)
      if (isDesktopEditMode) {
        const delBtn = document.createElement("button");
        delBtn.className = "widget-delete-badge";
        delBtn.innerHTML = "×";
        delBtn.onclick = (e) => {
          e.stopPropagation();
          removeWidgetFromSlot(typeKey, index);
        };
        slot.appendChild(delBtn);
      }
    } else if (id) {
      const info = DESKTOP_APPS_CONFIG[id];
      if (info) {
        const div = document.createElement("div");
        div.className = "app-icon";
        div.setAttribute("data-app", id);
        
        // 渲染美化过或原生的图标（主题可以覆盖图标：beautify-icon-overrides，如「薄秋」用的 Material Symbols）
        const customImg = customIcons[id];
        const themeIcon = (themeIcons && themeIcons[id]) || null;
        const iconHtml = customImg ? `<img src="${customImg}" class="custom-icon-img" style="width:100%; height:100%; object-fit:cover; border-radius:18px;">` : (themeIcon || info.svg);

        // 核心：若为 Dock 栏图标，直接过滤擦除 Span 文本标签，仅保留 icon-wrapper 的 SVG 渲染
        const nameHtml = isDesktopType ? `<span>${info.name}</span>` : "";

        div.innerHTML = `
          <div class="icon-wrapper">${iconHtml}</div>
          ${nameHtml}
        `;
        slot.appendChild(div);

        // 编辑模式下应用支持红叉删除卸载 (系统应用卸载)
        if (isDesktopEditMode) {
          const delBtn = document.createElement("button");
          delBtn.className = "widget-delete-badge";
          delBtn.innerHTML = "×";
          delBtn.onclick = (e) => {
            e.stopPropagation();
            removeAppFromSlot(typeKey, index);
          };
          slot.appendChild(delBtn);
        }
      }
    } else {
      // 编辑模式下的空槽位显示绿色加号，用于添加系统应用或自定义小组件
      if (isDesktopEditMode) {
        const addBtn = document.createElement("button");
        addBtn.className = "widget-add-badge";
        addBtn.innerHTML = "+";
        addBtn.onclick = (e) => {
          e.stopPropagation();
          openAddSelector(typeKey, index);
        };
        slot.appendChild(addBtn);
      }
    }
    container.appendChild(slot);
  });
}

let lastPointerDownX = 0;
let lastPointerDownY = 0;
document.addEventListener("pointerdown", (e) => {
  lastPointerDownX = e.clientX;
  lastPointerDownY = e.clientY;
});

function initAppClickEvents() {
  if (isAppClickEventsInitialized) return;
  isAppClickEventsInitialized = true;

  document.body.addEventListener("click", (e) => {
    // 如果手指按下和抬起之间的位移超过 15px，判定为滑动操作，直接忽略点击
    const dist = Math.hypot(e.clientX - lastPointerDownX, e.clientY - lastPointerDownY);
    if (dist > 15) return;

    // 编辑模式下，点击任何外部区域自动安全退出编辑模式
    if (isDesktopEditMode) {
      if (!e.target.closest(".widget-add-badge") && !e.target.closest(".widget-delete-badge") && !e.target.closest(".app-icon")) {
        exitDesktopEditMode();
        return;
      }
    }

    const icon = e.target.closest(".app-icon");
    if (icon) {
      const app = icon.getAttribute("data-app");
      // 仅当图标没有处于被拖拽移动的状态时，才触发应用开启
      if (icon.style.position !== "fixed") {
        openApp(app);
      }
    }
  });
}

function openApp(app) {
  const win = document.getElementById(`win-${app}`);
  if (win) {
    // 跳转前先关闭其他所有 active 的应用窗口（等同于先回主页面再跳转目标页）
    // 修复层级问题：从聊天点档案馆/深谈跳不过去、小助手全屏被遮挡等
    document.querySelectorAll(".app-window.active").forEach(function (w) {
      if (w !== win) w.classList.remove("active");
    });
    win.classList.add("active");
    updateThemeColor("#f4f6fa");
    
    // 安全防御：在全局环境检测初始化函数是否存在，100% 避免 reference 报错引发的脚本假死
    if (app === 'settings' && typeof initSettingsApp === 'function') initSettingsApp();
    if (app === 'archive' && typeof initArchiveApp === 'function') initArchiveApp();
    if (app === 'world_book' && typeof initWorldBookApp === 'function') initWorldBookApp(); 
    if (app === 'chat' && typeof initChatApp === 'function') initChatApp();
    if (app === 'deeptalk' && typeof initDeeptalkApp === 'function') initDeeptalkApp();
    if (app === 'reader' && typeof initReaderApp === 'function') initReaderApp();
    if (app === 'forum' && typeof initForumApp === 'function') initForumApp();
    if (app === 'couples' && typeof initCouplesApp === 'function') initCouplesApp();
    if (app === 'music' && typeof initMusicApp === 'function') initMusicApp();
    if (app === 'shopping' && typeof initShoppingApp === 'function') initShoppingApp();
    if (app === 'encounter' && typeof initEncounterApp === 'function') initEncounterApp();
    if (app === 'quicktravel' && typeof initQuickTravelApp === 'function') initQuickTravelApp();
    if (app === 'workbench' && typeof initWorkbenchApp === 'function') initWorkbenchApp();
    if (app === 'yigui' && typeof initYiguiApp === 'function') initYiguiApp();
  }
}

function closeApp(app) {
  const win = document.getElementById(`win-${app}`);
  if (win) {
    win.classList.remove("active");
    updateThemeColor("#f4f6fa");
  }
}

// 采用 Pointer Events 触控/鼠标完美居中跟手拖拽及双向换位
function initDragEvents() {
  if (isDragEventsInitialized) return;
  isDragEventsInitialized = true;

  let activeIcon = null;
  let startX = 0;
  let startY = 0;
  let lastMoveX = 0; // 动态变量：记录手指最新的移动坐标，破解闭包限制
  let lastMoveY = 0;
  let iconStartX = 0;
  let iconStartY = 0;
  let rectWidth = 0;
  let rectHeight = 0;
  let isDragging = false;
  let originalParent = null;
  let dragPlaceholder = null;
  let longPressTimer = null; // 用于侦测长按阶段1 (1s)
  let longPressTimer2 = null; // 用于侦测长按阶段2 (0.5s)
  let longPressTarget = null; // 缓存当前长按的DOM节点以进行视觉反馈

  document.addEventListener("pointerdown", (e) => {
        const icon = e.target.closest(".app-icon");
        const widget = e.target.closest(".desktop-widget-container");

        // 1. 如果不在编辑模式，只侦测长按以进入编辑模式，绝对不触发拖拽
        if (!isDesktopEditMode) {
          if (longPressTimer) clearTimeout(longPressTimer);
          if (longPressTimer2) clearTimeout(longPressTimer2);
          if (longPressTarget) {
            longPressTarget.style.transform = "";
            longPressTarget.style.transition = "";
            longPressTarget = null;
          }

          if (icon || widget) {
            startX = e.clientX;
            startY = e.clientY;
            lastMoveX = e.clientX; // 初始化最新坐标
            lastMoveY = e.clientY;
            longPressTarget = icon || widget;
            
            // 改进：单级高抗干扰定时器，1.2秒后直接校验动态位移决定是否进入编辑模式
            longPressTimer = setTimeout(() => {
              const dx = lastMoveX - startX;
              const dy = lastMoveY - startY;
              // 容差过滤：手指位移小于10px才判定为真长按，避免误触
              if (Math.abs(dx) < 10 && Math.abs(dy) < 10 && !isDesktopEditMode) {
                enterDesktopEditMode();
              }
              longPressTimer = null;
            }, 1200);
          }
          return; // 拦截！未进入编辑模式时，严禁初始化任何拖动及变量赋值
        }

        // 2. 如果已经在编辑模式，直接触发拖动重排逻辑，且无需重复侦测长按
        if (!icon) return;
        
        // 核心安全防御：若图标此时已脱离网格存在于 body 层（如上一次拖拽非正常中断），绝对拦截其重入 pointerdown
        const parentSlot = icon.parentNode;
        if (!parentSlot || (!parentSlot.classList.contains("desktop-slot") && !parentSlot.classList.contains("dock-slot"))) {
          return;
        }

        activeIcon = icon;
        
        if (e.target.setPointerCapture) {
          e.target.setPointerCapture(e.pointerId);
        }

        const rect = activeIcon.getBoundingClientRect();
        startX = e.clientX;
        startY = e.clientY;
        iconStartX = rect.left;
        iconStartY = rect.top;
        rectWidth = rect.width;
        rectHeight = rect.height;
        originalParent = activeIcon.parentNode;
        isDragging = false;
      });

  document.addEventListener("pointermove", (e) => {
    // 持续向动态变量投递最新的坐标，解决定时器闭包只取旧值的问题
    lastMoveX = e.clientX;
    lastMoveY = e.clientY;

    const dx = e.clientX - startX;
    const dy = e.clientY - startY;

    // 改进：一旦位移超出颤动阈值（10px），立刻在滑动第一步销毁定时器，防止事件漏发
    if (Math.abs(dx) > 10 || Math.abs(dy) > 10) {
      if (longPressTimer) {
        clearTimeout(longPressTimer);
        longPressTimer = null;
      }
      if (longPressTimer2) {
        clearTimeout(longPressTimer2);
        longPressTimer2 = null;
      }
      if (longPressTarget) {
        longPressTarget.style.transform = "";
        longPressTarget.style.transition = "";
        longPressTarget = null;
      }
    }

    if (!activeIcon) return;

    if (!isDragging && (Math.abs(dx) > 8 || Math.abs(dy) > 8)) {
      isDragging = true;
      activeIcon.classList.add("dragging");

      // 建立占位符，防止网格崩塌
      dragPlaceholder = document.createElement("div");
      dragPlaceholder.className = "app-icon-placeholder";
      dragPlaceholder.style.width = rectWidth + "px";
      dragPlaceholder.style.height = rectHeight + "px";
      originalParent.insertBefore(dragPlaceholder, activeIcon);

      // 核心修复：开启拖动时，将图标临时剪切追加到 #phone-container 顶层图层上！
      // 这将完美避开 Dock 栏 .dock-container 的 backdrop-filter 的 Containing Block 限制
      // 同时也避开了 body 层 flexbox 布局对图标尺寸的强制拉伸，一箭双雕！
      const phoneContainer = document.getElementById("phone-container");
      if (phoneContainer) {
        phoneContainer.appendChild(activeIcon);
      }

      activeIcon.style.position = "absolute";
      activeIcon.style.width = (rectWidth || 72) + "px"; // 跟随当前网格格子宽度（4 列 × 7 行自适应）
      activeIcon.style.height = "auto";
      activeIcon.style.zIndex = "9999";
      activeIcon.style.pointerEvents = "none"; 
    }

    if (isDragging) {
      // 核心优化：让图标 1:1 结合 #phone-container 的绝对坐标，实现高精度非弹性跟随
      const phoneContainer = document.getElementById("phone-container");
      const phoneRect = phoneContainer ? phoneContainer.getBoundingClientRect() : { left: 0, top: 0 };
      const halfW = (rectWidth || 72) / 2;
      const halfH = (rectHeight || 84) / 2;
      activeIcon.style.left = (e.clientX - phoneRect.left - halfW) + "px";
      activeIcon.style.top = (e.clientY - phoneRect.top - halfH) + "px";

      // 动态获取划过处的网格槽
      const targetElement = document.elementFromPoint(e.clientX, e.clientY);
      let hoveredSlot = null;
      if (targetElement) {
        hoveredSlot = targetElement.closest(".desktop-slot") || targetElement.closest(".dock-slot");
      }

      // 重置并单独给悬停网格槽添加微亮指示器
      document.querySelectorAll(".desktop-slot, .dock-slot").forEach(slot => {
        slot.classList.remove("drag-over");
      });

      if (hoveredSlot) {
        hoveredSlot.classList.add("drag-over");
      }
    }
  });

  document.addEventListener("pointerup", (e) => {
        if (longPressTimer) clearTimeout(longPressTimer);
        if (longPressTimer2) clearTimeout(longPressTimer2);
        if (longPressTarget) {
          longPressTarget.style.transform = "";
          longPressTarget.style.transition = "";
          longPressTarget = null;
        }
        if (!activeIcon) return;

        if (isDragging) {
          activeIcon.classList.remove("dragging");
          if (dragPlaceholder) {
            dragPlaceholder.remove();
          }

          // 精确获取落点处的网格槽
          const targetElement = document.elementFromPoint(e.clientX, e.clientY);
          let dropSlot = null;
          if (targetElement) {
            dropSlot = targetElement.closest(".desktop-slot") || targetElement.closest(".dock-slot");
          }

          // 清空所有的槽位高亮
          document.querySelectorAll(".desktop-slot, .dock-slot").forEach(slot => {
            slot.classList.remove("drag-over");
          });

          // 还原所有的 inline 拖拽尺寸和定位属性
          activeIcon.style.position = "";
          activeIcon.style.width = "";
          activeIcon.style.height = "";
          activeIcon.style.left = "";
          activeIcon.style.top = "";
          activeIcon.style.zIndex = "";
          activeIcon.style.pointerEvents = "";

          if (dropSlot) {
            const existingIcon = dropSlot.querySelector(".app-icon");
            const existingWidget = dropSlot.querySelector(".desktop-widget-container");

            // 槽位上如果是已存在图标，进行互互相对调；如果是代码组件，禁止对调回归原位
            if (existingIcon) {
              originalParent.appendChild(existingIcon);
              dropSlot.appendChild(activeIcon);
            } else if (existingWidget) {
              originalParent.appendChild(activeIcon);
            } else {
              dropSlot.appendChild(activeIcon);
            }
            saveLayoutsToLocal();
            loadDesktopLayout(); // 存盘后立刻重绘网格，消除残存DOM状态与增殖冗余
          } else {
            originalParent.appendChild(activeIcon);
            loadDesktopLayout(); // 归位后立即进行自愈式网格重绘
          }
        }

        activeIcon = null;
        isDragging = false;
        dragPlaceholder = null;
      });

  // 安全防御：当系统发出硬件或系统级的 pointercancel 信号时，必须安全销毁并还原所有进行中的长按定时器和拖拽状态
  document.addEventListener("pointercancel", (e) => {
    if (longPressTimer) {
      clearTimeout(longPressTimer);
      longPressTimer = null;
    }
    if (longPressTimer2) {
      clearTimeout(longPressTimer2);
      longPressTimer2 = null;
    }
    if (longPressTarget) {
      longPressTarget.style.transform = "";
      longPressTarget.style.transition = "";
      longPressTarget = null;
    }
    if (activeIcon) {
      if (isDragging) {
        activeIcon.classList.remove("dragging");
        if (dragPlaceholder) {
          dragPlaceholder.remove();
        }
        // 还原所有的拖拽 inline 属性并安全归位，打消由于手势中断引发的图标凭空丢失
        activeIcon.style.position = "";
        activeIcon.style.width = "";
        activeIcon.style.height = "";
        activeIcon.style.left = "";
        activeIcon.style.top = "";
        activeIcon.style.zIndex = "";
        activeIcon.style.pointerEvents = "";
        originalParent.appendChild(activeIcon);
        loadDesktopLayout();
      }
      activeIcon = null;
      isDragging = false;
      dragPlaceholder = null;
    }
  });
}

// 桌面滑屏翻页控制引擎 (一次仅翻一页)
function initDesktopSwipeEvents() {
  const desktop = document.getElementById("desktop");
  if (!desktop) return;

  let swipeStartX = 0;
  let swipeStartY = 0;
  let isSwipingDesktop = false;

  desktop.addEventListener("pointerdown", (e) => {
    // 编辑模式下才过滤图标和组件（因为需要拖拽），普通模式下允许从图标上开始滑动翻页
    if (isDesktopEditMode) {
      if (
        e.target.closest(".app-icon") || 
        e.target.closest(".desktop-widget-container") || 
        e.target.closest("button") || 
        e.target.closest(".widget-add-badge") || 
        e.target.closest(".widget-delete-badge")
      ) {
        return;
      }
    } else {
      // 普通模式下仅过滤点击按钮
      if (
        e.target.closest("button") || 
        e.target.closest(".widget-add-badge") || 
        e.target.closest(".widget-delete-badge")
      ) {
        return;
      }
    }
    isSwipingDesktop = true;
    swipeStartX = e.clientX;
    swipeStartY = e.clientY;
  });

  // 改在 document 上全局监听 pointerup 和 pointercancel，彻底解决滑动出界、滑动到其他节点上导致 pointerup 不触发的顽疾！
  document.addEventListener("pointerup", (e) => {
    if (!isSwipingDesktop) return;
    isSwipingDesktop = false;

    const deltaX = e.clientX - swipeStartX;
    const deltaY = e.clientY - swipeStartY;

    // 严防斜向无意识滑动干扰，限制 Y 轴偏离值在安全容错范围内
    if (Math.abs(deltaY) < 80) {
      let desktopLayout = [];
      try {
        desktopLayout = JSON.parse(localStorage.getItem("desktop-layout-v3")) || [];
      } catch (err) {}
      const pageCount = Math.max(1, Math.ceil(desktopLayout.length / DESKTOP_PAGE_SIZE));

      if (deltaX < -50) {
        // 向左滑 -> 进入下一页
        if (currentDesktopPage < pageCount - 1) {
          currentDesktopPage++;
          loadDesktopLayout();
        }
      } else if (deltaX > 50) {
        // 向右滑 -> 进入上一页
        if (currentDesktopPage > 0) {
          currentDesktopPage--;
          loadDesktopLayout();
        }
      }
    }
  });

  // 核心阻断：向整个桌面绑定 touchmove 的拦截器，并强行阻断默认回弹，确保真机 pointermove 的手势事件不被系统蚕食丢包 [1]
  desktop.addEventListener("touchmove", (e) => {
    if (isSwipingDesktop) {
      e.preventDefault();
    }
  }, { passive: false });

  document.addEventListener("pointercancel", () => {
    isSwipingDesktop = false;
  });
}

function saveLayoutsToLocal() {
  const desktopSlots = Array.from(document.getElementById("desktop-grid").children);
  let desktopLayout = JSON.parse(localStorage.getItem("desktop-layout-v3")) || [];
  const pageCount = Math.max(1, Math.ceil(desktopLayout.length / DESKTOP_PAGE_SIZE));
  
  while (desktopLayout.length < pageCount * DESKTOP_PAGE_SIZE) {
    desktopLayout.push(null);
  }

  const pageStart = currentDesktopPage * DESKTOP_PAGE_SIZE;
  for (let i = 0; i < DESKTOP_PAGE_SIZE; i++) {
    desktopLayout[pageStart + i] = null;
  }
  
  // === 【物理对齐存盘校正】：通过 slot 的 data-index 属性反查真实索引，防止由于跳过 DOM 节点导致的整体缩水 ===
  desktopSlots.forEach(slot => {
    const index = parseInt(slot.getAttribute("data-index"));
    if (!isNaN(index) && index < DESKTOP_PAGE_SIZE) {
      const icon = slot.querySelector(".app-icon");
      desktopLayout[pageStart + index] = icon ? icon.getAttribute("data-app") : null;
    }
  });

  const dockSlots = Array.from(document.getElementById("dock-grid").children);
  const dockLayout = Array(4).fill(null);
  dockSlots.forEach(slot => {
    const index = parseInt(slot.getAttribute("data-index"));
    if (!isNaN(index) && index < 4) {
      const icon = slot.querySelector(".app-icon");
      dockLayout[index] = icon ? icon.getAttribute("data-app") : null;
    }
  });

  // 独立保存高吸附性网格版本的布局数据
  localStorage.setItem("desktop-layout-v3", JSON.stringify(desktopLayout));
  localStorage.setItem("dock-layout-v3", JSON.stringify(dockLayout));
}

// ==========================================
// 桌面编辑模式控制中心与组件动态增/删逻辑
// ==========================================
function enterDesktopEditMode() {
  if (isDesktopEditMode) return;
  isDesktopEditMode = true;
  const phone = document.getElementById("phone-container");
  if (phone) {
    phone.classList.add("edit-mode");
  }
  loadDesktopLayout();
}

function exitDesktopEditMode() {
  isDesktopEditMode = false;
  const phone = document.getElementById("phone-container");
  if (phone) {
    phone.classList.remove("edit-mode");
  }
  loadDesktopLayout();
}

// 判断某个系统应用是否已经被摆放在桌面或 Dock 栏，防止重复实例增殖
function isAppAlreadyPlaced(appId) {
  let desktopLayout = [];
  let dockLayout = [];
  try {
    desktopLayout = JSON.parse(localStorage.getItem("desktop-layout-v3")) || [];
    dockLayout = JSON.parse(localStorage.getItem("dock-layout-v3")) || [];
  } catch(e) {}
  return desktopLayout.includes(appId) || dockLayout.includes(appId);
}

// 唤起选择添加系统应用或小部件的选择弹层 (去 Emoji，全 SVG 美化)
function openAddSelector(type, slotIndex) {
  let widgets = {};
  try {
    widgets = JSON.parse(localStorage.getItem("beautify-widgets")) || {};
  } catch(e) {}

  const widgetIds = Object.keys(widgets);
  const appsList = ["encounter", "settings", "archive", "world_book", "chat", "deeptalk", "reader", "forum", "couples", "music", "shopping", "quicktravel", "workbench", "yigui"];

  let html = `<div style="padding:16px;">
    <h4 style="margin:0 0 12px;font-size:14px;font-weight:700;text-align:center;">选择要添加的内容</h4>

    <!-- 1. 系统应用摆放 -->
    <div style="display:flex; flex-direction:column; gap:6px; margin-bottom:16px; max-height:120px; overflow-y:auto;">`;

  let appAddedCount = 0;
  appsList.forEach(appId => {
    if (!isAppAlreadyPlaced(appId)) {
      let name = "";
      if (appId === "settings") name = "设置";
      else if (appId === "archive") name = "档案库";
      else if (appId === "world_book") name = "世界书";
      else if (appId === "chat") name = "聊天";
      else if (appId === "deeptalk") name = "深谈";
      else if (appId === "reader") name = "阅读";
      else if (appId === "forum") name = "论坛";
      else if (appId === "couples") name = "情侣空间";
      else if (appId === "music") name = "听歌";
      else if (appId === "shopping") name = "购物";
      else if (appId === "encounter") name = "邂逅";
      else if (appId === "quicktravel") name = "快穿局";
      else if (appId === "workbench") name = "工作台";
      else if (appId === "yigui") name = "仪轨";

      html += `
        <button onclick="placeAppOnSlot('${type}', ${slotIndex}, '${appId}')" style="width:100%; padding:8px 10px; border-radius:10px; border:1px solid #e2e8f0; background:#f8fafc; font-size:12px; font-weight:600; text-align:left; cursor:pointer; display:flex; align-items:center; gap:6px;">
          <svg viewBox="0 0 24 24" width="14" height="14" style="flex-shrink:0;"><circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="4" fill="currentColor"/></svg>
          ${name}
        </button>
      `;
      appAddedCount++;
    }
  });

  if (appAddedCount === 0) {
    html += `<div style="text-align:center; font-size:11px; color:#94a3b8; padding:10px 0;">所有系统应用都已摆放在桌面上</div>`;
  }

  html += `</div>
    
    <!-- 2. 自定义桌面组件 -->
    <div style="font-size:11px; font-weight:700; color:var(--text-secondary); margin-bottom:6px; border-bottom:1px solid #f1f5f9; padding-bottom:2px;">添加组件工坊小部件</div>
    <div style="display:flex; flex-direction:column; gap:6px; max-height:150px; overflow-y:auto;">`;

  if (widgetIds.length === 0) {
    html += `<div style="text-align:center; font-size:11px; color:#94a3b8; padding:10px 0;">暂无组件，请去设置内创建</div>`;
  } else {
    widgetIds.forEach(id => {
      html += `
        <button onclick="placeWidgetOnSlot('${type}', ${slotIndex}, '${id}')" style="width:100%; padding:8px 10px; border-radius:10px; border:1px solid #e2e8f0; background:#f8fafc; font-size:12px; font-weight:600; text-align:left; cursor:pointer; display:flex; align-items:center; gap:6px;">
          <svg viewBox="0 0 24 24" width="14" height="14" style="flex-shrink:0;"><path fill="currentColor" d="M12 2L2 7l10 5 10-5-10-5zM2 9v7.5c0 .8.6 1.5 1.4 1.7l8.6 3.1v-7.3L2 9zm18 0l-10 5v7.3l8.6-3.1c.8-.2 1.4-.9 1.4-1.7V9z"/></svg>
          ${widgets[id].name} (${widgets[id].widthSpan || 1}x${widgets[id].heightSpan || 1})
        </button>
      `;
    });
  }

  html += `</div>
    <button onclick="closeWidgetSelectorModal()" style="margin-top:14px; width:100%; padding:10px; border-radius:10px; border:none; background:#ef4444; color:white; font-size:12px; font-weight:600; cursor:pointer;">取消</button>
  </div>`;

  let overlay = document.getElementById("widget-select-overlay");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = "widget-select-overlay";
    overlay.className = "modal-overlay";
    document.getElementById("phone-container").appendChild(overlay);
  }
  overlay.innerHTML = `<div class="modal" style="max-width:300px; border-radius:16px; margin:auto; background:white;">${html}</div>`;
  overlay.classList.add("active");
}

window.placeAppOnSlot = function(type, slotIndex, appId) {
  try {
    let layout = JSON.parse(localStorage.getItem(`${type}-layout-v3`)) || Array(type === "desktop" ? DESKTOP_PAGE_SIZE : 4).fill(null);
    const realIndex = type === "desktop" ? (currentDesktopPage * DESKTOP_PAGE_SIZE + slotIndex) : slotIndex;
    while (layout.length <= realIndex) {
      layout.push(null);
    }
    layout[realIndex] = appId;
    localStorage.setItem(`${type}-layout-v3`, JSON.stringify(layout));
  } catch(e) {}
  
  closeWidgetSelectorModal();
  exitDesktopEditMode();
};

window.placeWidgetOnSlot = function(type, slotIndex, widgetId) {
  try {
    const placed = JSON.parse(localStorage.getItem(`placed-widgets-${type}`)) || {};
    const realIndex = type === "desktop" ? (currentDesktopPage * DESKTOP_PAGE_SIZE + slotIndex) : slotIndex;
    placed[realIndex] = widgetId;
    localStorage.setItem(`placed-widgets-${type}`, JSON.stringify(placed));
  } catch(e) {}
  
  closeWidgetSelectorModal();
  exitDesktopEditMode();
};

window.closeWidgetSelectorModal = function() {
  const overlay = document.getElementById("widget-select-overlay");
  if (overlay) overlay.classList.remove("active");
};

function removeWidgetFromSlot(type, slotIndex) {
  if (confirm("确定要从该网格中删除此组件吗？")) {
    try {
      const placed = JSON.parse(localStorage.getItem(`placed-widgets-${type}`)) || {};
      const realIndex = type === "desktop" ? (currentDesktopPage * DESKTOP_PAGE_SIZE + slotIndex) : slotIndex;
      delete placed[realIndex];
      localStorage.setItem(`placed-widgets-${type}`, JSON.stringify(placed));
    } catch(e) {}
    exitDesktopEditMode();
  }
}

function removeAppFromSlot(type, slotIndex) {
  if (confirm("确定要将此应用从当前槽位中移除吗？您随时可以长按点击空白网格的加号重新放回桌面。")) {
    try {
      let layout = JSON.parse(localStorage.getItem(`${type}-layout-v3`)) || Array(type === "desktop" ? DESKTOP_PAGE_SIZE : 4).fill(null);
      const realIndex = type === "desktop" ? (currentDesktopPage * DESKTOP_PAGE_SIZE + slotIndex) : slotIndex;
      while (layout.length <= realIndex) {
        layout.push(null);
      }
      layout[realIndex] = null;
      localStorage.setItem(`${type}-layout-v3`, JSON.stringify(layout));
    } catch(e) {}
    exitDesktopEditMode();
  }
}

// 绑定阅读应用专属退出逻辑
function closeReaderRoom() {
  if (window.readerSystem && window.readerSystem.exitReadingRoom) {
    window.readerSystem.exitReadingRoom();
  }
}

// ============================================================
//  修复：编辑组件文字（contenteditable，如拍立得标题）时，
//  浏览器会自动滚动焦点元素到可见位置，导致 #desktop 向上抬起且无法恢复。
//  在聚焦后立即恢复桌面滚动位置，保证桌面纹丝不动。
// ============================================================
document.addEventListener("focusin", (e) => {
  const t = e.target;
  if (!t || !t.isContentEditable) return;
  const scroller = document.getElementById("desktop");
  if (!scroller) return;
  const saved = scroller.scrollTop;
  // 浏览器在聚焦默认动作阶段才会执行自动滚动，故在下一帧（滚动完成后）恢复原位
  requestAnimationFrame(() => {
    if (scroller.scrollTop !== saved) scroller.scrollTop = saved;
  });
});
