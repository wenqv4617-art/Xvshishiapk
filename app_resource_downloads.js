/**
 * app_resource_downloads.js - 设置中的资源下载中心
 *
 * 目标：
 * 1. 将体积较大的可选资源从默认构建链路中移除；
 * 2. 在设置中提供统一的“资源下载”入口，用户主动下载安装；
 * 3. 第一张卡片先承载本地 Node.js 服务资源（预留脚本说明与未来原生下载接入）。
 */
(function () {
  "use strict";

  function showToastSafe(msg) {
    if (typeof window.showToast === "function") window.showToast(msg);
    else console.log("[resource-downloads]", msg);
  }

  function isAndroidBridgeReady() {
    return !!(window.AndroidMCP && typeof window.AndroidMCP === "object");
  }

  const resourceDownloadSystem = {
    getPanelHTML: function () {
      return `
        <div id="settings-lv2-resource-downloads" class="settings-lv2-panel" style="display:none;">
          <div class="resource-downloads-intro-card">
            <div class="resource-downloads-intro-title">资源下载</div>
            <div class="resource-downloads-intro-desc">
              这里集中管理体积较大的可选资源。默认不随 APK 强制拉取，按需下载即可，避免构建失败，也减少首次安装体积。
            </div>
          </div>

          <details class="resource-download-card" open>
            <summary class="resource-download-summary">
              <div>
                <div class="resource-download-title">本地 Node.js 服务</div>
                <div class="resource-download-subtitle">用于未来按需启用本地 Node 服务，不再参与默认 APK 构建</div>
              </div>
              <div class="resource-download-badge" id="resource-nodejs-badge">未安装</div>
            </summary>
            <div class="resource-download-body">
              <div class="resource-download-meta">
                <div class="resource-download-row"><span>资源类型</span><b>可选扩展资源</b></div>
                <div class="resource-download-row"><span>默认状态</span><b>不内置、不阻塞构建</b></div>
                <div class="resource-download-row"><span>脚本状态</span><b>已保留内置脚本方案说明</b></div>
              </div>

              <div class="resource-download-note">
                当前版本已把 nodejs-mobile 依赖与 CI 下载流程移出主构建链路，因此 APK 工作流不会再卡在 AAR 下载。
                这个卡片作为后续“用户主动下载 Node 服务资源”的入口位，等原生下载/解压接口接好后即可直连启用。
              </div>

              <div class="resource-download-script-box">
                <div class="resource-download-script-title">预置脚本入口</div>
                <pre id="resource-nodejs-script-preview">/nodejs-project/index.js
用途：启动本地 Node.js 服务并承载业务脚本。
现状：资源已从默认构建中移除，等待后续按需下载接入。</pre>
              </div>

              <div id="resource-nodejs-status" class="resource-download-status">状态检测中…</div>

              <div class="form-actions" style="margin-top:12px;">
                <button id="btn-resource-nodejs-refresh" class="btn btn-outline">刷新状态</button>
                <button id="btn-resource-nodejs-download" class="btn btn-primary">准备下载</button>
              </div>
            </div>
          </details>
        </div>
      `;
    },

    initPanel: function () {
      const btnRefresh = document.getElementById("btn-resource-nodejs-refresh");
      const btnDownload = document.getElementById("btn-resource-nodejs-download");
      if (btnRefresh) btnRefresh.onclick = () => this.refreshNodejsCard();
      if (btnDownload) btnDownload.onclick = () => this.handleNodejsDownload();
      this.refreshNodejsCard();
    },

    refreshNodejsCard: function () {
      const statusEl = document.getElementById("resource-nodejs-status");
      const badgeEl = document.getElementById("resource-nodejs-badge");
      const btnEl = document.getElementById("btn-resource-nodejs-download");
      if (!statusEl || !badgeEl) return;

      if (!isAndroidBridgeReady()) {
        badgeEl.innerText = "网页环境";
        badgeEl.style.background = "#e2e8f0";
        badgeEl.style.color = "#475569";
        statusEl.innerHTML = "当前为网页环境，仅展示入口样式。真正的资源下载需要在 APK 真机环境下接入原生下载能力。";
        if (btnEl) {
          btnEl.disabled = true;
          btnEl.innerText = "APK 内可用";
        }
        return;
      }

      badgeEl.innerText = "待接入";
      badgeEl.style.background = "#fff7ed";
      badgeEl.style.color = "#c2410c";
      statusEl.innerHTML = "真机桥已检测到，但当前版本尚未接入 Node 服务资源的原生下载与解压接口。入口已预留，后续可直接打通。";
      if (btnEl) {
        btnEl.disabled = false;
        btnEl.innerText = "准备下载";
      }
    },

    handleNodejsDownload: function () {
      if (typeof window.showCustomConfirm === "function") {
        window.showCustomConfirm(
          "本地 Node.js 服务",
          "当前版本已经修复为：Node.js 资源不再默认参与 APK 构建，因此不会再导致工作流失败。\n\n这个下载入口 UI 已经预留完成；下一步只需补原生下载/解压接口，就能让用户主动下载。",
          () => {
            showToastSafe("资源下载入口已预留完成，当前版本以稳定构建为优先。");
          }
        );
      } else {
        alert("资源下载入口已预留完成，当前版本以稳定构建为优先。");
      }
    }
  };

  window.resourceDownloadSystem = resourceDownloadSystem;
})();