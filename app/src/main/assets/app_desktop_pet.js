/**
 * app_desktop_pet.js - 独立多状态悬浮桌宠与真机解耦控制联动引擎
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
    editingCharId: null,      // 当前正在 MCP 面板中配置/编辑的 CharID
    activePetCharId: null,    // 全局当前正在显示/活跃的桌宠 CharID
    editingPetConfig: null,   // 正在配置的桌宠数据
    activePetConfig: null,    // 正在活跃的桌宠数据
    currentState: 'default',
    bubbleTimer: null,

    // 初始化桌宠环境
    init: async function() {
      this.createDomElements();
      
      // 1. 读取全局活跃桌宠 ID，保障冷启动自愈
      const savedActiveCharId = localStorage.getItem("active_pet_char_id");
      if (savedActiveCharId && savedActiveCharId !== "null" && savedActiveCharId !== "undefined") {
        this.activePetCharId = Number(savedActiveCharId);
        await this.loadActivePetConfig(this.activePetCharId);
      }
      
      // 2. 同步当前的编辑窗口
      await this.syncWithActiveSession();
      this.renderPetToDesktop();
    },

    // 监控活动会话以装载 MCP 面板回显，但不破坏桌宠在桌面上的持续显示
    syncWithActiveSession: async function() {
      if (typeof activeSessionId !== 'undefined' && activeSessionId) {
        try {
          const sess = await db.sessions.get(activeSessionId);
          if (sess && sess.charId) {
            this.editingCharId = sess.charId;
            await this.loadEditingPetConfig(sess.charId);
            this.loadMcpPanelState();
            return;
          }
        } catch (e) {
          console.error("同步活动会话桌宠失败:", e);
        }
      }
      
      this.editingCharId = null;
      this.editingPetConfig = null;
      this.loadMcpPanelState();
    },

    // 网页内 DOM 容器构建（仅作为非安卓环境下的兜底呈现）
    createDomElements: function() {
      // 核心防冲突 1：如果处于 Android 外壳环境（哪怕延迟加载），彻底禁止创建任何 DOM 元素
      if (window.AndroidMCP || (window.parent && window.parent.AndroidMCP)) {
        return;
      }

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

      this.bindDragEvents(container);

      // 双击唤醒
      container.ondblclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.handleDoubleClick();
      };
    },

    // 网页内拖动逻辑
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

    // 辅助加载编辑中桌宠
    loadEditingPetConfig: async function(charId) {
      this.editingPetConfig = await this.getOrCreatePetConfig(charId);
    },

    // 辅助加载当前活跃桌宠
    loadActivePetConfig: async function(charId) {
      this.activePetConfig = await this.getOrCreatePetConfig(charId);
    },

    // 数据库防穿透创建
    getOrCreatePetConfig: async function(charId) {
      if (!charId) return null;
      try {
        let config = await db.desktop_pets.get(charId);
        if (!config) {
          config = {
            charId: charId,
            mode: 'custom',
            statesConfig: {},
            customDialogues: {},
            petEnabled: false,
            petSize: 100,
            activeMsgEnabled: false,
            activeMsgInterval: 10
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
        return config;
      } catch (e) {
        console.error("加载桌宠配置失败:", e);
        return null;
      }
    },

    // 渲染或更新全局活跃桌宠的外观 (只与当前活跃的 activePetConfig 相关，与当前聊天页是谁彻底脱钩) [1]
    renderPetToDesktop: function() {
      // 核心防冲突 2：如果在真机环境下，强行将网页 DOM 桌宠永久彻底拔除，杜绝双桌宠异常
      if (window.AndroidMCP || (window.parent && window.parent.AndroidMCP)) {
        const container = document.getElementById("desktop-pet-container");
        if (container) container.remove(); // 强制移出网页 DOM
        
        // 渲染真机系统级窗口
        if (window.AndroidMCP && typeof window.AndroidMCP.showDesktopPet === 'function') {
          if (this.activePetCharId && this.activePetConfig && this.activePetConfig.petEnabled) {
            const size = this.activePetConfig.petSize || 100;
            const base64 = this.activePetConfig.statesConfig[this.currentState] || this.activePetConfig.statesConfig['default'];
            if (base64) {
              window.AndroidMCP.showDesktopPet(base64, size);
            }
          } else {
            window.AndroidMCP.hideDesktopPet();
          }
        }
        return;
      }

      // 网页 PWA 端正常渲染
      const container = document.getElementById("desktop-pet-container");
      if (!container) return;

      if (!this.activePetCharId || !this.activePetConfig || !this.activePetConfig.petEnabled) {
        container.style.display = "none";
        return;
      }

      container.style.display = "block";
      const size = this.activePetConfig.petSize || 100;
      container.style.width = `${size}px`;
      container.style.height = `${size}px`;

      const imgEl = document.getElementById("desktop-pet-img");
      const base64 = this.activePetConfig.statesConfig[this.currentState] || this.activePetConfig.statesConfig['default'];
      if (base64) {
        imgEl.src = base64;
      } else {
        imgEl.src = 'data:image/svg+xml;utf8,<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><circle cx="12" cy="12" r="10" fill="%23fca5a5"/><text x="12" y="15" font-size="8" text-anchor="middle" fill="%23ffffff">无图</text></svg>';
      }
    },

    // 气泡冒泡重定向
    popBubble: function(text, duration = 3000) {
      if (window.AndroidMCP && typeof window.AndroidMCP.showDesktopPetBubble === 'function') {
        try {
          window.AndroidMCP.showDesktopPetBubble(text, duration);
          return;
        } catch(e) {
          console.error("调用原生悬浮窗冒泡失败:", e);
        }
      }

      const bubble = document.getElementById("desktop-pet-bubble");
      if (!bubble) return;

      bubble.innerText = text;
      bubble.classList.add("active");

      if (this.bubbleTimer) clearTimeout(this.bubbleTimer);
      this.bubbleTimer = setTimeout(() => {
        bubble.classList.remove("active");
      }, duration);
    },

    // 双击调起 App (基于当前活跃活跃桌宠绑定的角色) [1]
    handleDoubleClick: async function() {
      if (!this.activePetCharId) return;

      if (typeof openWeChatDialog === 'function' && typeof activeSessionId !== 'undefined') {
        const list = await db.sessions.where('charId').equals(this.activePetCharId).toArray();
        if (list.length > 0) {
          openWeChatDialog(list[0].id);
        }
      }

      if (this.activePetConfig.mode === 'api') {
        await this.triggerApiInteraction();
      } else {
        this.triggerCustomInteraction();
      }
    },

    // 真机系统桌面双击后台静默触发
    handleDoubleClickBackground: async function() {
      if (!this.activePetCharId) return;

      if (this.activePetConfig.mode === 'api') {
        await this.triggerApiInteraction();
      } else {
        this.triggerCustomInteraction();
      }
    },

    // 自定义对话触发 (作用于当前活跃活跃桌宠) [1]
    triggerCustomInteraction: function() {
      if (!this.activePetConfig) return;

      const candidates = [];
      Object.keys(STATE_NAMES).forEach(st => {
        const cfg = this.activePetConfig.customDialogues[st];
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

      const dialogueCfg = this.activePetConfig.customDialogues[selectedState];
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

    // 实时生成 API 交互 (作用于当前活跃活跃桌宠) [1]
    triggerApiInteraction: async function() {
      this.popBubble("思考中...");

      try {
        const presetId = localStorage.getItem("global_api_preset_id");
        if (!presetId) throw new Error("未配置全局默认 API");
        const api = await db.api_presets.get(Number(presetId));
        if (!api) throw new Error("API预设丢失");

        // 定位全局活跃桌宠关联会话
        const sessions = await db.sessions.where('charId').equals(this.activePetCharId).toArray();
        if (sessions.length === 0) throw new Error("未找到对应会话");
        const sess = sessions[0];
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
      if (!this.editingPetConfig) return;
      const select = document.getElementById("mcp-pet-state-select");
      if (!select) return;
      const st = select.value;

      const previewBox = document.getElementById("mcp-pet-state-preview");
      if (previewBox) {
        const base64 = this.editingPetConfig.statesConfig[st];
        previewBox.innerHTML = base64 
          ? `<img src="${base64}" style="width:100%; height:100%; object-fit:contain;">`
          : `<span style="font-size:8px; color:var(--text-secondary);">无图</span>`;
      }

      const probInput = document.getElementById("mcp-pet-state-prob");
      const dialoguesArea = document.getElementById("mcp-pet-state-dialogues");
      
      const dialogueCfg = this.editingPetConfig.customDialogues[st];
      if (probInput && dialogueCfg) {
        probInput.value = dialogueCfg.probability !== undefined ? dialogueCfg.probability : (st === 'default' ? 100 : 0);
      }
      if (dialoguesArea && dialogueCfg) {
        dialoguesArea.value = dialogueCfg.textLines || "";
      }
    },

    // 保存 MCP 面板修改 (仅作用于正在编辑配置的 editingPetConfig) [1]
    saveMcpUiSettings: async function() {
      if (!this.editingPetConfig) return;

      const modeSelect = document.getElementById("mcp-pet-mode");
      if (modeSelect) {
        this.editingPetConfig.mode = modeSelect.value;
      }

      const select = document.getElementById("mcp-pet-state-select");
      if (select) {
        const st = select.value;
        const probInput = document.getElementById("mcp-pet-state-prob");
        const dialoguesArea = document.getElementById("mcp-pet-state-dialogues");

        if (!this.editingPetConfig.customDialogues[st]) {
          this.editingPetConfig.customDialogues[st] = {};
        }
        if (probInput) {
          this.editingPetConfig.customDialogues[st].probability = parseInt(probInput.value) || 0;
        }
        if (dialoguesArea) {
          this.editingPetConfig.customDialogues[st].textLines = dialoguesArea.value;
        }
      }

      const activeMsgToggle = document.getElementById("settings-mcp-active-msg-toggle");
      if (activeMsgToggle) {
        this.editingPetConfig.activeMsgEnabled = activeMsgToggle.checked;
      }
      const activeMsgIntervalInput = document.getElementById("mcp-active-msg-interval");
      if (activeMsgIntervalInput) {
        this.editingPetConfig.activeMsgInterval = parseInt(activeMsgIntervalInput.value) || 10;
      }

      // 如果当前编辑的正是全局活跃的那只，即时同步其热内存配置
      if (this.activePetCharId === this.editingCharId) {
        this.activePetConfig = this.editingPetConfig;
      }

      await db.desktop_pets.put(this.editingPetConfig);
      this.renderPetToDesktop();
    },

    // 上传状态图 (editing)
    handleStateImageUpload: function(fileEl) {
      if (fileEl.files.length > 0 && this.editingPetConfig) {
        const select = document.getElementById("mcp-pet-state-select");
        if (!select) return;
        const st = select.value;

        const reader = new FileReader();
        reader.onload = async (e) => {
          const base64 = e.target.result;
          this.editingPetConfig.statesConfig[st] = base64;
          
          if (this.activePetCharId === this.editingCharId) {
            this.activePetConfig = this.editingPetConfig;
          }

          await db.desktop_pets.put(this.editingPetConfig);
          showToast(`[${STATE_NAMES[st]}] 状态动画图上传成功！`);
          
          this.onStateSelectChange();
          this.renderPetToDesktop();
        };
        reader.readAsDataURL(fileEl.files[0]);
      }
    },

    // 清除状态图
    clearStateImage: async function() {
      if (this.editingPetConfig) {
        const select = document.getElementById("mcp-pet-state-select");
        if (!select) return;
        const st = select.value;

        delete this.editingPetConfig.statesConfig[st];
        
        if (this.activePetCharId === this.editingCharId) {
          this.activePetConfig = this.editingPetConfig;
        }

        await db.desktop_pets.put(this.editingPetConfig);
        showToast(`已清空 [${STATE_NAMES[st]}] 状态动画图`);
        
        this.onStateSelectChange();
        this.renderPetToDesktop();
      }
    },

    // 改变尺寸 (editing)
    changePetSize: function(val) {
      if (this.editingPetConfig) {
        this.editingPetConfig.petSize = parseInt(val) || 100;
      }
      if (this.activePetCharId === this.editingCharId) {
        this.activePetConfig = this.editingPetConfig;
      }
      
      const sizeVal = document.getElementById("mcp-pet-size-val");
      if (sizeVal) sizeVal.innerText = `${val}dp`;
      localStorage.setItem("mcp-pet-size-slider", val);
      
      this.renderPetToDesktop();
      this.saveMcpUiSettings();
      
      if (window.AndroidMCP && typeof window.AndroidMCP.updateDesktopPetSize === 'function') {
        try {
          window.AndroidMCP.updateDesktopPetSize(parseInt(val));
        } catch(e) { console.error(e); }
      }
    },

    // 绑定角色开关的桌宠权限与转移逻辑 [1]
    togglePetActive: async function(toggleEl) {
      const isEnabled = toggleEl.checked;
      const charId = this.editingCharId;
      if (!charId) return;

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
          } catch(e) { console.error(e); }
        }

        // 1. 实现强去叠：开启新桌宠时，将其他所有角色的启用标记清空
        try {
          const allPets = await db.desktop_pets.toArray();
          for (let pet of allPets) {
            if (pet.charId !== charId && pet.petEnabled) {
              pet.petEnabled = false;
              await db.desktop_pets.put(pet);
            }
          }
        } catch(e) { console.error(e); }

        // 2. 将当前配置开启
        if (this.editingPetConfig) {
          this.editingPetConfig.petEnabled = true;
          await db.desktop_pets.put(this.editingPetConfig);
        }

        // 3. 切换全局桌宠持有者
        localStorage.setItem("active_pet_char_id", charId);
        this.activePetCharId = charId;
        this.activePetConfig = this.editingPetConfig;
        this.currentState = 'default';
        
        showToast("该角色桌面悬浮桌宠已开启！");
      } else {
        // 关闭当前桌宠
        if (this.editingPetConfig) {
          this.editingPetConfig.petEnabled = false;
          await db.desktop_pets.put(this.editingPetConfig);
        }
        localStorage.removeItem("active_pet_char_id");
        this.activePetCharId = null;
        this.activePetConfig = null;
        showToast("该角色桌宠已退出");
      }

      this.renderPetToDesktop();
      this.loadMcpPanelState(); // 重新同步回显面板
    },

    // 渲染 UI 面板设置初始回显 [1]
    loadMcpPanelState: function() {
      const warningEl = document.getElementById("mcp-pet-char-warning");
      
      // 无会话时，置灰置空
      if (!this.editingCharId || !this.editingPetConfig) {
        if (warningEl) warningEl.innerText = "当前编辑角色：无 (请进入会话后配置)";
        return;
      }

      const modeSelect = document.getElementById("mcp-pet-mode");
      if (modeSelect) modeSelect.value = this.editingPetConfig.mode || "custom";

      const sizeSlider = document.getElementById("mcp-pet-size-slider");
      const size = this.editingPetConfig.petSize || 100;
      if (sizeSlider) sizeSlider.value = size;
      const sizeVal = document.getElementById("mcp-pet-size-val");
      if (sizeVal) sizeVal.innerText = `${size}dp`;

      const activeMsgToggle = document.getElementById("settings-mcp-active-msg-toggle");
      if (activeMsgToggle) activeMsgToggle.checked = !!this.editingPetConfig.activeMsgEnabled;

      const activeMsgIntervalInput = document.getElementById("mcp-active-msg-interval");
      if (activeMsgIntervalInput) activeMsgIntervalInput.value = this.editingPetConfig.activeMsgInterval || 10;

      // 该角色专属桌宠开关回显
      const petToggle = document.getElementById("settings-mcp-pet-toggle");
      if (petToggle) {
        petToggle.checked = !!this.editingPetConfig.petEnabled;
      }

      this.onStateSelectChange();
    },

    // ==========================================
    //  JS 独立高精度后台定时发信调度引擎 (各角色完全独立解耦) [1]
    // ==========================================
    triggerActiveMessageForChar: async function(charId) {
      try {
        const sessions = await db.sessions.where('charId').equals(Number(charId)).toArray();
        if (sessions.length === 0) return;
        const sess = sessions[0];

        // 联动桌宠（仅在该角色正好是当前全局活跃桌宠时冒泡提示）
        if (this.activePetCharId === charId && this.currentState !== 'sleep') {
          this.popBubble("有人冒泡。");
        }

        // 编译 Prompt
        let systemPrompt = await buildGlobalSystemPrompt(sess.id);
        systemPrompt += `\n\n【重要指令（你正在主动发起对话）】：
目前距离上一轮聊天已经过去了一段时间，用户现在处于闲置状态。现在是你主动开启话题、发微信消息打破尴尬的时候。
请根据你当前的人设关系、世界书语境，发送一条极其自然、带有你特定情绪色彩的消息。控制在40字内。
表现得就像在真实的微信聊天中，你突然想跟对方聊天一样自然，严禁刻板套话。`;

        // 加载历史
        const history = await db.messages.where('sessionId').equals(sess.id).reverse().limit(10).toArray();
        history.reverse();

        const messagesToSend = [{ role: "system", content: systemPrompt }];
        history.forEach(h => {
          let cleanContent = h.content;
          if (typeof cleanContent === 'string') {
            cleanContent = cleanContent.replace(/[\[【]MSG_ID\s*:\s*\d+[\]】]/gi, "").trim();
          }
          messagesToSend.push({ role: h.senderType === 'user' ? 'user' : 'assistant', content: cleanContent });
        });

        // 查找 API Preset
        const presetId = localStorage.getItem("global_api_preset_id");
        if (!presetId) return;
        const api = await db.api_presets.get(Number(presetId));
        if (!api) return;

        const response = await fetch(`${api.url}/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": `Bearer ${api.key}` },
          body: JSON.stringify({
            model: api.model,
            messages: messagesToSend,
            temperature: api.temperature
          })
        });

        if (!response.ok) return;
        const result = await response.json();
        let reply = result.choices[0].message.content.trim();

        reply = reply.replace(/[\[【]MSG_ID\s*:\s*\d+[\]】]/gi, "").trim();

        const newMsg = {
          sessionId: sess.id,
          senderType: 'char',
          senderId: 0,
          content: reply,
          contentType: 'text',
          timestamp: Date.now()
        };
        await db.messages.add(newMsg);

        const char = await db.archives.get(charId);
        const charName = sess.customCharName || char?.name || "对方";

        if (typeof activeSessionId !== 'undefined' && activeSessionId === sess.id) {
          if (typeof renderDialogMessages === 'function') {
            await renderDialogMessages();
          }
        }

        // 推送通知
        if (window.AndroidMCP && typeof window.AndroidMCP.showSystemNotification === 'function') {
          window.AndroidMCP.showSystemNotification(charName, reply);
        }

        // 联动来信冒泡提示
        if (this.activePetCharId === charId) {
          this.popBubble("有人来信。");
        }

      } catch(e) {
        console.error(`角色 [CharId: ${charId}] 定时发信调度失败:`, e);
      }
    }
  };

  // 全局高精度定时扫描线程
  if (!window.activeMsgSchedulerInterval) {
    window.activeMsgSchedulerInterval = setInterval(async () => {
      if (typeof db === 'undefined' || !db.desktop_pets) return;
      try {
        const allPets = await db.desktop_pets.toArray();
        const now = Date.now();

        for (let pet of allPets) {
          if (pet.activeMsgEnabled) {
            const interval = parseInt(pet.activeMsgInterval) || 10;
            const lastTimeKey = `mcp_last_msg_time_${pet.charId}`;
            const lastTrigger = parseInt(localStorage.getItem(lastTimeKey) || "0") || now;
            
            if (!localStorage.getItem(lastTimeKey)) {
              localStorage.setItem(lastTimeKey, now);
              continue;
            }

            if (now - lastTrigger >= interval * 60 * 1000) {
              localStorage.setItem(lastTimeKey, now);
              await desktopPetSystem.triggerActiveMessageForChar(pet.charId);
            }
          }
        }
      } catch(e) {
        console.error("主动发信调度异常:", e);
      }
    }, 30000);
  }

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
