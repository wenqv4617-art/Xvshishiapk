/**
 * app_local_deploy.js - 本地部署中心（Termux 脚本管理）
 * 内置网易云 API(3000) + CORS 跨域中转(3001)；
 * 部署引导命令内置全部脚本内容（heredoc 直接在 Termux 创建文件，无需联网下载）；
 * 每个脚本提供「查看 / 编辑 / 删除」，查看可展开面板显示详情与脚本源码。
 *
 * ⚠️ 本文件由 scripts/sync-embedded-assets.js 生成：
 *    - 修改 termux/cors-proxy.js 或 termux/xvshishi-services.sh 后，运行
 *      node scripts/sync-embedded-assets.js 重新生成本文件；
 *    - 只允许编辑 scripts/app_local_deploy.template.js（文件内两处内嵌常量占位符
 *      会被自动替换为 termux/ 目录下的脚本内容）。
 */
(function () {
  "use strict";

  function showToastSafe(msg) {
    if (typeof window.showToast === "function") window.showToast(msg);
    else console.log("[local-deploy]", msg);
  }
  function esc(str) {
    if (!str) return "";
    return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
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

  // ============ 内置脚本文件内容（由 scripts/sync-embedded-assets.js 同步，勿手改）============
  var CORS_PROXY_SOURCE = `__CORS_PROXY_SOURCE__`;
  var SERVICES_MANAGER_SOURCE = `__SERVICES_MANAGER_SOURCE__`;
  var XSHISHI_LAUNCHER_SOURCE = `__XSHISHI_LAUNCHER_SOURCE__`;

  var BUILTIN_SCRIPTS = [
    { id: "ncm-api", name: "网易云音乐 API", desc: "网易云登录代理 / 歌单同步 / 歌词搜索（端口 3000）", port: 3000, healthUrl: "http://localhost:3000/search?keywords=test&limit=1", termuxCmd: "NeteaseCloudMusicApi -p 3000", fileContent: "", isBuiltin: true },
    { id: "cors-proxy", name: "CORS 跨域中转", desc: "为 PWA/网页版打破跨域限制，代理任意 HTTP/HTTPS 请求（端口 3001）", port: 3001, healthUrl: "http://localhost:3001/health", termuxCmd: "node $HOME/.xvshishi/cors-proxy.js", fileContent: CORS_PROXY_SOURCE, isBuiltin: true }
  ];

  // 合并内置脚本：内置脚本始终存在（旧版 localStorage 里没有 cors-proxy 也会自动补上），
  // 用户对内置脚本的编辑会覆盖对应字段
  function loadScripts() {
    var saved = [];
    try { var raw = localStorage.getItem("local-deploy-scripts"); if (raw) saved = JSON.parse(raw) || []; } catch (e) {}
    if (!Array.isArray(saved)) saved = [];
    var byId = {};
    saved.forEach(function (s) { if (s && s.id) byId[s.id] = s; });
    var merged = BUILTIN_SCRIPTS.map(function (b) {
      var s = byId[b.id];
      return s ? Object.assign({}, b, s) : JSON.parse(JSON.stringify(b));
    });
    saved.forEach(function (s) {
      if (!s || !s.id) return;
      var isBuiltin = BUILTIN_SCRIPTS.some(function (b) { return b.id === s.id; });
      if (!isBuiltin) merged.push(s);
    });
    return merged;
  }
  // 落盘时精简：内置脚本不重复存 fileContent / isBuiltin（下次加载自动补齐）
  function saveScripts(list) {
    var slim = list.map(function (s) {
      var copy = Object.assign({}, s);
      if (copy.isBuiltin) { delete copy.fileContent; delete copy.isBuiltin; }
      return copy;
    });
    localStorage.setItem("local-deploy-scripts", JSON.stringify(slim));
  }

  var localDeploySystem = {
    _confirmOkAction: null,
    _editingIndex: null,

    // ============ 面板 HTML ============
    getPanelHTML: function () {
      return `
        <div id="settings-lv2-local-deploy" class="settings-lv2-panel" style="display:none;">
          <div class="local-deploy-intro-card">
            <div class="local-deploy-intro-title">本地部署中心</div>
            <div class="local-deploy-intro-desc">
              通过 Termux 在手机上运行本地脚本服务（网易云 API / CORS 跨域中转），App 通过 localhost 访问。
              部署引导命令已内置全部脚本内容，复制到 Termux 执行即可直接创建脚本文件，无需联网下载。
            </div>
          </div>
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
              <div id="ld-modal-title" style="font-size:15px; font-weight:800; color:var(--text-primary); margin-bottom:12px;">新增本地脚本</div>
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
      if (btnAdd) btnAdd.onclick = function () { self.openScriptModal("add"); };
      var btnClose = document.getElementById("btn-local-deploy-guide-close");
      if (btnClose) btnClose.onclick = function () { self.hideGuide(); };
      var btnAddCancel = document.getElementById("btn-local-deploy-add-cancel");
      if (btnAddCancel) btnAddCancel.onclick = function () { self.closeScriptModal(); };
      var btnAddSave = document.getElementById("btn-local-deploy-add-save");
      if (btnAddSave) btnAddSave.onclick = function () { self.saveScriptModal(); };
      var btnConfirmCancel = document.getElementById("btn-local-deploy-confirm-cancel");
      if (btnConfirmCancel) btnConfirmCancel.onclick = function () { self.closeConfirmModal(); };
      var btnConfirmOk = document.getElementById("btn-local-deploy-confirm-ok");
      if (btnConfirmOk) btnConfirmOk.onclick = function () { if (self._confirmOkAction) self._confirmOkAction(); self.closeConfirmModal(); };
      this.renderScripts();
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

    // ============ 新增 / 编辑脚本（应用内卡片，替代 prompt） ============
    openScriptModal: function (mode, idx) {
      var overlay = document.getElementById("local-deploy-add-overlay");
      if (!overlay) return;
      var isEdit = mode === "edit";
      var titleEl = document.getElementById("ld-modal-title");
      if (titleEl) titleEl.innerText = isEdit ? "编辑本地脚本" : "新增本地脚本";
      var s = null;
      if (isEdit) {
        var scripts = loadScripts();
        s = scripts[idx] || null;
      }
      document.getElementById("ld-add-name").value = s ? (s.name || "") : "";
      document.getElementById("ld-add-port").value = s ? String(s.port || "") : "3000";
      document.getElementById("ld-add-health").value = s ? (s.healthUrl || "") : "";
      document.getElementById("ld-add-cmd").value = s ? (s.termuxCmd || "") : "";
      this._editingIndex = isEdit && s ? idx : null;
      overlay.style.display = "flex";
    },
    closeScriptModal: function () {
      var overlay = document.getElementById("local-deploy-add-overlay");
      if (overlay) overlay.style.display = "none";
      this._editingIndex = null;
    },
    saveScriptModal: function () {
      var name = (document.getElementById("ld-add-name").value || "").trim();
      var port = (document.getElementById("ld-add-port").value || "").trim();
      var health = (document.getElementById("ld-add-health").value || "").trim();
      var cmd = (document.getElementById("ld-add-cmd").value || "").trim();
      if (!name) { showToastSafe("请输入脚本名称"); return; }
      if (!cmd) { showToastSafe("请输入 Termux 启动命令"); return; }
      if (!health) health = "http://localhost:" + (port || "3000") + "/health";
      var scripts = loadScripts();
      if (this._editingIndex !== null && scripts[this._editingIndex]) {
        var s = scripts[this._editingIndex];
        s.name = name;
        s.port = Number(port) || 3000;
        s.healthUrl = health;
        s.termuxCmd = cmd;
      } else {
        scripts.push({
          id: "script-" + Date.now(),
          name: name,
          desc: "自定义本地脚本",
          port: Number(port) || 3000,
          healthUrl: health,
          termuxCmd: cmd,
          isBuiltin: false
        });
      }
      saveScripts(scripts);
      this.closeScriptModal();
      this.renderScripts();
      showToastSafe("已保存");
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
        var viewBtn = document.getElementById("ld-view-" + idx);
        var editBtn = document.getElementById("ld-edit-" + idx);
        var delBtn = document.getElementById("ld-del-" + idx);
        if (viewBtn) viewBtn.onclick = function () { localDeploySystem.toggleDetail(idx); };
        if (editBtn) editBtn.onclick = function () { localDeploySystem.openScriptModal("edit", idx); };
        if (delBtn) delBtn.onclick = function () { localDeploySystem.deleteScript(idx); };
      });
    },

    _renderCard: function (s, idx) {
      var isBuiltin = !!s.isBuiltin;
      var addr = s.healthUrl || ("http://localhost:" + (s.port || "3000"));
      return '' +
        '<div class="local-deploy-card" id="ld-card-' + idx + '">' +
          '<div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:6px;">' +
            '<div style="font-size:13px; font-weight:800; color:var(--text-primary);">' + esc(s.name) + '</div>' +
            '<span style="font-size:10px; font-weight:700; color:' + (isBuiltin ? "#6366f1" : "#64748b") + ';">' + (isBuiltin ? "内置" : "自定义") + '</span>' +
          '</div>' +
          '<div style="font-size:11px; color:var(--text-secondary); line-height:1.6; margin-bottom:8px;">' + esc(s.desc) + '</div>' +
          '<div style="font-size:10px; color:var(--text-secondary); margin-bottom:8px; word-break:break-all;">' +
            '<b>地址：</b>' + esc(addr) +
          '</div>' +
          '<div style="display:flex; gap:6px; flex-wrap:wrap;">' +
            '<button id="ld-view-' + idx + '" class="btn btn-outline" style="flex:1; padding:6px 0; font-size:11px;">查看</button>' +
            '<button id="ld-edit-' + idx + '" class="btn btn-outline" style="flex:1; padding:6px 0; font-size:11px;">编辑</button>' +
            (isBuiltin ? '' : '<button id="ld-del-' + idx + '" class="btn btn-danger-outline" style="flex:1; padding:6px 0; font-size:11px;">删除</button>') +
          '</div>' +
          '<div id="ld-detail-' + idx + '" class="local-deploy-detail" style="display:none;">' +
            '<div class="ld-detail-row"><b>服务端口：</b>' + esc(String(s.port || "-")) + '</div>' +
            '<div class="ld-detail-row"><b>健康检查地址：</b><span style="word-break:break-all;">' + esc(addr) + '</span></div>' +
            '<div class="ld-detail-row"><b>Termux 启动命令：</b></div>' +
            '<pre class="ld-code">' + esc(s.termuxCmd || "") + '</pre>' +
            (s.fileContent
              ? '<div class="ld-detail-row"><b>脚本文件内容（与仓库 termux/ 目录保持一致）：</b></div><pre class="ld-code">' + esc(s.fileContent) + '</pre>'
              : '') +
          '</div>' +
        '</div>';
    },

    // ============ 查看：展开/收起详情面板 ============
    toggleDetail: function (idx) {
      var el = document.getElementById("ld-detail-" + idx);
      if (!el) return;
      var expanded = el.style.display === "block";
      el.style.display = expanded ? "none" : "block";
      var btn = document.getElementById("ld-view-" + idx);
      if (btn) btn.innerText = expanded ? "查看" : "收起";
    },

    // ============ 删除脚本（应用内确认，替代 confirm） ============
    deleteScript: function (idx) {
      var scripts = loadScripts();
      var s = scripts[idx];
      if (!s) return;
      if (s.isBuiltin) { showToastSafe("内置脚本不可删除"); return; }
      var self = this;
      this.showConfirmModal("删除脚本", "确定删除脚本「" + s.name + "」吗？", function () {
        var saved = [];
        try { saved = JSON.parse(localStorage.getItem("local-deploy-scripts")) || []; } catch (e) {}
        if (!Array.isArray(saved)) saved = [];
        saved = saved.filter(function (x) { return !x || x.id !== s.id; });
        localStorage.setItem("local-deploy-scripts", JSON.stringify(saved));
        self.renderScripts();
        showToastSafe("脚本已删除");
      });
    },

    // ============ 部署引导（命令内置脚本内容，heredoc 直接创建文件） ============
    buildDeployCommand: function () {
      var L = [];
      L.push("mkdir -p ~/.xvshishi/data ~/.xvshishi/status ~/.xvshishi/logs ~/.xvshishi/pids");
      L.push("cat > ~/.xvshishi/cors-proxy.js <<'XSH_EOF'");
      L.push(CORS_PROXY_SOURCE.replace(/\n$/, ""));
      L.push("XSH_EOF");
      L.push("cat > ~/.xvshishi/xvshishi-services.sh <<'XSH_EOF'");
      L.push(SERVICES_MANAGER_SOURCE.replace(/\n$/, ""));
      L.push("XSH_EOF");
      L.push("mkdir -p $PREFIX/bin");
      L.push("cat > $PREFIX/bin/xvshishi <<'XSH_EOF'");
      L.push(XSHISHI_LAUNCHER_SOURCE.replace(/\n$/, ""));
      L.push("XSH_EOF");
      L.push("chmod +x $PREFIX/bin/xvshishi");
      L.push("chmod +x ~/.xvshishi/xvshishi-services.sh");
      L.push("pkg update -y");
      L.push("pkg install -y nodejs-lts");
      L.push("npm install -g NeteaseCloudMusicApi --registry=https://registry.npmmirror.com");
      L.push("bash ~/.xvshishi/xvshishi-services.sh tui");
      return L.join("\n");
    },

    showGuide: function () {
      var overlay = document.getElementById("local-deploy-guide-overlay");
      var body = document.getElementById("local-deploy-guide-body");
      if (!overlay || !body) return;

      var steps = [
        { title: "第 1 步：安装 Termux", desc: "务必用 F-Droid 版（Play 版已停更）：https://f-droid.org/packages/com.termux/", cmd: "" },
        { title: "第 2 步：一键部署", desc: "复制下面整条命令到 Termux 执行。命令已内置全部脚本内容，会自动创建 CORS 中转脚本、服务管理器与唤出命令 xvshishi，并安装依赖、进入服务管理器，全程无需联网下载：", cmd: this.buildDeployCommand() },
        { title: "第 3 步：启动服务", desc: "在服务管理器菜单按 [1] 启动全部；或分别执行：", cmd: "bash $HOME/.xvshishi/xvshishi-services.sh start ncm-api\nbash $HOME/.xvshishi/xvshishi-services.sh start cors-proxy" },
        { title: "第 4 步：随时唤出脚本页面", desc: "退出 Termux 后再进入时，直接输入下面的命令即可再次进入脚本交互页面：", cmd: "xvshishi" },
        { title: "第 5 步：保活", desc: "安装 termux-api 并开启保活：", cmd: "pkg install termux-api && termux-wake-lock" },
        { title: "第 6 步：回到 App 使用", desc: "网易云登录弹窗的 API 地址填（网页版跨域中转为 3001 端口）：", cmd: "http://localhost:3000" }
      ];

      var html = '<div style="margin-bottom:12px;">' +
        '<button class="btn btn-primary" style="width:100%;padding:10px 0;font-size:12px;" id="btn-copy-all-cmds">＋ 一键复制全部命令</button></div>';

      steps.forEach(function (step, i) {
        html += '<div style="margin-bottom:12px;">';
        html += '<b style="color:var(--text-primary);">' + step.title + '</b><br>';
        if (step.desc) html += '<span style="color:var(--text-secondary);">' + step.desc + '</span><br>';
        if (step.cmd) {
          var isMulti = step.cmd.indexOf("\n") >= 0;
          if (isMulti) {
            html += '<pre class="ld-cmd ld-cmd-multi" data-idx="' + i + '">' + esc(step.cmd) + '</pre>';
          } else {
            html += '<code class="ld-cmd" data-idx="' + i + '" style="background:rgba(0,0,0,0.06);padding:6px 8px;border-radius:6px;display:inline-block;max-width:100%;overflow-x:auto;word-break:break-all;cursor:pointer;color:var(--text-primary);">' + esc(step.cmd) + '</code>';
          }
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
