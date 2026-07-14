/**
 * app_desktop_pet.js - 独立多状态悬浮桌宠、后台多角色独立定时发信调度引擎
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

      this.bindDragEvents(container);

      // 双击触发灵魂唤醒对话
      container.ondblclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.handleDoubleClick();
      };
    },

    // 拖动逻辑
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

    // 从 IndexedDB 加载当前角色的专属桌宠与发信设定 [1]
    loadPetConfig: async function(charId) {
      if (!charId) return;
      try {
        let config = await db.desktop_pets.get(charId);
        if (!config) {
          config = {
            charId: charId,
            mode: 'custom',
            statesConfig: {},
            customDialogues: {},
            petEnabled: false,       // 独立角色桌宠开启开关
            petSize: 100,            // 独立尺寸
            activeMsgEnabled: false, // 独立主动定时发信开关 [1]
            activeMsgInterval: 10    // 独立自动发信时间间隔 [1]
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
        if (config.activeMsgInterval === undefined) config.activeMsgInterval = 10;
        
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

    // 渲染或更新桌宠外观（采用各角色完全解耦的独立桌宠开关） [1]
    renderPetToDesktop: function() {
      const container = document.getElementById("desktop-pet-container");
      if (!container) return;

      // 绝不使用全局 LocalStorage，改为每个角色完全解耦的独立桌宠开关！ [1]
      const isPetEnabled = this.currentPetConfig && this.currentPetConfig.petEnabled;
      
      if (!isPetEnabled || !this.currentPetConfig) {
        container.style.display = "none";
        if (window.AndroidMCP && typeof window.AndroidMCP.hideDesktopPet === 'function') {
          window.AndroidMCP.hideDesktopPet(); // 隐藏真机悬浮窗
        }
        return;
      }

      // 1. 网页内 DOM 呈现
      container.style.display = "block";
      const size = this.currentPetConfig.petSize || 100;
      container.style.width = `${size}px`;
      container.style.height = `${size}px`;

      const imgEl = document.getElementById("desktop-pet-img");
      const base64 = this.currentPetConfig.statesConfig[this.currentState] || this.currentPetConfig.statesConfig['default'];
      
      if (base64) {
        imgEl.src = base64;
        
        // 2. 真机系统级悬浮窗投射
        if (window.AndroidMCP && typeof window.AndroidMCP.showDesktopPet === 'function') {
          try {
            window.AndroidMCP.showDesktopPet(base64, size);
          } catch(e) {
            console.error("同步原生系统级桌宠失败:", e);
          }
        }
      } else {
        imgEl.src = 'data:image/svg+xml;utf8,<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><circle cx="12" cy="12" r="10" fill="%23fca5a5"/><text x="12" y="15" font-size="8" text-anchor="middle" fill="%23ffffff">无图</text></svg>';
      }
    },

    // 气泡冒泡机制
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

    // 外部后台双击静默唤醒
    handleDoubleClickBackground: async function() {
      if (!this.activeCharId) return;

      if (this.currentPetConfig.mode === 'api') {
        await this.triggerApiInteraction();
      } else {
        this.triggerCustomInteraction();
      }
    },

    // 自定义对话响应逻辑 (台词 + 概率)
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

    // 从 MCP 选项卡收集并保存数据 [1]
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

      // === 解耦：独立收集保存每个角色的自动发信与桌宠开启设置 === [1]
      const activeMsgToggle = document.getElementById("settings-mcp-active-msg-toggle");
      if (activeMsgToggle) {
        this.currentPetConfig.activeMsgEnabled = activeMsgToggle.checked;
      }
      const activeMsgIntervalInput = document.getElementById("mcp-active-msg-interval");
      if (activeMsgIntervalInput) {
        this.currentPetConfig.activeMsgInterval = parseInt(activeMsgIntervalInput.value) || 10;
      }

      const petToggle = document.getElementById("settings-mcp-pet-toggle");
      if (petToggle) {
        this.currentPetConfig.petEnabled = petToggle.checked;
      }
      
      const sizeSlider = document.getElementById("mcp-pet-size-slider");
      if (sizeSlider) {
        this.currentPetConfig.petSize = parseInt(sizeSlider.value) || 100;
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

    // 改变大小（同步改变系统悬浮窗尺寸）
    changePetSize: function(val) {
      if (this.currentPetConfig) {
        this.currentPetConfig.petSize = parseInt(val) || 100;
      }
      const sizeVal = document.getElementById("mcp-pet-size-val");
      if (sizeVal) sizeVal.innerText = `${val}dp`;
      localStorage.setItem("mcp-pet-size-slider", val);
      
      this.renderPetToDesktop();
      this.saveMcpUiSettings();
      
      if (window.AndroidMCP && typeof window.AndroidMCP.updateDesktopPetSize === 'function') {
        try {
          window.AndroidMCP.updateDesktopPetSize(parseInt(val));
        } catch(e) {
          console.error(e);
        }
      }
    },

    // 独立角色的悬浮权限拦截申请
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
            console.error(e);
          }
        }
      }
      
      // 保存解耦配置 [1]
      this.saveMcpUiSettings();
      showToast(isEnabled ? "该角色桌面悬浮桌宠已开启！" : "该角色桌宠已退出");
    },

    // 渲染 UI 面板设置初始回显 [1]
    loadMcpPanelState: function() {
      if (!this.currentPetConfig) return;

      const modeSelect = document.getElementById("mcp-pet-mode");
      if (modeSelect) modeSelect.value = this.currentPetConfig.mode || "custom";

      const sizeSlider = document.getElementById("mcp-pet-size-slider");
      const size = this.currentPetConfig.petSize || 100;
      if (sizeSlider) sizeSlider.value = size;
      const sizeVal = document.getElementById("mcp-pet-size-val");
      if (sizeVal) sizeVal.innerText = `${size}dp`;

      // 解耦：独立回显当前活跃角色的主动发信开关及桌宠开关 [1]
      const activeMsgToggle = document.getElementById("settings-mcp-active-msg-toggle");
      if (activeMsgToggle) activeMsgToggle.checked = !!this.currentPetConfig.activeMsgEnabled;

      const activeMsgIntervalInput = document.getElementById("mcp-active-msg-interval");
      if (activeMsgIntervalInput) activeMsgIntervalInput.value = this.currentPetConfig.activeMsgInterval || 10;

      const petToggle = document.getElementById("settings-mcp-pet-toggle");
      if (petToggle) petToggle.checked = !!this.currentPetConfig.petEnabled;

      this.onStateSelectChange();
    },

    // ==========================================
    //  JS 独立高精度后台定时发信调度引擎 (彻底解决多角色时间分离) [1]
    // ==========================================
    // 原生 Timer 不具备 RAG、世界书、长效记忆等多态 Prompt 编译权限，
    // 因此在 JS 层实现全自动化时间调度，再调用 popBubble 和 showSystemNotification
    // ==========================================
    triggerActiveMessageForChar: async function(charId) {
      try {
        const sessions = await db.sessions.where('charId').equals(Number(charId)).toArray();
        if (sessions.length === 0) return;
        const sess = sessions[0];

        // 1. 联动桌宠气泡（有人冒泡）
        if (this.activeCharId === charId && this.currentState !== 'sleep') {
          this.popBubble("有人冒泡。");
        }

        // 2. 编译该角色在特定会话下的专属 RAG 记忆与世界书 Prompt
        let systemPrompt = await buildGlobalSystemPrompt(sess.id);
        
        systemPrompt += `\n\n【重要指令（你正在主动发起对话）】：
目前距离上一轮聊天已经过去了一段时间，用户现在处于闲置状态。现在是你主动开启话题、发微信消息打破尴尬的时候。
请根据你当前的人设关系、世界书语境，发送一条极其自然、带有你特定情绪色彩的消息。控制在40字以内。
表现得就像在真实的微信聊天中，你突然想跟对方聊天一样自然，严禁刻板套话。`;

        // 加载历史会话
        const history = await db.messages.where('sessionId').equals(sess.id).reverse().limit(10).toArray();
        history.reverse();

        const messagesToSend = [{ role: "system", content: systemPrompt }];
        history.forEach(h => {
          // 擦除指令标志以喂入上下文
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

        // 清洗回复文本并入库
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

        // 如果刚好在这个角色的主聊天窗口，立即刷新上屏
        if (typeof activeSessionId !== 'undefined' && activeSessionId === sess.id) {
          if (typeof renderDialogMessages === 'function') {
            await renderDialogMessages();
          }
        }

        // 3. 真机通知系统
        if (window.AndroidMCP && typeof window.AndroidMCP.showSystemNotification === 'function') {
          window.AndroidMCP.showSystemNotification(charName, reply);
        }

        // 4. 联动桌宠气泡（有人来信）
        if (this.activeCharId === charId) {
          this.popBubble("有人来信。");
        }

      } catch(e) {
        console.error(`角色 [CharId: ${charId}] 定时发信调度失败:`, e);
      }
    }
  };

  // 全局定时发信调度引擎 (每 30 秒执行一次时间扫描，达到解耦分离) [1]
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
            
            // 首次冷启动时间对齐，防止瞬间连环发信
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
        console.error("主动发信调度引擎执行异常:", e);
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
