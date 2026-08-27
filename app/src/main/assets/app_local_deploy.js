/**
 * app_local_deploy.js - 本地部署中心（Termux 脚本管理）
 *
 * 设计目标：
 *  1. 不再内置/下载 nodejs-mobile 运行时，改为基于 Termux 部署（酒馆那套成熟思路）。
 *  2. 设置页提供"本地部署"入口，集中管理 Termux 脚本。
 *  3. 内置网易云音乐 API 脚本（端口 3000），用户可下方新增脚本。
 *  4. 每个脚本可独立启停，并做运行状态健康监测。
 *  5. 提供"如何在 Termux 里部署"的分步引导。
 *
 * 存储约定（localStorage）：
 *  - local-deploy-scripts : JSON 数组，[{ id, name, desc, port, healthUrl, termuxCmd, status }]
 *  - 内置网易云脚本作为默认 seed。
 */
(function () {
  "use strict";

  function showToastSafe(msg) {
    if (typeof window.showToast === "function") window.showToast(msg);
    else console.log("[local-deploy]", msg);
  }

  function esc(str) {
    if (!str) return "";
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // 内置脚本 seed：网易云音乐 API（端口 3000）
  const BUILTIN_SCRIPTS = [
    {
      id: "ncm-api",
      name: "网易云音乐 API",
      desc: "网易云登录代理 / 歌单同步（本地服务端口 3000）",
      port: 3000,
      healthUrl: "http://localhost:3000/health",
      termuxCmd: "NeteaseCloudMusicApi -p 3000",
      status: "unknown"
    }
  ];

  function loadScripts() {
    try {
      const raw = localStorage.getItem("local-deploy-scripts");
      if (raw) return JSON.parse(raw);
    } catch (e) {}
    return JSON.parse(JSON.stringify(BUILTIN_SCRIPTS));
  }

  function saveScripts(list) {
    localStorage.setItem("local-deploy-scripts", JSON.stringify(list));
  }

  const localDeploySystem = {
    // ============ 面板 HTML ============
    getPanelHTML: function () {
      return `
        <div id="settings-lv2-local-deploy" class="settings-lv2-panel" style="display:none;">
          <!-- 引导卡片 -->
          <div class="local-deploy-intro-card">
            <div class="local-deploy-intro-title">本地部署中心</div>
            <div class="local-deploy-intro-desc">
              通过 Termux 在手机上运行本地脚本服务（如网易云 API），App 通过 localhost 访问。
              每个脚本可独立启停，并实时监测运行状态。
            </div>
          </div>

          <!-- Termux 状态栏 -->
          <div id="local-deploy-termux-status" class="local-deploy-termux-status">检测 Termux 环境…</div>

          <!-- 引导按钮 -->
          <div class="form-actions" style="margin-bottom:14px;">
            <button id="btn-local-deploy-guide" class="btn btn-outline" style="flex:1;">部署引导（一步步教你在 Termux 运行）</button>
          </div>

          <!-- 脚本列表标题 -->
          <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:8px;">
            <span style="font-size:13px; font-weight:800; color:var(--text-primary);">我的脚本</span>
            <button id="btn-local-deploy-add" class="btn btn-primary" style="padding:6px 12px; font-size:11px;">＋ 新增脚本</button>
          </div>

          <!-- 脚本卡片容器 -->
          <div id="local-deploy-scripts-list"></div>

          <!-- 引导弹层（默认隐藏） -->
          <div id="local-deploy-guide-overlay" style="display:none; position:fixed; top:0; left:0; right:0; bottom:0; background:rgba(15,23,42,0.5); z-index:300; align-items:center; justify-content:center; padding:20px;">
            <div style="background:var(--bg-main); border-radius:18px; max-width:340px; width:100%; max-height:85vh; overflow-y:auto; padding:18px;">
              <div style="font-size:15px; font-weight:800; color:var(--text-primary); margin-bottom:12px;">Termux 部署引导</div>
              <div id="local-deploy-guide-body" style="font-size:12px; line-height:1.8; color:var(--text-secondary);"></div>
              <div class="form-actions" style="margin-top:14px;">
                <button id="btn-local-deploy-guide-close" class="btn btn-primary" style="width:100%;">我明白了</button>
              </div>
            </div>
          </div>
        </div>
      `;
    },

    // ============ 初始化 ============
    initPanel: function () {
      const btnGuide = document.getElementById("btn-local-deploy-guide");
      const btnAdd = document.getElementById("btn-local-deploy-add");
      if (btnGuide) btnGuide.onclick = () => this.showGuide();
      if (btnAdd) btnAdd.onclick = () => this.addScript();

      const btnClose = document.getElementById("btn-local-deploy-guide-close");
      if (btnClose) btnClose.onclick = () => this.hideGuide();

      this.checkTermux();
      this.renderScripts();
    },

    // ============ Termux 环境检测 ============
    checkTermux: function () {
      const el = document.getElementById("local-deploy-termux-status");
      if (!el) return;
      let termuxReady = false;
      if (window.AndroidMCP && typeof window.AndroidMCP.isTermuxReady === "function") {
        try {
          termuxReady = window.AndroidMCP.isTermuxReady() === true;
        } catch (e) {}
      }
      if (termuxReady) {
        el.innerHTML = "Termux 环境：<b style='color:#16a34a;'>已就绪</b>，可运行本地脚本";
        el.style.borderColor = "#bbf7d0";
        el.style.background = "#f0fdf4";
      } else {
        el.innerHTML = "Termux 环境：<b style='color:#dc2626;'>未检测到</b>。请先安装 Termux 并执行下方引导部署脚本。";
        el.style.borderColor = "#fecaca";
        el.style.background = "#fef2f2";
      }
    },

    // ============ 渲染脚本卡片 ============
    renderScripts: function () {
      const listEl = document.getElementById("local-deploy-scripts-list");
      if (!listEl) return;
      const scripts = loadScripts();

      if (scripts.length === 0) {
        listEl.innerHTML = `<div style="padding:16px; text-align:center; color:var(--text-secondary); font-size:12px;">还没有脚本，点击上方「新增脚本」添加。</div>`;
        return;
      }

      listEl.innerHTML = scripts.map((s, idx) => this._renderCard(s, idx)).join("");

      // 绑定按钮
      scripts.forEach((s, idx) => {
        const startBtn = document.getElementById(`ld-start-${idx}`);
        const stopBtn = document.getElementById(`ld-stop-${idx}`);
        const healthBtn = document.getElementById(`ld-health-${idx}`);
        const delBtn = document.getElementById(`ld-del-${idx}`);
        if (startBtn) startBtn.onclick = () => this.startScript(idx);
        if (stopBtn) stopBtn.onclick = () => this.stopScript(idx);
        if (healthBtn) healthBtn.onclick = () => this.checkHealth(idx);
        if (delBtn) delBtn.onclick = () => this.deleteScript(idx);
      });

      // 自动跑一次健康检测
      this.checkAllHealth();
    },

    _renderCard: function (s, idx) {
      const statusMap = {
        running: "<b style='color:#16a34a;'>运行中</b>",
        stopped: "<b style='color:#64748b;'>已停止</b>",
        unknown: "<b style='color:#ca8a04;'>未知</b>",
        error: "<b style='color:#dc2626;'>异常</b>"
      };
      const statusText = statusMap[s.status] || statusMap.unknown;
      return `
        <div class="local-deploy-card" id="ld-card-${idx}">
          <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:6px;">
            <div style="font-size:13px; font-weight:800; color:var(--text-primary);">${esc(s.name)}</div>
            <span id="ld-status-${idx}">${statusText}</span>
          </div>
          <div style="font-size:11px; color:var(--text-secondary); line-height:1.6; margin-bottom:8px;">${esc(s.desc)}</div>
          <div style="font-size:10px; color:var(--text-secondary); margin-bottom:8px; word-break:break-all;">
            <b>地址：</b>${esc(s.healthUrl || ("http://localhost:" + (s.port || "3000")))}
          </div>
          <div style="display:flex; gap:6px; flex-wrap:wrap;">
            <button id="ld-start-${idx}" class="btn btn-primary" style="flex:1; padding:6px 0; font-size:11px;">启动</button>
            <button id="ld-stop-${idx}" class="btn btn-outline" style="flex:1; padding:6px 0; font-size:11px;">停止</button>
            <button id="ld-health-${idx}" class="btn btn-outline" style="flex:1; padding:6px 0; font-size:11px;">检测</button>
            <button id="ld-del-${idx}" class="btn btn-danger-outline" style="padding:6px 10px; font-size:11px;">删除</button>
          </div>
        </div>
      `;
    },

    // ============ 新增脚本 ============
    addScript: function () {
      const scripts = loadScripts();
      const name = prompt("脚本名称（例如：我的本地代理）:");
      if (!name) return;
      const port = prompt("服务端口（例如 3000）:", "3000");
      const healthUrl = prompt("健康检查地址（例如 http://localhost:3000/health）:", "http://localhost:" + (port || "3000") + "/health");
      const termuxCmd = prompt("Termux 启动命令（例如 node start.js）:");
      if (!termuxCmd) return;

      scripts.push({
        id: "script-" + Date.now(),
        name: name,
        desc: "自定义本地脚本",
        port: Number(port) || 3000,
        healthUrl: healthUrl || "http://localhost:" + (port || "3000") + "/health",
        termuxCmd: termuxCmd,
        status: "unknown"
      });
      saveScripts(scripts);
      this.renderScripts();
      showToastSafe("脚本已添加");
    },

    deleteScript: function (idx) {
      const scripts = loadScripts();
      const s = scripts[idx];
      if (!s) return;
      if (confirm("确定删除脚本「" + s.name + "」吗？")) {
        scripts.splice(idx, 1);
        saveScripts(scripts);
        this.renderScripts();
        showToastSafe("脚本已删除");
      }
    },

    // ============ 独立启停 ============
    startScript: function (idx) {
      const scripts = loadScripts();
      const s = scripts[idx];
      if (!s) return;
      showToastSafe("正在启动「" + s.name + "」…");

      // 通过 AndroidMCP 调用 Termux 启动命令
      let ok = false;
      if (window.AndroidMCP && typeof window.AndroidMCP.runTermuxCommand === "function") {
        try {
          ok = window.AndroidMCP.runTermuxCommand(s.termuxCmd) === true;
        } catch (e) {
          console.error("[local-deploy] runTermuxCommand error:", e);
        }
      }

      if (ok) {
        s.status = "running";
      } else {
        // 无法直接调 Termux 时，降级为提示用户手动运行
        this.showTermuxCommandHint(s);
        s.status = "unknown";
      }
      saveScripts(scripts);
      this.renderScripts();
    },

    stopScript: function (idx) {
      const scripts = loadScripts();
      const s = scripts[idx];
      if (!s) return;
      showToastSafe("正在停止「" + s.name + "」…");

      let ok = false;
      if (window.AndroidMCP && typeof window.AndroidMCP.stopTermuxCommand === "function") {
        try {
          ok = window.AndroidMCP.stopTermuxCommand(s.termuxCmd) === true;
        } catch (e) {
          console.error("[local-deploy] stopTermuxCommand error:", e);
        }
      }

      if (ok) {
        s.status = "stopped";
      } else {
        showToastSafe("请在 Termux 中按 Ctrl+C 停止该脚本");
        s.status = "unknown";
      }
      saveScripts(scripts);
      this.renderScripts();
    },

    // ============ 健康检测 ============
    checkHealth: function (idx) {
      const scripts = loadScripts();
      const s = scripts[idx];
      if (!s) return;
      const url = s.healthUrl || ("http://localhost:" + (s.port || "3000") + "/health");
      fetch(url, { method: "GET", mode: "cors", cache: "no-store" })
        .then((res) => {
          s.status = res.ok ? "running" : "error";
          saveScripts(scripts);
          this.renderScripts();
          showToastSafe(s.status === "running" ? "「" + s.name + "」运行正常" : "「" + s.name + "」无响应");
        })
        .catch(() => {
          s.status = "stopped";
          saveScripts(scripts);
          this.renderScripts();
          showToastSafe("「" + s.name + "」未运行");
        });
    },

    checkAllHealth: function () {
      const scripts = loadScripts();
      scripts.forEach((s, idx) => {
        const url = s.healthUrl || ("http://localhost:" + (s.port || "3000") + "/health");
        fetch(url, { method: "GET", mode: "cors", cache: "no-store" })
          .then((res) => {
            s.status = res.ok ? "running" : "error";
            const el = document.getElementById("ld-status-" + idx);
            if (el) el.innerHTML = "<b style='color:" + (res.ok ? "#16a34a" : "#dc2626") + ";'>" + (res.ok ? "运行中" : "异常") + "</b>";
          })
          .catch(() => {
            s.status = "stopped";
            const el = document.getElementById("ld-status-" + idx);
            if (el) el.innerHTML = "<b style='color:#64748b;'>已停止</b>";
          });
      });
    },

    // ============ Termux 命令提示 ============
    showTermuxCommandHint: function (s) {
      const cmd = s.termuxCmd || "";
      if (typeof window.showCustomConfirm === "function") {
        window.showCustomConfirm(
          "在 Termux 中运行",
          "请打开 Termux，执行以下命令启动「" + s.name + "」：\n\n" + cmd + "\n\n保持 Termux 在前台或后台运行即可。",
          function () {}
        );
      } else {
        alert("请在 Termux 中执行:\n\n" + cmd);
      }
    },

    // ============ 部署引导 ============
    showGuide: function () {
      const overlay = document.getElementById("local-deploy-guide-overlay");
      const body = document.getElementById("local-deploy-guide-body");
      if (!overlay || !body) return;
      body.innerHTML = `
        <b style="color:var(--text-primary);">第 1 步：安装 Termux</b><br>
        用 F-Droid 安装（Play 版已停更）：<br>
        <code style="background:rgba(0,0,0,0.06); padding:1px 4px; border-radius:3px;">https://f-droid.org/packages/com.termux/</code><br><br>

        <b style="color:var(--text-primary);">第 2 步：安装依赖</b><br>
        在 Termux 中执行：<br>
        <code style="background:rgba(0,0,0,0.06); padding:1px 4px; border-radius:3px;">pkg update -y && pkg install -y nodejs-lts</code><br><br>

        <b style="color:var(--text-primary);">第 3 步：安装网易云 API</b><br>
        <code style="background:rgba(0,0,0,0.06); padding:1px 4px; border-radius:3px;">npm install -g NeteaseCloudMusicApi --registry=https://registry.npmmirror.com</code><br><br>

        <b style="color:var(--text-primary);">第 4 步：启动服务</b><br>
        在本页「我的脚本」中点击网易云脚本的「启动」；或直接在 Termux 执行：<br>
        <code style="background:rgba(0,0,0,0.06); padding:1px 4px; border-radius:3px;">NeteaseCloudMusicApi -p 3000</code><br><br>

        <b style="color:var(--text-primary);">第 5 步：保活</b><br>
        安装 termux-api 并开启保活，防止锁屏被杀：<br>
        <code style="background:rgba(0,0,0,0.06); padding:1px 4px; border-radius:3px;">pkg install termux-api && termux-wake-lock</code><br><br>

        <b style="color:var(--text-primary);">第 6 步：回到 App 使用</b><br>
        在网易云登录弹窗的 API 地址填：<code style="background:rgba(0,0,0,0.06); padding:1px 4px; border-radius:3px;">http://localhost:3000</code>
      `;
      overlay.style.display = "flex";
    },

    hideGuide: function () {
      const overlay = document.getElementById("local-deploy-guide-overlay");
      if (overlay) overlay.style.display = "none";
    }
  };

  window.localDeploySystem = localDeploySystem;
})();