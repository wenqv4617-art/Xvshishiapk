/**
 * app_chat_mcp.js - Model Context Protocol & Mobile Control Panel 神经联动中枢 (歌单多选读取版)
 */

(function() {
  let audioInstance = null;

  const mcpSystem = {
    // 内存歌单缓存（保存 File 实例以供播放）
    playlist: [],

    // 开启中枢控制面板
    openPanel: function() {
      if (!activeSessionId) {
        showToast("请先进入一个好友聊天对话！");
        return;
      }
      document.getElementById("chat-mcp-panel").classList.add("active");
      this.refreshScreentimeDisplay();
      this.loadMcpSettings();
    },

    // 关闭控制面板
    closePanel: function() {
      document.getElementById("chat-mcp-panel").classList.remove("active");
    },

    // 载入 MCP 本地配置
    loadMcpSettings: function() {
      const isMcpEnabled = localStorage.getItem("settings-mcp-prompt-enabled") === "true";
      const toggle = document.getElementById("settings-mcp-prompt-toggle");
      if (toggle) toggle.checked = isMcpEnabled;

      // 回显本地歌单列表
      const songTitles = localStorage.getItem("mcp_playlist_titles");
      const listEl = document.getElementById("mcp-playlist-list");
      if (listEl) {
        if (songTitles) {
          try {
            const songs = JSON.parse(songTitles);
            if (songs.length > 0) {
              listEl.innerHTML = songs.map((s, idx) => `<div style="padding: 2px 4px; border-radius:4px; background:rgba(0,0,0,0.03); overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">#${idx} - ${s}</div>`).join("");
              return;
            }
          } catch(e) {}
        }
        listEl.innerHTML = "歌单为空，请先点击导入本地音乐。";
      }
    },

    // MCP 神经注入开关切换
    togglePrompt: function(toggleEl) {
      localStorage.setItem("settings-mcp-prompt-enabled", toggleEl.checked ? "true" : "false");
      showToast(toggleEl.checked ? "已成功建立神经感知！当前环境与歌单已融入 AI 意识。" : "已断开神经通道。");
    },

    // 1. 同步地理位置与实时天气 (调用 Open-Meteo 免费开源气象协议)
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
            
            // 气象代码转换字典
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

            // 写入本地，大模型提示词编译器会动态感知
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

    // 2. 物理马达震动测试
    triggerVibration: function() {
      // 优先调用安卓原生高特权通道，绕过任何潜在沙箱！ [2]
      if (window.AndroidMCP && typeof window.AndroidMCP.triggerHardwareVibrator === 'function') {
        window.AndroidMCP.triggerHardwareVibrator(400); // 震动 400ms
        showToast("原生震动信号已发送至安卓硬件马达");
        return;
      }

      // H5 降级兼容
      if (navigator.vibrate) {
        navigator.vibrate([200, 100, 200, 100, 300]);
        showToast("H5 震动信号已发送");
      } else {
        showToast("您的设备不支持物理震动 API");
      }
    },

    // 3. 神经闹钟计时器 (结合安卓原生系统时钟高特权直写)
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

      // 优先调用原生 Android 时钟高特权直写通道，静默写入真机系统闹钟！ [2]
      if (window.AndroidMCP && typeof window.AndroidMCP.setAndroidSystemAlarm === 'function') {
        window.AndroidMCP.setAndroidSystemAlarm(hour, minute, "叙事诗小手机：MCP 神经倒计时");
        showToast(`已成功将物理闹钟静默设定至：${hour}:${String(minute).padStart(2, '0')}`);
        this.closePanel();
        return;
      }

      // H5 降级倒计时模拟器
      showToast(`神经闹钟已设定，将在 ${seconds} 秒后提醒`);
      this.closePanel();

      setTimeout(() => {
        if (window.AndroidMCP && typeof window.AndroidMCP.triggerHardwareVibrator === 'function') {
          window.AndroidMCP.triggerHardwareVibrator(600); // 震动 600ms
        } else if (navigator.vibrate) {
          navigator.vibrate([400, 100, 400, 100, 600]);
        }
        showCustomAlert("⏰ MCP 警报通知", "您设定的倒计时神经闹钟已经唤醒！");
      }, seconds * 1000);
    },

    // 4. 读取多选本地音频文件歌单并存入内存与 localStorage [1]
    handleMusicSelect: function(input) {
      if (input.files.length === 0) return;
      
      this.playlist = Array.from(input.files);
      const titles = this.playlist.map(file => file.name);

      // 将歌单的文件名称写到存储中，以便大模型感知
      localStorage.setItem("mcp_playlist_titles", JSON.stringify(titles));
      
      const titleEl = document.getElementById("mcp-music-title");
      if (titleEl) titleEl.innerText = `已导入本地歌曲：${this.playlist.length} 首`;

      this.loadMcpSettings();
      showToast(`成功导入 ${this.playlist.length} 首本地歌曲！`);
    },

    // 按索引播放内存中的本地音频
    playTrackByIndex: function(index) {
      if (this.playlist.length === 0) {
        showToast("本地歌单为空，请先在 MCP 面板中导入音乐！");
        return;
      }
      if (index < 0 || index >= this.playlist.length) {
        showToast("指令播放的歌单索引超出界限");
        return;
      }

      const file = this.playlist[index];
      this.playAudioFile(file);
    },

    // 真正的音乐播放控制逻辑 (MediaSession 完美继承锁屏控制)
    playAudioFile: function(file) {
      try {
        if (audioInstance) {
          audioInstance.pause();
        }
        
        // 利用极速内存对象地址转化本地 File 二进制数据 [2]
        const url = URL.createObjectURL(file);
        audioInstance = new Audio(url);
        
        audioInstance.play().then(() => {
          document.getElementById("mcp-music-title").innerText = `正在播放：${file.name}`;
          
          if ('mediaSession' in navigator) {
            navigator.mediaSession.metadata = new MediaMetadata({
              title: file.name.replace(/\.[^/.]+$/, ""), // 自动裁剪去掉 mp3/wav 后缀
              artist: '叙事诗小手机 (Story Phone)',
              album: '设备本地神经歌单'
            });
            
            navigator.mediaSession.setActionHandler('play', () => audioInstance.play());
            navigator.mediaSession.setActionHandler('pause', () => audioInstance.pause());
          }
          showToast(`已成功唤醒真机播放器，正在播放：《${file.name}》`);
        }).catch(err => {
          console.error(err);
          showToast("真机解码音频文件失败，请检查文件格式！");
        });
      } catch(e) {
        console.error(e);
        showToast("播放音频流遇到故障");
      }
    },

    stopMusic: function() {
      if (audioInstance) {
        audioInstance.pause();
        document.getElementById("mcp-music-title").innerText = "音频状态：已暂停";
        showToast("音频流播放已暂停");
      }
    },

    // 5. 屏幕扮演时间刷新展现
    refreshScreentimeDisplay: function() {
      const activeSeconds = parseInt(localStorage.getItem("mcp_screen_time_today") || "0");
      const mins = Math.floor(activeSeconds / 60);
      const secs = activeSeconds % 60;
      document.getElementById("mcp-screentime-val").innerText = `${mins} 分钟 ${secs} 秒`;
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
