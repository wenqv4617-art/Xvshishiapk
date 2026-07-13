/**
 * app_chat_html_widget.js - HTML 互动舱生成与安全沙盘渲染控制 (带无损视图清洗切换版)
 */

(function() {
  const chatHtmlWidgetSystem = {
    activeRepairCardId: null,
    
    // 用于存储当前处于“清洗视图”状态的卡片 ID 集合 (内存状态机，不污染数据库)
    cleanedCardIds: new Set(),

    // 开启 HTML 主界面
    openPanel: async function() {
      if (!activeSessionId) {
        alert("请先进入某位角色的聊天对话界面，再执行 HTML 生成。");
        return;
      }
      document.getElementById("chat-html-panel").classList.add("active");
      await this.loadCards();
    },

    // 关闭主界面
    closePanel: function() {
      document.getElementById("chat-html-panel").classList.remove("active");
    },

    // 载入历史卡片
    loadCards: async function() {
      const container = document.getElementById("html-cards-container");
      if (!container) return;
      
      container.innerHTML = `<div style="text-align:center; padding: 20px; color: #818cf8;">[GEN_PROTOCOL] 正在同步本地物理协议组件...</div>`;

      try {
        const cards = await db.html_cards.where('sessionId').equals(activeSessionId).sortBy('timestamp');
        if (cards.length === 0) {
          container.innerHTML = `
            <div style="text-align:center; color: #8f9cae; font-size:13px; padding:40px 0;">
              <p>[无生成的 HTML 互动协议卡片]</p>
              <p style="font-size: 11px; margin-top: 6px; color: rgba(99, 102, 241, 0.4)">点击右上角 + 开始构建卡片</p>
            </div>`;
          return;
        }

        container.innerHTML = "";
        cards.reverse().forEach(card => {
          const isCleaned = this.cleanedCardIds.has(card.id);
          const cleanBtnColor = isCleaned ? "#10b981" : "#94a3b8"; // 激活显示绿色，未激活显示温和灰
          const cleanBtnTitle = isCleaned ? "已开启重绘清洗（点击恢复 AI 原始返回）" : "一键清洗代码（自动剥离多余对话说明）";

          const cardEl = document.createElement("div");
          cardEl.className = "html-card";
          cardEl.innerHTML = `
            <div class="html-card-header">
              <span class="html-card-title">WIDGET_PROTOCOL_ID: #${card.id}</span>
              <div style="display: flex; gap: 10px;">
                <!-- 一键清洗按钮 (支持无损双态切换) -->
                <button class="btn-icon" id="btn-clean-${card.id}" onclick="chatHtmlWidgetSystem.cleanCard(${card.id})" style="color: ${cleanBtnColor};" title="${cleanBtnTitle}">
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M12 3v1m0 16v1m9-9h-1M3 12H2m15.24-7.24l-.7.7M6.46 17.54l-.7.7M17.54 17.54l.7.7M6.46 6.46l.7-.7M8 12a4 4 0 1 1 8 0 4 4 0 0 1-8 0z"/>
                  </svg>
                </button>
                <!-- 维修按钮 (扳手) -->
                <button class="btn-icon" onclick="chatHtmlWidgetSystem.openRepair(${card.id})" style="color: #818cf8;" title="维修组件代码">
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                    <path d="M22.7 19l-9.1-9.1c.9-2.3.4-5-1.5-6.9-2-2-5-2.4-7.4-1.3L9 6 6 9 1.6 4.3C.5 6.7.9 9.8 2.9 11.8c1.9 1.9 4.6 2.4 6.9 1.5l9.1 9.1c.4.4 1 .4 1.4 0l2.4-2.4c.4-.4.4-1.1 0-1.4z"/>
                  </svg>
                </button>
                <!-- 删除按钮 -->
                <button class="btn-icon" onclick="chatHtmlWidgetSystem.deleteCard(${card.id})" style="color: #fda4af;" title="粉碎组件">
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
                </button>
              </div>
            </div>
            <div class="html-card-prompt">指令: ${escapeHtml(card.prompt)}</div>
            <div class="html-card-iframe-container">
              <iframe id="html-iframe-${card.id}" sandbox="allow-scripts"></iframe>
            </div>
            <!-- 时间脚标下移至卡片右下角 -->
            <div class="html-card-footer">
              <span class="html-card-time">${new Date(card.timestamp).toLocaleString()}</span>
            </div>
          `;
          container.appendChild(cardEl);

          const iframe = document.getElementById(`html-iframe-${card.id}`);
          if (iframe) {
            if (isCleaned) {
              const cleaned = this.extractCleanHtml(card.html);
              this.loadHtmlInSandbox(iframe, cleaned);
            } else {
              this.loadHtmlInSandbox(iframe, card.html);
            }
          }
        });
      } catch (err) {
        console.error("加载卡片失败: ", err);
        container.innerHTML = `<div style="color: #fda4af; padding:20px;">[ERROR] 同步协议组件失败: ${err.message}</div>`;
      }
    },

    // 删除卡片
    deleteCard: async function(id) {
      if (confirm("确定要永久粉碎此 HTML 互动卡片吗？")) {
        await db.html_cards.delete(id);
        this.cleanedCardIds.delete(id); // 物理删除运行时状态
        await this.loadCards();
      }
    },

    // 精准剥离Conversational冗余文字的提取算法
    extractCleanHtml: function(rawCode) {
      let code = rawCode.trim();
      
      // 1. 尝试从 Markdown 代码块（如 ```html ... ```）中剥离提取
      const mdRegex = /```(?:html|xml|javascript|css)?([\s\S]*?)```/i;
      const match = code.match(mdRegex);
      if (match && match[1]) {
        return match[1].trim();
      }
      
      // 2. 尝试提取 <html> 至 </html> 完整结构
      const htmlRegex = /(<html[\s\S]*?<\/html>)/i;
      const htmlMatch = code.match(htmlRegex);
      if (htmlMatch && htmlMatch[1]) {
        return htmlMatch[1].trim();
      }

      // 3. 托底：提取首个“<”到最末尾“>”的所有字符
      const firstAngle = code.indexOf("<");
      const lastAngle = code.lastIndexOf(">");
      if (firstAngle !== -1 && lastAngle > firstAngle) {
        return code.substring(firstAngle, lastAngle + 1).trim();
      }
      
      return code;
    },

    // 执行一键清洗卡片 (只动运行时渲染效果，不修改 IndexedDB 数据库)
    cleanCard: function(id) {
      const iframe = document.getElementById(`html-iframe-${id}`);
      const btn = document.getElementById(`btn-clean-${id}`);
      if (!iframe) return;

      db.html_cards.get(id).then(card => {
        if (!card) return;

        if (this.cleanedCardIds.has(id)) {
          // 当前处于清洗态 -> 恢复到原始未清洗态
          this.cleanedCardIds.delete(id);
          this.loadHtmlInSandbox(iframe, card.html);
          if (btn) {
            btn.style.color = "#94a3b8"; // 恢复灰色
            btn.title = "一键清洗代码（自动剥离多余说明文字）";
          }
        } else {
          // 当前处于原始态 -> 切换至清洗态 (不修改数据库中的 card.html)
          this.cleanedCardIds.add(id);
          const cleaned = this.extractCleanHtml(card.html);
          this.loadHtmlInSandbox(iframe, cleaned);
          if (btn) {
            btn.style.color = "#10b981"; // 变亮绿
            btn.title = "已开启重绘清洗（点击恢复 AI 原始返回）";
          }
        }
      });
    },

    // 安全清洗并加载至 Iframe 中运行 (基础 Markdown 代码块剔除)
    loadHtmlInSandbox: function(iframe, htmlContent) {
      let cleanHtml = htmlContent.trim();
      
      if (cleanHtml.startsWith("```")) {
        cleanHtml = cleanHtml.replace(/^```[a-zA-Z]*\n?/, "");
        cleanHtml = cleanHtml.replace(/\n?```$/, "");
        cleanHtml = cleanHtml.trim();
      }
      
      iframe.srcdoc = cleanHtml;
    },

    // 动态生成并挂载代码编辑二级面板 (防止层级穿透与绝对定位污染)
    ensureRepairOverlay: function() {
      if (document.getElementById("html-repair-overlay")) return;

      const overlay = document.createElement("div");
      overlay.id = "html-repair-overlay";
      overlay.className = "repair-workspace-overlay";
      overlay.style.display = "none";
      overlay.innerHTML = `
        <header class="win-header">
          <button class="btn-icon" onclick="chatHtmlWidgetSystem.closeRepair()" style="color: #f1f5f9;">
            <svg viewBox="0 0 24 24"><path fill="currentColor" d="M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z"/></svg>
          </button>
          <h3>代码维修舱</h3>
          <div style="width:40px;"></div>
        </header>
        <div class="repair-workspace-body">
          <div>
            <div class="repair-editor-title">📜 源代码编辑器 (始终加载最原始 AI 返回，可在此放心修理)</div>
            <textarea id="repair-code-editor" class="repair-textarea" placeholder="在此处输入组件源码..."></textarea>
          </div>
          
          <div>
            <div class="repair-preview-label">
              <span class="repair-editor-title">👁️ 实时测试编译效果</span>
              <span class="repair-preview-status" id="repair-preview-indicator">LIVE_COMPILE</span>
            </div>
            <div class="html-card-iframe-container" style="margin-top: 6px;">
              <iframe id="repair-preview-iframe" sandbox="allow-scripts"></iframe>
            </div>
          </div>

          <div style="display:flex; gap:10px; margin-top: auto; padding-bottom: 8px;">
            <button class="btn btn-outline" onclick="chatHtmlWidgetSystem.closeRepair()" style="flex:1; border-color:#475569; color:#94a3b8; background:transparent; border-radius:10px; height:42px; font-weight:600; cursor:pointer;">取消</button>
            <button class="btn btn-cyber" onclick="chatHtmlWidgetSystem.saveRepair()" style="flex:1; border-radius:10px; height:42px; font-weight:600;">保存并更新</button>
          </div>
        </div>
      `;

      // 完美收纳至 win-chat 容器中，保障层级一致性
      const winChat = document.getElementById("win-chat");
      if (winChat) {
        winChat.appendChild(overlay);
      } else {
        document.body.appendChild(overlay);
      }

      // 实时绑定：输入字符时秒级防抖触发预览重绘
      let debounceTimer = null;
      const editor = document.getElementById("repair-code-editor");
      if (editor) {
        editor.oninput = () => {
          clearTimeout(debounceTimer);
          debounceTimer = setTimeout(() => {
            this.updateRepairPreview();
          }, 300); // 300ms 延迟无防抖重绘
        };
      }
    },

    // 进入维修舱 (始终加载 IndexedDB 最原始返回)
    openRepair: async function(id) {
      this.ensureRepairOverlay();
      this.activeRepairCardId = id;

      const card = await db.html_cards.get(id);
      if (!card) {
        alert("未能从本地数据库载入当前协议组件。");
        return;
      }

      // 这里直接填充数据库中存储的 100% 原始代码
      document.getElementById("repair-code-editor").value = card.html;
      document.getElementById("html-repair-overlay").style.display = "flex";

      this.updateRepairPreview();
    },

    // 实时预览刷新
    updateRepairPreview: function() {
      const code = document.getElementById("repair-code-editor").value;
      const iframe = document.getElementById("repair-preview-iframe");
      if (iframe) {
        this.loadHtmlInSandbox(iframe, code);
      }
    },

    // 退出维修舱
    closeRepair: function() {
      const overlay = document.getElementById("html-repair-overlay");
      if (overlay) overlay.style.display = "none";
      this.activeRepairCardId = null;
    },

    // 仅在维修舱手动保存代码时，执行物理覆写并入库
    saveRepair: async function() {
      const newHtml = document.getElementById("repair-code-editor").value.trim();
      if (!newHtml) {
        alert("组件源代码不能为空。");
        return;
      }

      if (this.activeRepairCardId) {
        try {
          await db.html_cards.update(this.activeRepairCardId, { html: newHtml });
          alert("修复协议保存成功！卡片已实时编译更新。");
          this.closeRepair();
          await this.loadCards();
        } catch(err) {
          alert("保存卡片失败: " + err.message);
        }
      }
    },

    // 唤起生成模态窗
    openGenerateModal: function() {
      document.getElementById("html-generate-overlay").classList.add("active");
      document.getElementById("html-generate-prompt").value = "";
    },

    // 关闭生成模态窗
    closeGenerateModal: function() {
      document.getElementById("html-generate-overlay").classList.remove("active");
    },

    // 核心：携带聊天上下文、总结、记忆向大模型发起编译请求
    submitGeneration: async function() {
      const promptInput = document.getElementById("html-generate-prompt");
      const promptText = promptInput.value.trim();
      if (!promptText) {
        alert("请输入具体的构建创意要求。");
        return;
      }

      const loader = document.getElementById("html-cards-container");
      loader.innerHTML = `
        <div style="text-align:center; padding: 50px 0; color: #818cf8;">
          <div style="font-size: 14px; font-weight: bold; margin-bottom: 12px; text-shadow: 0 0 8px rgba(99, 102, 241, 0.4);">[COMPILING] 神经链接已建立，正在执行全域编译...</div>
          <div style="font-size: 11px; color: #8f9cae; margin-bottom: 20px;">[系统已融合历史总结、世界书及长周期核心心智]</div>
          <div class="status-loading-box" style="display:flex; justify-content:center; align-items:center;">
             <div class="spinner" style="border-top-color: #6366f1;"></div>
          </div>
        </div>
      `;

      this.closeGenerateModal();

      try {
        const presetId = localStorage.getItem("global_api_preset_id");
        if (!presetId) throw new Error("未配置全局默认 API，请前往‘系统设置 - API 协议设置’中配置并应用！");
        const api = await db.api_presets.get(Number(presetId));
        if (!api) throw new Error("所选的 API 预设可能已被删除，请重新配置！");

        // 1. 获取全局上下文 (包含人设、世界书、记忆、历史总结)
        const systemPrompt = await buildGlobalSystemPrompt(activeSessionId);
        
        // 2. 注入 HTML 卡片专用编译约束提示词
        const htmlInstruction = PROMPT_TEMPLATES.HTML_WIDGET_INSTRUCTION;

        // 3. 拉取最新的 10 条线上上下文对话
        const history = await db.messages.where('sessionId').equals(activeSessionId).reverse().limit(10).toArray();
        history.reverse();

        const messagesToSend = [{ role: "system", content: systemPrompt + "\n\n" + htmlInstruction }];
        history.forEach(h => {
          messagesToSend.push({ role: h.senderType === 'user' ? 'user' : 'assistant', content: h.content });
        });

        // 4. 追加具有高优约束性的指令提示词，确保其摒弃上下文消息格式的惯性 (高优先指令升级)
        messagesToSend.push({
          role: "user",
          content: `【最新执行指令（高优！）】：现在请你针对用户最新提出的需求，全新生成一个独立的 HTML/CSS/JS 页面代码。请彻底遗忘并抛弃之前的对话消息格式（不要模仿、提及、或生成任何红包、转账、语音等对话台词或指令），你的唯一任务就是输出一个完整的、可运行的 HTML 代码组件！\n\n【用户的卡片构建需求如下】：\n${promptText}`
        });

        const response = await fetch(`${api.url}/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": `Bearer ${api.key}` },
          body: JSON.stringify({
            model: api.model,
            messages: messagesToSend,
            temperature: api.temperature
          })
        });

        if (!response.ok) {
          const errText = await response.text();
          throw new Error(`HTTP ${response.status} 错误: ${errText}`);
        }

        const result = await response.json();
        if (!result.choices || result.choices.length === 0) {
          throw new Error("模型服务返回数据异常，Choice 节点为空。");
        }

        const rawReply = result.choices[0].message.content.trim();

        // 5. 保存到数据库中 (入库内容绝对保留 AI 返回的一手原始未清洗状态)
        await db.html_cards.add({
          sessionId: activeSessionId,
          prompt: promptText,
          html: rawReply,
          timestamp: Date.now()
        });

        await this.loadCards();
      } catch (err) {
        console.error(err);
        alert(`生成卡片失败: ${err.message}`);
        await this.loadCards();
      }
    }
  };

  // 防御性自动事件绑定：当 DOM 解析完毕或脚本加载时，强制重新搜寻并注册事件
  function bindHtmlWidgetTrigger() {
    const btn = document.getElementById("btn-chat-html-widget");
    if (btn) {
      btn.onclick = (e) => {
        if (e) e.preventDefault();
        document.getElementById("chat-expand-panel").classList.remove("active");
        chatHtmlWidgetSystem.openPanel();
      };
    }
  }

  // 应对异步加载场景
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bindHtmlWidgetTrigger);
  } else {
    bindHtmlWidgetTrigger();
  }

  window.chatHtmlWidgetSystem = chatHtmlWidgetSystem;
})();