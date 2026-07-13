let currentChatTab = 'sessions';
let activeUserPersonaId = null; 
let activeSessionId = null;
let onlineAbortController = null;
let offlineAbortController = null;

// 用于渲染当前对话中双方头像的全局临时变量
let activeSessionCharAvatar = null;
let activeSessionUserAvatar = null;

// 记录当前右键/双击被操作的消息节点 ID
let selectedMsgId = null;
let isMultiSelectMode = false;

// 专属详情页临时存储的 Blob 头像指针
let detailsCharAvatarBlob = null;
let detailsUserAvatarBlob = null;

// === 线下功能全局变量 ===
let isOfflineTheater = false;
let activeTheaterId = null;
let activeOfflineSelectedMsgId = null;
let isOfflineMultiSelectMode = false;

function getMessageDisplayDate(msg, sess) {
  if (!sess || sess.timePerceptionToggle !== 0) {
    return new Date(msg.timestamp);
  }
  try {
    const td = JSON.parse(sess.customTimeData);
    const baseDate = new Date(td.year, td.month - 1, td.day, td.hour, td.minute, 0);
    const elapsed = msg.timestamp - (sess.customTimeSavedAt || msg.timestamp);
    return new Date(baseDate.getTime() + elapsed);
  } catch(e) {
    return new Date(msg.timestamp);
  }
}

function getSimulatedNow(sess) {
  if (!sess || sess.timePerceptionToggle !== 0) {
    return new Date();
  }
  try {
    const td = JSON.parse(sess.customTimeData);
    const baseDate = new Date(td.year, td.month - 1, td.day, td.hour, td.minute, 0);
    const elapsed = Date.now() - (sess.customTimeSavedAt || Date.now());
    return new Date(baseDate.getTime() + elapsed);
  } catch(e) {
    return new Date();
  }
}

function formatWeChatTime(date, relativeToDate) {
  const now = relativeToDate || new Date();
  const isSameYear = date.getFullYear() === now.getFullYear();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);
  const targetDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());

  const pad = (num) => String(num).padStart(2, '0');
  const timeStr = `${pad(date.getHours())}:${pad(date.getMinutes())}`;

  if (targetDate.getTime() === today.getTime()) {
    return timeStr;
  } else if (targetDate.getTime() === yesterday.getTime()) {
    return `昨天 ${timeStr}`;
  } else if (isSameYear) {
    return `${date.getMonth() + 1}月${date.getDate()}日 ${timeStr}`;
  } else {
    return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 ${timeStr}`;
  }
}

// === 核心修复：添加初始化绑定保护锁，100% 杜绝二次加载事件死锁与卡顿 ===
let isChatAppInitialized = false;
let isContextMenuInitialized = false;
let isOfflineContextMenuInitialized = false;
let isChatAppEventsBound = false;
let isOfflineChatAppEventsBound = false;

// 主动注入语音及多媒体场景卡片的 CSS 规范样式，保障视觉平铺无污染
(function() {
  const multimediaStyle = document.createElement("style");
  multimediaStyle.textContent = `
    /* 微信语音消息气泡 */
    .voice-bubble-card {
      background-color: #ffffff;
      padding: 10px 14px;
      border-radius: 6px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      cursor: pointer;
      box-shadow: 0 1px 2px rgba(0,0,0,0.05);
      min-width: 70px;
      gap: 12px;
      user-select: none;
    }
    .msg-bubble.self .voice-bubble-card {
      background-color: #95ec69;
      flex-direction: row-reverse;
    }
    .voice-bubble-wave {
      display: flex;
      align-items: center;
      color: #191919;
    }
    .voice-bubble-duration {
      font-size: 13px;
      color: #7f7f7f;
      font-weight: 600;
    }
    .msg-bubble.self .voice-bubble-duration {
      color: #333333;
    }
    .voice-translation-text {
      background: #ffffff;
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 10px 12px;
      margin-top: 6px;
      font-size: 13px;
      color: var(--text-primary);
      width: 100%;
      max-width: 220px;
      word-break: break-all;
      box-shadow: var(--shadow-sm);
      animation: fadeIn 0.2s ease-out;
    }
    
    /* 灰色色块画面卡片重隔 */
    .msg-image-placeholder-card {
      background-color: #f3f4f6;
      padding: 12px 14px;
      border-radius: 6px;
      cursor: pointer;
      box-shadow: 0 1px 2px rgba(0,0,0,0.05);
      width: 220px;
      display: flex;
      flex-direction: column;
      gap: 4px;
      user-select: none;
      border: 1px solid var(--border);
    }
    .msg-bubble.self .msg-image-placeholder-card {
      background-color: #95ec69;
    }
    .msg-image-placeholder-header {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .msg-image-placeholder-title {
      font-size: 13px;
      font-weight: 700;
      color: #191919;
    }
    .msg-image-placeholder-sub {
      font-size: 11px;
      color: #7f7f7f;
    }
    .msg-bubble.self .msg-image-placeholder-sub {
      color: #333333;
    }
    .msg-image-placeholder {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      background: #f1f5f9;
      padding: 12px;
      border-radius: 6px;
      width: 150px;
      height: 150px;
      flex-direction: column;
      text-align: center;
      font-size: 11px;
      color: #64748b;
    }
    .msg-image-placeholder-card .image-description-text {
      background: #ffffff;
      border: 1.5px dashed var(--border);
      border-radius: 6px;
      padding: 10px;
      font-size: 12px;
      color: #191919;
      line-height: 1.5;
      word-break: break-all;
      animation: fadeIn 0.2s ease-out;
    }
    .msg-bubble.self .msg-image-placeholder-card .image-description-text {
      background: #ffffff;
    }
    
    /* 表情反应面板与贴纸样式 */
    .bubble-emoji-picker {
      animation: scaleIn 0.15s ease-out;
      scrollbar-width: none;
    }
    .bubble-emoji-picker::-webkit-scrollbar {
      display: none;
    }
    .bubble-attached-emoji {
      position: absolute;
      font-size: 15px;
      background: #ffffff;
      border: 1px solid rgba(0,0,0,0.08);
      border-radius: 50%;
      width: 22px;
      height: 22px;
      display: flex;
      align-items: center;
      justify-content: center;
      box-shadow: 0 1.5px 3px rgba(0,0,0,0.12);
      user-select: none;
      -webkit-user-select: none;
      animation: popIn 0.2s cubic-bezier(0.175, 0.885, 0.32, 1.275);
      z-index: 12;
      cursor: pointer;
    }
    .msg-bubble.self .bubble-attached-emoji {
      bottom: -8px;
      left: -8px;
    }
    .msg-bubble.other .bubble-attached-emoji {
      bottom: -8px;
      right: -8px;
    }
    @keyframes scaleIn {
      from { transform: scale(0.8) translateY(8px); opacity: 0; }
      to { transform: scale(1) translateY(0); opacity: 1; }
    }
    @keyframes popIn {
      from { transform: scale(0); }
      to { transform: scale(1); }
    }

    /* 气泡长按选中缩小动效 */
    .msg-bubble {
      transition: transform 0.15s cubic-bezier(0.2, 0, 0.2, 1);
    }
    .msg-bubble.bubble-longpressing {
      transform: scale(0.95);
    }

    /* 全局 PWA 自定义提示与卡片式弹窗 */
    .pwa-toast {
      position: fixed;
      bottom: 120px;
      left: 50%;
      transform: translate(-50%, 20px);
      background: rgba(0, 0, 0, 0.8);
      color: #ffffff;
      padding: 10px 18px;
      border-radius: 20px;
      font-size: 13px;
      z-index: 10000;
      opacity: 0;
      transition: opacity 0.2s ease, transform 0.2s ease;
      pointer-events: none;
      text-align: center;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
      max-width: 80%;
      line-height: 1.4;
    }
    .pwa-toast.show {
      opacity: 1;
      transform: translate(-50%, 0);
    }

    .pwa-modal-overlay {
      position: fixed;
      top: 0;
      left: 0;
      width: 100vw;
      height: 100vh;
      background: rgba(0,0,0,0.4);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 10000;
      opacity: 0;
      transition: opacity 0.2s ease;
    }
    .pwa-modal-overlay.show {
      opacity: 1;
    }
    .pwa-modal-card {
      background: #ffffff;
      width: 290px;
      border-radius: 12px;
      padding: 20px;
      box-shadow: 0 8px 24px rgba(0,0,0,0.15);
      text-align: center;
      transform: scale(0.9);
      transition: transform 0.2s ease;
      box-sizing: border-box;
    }
    .pwa-modal-overlay.show .pwa-modal-card {
      transform: scale(1);
    }
    .pwa-modal-title {
      font-size: 16px;
      font-weight: 700;
      color: #1a1a1a;
      margin-bottom: 12px;
    }
    .pwa-modal-message {
      font-size: 13px;
      color: #64748b;
      margin-bottom: 16px;
      line-height: 1.5;
      word-break: break-all;
    }
    .pwa-modal-input {
      width: 100%;
      height: 40px;
      border: 1.5px solid var(--border);
      border-radius: 8px;
      padding: 0 10px;
      font-size: 15px;
      font-weight: 700;
      outline: none;
      margin-bottom: 16px;
      box-sizing: border-box;
      text-align: center;
    }
    .pwa-modal-buttons {
      display: flex;
      gap: 10px;
    }
    .btn-pwa-modal {
      flex: 1;
      height: 38px;
      border: none;
      border-radius: 8px;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
    }
    .btn-pwa-modal.cancel {
      background: #f1f5f9;
      color: #64748b;
    }
    .btn-pwa-modal.confirm {
      background: #07c160;
      color: #ffffff;
    }
  `;
  document.head.appendChild(multimediaStyle);

  // 全局注册 PWA Toast 和 Modal 接口
  window.showToast = function(msg, duration = 3000) {
    let toast = document.querySelector(".pwa-toast");
    if (!toast) {
      toast = document.createElement("div");
      toast.className = "pwa-toast";
      document.body.appendChild(toast);
    }
    toast.innerText = msg;
    toast.classList.add("show");
    if (window.toastTimer) clearTimeout(window.toastTimer);
    window.toastTimer = setTimeout(() => {
      toast.classList.remove("show");
    }, duration);
  };

  window.showCustomAlert = function(title, message, callback) {
    const overlay = document.createElement("div");
    overlay.className = "pwa-modal-overlay";
    overlay.innerHTML = '<div class="pwa-modal-card">' +
      '<div class="pwa-modal-title">' + escapeHtml(title) + '</div>' +
      '<div class="pwa-modal-message">' + escapeHtml(message) + '</div>' +
      '<div class="pwa-modal-buttons">' +
        '<button class="btn-pwa-modal confirm">确定</button>' +
      '</div>' +
    '</div>';
    document.body.appendChild(overlay);
    
    setTimeout(() => overlay.classList.add("show"), 10);
    
    overlay.querySelector(".confirm").onclick = () => {
      overlay.classList.remove("show");
      setTimeout(() => {
        overlay.remove();
        if (typeof callback === 'function') callback();
      }, 200);
    };
  };

  window.showCustomPrompt = function(title, defaultValue, callback) {
    const overlay = document.createElement("div");
    overlay.className = "pwa-modal-overlay";
    overlay.innerHTML = '<div class="pwa-modal-card">' +
      '<div class="pwa-modal-title">' + escapeHtml(title) + '</div>' +
      '<input type="text" class="pwa-modal-input" value="' + escapeHtml(defaultValue) + '">' +
      '<div class="pwa-modal-buttons">' +
        '<button class="btn-pwa-modal cancel">取消</button>' +
        '<button class="btn-pwa-modal confirm">确定</button>' +
      '</div>' +
    '</div>';
    document.body.appendChild(overlay);
    
    const input = overlay.querySelector(".pwa-modal-input");
    input.focus();
    input.select();
    
    setTimeout(() => overlay.classList.add("show"), 10);
    
    overlay.querySelector(".cancel").onclick = () => {
      overlay.classList.remove("show");
      setTimeout(() => overlay.remove(), 200);
    };
    
    overlay.querySelector(".confirm").onclick = () => {
      const val = input.value;
      overlay.classList.remove("show");
      setTimeout(() => {
        overlay.remove();
        if (typeof callback === 'function') callback(val);
      }, 200);
    };
  };

  window.showCustomConfirm = function(title, message, onConfirm, onCancel) {
    const overlay = document.createElement("div");
    overlay.className = "pwa-modal-overlay";
    overlay.innerHTML = '<div class="pwa-modal-card">' +
      '<div class="pwa-modal-title">' + escapeHtml(title) + '</div>' +
      '<div class="pwa-modal-message">' + escapeHtml(message) + '</div>' +
      '<div class="pwa-modal-buttons">' +
        '<button class="btn-pwa-modal cancel">取消</button>' +
        '<button class="btn-pwa-modal confirm">确定</button>' +
      '</div>' +
    '</div>';
    document.body.appendChild(overlay);
    
    setTimeout(() => overlay.classList.add("show"), 10);
    
    overlay.querySelector(".cancel").onclick = () => {
      overlay.classList.remove("show");
      setTimeout(() => {
        overlay.remove();
        if (typeof onCancel === 'function') onCancel();
      }, 200);
    };
    
    overlay.querySelector(".confirm").onclick = () => {
      overlay.classList.remove("show");
      setTimeout(() => {
        overlay.remove();
        if (typeof onConfirm === 'function') onConfirm();
      }, 200);
    };
  };

  function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;')
              .replace(/</g, '&lt;')
              .replace(/>/g, '&gt;')
              .replace(/"/g, '&quot;')
              .replace(/'/g, '&#39;');
  }
})();

function resolveAvatar(avatar) {
  if (!avatar) {
    // 零冲突、显式高宽的标准 URL 编码灰底圆形 SVG 头像
    return 'data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2250%22%20height%3D%2250%22%20viewBox%3D%220%200%2050%2050%22%3E%3Ccircle%20cx%3D%2225%22%20cy%3D%2225%22%20r%3D%2225%22%20fill%3D%22%23ccc%22%2F%3E%3C%2Fsvg%3E';
  }
  if (avatar instanceof Blob) {
    return URL.createObjectURL(avatar); 
  }
  return avatar; 
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
}

window.safeOpenMomentFromShare = function(momentId, e) {
  if (e) {
    e.preventDefault();
    e.stopPropagation();
  }
  if (window.momentShareClickTimer) {
    clearTimeout(window.momentShareClickTimer);
  }
  window.momentShareClickTimer = setTimeout(() => {
    if (typeof openMomentFromShare === "function") {
      openMomentFromShare(momentId);
    }
  }, 500);
};

window.toggleRecallContent = function(el, e) {
  if (e) {
    e.preventDefault();
    e.stopPropagation();
  }
  const container = el.parentNode.nextElementSibling;
  if (container) {
    if (container.style.display === "none") {
      container.style.display = "block";
      el.innerText = "收起";
    } else {
      container.style.display = "none";
      el.innerText = "查看";
    }
  }
};

let bubbleLongPressTimer = null;
let bubbleScaleTimer = null;
let activeLongPressBubbleEl = null;
let activePickerEl = null;

function startBubbleLongPress(msgId, bubbleEl, e) {
  if (isMultiSelectMode) return;
  
  if (e.target.closest('.voice-bubble-card') || e.target.closest('.msg-image-placeholder-card') || e.target.closest('.wallet-bubble-card')) {
    return;
  }

  if (bubbleLongPressTimer) clearTimeout(bubbleLongPressTimer);
  if (bubbleScaleTimer) clearTimeout(bubbleScaleTimer);
  
  activeLongPressBubbleEl = bubbleEl;

  // 1秒后气泡稍微缩小，进行触控回弹反馈 [1]
  bubbleScaleTimer = setTimeout(() => {
    bubbleEl.classList.add("bubble-longpressing");
  }, 1000);

  // 1.3秒后完成长按，恢复原状并弹出表情包选择器 [1]
  bubbleLongPressTimer = setTimeout(async () => {
    const msgs = await db.messages.where('sessionId').equals(activeSessionId).sortBy('timestamp');
    const last20 = msgs.slice(-20);
    const isWithinLastRounds = last20.some(m => m.id === Number(msgId));
    
    bubbleEl.classList.remove("bubble-longpressing");
    activeLongPressBubbleEl = null;

    if (!isWithinLastRounds) return;
    showEmojiPicker(msgId, bubbleEl);
  }, 1300);
}

function cancelBubbleLongPress(e) {
  if (bubbleLongPressTimer) {
    clearTimeout(bubbleLongPressTimer);
    bubbleLongPressTimer = null;
  }
  if (bubbleScaleTimer) {
    clearTimeout(bubbleScaleTimer);
    bubbleScaleTimer = null;
  }
  if (activeLongPressBubbleEl) {
    activeLongPressBubbleEl.classList.remove("bubble-longpressing");
    activeLongPressBubbleEl = null;
  }
}

function showEmojiPicker(msgId, bubbleEl) {
  if (activePickerEl) {
    activePickerEl.remove();
  }

  const picker = document.createElement("div");
  picker.className = "bubble-emoji-picker";
  
  const isSelf = bubbleEl.classList.contains("self");
  const alignStyle = isSelf ? "right: 0; transform: none;" : "left: 0; transform: none;";
  
  picker.style.cssText = "position: absolute; top: -38px; " + alignStyle + " display: flex; gap: 8px; background: #ffffff; border: 1.5px solid var(--border); border-radius: 20px; padding: 6px 12px; overflow-x: auto; white-space: nowrap; max-width: 220px; z-index: 1000; box-shadow: 0 4px 12px rgba(0,0,0,0.15); scrollbar-width: none;";
  
  const emojis = ["😂", "😚", "😌", "😊", "👿", "😪", "😭", "😣", "🙄", "🥺", "🥵", "🥰", "😉", "😏"];
  emojis.forEach(emo => {
    const span = document.createElement("span");
    span.className = "bubble-emoji-item";
    span.style.cssText = "font-size: 20px; cursor: pointer; transition: transform 0.1s ease; display: inline-block; padding: 0 4px;";
    span.innerText = emo;
    span.onclick = async (e) => {
      e.preventDefault();
      e.stopPropagation();
      await saveReaction(msgId, emo);
      picker.remove();
    };
    picker.appendChild(span);
  });

  bubbleEl.appendChild(picker);
  activePickerEl = picker;

  const clickAwayHandler = (e) => {
    if (!picker.contains(e.target)) {
      picker.remove();
      document.removeEventListener("click", clickAwayHandler);
    }
  };
  setTimeout(() => {
    document.addEventListener("click", clickAwayHandler);
  }, 50);
}

async function saveReaction(msgId, emoji) {
  await db.messages.update(Number(msgId), { reactionEmoji: emoji });
  await renderDialogMessages();
}

window.removeReaction = async function(msgId, e) {
  if (e) {
    e.preventDefault();
    e.stopPropagation();
  }
  await db.messages.update(Number(msgId), { reactionEmoji: null });
  await renderDialogMessages();
};

async function initChatApp() {
  await loadMyPersonas();
  await renderChatTab();

  if (isChatAppInitialized) return;
  isChatAppInitialized = true;

  const tabs = document.querySelectorAll("#win-chat .chat-tabs .tab-item");
  tabs.forEach(tab => {
    tab.onclick = () => {
      tabs.forEach(t => t.classList.remove("active"));
      tab.classList.add("active");
      currentChatTab = tab.getAttribute("data-chat-tab"); // 核心修复：复位于标准的data-chat-tab，斩断路由未定义假死
      
      document.querySelectorAll(".chat-tab-panel").forEach(p => p.classList.remove("active"));
      const targetPanel = document.getElementById(`chat-tab-${currentChatTab}`);
      if (targetPanel) {
        targetPanel.classList.add("active");
      }

      const btnNewChat = document.getElementById("btn-new-chat");
      const btnMomentsPost = document.getElementById("btn-moments-post");
      const btnMomentsSettings = document.getElementById("btn-moments-settings");
      
      if (btnNewChat) {
        btnNewChat.style.display = currentChatTab === 'sessions' ? 'flex' : 'none';
      }
      if (btnMomentsPost) {
        btnMomentsPost.style.display = currentChatTab === 'moments' ? 'flex' : 'none';
      }
      if (btnMomentsSettings) {
        btnMomentsSettings.style.display = currentChatTab === 'moments' ? 'flex' : 'none';
      }

      // 动态更新主标题内容
      const mainTitle = document.getElementById("chat-main-title");
      if (mainTitle) {
        if (currentChatTab === 'sessions') {
          mainTitle.innerText = "聊天";
        } else if (currentChatTab === 'moments') {
          mainTitle.innerText = "朋友圈";
          if (window.momentSystem && window.momentSystem.init) {
            window.momentSystem.init();
          }
        } else if (currentChatTab === 'me') {
          mainTitle.innerText = "我的";
        }
      }

      renderChatTab();
    };
  });

  initContextMenuHandlers();
  initOfflineContextMenuHandlers(); 
}

// 微信底部导航扁平切签路由
const chatFooterTabs = document.querySelectorAll("#win-chat .chat-tabs .tab-item");
chatFooterTabs.forEach(tab => {
  tab.onclick = () => {
    chatFooterTabs.forEach(t => t.classList.remove("active"));
    tab.classList.add("active");
    currentChatTab = tab.getAttribute("data-chat-tab");
    
    document.querySelectorAll(".chat-tab-panel").forEach(p => p.classList.remove("active"));
    const targetPanel = document.getElementById(`chat-tab-${currentChatTab}`);
    if (targetPanel) {
      targetPanel.classList.add("active");
    }

    const btnNewChat = document.getElementById("btn-new-chat");
    const btnMomentsPost = document.getElementById("btn-moments-post");
    const btnMomentsSettings = document.getElementById("btn-moments-settings");

    if (btnNewChat) {
      btnNewChat.style.display = currentChatTab === 'sessions' ? 'flex' : 'none';
    }
    if (btnMomentsPost) {
      btnMomentsPost.style.display = currentChatTab === 'moments' ? 'flex' : 'none';
    }
    if (btnMomentsSettings) {
      btnMomentsSettings.style.display = currentChatTab === 'moments' ? 'flex' : 'none';
    }

    // 动态更新主标题内容
    const mainTitle = document.getElementById("chat-main-title");
    if (mainTitle) {
      if (currentChatTab === 'sessions') {
        mainTitle.innerText = "对话";
      } else if (currentChatTab === 'moments') {
        mainTitle.innerText = "朋友圈";
        if (window.momentSystem && window.momentSystem.init) {
          window.momentSystem.init();
        }
      } else if (currentChatTab === 'me') {
        mainTitle.innerText = "我的";
      }
    }

    renderChatTab();
  };
});

// 渲染我的人设选中状态卡片
async function updateMeActiveCard(userId) {
  const activeCard = document.getElementById("me-active-card");
  const avatarEl = document.getElementById("me-active-avatar");
  const groupEl = document.getElementById("me-active-group");
  const nameEl = document.getElementById("me-active-name");
  const remarkEl = document.getElementById("me-active-remark");

  if (!activeCard) return;

  if (isNaN(Number(userId))) {
    activeCard.style.display = "none";
    return;
  }

  const user = await db.archives.get(Number(userId));
  if (user) {
    if (avatarEl) avatarEl.src = resolveAvatar(user.avatar);
    if (groupEl) groupEl.innerText = user.group || "默认分组";
    if (nameEl) nameEl.innerText = user.name;
    if (remarkEl) remarkEl.innerText = user.remark || "暂无备注";
    activeCard.style.display = "flex";
  } else {
    activeCard.style.display = "none";
  }
}

// 渲染“我的人设”选择 (重构为卡片点击式候选面板)
async function loadMyPersonas() {
  const activeCard = document.getElementById("me-active-card");
  const selectorContainer = document.getElementById("me-selector-container");
  const candidatesContainer = document.getElementById("me-candidate-cards");
  
  if (!activeCard || !selectorContainer || !candidatesContainer) return;

  try {
    const allArchives = await db.archives.toArray();
    const users = allArchives.filter(u => u.type === 'user');
    
    // 渲染候选人设卡片列表
    candidatesContainer.innerHTML = "";
    if (users.length === 0) {
      candidatesContainer.innerHTML = `<p style="font-size: 12px; color: var(--text-secondary); text-align: center; padding: 10px 0;">暂无候选用户人设，请前往档案库创建！</p>`;
    } else {
      users.forEach(u => {
        const card = document.createElement("div");
        card.className = "candidate-persona-card";
        card.style.cssText = "background: #ffffff; border: 1.5px solid var(--border); border-radius: 10px; padding: 10px; display: flex; align-items: center; gap: 10px; cursor: pointer; transition: all 0.2s;";
        card.innerHTML = `
          <img src="${resolveAvatar(u.avatar)}" style="width: 40px; height: 40px; border-radius: 50%; object-fit: cover;">
          <div style="flex: 1; text-align: left;">
            <div style="font-size: 9px; color: var(--text-secondary); font-weight: 500;">${u.group || '默认分组'}</div>
            <div style="font-size: 14px; font-weight: 700; color: var(--text-primary); margin: 2px 0;">${u.name}</div>
            <div style="font-size: 11px; color: var(--text-secondary);">${u.remark || '暂无备注'}</div>
          </div>
        `;
        card.onclick = async () => {
          activeUserPersonaId = u.id;
          localStorage.setItem("active_me_id", u.id);
          await updateMeActiveCard(u.id);
          updateMeHeader(u.id);
          selectorContainer.style.display = "none";
          if (currentChatTab === 'sessions') renderChatTab();
        };
        candidatesContainer.appendChild(card);
      });
    }

    activeUserPersonaId = localStorage.getItem("active_me_id");
    if (activeUserPersonaId && activeUserPersonaId !== "null" && activeUserPersonaId !== "undefined") {
      const userIdNum = Number(activeUserPersonaId);
      await updateMeActiveCard(userIdNum);
      updateMeHeader(userIdNum);
      selectorContainer.style.display = "none";
    } else {
      activeUserPersonaId = null;
      activeCard.style.display = "none";
      selectorContainer.style.display = "block";
    }

    // 点击当前选中卡片，可以展开/折叠候选列表以供重新选择
    activeCard.onclick = () => {
      if (selectorContainer.style.display === "none") {
        selectorContainer.style.display = "block";
      } else {
        selectorContainer.style.display = "none";
      }
    };

  } catch (err) {
    console.error("加载我的人设失败:", err);
  }
}

async function updateMeHeader(userId) {
  if (isNaN(Number(userId))) return;
  const user = await db.archives.get(userId);
  if (user) {
    const nameEl = document.getElementById("moment-user-name");
    const avatarEl = document.getElementById("moment-user-avatar");
    if (nameEl) nameEl.innerText = user.name;
    if (avatarEl) avatarEl.src = resolveAvatar(user.avatar);
  }
}

// 渲染对应页签
async function renderChatTab() {
  if (currentChatTab === 'sessions') {
    renderSessionList();
  }
}

// 会话加载列表
async function renderSessionList() {
  const container = document.getElementById("session-list-container");
  if (!container) return;
  container.innerHTML = "";

  const userIdNum = Number(activeUserPersonaId);
  if (!activeUserPersonaId || isNaN(userIdNum)) {
    container.innerHTML = `<p style="text-align:center;color:var(--text-secondary);font-size:13px;padding:40px 0;">请先到 “我的” 选项卡下选择我的人设！</p>`;
    return;
  }

  try {
    const list = await db.sessions.where('userId').equals(userIdNum).toArray();
    if (list.length === 0) {
      container.innerHTML = `<p style="text-align:center;color:var(--text-secondary);font-size:13px;padding:40px 0;">暂无会话，请点击右上角新建</p>`;
      return;
    }

    for (let s of list) {
      const char = await db.archives.get(s.charId);
      const rawMsgs = await db.messages.where('sessionId').equals(s.id).toArray();
      const latestMsg = rawMsgs.sort((a, b) => b.timestamp - a.timestamp)[0];
      
      let latestText = "暂无对话消息";
      if (latestMsg) {
        if (latestMsg.contentType === 'transfer') {
          latestText = "[微信转账]";
        } else if (latestMsg.contentType === 'red_envelope') {
          latestText = "[微信红包]";
        } else if (latestMsg.contentType === 'voice') {
          latestText = "[语音消息]";
        } else if (latestMsg.contentType === 'moment_share') {
          latestText = "[转发了一条朋友圈]";
        } else if (latestMsg.contentType === 'image' && typeof latestMsg.content === 'string' && latestMsg.content.startsWith("{")) {
          latestText = "[图片与描述]";
        } else {
          latestText = latestMsg.content;
          if (typeof latestText === 'string') {
            latestText = latestText.replace(/^[\[【](QUOTE|引用)\s*:\s*(\d+)[\]】]\s*/i, '');
          }
        }
      }
      
      const timeDisplay = formatWeChatTime(new Date(latestMsg ? latestMsg.timestamp : (s.lastMessageTime || Date.now())), new Date());
      const div = document.createElement("div");
      div.className = "session-item";
      div.onclick = () => openWeChatDialog(s.id);
      div.innerHTML = `
        <img class="session-avatar" src="${resolveAvatar(s.customCharAvatar || char?.avatar)}">
        <div class="session-detail">
          <div class="session-row">
            <span class="session-name">${s.customCharName || char?.name || '未知角色'}</span>
            <span class="session-time">${timeDisplay}</span>
          </div>
          <div class="session-msg">${latestText}</div>
        </div>
      `;
      container.appendChild(div);
    }
  } catch (err) {
    console.error("加载会话列表失败:", err);
    container.innerHTML = `<p style="text-align:center;color:var(--text-secondary);font-size:13px;padding:40px 0;">加载会话列表出错，请重试</p>`;
  }
}

// 展开单聊
async function openWeChatDialog(sessionId) {
  activeSessionId = sessionId;
  const sess = await db.sessions.get(sessionId);
  const char = await db.archives.get(sess.charId);
  const user = await db.archives.get(sess.userId);

  activeSessionCharAvatar = sess.customCharAvatar || char?.avatar || null;
  activeSessionUserAvatar = sess.customUserAvatar || user?.avatar || null;
  
  document.getElementById("dialog-header-title").innerText = sess.customCharName || char?.name || "未知角色";
  document.getElementById("chat-dialog-panel").classList.add("active");

  updateThemeColor("#ededed");

  exitMultiSelectMode();
  renderDialogMessages();
}

function closeChatDialog() {
  document.getElementById("chat-dialog-panel").classList.remove("active");
  updateThemeColor("#f4f6fa");
  renderSessionList();
}

// 渲染仿真消息
// 渲染仿真消息
async function renderDialogMessages() {
  const container = document.getElementById("dialog-messages-container");
  if (!container) return;
  
  const sess = await db.sessions.get(activeSessionId);
  const msgs = await db.messages.where('sessionId').equals(activeSessionId).sortBy('timestamp');
  const fragment = document.createDocumentFragment();
  
  const charAvatarUrl = resolveAvatar(activeSessionCharAvatar);
  const userAvatarUrl = resolveAvatar(activeSessionUserAvatar);

  // 预加载当前对话的表情包挂载配置
  let mountedGroupIds = [];
  if (window.stickerSystem && window.stickerSystem.getMountedGroupIds) {
    mountedGroupIds = await window.stickerSystem.getMountedGroupIds(activeSessionId);
  }

  let prevMsgDisplayTime = null;

      // 核心修复：采用健康的 for...of 异步遍历，解决 forEach 内部 await 导致的编译死锁
      for (const m of msgs) {
        const currentDisplayTime = getMessageDisplayDate(m, sess);
        let showTimestamp = false;
        if (prevMsgDisplayTime === null) {
          showTimestamp = true;
        } else {
          const diff = currentDisplayTime.getTime() - prevMsgDisplayTime.getTime();
          if (diff > 3 * 60 * 1000) {
            showTimestamp = true;
          }
        }
        prevMsgDisplayTime = currentDisplayTime;

        if (showTimestamp) {
          const timeDiv = document.createElement("div");
          timeDiv.className = "chat-time-divider";
          timeDiv.style.cssText = "text-align: center; margin: 12px 0; font-size: 11.5px; color: #b2b2b2; user-select: none;";
          timeDiv.innerText = formatWeChatTime(currentDisplayTime, getSimulatedNow(sess));
          fragment.appendChild(timeDiv);
        }

        if (m.isRecalled === 1) {
      const recallEl = document.createElement("div");
      recallEl.className = "recalled-system-msg-container";
      recallEl.setAttribute("data-msg-id", m.id);
      recallEl.style.cssText = "display: flex; justify-content: center; align-items: center; width: 100%; margin: 8px 0; box-sizing: border-box; padding: 0 16px;";
      recallEl.innerHTML = `
        <div style="background-color: rgba(0,0,0,0.05); padding: 6px 12px; border-radius: 4px; font-size: 11.5px; color: #999; user-select: none; max-width: 85%; display: flex; flex-direction: column; align-items: center; gap: 4px; text-align: center;">
          <div style="pointer-events: none;">
            ${m.senderType === 'user' ? '你' : '对方'} 撤回了一条消息 
            <span class="recall-view-btn" style="color: #576b95; font-size: 10.5px; margin-left: 4px; cursor: pointer; pointer-events: auto;" onclick="window.toggleRecallContent(this, event)">查看</span>
          </div>
          <div class="recall-original-content" style="display: none; border-top: 1px dashed rgba(0,0,0,0.1); padding-top: 4px; margin-top: 4px; color: #666; font-size: 11px; word-break: break-all; width: 100%; text-align: left;">
            ${escapeHtml(m.content)}
          </div>
        </div>
      `;
      recallEl.ondblclick = (e) => {
        e.preventDefault();
        if (isMultiSelectMode) return;
        selectedMsgId = m.id;
        
        if (window.momentShareClickTimer) {
          clearTimeout(window.momentShareClickTimer);
          window.momentShareClickTimer = null;
        }
        
        const btnRecall = document.getElementById("btn-menu-recall");
        if (btnRecall) btnRecall.style.display = "none";
        
        document.getElementById("bubble-context-menu").style.display = "flex";
      };
      fragment.appendChild(recallEl);
      continue;
    }

        const bubble = document.createElement("div");
    bubble.className = `msg-bubble ${m.senderType === 'user' ? 'self' : 'other'}`;
    bubble.setAttribute("data-msg-id", m.id);
    bubble.style.position = "relative";

    bubble.ondblclick = async (e) => {
      e.preventDefault();
      if (isMultiSelectMode) return;
      selectedMsgId = m.id;
      
      if (window.momentShareClickTimer) {
        clearTimeout(window.momentShareClickTimer);
        window.momentShareClickTimer = null;
      }
      
      const msg = await db.messages.get(m.id);
      const btnRecall = document.getElementById("btn-menu-recall");
      if (btnRecall && msg) {
        const isUserMsg = msg.senderType === 'user';
        if (isUserMsg && !msg.isRecalled) {
          btnRecall.style.display = "block";
        } else {
          btnRecall.style.display = "none";
        }
      }
      
      document.getElementById("bubble-context-menu").style.display = "flex";
    };

    bubble.onmousedown = (e) => startBubbleLongPress(m.id, bubble, e);
    bubble.onmouseup = (e) => cancelBubbleLongPress(e);
    bubble.onmouseleave = (e) => cancelBubbleLongPress(e);
    bubble.ontouchstart = (e) => startBubbleLongPress(m.id, bubble, e);
    bubble.ontouchend = (e) => cancelBubbleLongPress(e);
    
    const emojiHtml = m.reactionEmoji ? `<div class="bubble-attached-emoji" onclick="window.removeReaction(${m.id}, event)">${m.reactionEmoji}</div>` : "";
    let contentHtml = "";
    if (m.contentType === 'image') {
      try {
        const data = JSON.parse(m.content);
        const captionText = data.text || "场景画面";
        const isRealImage = data.url && data.url.startsWith("data:image/") && !data.url.includes("svg+xml");

        if (isRealImage) {
          contentHtml = `
            <div class="image-bubble-card" onclick="toggleImageText(${m.id}, this)" style="position: relative;">
              <img src="${data.url}" class="msg-img" onerror="this.style.display='none'; document.getElementById('img-fallback-${m.id}').style.display='flex';">
              <div id="img-fallback-${m.id}" class="msg-image-placeholder-card" style="display:none; width: 100%;">
                <div class="msg-image-placeholder-header">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color:var(--text-secondary); flex-shrink:0;"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
                  <span class="msg-image-placeholder-title">发送了画面图片</span>
                </div>
                <div class="msg-image-placeholder-sub">轻触可展示具体画面场景描述</div>
              </div>
              <div class="image-description-text" id="image-desc-${m.id}" style="display: none; max-height: 120px; overflow-y: auto;">
                ${escapeHtml(captionText)}
              </div>
              ${emojiHtml}
            </div>
          `;
        } else {
          contentHtml = `
            <div class="msg-image-placeholder-card" onclick="toggleImageText(${m.id}, this)" style="position: relative;">
              <div class="msg-image-placeholder-header">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color:var(--text-secondary); flex-shrink:0;"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
                <span class="msg-image-placeholder-title">发送了画面图片</span>
              </div>
              <div class="msg-image-placeholder-sub">轻触可展示具体画面场景描述</div>
              <div class="image-description-text" id="image-desc-${m.id}" style="display: none; max-height: 120px; overflow-y: auto; margin-top:8px;">
                ${escapeHtml(captionText)}
              </div>
              ${emojiHtml}
            </div>
          `;
        }
      } catch(e) {
        contentHtml = `
          <div class="msg-image-placeholder-card" onclick="toggleImageText(${m.id}, this)" style="position: relative;">
            <div class="msg-image-placeholder-header">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color:var(--text-secondary); flex-shrink:0;"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
              <span class="msg-image-placeholder-title">发送了画面图片</span>
            </div>
            <div class="msg-image-placeholder-sub">轻触可展示具体画面场景描述</div>
            <div class="image-description-text" id="image-desc-${m.id}" style="display: none; max-height: 120px; overflow-y: auto; margin-top:8px;">
              ${escapeHtml(m.content)}
            </div>
            ${emojiHtml}
          </div>
        `;
      }
    } else if (m.contentType === 'voice') {
      try {
        const data = JSON.parse(m.content);
        const width = Math.min(180, 75 + data.duration * 2);
        const align = m.senderType === 'user' ? 'flex-end' : 'flex-start';
        contentHtml = `
          <div style="display:flex; flex-direction:column; align-items: ${align}; gap:4px; max-width:220px; position: relative;">
            <div class="voice-bubble-card" onclick="toggleVoiceTranslation(${m.id}, this)" style="width: ${width}px; position: relative;">
              <div class="voice-bubble-wave">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:middle;">
                  <path d="M12 1v22M17 5v14M22 9v6M7 5v14M2 9v6"/>
                </svg>
              </div>
              <div class="voice-bubble-duration">${data.duration}"</div>
              ${emojiHtml}
            </div>
            <div class="voice-translation-text" id="voice-trans-${m.id}" style="display: none;">
              ${escapeHtml(data.text)}
            </div>
          </div>
        `;
      } catch(e) {
        contentHtml = `<div class="msg-text" style="position: relative;">语音数据格式错误${emojiHtml}</div>`;
      }
    } else if (m.contentType === 'transfer') {
      try {
        const data = JSON.parse(m.content);
        const amount = parseFloat(data.amount) || 0;
        const statusClass = data.status || 'pending';
        const statusLabel = statusClass === 'received' ? '已收钱' : '待接收';
        contentHtml = `
          <div class="wallet-bubble-card transfer ${statusClass}" onclick="walletSystem.claimTransfer(${m.id})" style="position: relative;">
            <div class="wallet-bubble-body">
              <div class="wallet-bubble-icon">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <rect x="2" y="5" width="20" height="14" rx="2" ry="2"/>
                  <line x1="2" y1="10" x2="22" y2="10"/>
                </svg>
              </div>
              <div class="wallet-bubble-details">
                <div class="wallet-bubble-title">微信转账</div>
                <div class="wallet-bubble-amount">¥ ${amount.toFixed(2)}</div>
              </div>
            </div>
            <div class="wallet-bubble-footer">${statusLabel}</div>
            ${emojiHtml}
          </div>
        `;
      } catch(e) {
        contentHtml = `<div class="msg-text" style="position: relative;">转账格式异常${emojiHtml}</div>`;
      }
    } else if (m.contentType === 'red_envelope') {
      try {
        const data = JSON.parse(m.content);
        const amount = parseFloat(data.amount) || 0;
        const remark = escapeHtml(data.remark || '恭喜发财，大吉大利');
        const statusClass = data.status || 'pending';
        const statusLabel = statusClass === 'opened' ? '微信红包（已领取）' : '微信红包';
        contentHtml = `
          <div class="wallet-bubble-card red-envelope ${statusClass}" onclick="walletSystem.claimRedEnvelope(${m.id})" style="position: relative;">
            <div class="wallet-bubble-body">
              <div class="wallet-bubble-icon">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/>
                  <circle cx="12" cy="12" r="3"/>
                </svg>
              </div>
              <div class="wallet-bubble-details">
                <div class="wallet-bubble-title">${remark}</div>
                <div class="wallet-bubble-desc">查看红包</div>
              </div>
            </div>
            <div class="wallet-bubble-footer">${statusLabel}</div>
            ${emojiHtml}
          </div>
        `;
      } catch(e) {
        contentHtml = `<div class="msg-text" style="position: relative;">红包格式异常${emojiHtml}</div>`;
      }
    } else if (m.contentType === 'moment_share') {
      try {
        const data = JSON.parse(m.content);
        contentHtml = `
          <div class="wallet-bubble-card" style="background-color: #ffffff; border: 1.5px solid var(--border); border-radius: 8px; width: 220px; cursor: pointer; position: relative;" onclick="window.safeOpenMomentFromShare(${data.momentId}, event)">
            <div class="wallet-bubble-body" style="padding: 10px; display: flex; flex-direction: column; gap: 4px;">
              <div style="font-size: 11px; color: var(--text-secondary); font-weight:700;">转发了朋友圈动态</div>
              <div style="font-size: 13px; font-weight: 700; color: #1e293b; border-bottom: 1.5px dashed var(--border); padding-bottom: 6px;">
                ${data.authorName} 的朋友圈
              </div>
              <div style="font-size: 13px; color: var(--text-primary); margin-top: 4px; font-style: italic;">
                “ ${escapeHtml(data.summary)} ”
              </div>
              ${data.commentText ? `<div style="font-size: 12px; color: #576b95; margin-top: 6px; font-weight:700;">附言：${escapeHtml(data.commentText)}</div>` : ''}
            </div>
            <div style="background-color: #fafbfc; font-size: 10px; padding: 6px 10px; border-top: 1px solid var(--border); text-align: right; color: var(--text-secondary); border-radius: 0 0 8px 8px;">轻触在朋友圈中查看</div>
            ${emojiHtml}
          </div>
        `;
      } catch(e) {
        contentHtml = `<div class="msg-text" style="position: relative;">朋友圈分享格式错误${emojiHtml}</div>`;
      }
    } else {
      const isOnlySticker = typeof m.content === 'string' && /^【表情包：[^】]+】$/.test(m.content.trim());
      let displayContent = m.content;
      if (window.stickerSystem && window.stickerSystem.renderStickerInMessageSync) {
        displayContent = window.stickerSystem.renderStickerInMessageSync(m.content, mountedGroupIds);
      }
      
      if (isOnlySticker && displayContent.includes('<img')) {
        contentHtml = `<div class="msg-sticker-alone-wrapper" style="position: relative;">${displayContent}${emojiHtml}</div>`;
      } else {
        // 支持引用渲染
        let quoteHtml = "";
        if (window.quoteSystem) {
          const parsed = await window.quoteSystem.parseQuote(m.content);
          if (parsed) {
            quoteHtml = parsed.quoteHtml;
            displayContent = parsed.cleanText;
            if (window.stickerSystem && window.stickerSystem.renderStickerInMessageSync) {
              displayContent = window.stickerSystem.renderStickerInMessageSync(displayContent, mountedGroupIds);
            }
          }
        }
        contentHtml = `<div class="msg-text" style="position: relative;">${quoteHtml}${displayContent}${emojiHtml}</div>`;
      }
    }

    const avatarUrl = m.senderType === 'user' ? userAvatarUrl : charAvatarUrl;

    bubble.innerHTML = `
      <div class="msg-select-checkbox" style="display: ${isMultiSelectMode ? 'flex' : 'none'};">
        <input type="checkbox" class="msg-checkbox" data-msg-id="${m.id}" onchange="updateSelectedCount()">
      </div>
      <img class="msg-avatar" src="${avatarUrl}">
      ${contentHtml}
    `;
    fragment.appendChild(bubble);
  }

  container.innerHTML = "";
  container.appendChild(fragment);
  container.scrollTop = container.scrollHeight;
}

// 动态追加消息
async function appendMessageToDOM(msg) {
  const container = document.getElementById("dialog-messages-container");
  if (!container) return;

  const sess = await db.sessions.get(activeSessionId);
  const msgs = await db.messages.where('sessionId').equals(activeSessionId).sortBy('timestamp');
  const prevMsg = msgs.length >= 2 ? msgs[msgs.length - 2] : null;

  const currentDisplayTime = getMessageDisplayDate(msg, sess);
  let showTimestamp = false;
  if (!prevMsg) {
    showTimestamp = true;
  } else {
    const prevDisplayTime = getMessageDisplayDate(prevMsg, sess);
    const diff = currentDisplayTime.getTime() - prevDisplayTime.getTime();
    if (diff > 3 * 60 * 1000) {
      showTimestamp = true;
    }
  }

  if (showTimestamp) {
    const timeDiv = document.createElement("div");
    timeDiv.className = "chat-time-divider";
    timeDiv.style.cssText = "text-align: center; margin: 12px 0; font-size: 11.5px; color: #b2b2b2; user-select: none;";
    timeDiv.innerText = formatWeChatTime(currentDisplayTime, getSimulatedNow(sess));
    container.appendChild(timeDiv);
  }

  if (msg.isRecalled === 1) {
    const recallEl = document.createElement("div");
    recallEl.className = "recalled-system-msg-container";
    recallEl.setAttribute("data-msg-id", msg.id);
    recallEl.style.cssText = "display: flex; justify-content: center; align-items: center; width: 100%; margin: 8px 0; box-sizing: border-box; padding: 0 16px;";
    recallEl.innerHTML = `
      <div style="background-color: rgba(0,0,0,0.05); padding: 6px 12px; border-radius: 4px; font-size: 11.5px; color: #999; user-select: none; max-width: 85%; display: flex; flex-direction: column; align-items: center; gap: 4px; text-align: center;">
        <div style="pointer-events: none;">
          ${msg.senderType === 'user' ? '你' : '对方'} 撤回了一条消息 
          <span class="recall-view-btn" style="color: #576b95; font-size: 10.5px; margin-left: 4px; cursor: pointer; pointer-events: auto;" onclick="window.toggleRecallContent(this, event)">查看</span>
        </div>
        <div class="recall-original-content" style="display: none; border-top: 1px dashed rgba(0,0,0,0.1); padding-top: 4px; margin-top: 4px; color: #666; font-size: 11px; word-break: break-all; width: 100%; text-align: left;">
          ${escapeHtml(msg.content)}
        </div>
      </div>
    `;
    recallEl.ondblclick = (e) => {
      e.preventDefault();
      if (isMultiSelectMode) return;
      selectedMsgId = msg.id;
      
      if (window.momentShareClickTimer) {
        clearTimeout(window.momentShareClickTimer);
        window.momentShareClickTimer = null;
      }
      
      const btnRecall = document.getElementById("btn-menu-recall");
      if (btnRecall) btnRecall.style.display = "none";
      
      document.getElementById("bubble-context-menu").style.display = "flex";
    };
    container.appendChild(recallEl);
    container.scrollTop = container.scrollHeight;
    return;
  }

  const bubble = document.createElement("div");
  bubble.className = `msg-bubble ${msg.senderType === 'user' ? 'self' : 'other'}`;
  bubble.setAttribute("data-msg-id", msg.id);
  bubble.style.position = "relative";

  bubble.ondblclick = async (e) => {
    e.preventDefault();
    if (isMultiSelectMode) return;
    selectedMsgId = msg.id;
    
    if (window.momentShareClickTimer) {
      clearTimeout(window.momentShareClickTimer);
      window.momentShareClickTimer = null;
    }
    
    const dbMsg = await db.messages.get(msg.id);
    const btnRecall = document.getElementById("btn-menu-recall");
    if (btnRecall && dbMsg) {
      const isUserMsg = dbMsg.senderType === 'user';
      if (isUserMsg && !dbMsg.isRecalled) {
        btnRecall.style.display = "block";
      } else {
        btnRecall.style.display = "none";
      }
    }
    
    document.getElementById("bubble-context-menu").style.display = "flex";
  };

  bubble.onmousedown = (e) => startBubbleLongPress(msg.id, bubble, e);
  bubble.onmouseup = (e) => cancelBubbleLongPress(e);
  bubble.onmouseleave = (e) => cancelBubbleLongPress(e);
  bubble.ontouchstart = (e) => startBubbleLongPress(msg.id, bubble, e);
  bubble.ontouchend = (e) => cancelBubbleLongPress(e);
  
  // 预加载当前对话的表情包挂载配置
  let mountedGroupIds = [];
  if (window.stickerSystem && window.stickerSystem.getMountedGroupIds) {
    mountedGroupIds = await window.stickerSystem.getMountedGroupIds(activeSessionId);
  }
  
  let contentHtml = "";
  if (msg.contentType === 'image') {
    try {
      const data = JSON.parse(msg.content);
      const captionText = data.text || "场景画面";
      const isRealImage = data.url && data.url.startsWith("data:image/") && !data.url.includes("svg+xml");

      if (isRealImage) {
        contentHtml = `
          <div class="image-bubble-card" onclick="toggleImageText(${msg.id}, this)">
            <img src="${data.url}" class="msg-img" onerror="this.style.display='none'; document.getElementById('img-fallback-${msg.id}').style.display='flex';">
            <div id="img-fallback-${msg.id}" class="msg-image-placeholder-card" style="display:none; width: 100%;">
              <div class="msg-image-placeholder-header">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color:var(--text-secondary); flex-shrink:0;"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
                <span class="msg-image-placeholder-title">发送了画面图片</span>
              </div>
              <div class="msg-image-placeholder-sub">轻触可展示具体画面场景描述</div>
            </div>
            <div class="image-description-text" id="image-desc-${msg.id}" style="display: none; max-height: 120px; overflow-y: auto;">
              ${escapeHtml(captionText)}
            </div>
          </div>
        `;
      } else {
        contentHtml = `
          <div class="msg-image-placeholder-card" onclick="toggleImageText(${msg.id}, this)">
            <div class="msg-image-placeholder-header">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color:var(--text-secondary); flex-shrink:0;"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
              <span class="msg-image-placeholder-title">发送了画面图片</span>
            </div>
            <div class="msg-image-placeholder-sub">轻触可展示具体画面场景描述</div>
            <div class="image-description-text" id="image-desc-${msg.id}" style="display: none; max-height: 120px; overflow-y: auto; margin-top:8px;">
              ${escapeHtml(captionText)}
            </div>
          </div>
        `;
      }
    } catch(e) {
      contentHtml = `
        <div class="msg-image-placeholder-card" onclick="toggleImageText(${msg.id}, this)">
          <div class="msg-image-placeholder-header">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color:var(--text-secondary); flex-shrink:0;"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
            <span class="msg-image-placeholder-title">发送了画面图片</span>
          </div>
          <div class="msg-image-placeholder-sub">轻触可展示具体画面场景描述</div>
          <div class="image-description-text" id="image-desc-${msg.id}" style="display: none; max-height: 120px; overflow-y: auto; margin-top:8px;">
            ${escapeHtml(msg.content)}
          </div>
        </div>
      `;
    }
  } else if (msg.contentType === 'voice') {
    try {
      const data = JSON.parse(msg.content);
      const width = Math.min(180, 75 + data.duration * 2);
      const align = msg.senderType === 'user' ? 'flex-end' : 'flex-start';
      contentHtml = `
        <div style="display:flex; flex-direction:column; align-items: ${align}; gap:4px; max-width:220px;">
          <div class="voice-bubble-card" onclick="toggleVoiceTranslation(${msg.id}, this)" style="width: ${width}px;">
            <div class="voice-bubble-wave">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:middle;">
                <path d="M12 1v22M17 5v14M22 9v6M7 5v14M2 9v6"/>
              </svg>
            </div>
            <div class="voice-bubble-duration">${data.duration}"</div>
          </div>
          <div class="voice-translation-text" id="voice-trans-${msg.id}" style="display: none;">
            ${escapeHtml(data.text)}
          </div>
        </div>
      `;
    } catch(e) {
      contentHtml = `<div class="msg-text">语音格式异常</div>`;
    }
  } else if (msg.contentType === 'transfer') {
    try {
      const data = JSON.parse(msg.content);
      const amount = parseFloat(data.amount) || 0;
      const statusClass = data.status || 'pending';
      const statusLabel = statusClass === 'received' ? '已收钱' : '待接收';
      contentHtml = `
        <div class="wallet-bubble-card transfer ${statusClass}" onclick="walletSystem.claimTransfer(${msg.id})">
          <div class="wallet-bubble-body">
            <div class="wallet-bubble-icon">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <rect x="2" y="5" width="20" height="14" rx="2" ry="2"/>
                <line x1="2" y1="10" x2="22" y2="10"/>
              </svg>
            </div>
            <div class="wallet-bubble-details">
              <div class="wallet-bubble-title">微信转账</div>
              <div class="wallet-bubble-amount">¥ ${amount.toFixed(2)}</div>
            </div>
          </div>
          <div class="wallet-bubble-footer">${statusLabel}</div>
        </div>
      `;
    } catch(e) {
      contentHtml = `<div class="msg-text">转账格式错误</div>`;
    }
  } else if (msg.contentType === 'red_envelope') {
    try {
      const data = JSON.parse(msg.content);
      const amount = parseFloat(data.amount) || 0;
      const remark = escapeHtml(data.remark || '恭喜发财，大吉大利');
      const statusClass = data.status || 'pending';
      const statusLabel = statusClass === 'opened' ? '微信红包（已领取）' : '微信红包';
      contentHtml = `
        <div class="wallet-bubble-card red-envelope ${statusClass}" onclick="walletSystem.claimRedEnvelope(${msg.id})">
          <div class="wallet-bubble-body">
            <div class="wallet-bubble-icon">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/>
                <circle cx="12" cy="12" r="3"/>
              </svg>
            </div>
            <div class="wallet-bubble-details">
              <div class="wallet-bubble-title">${remark}</div>
              <div class="wallet-bubble-desc">查看红包</div>
            </div>
          </div>
          <div class="wallet-bubble-footer">${statusLabel}</div>
        </div>
      `;
    } catch(e) {
      contentHtml = `<div class="msg-text">红包格式错误</div>`;
    }
  } else if (msg.contentType === 'moment_share') {
    try {
      const data = JSON.parse(msg.content);
      contentHtml = `
        <div class="wallet-bubble-card" style="background-color: #ffffff; border: 1.5px solid var(--border); border-radius: 8px; width: 220px; cursor: pointer;" onclick="window.safeOpenMomentFromShare(${data.momentId}, event)">
          <div class="wallet-bubble-body" style="padding: 10px; display: flex; flex-direction: column; gap: 4px;">
            <div style="font-size: 11px; color: var(--text-secondary); font-weight:700;">转发了朋友圈动态</div>
            <div style="font-size: 13px; font-weight: 700; color: #1e293b; border-bottom: 1.5px dashed var(--border); padding-bottom: 6px;">
              ${data.authorName} 的朋友圈
            </div>
            <div style="font-size: 13px; color: var(--text-primary); margin-top: 4px; font-style: italic;">
              “ ${escapeHtml(data.summary)} ”
            </div>
            ${data.commentText ? `<div style="font-size: 12px; color: #576b95; margin-top: 6px; font-weight:700;">附言：${escapeHtml(data.commentText)}</div>` : ''}
          </div>
          <div style="background-color: #fafbfc; font-size: 10px; padding: 6px 10px; border-top: 1px solid var(--border); text-align: right; color: var(--text-secondary); border-radius: 0 0 8px 8px;">轻触在朋友圈中查看</div>
        </div>
      `;
    } catch(e) {
      contentHtml = `<div class="msg-text">朋友圈分享格式错误</div>`;
    }
  } else {
    const isOnlySticker = typeof msg.content === 'string' && /^【表情包：[^】]+】$/.test(msg.content.trim());
    let displayContent = msg.content;
    if (window.stickerSystem && window.stickerSystem.renderStickerInMessageSync) {
      displayContent = window.stickerSystem.renderStickerInMessageSync(msg.content, mountedGroupIds);
    }
    
    if (isOnlySticker && displayContent.includes('<img')) {
      contentHtml = `<div class="msg-sticker-alone-wrapper">${displayContent}</div>`;
    } else {
      // 支持引用渲染
      let quoteHtml = "";
      if (window.quoteSystem) {
        const parsed = await window.quoteSystem.parseQuote(msg.content);
        if (parsed) {
          quoteHtml = parsed.quoteHtml;
          displayContent = parsed.cleanText;
          if (window.stickerSystem && window.stickerSystem.renderStickerInMessageSync) {
            displayContent = window.stickerSystem.renderStickerInMessageSync(displayContent, mountedGroupIds);
          }
        }
      }
      contentHtml = `<div class="msg-text">${quoteHtml}${displayContent}</div>`;
    }
  }

  const avatarUrl = msg.senderType === 'user' ? resolveAvatar(activeSessionUserAvatar) : resolveAvatar(activeSessionCharAvatar);
  const emojiHtml = msg.reactionEmoji ? `<div class="bubble-attached-emoji" onclick="window.removeReaction(${msg.id}, event)">${msg.reactionEmoji}</div>` : "";
  
  let finalContentHtml = contentHtml;
  // 给动态追加出来的单一卡片体注入相对坐标和贴纸
  if (msg.contentType === 'image') {
    finalContentHtml = contentHtml.replace('class="image-bubble-card"', 'class="image-bubble-card" style="position: relative;"').replace('class="msg-image-placeholder-card"', 'class="msg-image-placeholder-card" style="position: relative;"') + emojiHtml;
  } else if (msg.contentType === 'voice') {
    finalContentHtml = contentHtml.replace('class="voice-bubble-card"', 'class="voice-bubble-card" style="position: relative;"').replace('class="voice-bubble-card"', 'class="voice-bubble-card" style="position: relative;"') + emojiHtml;
  } else if (msg.contentType === 'transfer' || msg.contentType === 'red_envelope' || msg.contentType === 'moment_share') {
    finalContentHtml = contentHtml.replace('class="wallet-bubble-card', 'class="wallet-bubble-card" style="position: relative;"') + emojiHtml;
  } else {
    finalContentHtml = contentHtml.replace('class="msg-text"', 'class="msg-text" style="position: relative;"').replace('class="msg-sticker-alone-wrapper"', 'class="msg-sticker-alone-wrapper" style="position: relative;"') + emojiHtml;
  }

  bubble.innerHTML = `
    <div class="msg-select-checkbox" style="display: ${isMultiSelectMode ? 'flex' : 'none'};">
      <input type="checkbox" class="msg-checkbox" data-msg-id="${msg.id}" onchange="updateSelectedCount()">
    </div>
    <img class="msg-avatar" src="${avatarUrl}">
    ${finalContentHtml}
  `;
  container.appendChild(bubble);
  container.scrollTop = container.scrollHeight;
}

// 绑定操作中心事件
function initContextMenuHandlers() {
  if (isContextMenuInitialized) return;
  isContextMenuInitialized = true;

  const menu = document.getElementById("bubble-context-menu");
  if (!menu) return;
  
  menu.onclick = (e) => {
    if (e.target === menu) {
      menu.style.display = "none";
    }
  };

  const btnCancel = document.getElementById("btn-menu-cancel");
  if (btnCancel) {
    btnCancel.onclick = () => {
      menu.style.display = "none";
    };
  }

  const btnEdit = document.getElementById("btn-menu-edit");
  if (btnEdit) {
    btnEdit.onclick = async () => {
      menu.style.display = "none";
      const msg = await db.messages.get(selectedMsgId);
      if (!msg) return;
      const newContent = prompt("请编辑您的消息内容:", msg.content);
      if (newContent !== null && newContent.trim() !== "") {
        await db.messages.update(selectedMsgId, { content: newContent.trim() });
        renderDialogMessages();
      }
    };
  }

  const btnFav = document.getElementById("btn-menu-favorite");
  if (btnFav) {
    btnFav.onclick = async () => {
      menu.style.display = "none";
      const msg = await db.messages.get(selectedMsgId);
      if (!msg) return;
      await db.messages.update(selectedMsgId, { isFavorite: 1 });
      alert("该消息已成功收入收藏室。");
    };
  }

  const btnMulti = document.getElementById("btn-menu-multi");
  if (btnMulti) {
    btnMulti.onclick = () => {
      menu.style.display = "none";
      enterMultiSelectMode();
    };
  }

  const btnRecall = document.getElementById("btn-menu-recall");
  if (btnRecall) {
    btnRecall.onclick = async () => {
      menu.style.display = "none";
      const msg = await db.messages.get(selectedMsgId);
      if (!msg) return;
      
      if (msg.senderType === 'user') {
        await db.messages.update(selectedMsgId, { isRecalled: 1 });
        renderDialogMessages();
      } else {
        alert("无法撤回，这不是您的发言！");
      }
    };
  }

  const btnDeleteSingle = document.getElementById("btn-menu-delete-single");
  if (btnDeleteSingle) {
    btnDeleteSingle.onclick = async () => {
      menu.style.display = "none";
      if (confirm("确定要删除这条消息吗？此操作不可逆。")) {
        await db.messages.delete(selectedMsgId);
        renderDialogMessages();
      }
    };
  }

  const btnReroll = document.getElementById("btn-menu-reroll");
  if (btnReroll) {
    btnReroll.onclick = async () => {
      menu.style.display = "none";
      const msg = await db.messages.get(selectedMsgId);
      if (!msg) return;

      let targetUserMsg = null;
      if (msg.senderType === 'user') {
        targetUserMsg = msg;
      } else {
        const rawList = await db.messages.where('sessionId').equals(activeSessionId).toArray();
        const history = rawList
          .filter(m => m.timestamp <= msg.timestamp)
          .sort((a, b) => a.timestamp - b.timestamp);
        
        for (let i = history.length - 1; i >= 0; i--) {
          if (history[i].senderType === 'user') {
            targetUserMsg = history[i];
            break;
          }
        }
      }

      if (!targetUserMsg) {
        alert("无法回溯，未能在上下文中搜寻到我的发言。");
        return;
      }

      if (confirm(`确定要回溯重回吗？\n\n此操作将擦除该消息之后（包括当前消息）的所有对话并重新获取 AI 回复。`)) {
        const rawList = await db.messages.where('sessionId').equals(activeSessionId).toArray();
        const toDelete = rawList.filter(m => m.timestamp > targetUserMsg.timestamp);
        
        for (let td of toDelete) {
          await db.messages.delete(td.id);
        }

        await renderDialogMessages();

        const btnReply = document.getElementById("btn-dialog-reply");
        if (btnReply) btnReply.click();
      }
    };
  }

  const btnMultiCancel = document.getElementById("btn-multi-cancel");
  if (btnMultiCancel) {
    btnMultiCancel.onclick = () => {
      exitMultiSelectMode();
    };
  }

  const btnMultiDelete = document.getElementById("btn-multi-delete");
  if (btnMultiDelete) {
    btnMultiDelete.onclick = async () => {
      const checked = document.querySelectorAll(".msg-checkbox:checked");
      if (checked.length === 0) return;
      if (confirm(`确认要彻底删除这 ${checked.length} 条选中的消息吗？`)) {
        for (let chk of checked) {
          const id = Number(chk.getAttribute("data-msg-id"));
          await db.messages.delete(id);
        }
        exitMultiSelectMode();
        renderDialogMessages();
      }
    };
  }
}

function enterMultiSelectMode() {
  isMultiSelectMode = true;
  document.getElementById("normal-input-row").style.display = "none";
  document.getElementById("multi-select-bar").style.display = "flex";
  document.getElementById("selected-count").innerText = "0";
  
  document.querySelectorAll(".msg-select-checkbox").forEach(el => el.style.display = "flex");
}

function exitMultiSelectMode() {
  isMultiSelectMode = false;
  document.getElementById("normal-input-row").style.display = "flex";
  document.getElementById("multi-select-bar").style.display = "none";
  
  document.querySelectorAll(".msg-select-checkbox").forEach(el => el.style.display = "none");
}

function updateSelectedCount() {
  const count = document.querySelectorAll(".msg-checkbox:checked").length;
  document.getElementById("selected-count").innerText = count;
}

// 桥接函数：调用独立出去的 app_prompts.js 进行 Prompt 构建
async function buildSystemPrompt(sessionId) {
  let basePrompt = await buildGlobalSystemPrompt(sessionId);
  // 注入表情包系统上下文
  if (window.stickerSystem && window.stickerSystem.buildStickerSystemPrompt) {
    const stickerPrompt = await window.stickerSystem.buildStickerSystemPrompt(sessionId);
    if (stickerPrompt) {
      basePrompt += '\n\n' + stickerPrompt;
    }
  }
  return basePrompt;
}

// 顶级事件绑定注册 (安全保护锁)
function bindChatAppEvents() {
  if (isChatAppEventsBound) return;
  isChatAppEventsBound = true;

  const btnNewChat = document.getElementById("btn-new-chat");
  if (btnNewChat) {
    btnNewChat.onclick = async () => {
      if (!activeUserPersonaId) { alert("请先去‘我的’中切换我的人设"); return; }
      const overlay = document.getElementById("new-chat-overlay");
      const list = document.getElementById("new-chat-list");
      if (!overlay || !list) return;
      list.innerHTML = "";

      try {
        const allArchives = await db.archives.toArray();
        const chars = allArchives.filter(c => c.type === 'character' || c.type === 'npc');
        
        chars.forEach(c => {
          const row = document.createElement("div");
          row.className = "menu-item";
          row.onclick = () => startSingleChat(c.id);
          row.innerHTML = `<span>${c.name} (${c.type === 'character' ? '角色' : 'NPC'})</span>`;
          list.appendChild(row);
        });

        overlay.classList.add("active");
      } catch (err) {
        console.error(err);
        alert("获取角色列表失败: " + err.message);
      }
    };
  }

  // 绑定“选择角色”弹层的右上角叉号关闭事件
  const btnCloseNewChat = document.getElementById("btn-close-new-chat");
  if (btnCloseNewChat) {
    btnCloseNewChat.onclick = () => {
      document.getElementById("new-chat-overlay").classList.remove("active");
    };
  }

  // 1. 发送消息
  const btnSend = document.getElementById("btn-dialog-send");
  const dialogInput = document.getElementById("dialog-input-text");
  
  if (btnSend && dialogInput) {
    // 仅阻止桌面端鼠标点击时输入框失去焦点
    btnSend.onmousedown = (e) => {
      e.preventDefault();
    };

    btnSend.onclick = async () => {
      let text = dialogInput.value.trim();
      if (!text) return;

      // 引用挂载检测
      if (window.quoteSystem && window.quoteSystem.getActiveQuote()) {
        text = `[QUOTE:${window.quoteSystem.getActiveQuote()}] ` + text;
        window.quoteSystem.clearQuote();
      }

      // 表情包过滤
      const processedText = window.stickerSystem ? await window.stickerSystem.processStickersInMessage(text, activeSessionId) : text;
      await saveAndRenderMessage('user', processedText);
      dialogInput.value = "";
      dialogInput.focus(); // 显式回焦，保证键盘在移动端与桌面端均能顺畅保持不收起 [1]
    };

    // 绑定回车发送事件
    dialogInput.onkeydown = (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        const isEnterSendEnabled = localStorage.getItem("settings-enter-send") === "true";
        if (isEnterSendEnabled) {
          e.preventDefault(); // 阻止回车产生物理换行
          btnSend.click();
        }
      }
    };
  }

  // 2. 获取 AI 仿真回复 (微信交易及多媒体引擎重构)
  const btnReply = document.getElementById("btn-dialog-reply");
  if (btnReply) {
    btnReply.onclick = async () => {
      const header = document.getElementById("dialog-header-title");
      const originalTitle = header.innerText;

      // 如果当前正在请求，点击按钮立即中断
      if (onlineAbortController) {
        onlineAbortController.abort();
        onlineAbortController = null;
        header.classList.remove("header-typing");
        header.innerText = originalTitle;
        btnReply.innerHTML = '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M19 9l1.25-2.75L23 5l-2.75-1.25L19 1 17.75 3.75 15 5l2.75 1.25L19 9zm-7.5.5L9 4 6.5 9.5 1 12l5.5 2.5L9 20l2.5-5.5 2.5-5.5 5.5-2.5-5.5-2.5zm7.5 5l-1.25 2.75L15 19l2.75 1.25L19 23l1.25-2.75L23 19l-2.75-1.25L19 14.5z"/></svg>';
        showToast("当前请求已终止");
        return;
      }

      const inputEl = document.getElementById("dialog-input-text");
      if (inputEl) inputEl.blur(); // 主动收回输入框焦距，强制收起软键盘 [1]
      
      header.classList.add("header-typing");
      // 切换成停止按钮 (浅红色圆角方块)
      btnReply.innerHTML = '<svg viewBox="0 0 24 24"><rect x="5" y="5" width="14" height="14" rx="3" fill="#f87171"/></svg>';

      try {
        onlineAbortController = new AbortController();
        const presetId = localStorage.getItem("global_api_preset_id");
        if (!presetId) throw new Error("未配置全局默认 API，请前往‘系统设置 - API 协议设置’中配置并应用！");
        const api = await db.api_presets.get(Number(presetId));
        if (!api) throw new Error("所选的 API 预设可能已被删除，请重新配置！");

        // === 【微信交易引擎核心逻辑】：AI自动拦截并领取对方发来的一切未拆红包/未收转账 ===
        const rawList = await db.messages.where('sessionId').equals(activeSessionId).toArray();
        const pendingUserTransactions = rawList.filter(m => m.senderType === 'user' && (m.contentType === 'transfer' || m.contentType === 'red_envelope'));
        
        let autoReclaimContext = "";
        for (let ut of pendingUserTransactions) {
          try {
            const data = JSON.parse(ut.content);
            if (data.status === 'pending') {
              // 模拟AI自动收钱行为并更新数据库
              data.status = ut.contentType === 'transfer' ? 'received' : 'opened';
              await db.messages.update(ut.id, { content: JSON.stringify(data) });
              
              // 自动合成记账文本提示词喂给大模型
              const transactionName = ut.contentType === 'transfer' ? '微信转账' : '微信红包';
              autoReclaimContext += `【系统通知：对方（${originalTitle}）已经确认领取并收下了你刚刚发送的${transactionName}，资金为 ￥ ${data.amount.toFixed(2)} 元${ut.contentType === 'red_envelope' ? `，红包备注为："${data.remark}"` : ''}】\n`;
            }
          } catch(e) { console.error(e); }
        }

        const history = await db.messages.where('sessionId').equals(activeSessionId).reverse().limit(10).toArray();
        history.reverse();
        
        const systemPrompt = await buildSystemPrompt(activeSessionId);

        // 检查"心声随动生产"开关状态
        const statusAutoToggle = document.getElementById("details-status-auto");
        const isStatusAutoOn = statusAutoToggle ? statusAutoToggle.checked : false;

        let finalSystemPrompt = systemPrompt;
        if (isStatusAutoOn) {
          const session = await db.sessions.get(activeSessionId);
          const charName = session ? (session.customCharName || session.name || "对方") : "对方";
          let myName = "我";
          if (session && session.userId) {
            const userArch = await db.archives.get(session.userId);
            if (userArch && userArch.name) myName = userArch.name;
          }

          finalSystemPrompt += `\n\n【心声随动指令（重要）】
你需要在回复正常对话内容之后，额外输出当前角色（${charName}）对 ${myName} 此时此刻的真实内心状态。
请严格按照以下格式输出：

正常对话内容...

[STATUS]
{ "attire": "当前穿着描述", "affection": "好感度描述(0-100)", "excitement": "兴奋度/紧绷感描述", "thoughts": "此刻真实倾诉想法", "hiddenCorners": "心底隐秘想法/反差心声" }`;
        }

        const messagesToSend = [{ role: "system", content: finalSystemPrompt }];
        
        // 核心注入：在消息对话前注入领取提醒，实现极其逼真的互动对白！
        if (autoReclaimContext) {
          messagesToSend.push({
            role: "system", 
            content: `【微信收账通知（请立刻动态做出符合性格特色的反应）】：你在打开微信时，屏幕上弹出了你刚刚点击领取并成功入账用户钱款的通知：\n${autoReclaimContext}\n请你在本次回复中，配合符合你自身身份口吻 and 态度的台词，对此做出道谢、调侃、戏谑或客气回应，严厉禁止说教！`
          });
        }

        history.forEach(h => {
          // 注入消息 ID 供引用系统识别
          const prefix = `[MSG_ID: ${h.id}] `;
          let displayContent = h.content;
          if (h.isRecalled === 1) {
            displayContent = "[已撤回该消息]";
          } else if (h.contentType === 'image') {
            try {
              const data = JSON.parse(h.content);
              displayContent = `[图片描述: ${data.text}]`;
            } catch(e) {}
          } else if (h.contentType === 'voice') {
            try {
              const data = JSON.parse(h.content);
              displayContent = `[语音转文字: ${data.text}]`;
            } catch(e) {}
          }
          messagesToSend.push({ role: h.senderType === 'user' ? 'user' : 'assistant', content: prefix + displayContent });
        });

        const response = await fetch(`${api.url}/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": `Bearer ${api.key}` },
          body: JSON.stringify({
            model: api.model,
            messages: messagesToSend,
            temperature: api.temperature
          }),
          signal: onlineAbortController.signal
        });

        if (!response.ok) {
          const errText = await response.text();
          throw new Error(`HTTP ${response.status} 错误: ${errText}`);
        }

        const result = await response.json();
        if (!result.choices || result.choices.length === 0) {
          throw new Error("模型服务返回数据异常，Choice 节点为空。");
        }

        let rawReply = result.choices[0].message.content;

        // 核心消除：自动擦除大模型在对白中误编或幻觉出来的 [MSG_ID: xxx] 标签
        rawReply = rawReply.replace(/[\[【]MSG_ID\s*:\s*\d+[\]】]/gi, "").trim();

        // === Char (AI) 撤回消息处理 ===
        const recallRegex = /[\[【](RECALL|撤回|撤回消息)(?:\s*:\s*(\d+))?[\]】]/i;
        const recallMatch = rawReply.match(recallRegex);
        if (recallMatch) {
          const targetId = recallMatch[2] ? Number(recallMatch[2]) : null;
          let targetMsg = null;
          if (targetId) {
            targetMsg = await db.messages.get(targetId);
          } else {
            const charMsgs = await db.messages.where('sessionId').equals(activeSessionId).and(m => m.senderType === 'char').toArray();
            targetMsg = charMsgs.sort((a,b) => b.timestamp - a.timestamp)[0];
          }

          if (targetMsg && targetMsg.senderType === 'char' && targetMsg.sessionId === activeSessionId) {
            await db.messages.update(targetMsg.id, { isRecalled: 1 });
            rawReply = rawReply.replace(recallRegex, "").trim();
            await renderDialogMessages();
          } else {
            rawReply = rawReply.replace(recallRegex, "").trim();
            alert(`系统提示：对方（${originalTitle}）试图撤回一则消息（ID: ${targetId || '最新'}），但由于消息ID无效，撤回失败！`);
          }
        }

        // === Char (AI) 自动驱使本地音乐播放指令解析 ===
        const playMusicRegex = /[\[【](PLAY_MUSIC|播放音乐|MCP_PLAY_MUSIC)[\]】]\s*(\{[\s\S]*?\})/i;
        const playMusicMatch = rawReply.match(playMusicRegex);
        if (playMusicMatch) {
          try {
            const parsed = JSON.parse(playMusicMatch[2]);
            const targetIndex = parseInt(parsed.index);
            if (!isNaN(targetIndex) && window.mcpSystem && typeof window.mcpSystem.playTrackByIndex === 'function') {
              window.mcpSystem.playTrackByIndex(targetIndex);
            } else if (parsed.title && window.mcpSystem && typeof window.mcpSystem.playTrackByTitle === 'function') {
              window.mcpSystem.playTrackByTitle(parsed.title);
            }
          } catch(e) {
            console.warn("解析 AI 自动放歌指令 JSON 失败:", e);
          }
          // 擦除放歌指令，避免污染对话气泡呈现
          rawReply = rawReply.replace(playMusicRegex, "").trim();
        }

        // === Char (AI) 表情反应处理 ===
        const reactRegex = /[\[【]REACT\s*:\s*(\d+)[\]】]\s*([\s\S]*?)(?=(?:\[|【|$))/i;
        const reactMatch = rawReply.match(reactRegex);
        if (reactMatch) {
          const targetId = Number(reactMatch[1]);
          const emoji = reactMatch[2].trim();
          const validEmojis = ["😂", "😚", "😌", "😊", "👿", "😪", "😭", "😣", "🙄", "🥺", "🥵", "🥰", "😉", "😏"];
          
          if (validEmojis.includes(emoji)) {
            const targetMsg = await db.messages.get(targetId);
            if (targetMsg && targetMsg.sessionId === activeSessionId) {
              const msgs = await db.messages.where('sessionId').equals(activeSessionId).sortBy('timestamp');
              const last20 = msgs.slice(-20);
              const isWithinLastRounds = last20.some(m => m.id === targetId);
              if (isWithinLastRounds) {
                await db.messages.update(targetId, { reactionEmoji: emoji });
                rawReply = rawReply.replace(reactRegex, "").trim();
                await renderDialogMessages();
              } else {
                rawReply = rawReply.replace(reactRegex, "").trim();
              }
            } else {
              rawReply = rawReply.replace(reactRegex, "").trim();
            }
          } else {
            rawReply = rawReply.replace(reactRegex, "").trim();
          }
        }

        // === 【微信交易及多媒体引擎核心逻辑：智能防掉格式托底解析器】：支持标准 JSON 与任何非标准全/半角括号格式的混合解析 ===
        // 托底正则：同时捕获 [TOKEN] / 【TOKEN】格式
        const transactionRegex = /(\[|【)(TRANSFER|RED_ENVELOPE|RECEIVE_TRANSFER|OPEN_RED_ENVELOPE|转账|红包|收钱|收转账|拆红包|领红包|OPEN_RED_ENVELOPE|VOICE|语音|IMAGE|图片)(\]|】)\s*([\s\S]*?)(?=(?:\[|【|$))/gi;
        let match;
        
        const sessionObj = await db.sessions.get(activeSessionId);
        const userName = sessionObj?.customUserName || "我";

        while ((match = transactionRegex.exec(rawReply)) !== null) {
          const tokenRaw = match[2].toUpperCase();
          const contentRaw = match[4].trim();
          
          let token = "";
          if (tokenRaw.includes("TRANSFER") || tokenRaw.includes("转账")) {
            if (tokenRaw.includes("RECEIVE") || tokenRaw.includes("收")) {
              token = "RECEIVE_TRANSFER";
            } else {
              token = "TRANSFER";
            }
          } else if (tokenRaw.includes("RED") || tokenRaw.includes("红包")) {
            if (tokenRaw.includes("OPEN") || tokenRaw.includes("拆") || tokenRaw.includes("领")) {
              token = "OPEN_RED_ENVELOPE";
            } else {
              token = "RED_ENVELOPE";
            }
          } else if (tokenRaw.includes("VOICE") || tokenRaw.includes("语音")) {
            token = "VOICE";
          } else if (tokenRaw.includes("IMAGE") || tokenRaw.includes("图片")) {
            token = "IMAGE";
          }

          if (!token) continue;

          let amount = 0;
          let duration = 5;
          let remark = "";
          let url = ""; // 直接初始化为空，不再需要虚假 URL
          let voiceText = "...";
          let imageText = "";

          // 1. 尝试执行标准的 JSON 解析
          let isJsonParsed = false;
          const jsonMatch = contentRaw.match(/\{[\s\S]*?\}/);
          if (jsonMatch) {
            try {
              const parsed = JSON.parse(jsonMatch[0]);
              amount = parseFloat(parsed.amount) || 0;
              duration = parseInt(parsed.duration) || 5;
              remark = parsed.remark || "";
              url = parsed.url || url;
              voiceText = parsed.text || parsed.voiceText || "...";
              imageText = parsed.text || parsed.imageText || "";
              isJsonParsed = true;
            } catch(e) {
              console.warn("托底解析：检测到 JSON 结构但解析失败，降级为文本正则提取", e);
            }
          }

          // 2. 降级文本数值与备注正则提取：支持 "【转账：500.00】"、"【语音：5秒 | 对白】" 等极端格式
          if (!isJsonParsed) {
            const numMatch = contentRaw.match(/[0-9]+(?:\.[0-9]+)?/);
            if (numMatch) {
              const parsedNum = parseFloat(numMatch[0]);
              amount = parsedNum;
              duration = parseInt(parsedNum) || 5;
            }
            
            let cleanRemark = contentRaw
              .replace(/[0-9]+(?:\.[0-9]+)?/g, "")
              .replace(/[:：|｜(（)）元秒\s]/g, "")
              .trim();
            remark = cleanRemark;
            voiceText = cleanRemark || "...";
            imageText = cleanRemark;
          }

          try {
            if (token === 'TRANSFER' && amount > 0) {
              const walletData = { amount: amount, status: 'pending', targetName: userName };
              const transMsg = {
                sessionId: activeSessionId,
                senderType: 'char',
                senderId: 0,
                content: JSON.stringify(walletData),
                contentType: 'transfer',
                timestamp: Date.now()
              };
              const newId = await db.messages.add(transMsg);
              transMsg.id = newId;
              // 核心修复：即时追加渲染至屏幕
              await appendMessageToDOM(transMsg);
            } 
            else if (token === 'RED_ENVELOPE' && amount > 0) {
              const walletData = { amount: amount, status: 'pending', remark: remark || "恭喜发财" };
              const redMsg = {
                sessionId: activeSessionId,
                senderType: 'char',
                senderId: 0,
                content: JSON.stringify(walletData),
                contentType: 'red_envelope',
                timestamp: Date.now()
              };
              const newId = await db.messages.add(redMsg);
              redMsg.id = newId;
              await appendMessageToDOM(redMsg);
            } 
            else if (token === 'RECEIVE_TRANSFER') {
              const msgs = await db.messages.where('sessionId').equals(activeSessionId).toArray();
              const pendingTransfer = msgs.find(m => m.senderType === 'user' && m.contentType === 'transfer' && JSON.parse(m.content).status === 'pending');
              if (pendingTransfer) {
                const transData = JSON.parse(pendingTransfer.content);
                transData.status = 'received';
                await db.messages.update(pendingTransfer.id, { content: JSON.stringify(transData) });
                // 核心修复：即时重刷页面以更新卡片渲染状态
                await renderDialogMessages();
              }
            } 
            else if (token === 'OPEN_RED_ENVELOPE') {
              const msgs = await db.messages.where('sessionId').equals(activeSessionId).toArray();
              const pendingEnvelope = msgs.find(m => m.senderType === 'user' && m.contentType === 'red_envelope' && JSON.parse(m.content).status === 'pending');
              if (pendingEnvelope) {
                const envData = JSON.parse(pendingEnvelope.content);
                envData.status = 'opened';
                await db.messages.update(pendingEnvelope.id, { content: JSON.stringify(envData) });
                await renderDialogMessages();
              }
            }
            else if (token === 'VOICE') {
              const msgData = { duration: duration, text: voiceText };
              const voiceMsg = {
                sessionId: activeSessionId,
                senderType: 'char',
                senderId: 0,
                content: JSON.stringify(msgData),
                contentType: 'voice',
                timestamp: Date.now()
              };
              const newId = await db.messages.add(voiceMsg);
              voiceMsg.id = newId;
              await appendMessageToDOM(voiceMsg);
            }
            else if (token === 'IMAGE') {
              const msgData = { url: url, text: imageText };
              const imageMsg = {
                sessionId: activeSessionId,
                senderType: 'char',
                senderId: 0,
                content: JSON.stringify(msgData),
                contentType: 'image',
                timestamp: Date.now()
              };
              const newId = await db.messages.add(imageMsg);
              imageMsg.id = newId;
              await appendMessageToDOM(imageMsg);
            }
          } catch(e) {
            console.error("微信交易及多媒体引擎：托底数据库操作失败:", e);
          }
        }

        // 强力擦除所有解析过的指令文本以确保对白干净呈现
        rawReply = rawReply.replace(transactionRegex, '').trim();

        // 尝试解析心声随动 [STATUS] 格式
        let statusJson = null;
        let textReply = rawReply;
        if (isStatusAutoOn) {
          const statusMatch = rawReply.match(/\[STATUS\]\s*(\{[\s\S]*?\})/);
          if (statusMatch) {
            try {
              statusJson = JSON.parse(statusMatch[1]);
              textReply = rawReply.replace(/\[STATUS\]\s*\{[\s\S]*?\}/, '').trim();
            } catch (e) {
              console.warn("解析心声 JSON 失败:", e);
            }
          }
        }

        // === 【消息层叠时序引擎 2.0】：多句拟真时间比例上屏，不再粗暴砍半 ===
        let parts = textReply.split(/\[SPLIT\]|【SPLIT】/i);
        if (parts.length < 2) {
          parts = textReply.split(/[\n\r]+/);
        }
        parts = parts.map(p => p.trim()).filter(p => p.length > 0);

        // 托底合并：如果某子句仅仅是一个单独的引用标记 [QUOTE:xx]，则自动将其合并至下一句对白中，防止拆分上屏产生空卡片
        let mergedParts = [];
        for (let i = 0; i < parts.length; i++) {
          const part = parts[i];
          const isOnlyQuote = /^[\[【](QUOTE|引用)\s*:\s*(\d+)[\]】]$/i.test(part);
          if (isOnlyQuote && i + 1 < parts.length) {
            parts[i + 1] = part + " " + parts[i + 1];
          } else {
            mergedParts.push(part);
          }
        }
        parts = mergedParts;
        
        if (parts.length < 2) {
          // 利用正向预查断言，自动在句号、感叹号、问号后进行智能切分
          parts = textReply.split(/(?<=[。！\？！!\?])\s*/);
          parts = parts.map(p => p.trim()).filter(p => p.length > 0);
        }

        // 递归上屏处理队列，模仿真人输入时间过渡
        let currentPartIndex = 0;
        async function renderNextPart() {
          if (currentPartIndex < parts.length) {
            await saveAndRenderMessage('char', parts[currentPartIndex]);
            currentPartIndex++;
            if (currentPartIndex < parts.length) {
              // 自动按照上一句对白字数的多少计算打字延迟量 (每字 60ms，最少 1000ms，最长 3000ms)
              const previousPart = parts[currentPartIndex - 1];
              const charCount = (previousPart && typeof previousPart === 'string') ? previousPart.length : 5;
              const delay = Math.max(1000, Math.min(3000, charCount * 60));
              setTimeout(renderNextPart, delay);
            } else {
              header.classList.remove("header-typing");
              header.innerText = originalTitle;
              
              // 打字输出全部安全结束后，调用静默自动总结检测钩子
              if (typeof checkAndTriggerAutoSummary !== 'undefined') {
                checkAndTriggerAutoSummary(activeSessionId);
              }
            }
          }
        }

        if (parts.length > 0) {
          await renderNextPart();
        } else {
          header.classList.remove("header-typing");
          header.innerText = originalTitle;

          if (typeof checkAndTriggerAutoSummary !== 'undefined') {
            checkAndTriggerAutoSummary(activeSessionId);
          }
        }

      } catch (err) {
        if (err.name === 'AbortError') {
          // 被中止，默默忽略，不触发错误提示卡片
          return;
        }
        console.error(err);
        showCustomAlert("API 发生错误", err.message);
      } finally {
        header.classList.remove("header-typing");
        header.innerText = originalTitle;
        btnReply.innerHTML = '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M19 9l1.25-2.75L23 5l-2.75-1.25L19 1 17.75 3.75 15 5l2.75 1.25L19 9zm-7.5.5L9 4 6.5 9.5 1 12l5.5 2.5L9 20l2.5-5.5 2.5-5.5 5.5-2.5-5.5-2.5zm7.5 5l-1.25 2.75L15 19l2.75 1.25L19 23l1.25-2.75L23 19l-2.75-1.25L19 14.5z"/></svg>';
        onlineAbortController = null;
      }
    };
  }

  // 3. 输入栏加号展开
  const btnExpand = document.getElementById("btn-chat-expand-toggle");
  if (btnExpand) {
    btnExpand.onclick = () => {
      document.getElementById("chat-expand-panel").classList.toggle("active");
    };
  }

  // 4. 对话配置专属头像本地文件直接存储为原生 Blob 二进制
  const fileChar = document.getElementById("file-details-char");
  const btnChar = document.getElementById("btn-upload-details-char");
  if (btnChar && fileChar) {
    btnChar.onclick = (e) => {
      e.preventDefault();
      fileChar.click();
    };
    fileChar.onchange = (e) => {
      if (e.target.files.length > 0) {
        detailsCharAvatarBlob = e.target.files[0];
        document.getElementById("details-char-avatar").value = "[本地上传图片]";
      }
    };
  }

  const fileUser = document.getElementById("file-details-user");
  const btnUser = document.getElementById("btn-upload-details-user");
  if (btnUser && fileUser) {
    btnUser.onclick = (e) => {
      e.preventDefault();
      fileUser.click();
    };
    fileUser.onchange = (e) => {
      if (e.target.files.length > 0) {
        detailsUserAvatarBlob = e.target.files[0];
        document.getElementById("details-user-avatar").value = "[本地上传图片]";
      }
    };
  }

  // 5. 表情包按钮：打开表情包选择栏
  const btnSticker = document.getElementById("btn-chat-sticker");
  if (btnSticker) {
    btnSticker.onclick = () => {
      document.getElementById("chat-expand-panel").classList.remove("active");
      if (window.stickerSystem && window.stickerSystem.openStickerSelector) {
        window.stickerSystem.openStickerSelector(activeSessionId);
      } else {
        alert("表情包系统尚未初始化，请先刷新页面。");
      }
    };
  }

  // 6. 线下功能唤起
  const btnChatOffline = document.getElementById("btn-chat-offline");
  if (btnChatOffline) {
    btnChatOffline.onclick = () => {
      document.getElementById("chat-expand-panel").classList.remove("active");
      document.getElementById("offline-select-overlay").classList.add("active");
    };
  }

  // 7. HTML 互动卡片唤起 (新增)
  const btnChatHtmlWidget = document.getElementById("btn-chat-html-widget");
  if (btnChatHtmlWidget) {
    btnChatHtmlWidget.onclick = () => {
      document.getElementById("chat-expand-panel").classList.remove("active");
      if (window.chatHtmlWidgetSystem && window.chatHtmlWidgetSystem.openPanel) {
        window.chatHtmlWidgetSystem.openPanel();
      }
    };
  }
}

async function startSingleChat(charId) {
  document.getElementById("new-chat-overlay").classList.remove("active");
  
  try {
    const userIdNum = Number(activeUserPersonaId);
    if (isNaN(userIdNum) || userIdNum <= 0) {
      alert("请先去‘我的’中切换我的人设");
      return;
    }
    const list = await db.sessions.where('userId').equals(userIdNum).toArray();
    let sess = list.find(s => s.charId === Number(charId));
    
    if (!sess) {
      const char = await db.archives.get(charId);
      const user = await db.archives.get(userIdNum);
      sess = {
        userId: userIdNum,
        charId: Number(charId),
        customCharName: char?.name || "",
        customCharAvatar: char?.avatar || null,
        customCharPersona: char?.persona || "",
        customUserName: user?.name || "我",
        customUserAvatar: user?.avatar || null,
        customUserPersona: user?.persona || "",
        lastMessageTime: Date.now()
      };
      sess.id = await db.sessions.add(sess);
    }

    openWeChatDialog(sess.id);
  } catch (err) {
    console.error(err);
    alert("开启聊天失败，详细原因: " + err.message);
  }
}

// 朋友圈 “我的” 子级侧边路由 (钱包渲染适配)
function openMeSub(target) {
  const panel = document.getElementById("me-sub-panel");
  const title = document.getElementById("me-sub-title");
  const body = document.getElementById("me-sub-body");
  const addBtn = document.getElementById("btn-me-sub-add");

  body.innerHTML = "";
  addBtn.style.display = "none";
  panel.classList.add("active");

  if (target === 'collection') {
    title.innerText = "收藏室";
    loadFavoritesList();
  } else if (target === 'wallet') {
    title.innerText = "微信钱包";
    if (window.walletSystem && window.walletSystem.renderWalletPage) {
      window.walletSystem.renderWalletPage(body);
    } else {
      body.innerHTML = `<div style="padding:40px; text-align:center;"><div style="font-size:32px; font-weight:700; color:#1e293b;">￥ 88,888.00</div></div>`;
    }
  }
}

function closeMeSub() {
  document.getElementById("me-sub-panel").classList.remove("active");
}

async function loadFavoritesList() {
  const body = document.getElementById("me-sub-body");
  body.innerHTML = '<div class="favorites-list" id="favorites-list-container"></div>';
  const container = document.getElementById("favorites-list-container");
  
  const favs = await db.messages.filter(m => m.isFavorite === 1).toArray();
  const offlineFavs = await db.offline_messages.filter(m => m.isFavorite === 1).toArray();
  const totalFavs = [...favs, ...offlineFavs];

  if (totalFavs.length === 0) {
    container.innerHTML = `<p style="padding:40px; text-align:center; color:var(--text-secondary); font-size: 13px;">暂无收藏记录</p>`;
    return;
  }
  
  totalFavs.sort((a,b) => b.timestamp - a.timestamp).forEach(f => {
    const item = document.createElement("div");
    item.className = "menu-item";
    item.style.flexDirection = "column";
    item.style.alignItems = "flex-start";
    item.style.gap = "6px";
    item.innerHTML = `
      <div style="font-size: 11px; color: var(--text-secondary); font-weight:500;">收藏于：${new Date(f.timestamp).toLocaleString()} ${f.theaterId !== undefined ? '【线下】' : '【线上】'}</div>
      <div style="font-size: 13px; color: var(--text-primary); word-break: break-all; font-weight:600;">${f.content}</div>
    `;
    container.appendChild(item);
  });
}

// 专属设置安全加载
const btnDialogDetails = document.getElementById("btn-dialog-details");
if (btnDialogDetails) {
  btnDialogDetails.onclick = async () => {
    if (!activeSessionId) {
      alert("当前无活跃对话，请先开启一个会话。");
      return;
    }
    try {
      const sess = await db.sessions.get(activeSessionId);
      if (!sess) {
        throw new Error("无法从数据库加载当前单聊会话记录！");
      }
      const char = sess.charId ? await db.archives.get(sess.charId) : null;
      const user = sess.userId ? await db.archives.get(sess.userId) : null;

      document.getElementById("details-char-name").value = sess.customCharName || char?.name || "";
      
      const cAvatar = sess.customCharAvatar || char?.avatar;
      document.getElementById("details-char-avatar").value = (cAvatar instanceof Blob) ? "[本地上传图片]" : (cAvatar || "");
      detailsCharAvatarBlob = (cAvatar instanceof Blob) ? cAvatar : null;

      document.getElementById("details-char-persona").value = sess.customCharPersona || char?.persona || "";
      document.getElementById("details-user-name").value = sess.customUserName || user?.name || "";
      
      const uAvatar = sess.customUserAvatar || user?.avatar;
      document.getElementById("details-user-avatar").value = (uAvatar instanceof Blob) ? "[本地上传图片]" : (uAvatar || "");
      detailsUserAvatarBlob = (uAvatar instanceof Blob) ? uAvatar : null;

      document.getElementById("details-user-persona").value = sess.customUserPersona || user?.persona || "";
      
      const selectMounted = document.getElementById("details-wb-mounted");
      if (selectMounted) {
        selectMounted.innerHTML = "";
        const wbEntries = await db.world_book_entries.toArray();
        wbEntries.forEach(entry => {
          const opt = document.createElement("option");
          opt.value = entry.id;
          opt.innerText = `[${entry.group}] ${entry.title}`;
          if (sess.mountedEntryIds && sess.mountedEntryIds.includes(entry.id)) {
            opt.selected = true;
          }
          selectMounted.appendChild(opt);
        });
      }

      // 渲染多媒体、时间感知等全新状态设置开关
      document.getElementById("details-status-auto").checked = !!sess.statusAutoToggle;
      document.getElementById("details-multimedia-toggle").checked = !!sess.multimediaToggle;
      document.getElementById("details-allow-recall-toggle").checked = !!sess.allowCharRecall;
      document.getElementById("details-allow-reaction-toggle").checked = !!sess.allowCharReaction;
      
      const timeToggle = document.getElementById("details-time-toggle");
      // 核心修复：用 !== 0 表达式，精准阻断 0 的宽松映射，锁定详情页自定义关闭状态
      timeToggle.checked = sess.timePerceptionToggle !== 0; 
      
      const customTimeContainer = document.getElementById("details-custom-time-container");
      customTimeContainer.style.display = timeToggle.checked ? "none" : "block";

      if (sess.customTimeData) {
        try {
          const td = JSON.parse(sess.customTimeData);
          document.getElementById("details-time-year").value = td.year || 2026;
          document.getElementById("details-time-month").value = td.month || 1;
          document.getElementById("details-time-day").value = td.day || 1;
          document.getElementById("details-time-hour").value = td.hour || 12;
          document.getElementById("details-time-minute").value = td.minute || 0;
        } catch(e) {}
      }

      // 渲染表情包挂载列表
      const mountedStickersEl = document.getElementById("details-mounted-stickers");
      const mountBtn = document.getElementById("btn-details-sticker-mount");
      if (mountedStickersEl && mountBtn) {
        if (typeof stickerSystem !== 'undefined' && stickerSystem.init) {
          await stickerSystem.init();
          const mountedIds = await stickerSystem.getMountedGroupIds(activeSessionId);
          if (mountedIds.length > 0) {
            const names = stickerSystem.stickerGroups
              ? stickerSystem.stickerGroups.filter(g => mountedIds.includes(g.id)).map(g => g.name)
              : [];
            mountedStickersEl.textContent = names.length > 0 ? names.join('、') : '已挂载 ' + mountedIds.length + ' 个分组';
          } else {
            mountedStickersEl.textContent = '暂无挂载';
          }
        } else {
          mountedStickersEl.textContent = '暂无挂载';
        }
        mountBtn.onclick = async () => {
          if (typeof stickerSystem !== 'undefined' && stickerSystem.openStickerMountSettings) {
            await stickerSystem.openStickerMountSettings(activeSessionId);
          }
        };
      }

      document.getElementById("chat-details-panel").classList.add("active");
    } catch (err) {
      console.error(err);
      alert(`加载设置失败: ${err.message}`);
    }
  };
}

function closeChatDetails() {
  document.getElementById("chat-details-panel").classList.remove("active");
}

const btnSaveDetails = document.getElementById("btn-save-details");
if (btnSaveDetails) {
  btnSaveDetails.onclick = async () => {
    const charName = document.getElementById("details-char-name").value.trim();
    const charAvatarInput = document.getElementById("details-char-avatar").value.trim();
    
    let charAvatar = null;
    if (charAvatarInput === "[本地上传图片]") {
      charAvatar = detailsCharAvatarBlob; 
    } else {
      charAvatar = charAvatarInput; 
    }

    const charPersona = document.getElementById("details-char-persona").value.trim();
    const userName = document.getElementById("details-user-name").value.trim();
    const userAvatarInput = document.getElementById("details-user-avatar").value.trim();
    
    let userAvatar = null;
    if (userAvatarInput === "[本地上传图片]") {
      userAvatar = detailsUserAvatarBlob; 
    } else {
      userAvatar = userAvatarInput;
    }

    const userPersona = document.getElementById("details-user-persona").value.trim();

    const selectMounted = document.getElementById("details-wb-mounted");
    let mountedEntryIds = [];
    if (selectMounted) {
      mountedEntryIds = Array.from(selectMounted.selectedOptions).map(opt => Number(opt.value));
    }

    // 获取并写入全新的多媒体、时间模拟器属性
    const statusAutoToggle = document.getElementById("details-status-auto").checked;
    const multimediaToggle = document.getElementById("details-multimedia-toggle").checked;
    const timePerceptionToggle = document.getElementById("details-time-toggle").checked;
    const allowCharRecall = document.getElementById("details-allow-recall-toggle").checked;
    const allowCharReaction = document.getElementById("details-allow-reaction-toggle").checked;

    const timeData = {
      year: parseInt(document.getElementById("details-time-year").value) || 2026,
      month: parseInt(document.getElementById("details-time-month").value) || 1,
      day: parseInt(document.getElementById("details-time-day").value) || 1,
      hour: parseInt(document.getElementById("details-time-hour").value) || 12,
      minute: parseInt(document.getElementById("details-time-minute").value) || 0
    };

    await db.sessions.update(activeSessionId, {
      customCharName: charName,
      customCharAvatar: charAvatar,
      customCharPersona: charPersona,
      customUserName: userName,
      customUserAvatar: userAvatar,
      customUserPersona: userPersona,
      mountedEntryIds: mountedEntryIds,
      statusAutoToggle: statusAutoToggle ? 1 : 0,
      multimediaToggle: multimediaToggle ? 1 : 0,
      timePerceptionToggle: timePerceptionToggle ? 1 : 0,
      allowCharRecall: allowCharRecall ? 1 : 0,
      allowCharReaction: allowCharReaction ? 1 : 0,
      customTimeData: JSON.stringify(timeData),
      customTimeSavedAt: Date.now() // 核心写入：场景自定义时间的物理起始基准时间戳
    });

    activeSessionCharAvatar = charAvatar;
    activeSessionUserAvatar = userAvatar;

    showToast("当前对话专属设定已成功保存并在此对话内独立生效。");
    closeChatDetails();
    document.getElementById("dialog-header-title").innerText = charName;
    
    renderDialogMessages();
  };
}

async function saveAndRenderMessage(senderType, content, contentType = 'text') {
  const msg = {
    sessionId: activeSessionId,
    senderType,
    senderId: senderType === 'user' ? Number(activeUserPersonaId) : 0,
    content,
    contentType,
    timestamp: Date.now()
  };
  msg.id = await db.messages.add(msg);
  await appendMessageToDOM(msg);
}

// 语音消息与图片场景描述展开机制挂载
window.toggleVoiceTranslation = function(msgId, el) {
  const textEl = document.getElementById(`voice-trans-${msgId}`);
  if (textEl) {
    textEl.style.display = textEl.style.display === 'none' ? 'block' : 'none';
  }
};
window.toggleImageText = function(msgId, el) {
  const textEl = document.getElementById(`image-desc-${msgId}`);
  if (textEl) {
    textEl.style.display = textEl.style.display === 'none' ? 'block' : 'none';
  }
};

// ============================================================
//             线下业务交互逻辑
// ============================================================

function closeOfflineSelect() {
  document.getElementById("offline-select-overlay").classList.remove("active");
}

function triggerTheaterMode() {
  closeOfflineSelect();
  document.getElementById("win-theater-list").classList.add("active");
  renderTheaterList();
}

async function renderTheaterList() {
  const container = document.getElementById("theater-list-container");
  if (!container) return;
  container.innerHTML = "";

  const theaters = await db.theaters.where('sessionId').equals(activeSessionId).toArray();
  if (theaters.length === 0) {
    container.innerHTML = `<p style="text-align:center;color:var(--text-secondary);font-size:13px;padding:40px 0;">暂无独立剧场，点击右上角新建一个剧场</p>`;
    return;
  }

  theaters.forEach(th => {
    const card = document.createElement("div");
    card.className = "archive-card";
    card.style.style = "margin-bottom: 10px;";
    card.innerHTML = `
      <div class="card-info" onclick="enterTheater(${th.id})" style="cursor:pointer; flex: 1;">
        <div class="card-name">${th.name}</div>
        <div class="card-desc">每轮字数: ${th.minWordCount}-${th.maxWordCount} | 视角 (Char/User): ${th.charPOV || '第三人称'}/${th.userPOV || '第二人称'}</div>
      </div>
      <div class="card-actions">
        <button class="btn-icon" onclick="editArchiveItem(${th.id})">
          <svg viewBox="0 0 24 24"><path fill="currentColor" d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25z"/></svg>
        </button>
        <button class="btn-icon btn-delete" onclick="deleteTheater(${th.id})">
          <svg viewBox="0 0 24 24"><path fill="currentColor" d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
        </button>
      </div>
    `;
    container.appendChild(card);
  });
}

function openNewTheaterForm() {
  document.getElementById("new-theater-overlay").classList.add("active");
}

function closeNewTheaterForm() {
  document.getElementById("new-theater-overlay").classList.remove("active");
}

async function saveNewTheater() {
  const name = document.getElementById("theater-name").value.trim();
  const scenario = document.getElementById("theater-scenario").value.trim();
  const minWord = Number(document.getElementById("theater-min-word").value) || 50;
  const maxWord = Number(document.getElementById("theater-max-word").value) || 300;
  const carryMemory = document.getElementById("theater-carry-memory").checked;
  const charPOV = document.getElementById("theater-char-pov").value;
  const userPOV = document.getElementById("theater-user-pov").value;

  if (!name || !scenario) {
    alert("请完整填写剧场名称与情景设定！");
    return;
  }

  const theaterId = await db.theaters.add({
    sessionId: activeSessionId,
    name,
    scenario,
    minWordCount: minWord,
    maxWordCount: maxWord,
    carryMemory: carryMemory ? 1 : 0,
    charPOV,
    userPOV,
    createdAt: Date.now()
  });

  closeNewTheaterForm();
  closeTheaterList();
  enterTheater(theaterId);
}

async function deleteTheater(id) {
  if (confirm("确定要删除该独立剧场及其中所有的线下卡片记录吗？")) {
    await db.theaters.delete(id);
    await db.offline_messages.where('theaterId').equals(id).delete();
    renderTheaterList();
  }
}

function closeTheaterList() {
  document.getElementById("win-theater-list").classList.remove("active");
}

function enterTheater(theaterId) {
  isOfflineTheater = true;
  activeTheaterId = theaterId;
  exitOfflineMultiSelectMode();
  
  db.theaters.get(theaterId).then(th => {
    document.getElementById("offline-chat-title").innerText = `独立剧场：${th.name}`;
    document.getElementById("win-offline-chat").classList.add("active");
    renderOfflineMessages();
  });
}

function triggerAppointmentMode() {
  closeOfflineSelect();
  isOfflineTheater = false;
  activeTheaterId = 0;
  exitOfflineMultiSelectMode();

  document.getElementById("offline-chat-title").innerText = "赴约中...";
  document.getElementById("win-offline-chat").classList.add("active");
  renderOfflineMessages();
}

function exitOfflineChat() {
  document.getElementById("win-offline-chat").classList.remove("active");
}

// 渲染线下独立白描段落卡片
async function renderOfflineMessages() {
  const container = document.getElementById("offline-messages-flow");
  if (!container) return;
  container.innerHTML = "";

  let msgs = [];
  if (isOfflineTheater) {
    msgs = await db.offline_messages
      .where('theaterId').equals(activeTheaterId)
      .sortBy('timestamp');
  } else {
    msgs = await db.offline_messages
      .where('sessionId').equals(activeSessionId)
      .and(m => m.isTheater === 0)
      .sortBy('timestamp');
  }

  const sess = await db.sessions.get(activeSessionId);
  const char = await db.archives.get(sess.charId);
  const user = await db.archives.get(sess.userId);
  const charName = sess.customCharName || char?.name || "对方";
  const userName = sess.customUserName || user?.name || "我";

  const fragment = document.createDocumentFragment();
  msgs.forEach(m => {
    const card = document.createElement("div");
    card.className = `offline-card ${m.senderType === 'user' ? 'user' : 'char'}`;
    card.setAttribute("data-msg-id", m.id);

    card.ondblclick = (e) => {
      e.preventDefault();
      if (isOfflineMultiSelectMode) return;
      activeOfflineSelectedMsgId = Number(m.id);
      document.getElementById("offline-bubble-context-menu").style.display = "flex";
    };

    const senderLabel = m.senderType === 'user' ? userName : charName;
    const timeStr = new Date(m.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    card.innerHTML = `
      <div class="offline-select-checkbox" style="display: ${isOfflineMultiSelectMode ? 'flex' : 'none'};">
        <input type="checkbox" class="offline-msg-checkbox" data-msg-id="${m.id}" onchange="updateOfflineSelectedCount()">
      </div>
      <div class="offline-card-header">
        <span>${senderLabel}</span>
        <span>${timeStr}</span>
      </div>
      <div class="offline-card-body">${m.content}</div>
    `;
    fragment.appendChild(card);
  });

  container.appendChild(fragment);
  container.scrollTop = container.scrollHeight;
}

// 绑定线下卡片专属双击操作菜单 (安全保护锁)
function initOfflineContextMenuHandlers() {
  if (isOfflineContextMenuInitialized) return;
  isOfflineContextMenuInitialized = true;

  const menu = document.getElementById("offline-bubble-context-menu");
  if (!menu) return;
  
  menu.onclick = (e) => {
    if (e.target === menu) {
      menu.style.display = "none";
    }
  };

  const btnOfflineCancel = document.getElementById("btn-offline-menu-cancel");
  if (btnOfflineCancel) {
    btnOfflineCancel.onclick = () => {
      menu.style.display = "none";
    };
  }

  const btnOfflineEdit = document.getElementById("btn-offline-menu-edit");
  if (btnOfflineEdit) {
    btnOfflineEdit.onclick = async () => {
      menu.style.display = "none";
      const msg = await db.offline_messages.get(activeOfflineSelectedMsgId);
      if (!msg) return;
      const newContent = prompt("请编辑您的线下卡片描述:", msg.content);
      if (newContent !== null && newContent.trim() !== "") {
        await db.offline_messages.update(activeOfflineSelectedMsgId, { content: newContent.trim() });
        renderOfflineMessages();
      }
    };
  }

  const btnOfflineFav = document.getElementById("btn-offline-menu-favorite");
  if (btnOfflineFav) {
    btnOfflineFav.onclick = async () => {
      menu.style.display = "none";
      const msg = await db.offline_messages.get(activeOfflineSelectedMsgId);
      if (!msg) return;
      await db.offline_messages.update(activeOfflineSelectedMsgId, { isFavorite: 1 });
      alert("该段落卡片已成功收入收藏室。");
    };
  }

  const btnOfflineDeleteSingle = document.getElementById("btn-offline-menu-delete-single");
  if (btnOfflineDeleteSingle) {
    btnOfflineDeleteSingle.onclick = async () => {
      menu.style.display = "none";
      if (confirm("确定要删除这条线下记录吗？此操作不可逆。")) {
        await db.offline_messages.delete(activeOfflineSelectedMsgId);
        renderOfflineMessages();
      }
    };
  }

  const btnOfflineMulti = document.getElementById("btn-offline-menu-multi");
  if (btnOfflineMulti) {
    btnOfflineMulti.onclick = () => {
      menu.style.display = "none";
      enterOfflineMultiSelectMode();
    };
  }

  const btnOfflineReroll = document.getElementById("btn-offline-menu-reroll");
  if (btnOfflineReroll) {
    btnOfflineReroll.onclick = async () => {
      menu.style.display = "none";
      const msg = await db.offline_messages.get(activeOfflineSelectedMsgId);
      if (!msg) return;

      let targetUserMsg = null;
      let rawList = [];
      if (isOfflineTheater) {
        rawList = await db.offline_messages.where('theaterId').equals(activeTheaterId).toArray();
      } else {
        rawList = await db.offline_messages.where('sessionId').equals(activeSessionId).and(m => m.isTheater === 0).toArray();
      }

      if (msg.senderType === 'user') {
        targetUserMsg = msg;
      } else {
        const history = rawList
          .filter(m => m.timestamp <= msg.timestamp)
          .sort((a, b) => a.timestamp - b.timestamp);
        
        for (let i = history.length - 1; i >= 0; i--) {
          if (history[i].senderType === 'user') {
            targetUserMsg = history[i];
            break;
          }
        }
      }

      if (!targetUserMsg) {
        alert("无法回溯，未能在上下文中搜寻到我的发言。");
        return;
      }

      if (confirm("确定要回溯重回吗？\n\n此操作将擦除该发言之后（包括当前发言）的所有线下段落卡片并重新获取 AI 回复。")) {
        const toDelete = rawList.filter(m => m.timestamp > targetUserMsg.timestamp);
        for (let td of toDelete) {
          await db.offline_messages.delete(td.id);
        }
        await renderOfflineMessages();
        const offlineReplyBtn = document.getElementById("btn-offline-reply");
        if (offlineReplyBtn) offlineReplyBtn.click();
      }
    };
  }

  const btnOfflineMultiCancel = document.getElementById("btn-offline-multi-cancel");
  if (btnOfflineMultiCancel) {
    btnOfflineMultiCancel.onclick = exitOfflineMultiSelectMode;
  }

  const btnOfflineMultiDelete = document.getElementById("btn-offline-multi-delete");
  if (btnOfflineMultiDelete) {
    btnOfflineMultiDelete.onclick = async () => {
      const checked = document.querySelectorAll(".offline-msg-checkbox:checked");
      if (checked.length === 0) return;
      if (confirm(`确认要彻底删除这 ${checked.length} 条选中的线下记录吗？`)) {
        for (let chk of checked) {
          const id = Number(chk.getAttribute("data-msg-id"));
          await db.offline_messages.delete(id);
        }
        exitOfflineMultiSelectMode();
        renderOfflineMessages();
      }
    };
  }
}

function enterOfflineMultiSelectMode() {
  isOfflineMultiSelectMode = true;
  document.getElementById("offline-input-row").style.display = "none";
  document.getElementById("offline-multi-select-bar").style.display = "flex";
  document.getElementById("offline-selected-count").innerText = "0";
  document.getElementById("offline-messages-flow").classList.add("multi-selecting");
  
  document.querySelectorAll(".offline-select-checkbox").forEach(el => el.style.display = "flex");
}

function exitOfflineMultiSelectMode() {
  isOfflineMultiSelectMode = false;
  document.getElementById("offline-input-row").style.display = "flex";
  document.getElementById("offline-multi-select-bar").style.display = "none";
  document.getElementById("offline-messages-flow").classList.remove("multi-selecting");
  
  document.querySelectorAll(".offline-select-checkbox").forEach(el => {
    if (el) el.style.display = "none";
  });
}

function updateOfflineSelectedCount() {
  const count = document.querySelectorAll(".offline-msg-checkbox:checked").length;
  document.getElementById("offline-selected-count").innerText = count;
}

// 发送线下白描
async function sendOfflineMessage() {
  const textEl = document.getElementById("offline-input-text");
  if (!textEl) return;
  const content = textEl.value.trim();
  if (!content) return;

  const msg = {
    theaterId: isOfflineTheater ? activeTheaterId : 0,
    sessionId: activeSessionId,
    isTheater: isOfflineTheater ? 1 : 0,
    senderType: 'user',
    content,
    timestamp: Date.now()
  };
  await db.offline_messages.add(msg);
  textEl.value = "";
  await renderOfflineMessages();
}

// AI 线下专属大模型白描输出
async function triggerOfflineReply() {
  const header = document.getElementById("offline-chat-title");
  const originalTitle = header.innerText;
  const btnOfflineReply = document.getElementById("btn-offline-reply");

  // 如果当前正在请求，点击按钮立即中断
  if (offlineAbortController) {
    offlineAbortController.abort();
    offlineAbortController = null;
    header.classList.remove("header-typing");
    header.innerText = originalTitle;
    if (btnOfflineReply) btnOfflineReply.innerHTML = '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M19 9l1.25-2.75L23 5l-2.75-1.25L19 1 17.75 3.75 15 5l2.75 1.25L19 9zm-7.5.5L9 4 6.5 9.5 1 12l5.5 2.5L9 20l2.5-5.5 2.5-5.5 5.5-2.5-5.5-2.5zm7.5 5l-1.25 2.75L15 19l2.75 1.25L19 23l1.25-2.75L23 19l-2.75-1.25L19 14.5z"/></svg>';
    showToast("当前请求已终止");
    return;
  }

  header.classList.add("header-typing");
  if (btnOfflineReply) btnOfflineReply.innerHTML = '<svg viewBox="0 0 24 24"><rect x="5" y="5" width="14" height="14" rx="3" fill="#f87171"/></svg>';

  try {
    offlineAbortController = new AbortController();
    const presetId = localStorage.getItem("global_api_preset_id");
    if (!presetId) throw new Error("未配置全局默认 API，请前往‘系统设置 - API 协议设置’中配置！");
    const api = await db.api_presets.get(Number(presetId));
    if (!api) throw new Error("所选的 API 预设可能已被删除，请重新配置！");

    let rawList = [];
    if (isOfflineTheater) {
      rawList = await db.offline_messages.where('theaterId').equals(activeTheaterId).sortBy('timestamp');
    } else {
      rawList = await db.offline_messages.where('sessionId').equals(activeSessionId).and(m => m.isTheater === 0).sortBy('timestamp');
    }

    const history = rawList.slice(-15); 
    const systemPrompt = await buildOfflineSystemPrompt(activeSessionId, activeTheaterId, isOfflineTheater);

    const messagesToSend = [{ role: "system", content: systemPrompt }];
    history.forEach(h => {
      messagesToSend.push({ role: h.senderType === 'user' ? 'user' : 'assistant', content: h.content });
    });

    const response = await fetch(`${api.url}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${api.key}` },
      body: JSON.stringify({
        model: api.model,
        messages: [{ role: "system", content: systemPrompt }, ...messagesToSend.slice(1)],
        temperature: api.temperature
      }),
      signal: offlineAbortController.signal
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`HTTP ${response.status} 错误: ${errText}`);
    }

    const result = await response.json();
    if (!result.choices || result.choices.length === 0) {
      throw new Error("模型服务返回数据异常，Choice 节点为空。");
    }

    const rawReply = result.choices[0].message.content.trim();

    const msg = {
      theaterId: isOfflineTheater ? activeTheaterId : 0,
      sessionId: activeSessionId,
      isTheater: isOfflineTheater ? 1 : 0,
      senderType: 'char',
      content: rawReply,
      timestamp: Date.now()
    };
    await db.offline_messages.add(msg);
    await renderOfflineMessages();

  } catch (err) {
    if (err.name === 'AbortError') {
      // 默默忽略，由上面统一处理
      return;
    }
    console.error(err);
    showCustomAlert("API 发生错误", err.message);
  } finally {
    header.classList.remove("header-typing");
    header.innerText = originalTitle;
    if (btnOfflineReply) btnOfflineReply.innerHTML = '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M19 9l1.25-2.75L23 5l-2.75-1.25L19 1 17.75 3.75 15 5l2.75 1.25L19 9zm-7.5.5L9 4 6.5 9.5 1 12l5.5 2.5L9 20l2.5-5.5 2.5-5.5 5.5-2.5-5.5-2.5zm7.5 5l-1.25 2.75L15 19l2.75 1.25L19 23l1.25-2.75L23 19l-2.75-1.25L19 14.5z"/></svg>';
    offlineAbortController = null;
  }
}

// 线下场景设置面板逻辑 (支持 POV 参数装载)
async function openOfflineDetails() {
  const sess = await db.sessions.get(activeSessionId);
  if (isOfflineTheater) {
    const th = await db.theaters.get(activeTheaterId);
    document.getElementById("offline-detail-min-word").value = th.minWordCount || 50;
    document.getElementById("offline-detail-max-word").value = th.maxWordCount || 300;
    // 自动总结轮数默认继承线上设置
    document.getElementById("offline-detail-auto-summary").value = sess.autoSummaryInterval || 10; 
    document.getElementById("offline-detail-char-pov").value = th.charPOV || "第三人称";
    document.getElementById("offline-detail-user-pov").value = th.userPOV || "第二人称";
    document.getElementById("btn-end-appointment").style.display = "none";
  } else {
    // 赴约模式
    document.getElementById("offline-detail-min-word").value = sess.offlineMinWordCount || 50;
    document.getElementById("offline-detail-max-word").value = sess.offlineMaxWordCount || 200;
    // 自动总结轮数默认继承线上设置
    document.getElementById("offline-detail-auto-summary").value = sess.autoSummaryInterval || sess.offlineAutoSummaryCount || 10;
    document.getElementById("offline-detail-char-pov").value = sess.offlineCharPOV || "第三人称";
    document.getElementById("offline-detail-user-pov").value = sess.offlineUserPOV || "第二人称";
    document.getElementById("btn-end-appointment").style.display = "block";
  }

  // 渲染线下世界书
  const selectMounted = document.getElementById("offline-details-wb-mounted");
  if (selectMounted) {
    selectMounted.innerHTML = "";
    const wbEntries = await db.world_book_entries.toArray();
    const currentMounted = isOfflineTheater ? (sess.mountedEntryIds || []) : (sess.offlineMountedEntryIds || sess.mountedEntryIds || []);
    wbEntries.forEach(entry => {
      const opt = document.createElement("option");
      opt.value = entry.id;
      opt.innerText = `[${entry.group}] ${entry.title}`;
      if (currentMounted.includes(entry.id)) {
        opt.selected = true;
      }
      selectMounted.appendChild(opt);
    });
  }

  document.getElementById("win-offline-details").classList.add("active");
}

function closeOfflineDetails() {
  document.getElementById("win-offline-details").classList.remove("active");
}

async function saveOfflineDetails() {
  const minWord = Number(document.getElementById("offline-detail-min-word").value) || 50;
  const maxWord = Number(document.getElementById("offline-detail-max-word").value) || 200;
  const autoSummary = Number(document.getElementById("offline-detail-auto-summary").value) || 10;
  const charPOV = document.getElementById("offline-detail-char-pov").value;
  const userPOV = document.getElementById("offline-detail-user-pov").value;

  const selectMounted = document.getElementById("offline-details-wb-mounted");
  let mountedEntryIds = [];
  if (selectMounted) {
    mountedEntryIds = Array.from(selectMounted.selectedOptions).map(opt => Number(opt.value));
  }

  if (isOfflineTheater) {
    await db.theaters.update(activeTheaterId, {
      minWordCount: minWord,
      maxWordCount: maxWord,
      charPOV,
      userPOV
    });
  } else {
    // 赴约模式
    await db.sessions.update(activeSessionId, {
      offlineMinWordCount: minWord,
      offlineMaxWordCount: maxWord,
      autoSummaryInterval: autoSummary, // 默认回写继承至线上自动总结区间配置
      offlineAutoSummaryCount: autoSummary,
      offlineMountedEntryIds: mountedEntryIds,
      offlineCharPOV: charPOV,
      offlineUserPOV: userPOV
    });
  }

  alert("线下场景配置已成功保存！");
  closeOfflineDetails();
}

// 结束赴约模式 (赴约模式专属记忆回写与长效记忆库存储同步)
async function endAppointment() {
  if (!confirm("确定要结束当前的线下赴约吗？\n\n系统将自动根据当前的总结系统提示词生成一段经历总结，并无缝注入角色心智，成为后续长效记忆的一部分。")) return;
  
  const header = document.getElementById("offline-chat-title");
  header.classList.add("header-typing");
  header.innerText = "正在记忆同步中...";

  try {
    const presetId = localStorage.getItem("global_api_preset_id");
    const api = await db.api_presets.get(Number(presetId));
    if (!api) throw new Error("无法加载全局 API 预设，无法同步记忆。");

    const msgs = await db.offline_messages
      .where('sessionId').equals(activeSessionId)
      .and(m => m.isTheater === 0)
      .sortBy('timestamp');

    if (msgs.length === 0) {
      alert("暂无对话数据，无需总结记忆。");
      return;
    }

    let dialogText = "";
    const sess = await db.sessions.get(activeSessionId);
    const char = await db.archives.get(sess.charId);
    const user = await db.archives.get(sess.userId);
    const charName = sess.customCharName || char?.name || "对方";
    const userName = sess.customUserName || user?.name || "我";

    msgs.forEach(m => {
      const sender = m.senderType === 'user' ? userName : charName;
      dialogText += `[${sender}]: ${m.content}\n`;
    });

    const summaryPromptTemplate = sess.summarySystemPrompt || "以第三人称视角，按照时间顺序总结发生的所有事件，不允许有任何感情色彩，不超过150字。";

    const summaryPrompt = `请对以下发生的线下约会场景与白描对话经历进行深度、简练的总结。
总结要求：
1. 依照规范执行总结："${summaryPromptTemplate}"
2. 此总结将被永久保留在该角色的“长久记忆库”中，供后续检索召回。

---
线下对话原文：
${dialogText}
---`;

    const response = await fetch(`${api.url}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${api.key}` },
      body: JSON.stringify({
        model: api.model,
        messages: [{ role: "user", content: summaryPrompt }],
        temperature: 0.5
      })
    });

    if (!response.ok) throw new Error("API 总结调用失败");

    const result = await response.json();
    const summaryContent = result.choices[0].message.content.trim();

    // 1. 无缝回写长期角色记忆
    const currentPersona = sess.customCharPersona || char?.persona || "";
    const updatedPersona = `${currentPersona}\n\n【线下共同经历记忆（结束赴约时同步注入）：\n${summaryContent}】`;

    await db.sessions.update(activeSessionId, {
      customCharPersona: updatedPersona
    });

    // 2. 将线下总结无缝写入 summaries 记忆数据库中，支持长周期模糊召回！
    await db.summaries.add({
      sessionId: activeSessionId,
      startRound: 1,
      endRound: msgs.length,
      content: `[线下赴约共同经历记忆]：` + summaryContent,
      keywords: JSON.stringify(["线下见面", "赴约约会", charName]),
      timestamp: Date.now()
    });

    await db.offline_messages
      .where('sessionId').equals(activeSessionId)
      .and(m => m.isTheater === 0)
      .delete();

    alert(`赴约已圆满结束！\n\n线下经历总结已成功载入至角色的“长久记忆库”和脑海中：\n\n${summaryContent}`);
    
    closeOfflineDetails();
    exitOfflineChat();

  } catch (err) {
    console.error(err);
    alert("总结约会经历失败: " + err.message);
  } finally {
    header.classList.remove("header-typing");
    header.innerText = "线下见面";
  }
}

// 安全收拢事件监听注册，防范 DOM null 崩溃并在生命周期内强制单次绑定限制 [1]
function bindOfflineChatAppEvents() {
  if (isOfflineChatAppEventsBound) return;
  isOfflineChatAppEventsBound = true;

  const btnOfflineSend = document.getElementById("btn-offline-send");
  if (btnOfflineSend) btnOfflineSend.onclick = sendOfflineMessage;

  const btnOfflineReply = document.getElementById("btn-offline-reply");
  if (btnOfflineReply) btnOfflineReply.onclick = triggerOfflineReply;

  const btnSaveOfflineDetails = document.getElementById("btn-save-offline-details");
  if (btnSaveOfflineDetails) btnSaveOfflineDetails.onclick = saveOfflineDetails;

  const btnEndAppointment = document.getElementById("btn-end-appointment");
  if (btnEndAppointment) btnEndAppointment.onclick = endAppointment;
}

// 微信语音以及自定义图片发设绑定 (核心去原生 Prompt)
function bindMultimediaEvents() {
  // 1. 语音发送交互
  const btnVoiceTrigger = document.getElementById("btn-chat-voice-trigger");
  if (btnVoiceTrigger) {
    btnVoiceTrigger.onclick = () => {
      document.getElementById("chat-expand-panel").classList.remove("active");
      document.getElementById("voice-input-overlay").classList.add("active");
    };
  }

  const btnVoiceSubmit = document.getElementById("btn-voice-submit");
  if (btnVoiceSubmit) {
    btnVoiceSubmit.onclick = async () => {
      const duration = parseInt(document.getElementById("voice-duration-slider").value) || 5;
      const text = document.getElementById("voice-input-text").value.trim();
      
      if (!text) {
        alert("请输入语音转写内容文本（用于 AI 识别感知）！");
        return;
      }

      const voiceData = {
        duration: duration,
        text: text
      };

      await saveAndRenderMessage('user', JSON.stringify(voiceData), 'voice');
      
      // 重置并清理
      document.getElementById("voice-input-text").value = "";
      document.getElementById("voice-duration-slider").value = 5;
      document.getElementById("voice-duration-val").innerText = "5";
      document.getElementById("voice-input-overlay").classList.remove("active");
    };
  }

  // 2. 自定义图片伴随说明发送交互
  const btnPhotoTrigger = document.getElementById("btn-chat-photo");
  if (btnPhotoTrigger) {
    btnPhotoTrigger.onclick = () => {
      document.getElementById("chat-expand-panel").classList.remove("active");
      document.getElementById("image-input-overlay").classList.add("active");
    };
  }

  const btnImageSubmit = document.getElementById("btn-image-submit");
  if (btnImageSubmit) {
    btnImageSubmit.onclick = async () => {
      const fileInput = document.getElementById("image-file-input");
      const captionText = document.getElementById("image-input-text").value.trim();

      if (!captionText) {
        alert("为了让 AI 伙伴能看懂您的图片意图，请务必填写具体的画面场景描述！");
        return;
      }

      const processAndSend = async (imgUrl) => {
        const imgData = {
          url: imgUrl, // 如果用户实际上传了图片，imgUrl 为 Base64 Data URL；如果没有上传，则是空字符串
          text: captionText
        };
        await saveAndRenderMessage('user', JSON.stringify(imgData), 'image');
        
        // 重置清理
        if (fileInput) fileInput.value = "";
        const label = document.getElementById("image-file-name-label");
        if (label) label.innerText = "未选择文件";
        document.getElementById("image-input-text").value = "";
        document.getElementById("image-input-overlay").classList.remove("active");
      };

      if (fileInput && fileInput.files && fileInput.files.length > 0) {
        const reader = new FileReader();
        reader.onload = async (e) => {
          await processAndSend(e.target.result);
        };
        reader.readAsDataURL(fileInput.files[0]);
      } else {
        // 如果未上传物理图片，URL 属性直接设为空，安全依赖全新的灰色卡片进行干净渲染
        await processAndSend("");
      }
    };
  }
}

// 脚本载入时完成全局顶级、单次安全绑定
initContextMenuHandlers();
initOfflineContextMenuHandlers(); 
bindChatAppEvents();
bindOfflineChatAppEvents();
bindMultimediaEvents(); // 核心挂载：多媒体弹窗交互
