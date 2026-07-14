/**
 * app_summary_memory.js - 对话自动/手动总结与核心记忆关联召回系统
 */

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

// 2. 核心：检索召回机制 (固定带入最近5轮，通过最新的输入模糊匹配其它，若超过20轮则均匀提取)
async function retrieveSummaries(sessionId, latestUserMessageText) {
  const allSummaries = await db.summaries.where('sessionId').equals(sessionId).sortBy('startRound');
  if (allSummaries.length === 0) return [];

  // 固定携带最近的 5 轮总结
  const recentSummaries = allSummaries.slice(-5);
  const recentIds = new Set(recentSummaries.map(s => s.id));

  // 剩余的总结用于检索匹配
  const otherSummaries = allSummaries.filter(s => !recentIds.has(s.id));
  let matchedSummaries = [];

  if (latestUserMessageText && otherSummaries.length > 0) {
    const cleanedInput = latestUserMessageText.toLowerCase();
    otherSummaries.forEach(s => {
      let keywords = [];
      try { keywords = JSON.parse(s.keywords || "[]"); } catch(e){}
      
      const isMatch = keywords.some(k => cleanedInput.includes(k.toLowerCase()) || s.content.toLowerCase().includes(k.toLowerCase()));
      if (isMatch) {
        matchedSummaries.push(s);
      }
    });
  }

  // 限制召回数最高为 20。若命中 > 20 轮，则均匀提取
  let selectedMatched = [];
  if (matchedSummaries.length <= 20) {
    selectedMatched = matchedSummaries;
  } else {
    for (let j = 0; j < 20; j++) {
      const index = Math.floor(j * matchedSummaries.length / 20);
      selectedMatched.push(matchedSummaries[index]);
    }
  }

  const combined = [...recentSummaries, ...selectedMatched];
  const uniqueMap = new Map();
  combined.forEach(s => uniqueMap.set(s.id, s));
  
  return Array.from(uniqueMap.values()).sort((a,b) => a.startRound - b.startRound);
}

// 3. AI总结生成器 (提取总结与核心关键词，以 JSON 格式捕获)
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

  const prompt = customPrompt || "以第三人称视角，按照时间顺序总结发生的所有事件，不允许有任何感情色彩，不超过150字。";

  const systemPrompt = `请对以下发生的对话轮次进行严格事件总结，并提取最核心的核心词（不超过3个）。
【重要输出要求】：请直接且仅返回符合以下 JSON 格式的内容，严禁包含任何 Markdown 代码块（如 \`\`\`json）：
{
  "summary": "${prompt}",
  "keywords": ["关键字1", "关键字2"]
}

---
对话原文：
${dialogText}`;

  const response = await fetch(`${api.url}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${api.key}` },
    body: JSON.stringify({
      model: api.model,
      messages: [{ role: "user", content: systemPrompt }],
      temperature: 0.3
    })
  });

  if (!response.ok) throw new Error("API 调用总结失败");
  const result = await response.json();
  let rawText = result.choices[0].message.content.trim();
  rawText = rawText.replace(/^\`\`\`json/i, '').replace(/\`\`\`$/i, '').trim();

  let parsed = { summary: "", keywords: [] };
  try {
    parsed = JSON.parse(rawText);
  } catch(e) {
    parsed.summary = rawText;
    parsed.keywords = ["日常", "事件"];
  }

  await db.summaries.add({
    sessionId: sessionId,
    startRound: startRound,
    endRound: endRound,
    content: parsed.summary,
    keywords: JSON.stringify(parsed.keywords || []),
    timestamp: Date.now()
  });
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

// 5. 记忆面板：加载总结配置与核心记忆
async function loadSummarySettings(sessionId) {
  const sess = await db.sessions.get(sessionId);
  if (!sess) return;

  document.getElementById("summary-auto-toggle").checked = sess.autoSummaryToggle === 1;
  document.getElementById("summary-auto-interval").value = sess.autoSummaryInterval || 10;
  document.getElementById("summary-buffer-rounds").value = sess.bufferRounds || 5;
  document.getElementById("summary-system-prompt").value = sess.summarySystemPrompt || "以第三人称视角，按照时间顺序总结发生的所有事件，不允许有任何感情色彩，不超过150字。";

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

  await renderSummariesList(sessionId);
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

async function renderSummariesList(sessionId) {
  const container = document.getElementById("memory-summaries-list");
  if (!container) return;
  container.innerHTML = "";

  const list = await db.summaries.where('sessionId').equals(sessionId).sortBy('startRound');
  if (list.length === 0) {
    container.innerHTML = `<p style="font-size:12px; color:var(--text-secondary); text-align:center; padding:20px 0;">目前尚未生成任何阶段性对话总结。</p>`;
    return;
  }

  list.reverse().forEach(s => {
    const card = document.createElement("div");
    card.className = "summary-item-card";
    
    let keywords = [];
    try { keywords = JSON.parse(s.keywords || "[]"); } catch(e){}
    const tagsHtml = keywords.map(k => `<span class="summary-keyword-tag"># ${k}</span>`).join(" ");

    // 显式判定并生成极简风格的“来自深谈”标签，而不混杂在文本内 [1]
    const sourceBadge = s.source === 'deeptalk' 
      ? `<span class="summary-source-tag deeptalk" style="background-color: #f1f5f9; color: #475569; padding: 2px 6px; border-radius: 4px; font-weight: 700; font-size: 10px; margin-left: 6px;">来自深谈</span>`
      : "";

    card.innerHTML = `
      <div class="summary-item-header">
        <span style="display:flex; align-items:center;">轮次区间: ${s.startRound} - ${s.endRound} ${sourceBadge}</span>
        <button class="btn-icon" style="color:#ef4444; border:none; background:none; cursor:pointer;" onclick="deleteSummaryRecord(${s.id})">
          <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
        </button>
      </div>
      <div style="font-size:13px; color:var(--text-primary); line-height:1.5; white-space:pre-wrap;">${s.content}</div>
      <div class="summary-item-keywords">${tagsHtml}</div>
    `;
    container.appendChild(card);
  });
}

window.deleteSummaryRecord = async function(id) {
  if (confirm("确定要删除这一轮生成的总结吗？")) {
    await db.summaries.delete(id);
    if (activeSessionId) {
      await renderSummariesList(activeSessionId);
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

// 8. DOM 节点单次绑定绑定与生命周期挂载
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
});