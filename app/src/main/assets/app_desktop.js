/**
 * app_desktop.js - 桌面网格、桌面美化、组件工坊宽高占位自适应与长按编辑 (重构避让与无冲突版)
 */

let isDesktopEditMode = false;
let currentDesktopPage = 0;

// 核心初始化保护锁，彻底杜绝重复绑定事件
let isDragEventsInitialized = false;
let isAppClickEventsInitialized = false;

// 全局手势物理状态追踪，用以区分微颤点击与大位移滑动
let lastPointerDownX = 0;
let lastPointerDownY = 0;
let lastMoveX = 0;
let lastMoveY = 0;
let longPressTimer = null;
let longPressTarget = null;

// 1. 主动注入网格槽位、长按编辑模式微章 CSS 规范样式
(function() {
  const desktopDragStyle = document.createElement("style");
  desktopDragStyle.textContent = `
    #desktop-grid {
      display: grid !important;
      grid-template-columns: repeat(4, 1fr) !important;
      grid-template-rows: repeat(5, 1fr) !important;
      gap: 16px 12px !important;
      min-height: auto !important;
    }
    #dock-grid {
      display: grid !important;
      grid-template-columns: repeat(4, 1fr) !important;
      gap: 12px !important;
      align-items: center !important;
      width: 100% !important;
    }
    
    /* 桌面和 Dock 的专属网格槽 */
    .desktop-slot, .dock-slot {
      display: flex !important;
      justify-content: center !important;
      align-items: center !important;
      width: 100% !important;
      aspect-ratio: 4 / 5 !important; /* 黄金比例锁 */
      border-radius: 18px !important;
      transition: background-color 0.15s ease, border-color 0.15s ease !important;
      box-sizing: border-box !important;
      border: 1.5px dashed transparent !important;
      position: relative !important;
    }

    /* 当槽位摆放了自定义小部件组件时，解除比例限制 */
    .desktop-slot.has-widget {
      aspect-ratio: auto !important;
      height: 100% !important;
    }
    
    /* 拖拽悬浮过网格槽时的微高亮虚线提示 */
    .desktop-slot.drag-over, .dock-slot.drag-over {
      background-color: rgba(255, 255, 255, 0.15) !important;
      border-color: rgba(255, 255, 255, 0.4) !important;
    }
    
    .app-icon {
      user-select: none !important;
      -webkit-user-select: none !important;
      -webkit-user-drag: none !important;
    }
    /* 核心避让：仅在编辑模式下才阻断浏览器原生滑动手势，普通模式下完全不拦截触控滑动 */
    .edit-mode .app-icon {
      touch-action: none !important; 
      cursor: grab;
    }
    .app-icon.dragging {
      opacity: 0.82;
      transform: scale(1.15) !important;
      box-shadow: 0 10px 25px rgba(0,0,0,0.2) !important;
      transition: none !important;
    }
    .app-icon-placeholder {
      opacity: 0 !important;
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
  // PWA 安全注册
  if ('serviceWorker' in navigator) {
    if (localStorage.getItem("system-force-update") === "true") {
      navigator.serviceWorker.getRegistrations().then(registrations => {
        for (let reg of registrations) {
          reg.unregister();
        }
      });
    } else {
      navigator.serviceWorker.register('./sw.js')
        .then(() => console.log("PWA SW Online!"))
        .catch((e) => console.error("SW failed", e));
    }
  }

  // 记录基础全局按下位置，预防点击滑动冲突
  document.addEventListener("pointerdown", (e) => {
    lastPointerDownX = e.clientX;
    lastPointerDownY = e.clientY;
  });

  loadDesktopLayout();
  initAppClickEvents();
  initDragEvents();
  initDesktopSwipeEvents(); 
  
  applyGlobalSettingsOnLoad();
  updateThemeColor("#f4f6fa");
  initBrowserFullscreenTrigger();
});

// 应用壁纸与全局注入 CSS 的渲染挂载
function applyGlobalSettingsOnLoad() {
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

  const opacity = localStorage.getItem("beautify-dock-opacity") || "70";
  const dockContainer = document.querySelector(".dock-container");
  if (dockContainer) {
    dockContainer.style.setProperty("background-color", `rgba(255, 255, 255, ${parseFloat(opacity) / 100})`, "important");
  }

  const activeCss = localStorage.getItem("beautify-active-css") || "";
  let styleTag = document.getElementById("global-injected-css");
  if (!styleTag) {
    styleTag = document.createElement("style");
    styleTag.id = "global-injected-css";
    document.head.appendChild(styleTag);
  }
  styleTag.textContent = activeCss;
}

// 浏览器全屏自锁
function initBrowserFullscreenTrigger() {
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone;
  
  if (!isStandalone) {
    const requestFullscreenMode = () => {
      const docEl = document.documentElement;
      let fullscreenPromise = null;
      try {
        if (docEl.requestFullscreen) {
          fullscreenPromise = docEl.requestFullscreen();
        } else if (docEl.webkitRequestFullscreen) {
          fullscreenPromise = docEl.webkitRequestFullscreen();
        } else if (docEl.mozRequestFullScreen) {
          fullscreenPromise = docEl.mozRequestFullScreen();
        } else if (docEl.msRequestFullscreen) {
          fullscreenPromise = docEl.msRequestFullscreen();
        }

        if (fullscreenPromise && typeof fullscreenPromise.catch === 'function') {
          fullscreenPromise.catch(err => {
            console.warn("全屏申请被安全机制拦截:", err);
          });
        }
      } catch (err) {
        console.warn("全屏机制拦截:", err);
      }
      
      document.body.removeEventListener('click', requestFullscreenMode);
      document.body.removeEventListener('touchstart', requestFullscreenMode);
    };
    
    document.body.addEventListener('click', requestFullscreenMode);
    document.body.addEventListener('touchstart', requestFullscreenMode);
  }
}

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
  deeptalk: { name: "深谈", svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><path d="M8 10h.01"/><path d="M12 10h.01"/><path d="M16 10h.01"/></svg>' }
};

function loadDesktopLayout() {
  const grid = document.getElementById("desktop-grid");
  const dock = document.getElementById("dock-grid");

  let desktopLayout = JSON.parse(localStorage.getItem("desktop-layout-v3"));
  if (!desktopLayout || !Array.isArray(desktopLayout)) {
    const oldLayout = JSON.parse(localStorage.getItem("desktop-layout"));
    desktopLayout = Array(20).fill(null);
    if (oldLayout && Array.isArray(oldLayout)) {
      oldLayout.forEach((id, idx) => {
        if (idx < 20) desktopLayout[idx] = id;
      });
    } else {
      desktopLayout[0] = 'settings';
      desktopLayout[1] = 'archive';
      desktopLayout[2] = 'world_book';
      desktopLayout[3] = 'deeptalk';
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
    } else {
      dockLayout[0] = 'chat';
    }
  }

  const pageCount = Math.max(1, Math.ceil(desktopLayout.length / 20));
  if (currentDesktopPage >= pageCount) {
    currentDesktopPage = pageCount - 1;
  }
  
  const pageStart = currentDesktopPage * 20;
  const pageLayout = desktopLayout.slice(pageStart, pageStart + 20);
  while (pageLayout.length < 20) {
    pageLayout.push(null);
  }

  renderLayout(grid, pageLayout, "desktop-slot");
  renderLayout(dock, dockLayout, "dock-slot");
  renderPageIndicator(pageCount);

  // 编辑模式：判断空白页并渲染右上角“删除此页?”按钮
  let delBtn = document.getElementById("btn-delete-page-indicator");
  if (delBtn) delBtn.remove();

  if (isDesktopEditMode && pageCount > 1) {
    let isPageBlank = true;
    for (let i = 0; i < 20; i++) {
      if (pageLayout[i] !== null) {
        isPageBlank = false;
        break;
      }
      if (getPlacedWidget("desktop", i) !== null) {
        isPageBlank = false;
        break;
      }
    }

    if (isPageBlank) {
      const desktopMain = document.getElementById("desktop");
      if (desktopMain) {
        desktopMain.style.position = "relative"; 
        delBtn = document.createElement("button");
        delBtn.id = "btn-delete-page-indicator";
        delBtn.innerText = "删除此页?";
        delBtn.style.cssText = `
          position: absolute;
          top: 10px;
          right: 15px;
          background-color: #ef4444;
          color: white;
          border: none;
          border-radius: 12px;
          padding: 4px 10px;
          font-size: 11px;
          font-weight: bold;
          cursor: pointer;
          z-index: 1000;
          box-shadow: 0 2px 6px rgba(239, 68, 68, 0.2);
        `;
        delBtn.onclick = () => {
          window.deleteCurrentDesktopPage();
        };
        desktopMain.appendChild(delBtn);
      }
    }
  }
}

function renderPageIndicator(pageCount) {
  const indicator = document.getElementById("desktop-page-indicator");
  if (!indicator) return;
  indicator.innerHTML = "";

  for (let i = 0; i < pageCount; i++) {
    const dot = document.createElement("div");
    dot.className = `page-dot${i === currentDesktopPage ? " active" : ""}`;
    dot.onclick = () => {
      currentDesktopPage = i;
      loadDesktopLayout();
    };
    indicator.appendChild(dot);
  }

  if (isDesktopEditMode) {
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
  for (let i = 0; i < 20; i++) {
    desktopLayout.push(null);
  }
  localStorage.setItem("desktop-layout-v3", JSON.stringify(desktopLayout));
  currentDesktopPage = Math.floor(desktopLayout.length / 20) - 1;
  loadDesktopLayout();
}

window.deleteCurrentDesktopPage = function() {
  if (confirm("确定要删除当前空白页吗？")) {
    let desktopLayout = JSON.parse(localStorage.getItem("desktop-layout-v3")) || [];
    const pageStart = currentDesktopPage * 20;
    
    desktopLayout.splice(pageStart, 20);
    localStorage.setItem("desktop-layout-v3", JSON.stringify(desktopLayout));
    
    try {
      const placed = JSON.parse(localStorage.getItem("placed-widgets-desktop")) || {};
      const newPlaced = {};
      Object.keys(placed).forEach(key => {
        const idx = parseInt(key);
        if (idx < pageStart) {
          newPlaced[idx] = placed[idx];
        } else if (idx >= pageStart + 20) {
          newPlaced[idx - 20] = placed[idx];
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

function getPlacedWidget(type, index) {
  try {
    const placed = JSON.parse(localStorage.getItem(`placed-widgets-${type}`)) || {};
    const realIndex = type === "desktop" ? (currentDesktopPage * 20 + index) : index;
    const widgetId = placed[realIndex];
    if (widgetId) {
      const widgets = JSON.parse(localStorage.getItem("beautify-widgets")) || {};
      return widgets[widgetId] || null;
    }
  } catch(e) {}
  return null;
}

function renderLayout(container, layoutArray, slotClass) {
  container.innerHTML = "";
  
  let customIcons = {};
  try {
    customIcons = JSON.parse(localStorage.getItem("beautify-custom-icons")) || {};
  } catch(e) {}

  const isDesktopType = slotClass === "desktop-slot";
  const typeKey = isDesktopType ? "desktop" : "dock";
  const cols = 4;
  const totalCells = layoutArray.length;

  const skippedIndices = new Set();
  layoutArray.forEach((id, index) => {
    const wData = getPlacedWidget(typeKey, index);
    if (wData) {
      const w = parseInt(wData.widthSpan) || 1;
      const h = parseInt(wData.heightSpan) || 1;
      const row0 = Math.floor(index / cols);
      const col0 = index % cols;

      const actualW = Math.min(w, cols - col0);
      const actualH = h;

      for (let r = 0; r < actualH; r++) {
        for (let c = 0; c < actualW; c++) {
          if (r === 0 && c === 0) continue;
          const coveredIndex = (row0 + r) * cols + (col0 + c);
          if (coveredIndex < totalCells) {
            skippedIndices.add(coveredIndex);
          }
        }
      }
    }
  });

  layoutArray.forEach((id, index) => {
    if (skippedIndices.has(index)) return;

    const slot = document.createElement("div");
    slot.className = slotClass;
    slot.setAttribute("data-index", index);
    
    const wData = getPlacedWidget(typeKey, index);
    if (wData) {
      slot.classList.add("has-widget");
      const col0 = index % cols;
      const actualW = Math.min(parseInt(wData.widthSpan) || 1, cols - col0);

      slot.style.gridColumn = `span ${actualW}`;
      slot.style.gridRow = `span ${wData.heightSpan || 1}`;

      const widgetDiv = document.createElement("div");
      widgetDiv.className = "desktop-widget-container";
      widgetDiv.innerHTML = wData.html;
      
      const scripts = widgetDiv.querySelectorAll("script");
      scripts.forEach(oldScript => {
        const newScript = document.createElement("script");
        newScript.text = oldScript.innerHTML;
        oldScript.parentNode.replaceChild(newScript, oldScript);
      });

      slot.appendChild(widgetDiv);

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
        
        const customImg = customIcons[id];
        const iconHtml = customImg ? `<img src="${customImg}" draggable="false" class="custom-icon-img" style="width:100%; height:100%; object-fit:cover; border-radius:18px;">` : info.svg;
        const nameHtml = isDesktopType ? `<span>${info.name}</span>` : "";

        div.innerHTML = `
          <div class="icon-wrapper">${iconHtml}</div>
          ${nameHtml}
        `;
        slot.appendChild(div);

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

function initAppClickEvents() {
  if (isAppClickEventsInitialized) return;
  isAppClickEventsInitialized = true;

  document.body.addEventListener("click", (e) => {
    // 宽限判定：滑动后抬起不作为点击执行
    const dist = Math.hypot(e.clientX - lastPointerDownX, e.clientY - lastPointerDownY);
    if (dist > 15) return;

    if (isDesktopEditMode) {
      if (!e.target.closest(".widget-add-badge") && !e.target.closest(".widget-delete-badge") && !e.target.closest(".app-icon")) {
        exitDesktopEditMode();
        return;
      }
    }

    const icon = e.target.closest(".app-icon");
    if (icon) {
      const app = icon.getAttribute("data-app");
      if (icon.style.position !== "fixed") {
        openApp(app);
      }
    }
  });
}

function openApp(app) {
  const win = document.getElementById(`win-${app}`);
  if (win) {
    win.classList.add("active");
    updateThemeColor("#f4f6fa");
    
    if (app === 'settings' && typeof initSettingsApp === 'function') initSettingsApp();
    if (app === 'archive' && typeof initArchiveApp === 'function') initArchiveApp();
    if (app === 'world_book' && typeof initWorldBookApp === 'function') initWorldBookApp(); 
    if (app === 'chat' && typeof initChatApp === 'function') initChatApp();
    if (app === 'deeptalk' && typeof initDeeptalkApp === 'function') initDeeptalkApp();
  }
}

function closeApp(app) {
  const win = document.getElementById(`win-${app}`);
  if (win) {
    win.classList.remove("active");
    updateThemeColor("#f4f6fa");
  }
}

function initDragEvents() {
  if (isDragEventsInitialized) return;
  isDragEventsInitialized = true;

  let activeIcon = null;
  let startX = 0;
  let startY = 0;
  let iconStartX = 0;
  let iconStartY = 0;
  let rectWidth = 0;
  let rectHeight = 0;
  let isDragging = false;
  let originalParent = null;
  let dragPlaceholder = null;

  document.addEventListener("pointerdown", (e) => {
    const icon = e.target.closest(".app-icon");
    const widget = e.target.closest(".desktop-widget-container");

    // 1. 如果不在编辑模式，只进行 1.2s 长按侦测以决定是否进入编辑模式
    if (!isDesktopEditMode) {
      if (longPressTimer) clearTimeout(longPressTimer);
      if (longPressTarget) {
        longPressTarget.style.transform = "";
        longPressTarget.style.transition = "";
        longPressTarget = null;
      }

      if (icon || widget) {
        startX = e.clientX;
        startY = e.clientY;
        lastMoveX = e.clientX;
        lastMoveY = e.clientY;
        longPressTarget = icon || widget;

        longPressTimer = setTimeout(() => {
          const dx = lastMoveX - startX;
          const dy = lastMoveY - startY;
          // 抗震颤阻断：手指位移确实在10px以内，才确认触发
          if (Math.abs(dx) < 10 && Math.abs(dy) < 10 && !isDesktopEditMode) {
            enterDesktopEditMode();
          }
          longPressTimer = null;
        }, 1200);
      }
      return; 
    }

    // 2. 如果已在编辑模式，才启动拖重排逻辑
    if (!icon) return;
    
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
    lastMoveX = e.clientX;
    lastMoveY = e.clientY;

    const dx = e.clientX - startX;
    const dy = e.clientY - startY;

    // 非编辑模式下：如果手指移动超出了10px颤颤阈值，立刻清理长按，防止阻碍滑动
    if (!isDesktopEditMode) {
      if (Math.abs(dx) > 10 || Math.abs(dy) > 10) {
        if (longPressTimer) {
          clearTimeout(longPressTimer);
          longPressTimer = null;
        }
        if (longPressTarget) {
          longPressTarget.style.transform = "";
          longPressTarget.style.transition = "";
          longPressTarget = null;
        }
      }
      return;
    }

    if (!activeIcon) return;

    if (!isDragging && (Math.abs(dx) > 8 || Math.abs(dy) > 8)) {
      isDragging = true;
      activeIcon.classList.add("dragging");

      dragPlaceholder = document.createElement("div");
      dragPlaceholder.className = "app-icon-placeholder";
      dragPlaceholder.style.width = rectWidth + "px";
      dragPlaceholder.style.height = rectHeight + "px";
      originalParent.insertBefore(dragPlaceholder, activeIcon);

      document.body.appendChild(activeIcon);

      activeIcon.style.position = "fixed";
      activeIcon.style.width = "72px";
      activeIcon.style.height = "auto";
      activeIcon.style.zIndex = "9999";
      activeIcon.style.pointerEvents = "none"; 
    }

    if (isDragging) {
      activeIcon.style.left = (e.clientX - 36) + "px";
      activeIcon.style.top = (e.clientY - 42) + "px";

      const targetElement = document.elementFromPoint(e.clientX, e.clientY);
      let hoveredSlot = null;
      if (targetElement) {
        hoveredSlot = targetElement.closest(".desktop-slot") || targetElement.closest(".dock-slot");
      }

      document.querySelectorAll(".desktop-slot, .dock-slot").forEach(slot => {
        slot.classList.remove("drag-over");
      });

      if (hoveredSlot) {
        hoveredSlot.classList.add("drag-over");
      }
    }
  });

  document.addEventListener("pointerup", (e) => {
    if (longPressTimer) {
      clearTimeout(longPressTimer);
      longPressTimer = null;
    }
    if (longPressTarget) {
      longPressTarget.style.transform = "";
      longPressTarget.style.transition = "";
      longPressTarget = null;
    }

    if (!activeIcon) return;

    if (isDragging) {
      activeIcon.classList.remove("dragging");
      if (dragPlaceholder) dragPlaceholder.remove();

      const targetElement = document.elementFromPoint(e.clientX, e.clientY);
      let dropSlot = null;
      if (targetElement) {
        dropSlot = targetElement.closest(".desktop-slot") || targetElement.closest(".dock-slot");
      }

      document.querySelectorAll(".desktop-slot, .dock-slot").forEach(slot => {
        slot.classList.remove("drag-over");
      });

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

        if (existingIcon) {
          originalParent.appendChild(existingIcon);
          dropSlot.appendChild(activeIcon);
        } else if (existingWidget) {
          originalParent.appendChild(activeIcon);
        } else {
          dropSlot.appendChild(activeIcon);
        }
        saveLayoutsToLocal();
        loadDesktopLayout();
      } else {
        originalParent.appendChild(activeIcon);
        loadDesktopLayout();
      }
    }

    activeIcon = null;
    isDragging = false;
    dragPlaceholder = null;
  });
}

function initDesktopSwipeEvents() {
  const desktop = document.getElementById("desktop");
  if (!desktop) return;

  let swipeStartX = 0;
  let swipeStartY = 0;
  let isSwipingDesktop = false;

  desktop.addEventListener("pointerdown", (e) => {
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

  desktop.addEventListener("pointerup", (e) => {
    if (!isSwipingDesktop) return;
    isSwipingDesktop = false;

    const deltaX = e.clientX - swipeStartX;
    const deltaY = e.clientY - swipeStartY;

    if (Math.abs(deltaY) < 80) {
      let desktopLayout = [];
      try {
        desktopLayout = JSON.parse(localStorage.getItem("desktop-layout-v3")) || [];
      } catch (err) {}
      const pageCount = Math.max(1, Math.ceil(desktopLayout.length / 20));

      if (deltaX < -50) {
        if (currentDesktopPage < pageCount - 1) {
          currentDesktopPage++;
          loadDesktopLayout();
        }
      } else if (deltaX > 50) {
        if (currentDesktopPage > 0) {
          currentDesktopPage--;
          loadDesktopLayout();
        }
      }
    }
  });
}

function saveLayoutsToLocal() {
  const desktopSlots = Array.from(document.getElementById("desktop-grid").children);
  let desktopLayout = JSON.parse(localStorage.getItem("desktop-layout-v3")) || [];
  const pageCount = Math.max(1, Math.ceil(desktopLayout.length / 20));
  
  while (desktopLayout.length < pageCount * 20) {
    desktopLayout.push(null);
  }

  const pageStart = currentDesktopPage * 20;
  for (let i = 0; i < 20; i++) {
    desktopLayout[pageStart + i] = null;
  }
  
  desktopSlots.forEach(slot => {
    const index = parseInt(slot.getAttribute("data-index"));
    if (!isNaN(index) && index < 20) {
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

  localStorage.setItem("desktop-layout-v3", JSON.stringify(desktopLayout));
  localStorage.setItem("dock-layout-v3", JSON.stringify(dockLayout));
}

function enterDesktopEditMode() {
  if (isDesktopEditMode) return;
  isDesktopEditMode = true;
  const phone = document.getElementById("phone-container");
  if (phone) phone.classList.add("edit-mode");
  loadDesktopLayout();
}

function exitDesktopEditMode() {
  isDesktopEditMode = false;
  const phone = document.getElementById("phone-container");
  if (phone) phone.classList.remove("edit-mode");
  loadDesktopLayout();
}

function isAppAlreadyPlaced(appId) {
  let desktopLayout = [];
  let dockLayout = [];
  try {
    desktopLayout = JSON.parse(localStorage.getItem("desktop-layout-v3")) || [];
    dockLayout = JSON.parse(localStorage.getItem("dock-layout-v3")) || [];
  } catch(e) {}
  return desktopLayout.includes(appId) || dockLayout.includes(appId);
}

function openAddSelector(type, slotIndex) {
  let widgets = {};
  try {
    widgets = JSON.parse(localStorage.getItem("beautify-widgets")) || {};
  } catch(e) {}

  const widgetIds = Object.keys(widgets);
  const appsList = ["settings", "archive", "world_book", "chat", "deeptalk"];

  let html = `<div style="padding:16px;">
    <h4 style="margin:0 0 12px;font-size:14px;font-weight:700;text-align:center;">选择要添加的内容</h4>
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
    let layout = JSON.parse(localStorage.getItem(`${type}-layout-v3`)) || Array(type === "desktop" ? 20 : 4).fill(null);
    const realIndex = type === "desktop" ? (currentDesktopPage * 20 + slotIndex) : slotIndex;
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
    const realIndex = type === "desktop" ? (currentDesktopPage * 20 + slotIndex) : slotIndex;
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
      const realIndex = type === "desktop" ? (currentDesktopPage * 20 + slotIndex) : slotIndex;
      delete placed[realIndex];
      localStorage.setItem(`placed-widgets-${type}`, JSON.stringify(placed));
    } catch(e) {}
    exitDesktopEditMode();
  }
}

function removeAppFromSlot(type, slotIndex) {
  if (confirm("确定要将此应用从当前槽位中移除吗？")) {
    try {
      let layout = JSON.parse(localStorage.getItem(`${type}-layout-v3`)) || Array(type === "desktop" ? 20 : 4).fill(null);
      const realIndex = type === "desktop" ? (currentDesktopPage * 20 + slotIndex) : slotIndex;
      while (layout.length <= realIndex) {
        layout.push(null);
      }
      layout[realIndex] = null;
      localStorage.setItem(`${type}-layout-v3`, JSON.stringify(layout));
    } catch(e) {}
    exitDesktopEditMode();
  }
}
