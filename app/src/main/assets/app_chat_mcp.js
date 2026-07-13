/**
 * app_chat_mcp.js - Model Context Protocol & Mobile Control Panel 自研联动中枢
 */

(function() {
  let audioInstance = null;

  const mcpSystem = {
    // 开启中枢控制面板
    openPanel: function() {
      if (!activeSessionId) {
        showToast("请先进入一个好友聊天对话！");
        return;
      }
      document.getElementById("chat-mcp-panel").classList.add("active");
      this.refreshScreentimeDisplay();
    },

    // 关闭控制面板
    closePanel: function() {
      document.getElementById("chat-mcp-panel").classList.remove("active");
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
            showToast("传感器数据已注入！AI 已同步您的时空认知。");
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
      if (navigator.vibrate) {
        // 安卓马达震动节奏
        navigator.vibrate([200, 100, 200, 100, 300]);
        showToast("震动信号已发送至 Android 硬件马达");
      } else {
        showToast("您的设备不支持物理震动 API");
      }
    },

    // 3. 神经闹钟计时器 (结合屏幕唤醒锁保障后台运行)
    setAlarm: function() {
      const input = document.getElementById("mcp-timer-input");
      const seconds = parseInt(input.value);
      if (isNaN(seconds) || seconds <= 0) {
        showToast("请输入合法的闹钟倒计时秒数！");
        return;
      }

      showToast(`神经闹钟已设定，将在 ${seconds} 秒后提醒`);
      this.closePanel();

      // 申请屏幕唤醒锁，防止倒计时被后台冻结进程
      if ('wakeLock' in navigator) {
        navigator.wakeLock.request('screen').catch(e => console.warn("唤醒锁申请受阻:", e));
      }

      setTimeout(() => {
        if (navigator.vibrate) {
          navigator.vibrate([400, 100, 400, 100, 600]);
        }
        showCustomAlert("⏰ MCP 警报通知", "您设定的倒计时神经闹钟已经唤醒！");
      }, seconds * 1000);
    },

    // 4. 音频流播放器管理 (Android Lock-screen 下拉卡片媒体适配)
    playMusic: function() {
      if (!audioInstance) {
        // 选用高稳定性的公共疗愈钢琴曲
        audioInstance = new Audio("https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3");
        audioInstance.loop = true;
      }
      
      audioInstance.play().then(() => {
        document.getElementById("mcp-music-title").innerText = "音频状态：正在后台播放钢琴曲";
        
        // 完美的 Android 系统媒体中心通知控制槽位对接
        if ('mediaSession' in navigator) {
          navigator.mediaSession.metadata = new MediaMetadata({
            title: '神经共频疗愈白噪音',
            artist: '叙事诗小手机 (Story Phone)',
            album: 'MCP 硬件伴随舱',
            artwork: [
              { src: 'data:image/svg+xml;utf8,<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"><circle cx="50" cy="50" r="50" fill="%236366f1"/></svg>', sizes: '128x128', type: 'image/png' }
            ]
          });
          
          navigator.mediaSession.setActionHandler('play', () => this.playMusic());
          navigator.mediaSession.setActionHandler('pause', () => this.stopMusic());
        }
        showToast("钢琴曲已播放，下拉安卓系统状态栏即可控制！");
      }).catch(err => {
        console.error(err);
        showToast("音乐播放失败，请稍后重试");
      });
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