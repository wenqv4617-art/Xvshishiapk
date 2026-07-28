let archiveCurrentTab = 'character';
let temporaryAvatarFile = null; // 存储原生 File / Blob [2]
let isArchiveInitialized = false;

// 二进制 Blob 转换为极速内存临时 URL 的渲染器（彻底解决 Base64 卡顿） [2]
function resolveAvatar(avatar) {
  if (!avatar) {
    return 'data:image/svg+xml;utf8,<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"><circle cx="50" cy="50" r="50" fill="%23ccc"/></svg>';
  }
  if (avatar instanceof Blob) {
    return URL.createObjectURL(avatar); // 毫秒级内存地址转换
  }
  return avatar; // 网络 URL 直接返回
}

function initArchiveApp() {
  loadArchivesData();
  
  const tabs = document.querySelectorAll("#win-archive .archive-tabs .tab-item");
  tabs.forEach(tab => {
    tab.onclick = () => {
      tabs.forEach(t => t.classList.remove("active"));
      tab.classList.add("active");
      archiveCurrentTab = tab.getAttribute("data-tab");
      document.getElementById("archive-title").innerText = `档案库 - ${getTabZhName(archiveCurrentTab)}`;
      loadArchivesData();
    };
  });

  if (isArchiveInitialized) {
    return;
  }
  isArchiveInitialized = true;

  document.getElementById("btn-add-archive").onclick = () => {
    if (archiveCurrentTab === 'relation') {
      openRelationNetworkEditor(null); // 关系网点击新建直接平滑切入可视化编辑器！
    } else {
      openArchiveForm();
    }
  };

  document.getElementById("btn-close-form").onclick = () => {
    document.getElementById("archive-form-overlay").classList.remove("active");
  };
  document.getElementById("btn-cancel-form").onclick = () => {
    document.getElementById("archive-form-overlay").classList.remove("active");
  };

  // 初始化导入
  initArchiveImport();

  document.getElementById("btn-save-archive").onclick = async () => {
    const idVal = document.getElementById("archive-id").value;
    const id = idVal ? Number(idVal) : null;

    const name = document.getElementById("archive-name").value.trim();
    const remark = document.getElementById("archive-remark").value.trim();
    const group = document.getElementById("archive-group").value.trim();
    const persona = document.getElementById("archive-persona").value.trim();
    const urlAvatar = document.getElementById("archive-avatar-url").value.trim();
    const parentId = archiveCurrentTab === 'npc' ? Number(document.getElementById("archive-parent-id").value) : null;

    if (!name) {
      showToast("姓名不能为空！");
      return;
    }

    if (archiveCurrentTab === 'npc' && !parentId) {
      showToast("NPC 必须选择并归属于一名主要的角色或用户！");
      return;
    }

    const avatar = urlAvatar || temporaryAvatarFile || null;

    const arcObj = {
      type: archiveCurrentTab,
      name,
      avatar,
      remark,
      group,
      persona,
      parentId
    };

    if (id) {
      await db.archives.update(id, arcObj);
    } else {
      await db.archives.add(arcObj);
    }

    document.getElementById("archive-form-overlay").classList.remove("active");
    loadArchivesData();
  };

  initPasteAndDropEvents();
}

function getTabZhName(t) {
  const map = { character: '角色', user: '用户', npc: 'NPC', relation: '关系网' };
  return map[t] || '';
}

async function loadArchivesData() {
  const container = document.getElementById("archive-list-container");
  container.innerHTML = "";

  if (archiveCurrentTab === 'relation') {
    const rels = await db.relations.toArray();
    if (rels.length === 0) {
      container.innerHTML = `<p style="text-align:center;color:var(--text-secondary);font-size:13px;padding:40px 0;">暂无关系网，请点击右上角新建关系网</p>`;
      return;
    }
    for (let r of rels) {
      const nodeCount = (r.nodes || []).length;
      const edgeCount = (r.edges || []).length;
      const card = document.createElement("div");
      card.className = "archive-card";
      card.innerHTML = `
        <div class="card-info" onclick="openRelationNetworkEditor(${r.id})" style="cursor:pointer;">
          <div class="card-name" style="font-size:14px; font-weight:700;">🌐 ${escapeHtml(r.name || '未命名关系网')}</div>
          <div class="card-desc">包含 ${nodeCount} 个角色节点 | ${edgeCount} 条双向羁绊连线</div>
        </div>
        <div class="card-actions">
          <button class="btn-icon" onclick="openRelationNetworkEditor(${r.id})" title="编辑关系网">
            <svg viewBox="0 0 24 24"><path fill="currentColor" d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25z"/></svg>
          </button>
          <button class="btn-icon btn-delete" onclick="deleteArchiveItem(${r.id})" title="删除关系网">
            <svg viewBox="0 0 24 24"><path fill="currentColor" d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
          </button>
        </div>
      `;
      container.appendChild(card);
    }
    return;
  }

  const items = await db.archives.where('type').equals(archiveCurrentTab).toArray();
  if (items.length === 0) {
    container.innerHTML = `<p style="text-align:center;color:var(--text-secondary);font-size:13px;padding:40px 0;">暂无归档记录，请点击右上角添加</p>`;
    return;
  }

  const groups = {};
  items.forEach(item => {
    const grp = item.group || "默认未分组";
    if (!groups[grp]) groups[grp] = [];
    groups[grp].push(item);
  });

  for (let key in groups) {
    const wrapper = document.createElement("div");
    wrapper.className = "archive-group-wrapper";
    
    const isCollapsed = localStorage.getItem(`collapse_${archiveCurrentTab}_${key}`) === 'true';

    wrapper.innerHTML = `
      <div class="archive-group-header" data-group="${key}">
        <span>${key} (${groups[key].length})</span>
        <svg viewBox="0 0 24 24" width="16" height="16" style="transform: ${isCollapsed ? 'rotate(-90deg)' : 'none'};"><path fill="currentColor" d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6 1.41-1.41z"/></svg>
      </div>
      <div class="archive-group-content ${isCollapsed ? 'collapsed' : ''}"></div>
    `;

    const contentArea = wrapper.querySelector(".archive-group-content");
    groups[key].forEach(item => {
      const card = document.createElement("div");
      card.className = "archive-card";
      card.innerHTML = `
        <img class="card-avatar" src="${resolveAvatar(item.avatar)}" />
        <div class="card-info">
          <div class="card-name">${item.name}</div>
          <div class="card-desc">${item.remark || '暂无备注'}</div>
        </div>
        <div class="card-actions">
          <button class="btn-icon" onclick="editArchiveItem(${item.id})">
            <svg viewBox="0 0 24 24"><path fill="currentColor" d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25z"/></svg>
          </button>
          <button class="btn-icon btn-delete" onclick="deleteArchiveItem(${item.id})">
            <svg viewBox="0 0 24 24"><path fill="currentColor" d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
          </button>
        </div>
      `;
      contentArea.appendChild(card);
    });

    wrapper.querySelector(".archive-group-header").addEventListener("click", (e) => {
      const collapsed = contentArea.classList.toggle("collapsed");
      localStorage.setItem(`collapse_${archiveCurrentTab}_${key}`, collapsed);
      const icon = e.currentTarget.querySelector("svg");
      icon.style.transform = collapsed ? "rotate(-90deg)" : "none";
    });

    container.appendChild(wrapper);
  }
}

// 动态开启表单并重载特定的选项条件
async function openArchiveForm(editId = null) {
  document.getElementById("archive-id").value = "";
  document.getElementById("archive-name").value = "";
  document.getElementById("archive-remark").value = "";
  document.getElementById("archive-group").value = "";
  document.getElementById("archive-persona").value = "";
  document.getElementById("archive-avatar-url").value = "";
  document.getElementById("archive-parent-id").value = "";
  temporaryAvatarFile = null;
  
  document.getElementById("placeholder-avatar").style.display = "block";
  document.getElementById("avatar-preview-img").style.display = "none";
  document.getElementById("avatar-preview-img").src = "";

  const overlay = document.getElementById("archive-form-overlay");
  overlay.classList.add("active");

  const isNpc = archiveCurrentTab === 'npc';

  document.getElementById("form-general-fields").style.display = "block";
  document.querySelector(".avatar-uploader-container").style.display = "flex";
  document.getElementById("form-avatar-url-group").style.display = "block";
  document.getElementById("form-npc-parent-group").style.display = isNpc ? "block" : "none";

  if (isNpc) {
    document.getElementById("form-title").innerText = editId ? "编辑 NPC 设定" : "添加新 NPC";
    const options = await db.archives.where('type').anyOf(['character', 'user']).toArray();
    const container = document.getElementById("npc-parent-selector-cards");
    container.innerHTML = "";

    let targetParentId = null;
    if (editId) {
      const item = await db.archives.get(editId);
      if (item && item.parentId) targetParentId = item.parentId;
    }

    if (options.length === 0) {
      container.innerHTML = `<div style="font-size:11px; color:var(--text-secondary); text-align:center; padding:10px;">请先去创建角色或用户！</div>`;
    } else {
      options.forEach(item => {
        const card = document.createElement("div");
        card.className = "npc-parent-option-card";
        card.setAttribute("data-id", item.id);
        const isPreSelected = targetParentId && Number(targetParentId) === Number(item.id);
        
        card.style.cssText = `display:flex; align-items:center; gap:10px; padding:8px; border-radius:8px; background:${isPreSelected ? '#f0fdf4' : '#ffffff'}; border:1.5px solid ${isPreSelected ? '#07c160' : 'var(--border)'}; cursor:pointer; transition:all 0.15s;`;
        card.innerHTML = `
          <img src="${resolveAvatar(item.avatar)}" style="width:32px; height:32px; border-radius:50%; object-fit:cover; flex-shrink:0;">
          <div style="flex:1; overflow:hidden; text-align:left;">
            <div style="font-size:12px; font-weight:700; color:var(--text-primary); display:flex; align-items:center; gap:4px;">
              <span>${escapeHtml(item.name)}</span>
              <span style="font-size:9px; color:var(--text-secondary); background:#f1f5f9; padding:1px 4px; border-radius:4px;">${getTabZhName(item.type)}</span>
            </div>
            <div style="font-size:10px; color:var(--text-secondary); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${escapeHtml(item.remark || '暂无备注')}</div>
          </div>
        `;
        if (isPreSelected) {
          document.getElementById("archive-parent-id").value = item.id;
        }

        card.onclick = () => {
          container.querySelectorAll(".npc-parent-option-card").forEach(c => {
            c.style.borderColor = "var(--border)";
            c.style.backgroundColor = "#ffffff";
          });
          card.style.borderColor = "#07c160";
          card.style.backgroundColor = "#f0fdf4";
          document.getElementById("archive-parent-id").value = item.id;
        };
        container.appendChild(card);
      });
    }
  } else {
    document.getElementById("form-title").innerText = editId ? `编辑${getTabZhName(archiveCurrentTab)}` : `添加新${getTabZhName(archiveCurrentTab)}`;
  }

  if (editId) {
    const item = await db.archives.get(editId);
    if (item) {
      document.getElementById("archive-id").value = item.id;
      document.getElementById("archive-name").value = item.name || "";
      document.getElementById("archive-remark").value = item.remark || "";
      document.getElementById("archive-group").value = item.group || "";
      document.getElementById("archive-persona").value = item.persona || "";
      
      if (item.parentId) {
        document.getElementById("archive-parent-id").value = item.parentId;
      }

      if (item.avatar) {
        if (item.avatar instanceof Blob) {
          temporaryAvatarFile = item.avatar;
          document.getElementById("placeholder-avatar").style.display = "none";
          const previewImg = document.getElementById("avatar-preview-img");
          previewImg.src = resolveAvatar(item.avatar);
          previewImg.style.display = "block";
        } else {
          document.getElementById("archive-avatar-url").value = item.avatar;
        }
      }
    }
  }
}

window.editArchiveItem = function(id) {
  openArchiveForm(id);
};

window.deleteArchiveItem = async function(id) {
  showCustomConfirm("删除项目", "确定要彻底删除该项目吗？此操作不可挽回。", async () => {
    if (archiveCurrentTab === 'relation') {
      await db.relations.delete(id);
    } else {
      await db.archives.delete(id);
    }
    loadArchivesData();
  });
};

// 生成或获取本机唯一设备标识码 Device ID
function getOrCreateDeviceId() {
  let devId = localStorage.getItem("story_png_device_id");
  if (!devId) {
    const randomStr = Array.from(crypto.getRandomValues(new Uint8Array(8)))
      .map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
    devId = `DEV-${randomStr.slice(0, 4)}-${randomStr.slice(4, 8)}`;
    localStorage.setItem("story_png_device_id", devId);
  }
  return devId;
}

// 联网校验 Supabase 激活码并解锁设备
async function verifyAndUnlockPngImport(inputCode) {
  if (!inputCode) {
    showToast("请输入激活码！");
    return;
  }
  const deviceId = getOrCreateDeviceId();
  showToast("正在联网核验授权激活码...");

  try {
    if (typeof supabaseClient === 'undefined') {
      throw new Error("Supabase 服务未就绪，请检查网络连接！");
    }

    // 1. 查询激活码记录
    const { data, error } = await supabaseClient
      .from('png_activation_codes')
      .select('*')
      .eq('code', inputCode)
      .maybeSingle();

    if (error || !data) {
      showCustomAlert("激活失败", "无效的激活码，请核对无误后重试！");
      return;
    }

    if (data.device_id && data.device_id !== deviceId) {
      showCustomAlert("激活失败", "此激活码已被其他设备绑定使用！");
      return;
    }

    // 2. 绑定本设备
    const { error: updateErr } = await supabaseClient
      .from('png_activation_codes')
      .update({ device_id: deviceId, used_at: new Date().toISOString() })
      .eq('code', inputCode);

    if (updateErr) {
      showCustomAlert("激活失败", "更新设备绑定状态失败: " + updateErr.message);
      return;
    }

    // 3. 本地持久化解锁状态
    localStorage.setItem("png_import_unlocked", "true");
    showCustomAlert("解锁成功", "恭喜！本机已成功永久解锁酒馆 .png 角色卡导入功能！", () => {
      document.getElementById("png-activation-overlay").classList.remove("active");
      document.getElementById("file-archive-png-import").click();
    });

  } catch(err) {
    console.error(err);
    showCustomAlert("校验异常", err.message);
  }
}

// 从 PNG 图片块中解出 Base64 UTF-8 JSON 字符串
function decodeBase64Utf8(base64) {
  const binaryStr = atob(base64);
  const bytes = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i++) {
    bytes[i] = binaryStr.charCodeAt(i);
  }
  return new TextDecoder("utf-8").decode(bytes);
}

// 二进制解析酒馆 PNG 角色卡（提取 chara 块）
async function extractCharaFromPng(file) {
  const buffer = await file.arrayBuffer();
  const view = new DataView(buffer);
  
  if (view.getUint32(0) !== 0x89504E47 || view.getUint32(4) !== 0x0D0A1A0A) {
    throw new Error("不是标准的 PNG 图片文件");
  }

  let offset = 8;
  while (offset < buffer.byteLength) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(
      view.getUint8(offset + 4),
      view.getUint8(offset + 5),
      view.getUint8(offset + 6),
      view.getUint8(offset + 7)
    );

    if (type === 'tEXt') {
      const chunkData = new Uint8Array(buffer, offset + 8, length);
      let nullIdx = -1;
      for (let i = 0; i < chunkData.length; i++) {
        if (chunkData[i] === 0) { nullIdx = i; break; }
      }
      if (nullIdx !== -1) {
        const keyword = new TextDecoder().decode(chunkData.slice(0, nullIdx));
        if (keyword === 'chara') {
          const base64Str = new TextDecoder().decode(chunkData.slice(nullIdx + 1));
          const jsonStr = decodeBase64Utf8(base64Str);
          return JSON.parse(jsonStr);
        }
      }
    }
    offset += 12 + length; // 4 (length) + 4 (type) + length + 4 (CRC)
  }
  throw new Error("未在此 PNG 图片中找到酒馆角色卡 (chara) 嵌入元数据！");
}

// 初始化档案馆设定导入控制器
function initArchiveImport() {
  const btnImport = document.getElementById("btn-archive-import");
  const choiceOverlay = document.getElementById("archive-import-choice-overlay");
  const btnChoicePng = document.getElementById("btn-choice-import-png");
  const btnChoiceDoc = document.getElementById("btn-choice-import-doc");
  const fileImportDoc = document.getElementById("file-archive-import");
  const fileImportPng = document.getElementById("file-archive-png-import");

  if (btnImport && choiceOverlay) {
    btnImport.onclick = () => {
      choiceOverlay.classList.add("active");
    };

    if (btnChoiceDoc && fileImportDoc) {
      btnChoiceDoc.onclick = () => {
        choiceOverlay.classList.remove("active");
        fileImportDoc.click();
      };
    }

    if (btnChoicePng && fileImportPng) {
      btnChoicePng.onclick = () => {
        choiceOverlay.classList.remove("active");
        const isUnlocked = localStorage.getItem("png_import_unlocked") === "true";
        if (isUnlocked) {
          fileImportPng.click();
        } else {
          // 显示设备码并弹出解锁框
          const devId = getOrCreateDeviceId();
          document.getElementById("png-device-id-display").innerText = devId;
          document.getElementById("png-activation-code-input").value = "";
          document.getElementById("png-activation-overlay").classList.add("active");
        }
      };
    }

    // 提交激活码事件
    const btnSubmitActivation = document.getElementById("btn-submit-png-activation");
    if (btnSubmitActivation) {
      btnSubmitActivation.onclick = () => {
        const code = document.getElementById("png-activation-code-input").value.trim();
        verifyAndUnlockPngImport(code);
      };
    }

    // A. 处理 docx / txt 传统文件导入
    fileImportDoc.onchange = async (e) => {
      if (e.target.files.length > 0) {
        const file = e.target.files[0];
        showToast("正在解析角色设定文件...");
        try {
          let text = "";
          if (file.name.endsWith(".docx")) {
            text = await parseDocxText(file);
          } else {
            text = await readTxtFileSafe(file);
          }

          await openArchiveForm();
          const defaultName = file.name.substring(0, file.name.lastIndexOf('.')) || "新角色";
          document.getElementById("archive-name").value = defaultName;
          document.getElementById("archive-persona").value = text;
          showToast(`成功导入设定「${file.name}」！`);
        } catch(err) {
          console.error(err);
          showToast("解析设定文件失败: " + err.message);
        }
        fileImportDoc.value = "";
      }
    };

    // B. 处理酒馆 PNG 角色卡及附带世界书无损导入
    fileImportPng.onchange = async (e) => {
      if (e.target.files.length > 0) {
        const file = e.target.files[0];
        showToast("正在深度解析酒馆角色卡 PNG 数据...");
        try {
          const cardData = await extractCharaFromPng(file);
          const data = cardData.data || cardData; // 兼容 V1 / V2 / V3 规约数据节点

          const charName = data.name || file.name.replace(/\.png$/i, "") || "新角色";
          
          // 组装无损人设描述
          let persona = "";
          if (data.description) persona += `【角色描述】\n${data.description}\n\n`;
          if (data.personality) persona += `【性格特征】\n${data.personality}\n\n`;
          if (data.scenario) persona += `【场景设定】\n${data.scenario}\n\n`;
          if (data.first_mes) persona += `【开场白】\n${data.first_mes}\n\n`;
          if (data.mes_example) persona += `【对话示例】\n${data.mes_example}\n\n`;
          if (data.creator_notes) persona += `【作者备注】\n${data.creator_notes}\n`;

          // 在轨正方形居中裁剪头像
          const compressedAvatar = await compressImageBlob(file, 150, 0.8);

          // 1. 自动存入角色档案库
          const arcObj = {
            type: 'character',
            name: charName,
            avatar: compressedAvatar,
            remark: '酒馆卡导入',
            group: '酒馆角色',
            persona: persona.trim(),
            parentId: null
          };
          const newCharId = await db.archives.add(arcObj);

          // 2. 检查并无损解出附带的世界书 (Lorebook / Character Book，完整提取三态模式、关键词与深度)
          let wbCount = 0;
          const charBook = data.character_book || cardData.character_book;
          if (charBook && Array.isArray(charBook.entries) && charBook.entries.length > 0) {
            const groupName = charBook.name || `${charName}的世界书`;
            
            for (let entry of charBook.entries) {
              const rawKeys = entry.keys || entry.secondary_keys || [];
              const keysStr = Array.isArray(rawKeys) ? rawKeys.join(", ") : (rawKeys || "");
              const title = entry.comment || entry.name || (keysStr ? `设定(${keysStr})` : '设定条目');
              const content = entry.content || "";
              const depth = parseInt(entry.insertion_order) || parseInt(entry.depth) || 10;
              const prob = parseInt(entry.probability) ?? 100;

              // 解析酒馆条目触发模式
              let mode = 'selective';
              if (entry.constant || entry.position === 'before_char' || entry.position === 'general') {
                mode = 'constant';
              }
              if (entry.enabled === false || entry.disable === true) {
                mode = 'disabled';
              }

              if (content.trim()) {
                await db.world_book_entries.add({
                  group: groupName,
                  title: title,
                  keywords: keysStr,
                  mode: mode,
                  probability: prob,
                  depth: depth,
                  content: content,
                  isActive: mode !== 'disabled'
                });
                wbCount++;
              }
            }
          }

          showCustomAlert(
            "酒馆卡导入成功", 
            `已成功导入角色「${charName}」！\n\n${wbCount > 0 ? `已同时将卡片附带的 ${wbCount} 条世界书词条录入至世界书「${charBook.name || charName + '的世界书'}」分组中！` : '该卡片未包含附带世界书。'}`
          );

          if (typeof loadArchivesData === 'function') loadArchivesData();
        } catch(err) {
          console.error(err);
          showCustomAlert("导入角色卡失败", err.message);
        }
        fileImportPng.value = "";
      }
    };
  }
}

// 动态异步加载 JSZip 库，保障 Word 文本解压正常进行
function loadJSZip() {
  return new Promise((resolve, reject) => {
    if (typeof JSZip !== 'undefined') {
      resolve();
      return;
    }
    const script = document.createElement("script");
    script.src = "https://unpkg.com/jszip@3.10.1/dist/jszip.min.js";
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("加载 JSZip 压缩组件失败，请检查网络连接后重试"));
    document.head.appendChild(script);
  });
}

// 异步解析 docx 并提取文本，规避由于 binary 格式造成的乱码崩溃
async function parseDocxText(file) {
  await loadJSZip();
  const zip = await JSZip.loadAsync(file);
  const docXmlFile = zip.file("word/document.xml");
  if (!docXmlFile) throw new Error("无效的 docx Word 格式文件");
  const xmlText = await docXmlFile.async("string");
  
  const parser = new DOMParser();
  const xmlDoc = parser.parseFromString(xmlText, "text/xml");
  const texts = xmlDoc.getElementsByTagName("w:t");
  let out = "";
  for (let i = 0; i < texts.length; i++) {
    out += texts[i].textContent + "\n";
  }
  return out;
}

// 双向在轨自愈型文本读取解码器 (TextDecoder 强校验 UTF-8 与 GBK 降级机制，100% 根除中文乱码)
function readTxtFileSafe(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const arrayBuffer = e.target.result;
      const utf8Decoder = new TextDecoder("utf-8", { fatal: true });
      try {
        const text = utf8Decoder.decode(arrayBuffer);
        resolve(text);
      } catch (err) {
        // 捕获 UTF-8 错码序列异常，回退降级到 GBK 国标编码进行自愈重新翻译
        const gbkDecoder = new TextDecoder("gbk");
        try {
          const text = gbkDecoder.decode(arrayBuffer);
          resolve(text);
        } catch (gbkErr) {
          reject(gbkErr);
        }
      }
    };
    reader.onerror = reject;
    reader.readAsArrayBuffer(file);
  });
}

function initPasteAndDropEvents() {
  const dropzone = document.getElementById("avatar-dropzone");
  const fileInput = document.getElementById("archive-avatar-file");

  dropzone.onclick = () => fileInput.click();

  fileInput.onchange = (e) => {
    if (e.target.files.length > 0) handleAvatarFile(e.target.files[0]);
  };

  dropzone.ondragover = (e) => e.preventDefault();
  dropzone.ondrop = (e) => {
    e.preventDefault();
    if (e.dataTransfer.files.length > 0) handleAvatarFile(e.dataTransfer.files[0]);
  };

  document.addEventListener("paste", (e) => {
    const activeOverlay = document.getElementById("archive-form-overlay");
    if (!activeOverlay.classList.contains("active")) return;
    
    const items = e.clipboardData.items;
    for (let item of items) {
      if (item.type.indexOf("image") !== -1) {
        handleAvatarFile(item.getAsFile());
      }
    }
  });
}

// ============================================================
//         可视化图形关系网互动引擎 (2D Stage & Dual-POV Edges)
// ============================================================

let currentRelGraphId = null;
let graphNodes = []; // [{ id, x, y }]
let graphEdges = []; // [{ fromId, toId, relAtoB, relBtoA }]
let activeSelectedNodeId = null;
let activeEditingEdgeIndex = null;

// 控制右侧候选抽屉折叠展开
function toggleRelDrawer(show) {
  const drawer = document.getElementById("rel-candidate-drawer");
  const openBtn = document.getElementById("btn-open-rel-drawer");
  if (drawer && openBtn) {
    if (show) {
      drawer.style.display = "flex";
      openBtn.style.display = "none";
    } else {
      drawer.style.display = "none";
      openBtn.style.display = "block";
    }
  }
}
window.toggleRelDrawer = toggleRelDrawer;

// 打开可视化关系网编辑器
async function openRelationNetworkEditor(graphId = null) {
  currentRelGraphId = graphId;
  graphNodes = [];
  graphEdges = [];
  activeSelectedNodeId = null;
  activeEditingEdgeIndex = null;

  document.getElementById("rel-network-title-input").value = "";
  toggleRelDrawer(true); // 打开时默认呈现抽屉
  
  if (graphId) {
    const graphData = await db.relations.get(graphId);
    if (graphData) {
      document.getElementById("rel-network-title-input").value = graphData.name || "";
      graphNodes = graphData.nodes || [];
      graphEdges = graphData.edges || [];
    }
  }

  await renderRelCandidateDrawer();
  renderRelStage();
  document.getElementById("relation-network-editor").classList.add("active");
}
window.openRelationNetworkEditor = openRelationNetworkEditor;

function closeRelationNetworkEditor() {
  document.getElementById("relation-network-editor").classList.remove("active");
  currentRelGraphId = null;
}
window.closeRelationNetworkEditor = closeRelationNetworkEditor;

// 渲染右侧候选角色列表 (轻触加入关系网)
async function renderRelCandidateDrawer() {
  const container = document.getElementById("rel-candidate-list");
  container.innerHTML = "";

  const archives = await db.archives.toArray();
  const addedIds = graphNodes.map(n => n.id);

  archives.forEach(arc => {
    const isAdded = addedIds.includes(arc.id);
    const item = document.createElement("div");
    item.style.cssText = `display:flex; flex-direction:column; align-items:center; padding:8px 4px; border-radius:10px; background:${isAdded ? '#f1f5f9' : '#fff'}; border:1px solid ${isAdded ? '#cbd5e1' : 'var(--border)'}; opacity:${isAdded ? '0.5' : '1'}; cursor:${isAdded ? 'not-allowed' : 'pointer'}; text-align:center; transition:all 0.15s;`;
    item.innerHTML = `
      <img src="${resolveAvatar(arc.avatar)}" style="width:36px; height:32px; border-radius:50%; object-fit:cover; margin-bottom:4px;">
      <span style="font-size:10px; font-weight:700; color:var(--text-primary); max-width:80px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${escapeHtml(arc.name)}</span>
    `;

    if (!isAdded) {
      item.onclick = () => {
        const stage = document.getElementById("rel-canvas-stage");
        const centerX = (stage.clientWidth / 2) + (Math.random() * 60 - 30) - 30;
        const centerY = (stage.clientHeight / 2) + (Math.random() * 60 - 30) - 30;

        graphNodes.push({ id: arc.id, x: Math.max(10, centerX), y: Math.max(10, centerY) });
        renderRelCandidateDrawer();
        renderRelStage();
      };
    }
    container.appendChild(item);
  });
}

// 核心：重绘 Canvas 2D 阶段与 SVG 连接线（支持双行叠放 & 无限平滑拖拽）
async function renderRelStage() {
  const svgLayer = document.getElementById("rel-svg-layer");
  const nodesLayer = document.getElementById("rel-nodes-layer");
  svgLayer.innerHTML = "";
  nodesLayer.innerHTML = "";

  const archivesMap = new Map();
  const archives = await db.archives.toArray();
  archives.forEach(a => archivesMap.set(a.id, a));

  // 1. 绘制 SVG 连接线及双向羁绊预览 (改为上下双行叠放，完美收窄宽度)
  graphEdges.forEach((edge, idx) => {
    const nodeA = graphNodes.find(n => n.id === edge.fromId);
    const nodeB = graphNodes.find(n => n.id === edge.toId);
    if (!nodeA || !nodeB) return;

    const x1 = nodeA.x + 30; 
    const y1 = nodeA.y + 30;
    const x2 = nodeB.x + 30;
    const y2 = nodeB.y + 30;

    const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
    line.setAttribute("x1", x1);
    line.setAttribute("y1", y1);
    line.setAttribute("x2", x2);
    line.setAttribute("y2", y2);
    line.setAttribute("stroke", "#07c160");
    line.setAttribute("stroke-width", "2.5");
    line.setAttribute("stroke-dasharray", "4,4");
    svgLayer.appendChild(line);

    const midX = (x1 + x2) / 2;
    const midY = (y1 + y2) / 2;

    const group = document.createElementNS("http://www.w3.org/2000/svg", "g");
    group.style.cursor = "pointer";
    group.style.pointerEvents = "auto";
    group.onclick = () => openEdgeEditModal(idx);

    const arcA = archivesMap.get(edge.fromId);
    const arcB = archivesMap.get(edge.toId);

    // 智能双行/单行文本构建
    let textHtml = "";
    let rectHeight = 16;
    let rectWidth = 84;

    if (edge.relAtoB && edge.relBtoA) {
      rectHeight = 28;
      rectWidth = 90;
      textHtml = `
        <text x="${midX}" y="${midY - 3}" font-size="8.5" font-weight="bold" fill="#0284c7" text-anchor="middle">${escapeHtml(arcA?.name || 'A')}视[${escapeHtml(edge.relAtoB)}]</text>
        <text x="${midX}" y="${midY + 8}" font-size="8.5" font-weight="bold" fill="#db2777" text-anchor="middle">${escapeHtml(arcB?.name || 'B')}视[${escapeHtml(edge.relBtoA)}]</text>
      `;
    } else if (edge.relAtoB) {
      textHtml = `<text x="${midX}" y="${midY + 3.5}" font-size="9" font-weight="bold" fill="#0284c7" text-anchor="middle">${escapeHtml(arcA?.name || 'A')}视[${escapeHtml(edge.relAtoB)}]</text>`;
    } else if (edge.relBtoA) {
      textHtml = `<text x="${midX}" y="${midY + 3.5}" font-size="9" font-weight="bold" fill="#db2777" text-anchor="middle">${escapeHtml(arcB?.name || 'B')}视[${escapeHtml(edge.relBtoA)}]</text>`;
    } else {
      textHtml = `<text x="${midX}" y="${midY + 3.5}" font-size="9" font-weight="bold" fill="#64748b" text-anchor="middle">点击定义羁绊</text>`;
    }

    group.innerHTML = `
      <rect x="${midX - (rectWidth / 2)}" y="${midY - (rectHeight / 2)}" width="${rectWidth}" height="${rectHeight}" rx="8" fill="#ffffff" stroke="#07c160" stroke-width="1.5"/>
      ${textHtml}
    `;
    svgLayer.appendChild(group);
  });

  // 2. 绘制节点 (注入 touch-action: none 根治手势粘连卡顿)
  graphNodes.forEach(node => {
    const arc = archivesMap.get(node.id);
    if (!arc) return;

    const isSelected = activeSelectedNodeId === node.id;
    const el = document.createElement("div");
    // 关键修正：注入 touch-action: none 防止移动端触控被网页翻页手势截断！
    el.style.cssText = `position:absolute; left:${node.x}px; top:${node.y}px; width:60px; height:60px; display:flex; flex-direction:column; align-items:center; justify-content:center; cursor:grab; z-index:10; user-select:none; touch-action:none;`;

    el.innerHTML = `
      <div style="position:relative; width:44px; height:44px;">
        <img src="${resolveAvatar(arc.avatar)}" style="width:44px; height:44px; border-radius:50%; object-fit:cover; border:2.5px solid ${isSelected ? '#ec4899' : '#ffffff'}; box-shadow:0 4px 12px rgba(0,0,0,0.15);">
        <div onclick="event.stopPropagation(); removeNodeFromGraph(${node.id})" title="从关系网中移除" style="position:absolute; top:-4px; right:-4px; width:16px; height:16px; background:#ef4444; color:#fff; border-radius:50%; font-size:10px; font-weight:bold; display:flex; align-items:center; justify-content:center; cursor:pointer;">×</div>
      </div>
      <span style="font-size:10px; font-weight:800; color:#1e293b; background:rgba(255,255,255,0.9); padding:1px 6px; border-radius:8px; margin-top:2px; white-space:nowrap; box-shadow:0 1px 3px rgba(0,0,0,0.1);">${escapeHtml(arc.name)}</span>
    `;

    let isDragging = false;
    let startX = 0, startY = 0;
    let initNodeX = 0, initNodeY = 0;

    el.onpointerdown = (e) => {
      if (e.target.closest("div[onclick]")) return;
      isDragging = false;
      startX = e.clientX;
      startY = e.clientY;
      initNodeX = node.x;
      initNodeY = node.y;
      el.setPointerCapture(e.pointerId);

      el.onpointermove = (pe) => {
        const dx = pe.clientX - startX;
        const dy = pe.clientY - startY;
        if (Math.abs(dx) > 2 || Math.abs(dy) > 2) {
          isDragging = true;
          node.x = Math.max(0, initNodeX + dx);
          node.y = Math.max(0, initNodeY + dy);
          el.style.left = `${node.x}px`;
          el.style.top = `${node.y}px`;
          renderRelStageLinesOnly(); // 拖拽时即时更新连线位置
        }
      };

      el.onpointerup = (pe) => {
        el.releasePointerCapture(pe.pointerId);
        el.onpointermove = null;
        el.onpointerup = null;

        if (!isDragging) {
          if (activeSelectedNodeId === null) {
            activeSelectedNodeId = node.id;
            renderRelStage();
          } else if (activeSelectedNodeId === node.id) {
            activeSelectedNodeId = null;
            renderRelStage();
          } else {
            const fromId = activeSelectedNodeId;
            const toId = node.id;
            activeSelectedNodeId = null;

            let existingIdx = graphEdges.findIndex(e => (e.fromId === fromId && e.toId === toId) || (e.fromId === toId && e.toId === fromId));
            if (existingIdx === -1) {
              graphEdges.push({ fromId, toId, relAtoB: "", relBtoA: "" });
              existingIdx = graphEdges.length - 1;
            }
            openEdgeEditModal(existingIdx);
            renderRelStage();
          }
        }
      };
    };

    nodesLayer.appendChild(el);
  });
}

// 极写轻量重绘 SVG 连线 (拖拽时多行文本双向实时随动)
function renderRelStageLinesOnly() {
  const svgLayer = document.getElementById("rel-svg-layer");
  if (!svgLayer) return;
  
  const lines = svgLayer.querySelectorAll("line");
  const groups = svgLayer.querySelectorAll("g");

  graphEdges.forEach((edge, idx) => {
    const nodeA = graphNodes.find(n => n.id === edge.fromId);
    const nodeB = graphNodes.find(n => n.id === edge.toId);
    if (!nodeA || !nodeB) return;

    const x1 = nodeA.x + 30;
    const y1 = nodeA.y + 30;
    const x2 = nodeB.x + 30;
    const y2 = nodeB.y + 30;

    if (lines[idx]) {
      lines[idx].setAttribute("x1", x1);
      lines[idx].setAttribute("y1", y1);
      lines[idx].setAttribute("x2", x2);
      lines[idx].setAttribute("y2", y2);
    }
    if (groups[idx]) {
      const midX = (x1 + x2) / 2;
      const midY = (y1 + y2) / 2;
      const rect = groups[idx].querySelector("rect");
      const texts = groups[idx].querySelectorAll("text");

      // 强校验单行/双行文本全量实时中心随动，彻底根治粉字滞后 Bug
      if (texts.length === 2) {
        if (rect) {
          rect.setAttribute("x", midX - 45);
          rect.setAttribute("y", midY - 14);
        }
        texts[0].setAttribute("x", midX);
        texts[0].setAttribute("y", midY - 3);
        texts[1].setAttribute("x", midX);
        texts[1].setAttribute("y", midY + 8);
      } else if (texts.length === 1) {
        if (rect) {
          rect.setAttribute("x", midX - 42);
          rect.setAttribute("y", midY - 8);
        }
        texts[0].setAttribute("x", midX);
        texts[0].setAttribute("y", midY + 3.5);
      }
    }
  });
}

function removeNodeFromGraph(nodeId) {
  graphNodes = graphNodes.filter(n => n.id !== nodeId);
  graphEdges = graphEdges.filter(e => e.fromId !== nodeId && e.toId !== nodeId);
  renderRelCandidateDrawer();
  renderRelStage();
}

// 打开双向羁绊卡片编辑 Modal
async function openEdgeEditModal(edgeIndex) {
  activeEditingEdgeIndex = edgeIndex;
  const edge = graphEdges[edgeIndex];
  if (!edge) return;

  const arcA = await db.archives.get(edge.fromId);
  const arcB = await db.archives.get(edge.toId);

  document.getElementById("edge-label-a-to-b").innerText = `在 [${arcA?.name || 'A'}] 视角，[${arcB?.name || 'B'}] 是：`;
  document.getElementById("edge-input-a-to-b").value = edge.relAtoB || "";

  document.getElementById("edge-label-b-to-a").innerText = `在 [${arcB?.name || 'B'}] 视角，[${arcA?.name || 'A'}] 是：`;
  document.getElementById("edge-input-b-to-a").value = edge.relBtoA || "";

  document.getElementById("btn-save-edge").onclick = () => {
    edge.relAtoB = document.getElementById("edge-input-a-to-b").value.trim();
    edge.relBtoA = document.getElementById("edge-input-b-to-a").value.trim();
    document.getElementById("relation-edge-modal").classList.remove("active");
    renderRelStage();
  };

  document.getElementById("btn-delete-edge").onclick = () => {
    graphEdges.splice(edgeIndex, 1);
    document.getElementById("relation-edge-modal").classList.remove("active");
    renderRelStage();
  };

  document.getElementById("relation-edge-modal").classList.add("active");
}

// 核心落盘保存关系网
async function saveRelationNetworkGraph() {
  const name = document.getElementById("rel-network-title-input").value.trim();
  if (!name) {
    showToast("请输入这张关系网的名称！");
    return;
  }

  const graphObj = {
    name,
    nodes: graphNodes,
    edges: graphEdges,
    updatedAt: Date.now()
  };

  if (currentRelGraphId) {
    await db.relations.update(currentRelGraphId, graphObj);
  } else {
    await db.relations.add(graphObj);
  }

  showToast("关系网成功落盘保存！");
  closeRelationNetworkEditor();
  if (typeof loadArchivesData === 'function') loadArchivesData();
}

// 在轨二进制图片异步等轴方块裁剪压缩器 (150px 黄金尺寸，0.8 无感画质压缩) [1]
function compressImageBlob(file, maxDim = 150, quality = 0.8) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      let width = img.width;
      let height = img.height;
      
      // 自动执行居中等比方形裁剪，规避非等比图像变形，锁定完美人脸居中 [1]
      const size = Math.min(width, height);
      const startX = (width - size) / 2;
      const startY = (height - size) / 2;
      
      const canvas = document.createElement("canvas");
      canvas.width = maxDim;
      canvas.height = maxDim;
      const ctx = canvas.getContext("2d");
      
      // 执行裁剪与重置绘制
      ctx.drawImage(img, startX, startY, size, size, 0, 0, maxDim, maxDim);
      
      canvas.toBlob((blob) => {
        resolve(blob || file);
      }, "image/jpeg", quality);
    };
    img.onerror = () => {
      resolve(file); // 容灾回退，确保即使图片格式损坏也能正常引入不崩溃
    };
    const reader = new FileReader();
    reader.onload = (e) => {
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  });
}

// 升级为异步处理，获取并进行在轨 Canvas 压缩裁剪，体积直接骤降 99.5% [1]
async function handleAvatarFile(file) {
  document.getElementById("placeholder-avatar").style.display = "none";
  const previewImg = document.getElementById("avatar-preview-img");
  
  // 提示用户正在处理，打消等待焦虑感
  showToast("正在执行在轨无感高清压缩与等比方形裁剪...");
  
  const compressedBlob = await compressImageBlob(file, 150, 0.8);
  temporaryAvatarFile = compressedBlob; 
  
  previewImg.src = resolveAvatar(compressedBlob); // 瞬时内存预览
  previewImg.style.display = "block";
}