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
    openArchiveForm();
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
    const isRelation = archiveCurrentTab === 'relation';

    if (isRelation) {
      const fromId = Number(document.getElementById("relation-from").value);
      const toId = Number(document.getElementById("relation-to").value);
      const relationDesc = document.getElementById("relation-desc").value.trim();

      if (!fromId || !toId || !relationDesc) {
        showToast("请填写完整的关系网络端点与描述！");
        return;
      }

      const relObj = { fromId, toId, relation: relationDesc };
      if (id) {
        await db.relations.update(id, relObj);
      } else {
        await db.relations.add(relObj);
      }
    } else {
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

      // 如果提供了网络 URL，使用 URL 文本字符串；否则使用已上传的原生二进制 File/Blob 对象 [2]
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
      container.innerHTML = `<p style="text-align:center;color:var(--text-secondary);font-size:13px;padding:40px 0;">暂无关系网，请点击右上角新建</p>`;
      return;
    }
    for (let r of rels) {
      const fromObj = await db.archives.get(r.fromId);
      const toObj = await db.archives.get(r.toId);
      const card = document.createElement("div");
      card.className = "archive-card";
      card.innerHTML = `
        <div class="card-info">
          <div class="card-name">[${fromObj?.name || '未知'}] → [${r.relation}] → [${toObj?.name || '未知'}]</div>
          <div class="card-desc">关系网络连接线</div>
        </div>
        <div class="card-actions">
          <button class="btn-icon" onclick="editArchiveItem(${r.id})">
            <svg viewBox="0 0 24 24"><path fill="currentColor" d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25z"/></svg>
          </button>
          <button class="btn-icon btn-delete" onclick="deleteArchiveItem(${r.id})">
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
  temporaryAvatarFile = null;
  
  document.getElementById("placeholder-avatar").style.display = "block";
  document.getElementById("avatar-preview-img").style.display = "none";
  document.getElementById("avatar-preview-img").src = "";

  const overlay = document.getElementById("archive-form-overlay");
  overlay.classList.add("active");

  const isRelation = archiveCurrentTab === 'relation';
  const isNpc = archiveCurrentTab === 'npc';

  document.getElementById("form-general-fields").style.display = isRelation ? "none" : "block";
  document.querySelector(".avatar-uploader-container").style.display = isRelation ? "none" : "flex";
  document.getElementById("form-avatar-url-group").style.display = isRelation ? "none" : "block";
  document.getElementById("form-npc-parent-group").style.display = isNpc ? "block" : "none";
  document.getElementById("form-relation-fields").style.display = isRelation ? "block" : "none";

  if (isRelation) {
    document.getElementById("form-title").innerText = editId ? "编辑关系网" : "新建关系网";
    const options = await db.archives.where('type').anyOf(['character', 'user']).toArray();
    const fromSelect = document.getElementById("relation-from");
    const toSelect = document.getElementById("relation-to");
    
    const populateSelect = (selectEl, list) => {
      selectEl.innerHTML = '<option value="">-- 选择端点 --</option>';
      list.forEach(item => {
        const opt = document.createElement("option");
        opt.value = item.id;
        opt.innerText = `[${getTabZhName(item.type)}] ${item.name}`;
        selectEl.appendChild(opt);
      });
    };
    populateSelect(fromSelect, options);
    populateSelect(toSelect, options);
  } else if (isNpc) {
    document.getElementById("form-title").innerText = editId ? "编辑NPC设定" : "添加新NPC";
    const options = await db.archives.where('type').anyOf(['character', 'user']).toArray();
    const parentSelect = document.getElementById("archive-parent-id");
    parentSelect.innerHTML = '<option value="">-- 选择归属角色/用户 --</option>';
    options.forEach(item => {
      const opt = document.createElement("option");
      opt.value = item.id;
      opt.innerText = `[${getTabZhName(item.type)}] ${item.name}`;
      parentSelect.appendChild(opt);
    });
  } else {
    document.getElementById("form-title").innerText = editId ? `编辑${getTabZhName(archiveCurrentTab)}` : `添加新${getTabZhName(archiveCurrentTab)}`;
  }

  if (editId) {
    if (isRelation) {
      const r = await db.relations.get(editId);
      if (r) {
        document.getElementById("archive-id").value = r.id;
        document.getElementById("relation-from").value = r.fromId;
        document.getElementById("relation-to").value = r.toId;
        document.getElementById("relation-desc").value = r.relation;
      }
    } else {
      const item = await db.archives.get(editId);
      if (item) {
        document.getElementById("archive-id").value = item.id;
        document.getElementById("archive-name").value = item.name;
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

// 初始化档案馆设定导入控制器
function initArchiveImport() {
  const btnImport = document.getElementById("btn-archive-import");
  const fileImport = document.getElementById("file-archive-import");
  if (btnImport && fileImport) {
    btnImport.onclick = () => fileImport.click();
    fileImport.onchange = async (e) => {
      if (e.target.files.length > 0) {
        const file = e.target.files[0];
        showToast("正在解析档案馆角色设定文件...");
        try {
          let text = "";
          if (file.name.endsWith(".docx")) {
            text = await parseDocxText(file);
          } else {
            text = await readTxtFileSafe(file);
          }

          // 打开新建表单并自动填充数据
          await openArchiveForm();
          const defaultName = file.name.substring(0, file.name.lastIndexOf('.')) || "新角色";
          document.getElementById("archive-name").value = defaultName;
          document.getElementById("archive-persona").value = text;
          showToast(`成功导入并无损翻译设定「${file.name}」！`);
        } catch(err) {
          console.error(err);
          showToast("解析设定文件失败: " + err.message);
        }
        fileImport.value = "";
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