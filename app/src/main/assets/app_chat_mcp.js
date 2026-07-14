/**
 * app_chat_mcp.js - Model Context Protocol & Mobile Control Panel 物理扫歌与原生播放联动中枢 [1]
 * 
 * 修改说明（后台发信修复）：
 * - toggleActiveMessage(): 开启时从 IndexedDB 读取当前 API preset，通过 registerBgApiConfig() 注册到 Kotlin 层
 * - triggerBackgroundActiveMessage(): 改为双重逻辑——先通过 pushBgMessage() 推消息到 Kotlin 队列，
 *   再通过 pollBgResult() 轮询后台发信结果；同时保留原有 btnReply.click() 逻辑以兼容前台场景
 */

(function() {
  const mcpSystem = {
    // 自动扫描出的物理歌曲列表 (存放歌曲的真实文件名，如 "song.mp3") [1]
    localPlaylist: [],

    // 开启中枢控制面板
    openPanel: function() {
      if (!activeSessionId) {
        showToast("请先进入一个好友聊天对话！");
        return;
      }
      document.getElementById("chat-mcp-panel").classList.add("active");
      this.refreshScreentimeDisplay();
      
      // 开启面板时自动扫描本地物理歌单并加载设置 [1]
      this.scanAndSyncLocalMusic();
    },

    // 关闭控制面板
    closePanel: function() {
      document.getElementById("chat-mcp-panel").classList.remove("active");
    },

    // 载入并同步 MCP 本地配置
    loadMcpSettings: function() {
      const isMcpEnabled = localStorage.getItem("settings-mcp-prompt-enabled") === "true";
      const toggle = document.getElementById("settings-mcp-prompt-toggle");
      if (toggle) toggle.checked = isMcpEnabled;

      const isActiveMsgEnabled = localStorage.getItem("settings-mcp-active-msg-enabled") === "true";
      const activeMsgToggle = document.getElementById("settings-mcp-active-msg-toggle");
      if (activeMsgToggle) activeMsgToggle.checked = isActiveMsgEnabled;

      const isPetEnabled = localStorage.getItem("settings-mcp-pet-enabled") === "true";
      const petToggle = document.getElementById("settings-mcp-pet-toggle");
      if (petToggle) petToggle.checked = isPetEnabled;

      const petImage = localStorage.getItem("mcp-desktop-pet-image");
      const previewBox = document.getElementById("mcp-pet-preview-box");
      if (previewBox && petImage) {
        previewBox.innerHTML = `<img src="${petImage}" style="width:100%; height:100%; object-fit:contain;">`;
      }

      // 回显本地扫描出的物理歌单 [1]
      const listEl = document.getElementById("mcp-playlist-list");
      if (listEl) {
        if (this.localPlaylist.length > 0) {
          listEl.innerHTML = this.localPlaylist.map((s, idx) => `<div style="padding: 4px 6px; margin-bottom: 2px; border-radius:4px; background:rgba(0,0,0,0.03); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; cursor:pointer;" onclick="mcpSystem.playTrackByIndex(${idx})">#${idx} - ${s}</div>`).join("");
          return;
        }
        listEl.innerHTML = "歌单为空。请用手机文件管理器将 MP3/WAV 歌曲放入本地存储的 /Music/Storypoem/ 目录下，然后重新打开此页面即可自动刷新！";
      }
    },

    // MCP 神经注入开关切换
    togglePrompt: function(toggleEl) {
      localStorage.setItem("settings-mcp-prompt-enabled", toggleEl.checked ? "true" : "false");
      showToast(toggleEl.checked ? "已成功建立神经感知！物理传感器与歌单已同步至 AI。" : "已切断神经数据通道。");
    },

    // 1. 同步地理位置与天气
    syncLocation: function() {
      const geoStatus = document.getElementById("mcp-geo-status");
      const weatherStatus = document.getElementById("mcp-weather-status");
      
      if (!navigator.geolocation) {
        showToast("您的设备浏览器不支持 GPS 地理定位");
        return;
      }

      geoStatus.innerText = "正在向 Android 设备申请高精度定位...";
      showToast("正在读取 GPS 位置...");

      navigator.geolocation.getCurrentPosition(async (position) => {
        const lat = position.coords.latitude.toFixed(4);
        const lon = position.coords.longitude.toFixed(4);
        geoStatus.innerText = `设备实测 GPS (纬度:${lat}, 经度:${lon})`;

        try {
          weatherStatus.innerText = "正在连接 Open-Meteo 气象中枢...";
          const response = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current_weather=true`);
          const data = await response.json();
          
          if (data && data.current_weather) {
            const temp = data.current_weather.temperature;
            const code = data.current_weather.weathercode;
            
            const weatherMap = {
              0: "晴朗 (Clear Sky)",
              1: "大部分晴朗", 2: "多云", 3: "阴天",
              45: "雾气", 48: "沉积雾",
              51: "细雨", 53: "中等毛毛雨", 55: "重度毛毛雨",
              61: "微雨", 63: "中雨", 65: "大雨 (Rainy)",
              71: "微雪", 73: "中雪", 75: "大雪",
              80: "阵雨", 81: "中等阵雨", 82: "暴雨",
              95: "雷暴", 96: "雷暴伴有冰雹"
            };

            const weatherDesc = weatherMap[code] || "多云或局部晴";
            const weatherObj = {
              city: `Android GPS定位 (经度:${lon}, 纬度:${lat})`,
              temp: temp,
              weather: weatherDesc
            };

            localStorage.setItem("mcp_loc_weather", JSON.stringify(weatherObj));
            weatherStatus.innerText = `实时室外温度: ${temp}°C | 当前天气: ${weatherDesc}`;
            showToast("环境传感器数据已注入！AI 已同步您的时空认知。");
          } else {
            throw new Error("获取气象协议失败");
          }
        } catch(err) {
          weatherStatus.innerText = "天气查询失败，但定位坐标已成功记录。";
          console.error(err);
        }
      }, (error) => {
        geoStatus.innerText = "定位失败，未获得 Android 浏览器定位权限";
        showToast("GPS 读取失败，请检查浏览器定位权限开关！");
      }, { enableHighAccuracy: true, timeout: 8000 });
    },

    // 2. 物理马达震动
    triggerVibration: function() {
      if (window.AndroidMCP && typeof window.AndroidMCP.triggerHardwareVibrator === 'function') {
        window.AndroidMCP.triggerHardwareVibrator(400); // 原生震动
        showToast("震动信号已发送至 Android 硬件马达");
        return;
      }
      if (navigator.vibrate) {
        navigator.vibrate([200, 100, 200]);
        showToast("H5 震动信号已发送");
      } else {
        showToast("您的设备不支持物理震动 API");
      }
    },

    // 3. 原生物理时钟直写闹钟 [1]
    setAlarm: function() {
      const input = document.getElementById("mcp-timer-input");
      const seconds = parseInt(input.value);
      if (isNaN(seconds) || seconds <= 0) {
        showToast("请输入合法的闹钟倒计时秒数！");
        return;
      }

      const targetDate = new Date(Date.now() + seconds * 1000);
      const hour = targetDate.getHours();
      const minute = targetDate.getMinutes();

      // 物理级直写：绕过沙箱，直接写入手机系统的原生时钟闹钟！ [1]
      if (window.AndroidMCP && typeof window.AndroidMCP.setAndroidSystemAlarm === 'function') {
        window.AndroidMCP.setAndroidSystemAlarm(hour, minute, "叙事诗小手机：神经倒计时闹铃");
        showToast(`已成功写入系统时钟！物理闹钟已设定在 ${hour}:${String(minute).padStart(2, '0')}`);
        this.closePanel();
        return;
      }

      // 降级模拟
      showToast(`模拟闹钟已设定，将在 ${seconds} 秒后提醒`);
      this.closePanel();

      setTimeout(() => {
        if (window.AndroidMCP && typeof window.AndroidMCP.triggerHardwareVibrator === 'function') {
          window.AndroidMCP.triggerHardwareVibrator(600);
        } else if (navigator.vibrate) {
          navigator.vibrate([400, 100, 400, 100, 600]);
        }
        showCustomAlert("⏰ MCP 警报通知", "您设定的倒计时神经闹钟已经唤醒！");
      }, seconds * 1000);
    },

    // 4.1 静默扫描真机 /Music/Storypoem 物理目录并载入 [1]
    scanAndSyncLocalMusic: function() {
      if (window.AndroidMCP && typeof window.AndroidMCP.scanLocalMusicFolder === 'function') {
        try {
          const jsonStr = window.AndroidMCP.scanLocalMusicFolder();
          this.localPlaylist = JSON.parse(jsonStr);

          // 同步歌单名称给 LocalStorage，供大模型提示词读取感知 [1]
          localStorage.setItem("mcp_playlist_titles", jsonStr);

          const titleEl = document.getElementById("mcp-music-title");
          if (titleEl) {
            titleEl.innerText = this.localPlaylist.length > 0 
              ? `已自动装载本地歌曲：${this.localPlaylist.length} 首` 
              : "歌单就绪：尚未在手机 /Music/Storypoem 下放置歌曲";
          }
        } catch(e) {
          console.error("扫描本地物理歌单失败:", e);
        }
      } else {
        // H5 降级提示
        const titles = localStorage.getItem("mcp_playlist_titles");
        if (titles) {
          try { this.localPlaylist = JSON.parse(titles); } catch(e) {}
        }
      }
      this.loadMcpSettings();
    },

    // 4.2 通过原生 MediaPlayer 进行物理音频后台/锁屏播放 (彻底击穿 Origin 拦截) [1]
    playTrackByIndex: function(index) {
      if (this.localPlaylist.length === 0) {
        showToast("本地歌单为空！请先将 MP3 歌曲丢入手机 /Music/Storypoem 目录下");
        return;
      }
      if (index < 0 || index >= this.localPlaylist.length) {
        showToast("指令点播的音乐索引超出界限");
        return;
      }

      const songName = this.localPlaylist[index];
      
      // 核心直连：调用原生 APK 的 Kotlin 媒体引擎，实现完美的后台放歌与锁屏驻留 [1]
      if (window.AndroidMCP && typeof window.AndroidMCP.playNativeMusic === 'function') {
        const success = window.AndroidMCP.playNativeMusic(songName);
        if (success) {
          document.getElementById("mcp-music-title").innerText = `正在物理播放：${songName}`;
          showToast(`已成功唤醒原生播放器后台播放：《${songName}》`);
        } else {
          showToast("真机原生播放音频流失败");
        }
        return;
      }

      showToast("当前环境暂不支持原生物理音频流后台播放，请在 APK 壳中运行。");
    },

    // 按歌名进行模糊匹配播放
    playTrackByTitle: function(title) {
      if (this.localPlaylist.length === 0) return;
      const index = this.localPlaylist.findIndex(s => s.toLowerCase().includes(title.toLowerCase()));
      if (index !== -1) {
        this.playTrackByIndex(index);
      } else {
        showToast(`歌单中未找到包含 "${title}" 的歌曲`);
      }
    },

    stopMusic: function() {
      if (window.AndroidMCP && typeof window.AndroidMCP.stopNativeMusic === 'function') {
        window.AndroidMCP.stopNativeMusic();
        document.getElementById("mcp-music-title").innerText = "音乐播放已暂停";
        showToast("音频播放已暂停");
      }
    },

    // 5. 屏幕扮演时间刷新展现
    refreshScreentimeDisplay: function() {
      const activeSeconds = parseInt(localStorage.getItem("mcp_screen_time_today") || "0");
      const mins = Math.floor(activeSeconds / 60);
      const secs = activeSeconds % 60;
      document.getElementById("mcp-screentime-val").innerText = `${mins} 分钟 ${secs} 秒`;
    },

    // ==========================================
    //  6. 后台主动发信控制（重写版）
    // ==========================================
    // 修复说明：修正后台发信必须在 APP 前台才能运行的 WebView 冻结问题。
    // 开启后台发信时，从 IndexedDB 读取当前 API preset 注册到 Kotlin 层，
    // Kotlin 层直接使用 HttpURLConnection 发送 HTTP 请求，完全绕过 WebView 冻结限制。
    // 同时保留前台场景下的 btnReply.click() 逻辑以保持兼容。
    // ==========================================

    toggleActiveMessage: function(toggleEl) {
      const isEnabled = toggleEl.checked;
      localStorage.setItem("settings-mcp-active-msg-enabled", isEnabled ? "true" : "false");
      
      if (isEnabled) {
        const interval = parseInt(document.getElementById("mcp-active-msg-interval").value) || 10;
        
        // 开启时：从 IndexedDB 读取当前选中的 API preset，注册到 Kotlin 层
        (async () => {
          try {
            // 读取全局 API preset 设置（与 app_chat.js 中发信时读取相同的配置）
            const currentApiId = parseInt(localStorage.getItem("global_api_preset_id") || "0");
            let apiConfig = null;
            
            if (currentApiId > 0 && typeof db !== 'undefined' && db.api_presets) {
              apiConfig = await db.api_presets.get(currentApiId);
            }
            
            if (!apiConfig && typeof db !== 'undefined' && db.api_presets) {
              // 如果没有选中的 preset，读取第一个可用配置
              apiConfig = await db.api_presets.limit(1).first();
            }
            
            if (apiConfig && apiConfig.url && apiConfig.key) {
              // 注册 API 配置到 Kotlin 层（参数：url, key, model, temperature）
              if (window.AndroidMCP && typeof window.AndroidMCP.registerBgApiConfig === 'function') {
                window.AndroidMCP.registerBgApiConfig(
                  apiConfig.url,
                  apiConfig.key,
                  apiConfig.model || 'gpt-3.5-turbo',
                  apiConfig.temperature !== undefined ? apiConfig.temperature : 1.0
                );
              }
              
              // 启动后台轮询
              if (window.AndroidMCP && typeof window.AndroidMCP.startBackgroundPolling === 'function') {
                window.AndroidMCP.startBackgroundPolling(interval);
                showToast(`后台主动发信服务已开启（API: ${apiConfig.name || apiConfig.url}），每隔 ${interval} 分钟轮询一次`);
              } else {
                showToast("后台主动发信已模拟开启");
              }
            } else {
              showToast("未找到 API 配置！请先在设置中配置 API Preset");
              toggleEl.checked = false;
              localStorage.setItem("settings-mcp-active-msg-enabled", "false");
            }
          } catch(e) {
            console.error("读取 API 配置失败:", e);
            showToast("读取 API 配置失败，请确认已正确设置 API Preset");
            toggleEl.checked = false;
            localStorage.setItem("settings-mcp-active-msg-enabled", "false");
          }
        })();
        
      } else {
        // 关闭时：停止后台轮询
        if (window.AndroidMCP && typeof window.AndroidMCP.stopBackgroundPolling === 'function') {
          window.AndroidMCP.stopBackgroundPolling();
        }
        showToast("后台主动发信服务已关闭");
      }
    },

    // 后台主动发信触发器（由 Kotlin 层定时调用）
    triggerBackgroundActiveMessage: function() {
      if (!activeSessionId) return;
      
      // === 新逻辑：通过 Kotlin 层直接发 HTTP 请求（用于后台场景）===
      // 获取当前输入框中的消息内容（如果没有新输入，则不会发信）
      const input = document.getElementById("chat-input");
      let message = "";
      if (input && input.value.trim()) {
        message = input.value.trim();
      }
      
      if (message) {
        // 有消息内容：推送到 Kotlin 层的后台发送队列
        if (window.AndroidMCP && typeof window.AndroidMCP.pushBgMessage === 'function') {
          try {
            window.AndroidMCP.pushBgMessage(message);
            // 清空输入框
            input.value = "";
            // 调整高度
            input.style.height = 'auto';
          } catch(e) {
            console.error("pushBgMessage 失败:", e);
          }
        }
      }
      
      // === 保留原有逻辑：通过 btnReply.click() 触发前端发信（用于前台场景）===
      // 如果当前 APP 在前台，WebView 正常运行时，走原有逻辑
      const btnReply = document.getElementById("btn-dialog-reply");
      if (btnReply && !onlineAbortController) {
        btnReply.click();
      }
      
      // === 轮询后台发信结果并更新界面 ===
      if (window.AndroidMCP && typeof window.AndroidMCP.pollBgResult === 'function') {
        try {
          const resultJson = window.AndroidMCP.pollBgResult();
          if (resultJson) {
            const result = JSON.parse(resultJson);
            if (result && result.content) {
              // 模拟收到消息：如果 session 列表中有当前会话，追加 AI 响应
              // 这里与 app_chat.js 中收到消息后更新界面的逻辑保持一致
              if (typeof addMessageToSession === 'function') {
                addMessageToSession(activeSessionId, {
                  type: 'ai',
                  text: result.content,
                  time: new Date().toLocaleString()
                });
              }
              // 更新对话显示
              if (typeof appendMessageToDisplay === 'function') {
                appendMessageToDisplay('ai', result.content);
              }
            }
          }
        } catch(e) {
          console.error("pollBgResult 失败:", e);
        }
      }
    },

    // 7. 桌面悬浮桌宠控制
    toggleDesktopPet: function(toggleEl) {
      const isEnabled = toggleEl.checked;
      if (isEnabled) {
        if (window.AndroidMCP && typeof window.AndroidMCP.checkOverlayPermission === 'function') {
          const hasPermission = window.AndroidMCP.checkOverlayPermission();
          if (!hasPermission) {
            toggleEl.checked = false;
            showCustomConfirm("需要悬浮窗权限", "由于安卓系统限制，启动桌面桌宠必须授予"显示在其他应用上层"权限。是否现在前往系统设置授予？", () => {
              window.AndroidMCP.requestOverlayPermission();
            });
            return;
          }
        }
        
        const petImage = localStorage.getItem("mcp-desktop-pet-image");
        if (!petImage) {
          toggleEl.checked = false;
          showToast("请先上传透明底 PNG 桌宠立绘图片！");
          return;
        }
        const size = parseInt(document.getElementById("mcp-pet-size-slider").value) || 100;
        localStorage.setItem("settings-mcp-pet-enabled", "true");
        
        if (window.AndroidMCP && typeof window.AndroidMCP.showDesktopPet === 'function') {
          window.AndroidMCP.showDesktopPet(petImage, size);
        }
        showToast("系统桌面悬浮桌宠已开启！");
      } else {
        localStorage.setItem("settings-mcp-pet-enabled", "false");
        if (window.AndroidMCP && typeof window.AndroidMCP.hideDesktopPet === 'function') {
          window.AndroidMCP.hideDesktopPet();
        }
        showToast("桌宠已退出");
      }
    },

    handlePetUpload: function(fileEl) {
      if (fileEl.files.length > 0) {
        const reader = new FileReader();
        reader.onload = (e) => {
          const base64 = e.target.result;
          localStorage.setItem("mcp-desktop-pet-image", base64);
          document.getElementById("mcp-pet-preview-box").innerHTML = `<img src="${base64}" style="width:100%; height:100%; object-fit:contain;">`;
          showToast("桌宠立绘上传成功！");
          
          // 如果桌宠开关是开启的，即时重绘
          const toggle = document.getElementById("settings-mcp-pet-toggle");
          if (toggle && toggle.checked) {
            const size = parseInt(document.getElementById("mcp-pet-size-slider").value) || 100;
            if (window.AndroidMCP && typeof window.AndroidMCP.showDesktopPet === 'function') {
              window.AndroidMCP.showDesktopPet(base64, size);
            }
          }
        };
        reader.readAsDataURL(fileEl.files[0]);
      }
    },
    changePetSize: function(val) {
      document.getElementById("mcp-pet-size-val").innerText = `${val}dp`;
      const toggle = document.getElementById("settings-mcp-pet-toggle");
      if (toggle && toggle.checked) {
        if (window.AndroidMCP && typeof window.AndroidMCP.updateDesktopPetSize === 'function') {
          window.AndroidMCP.updateDesktopPetSize(parseInt(val));
        }
      }
    }
  };

  // ==========================================
  //  5. 精准统计今日 PWA 屏幕使用时长
  // ==========================================
  let activeSeconds = parseInt(localStorage.getItem("mcp_screen_time_today") || "0");
  setInterval(() => {
    if (document.visibilityState === 'visible') {
      activeSeconds++;
      localStorage.setItem("mcp_screen_time_today", activeSeconds);
    }
  }, 1000);

  // ==========================================
  //  6. 防御性自注册绑定 (自适应 DOMContentLoaded 周期)
  // ==========================================
  function bindMcpTrigger() {
    const btn = document.getElementById("btn-chat-mcp");
    if (btn) {
      btn.onclick = (e) => {
        if (e) e.preventDefault();
        document.getElementById("chat-expand-panel").classList.remove("active");
        mcpSystem.openPanel();
      };
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bindMcpTrigger);
  } else {
    bindMcpTrigger();
  }

  window.mcpSystem = mcpSystem;
})();
