/**
 * app_settings.js - 系统设置、桌面美化、组件工坊、数据分区隔离管理中心 (内置 Prompt 复制版)
 */

let isSettingsInitialized = false;

// 专属临时存储自定义图标和壁纸的 Blob 二进制指针
let tempBgBlob = null;

function initSettingsApp() {
  if (isSettingsInitialized) return;
  isSettingsInitialized = true;

  loadPresetsList();
  loadCustomCssPresets();
  loadWidgetPresets();
  loadBeautifyForm();
  loadDeeptalkPresetsList(); // 初始化载入深谈预设
  initVConsoleSetting();     // 初始化调试控制台开关状态

  // 绑定：二级面板中深谈预设设置的保存、删除与表单反馈
  document.getElementById("btn-save-deeptalk-preset").onclick = saveDeeptalkPreset;
  document.getElementById("btn-delete-deeptalk-preset").onclick = deleteDeeptalkPreset;
  document.getElementById("settings-deeptalk-presets-select").onchange = loadDeeptalkPresetToForm;

  // 1. 桌面壁纸美化上传
  const btnBgUpload = document.getElementById("btn-beautify-bg-upload");
  const fileBg = document.getElementById("file-beautify-bg");
  if (btnBgUpload && fileBg) {
    btnBgUpload.onclick = () => fileBg.click();
    fileBg.onchange = (e) => {
      if (e.target.files.length > 0) {
        tempBgBlob = e.target.files[0];
        document.getElementById("beautify-bg-url").value = "[本地上传背景]";
        
        // 实时触发壁纸的图像预览
        const reader = new FileReader();
        reader.onload = function(evt) {
          const preview = document.getElementById("beautify-bg-preview");
          if (preview) preview.innerHTML = `<img src="${evt.target.result}" style="width:100%; height:100%; object-fit:cover;">`;
        };
        reader.readAsDataURL(tempBgBlob);
      }
    };
  }

  // 2. 监听4个应用图标的本地上传触发
  let activeCustomizingAppId = null;
  document.querySelectorAll(".btn-icon-upload-trigger").forEach(btn => {
    btn.onclick = (e) => {
      e.preventDefault();
      activeCustomizingAppId = btn.getAttribute("data-app");
      document.getElementById("file-beautify-icon-global").click();
    };
  });

  // 绑定全局图标选择变更并即时显示预览
  const fileIconGlobal = document.getElementById("file-beautify-icon-global");
  if (fileIconGlobal) {
    fileIconGlobal.onchange = async (e) => {
      if (e.target.files.length > 0 && activeCustomizingAppId) {
        const file = e.target.files[0];
        const dataURL = await blobToDataURL(file);
        
        // 写入本地该应用输入框，并更新即时预览
        const urlInput = document.getElementById(`beautify-icon-url-${activeCustomizingAppId}`);
        if (urlInput) urlInput.value = "[本地上传图标]";
        
        const previewBox = document.getElementById(`beautify-preview-${activeCustomizingAppId}`);
        if (previewBox) {
          previewBox.innerHTML = `<img src="${dataURL}" style="width:100%; height:100%; object-fit:cover;">`;
          previewBox.setAttribute("data-pending-base64", dataURL);
        }
        
        fileIconGlobal.value = "";
      }
    };
  }

  // 监听恢复单个应用图标为默认
  document.querySelectorAll(".btn-icon-reset-trigger").forEach(btn => {
    btn.onclick = (e) => {
      e.preventDefault();
      const appId = btn.getAttribute("data-app");
      
      let customIcons = {};
      try { customIcons = JSON.parse(localStorage.getItem("beautify-custom-icons")) || {}; } catch(err) {}
      delete customIcons[appId];
      localStorage.setItem("beautify-custom-icons", JSON.stringify(customIcons));

      const urlInput = document.getElementById(`beautify-icon-url-${appId}`);
      if (urlInput) urlInput.value = "";

      const previewBox = document.getElementById(`beautify-preview-${appId}`);
      if (previewBox) {
        previewBox.removeAttribute("data-pending-base64");
        const info = DESKTOP_APPS_CONFIG[appId];
        previewBox.innerHTML = info ? info.svg : "";
      }
      
      let appName = "";
      if (appId === "settings") appName = "设置";
      else if (appId === "archive") appName = "档案库";
      else if (appId === "world_book") appName = "世界书";
      else if (appId === "chat") appName = "聊天";
      else if (appId === "deeptalk") appName = "深谈";

      alert(`应用「${appName}」图标已重置为系统默认。`);
      if (window.loadDesktopLayout) window.loadDesktopLayout();
    };
  });

  // 绑定：Dock 不透明度数值即时变动
  const opacityInput = document.getElementById("beautify-dock-opacity");
  const opacityValText = document.getElementById("beautify-dock-opacity-val");
  if (opacityInput && opacityValText) {
    opacityInput.oninput = (e) => {
      opacityValText.innerText = e.target.value;
    };
  }

  document.getElementById("btn-save-beautify").onclick = saveBeautifyConfig;
  document.getElementById("btn-reset-beautify").onclick = resetBeautifyConfig;

  // 绑定：全局 CSS 相关
  document.getElementById("btn-save-css-preset").onclick = saveCssPreset;
  document.getElementById("btn-apply-css").onclick = applyCssPreset;
  document.getElementById("btn-reset-css").onclick = resetCssPreset;
  document.getElementById("btn-delete-css-preset").onclick = deleteCssPreset;
  document.getElementById("css-presets-select").onchange = loadCssPresetToForm;

  // 绑定：组件工坊相关
  document.getElementById("btn-compile-widget").onclick = compileAndPreviewWidget;
  document.getElementById("btn-save-widget").onclick = saveWidgetPreset;
  document.getElementById("btn-delete-widget").onclick = deleteWidgetPreset;
  document.getElementById("widget-presets-select").onchange = loadWidgetToForm;
  
  // === 【绑定大模型组件 Prompt 复制事件】 ===
  const btnCopyPrompt = document.getElementById("btn-copy-widget-prompt");
  if (btnCopyPrompt) {
    btnCopyPrompt.onclick = copyWidgetPromptToClipboard;
  }

  // 绑定：数据管理 (7块隔离导出/导入功能)
  document.getElementById("btn-export-beautify").onclick = exportBeautifyPack;
  document.getElementById("btn-import-beautify").onclick = () => document.getElementById("file-import-beautify").click();
  document.getElementById("file-import-beautify").onchange = importBeautifyPack;

  document.getElementById("btn-export-chat-personas").onclick = exportChatAndPersonas;
  document.getElementById("btn-import-chat-personas").onclick = () => document.getElementById("file-import-chat-personas").click();
  document.getElementById("file-import-chat-personas").onchange = importChatAndPersonas;

  document.getElementById("btn-export-all-data").onclick = exportBackup;
  document.getElementById("btn-import-all-data").onclick = () => document.getElementById("file-import-all").click();
  document.getElementById("file-import-all").onchange = importBackup;

  document.getElementById("btn-clear-all-data").onclick = clearAllAppData;

  // 绑定：强更新开关状态维护
  const forceToggle = document.getElementById("force-update-toggle");
  if (forceToggle) {
    forceToggle.checked = localStorage.getItem("system-force-update") === "true";
    forceToggle.onchange = (e) => {
      localStorage.setItem("system-force-update", e.target.checked ? "true" : "false");
    };
  }

  // 检测并升级静态资源
  document.getElementById("btn-update-resources").onclick = async () => {
    if (confirm("确定要立即重构并升级本地静态资源吗？您保存的本地聊天、人设、美化等数据将 100% 安全保留。")) {
      try {
        if ('serviceWorker' in navigator) {
          const registrations = await navigator.serviceWorker.getRegistrations();
          for (let reg of registrations) {
            await reg.unregister();
          }
        }
        if ('caches' in window) {
          const cacheKeys = await caches.keys();
          for (let key of cacheKeys) {
            await caches.delete(key);
          }
        }
        alert("离线服务线程与本地强缓存已卸载成功！即将强制刷新以加载最新代码。");
        window.location.replace(window.location.origin + window.location.pathname + '?v=' + Date.now());
      } catch (err) {
        console.error("更新静态资源失败:", err);
        alert(`升级失败，详细原因: ${err.message}`);
      }
    }
  };
}

function openSettingsLv2(subTab) {
  document.getElementById("settings-lv1").style.display = "none";
  document.querySelectorAll(".settings-lv2-panel").forEach(p => p.style.display = "none");
  document.getElementById(`settings-lv2-${subTab}`).style.display = "block";
  
  const titles = {
    api: 'API 协议设置',
    beautify: '桌面美化设置',
    css: '全局 CSS 注入',
    widget: '组件工坊',
    deeptalk: '深谈预设设置', 
    data: '数据分区管理',
    'force-update': '系统强更新'
  };
  document.getElementById("settings-title").innerText = titles[subTab] || '系统设置';
  
  if (subTab === 'data') computeStorageUsage();
}

// === 深谈全局预设配置管理 ===
async function loadDeeptalkPresetsList() {
  const select = document.getElementById("settings-deeptalk-presets-select");
  if (!select) return;
  const presets = await db.deeptalk_presets.toArray();
  select.innerHTML = '<option value="">-- 新建预设 --</option>';
  presets.forEach(p => {
    const opt = document.createElement("option");
    opt.value = p.id;
    opt.innerText = p.name;
    select.appendChild(opt);
  });
}

async function loadDeeptalkPresetToForm() {
  const select = document.getElementById("settings-deeptalk-presets-select");
  const idVal = select.value;
  if (!idVal) {
    document.getElementById("settings-deeptalk-preset-name").value = "";
    document.getElementById("settings-deeptalk-preset-prompt").value = "";
    return;
  }

  const preset = await db.deeptalk_presets.get(Number(idVal));
  if (preset) {
    document.getElementById("settings-deeptalk-preset-name").value = preset.name;
    document.getElementById("settings-deeptalk-preset-prompt").value = preset.prompt;
  }
}

async function saveDeeptalkPreset() {
  const select = document.getElementById("settings-deeptalk-presets-select");
  const idVal = select.value;
  const name = document.getElementById("settings-deeptalk-preset-name").value.trim();
  const promptText = document.getElementById("settings-deeptalk-preset-prompt").value.trim();

  if (!name || !promptText) {
    alert("请完整填写预设名称与附加 Prompt！");
    return;
  }

  const presetData = { name, prompt: promptText };

  if (idVal) {
    await db.deeptalk_presets.update(Number(idVal), presetData);
    alert("深谈预设已更新！");
  } else {
    await db.deeptalk_presets.add(presetData);
    alert("新深谈预设已成功添加！");
  }

  document.getElementById("settings-deeptalk-preset-name").value = "";
  document.getElementById("settings-deeptalk-preset-prompt").value = "";
  await loadDeeptalkPresetsList();
}

async function deleteDeeptalkPreset() {
  const select = document.getElementById("settings-deeptalk-presets-select");
  const idVal = select.value;
  if (!idVal) {
    alert("请选择要删除的深谈预设！");
    return;
  }

  if (confirm("确定要删除此深谈预设吗？")) {
    await db.deeptalk_presets.delete(Number(idVal));
    alert("该预设已彻底删除。");
    document.getElementById("settings-deeptalk-preset-name").value = "";
    document.getElementById("settings-deeptalk-preset-prompt").value = "";
    await loadDeeptalkPresetsList();
  }
}

function closeSettingsLv2() {
  document.getElementById("settings-lv1").style.display = "block";
  document.querySelectorAll(".settings-lv2-panel").forEach(p => p.style.display = "none");
  document.getElementById("settings-title").innerText = '系统设置';
}

function handleSettingsBack() {
  const lv1 = document.getElementById("settings-lv1");
  if (lv1.style.display === "none") {
    closeSettingsLv2();
  } else {
    closeApp('settings');
  }
}

// ==========================================
// 1. API 协议设置加载
// ==========================================
async function loadPresetsList() {
  const select = document.getElementById("api-presets-select");
  const presets = await db.api_presets.toArray();
  select.innerHTML = '<option value="">-- 选择已有预设 --</option>';
  presets.forEach(p => {
    const opt = document.createElement("option");
    opt.value = p.id;
    opt.innerText = p.name;
    select.appendChild(opt);
  });
  
  const activeId = localStorage.getItem("global_api_preset_id");
  if (activeId) {
    select.value = activeId;
    loadPresetToForm(Number(activeId));
  }
}

async function loadPresetToForm(id) {
  const preset = await db.api_presets.get(id);
  if (!preset) return;
  document.getElementById("api-preset-name").value = preset.name || "";
  document.getElementById("api-protocol").value = preset.protocol || "openai";
  document.getElementById("api-url").value = preset.url || "";
  document.getElementById("api-key").value = preset.key || "";
  document.getElementById("api-temp").value = preset.temperature ?? 0.7;
  document.getElementById("temp-val").innerText = preset.temperature ?? 0.7;
  
  const modelSelect = document.getElementById("api-model-select");
  modelSelect.innerHTML = `<option value="${preset.model || ""}">${preset.model || "默认模型"}</option>`;
}

document.getElementById("api-presets-select").onchange = (e) => {
  if (e.target.value) {
    loadPresetToForm(Number(e.target.value));
  } else {
    document.getElementById("api-preset-name").value = "";
    document.getElementById("api-url").value = "";
    document.getElementById("api-key").value = "";
    document.getElementById("api-temp").value = 0.7;
    document.getElementById("temp-val").innerText = "0.7";
    document.getElementById("api-model-select").innerHTML = '<option value="">请先拉取模型</option>';
  }
};

document.getElementById("api-temp").oninput = (e) => {
  document.getElementById("temp-val").innerText = e.target.value;
};

document.getElementById("btn-save-preset").onclick = async () => {
  const select = document.getElementById("api-presets-select");
  const idVal = select.value;
  const name = document.getElementById("api-preset-name").value.trim();
  const protocol = document.getElementById("api-protocol").value;
  const url = document.getElementById("api-url").value.trim();
  const key = document.getElementById("api-key").value.trim();
  const model = document.getElementById("api-model-select").value;
  const temperature = parseFloat(document.getElementById("api-temp").value);
  
  if (!name) {
    alert("请输入预设名称");
    return;
  }
  
  const presetData = { name, protocol, url, key, model, temperature };
  
  if (idVal) {
    await db.api_presets.update(Number(idVal), presetData);
    alert("预设更新成功");
  } else {
    const newId = await db.api_presets.add(presetData);
    alert("新预设添加成功");
    localStorage.setItem("global_api_preset_id", newId);
  }
  loadPresetsList();
};

document.getElementById("btn-apply-global").onclick = async () => {
  const select = document.getElementById("api-presets-select");
  const idVal = select.value;
  if (!idVal) {
    alert("请先保存或选择一个预设进行应用");
    return;
  }
  localStorage.setItem("global_api_preset_id", idVal);
  alert("当前 API 预设已成功设定为全局应用！");
};

document.getElementById("btn-delete-preset").onclick = async () => {
  const select = document.getElementById("api-presets-select");
  const idVal = select.value;
  if (!idVal) {
    alert("请先选择一个预设进行删除");
    return;
  }
  if (confirm("确定要删除此 API 预设吗？")) {
    await db.api_presets.delete(Number(idVal));
    if (localStorage.getItem("global_api_preset_id") === idVal) {
      localStorage.removeItem("global_api_preset_id");
    }
    alert("预设已删除");
    loadPresetsList();
  }
};

document.getElementById("btn-fetch-models").onclick = async () => {
  const url = document.getElementById("api-url").value.trim();
  const key = document.getElementById("api-key").value.trim();
  const protocol = document.getElementById("api-protocol").value;
  
  if (!url) {
    alert("请先填写 API 终结点 URL");
    return;
  }
  
  const btn = document.getElementById("btn-fetch-models");
  btn.innerText = "拉动中...";
  btn.disabled = true;
  
  try {
    let models = [];
    if (protocol === 'openai' || protocol === 'openai-compatible' || protocol === 'deepseek') {
      const response = await fetch(`${url}/models`, {
        headers: { "Authorization": `Bearer ${key}` }
      });
      const data = await response.json();
      if (data && data.data) {
        models = data.data.map(m => m.id);
      }
    } else if (protocol === 'gemini') {
      models = ["gemini-1.5-pro", "gemini-1.5-flash", "gemini-2.0-flash-exp"];
    }
    
    const modelSelect = document.getElementById("api-model-select");
    modelSelect.innerHTML = "";
    if (models.length > 0) {
      models.forEach(m => {
        const opt = document.createElement("option");
        opt.value = m;
        opt.innerText = m;
        modelSelect.appendChild(opt);
      });
      alert(`成功拉取到 ${models.length} 个模型`);
    } else {
      throw new Error("未获取到模型列表");
    }
  } catch (err) {
    console.error(err);
    const modelSelect = document.getElementById("api-model-select");
    const mName = prompt("拉取失败，请输入模型名称（例如: gpt-4o）:") || "";
    if (mName) {
      modelSelect.innerHTML = `<option value="${mName}">${mName}</option>`;
    }
  } finally {
    btn.innerText = "拉取";
    btn.disabled = false;
  }
};

document.getElementById("btn-test-api").onclick = async () => {
  const url = document.getElementById("api-url").value.trim();
  const key = document.getElementById("api-key").value.trim();
  const model = document.getElementById("api-model-select").value || "gpt-3.5-turbo";
  
  if (!url) {
    alert("请先填写 API 终结点 URL");
    return;
  }
  
  const btn = document.getElementById("btn-test-api");
  btn.innerText = "测试中...";
  btn.disabled = true;
  
  try {
    const response = await fetch(`${url}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${key}` },
      body: JSON.stringify({
        model: model,
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 5
      })
    });
    
    if (response.ok) {
      alert("连接测试成功！API 响应正常。");
    } else {
      const errText = await response.text();
      throw new Error(`HTTP ${response.status}: ${errText}`);
    }
  } catch (err) {
    console.error(err);
    alert("连接测试失败: " + err.message);
  } finally {
    btn.innerText = "测试连接";
    btn.disabled = false;
  }
};

// ==========================================
// 2. 桌面美化设置逻辑 (支持平铺配置、即时预览与不透明度保存)
// ==========================================
function loadBeautifyForm() {
  const bgUrl = localStorage.getItem("beautify-wallpaper") || "";
  document.getElementById("beautify-bg-url").value = bgUrl.startsWith("data:") ? "[本地上传背景]" : bgUrl;
  
  // 渲染壁纸预览
  const bgPreview = document.getElementById("beautify-bg-preview");
  if (bgPreview) {
    if (bgUrl) {
      bgPreview.innerHTML = `<img src="${bgUrl}" style="width:100%; height:100%; object-fit:cover;">`;
    } else {
      bgPreview.innerHTML = '<span style="font-size: 9px; color: var(--text-secondary); text-align: center;">无预览</span>';
    }
  }

  // 渲染不透明度数据
  const opacity = localStorage.getItem("beautify-dock-opacity") || "70";
  document.getElementById("beautify-dock-opacity").value = opacity;
  document.getElementById("beautify-dock-opacity-val").innerText = opacity;

  // 渲染回车上屏开关状态
  const enterSend = localStorage.getItem("settings-enter-send") === "true";
  const enterSendInput = document.getElementById("settings-enter-send-toggle");
  if (enterSendInput) enterSendInput.checked = enterSend;

  // 循环载入并高精度绘制应用图标的平铺预览图 (加入 deeptalk)
  const apps = ["settings", "archive", "world_book", "chat", "deeptalk"];
  let customIcons = {};
  try {
    customIcons = JSON.parse(localStorage.getItem("beautify-custom-icons")) || {};
  } catch(e) {}

  apps.forEach(appId => {
    const previewBox = document.getElementById(`beautify-preview-${appId}`);
    const urlInput = document.getElementById(`beautify-icon-url-${appId}`);
    if (urlInput) {
      const savedIcon = customIcons[appId] || "";
      urlInput.value = savedIcon.startsWith("data:") ? "[本地上传图标]" : savedIcon;
      
      if (previewBox) {
        if (savedIcon) {
          previewBox.innerHTML = `<img src="${savedIcon}" style="width:100%; height:100%; object-fit:cover;">`;
        } else {
          const info = DESKTOP_APPS_CONFIG[appId];
          previewBox.innerHTML = info ? info.svg : "";
        }
      }
    }
  });
}

async function saveBeautifyConfig() {
  const bgInput = document.getElementById("beautify-bg-url").value.trim();
  const opacityVal = document.getElementById("beautify-dock-opacity").value;

  // 保存背景
  if (bgInput === "[本地上传背景]") {
    if (tempBgBlob) {
      const dataURL = await blobToDataURL(tempBgBlob);
      localStorage.setItem("beautify-wallpaper", dataURL);
    }
  } else if (bgInput) {
    localStorage.setItem("beautify-wallpaper", bgInput);
  } else {
    localStorage.removeItem("beautify-wallpaper");
  }

  // 保存不透明度
  localStorage.setItem("beautify-dock-opacity", opacityVal);

  // 保存回车上屏开关状态
  const enterSendInput = document.getElementById("settings-enter-send-toggle");
  if (enterSendInput) {
    localStorage.setItem("settings-enter-send", enterSendInput.checked ? "true" : "false");
  }

  // 依次读取平铺列表中的应用图标配置 (加入 deeptalk)
  const apps = ["settings", "archive", "world_book", "chat", "deeptalk"];
  let customIcons = {};
  try {
    customIcons = JSON.parse(localStorage.getItem("beautify-custom-icons")) || {};
  } catch(e) {}

  apps.forEach(appId => {
    const urlInput = document.getElementById(`beautify-icon-url-${appId}`);
    if (urlInput) {
      const val = urlInput.value.trim();
      if (val === "[本地上传图标]") {
        const previewBox = document.getElementById(`beautify-preview-${appId}`);
        const pendingBase64 = previewBox ? previewBox.getAttribute("data-pending-base64") : null;
        if (pendingBase64) {
          customIcons[appId] = pendingBase64;
        }
      } else if (val) {
        customIcons[appId] = val;
      } else {
        delete customIcons[appId];
      }
    }
  });

  localStorage.setItem("beautify-custom-icons", JSON.stringify(customIcons));
  tempBgBlob = null;

  alert("美化方案配置已应用并保存！桌面端即将即时重绘。");
  if (window.applyGlobalSettingsOnLoad) applyGlobalSettingsOnLoad();
  if (window.loadDesktopLayout) loadDesktopLayout();
  loadBeautifyForm(); // 刷新预览状态
}

function resetBeautifyConfig() {
  if (confirm("确定要恢复默认壁纸与全部桌面图标吗？")) {
    localStorage.removeItem("beautify-wallpaper");
    localStorage.removeItem("beautify-custom-icons");
    localStorage.removeItem("beautify-dock-opacity");
    localStorage.removeItem("settings-enter-send");
    document.getElementById("beautify-bg-url").value = "";
    
    const apps = ["settings", "archive", "world_book", "chat", "deeptalk"];
    apps.forEach(appId => {
      const input = document.getElementById(`beautify-icon-url-${appId}`);
      if (input) input.value = "";
    });

    alert("默认方案重置成功。");
    if (window.applyGlobalSettingsOnLoad) applyGlobalSettingsOnLoad();
    if (window.loadDesktopLayout) loadDesktopLayout();
    loadBeautifyForm();
  }
}

// ==========================================
// 3. 全局 CSS 注入逻辑
// ==========================================
function loadCustomCssPresets() {
  const select = document.getElementById("css-presets-select");
  let presets = {};
  try {
    presets = JSON.parse(localStorage.getItem("custom-css-presets")) || {};
  } catch(e) {}

  select.innerHTML = '<option value="">-- 新建预设 --</option>';
  Object.keys(presets).forEach(name => {
    const opt = document.createElement("option");
    opt.value = name;
    opt.innerText = name;
    select.appendChild(opt);
  });

  document.getElementById("css-code-editor").value = localStorage.getItem("beautify-active-css") || "";
}

function loadCssPresetToForm() {
  const name = document.getElementById("css-presets-select").value;
  if (!name) return;
  let presets = {};
  try {
    presets = JSON.parse(localStorage.getItem("custom-css-presets")) || {};
  } catch(e) {}

  document.getElementById("css-preset-name").value = name;
  document.getElementById("css-code-editor").value = presets[name] || "";
}

function saveCssPreset() {
  const name = document.getElementById("css-preset-name").value.trim();
  const code = document.getElementById("css-code-editor").value;
  if (!name) {
    alert("请输入要保存的预设名称");
    return;
  }

  let presets = {};
  try {
    presets = JSON.parse(localStorage.getItem("custom-css-presets")) || {};
  } catch(e) {}

  presets[name] = code;
  localStorage.setItem("custom-css-presets", JSON.stringify(presets));
  alert("CSS 预设保存成功。");
  loadCustomCssPresets();
}

function applyCssPreset() {
  const code = document.getElementById("css-code-editor").value;
  localStorage.setItem("beautify-active-css", code);
  alert("自定义 CSS 已编译并全局生效！");
  if (window.applyGlobalSettingsOnLoad) applyGlobalSettingsOnLoad();
}

function resetCssPreset() {
  if (confirm("确定要清空全局 CSS 注入吗？")) {
    localStorage.removeItem("beautify-active-css");
    document.getElementById("css-code-editor").value = "";
    document.getElementById("css-preset-name").value = "";
    alert("已清空并恢复默认。");
    if (window.applyGlobalSettingsOnLoad) applyGlobalSettingsOnLoad();
  }
}

function deleteCssPreset() {
  const name = document.getElementById("css-presets-select").value;
  if (!name) {
    alert("请先选择要删除的 CSS 预设");
    return;
  }
  if (confirm(`确定要彻底删除预设「${name}」吗？`)) {
    let presets = {};
    try {
      presets = JSON.parse(localStorage.getItem("custom-css-presets")) || {};
    } catch(e) {}
    delete presets[name];
    localStorage.setItem("custom-css-presets", JSON.stringify(presets));
    alert("预设已成功删除。");
    loadCustomCssPresets();
  }
}

// ==========================================
// 4. 组件工坊逻辑（支持自定义列宽行高）
// ==========================================
function loadWidgetPresets() {
  const select = document.getElementById("widget-presets-select");
  let widgets = {};
  try {
    widgets = JSON.parse(localStorage.getItem("beautify-widgets")) || {};
  } catch(e) {}

  select.innerHTML = '<option value="">-- 新建组件 --</option>';
  Object.keys(widgets).forEach(id => {
    const opt = document.createElement("option");
    opt.value = id;
    opt.innerText = widgets[id].name;
    select.appendChild(opt);
  });
}

function loadWidgetToForm() {
  const id = document.getElementById("widget-presets-select").value;
  if (!id) {
    document.getElementById("widget-name-input").value = "";
    document.getElementById("widget-code-editor").value = "";
    document.getElementById("widget-width-span").value = "1";
    document.getElementById("widget-height-span").value = "1";
    document.getElementById("widget-workshop-preview").innerHTML = '<span style="font-size:11px; color:var(--text-secondary);">暂无预览</span>';
    return;
  }

  let widgets = {};
  try {
    widgets = JSON.parse(localStorage.getItem("beautify-widgets")) || {};
  } catch(e) {}

  const w = widgets[id];
  if (w) {
    document.getElementById("widget-name-input").value = w.name;
    document.getElementById("widget-code-editor").value = w.html;
    document.getElementById("widget-width-span").value = w.widthSpan || 1;
    document.getElementById("widget-height-span").value = w.heightSpan || 1;
    compileAndPreviewWidget();
  }
}

function compileAndPreviewWidget() {
  const code = document.getElementById("widget-code-editor").value;
  const preview = document.getElementById("widget-workshop-preview");
  if (!preview) return;

  preview.innerHTML = code;
  // 核心：强制执行组件中的 script
  const scripts = preview.querySelectorAll("script");
  scripts.forEach(oldScript => {
    const newScript = document.createElement("script");
    newScript.text = oldScript.innerHTML;
    oldScript.parentNode.replaceChild(newScript, oldScript);
  });
}

function saveWidgetPreset() {
  const name = document.getElementById("widget-name-input").value.trim();
  const code = document.getElementById("widget-code-editor").value;
  const widthSpan = parseInt(document.getElementById("widget-width-span").value) || 1;
  const heightSpan = parseInt(document.getElementById("widget-height-span").value) || 1;

  if (!name) {
    alert("请输入组件名称");
    return;
  }

  const select = document.getElementById("widget-presets-select");
  let id = select.value;
  if (!id) {
    id = "widget_" + Date.now();
  }

  let widgets = {};
  try {
    widgets = JSON.parse(localStorage.getItem("beautify-widgets")) || {};
  } catch(e) {}

  widgets[id] = { id, name, html: code, widthSpan, heightSpan };
  localStorage.setItem("beautify-widgets", JSON.stringify(widgets));
  alert("组件编译与保存成功！可在桌面上长按空白槽位添加。");
  loadWidgetPresets();
  select.value = id;
}

function deleteWidgetPreset() {
  const id = document.getElementById("widget-presets-select").value;
  if (!id) {
    alert("请选择一个已有组件进行删除");
    return;
  }
  if (confirm("确定要删除此组件吗？这将从桌面所有已添加的地方将其自动卸载。")) {
    let widgets = {};
    try {
      widgets = JSON.parse(localStorage.getItem("beautify-widgets")) || {};
    } catch(e) {}
    delete widgets[id];
    localStorage.setItem("beautify-widgets", JSON.stringify(widgets));

    // 清理桌面摆放
    ["desktop", "dock"].forEach(type => {
      let placed = {};
      try { placed = JSON.parse(localStorage.getItem(`placed-widgets-${type}`)) || {}; } catch(e) {}
      Object.keys(placed).forEach(slotIdx => {
        if (placed[slotIdx] === id) delete placed[slotIdx];
      });
      localStorage.setItem(`placed-widgets-${type}`, JSON.stringify(placed));
    });

    alert("组件已删除");
    loadWidgetPresets();
    loadWidgetToForm();
    if (window.loadDesktopLayout) loadDesktopLayout();
  }
}

// === 【一键复制组件开发 Prompt 模板函数】 ===
function copyWidgetPromptToClipboard() {
  const promptText = `# Role
你是一个资深的前端动效与组件设计师，专为“叙事诗小手机（Story Phone）”虚拟操作系统设计桌面小部件（Widgets）。

# Goal
根据用户提出的功能需求与尺寸规格，生成一段 100% 独立自闭环、开箱即用的 HTML/CSS/JS 混合代码。该代码能够直接粘贴到小手机的“组件工坊”中无缝编译并渲染。

# Technical Constraints & Code Standards (极其重要)
为了防止组件破坏主系统或在页面重绘时引起浏览器假死，你编写的代码必须严格遵守以下技术规范：

1. 作用域隔离 (Scope Isolation)：
   - 脚本必须包裹在立即执行函数 IIFE 中：(function() { ... })();。
   - 严禁声明任何全局变量或将属性挂载到 window 上，所有变量必须使用 const 或 let 进行块级约束，防止命名空间冲突。

2. 防御性内存清理机制 (Anti-Memory Leak)：
   - 如果组件中使用了 setInterval、setTimeout 或向全局 document / window 绑定了事件监听器，必须使用 MutationObserver 监听组件根节点在 DOM 树中的物理留存状态。
   - 一旦检测到组件已被用户从桌面卸载，**必须立即清除定时器（clearInterval/clearTimeout）并注销全局监听**，防止多实例叠加导致主进程卡死。
   - 示例卸载监听代码：
     \`\`\`javascript
     const container = document.getElementById("your-widget-unique-id");
     const intervalId = setInterval(updateFunction, 1000);
     const observer = new MutationObserver((mutations, obs) => {
       if (!document.contains(container)) {
         clearInterval(intervalId);
         obs.disconnect();
       }
     });
     observer.observe(document.body, { childList: true, subtree: true });
     \`\`\`

3. 视觉规范 (Aesthetics & Glassmorphism)：
   - 组件默认继承操作系统的“仿微信/iOS 毛玻璃（Glassmorphism）”视觉调性。
   - 容器背景必须使用半透明色彩：background: rgba(255, 255, 255, 0.12);。
   - 容器边缘必须具备毛玻璃模糊：backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px);。
   - 容器边框必须是微弱发光的白色半透明描边：border: 1px solid rgba(255, 255, 255, 0.22);。
   - 字体必须使用现代无衬线体 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif，并使用高清晰度文字阴影：text-shadow: 0 2px 10px rgba(0, 0, 0, 0.15);。
   - 时钟或动态变动的数字，必须开启等宽数字对齐，防止数字跳动导致的卡片滑步：font-feature-settings: 'tnum';。

4. 尺寸与排版适应 (Sizing)：
   - 必须使用绝对自适应布局（width: 100%; height: 100%; box-sizing: border-box;），确保在不同的 widthSpan（列宽）和 heightSpan（行高）下不发生内容物理溢出。

# Output Format
- 仅输出一个 Markdown 代码块，包含完整的 HTML/CSS/JS 代码。
- 严禁输出任何多余的解释性文本、问候语或 Markdown 外侧修饰，确保用户可以一键复制。

---

# User Input
请根据以下要求，为我设计组件：
- **组件名称**：[例如：极简数字时钟]
- **占用尺寸**：宽 [X] 列，高 [Y] 行 （注：一排最大宽度为 4 列）
- **功能细节**：[例如：实时拉取系统时间，显示小时与分钟，带动态闪烁的分隔符，以及农历日期]
- **交互动效**：[例如：点击卡片时，背景色彩发生微弱渐变律动]`;

  navigator.clipboard.writeText(promptText).then(() => {
    alert("组件开发大模型 Prompt 模板已成功复制到您的剪贴板！\n\n您可以立刻将其粘贴发送给 ChatGPT/DeepSeek/Claude 等 AI 助手来为您生成高度合规的桌面小组件。");
  }).catch(err => {
    console.error("一键复制失败:", err);
    alert("复制失败，您的浏览器可能未授予剪贴板访问权限，请在 README 的附录中手动复制。");
  });
}

// ==========================================
// 5. 数据管理高级备份 (7块分区隔离导入导出)
// ==========================================
async function clearAllAppData() {
  if (confirm("系统数据全清除警告！\n\n此操作将彻底抹除当前小手机内产生的所有本地聊天记录、配置、美化及自定义组件，格式化为最初始状态。确定要彻底清空吗？")) {
    if (confirm("再次确认：确定清除吗？清除后不可撤销。")) {
      await db.api_presets.clear();
      await db.archives.clear();
      await db.relations.clear();
      await db.sessions.clear();
      await db.messages.clear();
      await db.world_book_entries.clear();
      await db.theaters.clear();
      await db.offline_messages.clear();
      await db.status_history.clear();
      await db.sticker_groups.clear();
      await db.sticker_items.clear();
      
      localStorage.clear();
      alert("所有本地数据与美化设置均已被格式化，系统即将重启。");
      location.reload();
    }
  }
}

// 导出美化包
function exportBeautifyPack() {
  try {
    const pack = {
      wallpaper: localStorage.getItem("beautify-wallpaper"),
      customIcons: localStorage.getItem("beautify-custom-icons"),
      activeCss: localStorage.getItem("beautify-active-css"),
      cssPresets: localStorage.getItem("custom-css-presets"),
      placedWidgetsDesktop: localStorage.getItem("placed-widgets-desktop"),
      placedWidgetsDock: localStorage.getItem("placed-widgets-dock"),
      widgets: localStorage.getItem("beautify-widgets"),
      dockOpacity: localStorage.getItem("beautify-dock-opacity")
    };
    
    const blob = new Blob([JSON.stringify(pack, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `desktop_beautify_pack_${Date.now()}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  } catch(e) {
    alert("导出美化包失败: " + e.message);
  }
}

function importBeautifyPack(e) {
  const file = e.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = (event) => {
    try {
      const data = JSON.parse(event.target.result);
      if (confirm("导入美化包将覆盖现有的壁纸、自定义图标与组件库！确定继续吗？")) {
        if (data.wallpaper) localStorage.setItem("beautify-wallpaper", data.wallpaper);
        if (data.customIcons) localStorage.setItem("beautify-custom-icons", data.customIcons);
        if (data.activeCss) localStorage.setItem("beautify-active-css", data.activeCss);
        if (data.cssPresets) localStorage.setItem("custom-css-presets", data.cssPresets);
        if (data.placedWidgetsDesktop) localStorage.setItem("placed-widgets-desktop", data.placedWidgetsDesktop);
        if (data.placedWidgetsDock) localStorage.setItem("placed-widgets-dock", data.placedWidgetsDock);
        if (data.widgets) localStorage.setItem("beautify-widgets", data.widgets);
        if (data.dockOpacity) localStorage.setItem("beautify-dock-opacity", data.dockOpacity);

        alert("美化包导入成功！");
        location.reload();
      }
    } catch(err) {
      alert("导入美化包失败: " + err.message);
    }
  };
  reader.readAsText(file);
}

// 导出人设与聊天记录
async function exportChatAndPersonas() {
  try {
    const rawBackup = {
      archives: await db.archives.toArray(),
      relations: await db.relations.toArray(),
      sessions: await db.sessions.toArray(),
      messages: await db.messages.toArray(),
      offline_messages: await db.offline_messages.toArray(),
      status_history: await db.status_history.toArray(),
      localStorage: {
        active_me_id: localStorage.getItem("active_me_id")
      }
    };
    const backup = await serializeRecord(rawBackup);
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `personas_chat_backup_${Date.now()}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  } catch(e) {
    alert("导出聊天人设记录失败: " + e.message);
  }
}

function importChatAndPersonas(e) {
  const file = e.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = async (event) => {
    try {
      const rawData = JSON.parse(event.target.result);
      const data = deserializeRecord(rawData);
      if (confirm("警告：导入将覆盖现有的档案库、会话关系与所有聊天记录！确定继续吗？")) {
        await db.transaction('rw', [
          db.archives, db.relations, db.sessions, db.messages, db.offline_messages, db.status_history
        ], async () => {
          if (data.archives) {
            await db.archives.clear();
            await db.archives.bulkAdd(data.archives);
          }
          if (data.relations) {
            await db.relations.clear();
            await db.relations.bulkAdd(data.relations);
          }
          if (data.sessions) {
            await db.sessions.clear();
            await db.sessions.bulkAdd(data.sessions);
          }
          if (data.messages) {
            await db.messages.clear();
            await db.messages.bulkAdd(data.messages);
          }
          if (data.offline_messages) {
            await db.offline_messages.clear();
            await db.offline_messages.bulkAdd(data.offline_messages);
          }
          if (data.status_history) {
            await db.status_history.clear();
            await db.status_history.bulkAdd(data.status_history);
          }
        });

        if (data.localStorage && data.localStorage.active_me_id) {
          localStorage.setItem("active_me_id", data.localStorage.active_me_id);
        }

        alert("人设聊天记录导入成功！");
        location.reload();
      }
    } catch(err) {
      alert("导入失败: " + err.message);
    }
  };
  reader.readAsText(file);
}

// ==========================================
// 6. 基础系统底层 (容量占用计算、无损大二进制导入/导出等)
// ==========================================
async function computeStorageUsage() {
  try {
    const api_presets = await db.api_presets.toArray();
    const archives = await db.archives.toArray();
    const relations = await db.relations.toArray();
    const sessions = await db.sessions.toArray();
    const messages = await db.messages.toArray();
    const world_book_entries = await db.world_book_entries.toArray();
    const theaters = await db.theaters.toArray();
    const offline_messages = await db.offline_messages.toArray();
    const status_history = await db.status_history.toArray();
    const sticker_groups = await db.sticker_groups.toArray();
    const sticker_items = await db.sticker_items.toArray();
    // 增加深谈、朋友圈容量统筹计算
    const deeptalks = await db.deeptalks.toArray();
    const deeptalk_messages = await db.deeptalk_messages.toArray();
    const deeptalk_thoughts = await db.deeptalk_thoughts.toArray();
    const deeptalk_presets = await db.deeptalk_presets.toArray();
    const moments = await db.moments.toArray();
    const moment_comments = await db.moment_comments.toArray();
    const moment_settings = await db.moment_settings.toArray();

    const totalRecords = api_presets.length + archives.length + relations.length + 
                         sessions.length + messages.length + world_book_entries.length + 
                         theaters.length + offline_messages.length + status_history.length + 
                         sticker_groups.length + sticker_items.length +
                         deeptalks.length + deeptalk_messages.length + deeptalk_thoughts.length + deeptalk_presets.length +
                         moments.length + moment_comments.length + moment_settings.length;
                         
    document.getElementById("db-total-records").innerText = totalRecords;

    let imgBytes = 0;
    archives.forEach(item => {
      if (item.avatar && typeof item.avatar === 'string' && item.avatar.startsWith("data:")) {
        imgBytes += item.avatar.length;
      }
    });
    sticker_items.forEach(item => {
      if (item.imageUrl && typeof item.imageUrl === 'string' && item.imageUrl.startsWith("data:")) {
        imgBytes += item.imageUrl.length;
      }
    });

    const fullDataObj = { 
      api_presets, archives, relations, sessions, messages, 
      world_book_entries, theaters, offline_messages, status_history, 
      sticker_groups, sticker_items 
    };
    const allBytes = new Blob([JSON.stringify(fullDataObj)]).size;

    document.getElementById("db-total-bytes").innerText = `${(allBytes / 1024).toFixed(2)} KB`;
    document.getElementById("db-image-bytes").innerText = `${(imgBytes / 1024).toFixed(2)} KB`;
  } catch (err) {
    console.error("计算空间失败，数据表未完全就位:", err);
  }
}

// === 大二进制 Blob / File 原生编解码转换层 ===
function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

function dataURLtoBlob(dataurl) {
  const arr = dataurl.split(',');
  const mime = arr[0].match(/:(.*?);/)[1];
  const bstr = atob(arr[1]);
  let n = bstr.length;
  const u8arr = new Uint8Array(n);
  while (n--) {
    u8arr[n] = bstr.charCodeAt(n);
  }
  return new Blob([u8arr], { type: mime });
}

// 递归遍历任意记录将 Blob 原生转换为 Base64 容器
async function serializeRecord(obj) {
  if (!obj) return obj;
  if (obj instanceof Blob) {
    const dataURL = await blobToDataURL(obj);
    return { __type: "Blob", data: dataURL };
  }
  if (Array.isArray(obj)) {
    const serializedArr = [];
    for (let item of obj) {
      serializedArr.push(await serializeRecord(item));
    }
    return serializedArr;
  }
  if (typeof obj === 'object') {
    const serializedObj = {};
    for (let key in obj) {
      if (Object.prototype.hasOwnProperty.call(obj, key)) {
        serializedObj[key] = await serializeRecord(obj[key]);
      }
    }
    return serializedObj;
  }
  return obj;
}

// 递归遍历还原原生二进制 Blob 对象
function deserializeRecord(obj) {
  if (!obj) return obj;
  if (typeof obj === 'object') {
    if (obj.__type === "Blob" && typeof obj.data === 'string') {
      return dataURLtoBlob(obj.data);
    }
    if (Array.isArray(obj)) {
      return obj.map(item => deserializeRecord(item));
    }
    const restoredObj = {};
    for (let key in obj) {
      if (Object.prototype.hasOwnProperty.call(obj, key)) {
        restoredObj[key] = deserializeRecord(obj[key]);
      }
    }
    return restoredObj;
  }
  return obj;
}

// 备份数据导出逻辑
async function exportBackup() {
  try {
    const rawBackup = {
      api_presets: await db.api_presets.toArray(),
      archives: await db.archives.toArray(),
      relations: await db.relations.toArray(),
      sessions: await db.sessions.toArray(),
      messages: await db.messages.toArray(),
      world_book_entries: await db.world_book_entries.toArray(),
      theaters: await db.theaters.toArray(),
      offline_messages: await db.offline_messages.toArray(),
      status_history: await db.status_history.toArray(),
      sticker_groups: await db.sticker_groups.toArray(),
      sticker_items: await db.sticker_items.toArray(),
      // 导出深谈、朋友圈表的数据
      deeptalks: await db.deeptalks.toArray(),
      deeptalk_messages: await db.deeptalk_messages.toArray(),
      deeptalk_thoughts: await db.deeptalk_thoughts.toArray(),
      deeptalk_presets: await db.deeptalk_presets.toArray(),
      moments: await db.moments.toArray(),
      moment_comments: await db.moment_comments.toArray(),
      moment_settings: await db.moment_settings.toArray(),
      localStorage: {
        global_api_preset_id: localStorage.getItem("global_api_preset_id"),
        active_me_id: localStorage.getItem("active_me_id"),
        desktopLayout: localStorage.getItem("desktop-layout-v3"),
        dockLayout: localStorage.getItem("dock-layout-v3"),
        wallet_balance_v1: localStorage.getItem("wallet_balance_v1"),
        wallet_ledger_v1: localStorage.getItem("wallet_ledger_v1"),
        beautifyWallpaper: localStorage.getItem("beautify-wallpaper"),
        customIcons: localStorage.getItem("beautify-custom-icons"),
        activeCss: localStorage.getItem("beautify-active-css"),
        cssPresets: localStorage.getItem("custom-css-presets"),
        placedWidgetsDesktop: localStorage.getItem("placed-widgets-desktop"),
        placedWidgetsDock: localStorage.getItem("placed-widgets-dock"),
        widgets: localStorage.getItem("beautify-widgets"),
        dockOpacity: localStorage.getItem("beautify-dock-opacity")
      }
    };
    
    const backup = await serializeRecord(rawBackup);
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `story_phone_all_backup_${Date.now()}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  } catch (error) {
    console.error(error);
    alert("完整数据备份失败: " + error.message);
  }
}

// 备份数据还原导入逻辑
async function importBackup(e) {
  const file = e.target.files[0];
  if (!file) return;
  
  const reader = new FileReader();
  reader.onload = async (event) => {
    try {
      const rawData = JSON.parse(event.target.result);
      if (!rawData || typeof rawData !== 'object') {
        throw new Error("无效的 JSON 备份数据结构");
      }
      
      const confirmImport = confirm("导入完整备份将覆盖所有的本地数据、人设、聊天记录以及美化配置！确定要继续吗？");
      if (!confirmImport) return;
      
      const data = deserializeRecord(rawData);
      
      await db.transaction('rw', [
        db.api_presets, db.archives, db.relations, db.sessions, db.messages, 
        db.world_book_entries, db.theaters, db.offline_messages, db.status_history,
        db.sticker_groups, db.sticker_items,
        db.deeptalks, db.deeptalk_messages, db.deeptalk_thoughts, db.deeptalk_presets,
        db.moments, db.moment_comments, db.moment_settings // 增加朋友圈 3 张表的 rw 锁，防止死锁崩溃 [1]
      ], async () => {
        if (data.api_presets) {
          await db.api_presets.clear();
          await db.api_presets.bulkAdd(data.api_presets);
        }
        if (data.archives) {
          await db.archives.clear();
          await db.archives.bulkAdd(data.archives);
        }
        if (data.relations) {
          await db.relations.clear();
          await db.relations.bulkAdd(data.relations);
        }
        if (data.sessions) {
          await db.sessions.clear();
          await db.sessions.bulkAdd(data.sessions);
        }
        if (data.messages) {
          await db.messages.clear();
          await db.messages.bulkAdd(data.messages);
        }
        if (data.world_book_entries) {
          await db.world_book_entries.clear();
          await db.world_book_entries.bulkAdd(data.world_book_entries);
        }
        if (data.theaters) {
          await db.theaters.clear();
          await db.theaters.bulkAdd(data.theaters);
        }
        if (data.offline_messages) {
          await db.offline_messages.clear();
          await db.offline_messages.bulkAdd(data.offline_messages);
        }
        if (data.status_history) {
          await db.status_history.clear();
          await db.status_history.bulkAdd(data.status_history);
        }
        if (data.sticker_groups) {
          await db.sticker_groups.clear();
          await db.sticker_groups.bulkAdd(data.sticker_groups);
        }
        if (data.sticker_items) {
          await db.sticker_items.clear();
          await db.sticker_items.bulkAdd(data.sticker_items);
        }
        // 反向写入深谈 4 表
        if (data.deeptalks) {
          await db.deeptalks.clear();
          await db.deeptalks.bulkAdd(data.deeptalks);
        }
        if (data.deeptalk_messages) {
          await db.deeptalk_messages.clear();
          await db.deeptalk_messages.bulkAdd(data.deeptalk_messages);
        }
        if (data.deeptalk_thoughts) {
          await db.deeptalk_thoughts.clear();
          await db.deeptalk_thoughts.bulkAdd(data.deeptalk_thoughts);
        }
        if (data.deeptalk_presets) {
          await db.deeptalk_presets.clear();
          await db.deeptalk_presets.bulkAdd(data.deeptalk_presets);
        }
        if (data.moments) {
          await db.moments.clear();
          await db.moments.bulkAdd(data.moments);
        }
        if (data.moment_comments) {
          await db.moment_comments.clear();
          await db.moment_comments.bulkAdd(data.moment_comments);
        }
        if (data.moment_settings) {
          await db.moment_settings.clear();
          await db.moment_settings.bulkAdd(data.moment_settings);
        }
      });
      
      if (data.localStorage) {
        const keys = [
          "global_api_preset_id", "active_me_id", "desktop-layout-v3", "dock-layout-v3",
          "wallet_balance_v1", "wallet_ledger_v1", "beautify-wallpaper", "beautify-custom-icons",
          "beautify-active-css", "custom-css-presets", "placed-widgets-desktop", "placed-widgets-dock",
          "beautify-widgets", "beautify-dock-opacity"
        ];
        // 映射恢复
        const map = {
          desktopLayout: "desktop-layout-v3",
          dockLayout: "dock-layout-v3",
          beautifyWallpaper: "beautify-wallpaper",
          customIcons: "beautify-custom-icons",
          activeCss: "beautify-active-css",
          cssPresets: "custom-css-presets",
          placedWidgetsDesktop: "placed-widgets-desktop",
          placedWidgetsDock: "placed-widgets-dock",
          widgets: "beautify-widgets",
          dockOpacity: "beautify-dock-opacity"
        };

        Object.keys(data.localStorage).forEach(k => {
          const lKey = map[k] || k;
          if (data.localStorage[k] !== null && data.localStorage[k] !== undefined) {
            localStorage.setItem(lKey, data.localStorage[k]);
          }
        });
      }
      
      alert("全量数据导入成功！系统即将自动重载。");
      location.reload();
    } catch (error) {
      console.error(error);
      alert("导入备份失败: " + error.message);
    }
  };
  reader.readAsText(file);
}

// === 新增：自适应 PWA/APK 移动端调试控制台 (vConsole) 动态开关管理 ===
window.vConsoleInstance = null;

function initVConsoleSetting() {
  const toggle = document.getElementById("settings-vconsole-toggle");
  if (!toggle) return;

  const isEnabled = localStorage.getItem("settings-vconsole-enabled") === "true";
  toggle.checked = isEnabled;

  // 首次冷启动加载：静默启动（不弹 Toast 提示干扰用户）
  applyVConsoleState(isEnabled, true);

  toggle.onchange = (e) => {
    const enabled = e.target.checked;
    localStorage.setItem("settings-vconsole-enabled", enabled ? "true" : "false");
    applyVConsoleState(enabled, false);
  };
}

function applyVConsoleState(enabled, isFirstLoad) {
  if (enabled) {
    if (typeof VConsole !== 'undefined' && !window.vConsoleInstance) {
      window.vConsoleInstance = new VConsole();
      if (!isFirstLoad) showToast("调试控制台已开启 (绿色标签已就绪)");
    } else if (typeof VConsole === 'undefined') {
      if (!isFirstLoad) showToast("未检测到 vConsole 脚本，请确保 index.html 头部已引入");
    }
  } else {
    if (window.vConsoleInstance) {
      try {
        window.vConsoleInstance.destroy();
      } catch(e) {}
      window.vConsoleInstance = null;
      if (!isFirstLoad) showToast("调试控制台已关闭");
    }
  }
}
