/**
 * app_local_deploy.js - 本地部署中心（Termux 脚本管理）
 * 内置网易云 API(3000) + CORS 跨域中转(3001)；独立启停、健康检测、
 * 部署引导命令一键复制、新增/删除脚本用应用内卡片弹窗（不用浏览器 prompt/confirm）。
 */
(function () {
  "use strict";

  function showToastSafe(msg) {
    if (typeof window.showToast === "function") window.showToast(msg);
    else console.log("[local-deploy]", msg);
  }
  function esc(str) {
    if (!str) return "";
    return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "");
  }
  // 探测本地服务：APK 内走原生壳（无 CORS 限制），网页版降级 fetch
  function probeUrl(url) {
    return new Promise(function (resolve) {
      if (window.AndroidMCP && typeof window.AndroidMCP.sendNativeHttpRequest === "function") {
        try {
          var resObj = JSON.parse(window.AndroidMCP.sendNativeHttpRequest(url, "GET", "{}", ""));
          var st = Number(resObj.status) || 0;
          resolve({ ok: st >= 200 && st < 400, status: st });
          return;
        } catch (e) {
          resolve({ ok: false, status: 0 });
          return;
        }
      }
      fetch(url, { method: "GET", cache: "no-store" })
        .then(function (res) { resolve({ ok: res.ok, status: res.status }); })
        .catch(function () { resolve({ ok: false, status: 0 }); });
    });
  }
  // 复制：clipboard API -> 隐藏 textarea + execCommand 兜底
  function copyText(text, onDone) {
    var done = function (ok) {
      if (typeof onDone === "function") onDone(ok);
      if (typeof window.showToast === "function") window.showToast(ok ? "已复制到剪贴板" : "复制失败，请长按选中文本手动复制");
    };
    if (!text) { done(false); return; }
    var fallbackCopy = function () {
      try {
        var ta = document.createElement("textarea");
        ta.value = text;
        ta.setAttribute("readonly", "");
        ta.style.position = "fixed";
        ta.style.left = "-9999px";
        ta.style.top = "0";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        var sel = window.getSelection();
        sel.removeAllRanges();
        var range = document.createRange();
        range.selectNodeContents(ta);
        sel.addRange(range);
        ta.setSelectionRange(0, text.length);
        ta.focus();
        var ok = false;
        try { ok = document.execCommand("copy"); } catch (e2) { ok = false; }
        document.body.removeChild(ta);
        done(ok);
      } catch (e) { done(false); }
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { done(true); }).catch(function () { fallbackCopy(); });
    } else {
      fallbackCopy();
    }
  }

  var BUILTIN_SCRIPTS = [
    { id: "ncm-api", name: "网易云音乐 API", desc: "网易云登录代理 / 歌单同步 / 歌词搜索（端口 3000）", port: 3000, healthUrl: "http://localhost:3000/search?keywords=test&limit=1", termuxCmd: "NeteaseCloudMusicApi -p 3000", status: "unknown" },
    { id: "cors-proxy", name: "CORS 跨域中转", desc: "为 PWA/网页版打破跨域限制，代理任意 HTTP/HTTPS 请求（端口 3001）", port: 3001, healthUrl: "http://localhost:3001/health", termuxCmd: "node $HOME/.xvshishi/cors-proxy.js", status: "unknown" }
  ];
  function loadScripts() {
    try { var raw = localStorage.getItem("local-deploy-scripts"); if (raw) return JSON.parse(raw); } catch (e) {}
    return JSON.parse(JSON.stringify(BUILTIN_SCRIPTS));
  }
  function saveScripts(list) { localStorage.setItem("local-deploy-scripts", JSON.stringify(list)); }

  var localDeploySystem = {
    _confirmOkAction: null,

    // ============ 面板 HTML ============
    getPanelHTML: function () {
      return `
        <div id="settings-lv2-local-deploy" class="settings-lv2-panel" style="display:none;">
          <div class="local-deploy-intro-card">
            <div class="local-deploy-intro-title">本地部署中心</div>
            <div class="local-deploy-intro-desc">
              通过 Termux 在手机上运行本地脚本服务（如网易云 API），App 通过 localhost 访问。
              每个脚本可独立启停并实时监测。Termux 侧请使用仓库 termux/ 目录的服务管理器（xvshishi-services.sh）统一管理。
            </div>
          </div>
          <div id="local-deploy-termux-status" class="local-deploy-termux-status">检测 Termux 环境…</div>
          <div class="form-actions" style="margin-bottom:14px;">
            <button id="btn-local-deploy-guide" class="btn btn-outline" style="flex:1;">部署引导（命令可一键复制）</button>
          </div>
          <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:8px;">
            <span style="font-size:13px; font-weight:800; color:var(--text-primary);">我的脚本</span>
            <button id="btn-local-deploy-add" class="btn btn-primary" style="padding:6px 12px; font-size:11px;">＋ 新增脚本</button>
          </div>
          <div id="local-deploy-scripts-list"></div>

          <div id="local-deploy-guide-overlay" style="display:none; position:fixed; top:0; left:0; right:0; bottom:0; background:rgba(15,23,42,0.5); z-index:300; align-items:center; justify-content:center; padding:20px;">
            <div style="background:var(--bg-main); border-radius:18px; max-width:340px; width:100%; max-height:85vh; overflow-y:auto; padding:18px;">
              <div style="font-size:15px; font-weight:800; color:var(--text-primary); margin-bottom:12px;">Termux 部署引导</div>
              <div id="local-deploy-guide-body" style="font-size:12px; line-height:1.8; color:var(--text-secondary);"></div>
              <div class="form-actions" style="margin-top:14px;">
                <button id="btn-local-deploy-guide-close" class="btn btn-primary" style="width:100%;">我明白了</button>
              </div>
            </div>
          </div>

          <div id="local-deploy-add-overlay" style="display:none; position:fixed; top:0; left:0; right:0; bottom:0; background:rgba(15,23,42,0.5); z-index:310; align-items:center; justify-content:center; padding:20px;">
            <div style="background:var(--bg-main); border-radius:18px; max-width:340px; width:100%; max-height:88vh; overflow-y:auto; padding:18px;">
              <div style="font-size:15px; font-weight:800; color:var(--text-primary); margin-bottom:12px;">新增本地脚本</div>
              <div style="display:flex; flex-direction:column; gap:10px;">
                <div><label style="font-size:11px; font-weight:700; color:var(--text-secondary); display:block; margin-bottom:4px;">脚本名称</label><input type="text" id="ld-add-name" placeholder="例如：我的本地代理" style="width:100%; height:34px; font-size:12px; border:1px solid #e2e8f0; border-radius:8px; padding:0 10px; box-sizing:border-box; background:var(--surface); color:var(--text-primary);"></div>
                <div><label style="font-size:11px; font-weight:700; color:var(--text-secondary); display:block; margin-bottom:4px;">服务端口</label><input type="number" id="ld-add-port" placeholder="3000" value="3000" style="width:100%; height:34px; font-size:12px; border:1px solid #e2e8f0; border-radius:8px; padding:0 10px; box-sizing:border-box; background:var(--surface); color:var(--text-primary);"></div>
                <div><label style="font-size:11px; font-weight:700; color:var(--text-secondary); display:block; margin-bottom:4px;">健康检查地址</label><input type="text" id="ld-add-health" placeholder="http://localhost:3000/health" style="width:100%; height:34px; font-size:12px; border:1px solid #e2e8f0; border-radius:8px; padding:0 10px; box-sizing:border-box; background:var(--surface); color:var(--text-primary);"></div>
                <div><label style="font-size:11px; font-weight:700; color:var(--text-secondary); display:block; margin-bottom:4px;">Termux 启动命令</label><input type="text" id="ld-add-cmd" placeholder="例如：node start.js" style="width:100%; height:34px; font-size:12px; border:1px solid #e2e8f0; border-radius:8px; padding:0 10px; box-sizing:border-box; background:var(--surface); color:var(--text-primary);"></div>
              </div>
              <div class="form-actions" style="margin-top:14px; display:flex; gap:8px;">
                <button id="btn-local-deploy-add-cancel" class="btn btn-outline" style="flex:1;">取消</button>
                <button id="btn-local-deploy-add-save" class="btn btn-primary" style="flex:1;">保存</button>
              </div>
            </div>
          </div>

          <div id="local-deploy-confirm-overlay" style="display:none; position:fixed; top:0; left:0; right:0; bottom:0; background:rgba(15,23,42,0.5); z-index:320; align-items:center; justify-content:center; padding:20px;">
            <div style="background:var(--bg-main); border-radius:18px; max-width:300px; width:100%; padding:18px;">
              <div id="local-deploy-confirm-title" style="font-size:14px; font-weight:800; color:var(--text-primary); margin-bottom:8px;">确认</div>
              <div id="local-deploy-confirm-message" style="font-size:12px; line-height:1.7; color:var(--text-secondary); margin-bottom:14px;"></div>
              <div style="display:flex; gap:8px;">
                <button id="btn-local-deploy-confirm-cancel" class="btn btn-outline" style="flex:1;">取消</button>
                <button id="btn-local-deploy-confirm-ok" class="btn btn-danger" style="flex:1;">确定</button>
              </div>
            </div>
          </div>
        </div>
      `;
    },

    // ============ 初始化 ============
    initPanel: function () {
      var self = this;
      var btnGuide = document.getElementById("btn-local-deploy-guide");
      var btnAdd = document.getElementById("btn-local-deploy-add");
      if (btnGuide) btnGuide.onclick = function () { self.showGuide(); };
      if (btnAdd) btnAdd.onclick = function () { self.openAddScriptModal(); };
      var btnClose = document.getElementById("btn-local-deploy-guide-close");
      if (btnClose) btnClose.onclick = function () { self.hideGuide(); };
      var btnAddCancel = document.getElementById("btn-local-deploy-add-cancel");
      if (btnAddCancel) btnAddCancel.onclick = function () { self.closeAddScriptModal(); };
      var btnAddSave = document.getElementById("btn-local-deploy-add-save");
      if (btnAddSave) btnAddSave.onclick = function () { self.saveAddScriptModal(); };
      var btnConfirmCancel = document.getElementById("btn-local-deploy-confirm-cancel");
      if (btnConfirmCancel) btnConfirmCancel.onclick = function () { self.closeConfirmModal(); };
      var btnConfirmOk = document.getElementById("btn-local-deploy-confirm-ok");
      if (btnConfirmOk) btnConfirmOk.onclick = function () { if (self._confirmOkAction) self._confirmOkAction(); self.closeConfirmModal(); };
      this.checkTermux();
      this.renderScripts();
    },

    // ============ Termux 环境检测（真实探测本地服务） ============
    checkTermux: function () {
      var el = document.getElementById("local-deploy-termux-status");
      if (!el) return;
      el.innerHTML = "正在探测 Termux 本地服务…";
      Promise.all([
        probeUrl("http://localhost:3000/search?keywords=test&limit=1"),
        probeUrl("http://localhost:3001/health")
      ]).then(function (results) {
        var ncmOk = results[0] && results[0].ok;
        var corsOk = results[1] && results[1].ok;
        if (ncmOk || corsOk) {
          var detail = [];
          if (ncmOk) detail.push("网易云 API:3000");
          if (corsOk) detail.push("CORS 中转:3001");
          el.innerHTML = "Termux 环境：<b style='color:#16a34a;'>已就绪</b>（" + detail.join(" / ") + " 在线）";
          el.style.borderColor = "#bbf7d0";
          el.style.background = "#f0fdf4";
        } else {
          el.innerHTML = "Termux 环境：<b style='color:#dc2626;'>未检测到本地服务</b>。请先在 Termux 中执行部署脚本（见下方引导），并保持 Termux 运行。";
          el.style.borderColor = "#fecaca";
          el.style.background = "#fef2f2";
        }
      });
    },

    // ============ 通用确认弹窗（替代 confirm） ============
    showConfirmModal: function (title, message, onOk) {
      var overlay = document.getElementById("local-deploy-confirm-overlay");
      if (!overlay) return;
      var titleEl = document.getElementById("local-deploy-confirm-title");
      var msgEl = document.getElementById("local-deploy-confirm-message");
      if (titleEl) titleEl.innerText = title || "确认";
      if (msgEl) msgEl.innerText = message || "";
      this._confirmOkAction = onOk || null;
      overlay.style.display = "flex";
    },
    closeConfirmModal: function () {
      var overlay = document.getElementById("local-deploy-confirm-overlay");
      if (overlay) overlay.style.display = "none";
      this._confirmOkAction = null;
    },

    // ============ 新增脚本（应用内卡片，替代 prompt） ============
    openAddScriptModal: function () {
      var overlay = document.getElementById("local-deploy-add-overlay");
      if (!overlay) return;
      document.getElementById("ld-add-name").value = "";
      document.getElementById("ld-add-port").value = "3000";
      document.getElementById("ld-add-health").value = "";
      document.getElementById("ld-add-cmd").value = "";
      overlay.style.display = "flex";
    },
    closeAddScriptModal: function () {
      var overlay = document.getElementById("local-deploy-add-overlay");
      if (overlay) overlay.style.display = "none";
    },
    saveAddScriptModal: function () {
      var name = (document.getElementById("ld-add-name").value || "").trim();
      var port = (document.getElementById("ld-add-port").value || "").trim();
      var health = (document.getElementById("ld-add-health").value || "").trim();
      var cmd = (document.getElementById("ld-add-cmd").value || "").trim();
      if (!name) { showToastSafe("请输入脚本名称"); return; }
      if (!cmd) { showToastSafe("请输入 Termux 启动命令"); return; }
      if (!health) health = "http://localhost:" + (port || "3000") + "/health";
      var scripts = loadScripts();
      scripts.push({
        id: "script-" + Date.now(),
        name: name,
        desc: "自定义本地脚本",
        port: Number(port) || 3000,
        healthUrl: health,
        termuxCmd: cmd,
        status: "unknown"
      });
      saveScripts(scripts);
      this.closeAddScriptModal();
      this.renderScripts();
      showToastSafe("脚本已添加");
    },

    // ============ 渲染脚本卡片 ============
    renderScripts: function () {
      var listEl = document.getElementById("local-deploy-scripts-list");
      if (!listEl) return;
      var scripts = loadScripts();
      if (scripts.length === 0) {
        listEl.innerHTML = '<div style="padding:16px; text-align:center; color:var(--text-secondary); font-size:12px;">还没有脚本，点击上方「新增脚本」添加。</div>';
        return;
      }
      listEl.innerHTML = scripts.map(function (s, idx) { return localDeploySystem._renderCard(s, idx); }).join("");
      scripts.forEach(function (s, idx) {
        var startBtn = document.getElementById("ld-start-" + idx);
        var stopBtn = document.getElementById("ld-stop-" + idx);
        var healthBtn = document.getElementById("ld-health-" + idx);
        var delBtn = document.getElementById("ld-del-" + idx);
        if (startBtn) startBtn.onclick = function () { localDeploySystem.startScript(idx); };
        if (stopBtn) stopBtn.onclick = function () { localDeploySystem.stopScript(idx); };
        if (healthBtn) healthBtn.onclick = function () { localDeploySystem.checkHealth(idx); };
        if (delBtn) delBtn.onclick = function () { localDeploySystem.deleteScript(idx); };
      });
      this.checkAllHealth();
    },

    _renderCard: function (s, idx) {
      var statusMap = {
        running: "<b style='color:#16a34a;'>运行中</b>",
        stopped: "<b style='color:#64748b;'>已停止</b>",
        unknown: "<b style='color:#ca8a04;'>未知</b>",
        error: "<b style='color:#dc2626;'>异常</b>"
      };
      var statusText = statusMap[s.status] || statusMap.unknown;
      return '' +
        '<div class="local-deploy-card" id="ld-card-' + idx + '">' +
          '<div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:6px;">' +
            '<div style="font-size:13px; font-weight:800; color:var(--text-primary);">' + esc(s.name) + '</div>' +
            '<span id="ld-status-' + idx + '">' + statusText + '</span>' +
          '</div>' +
          '<div style="font-size:11px; color:var(--text-secondary); line-height:1.6; margin-bottom:8px;">' + esc(s.desc) + '</div>' +
          '<div style="font-size:10px; color:var(--text-secondary); margin-bottom:8px; word-break:break-all;">' +
            '<b>地址：</b>' + esc(s.healthUrl || ("http://localhost:" + (s.port || "3000"))) +
          '</div>' +
          '<div style="display:flex; gap:6px; flex-wrap:wrap;">' +
            '<button id="ld-start-' + idx + '" class="btn btn-primary" style="flex:1; padding:6px 0; font-size:11px;">启动</button>' +
            '<button id="ld-stop-' + idx + '" class="btn btn-outline" style="flex:1; padding:6px 0; font-size:11px;">停止</button>' +
            '<button id="ld-health-' + idx + '" class="btn btn-outline" style="flex:1; padding:6px 0; font-size:11px;">检测</button>' +
            '<button id="ld-del-' + idx + '" class="btn btn-danger-outline" style="padding:6px 10px; font-size:11px;">删除</button>' +
          '</div>' +
        '</div>';
    },

    // ============ 删除脚本（应用内确认，替代 confirm） ============
    deleteScript: function (idx) {
      var scripts = loadScripts();
      var s = scripts[idx];
      if (!s) return;
      var self = this;
      this.showConfirmModal("删除脚本", "确定删除脚本「" + s.name + "」吗？", function () {
        scripts.splice(idx, 1);
        saveScripts(scripts);
        self.renderScripts();
        showToastSafe("脚本已删除");
      });
    },

    // ============ 独立启停 ============
    startScript: function (idx) {
      var scripts = loadScripts();
      var s = scripts[idx];
      if (!s) return;
      showToastSafe("正在启动「" + s.name + "」…");
      var ok = false;
      if (window.AndroidMCP && typeof window.AndroidMCP.runTermuxCommand === "function") {
        try { ok = window.AndroidMCP.runTermuxCommand(s.termuxCmd) === true; } catch (e) {}
      }
      if (ok) {
        s.status = "running";
      } else {
        this.showTermuxCommandHint(s);
        s.status = "unknown";
      }
      saveScripts(scripts);
      this.renderScripts();
    },

    stopScript: function (idx) {
      var scripts = loadScripts();
      var s = scripts[idx];
      if (!s) return;
      showToastSafe("正在停止「" + s.name + "」…");
      var ok = false;
      if (window.AndroidMCP && typeof window.AndroidMCP.stopTermuxCommand === "function") {
        try { ok = window.AndroidMCP.stopTermuxCommand(s.termuxCmd) === true; } catch (e) {}
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
      var scripts = loadScripts();
      var s = scripts[idx];
      if (!s) return;
      var url = s.healthUrl || ("http://localhost:" + (s.port || "3000") + "/health");
      var self = this;
      probeUrl(url).then(function (result) {
        s.status = result.ok ? "running" : "stopped";
        saveScripts(scripts);
        self.renderScripts();
        showToastSafe(result.ok ? "「" + s.name + "」运行正常" : "「" + s.name + "」未运行");
      });
    },

    checkAllHealth: function () {
      var scripts = loadScripts();
      scripts.forEach(function (s, idx) {
        var url = s.healthUrl || ("http://localhost:" + (s.port || "3000") + "/health");
        probeUrl(url).then(function (result) {
          s.status = result.ok ? "running" : "stopped";
          var color = result.ok ? "#16a34a" : "#64748b";
          var text = result.ok ? "运行中" : "已停止";
          var el = document.getElementById("ld-status-" + idx);
          if (el) el.innerHTML = "<b style='color:" + color + ";'>" + text + "</b>";
        });
      });
    },

    // ============ Termux 命令提示 ============
    showTermuxCommandHint: function (s) {
      var cmd = s.termuxCmd || "";
      if (typeof window.showCustomConfirm === "function") {
        window.showCustomConfirm("在 Termux 中运行", "请打开 Termux，执行以下命令启动「" + s.name + "」：\n\n" + cmd + "\n\n保持 Termux 在前台或后台运行即可。", function () {});
      } else {
        alert("请在 Termux 中执行:\n\n" + cmd);
      }
    },

    // ============ 部署引导（命令一键复制） ============
    showGuide: function () {
      var overlay = document.getElementById("local-deploy-guide-overlay");
      var body = document.getElementById("local-deploy-guide-body");
      if (!overlay || !body) return;

      var steps = [
        { title: "第 1 步：安装 Termux", desc: "用 F-Droid 安装（Play 版已停更）：", cmd: "https://f-droid.org/packages/com.termux/" },
        { title: "第 2 步：一键部署", desc: "复制下面这条命令到 Termux 执行（自动下载脚本 + 装依赖 + 建数据目录 + 进服务管理器）：", cmd: "curl -L https://raw.githubusercontent.com/wenqv4617-art/Xvshishiapk/main/termux-ncm-api.sh -o ~/termux-ncm-api.sh && bash ~/termux-ncm-api.sh" },
        { title: "第 3 步：启动网易云 API", desc: "在服务管理器菜单按 [1] 启动全部；或单独执行：", cmd: "bash $HOME/.xvshishi/xvshishi-services.sh start ncm-api" },
        { title: "第 4 步：启动 CORS 中转（网页版需要）", desc: "", cmd: "bash $HOME/.xvshishi/xvshishi-services.sh start cors-proxy" },
        { title: "第 5 步：保活", desc: "安装 termux-api 并开启保活：", cmd: "pkg install termux-api && termux-wake-lock" },
        { title: "第 6 步：回到 App 使用", desc: "网易云登录弹窗的 API 地址填：", cmd: "http://localhost:3000" }
      ];

      var html = '<div style="margin-bottom:12px;">' +
        '<button class="btn btn-primary" style="width:100%;padding:10px 0;font-size:12px;" id="btn-copy-all-cmds">＋ 一键复制全部命令</button></div>';

      steps.forEach(function (step, i) {
        html += '<div style="margin-bottom:12px;">';
        html += '<b style="color:var(--text-primary);">' + step.title + '</b><br>';
        if (step.desc) html += '<span style="color:var(--text-secondary);">' + step.desc + '</span><br>';
        if (step.cmd) {
          html += '<code class="ld-cmd" data-idx="' + i + '" style="background:rgba(0,0,0,0.06);padding:6px 8px;border-radius:6px;display:inline-block;max-width:100%;overflow-x:auto;word-break:break-all;cursor:pointer;color:var(--text-primary);">' + step.cmd + '</code>';
          html += '<span class="ld-copy-tag" data-idx="' + i + '" style="font-size:10px;color:#16a34a;margin-left:8px;cursor:pointer;display:inline-block;user-select:none;">复制</span>';
        }
        html += '</div>';
      });

      body.innerHTML = html;

      body.querySelectorAll(".ld-cmd, .ld-copy-tag").forEach(function (el) {
        el.onclick = function () {
          var i = Number(el.getAttribute("data-idx"));
          copyText(steps[i].cmd);
        };
      });

      var btnAll = document.getElementById("btn-copy-all-cmds");
      if (btnAll) {
        btnAll.onclick = function () {
          copyText(steps.map(function (s) { return s.cmd; }).filter(Boolean).join("\n\n"));
        };
      }

      overlay.style.display = "flex";
    },

    hideGuide: function () {
      var overlay = document.getElementById("local-deploy-guide-overlay");
      if (overlay) overlay.style.display = "none";
    }
  };

  window.localDeploySystem = localDeploySystem;
})();
