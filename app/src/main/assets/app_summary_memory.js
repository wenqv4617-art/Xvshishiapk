/**
 * app_summary_memory.js - 对话自动/手动总结与核心记忆关联召回系统
 */

// 向量检索基础余弦相似度算法及 native 绑定桥 [1]
function cosineSimilarity(vecA, vecB) {
  if (!vecA || !vecB || vecA.length !== vecB.length) return 0;
  let dotProduct = 0.0;
  let normA = 0.0;
  let normB = 0.0;
  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

async function safeGetEmbedding(text) {
  if (window.AndroidMCP && typeof window.AndroidMCP.getEmbedding === 'function') {
    try {
      const res = window.AndroidMCP.getEmbedding(text);
      if (res) return JSON.parse(res);
    } catch(e) {
      console.error("生成本地 ONNX 向量失败:", e);
    }
  }
  return null;
}

// 1. 提取对话轮次列表算法 (一轮 = user连续发言段 + char连续回复段)
function getRoundsList(messages) {
  let rounds = [];
  let currentRound = { userMsgContent: "", charMsgContent: "", timestamp: 0 };
  
  for (let m of messages) {
    if (m.senderType === 'user') {
      if (currentRound.userMsgContent && currentRound.charMsgContent) {
        rounds.push(currentRound);
        currentRound = { userMsgContent: "", charMsgContent: "", timestamp: 0 };
      }
      currentRound.userMsgContent = currentRound.userMsgContent 
        ? currentRound.userMsgContent + "\n" + m.content 
        : m.content;
      currentRound.timestamp = m.timestamp;
    } else if (m.senderType === 'char') {
      if (currentRound.userMsgContent) {
        currentRound.charMsgContent = currentRound.charMsgContent 
          ? currentRound.charMsgContent + "\n" + m.content 
          : m.content;
      }
    }
  }
  if (currentRound.userMsgContent && currentRound.charMsgContent) {
    rounds.push(currentRound);
  }
  return rounds;
}

// 2. 核心：检索召回机制 (支持传统关键词匹配，以及升级后的本地向量高精检索及衰减时间 λ) [1]
async function retrieveSummaries(sessionId, latestUserMessageText) {
  const allSummaries = await db.summaries.where('sessionId').equals(sessionId).sortBy('startRound');
  if (allSummaries.length === 0) return [];

  // 固定优先包含最后生成的 5 条碎片总结，保留基本上下文
  const recentSummaries = allSummaries.slice(-5);
  const recentIds = new Set(recentSummaries.map(s => s.id));

  const otherSummaries = allSummaries.filter(s => !recentIds.has(s.id));
  let matchedSummaries = [];

  const isVectorEnabled = localStorage.getItem("settings-vector-enabled") === "true";
  let queryVector = null;

  if (isVectorEnabled && latestUserMessageText) {
    queryVector = await safeGetEmbedding(latestUserMessageText);
  }

  if (queryVector && otherSummaries.length > 0) {
    const decayType = localStorage.getItem("vector-decay-type") || "medium";
    let lambda = 0.05; // 默认新旧平衡衰减系数
    if (decayType === "high") lambda = 0.5; // 看重近期记忆
    else if (decayType === "low") lambda = 0.001; // 看重久远记忆

    const threshold = parseFloat(localStorage.getItem("vector-threshold") || "0.55");
    const topk = parseInt(localStorage.getItem("vector-topk") || "3");

    const scoredSummaries = [];
    otherSummaries.forEach(s => {
      if (s.vector) {
        const sim = cosineSimilarity(queryVector, s.vector);
        const daysAgo = (Date.now() - s.timestamp) / (1000 * 60 * 60 * 24);
        const decayFactor = Math.exp(-lambda * daysAgo);
        const score = sim * decayFactor;

        if (score >= threshold) {
          scoredSummaries.push({ s, score });
        }
      }
    });

    scoredSummaries.sort((a, b) => b.score - a.score);
    matchedSummaries = scoredSummaries.slice(0, topk).map(item => item.s);
  } else if (latestUserMessageText && otherSummaries.length > 0) {
    // 兜底降级：执行原有关键词模糊匹配
    const cleanedInput = latestUserMessageText.toLowerCase();
    otherSummaries.forEach(s => {
      let keywords = [];
      try { keywords = JSON.parse(s.keywords || "[]"); } catch(e){}
      
      const isMatch = keywords.some(k => cleanedInput.includes(k.toLowerCase()) || s.content.toLowerCase().includes(k.toLowerCase()));
      if (isMatch) {
        matchedSummaries.push(s);
      }
    });
    
    if (matchedSummaries.length > 20) {
      const selected = [];
      for (let j = 0; j < 20; j++) {
        const index = Math.floor(j * matchedSummaries.length / 20);
        selected.push(matchedSummaries[index]);
      }
      matchedSummaries = selected;
    }
  }

  const combined = [...recentSummaries, ...matchedSummaries];
  const uniqueMap = new Map();
  combined.forEach(s => uniqueMap.set(s.id, s));
  
  return Array.from(uniqueMap.values()).sort((a,b) => a.startRound - b.startRound);
}

// 3. AI 总结碎片生成器 (升级为双响应协议，高自愈性多模块解析及向量写入通道) [1]
async function generateSummaryForRounds(sessionId, startRound, endRound, customPrompt) {
  const presetId = localStorage.getItem("global_api_preset_id");
  const api = await db.api_presets.get(Number(presetId));
  if (!api) throw new Error("无法加载 API 配置，总结失败。");

  const rawMsgs = await db.messages.where('sessionId').equals(sessionId).sortBy('timestamp');
  const rounds = getRoundsList(rawMsgs);

  if (rounds.length < endRound) return;

  let dialogText = "";
  for (let i = startRound - 1; i < endRound; i++) {
    dialogText += `[轮次 ${i+1}]\n用户: ${rounds[i].userMsgContent}\n对方: ${rounds[i].charMsgContent}\n\n`;
  }

  const formatChoice = localStorage.getItem("summary-format-choice") || "json";
  let systemPrompt = "";

  if (formatChoice === "json") {
    systemPrompt = `你是一个长周期记忆整合引擎。请对以下发生的对话轮次进行碎片化总结，并严格归入以下三个模块分类：
- "emotional": 情感需求（角色或用户在对话中表现出的深层情感渴望、心理脆弱点或防御机制，不超过80字）
- "factual": 事实记忆（发生的重要事件细节、提及的时间、数字、物理背景，不超过80字）
- "core": 核心记忆（涉及长线关系转变、核心认知改变、重大转折性共识，不超过80字）

【输出格式控制】：请直接且仅返回以下格式的 JSON 数组（不要包含任何 Markdown 标识符如 \`\`\`json 块）：
[
  {"category": "emotional", "content": "情感碎片内容", "keywords": ["词1", "词2"]},
  {"category": "factual", "content": "事实碎片内容", "keywords": ["词1"]},
  {"category": "core", "content": "核心碎片内容", "keywords": ["词1"]}
]

---
对话原文：
${dialogText}`;
  } else {
    systemPrompt = `你是一个长周期记忆整合引擎。请对以下发生的对话轮次进行碎片化总结，并严格归入以下三个模块分类（如果没有对应分类内容可省略该块）。请直接按照以下文字标签块格式输出（不要包含 Markdown 代码块）：

[情感需求]
内容：情感需求具体总结描述（不超过80字）
关键词：词1, 词2

[事实记忆]
内容：事实事件具体总结描述（不超过80字）
关键词：词1, 词2

[核心记忆]
内容：核心转变具体总结描述（不超过80字）
关键词：词1, 词2

---
对话原文：
${dialogText}`;
  }

  const response = await fetch(`${api.url}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${api.key}` },
    body: JSON.stringify({
      model: api.model,
      messages: [{ role: "user", content: systemPrompt }],
      temperature: 0.3
    })
  });

  if (!response.ok) throw new Error("API 调用整合总结失败");
  const result = await response.json();
  let rawText = result.choices[0].message.content.trim();

  let items = [];

  if (formatChoice === "json") {
    try {
      let cleaned = rawText.replace(/^\`\`\`json/i, '').replace(/\`\`\`$/i, '').trim();
      try {
        items = JSON.parse(cleaned);
      } catch (err) {
        // 括号与结构破损自愈性解析
        cleaned = cleaned.replace(/,\s*([\]}])/g, '$1');
        if (!cleaned.startsWith('[') && cleaned.includes('{')) cleaned = '[' + cleaned;
        if (!cleaned.endsWith(']') && cleaned.includes('}')) cleaned = cleaned + ']';
        items = JSON.parse(cleaned);
      }
    } catch (e) {
      // 正则强制匹配提取有效的 JSON 节点片段
      try {
        let cleaned = rawText.replace(/^\`\`\`json/i, '').replace(/\`\`\`$/i, '').trim();
        const regex = /\{\s*"category"\s*:\s*"([^"]+)"\s*,\s*"content"\s*:\s*"([^"]+)"(?:\s*,\s*"keywords"\s*:\s*(\[[^\]]*\]))?\s*\}/gi;
        let match;
        while ((match = regex.exec(cleaned)) !== null) {
          const category = match[1];
          const content = match[2];
          let keywords = [];
          if (match[3]) {
            try { keywords = JSON.parse(match[3]); } catch(err) {}
          }
          items.push({ category, content, keywords });
        }
      } catch (regexErr) {
        console.error("JSON 与正则提取自愈解析完全失败:", regexErr);
      }
    }
  } else {
    // 文字标签快自愈性解析 (兼容全角/半角)
    try {
      const normalized = rawText
        .replace(/【/g, '[').replace(/】/g, ']')
        .replace(/［/g, '[').replace(/］/g, ']')
        .replace(/：/g, ':')
        .replace(/，/g, ',');
      
      const sections = normalized.split(/\[(情感需求|事实记忆|核心记忆)\]/gi);
      for (let i = 1; i < sections.length; i += 2) {
        const catName = sections[i].trim();
        const block = sections[i + 1] || "";
        
        let category = 'factual';
        if (catName.includes('情感')) category = 'emotional';
        else if (catName.includes('核心')) category = 'core';
        
        let content = "";
        let keywords = [];
        
        const contentMatch = block.match(/内容\s*:\s*([^\n]+)/i);
        if (contentMatch) content = contentMatch[1].trim();
        
        const kwMatch = block.match(/关键词\s*:\s*([^\n]+)/i);
        if (kwMatch) {
          keywords = kwMatch[1].split(',').map(k => k.trim()).filter(Boolean);
        }
        
        if (content) {
          items.push({ category, content, keywords });
        }
      }
    } catch (textErr) {
      console.error("文字标签块自愈性解析失败:", textErr);
    }
  }

  // 如果双重解析格式最终皆无法捕获，则直接一股脑塞进事实分类，保证数据 100% 不丢损 [1]
  if (!Array.isArray(items) || items.length === 0) {
    items = [{
      category: 'factual',
      content: rawText,
      keywords: ["日常", "事件"]
    }];
  }

  const isVectorEnabled = localStorage.getItem("settings-vector-enabled") === "true";
      const summaryTimestamp = rounds[endRound - 1]?.timestamp || Date.now();

      // 依次将分类纸条异步入库并提取 Embedding
      for (let item of items) {
        let vector = null;
        if (isVectorEnabled) {
          vector = await safeGetEmbedding(item.content);
        }

        await db.summaries.add({
          sessionId: sessionId,
          startRound: startRound,
          endRound: endRound,
          content: item.content,
          category: item.category || 'factual',
          keywords: JSON.stringify(item.keywords || []),
          timestamp: summaryTimestamp,
          vector: vector
        });
      }
}

// 4. 自动总结拦截触发器 (在每次 AI 回复完成后，若符合条件且出了缓冲区则自动执行总结)
async function checkAndTriggerAutoSummary(sessionId) {
  const sess = await db.sessions.get(sessionId);
  if (!sess || sess.autoSummaryToggle !== 1) return;

  const interval = sess.autoSummaryInterval || 10;
  const buffer = sess.bufferRounds || 5;

  const rawMsgs = await db.messages.where('sessionId').equals(sessionId).sortBy('timestamp');
  const rounds = getRoundsList(rawMsgs);
  const totalRounds = rounds.length;

  const existingSummaries = await db.summaries.where('sessionId').equals(sessionId).toArray();
  const maxEndRound = existingSummaries.reduce((max, s) => Math.max(max, s.endRound || 0), 0);

  const startRound = maxEndRound + 1;
  const endRound = totalRounds - buffer;

  if (endRound - startRound + 1 >= interval && startRound <= endRound) {
    try {
      await generateSummaryForRounds(sessionId, startRound, endRound, sess.summarySystemPrompt);
    } catch(e) {
      console.error("对话自动后台总结失败:", e);
    }
  }
}

// 5. 记忆面板：加载总结配置与核心记忆 [1]
async function loadSummarySettings(sessionId) {
  const sess = await db.sessions.get(sessionId);
  if (!sess) return;

  document.getElementById("summary-auto-toggle").checked = sess.autoSummaryToggle === 1;
  document.getElementById("summary-auto-interval").value = sess.autoSummaryInterval || 10;
  document.getElementById("summary-buffer-rounds").value = sess.bufferRounds || 5;
  document.getElementById("summary-system-prompt").value = sess.summarySystemPrompt || "以第三人称视角，按照时间顺序总结发生的所有事件，不允许有任何感情色彩，不超过150字。";
  
  const formatChoice = localStorage.getItem("summary-format-choice") || "json";
  const choiceEl = document.getElementById("summary-format-choice");
  if (choiceEl) choiceEl.value = formatChoice;

  const rawMsgs = await db.messages.where('sessionId').equals(sessionId).sortBy('timestamp');
  const rounds = getRoundsList(rawMsgs);

  const existingSummaries = await db.summaries.where('sessionId').equals(sessionId).toArray();
  const maxEndRound = existingSummaries.reduce((max, s) => Math.max(max, s.endRound || 0), 0);

  document.getElementById("summary-stat-summarized").innerText = maxEndRound;
  document.getElementById("summary-stat-total").innerText = rounds.length;
}

async function saveSummarySettings(sessionId) {
  const toggle = document.getElementById("summary-auto-toggle").checked ? 1 : 0;
  const interval = parseInt(document.getElementById("summary-auto-interval").value) || 10;
  const buffer = parseInt(document.getElementById("summary-buffer-rounds").value) || 5;
  const prompt = document.getElementById("summary-system-prompt").value.trim();

  await db.sessions.update(sessionId, {
    autoSummaryToggle: toggle,
    autoSummaryInterval: interval,
    bufferRounds: buffer,
    summarySystemPrompt: prompt
  });

  const choiceEl = document.getElementById("summary-format-choice");
  if (choiceEl) {
    localStorage.setItem("summary-format-choice", choiceEl.value);
  }

  alert("总结配置已成功保存并在此会话中全局应用！");
}

async function loadCoreMemory(sessionId) {
  const sess = await db.sessions.get(sessionId);
  if (!sess) return;

  document.getElementById("memory-core-status").value = sess.coreSelfStatus || "";
  document.getElementById("memory-core-purpose").value = sess.coreSelfPurpose || "";
  document.getElementById("memory-core-changes").value = sess.coreSelfChanges || "";
  document.getElementById("memory-core-relationship").value = sess.coreRelationship || "";
  document.getElementById("memory-core-userineyes").value = sess.coreUserInEyes || "";

  // 加载本地 ONNX 向量微调设置
  const isVectorEnabled = localStorage.getItem("settings-vector-enabled") === "true";
  const vectorPanel = document.getElementById("vector-config-panel");
  if (vectorPanel) {
    vectorPanel.style.display = isVectorEnabled ? "block" : "none";
  }

  if (isVectorEnabled) {
    const topk = localStorage.getItem("vector-topk") || "3";
    const decay = localStorage.getItem("vector-decay-type") || "medium";
    const threshold = localStorage.getItem("vector-threshold") || "0.55";

    document.getElementById("vector-topk").value = topk;
    const topkInputText = document.getElementById("vector-topk-input");
    if (topkInputText) topkInputText.value = topk;

    document.getElementById("vector-threshold").value = threshold;
    document.getElementById("vector-threshold-val").innerText = threshold;

    document.querySelectorAll(".vector-decay-btn").forEach(btn => {
      const isActive = btn.getAttribute("data-decay") === decay;
      btn.classList.toggle("btn-primary", isActive);
      btn.classList.toggle("btn-outline", !isActive);
    });
  }

  // 重设当前选中的 Summaries 历史碎片过滤标签
  document.querySelectorAll(".summary-tab-btn").forEach(btn => {
    btn.classList.toggle("active", btn.getAttribute("data-cat") === "all");
  });

  await renderSummariesList(sessionId, "all");
}

async function saveCoreMemory(sessionId) {
  const status = document.getElementById("memory-core-status").value.trim();
  const purpose = document.getElementById("memory-core-purpose").value.trim();
  const changes = document.getElementById("memory-core-changes").value.trim();
  const relation = document.getElementById("memory-core-relationship").value.trim();
  const userInEyes = document.getElementById("memory-core-userineyes").value.trim();

  await db.sessions.update(sessionId, {
    coreSelfStatus: status,
    coreSelfPurpose: purpose,
    coreSelfChanges: changes,
    coreRelationship: relation,
    coreUserInEyes: userInEyes
  });
  alert("核心记忆库已保存！");
}

async function renderSummariesList(sessionId, category = "all") {
  const container = document.getElementById("memory-summaries-list");
  if (!container) return;
  container.innerHTML = "";

  let list = [];
  if (category === "all") {
    list = await db.summaries.where('sessionId').equals(sessionId).sortBy('startRound');
  } else {
    list = await db.summaries.where('sessionId').equals(sessionId).filter(s => s.category === category).toArray();
    list.sort((a, b) => a.startRound - b.startRound);
  }

  if (list.length === 0) {
    container.innerHTML = `<p style="font-size:12px; color:var(--text-secondary); text-align:center; padding:20px 0;">目前该分类下尚未生成任何碎片化时间流记忆。</p>`;
    return;
  }

  // 按时间降序排列，最新生成的碎片放置于时间流最上方
  list.reverse().forEach(s => {
    const card = document.createElement("div");
    card.className = "timeline-item";
    card.style.position = "relative";
    card.style.paddingLeft = "20px";
    card.style.borderLeft = "2px solid var(--border)";
    card.style.marginLeft = "10px";
    card.style.paddingBottom = "16px";
    
    let keywords = [];
    try { keywords = JSON.parse(s.keywords || "[]"); } catch(e){}
    const tagsHtml = keywords.map(k => `<span class="summary-keyword-tag"># ${k}</span>`).join(" ");

    const sourceBadge = s.source === 'deeptalk' 
      ? `<span class="summary-source-tag deeptalk" style="background-color: #f1f5f9; color: #475569; padding: 2px 6px; border-radius: 4px; font-weight: 700; font-size: 10px; margin-left: 6px;">来自深谈</span>`
      : "";

    // 向量化指示器状态渲染
    const vectorBadge = s.vector 
      ? `<span class="vector-badge" style="background-color: #e0f2fe; color: #0369a1; font-size: 9px; padding: 2px 6px; border-radius: 9999px; margin-left: 6px; font-weight: 700;">384D 向量化</span>` 
      : `<span class="vector-badge" style="background-color: #f3f4f6; color: #6b7280; font-size: 9px; padding: 2px 6px; border-radius: 9999px; margin-left: 6px;">未向量化</span>`;

    const catMap = {
      'emotional': '情感需求',
      'factual': '事实记忆',
      'core': '核心记忆'
    };
    const catLabel = catMap[s.category] || "碎片总结";
    const catColor = s.category === 'emotional' ? '#ec4899' : (s.category === 'core' ? '#ca8a04' : '#10b981');

    // 提取格式化中文时间戳节点
    const timeStr = new Date(s.timestamp).toLocaleString('zh-CN', {
      month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
    });

    card.innerHTML = `
      <!-- 垂直高保真流式时间线节点 -->
      <span class="timeline-dot" style="position: absolute; left: -6px; top: 4px; width: 10px; height: 10px; border-radius: 50%; background-color: ${catColor}; border: 2px solid #fff; box-shadow: 0 0 4px rgba(0,0,0,0.15);"></span>
      <div class="summary-item-card" style="margin-top: 0; background: #fff; border: 1px solid var(--border); border-radius: 12px; padding: 12px; box-shadow: var(--shadow-sm);">
        <div class="summary-item-header" style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">
          <span style="font-size:11px; font-weight:700; color:${catColor}; display:flex; align-items:center; flex-wrap:wrap; gap:4px;">
            [${catLabel}] <span style="color:var(--text-secondary); margin-left:2px; font-weight:normal;">${timeStr}</span> ${vectorBadge} ${sourceBadge}
          </span>
          <div style="display:flex; gap:6px; flex-shrink:0;">
            <button class="btn-icon" style="color:#3b82f6; border:none; background:none; cursor:pointer; padding:2px;" onclick="editSummaryRecord(${s.id})" title="编辑">
              <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>
            </button>
            <button class="btn-icon" style="color:#ef4444; border:none; background:none; cursor:pointer; padding:2px;" onclick="deleteSummaryRecord(${s.id})" title="删除">
              <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
            </button>
          </div>
        </div>
        <div style="font-size:13px; color:var(--text-primary); line-height:1.5; white-space:pre-wrap; margin-bottom:6px;">${s.content}</div>
        <div class="summary-item-keywords">${tagsHtml}</div>
      </div>
    `;
    container.appendChild(card);
  });
}

window.deleteSummaryRecord = async function(id) {
  if (confirm("确定要删除这一条碎片记忆吗？")) {
    await db.summaries.delete(id);
    if (activeSessionId) {
      const activeTab = document.querySelector(".summary-tab-btn.active")?.getAttribute("data-cat") || "all";
      await renderSummariesList(activeSessionId, activeTab);
    }
  }
};

// 6. AI 深度提炼核心记忆
async function generateCoreMemoryFromAI(sessionId) {
  const btn = document.getElementById("btn-generate-core-memory");
  const originalText = btn.innerText;
  btn.disabled = true;
  btn.innerText = "正在记忆提炼中...";

  try {
    const presetId = localStorage.getItem("global_api_preset_id");
    const api = await db.api_presets.get(Number(presetId));
    if (!api) throw new Error("请配置全局 API 预设");

    const summaries = await db.summaries.where('sessionId').equals(sessionId).toArray();
    if (summaries.length === 0) {
      throw new Error("无任何阶段性总结记忆，AI 无法提取。请先执行手动或自动总结！");
    }

    const summariesText = summaries.map(s => `- [轮次 ${s.startRound}-${s.endRound}]: ${s.content}`).join("\n");

    const systemPrompt = `你是一个长周期记忆整合引擎。请根据以下关于两个人的多维交往对话事件总结，站在角色角度，高度提炼出角色心智中的以下五个维度，写成第一人称心流或总结。
【重要格式输出】：请直接且仅返回符合以下标准的 JSON 格式，不准在首尾添加任何 Markdown 标识符：
{
  "coreSelfStatus": "我的现状、当前的处境和心境...",
  "coreSelfPurpose": "我与TA交往背后的真实动机、目的与核心渴望...",
  "coreSelfChanges": "认识TA以来，我在性格、态度、情感层面的变化...",
  "coreRelationship": "我对我们双方目前社交或深层关系的定位...",
  "coreUserInEyes": "在我心里对TA（用户）的最真实客观、私密的正面或负面印象评价..."
}

---
经历事件总结：
${summariesText}`;

    const response = await fetch(`${api.url}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${api.key}` },
      body: JSON.stringify({
        model: api.model,
        messages: [{ role: "user", content: systemPrompt }],
        temperature: 0.5
      })
    });

    if (!response.ok) throw new Error("API 核心记忆提炼调用失败");
    const result = await response.json();
    let text = result.choices[0].message.content.trim();
    text = text.replace(/^\`\`\`json/i, '').replace(/\`\`\`$/i, '').trim();

    const parsed = JSON.parse(text);
    
    document.getElementById("memory-core-status").value = parsed.coreSelfStatus || "";
    document.getElementById("memory-core-purpose").value = parsed.coreSelfPurpose || "";
    document.getElementById("memory-core-changes").value = parsed.coreSelfChanges || "";
    document.getElementById("memory-core-relationship").value = parsed.coreRelationship || "";
    document.getElementById("memory-core-userineyes").value = parsed.coreUserInEyes || "";

    alert("AI 记忆提炼完成！请核对以下内容并点击“保存核心记忆库”进行存储。");

  } catch(e) {
    console.error(e);
    alert("提炼核心记忆失败: " + e.message);
  } finally {
    btn.disabled = false;
    btn.innerText = originalText;
  }
}

// 7. 手动执行范围总结
async function triggerManualSummary(sessionId) {
  const start = parseInt(document.getElementById("summary-manual-start").value);
  const end = parseInt(document.getElementById("summary-manual-end").value);
  const prompt = document.getElementById("summary-system-prompt").value.trim();

  if (isNaN(start) || isNaN(end) || start <= 0 || end <= 0 || start > end) {
    alert("请输入合法的起始与结束轮次区间！");
    return;
  }

  const btn = document.getElementById("btn-summary-manual-trigger");
  btn.disabled = true;
  btn.innerText = "总结生成中...";

  try {
    await generateSummaryForRounds(sessionId, start, end, prompt);
    alert(`第 ${start} 至 ${end} 轮对话事件总结已成功生成！`);
    await loadSummarySettings(sessionId);
    // 重置输入
    document.getElementById("summary-manual-start").value = "";
    document.getElementById("summary-manual-end").value = "";
  } catch(e) {
    console.error(e);
    alert("手动总结失败: " + e.message);
  } finally {
    btn.disabled = false;
    btn.innerText = "手动总结";
  }
}

// 8. DOM 节点单次绑定绑定与生命周期挂载 [1]
document.addEventListener("DOMContentLoaded", () => {
  const btnSummary = document.getElementById("btn-chat-summary");
  if (btnSummary) {
    btnSummary.onclick = () => {
      document.getElementById("chat-expand-panel").classList.remove("active");
      document.getElementById("chat-summary-panel").classList.add("active");
      loadSummarySettings(activeSessionId);
    };
  }

  const btnMemory = document.getElementById("btn-chat-memory");
  if (btnMemory) {
    btnMemory.onclick = () => {
      document.getElementById("chat-expand-panel").classList.remove("active");
      document.getElementById("chat-memory-panel").classList.add("active");
      loadCoreMemory(activeSessionId);
    };
  }

  const btnSaveSummary = document.getElementById("btn-save-summary-settings");
  if (btnSaveSummary) {
    btnSaveSummary.onclick = () => {
      if (activeSessionId) saveSummarySettings(activeSessionId);
    };
  }

  const btnSaveCore = document.getElementById("btn-save-core-memory");
  if (btnSaveCore) {
    btnSaveCore.onclick = () => {
      if (activeSessionId) saveCoreMemory(activeSessionId);
    };
  }

  const btnGenerateCore = document.getElementById("btn-generate-core-memory");
  if (btnGenerateCore) {
    btnGenerateCore.onclick = () => {
      if (activeSessionId) generateCoreMemoryFromAI(activeSessionId);
    };
  }

  const btnManualTrigger = document.getElementById("btn-summary-manual-trigger");
  if (btnManualTrigger) {
    btnManualTrigger.onclick = () => {
      if (activeSessionId) triggerManualSummary(activeSessionId);
    };
  }

  // 绑定向量检索设置交互机制与 Ticker 滑动保存 (支持 Top-K 输入框与滑块的双向实时同步) [1]
      const topkSlider = document.getElementById("vector-topk");
      const topkInputText = document.getElementById("vector-topk-input");
      if (topkSlider && topkInputText) {
        topkSlider.oninput = (e) => {
          topkInputText.value = e.target.value;
          localStorage.setItem("vector-topk", e.target.value);
        };
        topkInputText.oninput = (e) => {
          let val = parseInt(e.target.value) || 3;
          if (val < 3) val = 3;
          if (val > 1000) val = 1000;
          topkSlider.value = val;
          localStorage.setItem("vector-topk", val);
        };
        topkInputText.onblur = (e) => {
          let val = parseInt(e.target.value) || 3;
          if (val < 3) val = 3;
          if (val > 1000) val = 1000;
          topkInputText.value = val;
          topkSlider.value = val;
          localStorage.setItem("vector-topk", val);
        };
      }

      const thresholdInput = document.getElementById("vector-threshold");
      if (thresholdInput) {
        thresholdInput.oninput = (e) => {
          document.getElementById("vector-threshold-val").innerText = e.target.value;
          localStorage.setItem("vector-threshold", e.target.value);
        };
      }

      // 绑定时间衰减系数按钮，采用原生 btn-primary 和 btn-outline 样式进行强视觉反馈切换 [1]
      document.querySelectorAll(".vector-decay-btn").forEach(btn => {
        btn.onclick = () => {
          document.querySelectorAll(".vector-decay-btn").forEach(b => {
            b.classList.remove("btn-primary");
            b.classList.add("btn-outline");
          });
          btn.classList.remove("btn-outline");
          btn.classList.add("btn-primary");
          localStorage.setItem("vector-decay-type", btn.getAttribute("data-decay"));
        };
      });

  const thresholdInput = document.getElementById("vector-threshold");
  if (thresholdInput) {
    thresholdInput.oninput = (e) => {
      document.getElementById("vector-threshold-val").innerText = e.target.value;
      localStorage.setItem("vector-threshold", e.target.value);
    };
  }

  document.querySelectorAll(".vector-decay-btn").forEach(btn => {
    btn.onclick = () => {
      document.querySelectorAll(".vector-decay-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      localStorage.setItem("vector-decay-type", btn.getAttribute("data-decay"));
    };
  });

  // 绑定历史总结分类过滤器 Tabs 交互事件
  document.querySelectorAll(".summary-tab-btn").forEach(btn => {
    btn.onclick = () => {
      document.querySelectorAll(".summary-tab-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      const category = btn.getAttribute("data-cat");
      if (activeSessionId) {
        renderSummariesList(activeSessionId, category);
      }
    };
  });
});