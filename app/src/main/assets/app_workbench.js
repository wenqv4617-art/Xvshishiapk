/**
 * app_workbench.js - 工作台 Agent（多对话 + 本地工作区 + GitHub + 多轮工具调用）
 *
 * 对标市面 Agent 手机端（Claude / Trae）：
 * - 多对话窗口：会话列表 + 对话页，可自由新建/删除/重命名
 * - 每对话专属本地工作区（Kotlin WorkbenchFileSystem 桥接，App 私有目录，免权限）
 * - 可选连接 GitHub：用户自配 用户名 + Token，通过 Contents API 推送文件
 * - 多轮工具循环：[`WB_TOOL: {...}`] 协议，支持 文件读写 / 目录 / GitHub 推送 / 网页抓取 / MCP
 * - 上下文裁剪 + 对话摘要 + 输入/输出 Token 统计 + 缓存命中统计
 *
 * 界面约束：无任何 emoji；全部按钮使用 SVG 通用路径图标；全部弹窗为自制卡片（禁用原生 alert/confirm/prompt）。
 */
(function () {
  "use strict";

  var WB = {
    // ==================== 常量 ====================
    MAX_TOOL_LOOPS: 8,          // 单轮用户消息最多工具循环次数
    MAX_CONTEXT_TOKENS: 8000,   // 上下文 token 预算（超出则折叠旧消息）
    TOOL_TAG: "WB_TOOL",

    state: {
      view: "list",             // list | chat
      activeConvId: null,
      sending: false,
      abortCtrl: null,
      inputTimer: null,
    },

    // ==================== 工具：文件系统（Kotlin 桥） ====================
    fs: {
      _guard: function () {
        if (window.AndroidMCP && typeof window.AndroidMCP.wbListDir === "function") return true;
        return false;
      },
      listDir: function (path) {
        if (!this._guard()) return { ok: false, error: "当前环境不支持原生文件系统（请安装 APK 使用）" };
        try { return JSON.parse(window.AndroidMCP.wbListDir(path || ".")); } catch (e) { return { ok: false, error: "解析失败: " + e.message }; }
      },
      readFile: function (path) {
        if (!this._guard()) return { ok: false, error: "当前环境不支持原生文件系统" };
        try { return JSON.parse(window.AndroidMCP.wbReadFile(path)); } catch (e) { return { ok: false, error: "解析失败: " + e.message }; }
      },
      writeFile: function (path, content) {
        if (!this._guard()) return { ok: false, error: "当前环境不支持原生文件系统" };
        try { return JSON.parse(window.AndroidMCP.wbWriteFile(path, content)); } catch (e) { return { ok: false, error: "解析失败: " + e.message }; }
      },
      mkdir: function (path) {
        if (!this._guard()) return { ok: false, error: "当前环境不支持原生文件系统" };
        try { return JSON.parse(window.AndroidMCP.wbMkdir(path)); } catch (e) { return { ok: false, error: "解析失败: " + e.message }; }
      },
      del: function (path) {
        if (!this._guard()) return { ok: false, error: "当前环境不支持原生文件系统" };
        try { return JSON.parse(window.AndroidMCP.wbDelete(path)); } catch (e) { return { ok: false, error: "解析失败: " + e.message }; }
      },
      roots: function () {
        if (!this._guard()) return { ok: false, error: "当前环境不支持原生文件系统" };
        try { return JSON.parse(window.AndroidMCP.wbGetRoots()); } catch (e) { return { ok: false, error: "解析失败: " + e.message }; }
      },
      listPublic: function (path) {
        if (!this._guard()) return { ok: false, error: "当前环境不支持原生文件系统" };
        try { return JSON.parse(window.AndroidMCP.wbListPublicDir(path)); } catch (e) { return { ok: false, error: "解析失败: " + e.message }; }
      }
    },

    // ==================== 工具：GitHub（Contents API） ====================
    github: {
      config: function () {
        try { return JSON.parse(localStorage.getItem("wb_github_config")) || null; } catch (e) { return null; }
      },
      saveConfig: function (cfg) {
        localStorage.setItem("wb_github_config", JSON.stringify(cfg || null));
      },
      clearConfig: function () {
        localStorage.removeItem("wb_github_config");
      },
      headers: function () {
        var cfg = this.config();
        if (!cfg || !cfg.token) return null;
        return {
          "Authorization": "Bearer " + cfg.token,
          "Accept": "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28"
        };
      },
      /** 推送文件到 GitHub（Contents API，支持创建与更新） */
      pushFile: async function (opts) {
        var cfg = this.config();
        if (!cfg || !cfg.token || !cfg.username) return { ok: false, error: "尚未配置 GitHub（用户名/Token），请先在工作台设置中连接" };
        var owner = (opts.owner || cfg.username).trim();
        var repo = (opts.repo || cfg.repo || "").trim();
        if (!repo) return { ok: false, error: "未指定 GitHub 仓库（repo）" };
        var filePath = String(opts.path || "").trim();
        if (!filePath) return { ok: false, error: "未指定推送路径（path）" };
        var message = String(opts.message || "workbench update").trim();
        var content = String(opts.content || "");
        var branch = String(opts.branch || "main").trim();
        var headers = this.headers();
        try {
          // 1. 查询文件是否存在（拿 sha）
          var existingSha = null;
          var getRes = await fetch("https://api.github.com/repos/" + owner + "/" + repo + "/contents/" + filePath + "?ref=" + encodeURIComponent(branch), { headers: headers });
          if (getRes.status === 200) {
            var exist = await getRes.json();
            existingSha = exist.sha || null;
          } else if (getRes.status !== 404) {
            return { ok: false, error: "查询文件失败: HTTP " + getRes.status };
          }
          // 2. 创建 / 更新
          var payload = {
            message: message,
            content: btoa(unescape(encodeURIComponent(content))),
            branch: branch
          };
          if (existingSha) payload.sha = existingSha;
          var putRes = await fetch("https://api.github.com/repos/" + owner + "/" + repo + "/contents/" + filePath, {
            method: "PUT",
            headers: Object.assign({ "Content-Type": "application/json" }, headers),
            body: JSON.stringify(payload)
          });
          if (putRes.status === 200 || putRes.status === 201) {
            var data = await putRes.json();
            return { ok: true, message: "已推送 " + filePath + " 到 " + owner + "/" + repo + " (" + branch + ")", commit: (data.commit && data.commit.sha) || "" };
          }
          var errText = await putRes.text();
          return { ok: false, error: "推送失败: HTTP " + putRes.status + " " + errText.slice(0, 300) };
        } catch (e) {
          return { ok: false, error: "GitHub 请求异常: " + e.message };
        }
      }
    },

    // ==================== 数据层（IndexedDB：db.wb_conversations / db.wb_messages） ====================
    convs: async function () {
      try { return (await db.wb_conversations.orderBy("updatedAt").reverse().toArray()) || []; } catch (e) { return []; }
    },
    getConv: async function (id) {
      try { return await db.wb_conversations.get(Number(id)); } catch (e) { return null; }
    },
    addConv: async function (data) {
      return await db.wb_conversations.add(Object.assign({
        title: "未命名会话",
        workspace: ".",
        workspaceLabel: "工作台私有区",
        github: null,
        systemPrompt: "",
        summary: "",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        totalTokensIn: 0,
        totalTokensOut: 0,
        cacheHits: 0
      }, data || {}));
    },
    updateConv: async function (id, patch) {
      try { await db.wb_conversations.update(Number(id), Object.assign({ updatedAt: Date.now() }, patch)); } catch (e) {}
    },
    delConv: async function (id) {
      try { await db.wb_conversations.delete(Number(id)); } catch (e) {}
      try { await db.wb_messages.where("convId").equals(Number(id)).delete(); } catch (e) {}
    },
    msgs: async function (convId) {
      try { return (await db.wb_messages.where("convId").equals(Number(convId)).sortBy("seq")) || []; } catch (e) { return []; }
    },
    addMsg: async function (m) {
      try { return await db.wb_messages.add(m); } catch (e) { return null; }
    },
    lastMsg: async function (convId) {
      try { return (await db.wb_messages.where("convId").equals(Number(convId)).sortBy("seq")).pop() || null; } catch (e) { return null; }
    },

    // ==================== 工具集（供 Agent 调用） ====================
    tools: {
      list_dir: function (args, conv) {
        var p = WB.fsPath(args.path, conv);
        return WB.fs.listDir(p);
      },
      read_file: function (args, conv) {
        return WB.fs.readFile(WB.fsPath(args.path, conv));
      },
      write_file: function (args, conv) {
        if (typeof args.content !== "string") return { ok: false, error: "content 必须为字符串" };
        return WB.fs.writeFile(WB.fsPath(args.path, conv), args.content);
      },
      mkdir: function (args, conv) {
        return WB.fs.mkdir(WB.fsPath(args.path, conv));
      },
      delete_path: function (args, conv) {
        return WB.fs.del(WB.fsPath(args.path, conv));
      },
      workspace_info: function (args, conv) {
        var roots = WB.fs.roots();
        return { ok: true, workspace: conv.workspace || ".", label: conv.workspaceLabel || "", roots: roots.roots || [] };
      },
      fetch_url: async function (args) {
        try {
          var url = String(args.url || "");
          if (!/^https?:\/\//i.test(url)) return { ok: false, error: "仅支持 http/https 地址" };
          var res = await fetch(url, {
            method: String(args.method || "GET").toUpperCase(),
            headers: (args.headers && typeof args.headers === "object") ? args.headers : {},
            body: (args.body && args.method && args.method !== "GET") ? String(args.body) : undefined
          });
          var text = await res.text();
          return { ok: true, status: res.status, body: text.slice(0, 8000) };
        } catch (e) {
          return { ok: false, error: "抓取失败: " + e.message };
        }
      },
      github_push: async function (args, conv) {
        return await WB.github.pushFile(args);
      },
      github_status: function (args, conv) {
        var cfg = WB.github.config();
        return { ok: true, connected: !!cfg, username: cfg ? cfg.username : "", repo: cfg ? (cfg.repo || "") : "" };
      },
      mcp_tool: async function (args) {
        // 复用外部 MCP 服务器工具（mcpClientSystem.callMcpTool）
        try {
          if (window.mcpClientSystem && typeof window.mcpClientSystem.callMcpTool === "function") {
            var result = await window.mcpClientSystem.callMcpTool(args.server, args.tool, args.arguments || {});
            return { ok: true, result: result };
          }
          return { ok: false, error: "MCP 客户端未就绪" };
        } catch (e) {
          return { ok: false, error: "MCP 调用失败: " + e.message };
        }
      }
    },

    /** 把 Agent 传来的相对路径换算为对话工作区下的实际路径 */
    fsPath: function (rel, conv) {
      var p = String(rel || "").trim();
      if (!p || p === ".") return conv.workspace || ".";
      if (p.indexOf("/") === 0) return conv.workspace + p;
      if (conv.workspace && conv.workspace !== ".") return conv.workspace + "/" + p;
      return p;
    },

    // ==================== 工具执行 ====================
    executeTool: async function (tool, args, conv) {
      var fn = this.tools[tool];
      if (!fn) return { ok: false, error: "未知工具: " + tool + "（可用工具: " + Object.keys(this.tools).join(", ") + "）" };
      try {
        var result = await fn(args || {}, conv);
        if (result === undefined) result = { ok: true, note: "执行完成" };
        return result;
      } catch (e) {
        return { ok: false, error: "工具执行异常: " + e.message };
      }
    },
    // ==================== LLM 调用（复用全局 fetchStreamOrJson 流式引擎） ====================
    /** 工作台自有流式调用（含 usage 捕获：token 统计与缓存命中） */
    wbStreamChat: async function (baseUrl, api, messages, signal, onChunk, onUsage) {
      var cleanBaseUrl = String(baseUrl || "").replace(/\/+$/, "");
      var endpoint = cleanBaseUrl.indexOf("/chat/completions") > 0 ? cleanBaseUrl : cleanBaseUrl + "/chat/completions";
      var streamEnabled = !api.disableStream;
      if (streamEnabled) {
        var response = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Accept": "text/event-stream, application/json, */*", "Authorization": "Bearer " + api.key },
          body: JSON.stringify({ model: api.model, messages: messages, temperature: api.temperature, stream: true }),
          signal: signal
        });
        if (!response.ok) {
          var errText = await response.text();
          throw new Error("HTTP " + response.status + " " + String(errText).slice(0, 300));
        }
        if (!response.body) throw new Error("响应流不可用");
        var reader = response.body.getReader();
        var decoder = new TextDecoder("utf-8");
        var buffer = "";
        var contentText = "";
        var usage = null;
        while (true) {
          var r = await reader.read();
          if (r.done) break;
          buffer += decoder.decode(r.value, { stream: true });
          var lines = buffer.split("\n");
          buffer = lines.pop() || "";
          for (var i = 0; i < lines.length; i++) {
            var line = lines[i].trim();
            if (!line || line.indexOf("data: ") !== 0) continue;
            var dataStr = line.slice(6).trim();
            if (dataStr === "[DONE]") continue;
            try {
              var parsed = JSON.parse(dataStr);
              var delta = (parsed.choices && parsed.choices[0] && parsed.choices[0].delta && parsed.choices[0].delta.content) || "";
              if (delta) {
                contentText += delta;
                if (onChunk) onChunk(delta, contentText);
              }
              if (parsed.usage) usage = parsed.usage;
            } catch (e) {}
          }
        }
        if (usage && onUsage) onUsage(usage);
        return contentText;
      }
      var res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Accept": "application/json, */*", "Authorization": "Bearer " + api.key },
        body: JSON.stringify({ model: api.model, messages: messages, temperature: api.temperature, stream: false }),
        signal: signal
      });
      if (!res.ok) {
        var t = await res.text();
        throw new Error("HTTP " + res.status + " " + String(t).slice(0, 300));
      }
      var result = await res.json();
      if (result && result.usage && onUsage) onUsage(result.usage);
      var content = (result.choices && result.choices[0] && result.choices[0].message && result.choices[0].message.content) || "";
      return content;
    },

    getApiPreset: async function () {
      try {
        var presets = await db.api_presets.toArray();
        var active = presets.find(function (p) { return p.enabled; });
        return active || presets[0] || null;
      } catch (e) { return null; }
    },
    estimateTokens: function (text) {
      if (!text) return 0;
      var cjk = (text.match(/[\u4e00-\u9fff\u3000-\u303f]/g) || []).length;
      var other = text.length - cjk;
      return Math.ceil(cjk / 1.5 + other / 4);
    },

    // ==================== Agent 引擎 ====================
    buildSystemPrompt: function (conv) {
      var cfg = WB.github.config();
      var lines = [];
      lines.push("你是一个运行在手机端工作台里的全能 AI Agent（叙事诗小手机 · 工作台）。");
      lines.push("你可以读取、创建、修改本地工作区文件，向 GitHub 推送文件，抓取网页，调用 MCP 工具，像一名工程师一样帮用户完成实际任务。");
      lines.push("");
      lines.push("【当前对话工作区】");
      lines.push("- 工作区: " + (conv.workspaceLabel || conv.workspace || "."));
      lines.push("- 工作区路径(相对根): " + (conv.workspace || "."));
      lines.push("");
      lines.push("【GitHub 连接】" + (cfg && cfg.token ? "已连接（用户名: " + (cfg.username || "") + (cfg.repo ? "，默认仓库: " + cfg.repo : "") + "）" : "未连接（用户可在设置中配置用户名与 Token）"));
      lines.push("");
      lines.push("【可用工具（通过工具标签调用）】");
      lines.push("1. list_dir: 列出目录内容。参数 {path}（相对工作区）");
      lines.push("2. read_file: 读取文本文件。参数 {path}");
      lines.push("3. write_file: 写入/创建文本文件。参数 {path, content}");
      lines.push("4. mkdir: 创建目录。参数 {path}");
      lines.push("5. delete_path: 删除文件或目录。参数 {path}");
      lines.push("6. workspace_info: 查看工作区信息");
      lines.push("7. fetch_url: 抓取网页内容。参数 {url, method?, headers?, body?}");
      lines.push("8. github_push: 推送文件到 GitHub。参数 {path(仓库内路径), content, message?, repo?, owner?, branch?}");
      lines.push("9. github_status: 查看 GitHub 连接状态");
      lines.push("10. mcp_tool: 调用已配置的外部 MCP 服务器工具。参数 {server, tool, arguments}");
      lines.push("");
      lines.push("【工具调用语法（极其重要）】");
      lines.push("当你需要调用工具时，在你的回复中单独输出一行（必须单独占一行）：");
      lines.push("[WB_TOOL:{\"tool\":\"工具名\",\"arguments\":{...}}]");
      lines.push("执行结果会自动作为新消息返回给你，你可以继续调用或给出最终结论。一行只放一个工具调用。");
      lines.push("路径一律使用相对工作区的路径；写文件前如不确定可先 list_dir / read_file 查看。");
      lines.push("");
      lines.push("【行为准则】");
      lines.push("- 先思考用户要达成的目标，分步骤使用工具，不要一次输出多个工具调用标签；");
      lines.push("- 工具结果较长时，提炼要点后再继续；");
      lines.push("- 任务完成后，用自然语言向用户汇报做了什么、结果如何、文件在哪；");
      lines.push("- 涉及删除/覆盖等危险操作前，先明确告知用户并获得同意。");
      if (conv.systemPrompt) {
        lines.push("");
        lines.push("【用户为本对话设定的补充规则】");
        lines.push(conv.systemPrompt);
      }
      return lines.join("\n");
    },

    buildMessages: function (conv, history) {
      var sys = this.buildSystemPrompt(conv);
      var msgs = [{ role: "system", content: sys }];
      if (conv.summary) {
        msgs.push({ role: "system", content: "【较早对话摘要】" + conv.summary });
      }
      var budget = WB.MAX_CONTEXT_TOKENS - WB.estimateTokens(sys) - (conv.summary ? WB.estimateTokens(conv.summary) : 0);
      var recent = [];
      for (var i = history.length - 1; i >= 0; i--) {
        var m = history[i];
        var t = WB.estimateTokens(m.content || "");
        if (budget - t < 200 && recent.length > 2) break;
        recent.unshift({ role: m.role === "assistant" ? "assistant" : "user", content: m.content || "" });
        budget -= t;
      }
      return msgs.concat(recent);
    },

    parseToolCall: function (text) {
      var re = /\[\s*WB_TOOL\s*:\s*(\{[\s\S]*?\})\s*\]/i;
      var m = String(text || "").match(re);
      if (!m) return null;
      try {
        var obj = JSON.parse(m[1]);
        if (!obj || typeof obj.tool !== "string") return null;
        return { fullMatch: m[0], tool: obj.tool, arguments: obj.arguments || {} };
      } catch (e) { return null; }
    },

    runAgent: async function (conv, userText) {
      if (this.state.sending) return;
      this.state.sending = true;
      var preset = await this.getApiPreset();
      if (!preset || !preset.url || !preset.key) {
        this.appendSysMsg("未配置可用 API（请先在 设置-API 服务 中配置并启用一个服务）");
        this.state.sending = false;
        return;
      }
      var seq = (await this.msgs(conv.id)).length;
      var turnTokensIn = 0, turnTokensOut = 0, turnCache = 0;

      await this.addMsg({ convId: conv.id, seq: seq++, role: "user", content: userText, createdAt: Date.now() });
      this.appendBubble("user", userText);

      var history = await this.msgs(conv.id);
      var messages = this.buildMessages(conv, history);
      var loop = 0;
      var aborted = false;

      while (loop < WB.MAX_TOOL_LOOPS && !aborted) {
        loop++;
        var reply = "";
        var usage = null;
        var ctrl = new AbortController();
        this.state.abortCtrl = ctrl;
        var bubble = this.appendBubble("assistant", "");
        try {
          reply = await this.wbStreamChat(
            preset.url,
            { key: preset.key, model: preset.model, temperature: preset.temperature },
            messages,
            ctrl.signal,
            function (delta, fullText) {
              reply = fullText;
              if (bubble && bubble._el) bubble._el.textContent = fullText;
            },
            function (u) { usage = u; }
          );
        } catch (e) {
          if (e && e.name === "AbortError") { aborted = true; }
          else {
            this.appendSysMsg("请求失败: " + (e && e.message ? e.message : String(e)));
            this.state.sending = false;
            return;
          }
        }
        if (aborted) break;

        if (usage && usage.prompt_tokens) turnTokensIn += usage.prompt_tokens;
        if (usage && usage.completion_tokens) turnTokensOut += usage.completion_tokens;
        if (usage && usage.prompt_cache_hit_tokens) turnCache += usage.prompt_cache_hit_tokens;

        await this.addMsg({ convId: conv.id, seq: seq++, role: "assistant", content: reply, createdAt: Date.now() });
        if (bubble && bubble._el) bubble._el.textContent = reply;

        var toolCall = this.parseToolCall(reply);
        if (!toolCall) break;

        var card = this.appendToolCard(toolCall.tool, toolCall.arguments);
        var result = await this.executeTool(toolCall.tool, toolCall.arguments, conv);
        card._render(result);
        var resultText = JSON.stringify(result);
        if (resultText.length > 6000) resultText = resultText.slice(0, 6000) + "...(截断)";
        await this.addMsg({ convId: conv.id, seq: seq++, role: "tool", content: resultText, createdAt: Date.now() });
        messages = messages.concat([
          { role: "assistant", content: reply },
          { role: "user", content: "[工具结果] " + resultText }
        ]);
        if (messages.length > 40) {
          messages = messages.slice(-30);
          messages.unshift({ role: "system", content: "（上下文已裁剪，保留最近对话）" });
        }
      }

      var convPatch = {
        totalTokensIn: (conv.totalTokensIn || 0) + turnTokensIn,
        totalTokensOut: (conv.totalTokensOut || 0) + turnTokensOut,
        cacheHits: (conv.cacheHits || 0) + turnCache
      };
      if (!conv.title || conv.title === "未命名会话") {
        convPatch.title = userText.slice(0, 18) + (userText.length > 18 ? "..." : "");
      }
      await this.updateConv(conv.id, convPatch);
      conv = Object.assign(conv, convPatch);
      this.updateChatHeader(conv);
      this.state.sending = false;
      this.state.abortCtrl = null;
      this.scrollToBottom();
    },

    stopAgent: function () {
      if (this.state.abortCtrl) {
        try { this.state.abortCtrl.abort(); } catch (e) {}
        this.state.abortCtrl = null;
      }
      this.state.sending = false;
      var btn = document.getElementById("wb-send-btn");
      if (btn) btn.style.display = "flex";
      var stopBtn = document.getElementById("wb-stop-btn");
      if (stopBtn) stopBtn.style.display = "none";
    },
    // ==================== 渲染：视图 ====================
    init: function () {
      var body = document.getElementById("wb-body");
      if (!body) return;
      this.bindClose();
      this.renderList();
    },

    bindClose: function () {
      var btn = document.getElementById("wb-close-btn");
      if (btn) btn.onclick = function () { if (typeof closeApp === "function") closeApp("workbench"); };
    },

    svg: function (d, size, extra) {
      size = size || 16;
      return '<svg viewBox="0 0 24 24" width="' + size + '" height="' + size + '" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;' + (extra || "") + '">' + d + '</svg>';
    },

    // ============ 会话列表 ============
    renderList: function () {
      var self = this;
      this.state.view = "list";
      this.state.activeConvId = null;
      var body = document.getElementById("wb-body");
      if (!body) return;
      this.convs().then(function (convs) {
        var cfg = self.github.config();
        var cards = convs.map(function (c) {
          var gh = c.github ? '<span style="display:inline-flex;align-items:center;gap:2px;font-size:9px;color:#16a34a;background:#dcfce7;border-radius:4px;padding:1px 5px;">' + self.svg('<path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/>', 10) + 'GitHub</span>' : "";
          var ws = c.workspaceLabel ? '<span style="display:inline-flex;align-items:center;gap:2px;font-size:9px;color:#0e7490;background:#cffafe;border-radius:4px;padding:1px 5px;">' + self.svg('<path d="M3 7v10a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-6l-2-2H5a2 2 0 0 0-2 2z"/>', 10) + self.esc(c.workspaceLabel) + '</span>' : "";
          var time = self.fmtTime(c.updatedAt);
          var tokens = '<span style="font-size:9px;color:#64748b;">↑' + (c.totalTokensIn || 0) + ' ↓' + (c.totalTokensOut || 0) + '</span>';
          return '<div class="wb-conv-card" data-id="' + c.id + '" style="background:#fff;border:1.5px solid var(--border);border-radius:14px;padding:12px;margin-bottom:10px;cursor:pointer;transition:all .15s;box-shadow:var(--shadow-sm);">' +
            '<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">' +
              '<div style="font-size:13px;font-weight:700;color:var(--text-primary);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + self.esc(c.title) + '</div>' +
              '<div style="display:flex;align-items:center;gap:4px;">' + gh + ws + tokens + '</div>' +
            '</div>' +
            (c.summary ? '<div style="font-size:10px;color:var(--text-secondary);margin-top:6px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;">摘要: ' + self.esc(c.summary) + '</div>' : '') +
            '<div style="font-size:10px;color:#94a3b8;margin-top:8px;display:flex;align-items:center;justify-content:space-between;">' +
              '<span>' + self.fmtDate(c.updatedAt) + ' ' + time + '</span>' +
              '<button class="wb-del-btn" data-id="' + c.id + '" style="border:none;background:none;color:#ef4444;cursor:pointer;padding:2px;">' + self.svg('<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>', 15) + '</button>' +
            '</div>' +
          '</div>';
        }).join("");

        body.innerHTML =
          '<div style="display:flex;flex-direction:column;height:100%;">' +
            '<div style="display:flex;align-items:center;gap:8px;padding:12px 14px;border-bottom:1px solid var(--border);">' +
              '<div style="font-size:15px;font-weight:700;color:var(--text-primary);flex:1;display:flex;align-items:center;gap:6px;">' + self.svg('<path d="m7 8 3 3-3 3"/><path d="M12 16h5"/><rect x="3" y="4" width="18" height="16" rx="2"/>', 18) + '工作台</div>' +
              '<button class="wb-icon-btn" id="wb-github-btn" title="GitHub 连接" style="border:1.5px solid var(--border);background:#fff;border-radius:10px;padding:7px;cursor:pointer;color:' + (cfg && cfg.token ? "#16a34a" : "#94a3b8") + ';">' + self.svg('<path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22"/>', 17) + '</button>' +
              '<button class="wb-icon-btn" id="wb-new-btn" style="border:none;background:var(--primary);border-radius:10px;padding:7px 12px;cursor:pointer;color:#fff;font-size:12px;font-weight:700;display:flex;align-items:center;gap:4px;">' + self.svg('<path d="M12 5v14"/><path d="M5 12h14"/>', 14) + '新建</button>' +
            '</div>' +
            '<div id="wb-list" style="flex:1;overflow-y:auto;padding:12px 14px;">' +
              (cards || '<div style="text-align:center;color:#94a3b8;font-size:12px;padding:60px 20px;line-height:1.8;">' + self.svg('<path d="M9.813 15.904 9 18l.75.75L12 17.25l2.25 2.25L15 18l-.813-2.096a4.5 4.5 0 0 0-4.374 0z"/><path d="M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z"/>', 40, "color:#cbd5e1;display:block;margin:0 auto 10px;") + '还没有会话<br>点击右上角新建，开始你的第一个 Agent 任务') +
            '</div>' +
            '<div style="padding:8px 14px;border-top:1px solid var(--border);font-size:10px;color:#94a3b8;display:flex;align-items:center;gap:4px;">' + self.svg('<path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/>', 12) + '工作台 Agent · 本地工作区 + GitHub 推送 · 数据仅存本机' + '</div>' +
          '</div>';

        // 事件
        var listEl = document.getElementById("wb-list");
        listEl.querySelectorAll(".wb-conv-card").forEach(function (card) {
          card.addEventListener("click", function (ev) {
            if (ev.target.closest(".wb-del-btn")) return;
            self.showChat(Number(card.getAttribute("data-id")));
          });
        });
        listEl.querySelectorAll(".wb-del-btn").forEach(function (btn) {
          btn.addEventListener("click", function (ev) {
            ev.stopPropagation();
            var id = Number(btn.getAttribute("data-id"));
            self.confirmDialog("删除会话", "确定删除该会话及其全部对话记录吗？此操作不可恢复。", function () {
              self.delConv(id).then(function () { self.renderList(); });
            });
          });
        });
        document.getElementById("wb-new-btn").onclick = function () { self.showNewConvDialog(); };
        document.getElementById("wb-github-btn").onclick = function () { self.showGithubConfigDialog(); };
      });
    },

    // ============ 对话视图 ============
    showChat: function (convId) {
      var self = this;
      this.getConv(convId).then(function (conv) {
        if (!conv) return;
        self.state.view = "chat";
        self.state.activeConvId = conv.id;
        self.msgs(conv.id).then(function (msgs) {
          self.renderChat(conv, msgs);
        });
      });
    },

    renderChat: function (conv, msgs) {
      var self = this;
      var body = document.getElementById("wb-body");
      if (!body) return;
      var cfg = this.github.config();
      var ghBadge = conv.github
        ? '<span style="display:inline-flex;align-items:center;gap:3px;font-size:9px;color:#16a34a;background:#dcfce7;border-radius:6px;padding:2px 6px;">' + this.svg('<path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22"/>', 11) + (cfg ? cfg.username : "") + '</span>'
        : '<span style="font-size:9px;color:#94a3b8;background:#f1f5f9;border-radius:6px;padding:2px 6px;">未连 GitHub</span>';
      var wsBadge = '<span style="display:inline-flex;align-items:center;gap:3px;font-size:9px;color:#0e7490;background:#cffafe;border-radius:6px;padding:2px 6px;">' + this.svg('<path d="M3 7v10a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-6l-2-2H5a2 2 0 0 0-2 2z"/>', 11) + this.esc(conv.workspaceLabel || "工作台私有区") + '</span>';

      body.innerHTML =
        '<div style="display:flex;flex-direction:column;height:100%;">' +
          '<div style="display:flex;align-items:center;gap:6px;padding:8px 10px;border-bottom:1px solid var(--border);flex-wrap:wrap;">' +
            '<button class="wb-icon-btn" id="wb-back-btn" style="border:none;background:none;color:#475569;cursor:pointer;padding:4px;">' + this.svg('<path d="M15 18l-6-6 6-6"/>', 18) + '</button>' +
            '<div style="flex:1;min-width:0;font-size:13px;font-weight:700;color:var(--text-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + this.esc(conv.title) + '</div>' +
            wsBadge + ghBadge +
            '<span id="wb-usage" style="font-size:9px;color:#64748b;">↑' + (conv.totalTokensIn || 0) + ' ↓' + (conv.totalTokensOut || 0) + (conv.cacheHits ? ' 缓存:' + conv.cacheHits : '') + '</span>' +
            '<button class="wb-icon-btn" id="wb-conv-menu" style="border:none;background:none;color:#64748b;cursor:pointer;padding:4px;">' + this.svg('<circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/>', 16) + '</button>' +
          '</div>' +
          '<div id="wb-msgs" style="flex:1;overflow-y:auto;padding:12px 12px 8px 12px;display:flex;flex-direction:column;gap:10px;"></div>' +
          '<div style="border-top:1px solid var(--border);padding:8px 10px;background:#fff;">' +
            '<textarea id="wb-input" rows="2" placeholder="输入任务，例如：在工作区创建一个项目并写入示例代码，然后推送到 GitHub..." style="width:100%;box-sizing:border-box;border:1.5px solid var(--border);border-radius:12px;padding:10px 12px;font-size:13px;resize:none;outline:none;color:var(--text-primary);background:#f8fafc;line-height:1.5;"></textarea>' +
            '<div style="display:flex;align-items:center;gap:6px;margin-top:6px;">' +
              (this.fs._guard()
                ? '<button class="wb-icon-btn" id="wb-ws-pick" title="切换工作区" style="border:1px solid var(--border);background:#fff;border-radius:8px;padding:6px;cursor:pointer;color:#0e7490;">' + this.svg('<path d="M3 7v10a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-6l-2-2H5a2 2 0 0 0-2 2z"/>', 15) + '</button>' +
                '<span style="flex:1;font-size:9px;color:#94a3b8;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + this.esc(conv.workspaceLabel || "工作台私有区") + '</span>'
                : '<span style="flex:1;font-size:9px;color:#94a3b8;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">链接版：仅 GitHub 连接</span>') +
              '<button id="wb-stop-btn" style="display:none;border:none;background:#ef4444;color:#fff;border-radius:8px;padding:7px 12px;font-size:12px;font-weight:700;cursor:pointer;">' + this.svg('<rect x="6" y="6" width="12" height="12" rx="2"/>', 13) + '停止</button>' +
              '<button id="wb-send-btn" style="border:none;background:var(--primary);color:#fff;border-radius:8px;padding:7px 14px;font-size:12px;font-weight:700;cursor:pointer;display:flex;align-items:center;gap:4px;">' + this.svg('<path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4 20-7z"/>', 13) + '发送</button>' +
            '</div>' +
          '</div>' +
        '</div>';

      var msgsEl = document.getElementById("wb-msgs");
      msgs.forEach(function (m) {
        self.renderStoredMsg(msgsEl, m);
      });
      this.scrollToBottom();

      document.getElementById("wb-back-btn").onclick = function () { self.renderList(); };
      document.getElementById("wb-send-btn").onclick = function () { self.onSend(conv); };
      document.getElementById("wb-stop-btn").onclick = function () { self.stopAgent(); };
      var wsPick = document.getElementById("wb-ws-pick");
      if (wsPick) {
        wsPick.onclick = function () {
          self.showWorkspacePicker(function (path, label) {
            self.updateConv(conv.id, { workspace: path, workspaceLabel: label });
            conv.workspace = path; conv.workspaceLabel = label;
            self.showChat(conv.id);
          });
        };
      }
      document.getElementById("wb-conv-menu").onclick = function () { self.showConvMenu(conv); };
      document.getElementById("wb-input").addEventListener("keydown", function (ev) {
        if (ev.key === "Enter" && !ev.shiftKey) {
          ev.preventDefault();
          self.onSend(conv);
        }
      });
      document.getElementById("wb-input").focus();
      if (this.state.sending) {
        document.getElementById("wb-send-btn").style.display = "none";
        document.getElementById("wb-stop-btn").style.display = "flex";
      }
    },

    onSend: function (conv) {
      var input = document.getElementById("wb-input");
      if (!input) return;
      var text = input.value.trim();
      if (!text || this.state.sending) return;
      input.value = "";
      this.runAgent(conv, text);
    },

    renderStoredMsg: function (container, m) {
      var self = this;
      if (m.role === "user") {
        self.appendBubble("user", m.content);
      } else if (m.role === "assistant") {
        self.appendBubble("assistant", m.content);
      } else if (m.role === "tool") {
        // 历史工具结果折叠显示
        var div = document.createElement("div");
        div.style.cssText = "align-self:flex-start;background:#f1f5f9;border:1px dashed #cbd5e1;border-radius:10px;padding:8px 10px;font-size:10px;color:#64748b;max-width:88%;word-break:break-all;";
        div.textContent = "[工具结果] " + m.content.slice(0, 300) + (m.content.length > 300 ? "..." : "");
        container.appendChild(div);
      } else {
        var sys = document.createElement("div");
        sys.style.cssText = "align-self:center;font-size:10px;color:#94a3b8;background:#f8fafc;border-radius:8px;padding:4px 10px;max-width:80%;";
        sys.textContent = m.content;
        container.appendChild(sys);
      }
    },

    appendBubble: function (role, text) {
      var el = document.getElementById("wb-msgs");
      if (!el) return null;
      var wrap = document.createElement("div");
      wrap.style.cssText = role === "user"
        ? "align-self:flex-end;background:var(--primary);color:#fff;border-radius:14px 14px 4px 14px;padding:9px 12px;max-width:82%;font-size:13px;line-height:1.55;white-space:pre-wrap;word-break:break-word;box-shadow:var(--shadow-sm);"
        : "align-self:flex-start;background:#fff;border:1.5px solid var(--border);color:var(--text-primary);border-radius:14px 14px 14px 4px;padding:9px 12px;max-width:86%;font-size:13px;line-height:1.55;white-space:pre-wrap;word-break:break-word;box-shadow:var(--shadow-sm);";
      var content = document.createElement("div");
      content.style.cssText = "min-height:1em;";
      content.textContent = text || "";
      wrap.appendChild(content);
      el.appendChild(wrap);
      this.scrollToBottom();
      return { _el: content };
    },

    appendSysMsg: function (text) {
      var el = document.getElementById("wb-msgs");
      if (!el) return;
      var div = document.createElement("div");
      div.style.cssText = "align-self:center;font-size:11px;color:#b45309;background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:5px 12px;max-width:85%;";
      div.textContent = text;
      el.appendChild(div);
      this.scrollToBottom();
    },

    appendToolCard: function (tool, args) {
      var el = document.getElementById("wb-msgs");
      var card = document.createElement("div");
      card.style.cssText = "align-self:flex-start;background:#f0f9ff;border:1.5px solid #bae6fd;border-radius:12px;padding:8px 12px;width:88%;box-sizing:border-box;";
      card.innerHTML =
        '<div style="display:flex;align-items:center;gap:6px;font-size:11px;font-weight:700;color:#0369a1;">' + this.svg('<path d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4"/>', 13) + '调用工具: ' + this.esc(tool) +
        '<span style="margin-left:auto;font-weight:400;color:#94a3b8;">' + this.esc(JSON.stringify(args || {}).slice(0, 80)) + '</span></div>' +
        '<div class="wb-tool-result" style="margin-top:6px;font-size:10px;color:#475569;white-space:pre-wrap;word-break:break-all;max-height:220px;overflow-y:auto;"></div>';
      el.appendChild(card);
      this.scrollToBottom();
      return {
        _render: function (result) {
          var box = card.querySelector(".wb-tool-result");
          if (!box) return;
          if (result && result.ok) {
            box.style.color = "#15803d";
            box.textContent = result.error ? ("执行完成: " + result.error) : (result.message || "执行完成");
            if (result.entries && Array.isArray(result.entries)) {
              box.textContent = "共 " + result.entries.length + " 项: " + result.entries.map(function (en) { return en.name + (en.type === "dir" ? "/" : ""); }).join(", ").slice(0, 500);
            }
            if (result.content !== undefined) {
              box.textContent = String(result.content).slice(0, 2000);
            }
          } else {
            box.style.color = "#dc2626";
            box.textContent = "失败: " + ((result && result.error) || "未知错误");
          }
        }
      };
    },

    updateChatHeader: function (conv) {
      var usageEl = document.getElementById("wb-usage");
      if (usageEl) usageEl.textContent = "↑" + (conv.totalTokensIn || 0) + " ↓" + (conv.totalTokensOut || 0) + (conv.cacheHits ? " 缓存:" + conv.cacheHits : "");
    },

    scrollToBottom: function () {
      var el = document.getElementById("wb-msgs");
      if (el) el.scrollTop = el.scrollHeight;
    },

    // ============ 会话菜单 ============
    showConvMenu: function (conv) {
      var self = this;
      var items = [
        { label: "重命名会话", fn: function () { self.promptDialog("重命名会话", "输入新的会话标题", conv.title, function (val) { if (val) self.updateConv(conv.id, { title: val }); self.showChat(conv.id); }); } },
        { label: "切换 GitHub 连接状态", fn: function () {
          self.confirmDialog("GitHub 连接", conv.github ? "当前已连接 GitHub，是否断开本会话的 GitHub 标记？（不影响全局配置）" : "为当前会话标记为连接 GitHub？（需先在全局配置用户名与 Token）", function () {
            self.updateConv(conv.id, { github: !conv.github });
            self.showChat(conv.id);
          });
        } },
        { label: "清空本会话消息", fn: function () {
          self.confirmDialog("清空消息", "确定清空本会话全部消息记录吗？", function () {
            self.delConv(conv.id).then(function () {
              self.addConv({ title: conv.title, workspace: conv.workspace, workspaceLabel: conv.workspaceLabel, github: conv.github, systemPrompt: conv.systemPrompt }).then(function (newId) {
                self.showChat(newId);
              });
            });
          });
        } },
        { label: "删除会话", fn: function () {
          self.confirmDialog("删除会话", "确定删除该会话及全部记录吗？", function () {
            self.delConv(conv.id).then(function () { self.renderList(); });
          });
        } }
      ];
      var box = document.createElement("div");
      box.style.cssText = "position:fixed;top:70px;right:12px;background:#fff;border:1.5px solid var(--border);border-radius:12px;box-shadow:0 12px 32px rgba(15,23,42,0.12);z-index:100010;min-width:180px;overflow:hidden;";
      items.forEach(function (it) {
        var b = document.createElement("button");
        b.textContent = it.label;
        b.style.cssText = "display:block;width:100%;padding:10px 14px;border:none;background:#fff;cursor:pointer;font-size:12px;color:var(--text-primary);text-align:left;";
        b.addEventListener("mouseenter", function () { b.style.background = "#f1f5f9"; });
        b.addEventListener("mouseleave", function () { b.style.background = "#fff"; });
        b.addEventListener("click", function () { box.remove(); it.fn(); });
        box.appendChild(b);
      });
      document.body.appendChild(box);
      setTimeout(function () {
        document.addEventListener("click", function handler(ev) {
          if (!box.contains(ev.target)) { box.remove(); document.removeEventListener("click", handler); }
        });
      }, 0);
    },
    // ==================== 弹窗（自制卡片，禁止原生） ====================
    overlay: function (contentHtml, width) {
      var mask = document.createElement("div");
      mask.style.cssText = "position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(15,23,42,0.45);z-index:100000;display:flex;align-items:center;justify-content:center;padding:20px;";
      var card = document.createElement("div");
      card.style.cssText = "background:#fff;border-radius:16px;width:" + (width || 360) + "px;max-width:94vw;max-height:84vh;overflow-y:auto;padding:18px;box-shadow:0 24px 60px rgba(15,23,42,0.25);";
      card.innerHTML = contentHtml;
      mask.appendChild(card);
      mask.addEventListener("click", function (ev) { if (ev.target === mask) mask.remove(); });
      document.body.appendChild(mask);
      return { mask: mask, card: card, close: function () { mask.remove(); } };
    },

    confirmDialog: function (title, msg, onOk) {
      var self = this;
      if (typeof window.showCustomConfirm === "function") {
        window.showCustomConfirm(title, msg, function () { if (onOk) onOk(); });
        return;
      }
      var dlg = this.overlay(
        '<div style="display:flex;align-items:center;gap:6px;font-size:15px;font-weight:700;color:var(--text-primary);margin-bottom:10px;">' + this.svg('<path d="M12 9v2m0 4h.01M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>', 18, "color:#f59e0b;") + this.esc(title) + '</div>' +
        '<div style="font-size:13px;color:var(--text-secondary);line-height:1.6;margin-bottom:16px;white-space:pre-wrap;">' + this.esc(msg) + '</div>' +
        '<div style="display:flex;gap:8px;">' +
          '<button class="wb-dlg-cancel" style="flex:1;padding:9px;border:1.5px solid var(--border);background:#fff;border-radius:10px;font-size:12px;font-weight:700;color:var(--text-secondary);cursor:pointer;">取消</button>' +
          '<button class="wb-dlg-ok" style="flex:1;padding:9px;border:none;background:var(--primary);border-radius:10px;font-size:12px;font-weight:700;color:#fff;cursor:pointer;">确定</button>' +
        '</div>'
      );
      dlg.card.querySelector(".wb-dlg-cancel").onclick = function () { dlg.close(); };
      dlg.card.querySelector(".wb-dlg-ok").onclick = function () { dlg.close(); if (onOk) onOk(); };
    },

    promptDialog: function (title, msg, def, onOk) {
      var self = this;
      if (typeof window.showCustomPrompt === "function") {
        window.showCustomPrompt(title, msg, def, function (val) { if (onOk) onOk(val); });
        return;
      }
      var dlg = this.overlay(
        '<div style="font-size:15px;font-weight:700;color:var(--text-primary);margin-bottom:8px;">' + this.esc(title) + '</div>' +
        '<div style="font-size:12px;color:var(--text-secondary);margin-bottom:10px;">' + this.esc(msg) + '</div>' +
        '<input class="wb-dlg-input" type="text" value="' + this.esc(def || "") + '" style="width:100%;box-sizing:border-box;padding:9px;border:1.5px solid var(--border);border-radius:10px;font-size:13px;outline:none;margin-bottom:14px;">' +
        '<div style="display:flex;gap:8px;">' +
          '<button class="wb-dlg-cancel" style="flex:1;padding:9px;border:1.5px solid var(--border);background:#fff;border-radius:10px;font-size:12px;font-weight:700;color:var(--text-secondary);cursor:pointer;">取消</button>' +
          '<button class="wb-dlg-ok" style="flex:1;padding:9px;border:none;background:var(--primary);border-radius:10px;font-size:12px;font-weight:700;color:#fff;cursor:pointer;">确定</button>' +
        '</div>'
      );
      dlg.card.querySelector(".wb-dlg-cancel").onclick = function () { dlg.close(); };
      dlg.card.querySelector(".wb-dlg-ok").onclick = function () {
        var v = dlg.card.querySelector(".wb-dlg-input").value;
        dlg.close();
        if (onOk) onOk(v);
      };
    },

    // ============ 新建会话 ============
    showNewConvDialog: function () {
      var self = this;
      var wsLabel = "工作台私有区(Android/data/com.story.phone/files/workbench)";
      var wsPath = ".";
      var dlg = this.overlay(
        '<div style="display:flex;align-items:center;gap:6px;font-size:15px;font-weight:700;color:var(--text-primary);margin-bottom:12px;">' + this.svg('<path d="M12 5v14"/><path d="M5 12h14"/>', 18, "color:var(--primary);") + '新建工作台会话</div>' +
        '<div style="font-size:11px;font-weight:700;color:var(--text-secondary);margin-bottom:4px;">会话标题</div>' +
        '<input id="wb-new-title" type="text" placeholder="例如: 搭建一个天气查询工具" style="width:100%;box-sizing:border-box;padding:9px;border:1.5px solid var(--border);border-radius:10px;font-size:13px;outline:none;margin-bottom:10px;">' +
        (this.fs._guard()
          ? '<div style="font-size:11px;font-weight:700;color:var(--text-secondary);margin-bottom:4px;">专属本地工作区</div>' +
            '<button id="wb-new-ws" style="width:100%;display:flex;align-items:center;gap:6px;padding:9px;border:1.5px dashed var(--border);border-radius:10px;background:#f8fafc;font-size:12px;color:#0e7490;cursor:pointer;margin-bottom:10px;">' + this.svg('<path d="M3 7v10a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-6l-2-2H5a2 2 0 0 0-2 2z"/>', 14) + '<span id="wb-new-ws-label" style="flex:1;text-align:left;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + this.esc(wsLabel) + '</span>' + this.svg('<path d="M9 18l6-6-6-6"/>', 14) + '</button>'
          : '<div style="font-size:11px;color:#94a3b8;line-height:1.6;margin-bottom:10px;background:#f8fafc;border:1.5px dashed var(--border);border-radius:10px;padding:9px;">链接版（网页/PWA）无本地文件系统，本会话仅支持 GitHub 连接工作。</div>') +
        '<div style="display:flex;align-items:center;justify-content:space-between;padding:9px;border:1.5px solid var(--border);border-radius:10px;background:#fff;margin-bottom:10px;">' +
          '<div style="display:flex;align-items:center;gap:6px;font-size:12px;color:var(--text-primary);">' + this.svg('<path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22"/>', 15, "color:#16a34a;") + '连接 GitHub' +
          '</div>' +
          '<label style="display:flex;align-items:center;gap:4px;cursor:pointer;"><input type="checkbox" id="wb-new-gh" style="width:16px;height:16px;accent-color:var(--primary);"><span style="font-size:11px;color:var(--text-secondary);">推送/拉取仓库文件</span></label>' +
        '</div>' +
        '<div style="font-size:11px;font-weight:700;color:var(--text-secondary);margin-bottom:4px;">会话规则（可选）</div>' +
        '<textarea id="wb-new-sys" rows="2" placeholder="例如: 请全程使用中文回复，代码风格保持简洁" style="width:100%;box-sizing:border-box;padding:9px;border:1.5px solid var(--border);border-radius:10px;font-size:12px;resize:none;outline:none;margin-bottom:14px;"></textarea>' +
        '<div style="display:flex;gap:8px;">' +
          '<button class="wb-dlg-cancel" style="flex:1;padding:9px;border:1.5px solid var(--border);background:#fff;border-radius:10px;font-size:12px;font-weight:700;color:var(--text-secondary);cursor:pointer;">取消</button>' +
          '<button class="wb-dlg-ok" style="flex:1;padding:9px;border:none;background:var(--primary);border-radius:10px;font-size:12px;font-weight:700;color:#fff;cursor:pointer;">创建并开始</button>' +
        '</div>'
      );
      dlg.card.querySelector(".wb-dlg-cancel").onclick = function () { dlg.close(); };
      var wsBtn = document.getElementById("wb-new-ws");
      if (wsBtn) {
        wsBtn.onclick = function () {
          self.showWorkspacePicker(function (path, label) {
            wsPath = path; wsLabel = label;
            var lbl = document.getElementById("wb-new-ws-label");
            if (lbl) lbl.textContent = label;
          });
        };
      }
      dlg.card.querySelector(".wb-dlg-ok").onclick = async function () {
        var title = document.getElementById("wb-new-title").value.trim() || "未命名会话";
        var gh = document.getElementById("wb-new-gh").checked;
        var sys = document.getElementById("wb-new-sys").value.trim();
        var cfg = self.github.config();
        var id = await self.addConv({ title: title, workspace: wsPath, workspaceLabel: wsLabel, github: gh ? true : null, systemPrompt: sys });
        dlg.close();
        self.showChat(id);
      };
    },

    // ============ GitHub 配置 ============
    showGithubConfigDialog: function () {
      var self = this;
      var cfg = this.github.config() || {};
      var dlg = this.overlay(
        '<div style="display:flex;align-items:center;gap:6px;font-size:15px;font-weight:700;color:var(--text-primary);margin-bottom:12px;">' + this.svg('<path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22"/>', 18, "color:#16a34a;") + 'GitHub 连接配置</div>' +
        '<div style="font-size:11px;color:var(--text-secondary);line-height:1.6;margin-bottom:12px;">配置后 Agent 可通过 github_push 工具把工作区文件推送到你的仓库。Token 需具备 repo 权限（Fine-grained token 请勾选 Contents: Read and write）。Token 仅保存在本机。</div>' +
        '<div style="font-size:11px;font-weight:700;color:var(--text-secondary);margin-bottom:4px;">GitHub 用户名</div>' +
        '<input id="wb-gh-user" type="text" value="' + this.esc(cfg.username || "") + '" placeholder="例如: island-glitch" style="width:100%;box-sizing:border-box;padding:9px;border:1.5px solid var(--border);border-radius:10px;font-size:13px;outline:none;margin-bottom:10px;">' +
        '<div style="font-size:11px;font-weight:700;color:var(--text-secondary);margin-bottom:4px;">Personal Access Token</div>' +
        '<input id="wb-gh-token" type="password" value="' + this.esc(cfg.token || "") + '" placeholder="ghp_xxx / ghp_xxx" style="width:100%;box-sizing:border-box;padding:9px;border:1.5px solid var(--border);border-radius:10px;font-size:13px;outline:none;margin-bottom:10px;">' +
        '<div style="font-size:11px;font-weight:700;color:var(--text-secondary);margin-bottom:4px;">默认仓库（可选，owner/repo 格式）</div>' +
        '<input id="wb-gh-repo" type="text" value="' + this.esc(cfg.repo || "") + '" placeholder="例如: island-glitch/poemnarapk" style="width:100%;box-sizing:border-box;padding:9px;border:1.5px solid var(--border);border-radius:10px;font-size:13px;outline:none;margin-bottom:14px;">' +
        '<div style="display:flex;gap:8px;">' +
          '<button class="wb-dlg-clear" style="flex:1;padding:9px;border:1.5px solid #fecaca;background:#fef2f2;border-radius:10px;font-size:12px;font-weight:700;color:#dc2626;cursor:pointer;">清除配置</button>' +
          '<button class="wb-dlg-cancel" style="flex:1;padding:9px;border:1.5px solid var(--border);background:#fff;border-radius:10px;font-size:12px;font-weight:700;color:var(--text-secondary);cursor:pointer;">取消</button>' +
          '<button class="wb-dlg-ok" style="flex:1;padding:9px;border:none;background:var(--primary);border-radius:10px;font-size:12px;font-weight:700;color:#fff;cursor:pointer;">保存</button>' +
        '</div>'
      );
      dlg.card.querySelector(".wb-dlg-cancel").onclick = function () { dlg.close(); };
      dlg.card.querySelector(".wb-dlg-clear").onclick = function () {
        self.github.clearConfig();
        dlg.close();
        self.renderList();
        if (typeof showToast === "function") showToast("GitHub 配置已清除");
      };
      dlg.card.querySelector(".wb-dlg-ok").onclick = function () {
        var username = document.getElementById("wb-gh-user").value.trim();
        var token = document.getElementById("wb-gh-token").value.trim();
        var repo = document.getElementById("wb-gh-repo").value.trim();
        if (!username || !token) {
          if (typeof showToast === "function") showToast("请填写用户名与 Token");
          return;
        }
        self.github.saveConfig({ username: username, token: token, repo: repo });
        dlg.close();
        self.renderList();
        if (typeof showToast === "function") showToast("GitHub 配置已保存");
      };
    },

    // ============ 工作区选择器（目录树浏览） ============
    showWorkspacePicker: function (onPick) {
      var self = this;
      var dlg = this.overlay(
        '<div style="display:flex;align-items:center;gap:6px;font-size:15px;font-weight:700;color:var(--text-primary);margin-bottom:12px;">' + this.svg('<path d="M3 7v10a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-6l-2-2H5a2 2 0 0 0-2 2z"/>', 18, "color:#0e7490;") + '选择工作区文件夹</div>' +
        '<div style="font-size:11px;color:var(--text-secondary);margin-bottom:10px;line-height:1.6;">工作区位于手机存储 <b style="color:#0e7490;">Android/data/com.story.phone/files/workbench</b><br>可用文件管理器直接查看；免存储权限、天然隔离。公共存储仅可浏览。</div>' +
        '<div id="wb-pick-breadcrumb" style="font-size:11px;color:#0e7490;margin-bottom:8px;display:flex;align-items:center;gap:4px;flex-wrap:wrap;"></div>' +
        '<div id="wb-pick-list" style="max-height:300px;overflow-y:auto;border:1.5px solid var(--border);border-radius:10px;padding:6px;background:#f8fafc;min-height:80px;"></div>' +
        '<div style="display:flex;gap:6px;margin-top:10px;">' +
          '<input id="wb-pick-path-input" type="text" placeholder="或手动输入相对路径，如: my-project/src" style="flex:1;min-width:0;padding:8px;border:1.5px solid var(--border);border-radius:10px;font-size:11px;outline:none;">' +
          '<button id="wb-pick-path-btn" style="flex-shrink:0;padding:8px 12px;border:1.5px solid #0e7490;background:#ecfeff;border-radius:10px;font-size:11px;font-weight:700;color:#0e7490;cursor:pointer;">绑定路径</button>' +
        '</div>' +
        '<div style="display:flex;gap:8px;margin-top:10px;">' +
          '<button class="wb-dlg-cancel" style="flex:1;padding:9px;border:1.5px solid var(--border);background:#fff;border-radius:10px;font-size:12px;font-weight:700;color:var(--text-secondary);cursor:pointer;">取消</button>' +
          '<button class="wb-dlg-ok" style="flex:1;padding:9px;border:none;background:var(--primary);border-radius:10px;font-size:12px;font-weight:700;color:#fff;cursor:pointer;">选择此目录</button>' +
        '</div>'
      );
      var curPath = ".";
      var curLabel = "工作台私有区";

      function render() {
        var bc = document.getElementById("wb-pick-breadcrumb");
        var list = document.getElementById("wb-pick-list");
        bc.innerHTML = "";
        var segs = curPath === "." ? [] : curPath.split("/");
        var acc = "";
        var homeBtn = document.createElement("span");
        homeBtn.style.cssText = "cursor:pointer;font-weight:700;padding:2px 4px;border-radius:4px;";
        homeBtn.textContent = "工作台私有区";
        homeBtn.onclick = function () { curPath = "."; render(); };
        bc.appendChild(homeBtn);
        segs.forEach(function (seg, idx) {
          acc = acc ? acc + "/" + seg : seg;
          var arrow = document.createElement("span");
          arrow.textContent = " / ";
          arrow.style.color = "#cbd5e1";
          bc.appendChild(arrow);
          var sp = document.createElement("span");
          sp.textContent = seg;
          sp.style.cssText = "cursor:pointer;padding:2px 4px;border-radius:4px;";
          sp.onclick = function () { curPath = acc; render(); };
          bc.appendChild(sp);
        });
        list.innerHTML = '<div style="font-size:11px;color:#94a3b8;padding:10px;text-align:center;">加载中...</div>';
        var res = self.fs.listDir(curPath);
        if (!res.ok) {
          list.innerHTML = '<div style="font-size:11px;color:#dc2626;padding:10px;">' + self.esc(res.error || "读取失败") + '</div>';
          return;
        }
        var entries = (res.entries || []).filter(function (en) { return en.type === "dir"; });
        var files = (res.entries || []).filter(function (en) { return en.type === "file"; });
        list.innerHTML = "";
        if (curPath !== ".") {
          var up = document.createElement("div");
          up.style.cssText = "display:flex;align-items:center;gap:6px;padding:8px;cursor:pointer;border-radius:8px;font-size:12px;color:#64748b;";
          up.innerHTML = self.svg('<path d="M5 12h14"/><path d="M12 5l-7 7 7 7"/>', 14) + '返回上级';
          up.onclick = function () {
            var parts = curPath.split("/");
            parts.pop();
            curPath = parts.length ? parts.join("/") : ".";
            render();
          };
          list.appendChild(up);
        }
        entries.forEach(function (en) {
          var row = document.createElement("div");
          row.style.cssText = "display:flex;align-items:center;gap:6px;padding:8px;cursor:pointer;border-radius:8px;font-size:12px;color:var(--text-primary);";
          row.innerHTML = self.svg('<path d="M3 7v10a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-6l-2-2H5a2 2 0 0 0-2 2z"/>', 14, "color:#f59e0b;") + '<span style="flex:1;">' + self.esc(en.name) + '</span>' + self.svg('<path d="M9 18l6-6-6-6"/>', 12, "color:#cbd5e1;");
          row.onclick = function () {
            curPath = curPath === "." ? en.name : curPath + "/" + en.name;
            render();
          };
          list.appendChild(row);
        });
        if (entries.length === 0 && curPath === ".") {
          var hint = document.createElement("div");
          hint.style.cssText = "font-size:11px;color:#94a3b8;padding:12px;line-height:1.7;";
          hint.textContent = "私有区为空。可先选择此目录作为工作区，Agent 会在此创建项目文件。";
          list.appendChild(hint);
        }
        if (files.length > 0) {
          var fh = document.createElement("div");
          fh.style.cssText = "font-size:10px;color:#94a3b8;padding:6px 8px 2px;";
          fh.textContent = "文件 (" + files.length + "): " + files.slice(0, 6).map(function (f) { return f.name; }).join(", ") + (files.length > 6 ? " ..." : "");
          list.appendChild(fh);
        }
      }
      render();
      var pathBtn = dlg.card.querySelector("#wb-pick-path-btn");
      if (pathBtn) {
        pathBtn.onclick = function () {
          var raw = dlg.card.querySelector("#wb-pick-path-input").value.trim();
          if (!raw) { if (typeof showToast === "function") showToast("请输入相对路径"); return; }
          var clean = raw.replace(/\\/g, "/").replace(/^\.?\//, "");
          dlg.close();
          if (onPick) onPick(clean || ".", "手动路径: " + clean);
        };
      }
      dlg.card.querySelector(".wb-dlg-cancel").onclick = function () { dlg.close(); };
      dlg.card.querySelector(".wb-dlg-ok").onclick = function () {
        dlg.close();
        if (onPick) onPick(curPath, curLabel + (curPath === "." ? "" : " / " + curPath));
      };
    },

    // ============ 数据清理（设置-数据管理 入口） ============
    showClearDataDialog: function () {
      var self = this;
      var dlg = this.overlay(
        '<div style="display:flex;align-items:center;gap:6px;font-size:15px;font-weight:700;color:var(--text-primary);margin-bottom:6px;">' + this.svg('<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>', 18, "color:#ef4444;") + '清空工作台数据</div>' +
        '<div style="font-size:12px;color:var(--text-secondary);line-height:1.6;margin-bottom:14px;">工作台的对话记录、产物文件与配置说明：</div>' +
        '<div style="display:flex;flex-direction:column;gap:8px;margin-bottom:14px;">' +
          '<button class="wb-clear-opt" data-mode="chat" style="padding:10px;border:1.5px solid var(--border);border-radius:10px;background:#fff;font-size:12px;color:var(--text-primary);cursor:pointer;text-align:left;">' + this.svg('<path d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.86 9.86 0 0 1-4-.86L3 21l1.2-4.6A7.97 7.97 0 0 1 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"/>', 14, "color:#6366f1;") + ' 仅清空全部对话记录（保留 GitHub 配置与工作区文件）</button>' +
          '<button class="wb-clear-opt" data-mode="all" style="padding:10px;border:1.5px solid #fecaca;border-radius:10px;background:#fef2f2;font-size:12px;color:#b91c1c;cursor:pointer;text-align:left;">' + this.svg('<path d="M12 9v2m0 4h.01M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>', 14, "color:#dc2626;") + ' 对话 + GitHub 配置 + 工作区文件 一并清空</button>' +
        '</div>' +
        '<div style="display:flex;gap:8px;">' +
          '<button class="wb-dlg-cancel" style="flex:1;padding:9px;border:1.5px solid var(--border);background:#fff;border-radius:10px;font-size:12px;font-weight:700;color:var(--text-secondary);cursor:pointer;">取消</button>' +
        '</div>'
      );
      dlg.card.querySelector(".wb-dlg-cancel").onclick = function () { dlg.close(); };
      dlg.card.querySelectorAll(".wb-clear-opt").forEach(function (btn) {
        btn.onclick = function () {
          var mode = btn.getAttribute("data-mode");
          dlg.close();
          self.confirmDialog("确认清空", mode === "all" ? "将清空全部工作台对话，并删除 GitHub 配置与工作区文件。此操作不可恢复，确定继续吗？" : "将清空全部工作台对话记录（保留 GitHub 配置与工作区文件）。确定继续吗？", async function () {
            try {
              await db.wb_conversations.clear();
              await db.wb_messages.clear();
              if (mode === "all") {
                self.github.clearConfig();
                if (self.fs._guard()) { self.fs.del("."); }
              }
              if (typeof showToast === "function") showToast("工作台数据已清空");
              self.renderList();
            } catch (e) {
              if (typeof showToast === "function") showToast("清空失败: " + e.message);
            }
          });
        };
      });
    },

    // ==================== 工具函数 ====================
    esc: function (s) {
      return String(s == null ? "" : s)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
    },
    fmtTime: function (ts) {
      try {
        var d = new Date(ts);
        return ("0" + d.getHours()).slice(-2) + ":" + ("0" + d.getMinutes()).slice(-2);
      } catch (e) { return ""; }
    },
    fmtDate: function (ts) {
      try {
        var d = new Date(ts);
        var now = new Date();
        if (d.toDateString() === now.toDateString()) return "今天";
        return (d.getMonth() + 1) + "月" + d.getDate() + "日";
      } catch (e) { return ""; }
    }
  };

  // ==================== 全局导出 ====================
  window.workbenchSystem = WB;
  window.initWorkbenchApp = function () {
    WB.init();
  };
  window.clearWorkbenchData = function () {
    if (WB && typeof WB.showClearDataDialog === "function") WB.showClearDataDialog();
  };
})();
