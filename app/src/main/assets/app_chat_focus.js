/**
 * app_chat_focus.js - 沉浸式专注时空控制中枢
 */

(function() {
  // 专注数据状态机，防篡改闭环
  const state = {
    timerId: null,
    totalSeconds: 0,
    elapsedSeconds: 0,
    pokesCount: 0,
    isActive: false,
    lastTickTime: null,
    history: [],
    currentConfig: {
      avatarUrl: "",
      duration: 25,
      category: "学习",
      mode: "严格监督"
    },
    tempBlob: null
  };

  // 1. 初始化设置界面数据
  async function loadSetupScreen() {
    if (!activeSessionId) return;
    const sess = await db.sessions.get(Number(activeSessionId));
    if (!sess) return;

    // A. 载入专注配置
    let config = { avatarUrl: "", duration: 25, category: "学习", mode: "严格监督", ambientSoundName: "" };
    if (sess.activeFocusConfig) {
      try { config = JSON.parse(sess.activeFocusConfig); } catch(e) {}
    }
    state.currentConfig = config;

    const avatarInput = document.getElementById("focus-config-avatar");
    const durationInput = document.getElementById("focus-config-duration");
    const durationVal = document.getElementById("focus-config-duration-val");
    const categorySelect = document.getElementById("focus-config-category");
    const modeSelect = document.getElementById("focus-config-mode");
    const dialWheel = document.getElementById("focus-dial-wheel");

    if (avatarInput) {
      avatarInput.value = (config.avatarUrl && (config.avatarUrl.startsWith("data:image/") || config.avatarUrl.startsWith("blob:") || config.avatarUrl === "[本地上传图片]")) ? "[本地上传图片]" : (config.avatarUrl || "");
    }
    
    // 初始化同步指示表盘与转盘角度
    const loadDuration = config.duration || 25;
    if (durationInput) durationInput.value = loadDuration;
    if (durationVal) durationVal.innerText = loadDuration;
    if (dialWheel) {
      const initialRotateDeg = (loadDuration / 120) * 360;
      dialWheel.style.transform = `rotate(${initialRotateDeg}deg)`;
    }

    if (categorySelect) categorySelect.value = config.category;
    if (modeSelect) modeSelect.value = config.mode;

    // A2. 同步与绘制多态环境伴随音列表
    const ambientSelect = document.getElementById("focus-config-ambient");
    const btnAmbientHeadphone = document.getElementById("btn-focus-ambient-sound");
    if (ambientSelect) {
      ambientSelect.innerHTML = `<option value="">-- 无伴随环境音 --</option>`;
      const sounds = sess.focusAmbientSounds || [];
      sounds.forEach(s => {
        const opt = document.createElement("option");
        opt.value = s.name;
        opt.innerText = s.name;
        if (config.ambientSoundName === s.name) {
          opt.selected = true;
        }
        ambientSelect.appendChild(opt);
      });
      
      // 耳机高亮开关态
      if (btnAmbientHeadphone) {
        if (config.ambientSoundName) {
          btnAmbientHeadphone.classList.add("active");
        } else {
          btnAmbientHeadphone.classList.remove("active");
        }
      }
    }

    // B. 计算每日专注目标
    let dailyTarget = parseInt(localStorage.getItem(`focus_target_${activeSessionId}`) || "60");
    const targetInput = document.getElementById("focus-target-input");
    if (targetInput) targetInput.value = dailyTarget;

    // C. 提炼并统计历史专注明细
    let history = [];
    if (sess.focusHistory) {
      try { history = JSON.parse(sess.focusHistory); } catch(e){}
    }
    state.history = history;

    calculateAndRenderStats();
    renderHistoryList();
  }

  // 2. 多态时空数据指标统配差值分析器
  function calculateAndRenderStats() {
    const history = state.history;
    const targetMin = parseInt(localStorage.getItem(`focus_target_${activeSessionId}`) || "60");

    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const yesterdayStart = todayStart - 86400000;

    // 计算本周一 0 点
    const day = now.getDay() || 7;
    const weekStart = todayStart - (day - 1) * 86400000;
    const lastWeekStart = weekStart - 7 * 24 * 60 * 60 * 1000;

    let todayMins = 0;
    let yesterdayMins = 0;
    let weekMins = 0;
    let lastWeekMins = 0;
    let totalMins = 0;

    history.forEach(item => {
      const dur = parseFloat(item.duration) || 0;
      totalMins += dur;

      if (item.timestamp >= todayStart) {
        todayMins += dur;
      } else if (item.timestamp >= yesterdayStart && item.timestamp < todayStart) {
        yesterdayMins += dur;
      }

      if (item.timestamp >= weekStart) {
        weekMins += dur;
      } else if (item.timestamp >= lastWeekStart && item.timestamp < weekStart) {
        lastWeekMins += dur;
      }
    });

    // 今日相比昨日百分比
    let todayDiffText = "比昨日 +0%";
    if (yesterdayMins > 0) {
      const diff = ((todayMins - yesterdayMins) / yesterdayMins) * 100;
      todayDiffText = `比昨日 ${diff >= 0 ? '+' : ''}${diff.toFixed(0)}%`;
    } else if (todayMins > 0) {
      todayDiffText = "比昨日 +100%";
    }

    // 本周相比上周百分比
    let weekDiffText = "比上周 +0%";
    if (lastWeekMins > 0) {
      const diff = ((weekMins - lastWeekMins) / lastWeekMins) * 100;
      weekDiffText = `比上周 ${diff >= 0 ? '+' : ''}${diff.toFixed(0)}%`;
    } else if (weekMins > 0) {
      weekDiffText = "比上周 +100%";
    }

    // 更新 DOM
    document.getElementById("focus-stat-today").innerText = `${todayMins.toFixed(1)} 分钟`;
    document.getElementById("focus-stat-today-diff").innerText = todayDiffText;
    document.getElementById("focus-stat-week").innerText = `${weekMins.toFixed(1)} 分钟`;
    document.getElementById("focus-stat-week-diff").innerText = weekDiffText;
    document.getElementById("focus-stat-total").innerText = `${totalMins.toFixed(1)} 分钟`;

    // 目标进度条
    const progressPct = Math.min(100, Math.round((todayMins / targetMin) * 100));
    const progressBar = document.getElementById("focus-target-progressbar");
    if (progressBar) progressBar.style.width = progressPct + "%";
    document.getElementById("focus-target-progress-text").innerText = `进度：${todayMins.toFixed(1)} / ${targetMin} 分钟 (${progressPct}%)`;
  }

  // 3. 渲染轨迹成长列表
  function renderHistoryList() {
    const listContainer = document.getElementById("focus-history-list");
    if (!listContainer) return;
    listContainer.innerHTML = "";

    const history = state.history;
    if (history.length === 0) {
      listContainer.innerHTML = `<p style="font-size:11px; color:var(--text-secondary); text-align:center; padding:10px 0; margin:0;">尚无成长记录。赶紧进行第一场深度专注吧！</p>`;
      return;
    }

    history.sort((a,b) => b.timestamp - a.timestamp).forEach((item, idx) => {
      const card = document.createElement("div");
      card.style.cssText = "background: #f8fafc; border: 1px solid var(--border); border-radius: 10px; padding: 10px; display:flex; flex-direction:column; gap:6px;";
      
      const timeStr = new Date(item.timestamp).toLocaleString([], { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
      card.innerHTML = `
        <div style="display:flex; justify-content:space-between; align-items:center; font-size:11px; border-bottom: 1px dashed var(--border); padding-bottom:4px; font-weight:700;">
          <span style="color:var(--text-secondary);">${timeStr}</span>
          <span style="color:var(--primary);">${item.category} | ${item.duration.toFixed(1)} 分钟 (${item.mode})</span>
        </div>
        <div style="font-size:12px; color:var(--text-primary); line-height:1.4; text-align:justify; margin: 2px 0;" class="focus-eval-content">
          ${item.evaluation || "专注于当下，无负累心流。"}
        </div>
        <div style="font-size:10px; color:#059669; font-weight:600;">互动戳戳数: ${item.pokesCount} 次</div>
      `;
      listContainer.appendChild(card);
    });
  }

  // 4. 保存专注配置
  async function saveFocusConfig() {
    const durationInput = document.getElementById("focus-config-duration");
    const categorySelect = document.getElementById("focus-config-category");
    const modeSelect = document.getElementById("focus-config-mode");
    const avatarInput = document.getElementById("focus-config-avatar");
    const ambientSelect = document.getElementById("focus-config-ambient");

    let avatarUrl = avatarInput.value.trim();
    if (avatarUrl === "[本地上传图片]") {
      avatarUrl = state.tempBlob || state.currentConfig.avatarUrl;
    }

    const newConfig = {
      avatarUrl: avatarUrl,
      duration: parseInt(durationInput.value) || 25,
      category: categorySelect.value,
      mode: modeSelect.value,
      ambientSoundName: ambientSelect ? ambientSelect.value : ""
    };

    state.currentConfig = newConfig;

    await db.sessions.update(activeSessionId, {
      activeFocusConfig: JSON.stringify(newConfig)
    });

    showToast("专注环境配置保存成功！");
    await loadSetupScreen();
  }

  // 5. 开启专注时空
  async function startFocusSession() {
    const config = state.currentConfig;
    if (!config) return;

    // A. 载入立绘并切换至沉浸屏
    const activeScreen = document.getElementById("win-focus-active");
    const bg = document.getElementById("focus-active-bg");
    const exitBtn = document.getElementById("btn-focus-active-exit");
    
    if (!activeScreen || !bg || !exitBtn) return;

    let imgUrl = resolveAvatar(config.avatarUrl);
    bg.style.backgroundImage = `url(${imgUrl})`;

    // B. 设置严格监督/宽泛监督下的退出按钮
    exitBtn.style.display = config.mode === "严格监督" ? "none" : "block";

    // C. 重置时间参数
    state.totalSeconds = config.duration * 60;
    state.elapsedSeconds = 0;
    state.pokesCount = 0;
    state.isActive = true;
    state.lastTickTime = Date.now();

    document.getElementById("focus-active-category").innerText = `${config.category}中`;
    updateActiveTimerUI();

    // 重置恢复按钮的状态，重新展示进度文本
    const resumeBtn = document.getElementById("focus-active-resume-btn");
    const ratioText = document.getElementById("focus-active-ratio");
    if (resumeBtn) resumeBtn.style.display = "none";
    if (ratioText) ratioText.style.display = "block";

    // D. 提取并启动伴奏环境音白噪音
    const player = document.getElementById("focus-ambient-player");
    if (player) {
      player.pause();
      player.src = "";
      if (config.ambientSoundName) {
        const sess = await db.sessions.get(activeSessionId);
        const sounds = sess.focusAmbientSounds || [];
        const sound = sounds.find(s => s.name === config.ambientSoundName);
        if (sound && sound.data) {
          player.src = URL.createObjectURL(sound.data);
          player.play().catch(err => console.log("伴奏白噪音拉起被安全屏蔽:", err));
        }
      }
    }

    // E. 开启循环计时器与 Page Visibility 自锁切屏传感器
    activeScreen.style.display = "block";
    startTickLoop();
  }

  function updateActiveTimerUI() {
    const total = state.totalSeconds;
    const elapsed = state.elapsedSeconds;
    const remaining = Math.max(0, total - elapsed);

    const mins = Math.floor(remaining / 60);
    const secs = remaining % 60;
    document.getElementById("focus-active-timer").innerText = `${String(mins).padStart(2,'0')}:${String(secs).padStart(2,'0')}`;

    const pct = Math.min(100, Math.round((elapsed / total) * 100));
    document.getElementById("focus-active-ratio").innerText = `已进行 ${pct}%`;

    // 绘制 SVG 圆环进度
    const bar = document.getElementById("focus-progress-svg-bar");
    if (bar) {
      const perimeter = 2 * Math.PI * 90; // r=90
      const offset = perimeter - (pct / 100) * perimeter;
      bar.style.strokeDashoffset = offset;
    }
  }

  function startTickLoop() {
    if (state.timerId) clearInterval(state.timerId);
    state.timerId = setInterval(() => {
      if (!state.isActive) return;
      const now = Date.now();
      const diff = Math.floor((now - state.lastTickTime) / 1000);
      
      if (diff >= 1) {
        state.elapsedSeconds += diff;
        state.lastTickTime = now;
        updateActiveTimerUI();

        if (state.elapsedSeconds >= state.totalSeconds) {
          finishFocusSession(true);
        }
      }
    }, 1000);
  }

  // 6. 退出/结算专注空间
  async function finishFocusSession(isFinishedCompleted) {
    if (state.timerId) clearInterval(state.timerId);
    state.timerId = null;
    state.isActive = false;

    const elapsedMins = parseFloat((state.elapsedSeconds / 60).toFixed(1));
    const activeScreen = document.getElementById("win-focus-active");
    if (activeScreen) activeScreen.style.display = "none";

    // 安全停播白噪音伴奏
    const player = document.getElementById("focus-ambient-player");
    if (player) {
      player.pause();
      player.src = "";
    }

    if (elapsedMins < 0.1) {
      showToast("专注时间过短，本次修行不计入历史轨迹。");
      await loadSetupScreen();
      return;
    }

    const header = document.getElementById("dialog-header-title");
    const origTitle = header.innerText;
    header.innerText = "对方正在提炼综合考评...";
    header.classList.add("header-typing");

    try {
      const presetId = localStorage.getItem("global_api_preset_id");
      const api = await db.api_presets.get(Number(presetId));
      if (!api) throw new Error("API未就位，无法合成最终回顾考评");

      // 提取线上主聊天 prompt
      let basePrompt = await buildGlobalSystemPrompt(activeSessionId);

      const evalPrompt = `${basePrompt}

【专注考评提炼要求（重要，高优先级行为）】
你刚刚陪用户（${localStorage.getItem("active_me_id") ? "对方" : "我"}）进行了一场深度的【${state.currentConfig.category}】修行。
- 设定计划专注时长：${state.currentConfig.duration} 分钟
- 实际坚持完成时长：${elapsedMins} 分钟
- 中途用户分心“戳了戳”你进行互动的频率次数：${state.pokesCount} 次
- 本次专注是否彻底完满实现：${isFinishedCompleted ? '是' : '中途强退放弃'}

请你完全站在你自身人设立场、性格与情感态度出发，写一段符合当前余温的考评反馈语（不超过100字，绝不能盲目客气或死板说教，用词必须极度生动并充满性格色彩！）
请直接输出该考评反馈台词，禁止包含动作和心理描写！`;

      const response = await fetch(`${api.url}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${api.key}` },
        body: JSON.stringify({
          model: api.model,
          messages: [{ role: "user", content: evalPrompt }],
          temperature: 0.5
        })
      });

      if (!response.ok) throw new Error("考评生成失败");
      const result = await response.json();
      const evalText = result.choices[0].message.content.trim();

      // 将轨迹保存入库
      const historyItem = {
        timestamp: Date.now(),
        duration: elapsedMins,
        category: state.currentConfig.category,
        mode: state.currentConfig.mode,
        pokesCount: state.pokesCount,
        evaluation: evalText
      };

      state.history.push(historyItem);
      await db.sessions.update(activeSessionId, {
        focusHistory: JSON.stringify(state.history)
      });

      showCustomAlert("专注空间结语考评", evalText);

    } catch(err) {
      console.error(err);
      // 容灾兜底
      const fallbackEval = `完成了 ${elapsedMins} 分钟的${state.currentConfig.category}，中途互动 ${state.pokesCount} 次。专注于当下。`;
      state.history.push({
        timestamp: Date.now(),
        duration: elapsedMins,
        category: state.currentConfig.category,
        mode: state.currentConfig.mode,
        pokesCount: state.pokesCount,
        evaluation: fallbackEval
      });
      await db.sessions.update(activeSessionId, {
        focusHistory: JSON.stringify(state.history)
      });
      showCustomAlert("专注空间结语考评", fallbackEval);
    } finally {
      header.innerText = origTitle;
      header.classList.remove("header-typing");
      await loadSetupScreen();
    }
  }

  // 7. 专注中戳一戳交流
  async function triggerPokeDialogue(e) {
    if (e.target.closest("#btn-focus-active-exit") || e.target.closest("#focus-draggable-circle")) return;
    if (!state.isActive) return;

    state.pokesCount++;
    const bubble = document.getElementById("focus-poke-bubble");
    const sender = document.getElementById("focus-poke-bubble-sender");
    const textEl = document.getElementById("focus-poke-bubble-text");

    if (!bubble || !textEl || !sender) return;

    // 提拉动画
    bubble.style.opacity = "0";
    bubble.style.transform = "translateX(-50%) translateY(20px)";

    try {
      const presetId = localStorage.getItem("global_api_preset_id");
      const api = await db.api_presets.get(Number(presetId));
      if (!api) throw new Error();

      const basePrompt = await buildGlobalSystemPrompt(activeSessionId);
      const elapsedMins = (state.elapsedSeconds / 60).toFixed(1);
      const progressPct = Math.round((state.elapsedSeconds / state.totalSeconds) * 100);

      const pokePrompt = `${basePrompt}

【沉浸式专注戳一戳快速反应（高优先级命令）】
当前我们正在一起进行【${state.currentConfig.category}】。
- 设定总时长：${state.currentConfig.duration} 分钟
- 已经进行时长：${elapsedMins} 分钟
- 当前任务进度比：${progressPct}%

对方刚刚在专注中“戳了戳”你。请你极速给予对方一句话作为秒回，用于鼓励、戏谑、催促或娇羞回应（限 25 字以内，绝对禁止说教或长篇大论）。直接输出回复台词，禁止任何动作旁白！`;

      const response = await fetch(`${api.url}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${api.key}` },
        body: JSON.stringify({
          model: api.model,
          messages: [{ role: "user", content: pokePrompt }],
          temperature: 0.6
        })
      });

      if (!response.ok) throw new Error();
      const result = await response.json();
      const reply = result.choices[0].message.content.trim();

      const sess = await db.sessions.get(activeSessionId);
      sender.innerText = sess.customCharName || "对方";
      textEl.innerText = reply;

    } catch(err) {
      sender.innerText = "系统提示";
      textEl.innerText = "正在认真专注中...不要三心二意哦。";
    }

    bubble.style.opacity = "1";
    bubble.style.transform = "translateX(-50%) translateY(0)";

    // 10秒淡出
    if (state.bubbleTimer) clearTimeout(state.historyTimer);
    state.bubbleTimer = setTimeout(() => {
      bubble.style.opacity = "0";
      bubble.style.transform = "translateX(-50%) translateY(20px)";
    }, 10000);
  }

  // 8. 物理传感器级：切屏/Visibility 自锁
  document.addEventListener("visibilitychange", () => {
    // 只有当专注屏幕处于开启状态时才响应切换事件
    const activeScreen = document.getElementById("win-focus-active");
    if (!activeScreen || activeScreen.style.display === "none") return;

    if (document.visibilityState === "hidden") {
      if (state.isActive) {
        state.isActive = false;
        
        // 1. 暂停环境伴奏音
        const player = document.getElementById("focus-ambient-player");
        if (player) player.pause();

        // 2. 隐藏进度条文字并唤起“继续”指示按钮
        const resumeBtn = document.getElementById("focus-active-resume-btn");
        const ratioText = document.getElementById("focus-active-ratio");
        if (resumeBtn) resumeBtn.style.display = "flex";
        if (ratioText) ratioText.style.display = "none";

        showToast("检测到您已退出了专注大屏，计时器与白噪音已暂停。");
      }
    } else {
      // 保持暂停状态，静候用户轻触继续按钮
      showToast("已回到专注空间，请轻触时钟中央的继续按钮以恢复专注。");
    }
  });

  // 9. 闭环触屏拖拽及自绑定自注册机制
  function initFocusSystem() {
    const saveBtn = document.getElementById("btn-save-focus-config");
    if (saveBtn) saveBtn.onclick = saveFocusConfig;

    const startBtn = document.getElementById("btn-start-focus-session");
    if (startBtn) startBtn.onclick = startFocusSession;

    const exitBtn = document.getElementById("btn-focus-active-exit");
    if (exitBtn) {
      exitBtn.onclick = () => {
        showCustomConfirm("强退专注", "确定要在专注中途强退退出吗？\n\n这将导致强退结语，且修行不计入完美成长轨迹中。", () => {
          finishFocusSession(false);
        });
      };
    }

    const activeScreen = document.getElementById("win-focus-active");
    if (activeScreen) activeScreen.onclick = triggerPokeDialogue;

    // 绑定恢复专注的点击响应
    const resumeBtn = document.getElementById("focus-active-resume-btn");
    if (resumeBtn) {
      resumeBtn.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation(); // 阻止向下冒泡导致戳一戳气泡弹出

        state.isActive = true;
        state.lastTickTime = Date.now();

        // 1. 继续播放环境音
        const player = document.getElementById("focus-ambient-player");
        if (player && player.src) {
          player.play().catch(err => console.log("白噪音恢复播音失败:", err));
        }

        // 2. 隐藏恢复按钮，展示进度比例文字
        resumeBtn.style.display = "none";
        const ratioText = document.getElementById("focus-active-ratio");
        if (ratioText) ratioText.style.display = "block";

        showToast("专注节奏恢复，心流继续中...");
      };
    }

    // 9.1 手势拖拽环形气泡 (Pointer Events)
    const knob = document.getElementById("focus-draggable-circle");
    if (knob) {
      let drag = false;
      let startX, startY;
      let initLeft, initTop;

      knob.onpointerdown = (e) => {
        e.preventDefault();
        e.stopPropagation();
        drag = true;
        startX = e.clientX;
        startY = e.clientY;
        const container = document.getElementById("focus-active-knob-container");
        initLeft = container.offsetLeft;
        initTop = container.offsetTop;
        knob.style.cursor = "grabbing";
        knob.setPointerCapture(e.pointerId);
      };

      knob.onpointermove = (e) => {
        if (!drag) return;
        e.preventDefault();
        e.stopPropagation();
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        const container = document.getElementById("focus-active-knob-container");
        container.style.left = `${initLeft + dx}px`;
        container.style.top = `${initTop + dy}px`;
      };

      knob.onpointerup = (e) => {
        if (drag) {
          drag = false;
          knob.style.cursor = "grab";
          knob.releasePointerCapture(e.pointerId);
        }
      };
    }

    // 9.2 物理刻度转盘旋转仪控制逻辑 (Pointer Tracking)
    const dialWheel = document.getElementById("focus-dial-wheel");
    if (dialWheel) {
      let isDialDragging = false;
      let dialCenter = { x: 0, y: 0 };
      let startAngle = 0;
      let startDuration = 25;

      dialWheel.onpointerdown = (e) => {
        e.preventDefault();
        e.stopPropagation();
        isDialDragging = true;
        
        const rect = dialWheel.getBoundingClientRect();
        dialCenter = {
          x: rect.left + rect.width / 2,
          y: rect.top + rect.height / 2
        };
        
        startAngle = Math.atan2(e.clientY - dialCenter.y, e.clientX - dialCenter.x);
        startDuration = parseInt(document.getElementById("focus-config-duration-val").innerText) || 25;
        
        dialWheel.setPointerCapture(e.pointerId);
        dialWheel.style.cursor = "grabbing";
      };

      dialWheel.onpointermove = (e) => {
        if (!isDialDragging) return;
        e.preventDefault();
        e.stopPropagation();
        
        const currentAngle = Math.atan2(e.clientY - dialCenter.y, e.clientX - dialCenter.x);
        let angleDiff = currentAngle - startAngle;
        
        // 跨界越阈自愈对齐
        if (angleDiff > Math.PI) angleDiff -= 2 * Math.PI;
        if (angleDiff < -Math.PI) angleDiff += 2 * Math.PI;

        // 旋转角度映射到时间刻度 (1圈=120分钟)
        const minDelta = Math.round((angleDiff / (2 * Math.PI)) * 120);
        let newDuration = startDuration + minDelta;
        
        // 限制在 5 ~ 120 分钟内
        if (newDuration < 5) newDuration = 5;
        if (newDuration > 120) newDuration = 120;

        // 应用物理转盘的真实旋转旋转动画
        const rotateDeg = (newDuration / 120) * 360;
        dialWheel.style.transform = `rotate(${rotateDeg}deg)`;

        // 同步回退写入 UI
        document.getElementById("focus-config-duration-val").innerText = newDuration;
        document.getElementById("focus-config-duration").value = newDuration;
      };

      dialWheel.onpointerup = (e) => {
        if (isDialDragging) {
          isDialDragging = false;
          dialWheel.style.cursor = "grab";
          dialWheel.releasePointerCapture(e.pointerId);
        }
      };
    }

    // 9.3 目标分钟输入更改
    const targetInput = document.getElementById("focus-target-input");
    if (targetInput) {
      targetInput.onchange = (e) => {
        let val = parseInt(e.target.value) || 60;
        if (val < 5) val = 5;
        localStorage.setItem(`focus_target_${activeSessionId}`, val);
        calculateAndRenderStats();
      };
    }

    // 9.4 立绘上传
    const uploadBtn = document.getElementById("btn-upload-focus-avatar");
    const fileInput = document.getElementById("file-focus-avatar");
    if (uploadBtn && fileInput) {
      uploadBtn.onclick = (e) => {
        e.preventDefault();
        fileInput.click();
      };
      fileInput.onchange = (e) => {
        if (e.target.files.length > 0) {
          const file = e.target.files[0];
          const reader = new FileReader();
          reader.onload = (event) => {
            state.tempBlob = event.target.result;
            document.getElementById("focus-config-avatar").value = "[本地上传图片]";
          };
          reader.readAsDataURL(file);
        }
      };
    }

    // 9.5 环境音 MP3 本地上载与存储
    const btnAmbientSound = document.getElementById("btn-focus-ambient-sound");
    const fileAmbientInput = document.getElementById("file-focus-ambient");
    if (btnAmbientSound && fileAmbientInput) {
      btnAmbientSound.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        fileAmbientInput.click();
      };
      fileAmbientInput.onchange = async (e) => {
        if (e.target.files.length > 0) {
          const file = e.target.files[0];
          const sess = await db.sessions.get(activeSessionId);
          let list = sess.focusAmbientSounds || [];
          
          if (!list.some(s => s.name === file.name)) {
            list.push({ name: file.name, data: file });
            await db.sessions.update(activeSessionId, { focusAmbientSounds: list });
            showToast(`环境音导入成功: ${file.name}`);
            await loadSetupScreen();
          } else {
            showToast("此环境音音轨已在库中，无需重复载入");
          }
        }
      };
    }

    // 9.6 专注历史记录收起/展开折叠逻辑
    const historyHeader = document.getElementById("focus-history-toggle-header");
    const historyList = document.getElementById("focus-history-list");
    const historyArrow = document.getElementById("focus-history-toggle-arrow");
    if (historyHeader && historyList && historyArrow) {
      historyHeader.onclick = (e) => {
        e.preventDefault();
        const isHidden = historyList.style.display === "none" || historyList.style.display === "";
        if (isHidden) {
          historyList.style.display = "flex";
          historyArrow.style.transform = "rotate(180deg)";
        } else {
          historyList.style.display = "none";
          historyArrow.style.transform = "rotate(0deg)";
        }
      };
    }
  }

  // 自注册防御挂载
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initFocusSystem);
  } else {
    initFocusSystem();
  }

  // 挂载全局句柄供 setup 激活读取
  window.focusSpaceSystem = {
    loadSetupScreen
  };
})();