/**
 * app_desktop_pet.js - 独立多状态悬浮桌宠与真机系统级悬浮窗联动引擎
 */
(function() {
  const STATE_NAMES = {
    default: "初始化",
    happy: "开心",
    sad: "难过",
    angry: "生气",
    hesitant: "犹豫",
    wash: "洗漱",
    eat: "吃饭",
    sleep: "睡觉",
    watch: "看着你"
  };

  const desktopPetSystem = {
    activeCharId: null,
    currentPetConfig: null,
    currentState: 'default',
    bubbleTimer: null,

    // 初始化桌宠环境
    init: async function() {
      this.createDomElements();
      await this.syncWithActiveSession();
    },

    // 监控活动会话
    syncWithActiveSession: async function() {
      if (typeof activeSessionId !== 'undefined' && activeSessionId) {
        try {
          const sess = await db.sessions.get(activeSessionId);
          if (sess && sess.charId) {
            this.activeCharId = sess.charId;
            const char = await db.archives.get(sess.charId);
            const warningEl = document.getElementById("mcp-pet-char-warning");
            if (warningEl) {
              warningEl.innerText = `当前绑定角色：${char ? char.name : '未知'}`;
              warningEl.style.color = "#07c160"; // 绿色提示就绪
            }
            await this.loadPetConfig(sess.charId);
            this.renderPetToDesktop();
            this.onStateSelectChange(); // 刷新 MCP 面板中对应状态的展示
            return;
          }
        } catch (e) {
          console.error("同步活动会话桌宠失败:", e);
        }
      }
      
      // 回退未进入会话状态
      const warningEl = document.getElementById("mcp-pet-char-warning");
      if (warningEl) {
        warningEl.innerText = "当前绑定角色：无 (请进入会话后配置)";
        warningEl.style.color = "#e11d48";
      }
      this.currentPetConfig = null;
      this.activeCharId = null;
      this.renderPetToDesktop();
    },

    // 创建 DOM（供 PWA/浏览器环境内作为兜底呈现）
    createDomElements: function() {
      if (document.getElementById("desktop-pet-container")) return;

      const container = document.createElement("div");
      container.id = "desktop-pet-container";
      container.style.display = "none"; // 默认隐藏

      const img = document.createElement("img");
      img.id = "desktop-pet-img";
      
      const bubble = document.createElement("div");
      bubble.id = "desktop-pet-bubble";
      bubble.className = "pet-bubble";

      container.appendChild(bubble);
      container.appendChild(img);
      document.body.appendChild(container);

      // 绑定指针手势拖动
      this.bindDragEvents(container);

      // 双击触发灵魂唤醒对话
      container.ondblclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.handleDoubleClick();
      };
    },

    // 拖动逻辑（仅在网页内悬浮时有效）
    bindDragEvents: function(el) {
      let isDragging = false;
      let startX, startY;
      let initialX, initialY;

      el.addEventListener('pointerdown', (e) => {
        isDragging = true;
        startX = e.clientX;
        startY = e.clientY;
        const rect = el.getBoundingClientRect();
        initialX = rect.left;
        initialY = rect.top;
        el.setPointerCapture(e.pointerId);
      });

      el.addEventListener('pointermove', (e) => {
        if (!isDragging) return;
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        
        let newX = initialX + dx;
        let newY = initialY + dy;
        const maxW = window.innerWidth - el.clientWidth;
        const maxH = window.innerHeight - el.clientHeight;
        newX = Math.max(0, Math.min(maxW, newX));
        newY = Math.max(0, Math.min(maxH, newY));

        el.style.left = `${newX}px`;
        el.style.top = `${newY}px`;
        el.style.bottom = 'auto';
        el.style.right = 'auto';
      });

      el.addEventListener('pointerup', (e) => {
        isDragging = false;
        el.releasePointerCapture(e.pointerId);
      });
    },

    // 从 IndexedDB 加载当前角色的专属桌宠设定
    loadPetConfig: async function(charId) {
      if (!charId) return;
      try {
        let config = await db.desktop_pets.get(charId);
        if (!config) {
          config = {
            charId: charId,
            mode: 'custom',
            statesConfig: {},
            customDialogues: {}
          };
          Object.keys(STATE_NAMES).forEach(st => {
            config.customDialogues[st] = {
              probability: st === 'default' ? 100 : 0,
              textLines: ""
            };
          });
          await db.desktop_pets.add(config);
        }
        if (!config.statesConfig) config.statesConfig = {};
        if (!config.customDialogues) config.customDialogues = {};
        Object.keys(STATE_NAMES).forEach(st => {
          if (!config.customDialogues[st]) {
            config.customDialogues[st] = {
              probability: st === 'default' ? 100 : 0,
              textLines: ""
            };
          }
        });
        this.currentPetConfig = config;
      } catch (e) {
        console.error("加载桌宠 IndexedDB 数据失败:", e);
      }
    },

    // 渲染或更新桌宠外观（支持网页渲染与安卓原生悬浮窗双端同步）
    renderPetToDesktop: function() {
      const container = document.getElementById("desktop-pet-container");
      if (!container) return;

      const isPetEnabled = localStorage.getItem("settings-mcp-pet-enabled") === "true";
      
      // 如果未开启，或者数据未加载，双端卸载
      if (!isPetEnabled || !this.currentPetConfig) {
        container.style.display = "none";
        if (window.AndroidMCP && typeof window.AndroidMCP.hideDesktopPet === 'function') {
          window.AndroidMCP.hideDesktopPet(); // 联动真机：隐藏原生系统悬浮窗
        }
        return;
      }

      const size = parseInt(localStorage.getItem("mcp-pet-size-slider") || "100");
      const base64 = this.currentPetConfig.statesConfig[this.currentState] || this.currentPetConfig.statesConfig['default'];

      // 核心消减双生桌宠：如果检测到处于安卓特权外壳中，隐藏网页 DOM 桌宠，100% 交由真机系统级悬浮窗托管！ [1]
      if (window.AndroidMCP && typeof window.AndroidMCP.showDesktopPet === 'function') {
        container.style.display = "none"; // 隐藏 DOM 容器，杜绝两个桌宠重叠
        if (base64) {
          try {
            window.AndroidMCP.showDesktopPet(base64, size);
          } catch(e) {
            console.error("同步原生系统级桌宠失败:", e);
          }
        }
        return;
      }

      // 网页端 PWA 正常渲染
      container.style.display = "block";
      container.style.width = `${size}px`;
      container.style.height = `${size}px`;

      const imgEl = document.getElementById("desktop-pet-img");
      if (base64) {
        imgEl.src = base64;
      } else {
        imgEl.src = 'data:image/svg+xml;utf8,<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><circle cx="12" cy="12" r="10" fill="%23fca5a5"/><text x="12" y="15" font-size="8" text-anchor="middle" fill="%23ffffff">无图</text></svg>';
      }
    },

    // 气泡冒泡机制 (真机环境下直接发送给安卓系统 TextView 进行全局桌面渲染) [1]
    popBubble: function(text, duration = 3000) {
      // 优先调用安卓真机系统级悬浮气泡
      if (window.AndroidMCP && typeof window.AndroidMCP.showDesktopPetBubble === 'function') {
        try {
          window.AndroidMCP.showDesktopPetBubble(text, duration);
          return;
        } catch(e) {
          console.error("调用原生悬浮窗冒泡失败:", e);
        }
      }

      // 网页内 DOM 冒泡兜底
      const bubble = document.getElementById("desktop-pet-bubble");
      if (!bubble) return;

      bubble.innerText = text;
      bubble.classList.add("active");

      if (this.bubbleTimer) clearTimeout(this.bubbleTimer);
      this.bubbleTimer = setTimeout(() => {
        bubble.classList.remove("active");
      }, duration);
    },

    // 双击触发灵魂唤醒对话
    handleDoubleClick: async function() {
      if (!this.activeCharId) return;

      if (typeof openWeChatDialog === 'function' && typeof activeSessionId !== 'undefined') {
        const list = await db.sessions.where('charId').equals(this.activeCharId).toArray();
        if (list.length > 0) {
          openWeChatDialog(list[0].id);
        }
      }

      if (this.currentPetConfig.mode === 'api') {
        await this.triggerApiInteraction();
      } else {
        this.triggerCustomInteraction();
      }
    },

    // 自定义对话响应逻辑 (台词 + 概率概率)
    triggerCustomInteraction: function() {
      if (!this.currentPetConfig) return;

      const candidates = [];
      Object.keys(STATE_NAMES).forEach(st => {
        const cfg = this.currentPetConfig.customDialogues[st];
        if (cfg) {
          const prob = parseInt(cfg.probability) || 0;
          if (prob > 0) {
            candidates.push({ state: st, weight: prob });
          }
        }
      });

      if (candidates.length === 0) {
        candidates.push({ state: 'default', weight: 100 });
      }

      const totalWeight = candidates.reduce((acc, cur) => acc + cur.weight, 0);
      let rand = Math.random() * totalWeight;
      let selectedState = 'default';
      for (let cand of candidates) {
        rand -= cand.weight;
        if (rand <= 0) {
          selectedState = cand.state;
          break;
        }
      }

      this.currentState = selectedState;
      this.renderPetToDesktop();

      const dialogueCfg = this.currentPetConfig.customDialogues[selectedState];
      const lines = dialogueCfg && dialogueCfg.textLines 
        ? dialogueCfg.textLines.split('\n').map(l => l.trim()).filter(l => l.length > 0)
        : [];

      if (lines.length > 0) {
        const phrase = lines[Math.floor(Math.random() * lines.length)];
        this.popBubble(phrase);
      } else {
        this.popBubble(`(处于[${STATE_NAMES[selectedState]}]状态)`);
      }
    },

    // 实时生成 API 交互
    triggerApiInteraction: async function() {
      this.popBubble("思考中...");

      try {
        const presetId = localStorage.getItem("global_api_preset_id");
        if (!presetId) throw new Error("未配置全局默认 API");
        const api = await db.api_presets.get(Number(presetId));
        if (!api) throw new Error("API预设丢失");

        const sess = await db.sessions.get(activeSessionId);
        const char = await db.archives.get(sess.charId);

        const prompt = `你现在是用户的桌面悬浮桌宠，扮演【${char.name}】。
当前人设背景：${sess.customCharPersona || char.persona || ""}。
请以符合你自身性格、当前情绪和桌宠身份的口吻，简短地对用户说一句话（必须控制在20个字以内，严禁长篇大论）。
同时你必须在回答的最后一行以 \`[PET_STATE]状态名\` 的格式返回你的新状态动作（状态名只能是以下之一：初始化, 开心, 难过, 生气, 犹豫, 洗漱, 吃饭, 睡觉, 看着你）。`;

        const response = await fetch(`${api.url}/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": `Bearer ${api.key}` },
          body: JSON.stringify({
            model: api.model,
            messages: [{ role: "system", content: prompt }, { role: "user", content: "双击了你" }],
            temperature: 0.8
          })
        });

        if (!response.ok) throw new Error("连接 API 失败");

        const result = await response.json();
        let reply = result.choices[0].message.content.trim();

        const stateMatch = reply.match(/\[PET_STATE\]\s*([\s\S]*?)$/i);
        let foundState = 'default';
        if (stateMatch) {
          const stateName = stateMatch[1].trim();
          const matchedKey = Object.keys(STATE_NAMES).find(key => STATE_NAMES[key] === stateName);
          if (matchedKey) foundState = matchedKey;
          reply = reply.replace(/\[PET_STATE\]\s*[\s\S]*?$/i, "").trim();
        }

        this.currentState = foundState;
        this.renderPetToDesktop();
        this.popBubble(reply || "(晃动了身体)");
      } catch (e) {
        console.error("桌宠实时生成 API 出错:", e);
        this.popBubble("气流阻塞了...");
      }
    },

    // 控制 MCP 面板中状态的选择改变
    onStateSelectChange: function() {
      if (!this.currentPetConfig) return;
      const select = document.getElementById("mcp-pet-state-select");
      if (!select) return;
      const st = select.value;

      const previewBox = document.getElementById("mcp-pet-state-preview");
      if (previewBox) {
        const base64 = this.currentPetConfig.statesConfig[st];
        previewBox.innerHTML = base64 
          ? `<img src="${base64}" style="width:100%; height:100%; object-fit:contain;">`
          : `<span style="font-size:8px; color:var(--text-secondary);">无图</span>`;
      }

      const probInput = document.getElementById("mcp-pet-state-prob");
      const dialoguesArea = document.getElementById("mcp-pet-state-dialogues");
      
      const dialogueCfg = this.currentPetConfig.customDialogues[st];
      if (probInput && dialogueCfg) {
        probInput.value = dialogueCfg.probability !== undefined ? dialogueCfg.probability : (st === 'default' ? 100 : 0);
      }
      if (dialoguesArea && dialogueCfg) {
        dialoguesArea.value = dialogueCfg.textLines || "";
      }
    },

    // 从 MCP 选项卡收集并保存数据
    saveMcpUiSettings: async function() {
      if (!this.currentPetConfig) return;

      const modeSelect = document.getElementById("mcp-pet-mode");
      if (modeSelect) {
        this.currentPetConfig.mode = modeSelect.value;
      }

      const select = document.getElementById("mcp-pet-state-select");
      if (select) {
        const st = select.value;
        const probInput = document.getElementById("mcp-pet-state-prob");
        const dialoguesArea = document.getElementById("mcp-pet-state-dialogues");

        if (!this.currentPetConfig.customDialogues[st]) {
          this.currentPetConfig.customDialogues[st] = {};
        }
        if (probInput) {
          this.currentPetConfig.customDialogues[st].probability = parseInt(probInput.value) || 0;
        }
        if (dialoguesArea) {
          this.currentPetConfig.customDialogues[st].textLines = dialoguesArea.value;
        }
      }

      await db.desktop_pets.put(this.currentPetConfig);
      this.renderPetToDesktop();
    },

    // 上传对应状态的 Base64 动作图
    handleStateImageUpload: function(fileEl) {
      if (fileEl.files.length > 0 && this.currentPetConfig) {
        const select = document.getElementById("mcp-pet-state-select");
        if (!select) return;
        const st = select.value;

        const reader = new FileReader();
        reader.onload = async (e) => {
          const base64 = e.target.result;
          this.currentPetConfig.statesConfig[st] = base64;
          
          await db.desktop_pets.put(this.currentPetConfig);
          showToast(`[${STATE_NAMES[st]}] 状态动画图上传成功！`);
          
          this.onStateSelectChange();
          this.renderPetToDesktop();
        };
        reader.readAsDataURL(fileEl.files[0]);
      }
    },

    // 清除动作图
    clearStateImage: async function() {
      if (this.currentPetConfig) {
        const select = document.getElementById("mcp-pet-state-select");
        if (!select) return;
        const st = select.value;

        delete this.currentPetConfig.statesConfig[st];
        await db.desktop_pets.put(this.currentPetConfig);
        showToast(`已清空 [${STATE_NAMES[st]}] 状态动画图`);
        
        this.onStateSelectChange();
        this.renderPetToDesktop();
      }
    },

    // 改变大小（同步改变系统悬浮窗与网页悬浮窗）
    changePetSize: function(val) {
      const sizeVal = document.getElementById("mcp-pet-size-val");
      if (sizeVal) sizeVal.innerText = `${val}dp`;
      localStorage.setItem("mcp-pet-size-slider", val);
      
      this.renderPetToDesktop();
      
      if (window.AndroidMCP && typeof window.AndroidMCP.updateDesktopPetSize === 'function') {
        try {
          window.AndroidMCP.updateDesktopPetSize(parseInt(val)); // 同步更改真机物理悬浮窗尺寸
        } catch(e) {
          console.error("设置原生悬浮窗尺寸失败:", e);
        }
      }
    },

    // 全局控制开启与关闭（支持真机系统悬浮窗权限拦截申请）
    togglePetActive: function(toggleEl) {
      const isEnabled = toggleEl.checked;
      if (isEnabled) {
        if (window.AndroidMCP && typeof window.AndroidMCP.checkOverlayPermission === 'function') {
          try {
            const hasPermission = window.AndroidMCP.checkOverlayPermission();
            if (!hasPermission) {
              toggleEl.checked = false;
              showCustomConfirm("需要悬浮窗权限", "由于安卓系统限制，启动桌面桌宠必须授予「显示在其他应用上层」权限。是否现在前往系统设置授予？", () => {
                window.AndroidMCP.requestOverlayPermission();
              });
              return;
            }
          } catch(e) {
            console.error("检查真机悬浮窗权限异常:", e);
          }
        }
        
        localStorage.setItem("settings-mcp-pet-enabled", "true");
        this.renderPetToDesktop();
        showToast("桌面悬浮桌宠已开启！");
      } else {
        localStorage.setItem("settings-mcp-pet-enabled", "false");
        const container = document.getElementById("desktop-pet-container");
        if (container) container.style.display = "none";
        
        if (window.AndroidMCP && typeof window.AndroidMCP.hideDesktopPet === 'function') {
          try {
            window.AndroidMCP.hideDesktopPet();
          } catch(e) {
            console.error("隐藏真机原生桌宠异常:", e);
          }
        }
        showToast("桌宠已退出");
      }
    },

    // 渲染 UI 面板设置初始回显
    loadMcpPanelState: function() {
      if (!this.currentPetConfig) return;

      const isPetEnabled = localStorage.getItem("settings-mcp-pet-enabled") === "true";
      const toggle = document.getElementById("settings-mcp-pet-toggle");
      if (toggle) toggle.checked = isPetEnabled;

      const modeSelect = document.getElementById("mcp-pet-mode");
      if (modeSelect) modeSelect.value = this.currentPetConfig.mode || "custom";

      const sizeSlider = document.getElementById("mcp-pet-size-slider");
      const size = localStorage.getItem("mcp-pet-size-slider") || "100";
      if (sizeSlider) sizeSlider.value = size;
      const sizeVal = document.getElementById("mcp-pet-size-val");
      if (sizeVal) sizeVal.innerText = `${size}dp`;

      this.onStateSelectChange();
    }
  };

  window.desktopPetSystem = desktopPetSystem;

  const origOpenWeChatDialog = window.openWeChatDialog;
  window.openWeChatDialog = async function(sessionId) {
    if (typeof origOpenWeChatDialog === 'function') {
      await origOpenWeChatDialog(sessionId);
    }
    await desktopPetSystem.syncWithActiveSession();
  };

  document.addEventListener("DOMContentLoaded", () => {
    desktopPetSystem.init();
  });
})();
