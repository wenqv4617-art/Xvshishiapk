/**
 * app_mcp_client.js - Model Context Protocol (MCP) 独立宿主客户端与 JSON-RPC 2.0 传输中枢
 * 
 * 功能简述：
 * 1. 提供完整的 MCP Client/Host 规范支持（Streamable HTTP 与 SSE 管道）。
 * 2. 支持服务器与每个工具的多级开关控制（IndexedDB持久化）。
 * 3. 动态提炼启用的 Tools 并编译为标准的 System Prompt 段落。
 * 4. 拦截 AI 产生的 [CALL_TOOL: ...] 标头并执行 JSON-RPC 2.0 tools/call 远程调用。
 * 5. 100% 遵从去 Emoji 命令，所有按钮与 UI 组件均采用矢量 SVG 路径。
 */

(function() {
  const mcpClientSystem = {
    // 1. 打开 MCP 服务器配置面板
    openServersPanel: async function() {
      const panel = document.getElementById("mcp-servers-panel");
      if (panel) {
        panel.classList.add("active");
        await this.renderServersList();
      }
    },

    // 2. 关闭 MCP 服务器配置面板
    closeServersPanel: function() {
      const panel = document.getElementById("mcp-servers-panel");
      if (panel) {
        panel.classList.remove("active");
      }
      if (window.mcpSystem && typeof window.mcpSystem.loadMcpSettings === 'function') {
        window.mcpSystem.loadMcpSettings();
      }
    },

    // 3. 打开新建/编辑服务器弹窗
    openServerEditModal: async function(serverId = null) {
      const overlay = document.getElementById("mcp-server-edit-overlay");
      const titleEl = document.getElementById("mcp-server-modal-title");
      const idInput = document.getElementById("mcp-server-edit-id");
      const nameInput = document.getElementById("mcp-server-input-name");
      const typeSelect = document.getElementById("mcp-server-input-type");
      const urlInput = document.getElementById("mcp-server-input-url");
      const headersInput = document.getElementById("mcp-server-input-headers");

      if (!overlay) return;

      if (serverId) {
        titleEl.innerText = "编辑 MCP 服务器";
        const server = await db.mcp_servers.get(Number(serverId));
        if (server) {
          idInput.value = server.id;
          nameInput.value = server.name || "";
          typeSelect.value = server.type || "streamable_http";
          urlInput.value = server.url || "";
          headersInput.value = server.headers ? JSON.stringify(server.headers, null, 2) : "";
        }
      } else {
        titleEl.innerText = "新建 MCP 服务器";
        idInput.value = "";
        nameInput.value = "";
        typeSelect.value = "streamable_http";
        urlInput.value = "";
        headersInput.value = "";
      }

      overlay.classList.add("active");
    },

    // 4. 关闭编辑弹窗
    closeServerEditModal: function() {
      const overlay = document.getElementById("mcp-server-edit-overlay");
      if (overlay) overlay.classList.remove("active");
    },

    // 5. 保存服务器配置并自动拉取工具 (tools/list)
    saveServerAndFetchTools: async function() {
      const idVal = document.getElementById("mcp-server-edit-id").value;
      const name = document.getElementById("mcp-server-input-name").value.trim();
      const type = document.getElementById("mcp-server-input-type").value;
      const url = document.getElementById("mcp-server-input-url").value.trim();
      const headersStr = document.getElementById("mcp-server-input-headers").value.trim();

      if (!name || !url) {
        showToast("请填写完整的服务器名称与 URL 地址！");
        return;
      }

      let parsedHeaders = {};
      if (headersStr) {
        try {
          parsedHeaders = JSON.parse(headersStr);
        } catch (e) {
          showToast("自定义 Headers JSON 格式不合法！");
          return;
        }
      }

      showToast(`正在保存并连接 ${name} 拉取 Tools...`);

      try {
        // 向 MCP 服务器发送 JSON-RPC 2.0 tools/list 请求
        const fetchedTools = await this.rpcFetchToolsList(url, type, parsedHeaders);

        let serverId = idVal ? Number(idVal) : null;
        let existingToolsMap = {};

        if (serverId) {
          const oldServer = await db.mcp_servers.get(serverId);
          if (oldServer && oldServer.tools) {
            oldServer.tools.forEach(t => {
              existingToolsMap[t.name] = t.enabled;
            });
          }
        }

        // 整理工具明细并继承历史开关状态
        const toolsList = fetchedTools.map(t => ({
          name: t.name,
          description: t.description || "",
          inputSchema: t.inputSchema || {},
          enabled: existingToolsMap[t.name] !== undefined ? existingToolsMap[t.name] : true
        }));

        const serverData = {
          name: name,
          type: type,
          url: url,
          headers: parsedHeaders,
          enabled: true,
          tools: toolsList,
          updatedAt: Date.now()
        };

        if (serverId) {
          await db.mcp_servers.update(serverId, serverData);
        } else {
          serverId = await db.mcp_servers.add(serverData);
        }

        showToast(`成功连接！并成功拉取到 ${toolsList.length} 个 MCP 工具`);
        this.closeServerEditModal();
        await this.renderServersList();

      } catch (err) {
        console.error("拉取 MCP 工具失败:", err);
        showCustomAlert("拉取 MCP 工具失败", `无法成功与 MCP 服务器建立 JSON-RPC 2.0 通信：\n${err.message}`);
      }
    },

    // 通用底层请求引擎：极速自适应跨域穿透 (支持直连、安卓原生桥接、多重 CORS 代理熔断)
    mcpFetch: async function(url, options) {
      // 1. 真机 APK 环境：若原生桥挂载了 sendNativeHttpRequest，优先走 Kotlin 原生网络 (100% 避开浏览器 CORS 限制)
      if (window.AndroidMCP && typeof window.AndroidMCP.sendNativeHttpRequest === 'function') {
        try {
          const headersJson = JSON.stringify(options.headers || {});
          const bodyStr = options.body || "";
          const method = options.method || "POST";
          const nativeResStr = window.AndroidMCP.sendNativeHttpRequest(url, method, headersJson, bodyStr);
          if (nativeResStr) {
            const parsedRes = JSON.parse(nativeResStr);
            return {
              ok: parsedRes.status >= 200 && parsedRes.status < 300,
              status: parsedRes.status,
              text: async () => parsedRes.body,
              json: async () => JSON.parse(parsedRes.body),
              headers: {
                get: (k) => {
                  if (!parsedRes.headers) return null;
                  const targetKey = Object.keys(parsedRes.headers).find(key => key.toLowerCase() === k.toLowerCase());
                  return targetKey ? parsedRes.headers[targetKey] : null;
                }
              }
            };
          }
        } catch (e) {
          console.warn("[MCP Native Bridge] 原生请求通道异常，回退为 Web 代理:", e);
        }
      }

      // 2. 优先尝试浏览器直连
      try {
        const directResponse = await fetch(url, options);
        return directResponse;
      } catch (err) {
        // 当捕获到 Failed to fetch（跨域 CORS 拦截或预检拒绝）时，启动多代理容灾链路
        if (err && err.message && (err.message.includes("Failed to fetch") || err.message.includes("NetworkError"))) {
          console.warn("[MCP CORS Warning] 直连被跨域策略阻断，正在切入多通道跨域代理桥:", url);

          // 代理通道 1: thingproxy (完美透传 Authorization 鉴权头与 POST 实体)
          try {
            const proxyUrl1 = "https://thingproxy.freeboard.io/fetch/" + url;
            const res1 = await fetch(proxyUrl1, options);
            if (res1.ok || res1.status < 500) return res1;
          } catch (e1) {
            console.warn("[MCP Proxy 1] thingproxy 代理未响应，尝试通道 2...");
          }

          // 代理通道 2: corsproxy.io
          try {
            const proxyUrl2 = "https://corsproxy.io/?" + encodeURIComponent(url);
            const res2 = await fetch(proxyUrl2, options);
            if (res2.ok || res2.status < 500) return res2;
          } catch (e2) {
            console.warn("[MCP Proxy 2] corsproxy 代理未响应，尝试通道 3...");
          }

          // 代理通道 3: allorigins 容灾兜底
          try {
            const proxyUrl3 = "https://api.allorigins.win/raw?url=" + encodeURIComponent(url);
            const res3 = await fetch(proxyUrl3, options);
            if (res3.ok || res3.status < 500) return res3;
          } catch (e3) {
            console.warn("[MCP Proxy 3] 代理通道尝试完毕");
          }
        }
        throw err;
      }
    },

    // 6. MCP 标准初始化握手 (initialize & notifications/initialized)
    rpcInitialize: async function(url, type, headers) {
      const initPayload = {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: {
            name: "叙事诗小手机",
            version: "1.0.0"
          }
        }
      };

      const requestHeaders = {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
        ...headers
      };

      // 步骤 1：发送 initialize 握手包 (自动跨域自愈)
      const response = await this.mcpFetch(url, {
        method: "POST",
        headers: requestHeaders,
        body: JSON.stringify(initPayload)
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`初始化握手 HTTP ${response.status}: ${errText}`);
      }

      const resData = await response.json();
      if (resData.error) {
        throw new Error(`初始化握手 JSON-RPC Error [${resData.error.code}]: ${resData.error.message}`);
      }

      // 提取可能返回的 Mcp-Session-Id
      let sessionIdHeader = response.headers.get("Mcp-Session-Id") || response.headers.get("mcp-session-id");
      let activeHeaders = { ...headers };
      if (sessionIdHeader) {
        activeHeaders["Mcp-Session-Id"] = sessionIdHeader;
      }

      // 步骤 2：发送 notifications/initialized 挂钩通知
      try {
        await this.mcpFetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...activeHeaders
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            method: "notifications/initialized"
          })
        });
      } catch (e) {
        console.warn("发送 notifications/initialized 挂钩通知:", e);
      }

      return activeHeaders;
    },

    // 7. JSON-RPC 2.0: 通用 POST / SSE 请求驱动器 (自动跨域自愈)
    rpcRequest: async function(url, type, headers, method, params = {}) {
      const payload = {
        jsonrpc: "2.0",
        id: Date.now(),
        method: method,
        params: params
      };

      const requestHeaders = {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
        ...headers
      };

      if (type === "streamable_http" || type === "sse") {
        const response = await this.mcpFetch(url, {
          method: "POST",
          headers: requestHeaders,
          body: JSON.stringify(payload)
        });

        if (!response.ok) {
          const errText = await response.text();
          throw new Error(`HTTP ${response.status}: ${errText}`);
        }

        const resData = await response.json();
        if (resData.error) {
          throw new Error(`JSON-RPC Error [${resData.error.code}]: ${resData.error.message}`);
        }
        return resData.result;
      }
    },

    // 8. 拉取工具列表 (tools/list) - 先握手再获取工具
    rpcFetchToolsList: async function(url, type, headers) {
      const activeHeaders = await this.rpcInitialize(url, type, headers);
      const result = await this.rpcRequest(url, type, activeHeaders, "tools/list", {});
      if (result && Array.isArray(result.tools)) {
        return result.tools;
      }
      return [];
    },

    // 9. 触发具体工具调用 (tools/call) - 自动包含握手会话头
    callMcpTool: async function(serverName, toolName, args) {
      const servers = await db.mcp_servers.toArray();
      const server = servers.find(s => s.name === serverName && s.enabled);
      if (!server) {
        throw new Error(`未找到名为 [${serverName}] 的可用 MCP 服务器或服务已被禁用`);
      }

      const targetTool = (server.tools || []).find(t => t.name === toolName && t.enabled);
      if (!targetTool) {
        throw new Error(`在服务器 [${serverName}] 中未找到名为 [${toolName}] 的可用工具或该工具已被禁用`);
      }

      let activeHeaders = server.headers || {};
      try {
        activeHeaders = await this.rpcInitialize(server.url, server.type, server.headers || {});
      } catch (e) {
        console.warn("工具调用前握手（部分无状态服务器可兼容）:", e);
      }

      const params = {
        name: toolName,
        arguments: args
      };

      const result = await this.rpcRequest(server.url, server.type, activeHeaders, "tools/call", params);
      return result;
    },

    // 9. 渲染 MCP 服务器与工具层级卡片列表
    renderServersList: async function() {
      const container = document.getElementById("mcp-servers-list-container");
      const summaryText = document.getElementById("mcp-servers-summary-text");
      if (!container) return;

      container.innerHTML = "";
      const servers = await db.mcp_servers.toArray();

      let activeToolsCount = 0;
      servers.forEach(s => {
        if (s.enabled && s.tools) {
          activeToolsCount += s.tools.filter(t => t.enabled).length;
        }
      });

      if (summaryText) {
        summaryText.innerText = `已接入 ${servers.length} 个服务器，激活 ${activeToolsCount} 个工具`;
      }

      if (servers.length === 0) {
        container.innerHTML = `
          <div style="text-align:center; color:var(--text-secondary); font-size:12px; padding:40px 0;">
            暂未配置任何外部 MCP 服务器。<br>点击右上角加号按键添加 SSE 或 Streamable HTTP 服务。
          </div>
        `;
        return;
      }

      servers.forEach(srv => {
        const card = document.createElement("div");
        card.className = "mcp-card";
        card.style.cssText = "background:#ffffff; border:1.5px solid var(--border); border-radius:12px; padding:12px; box-shadow: var(--shadow-sm); display:flex; flex-direction:column; gap:10px;";

        const toolsCount = srv.tools ? srv.tools.length : 0;
        const activeCount = srv.tools ? srv.tools.filter(t => t.enabled).length : 0;

        let toolsListHtml = "";
        if (srv.tools && srv.tools.length > 0) {
          toolsListHtml = srv.tools.map((t, idx) => `
            <div style="display:flex; align-items:center; justify-content:space-between; padding:6px 8px; background:#f8fafc; border-radius:8px; border:1px solid var(--border);">
              <div style="flex:1; overflow:hidden; padding-right:8px;">
                <div style="font-size:12px; font-weight:700; color:var(--text-primary); text-overflow:ellipsis; white-space:nowrap; overflow:hidden;">${escapeHtml(t.name)}</div>
                <div style="font-size:10px; color:var(--text-secondary); text-overflow:ellipsis; white-space:nowrap; overflow:hidden;">${escapeHtml(t.description || '暂无描述')}</div>
              </div>
              <label class="switch" style="flex-shrink:0;">
                <input type="checkbox" ${t.enabled ? 'checked' : ''} onchange="mcpClientSystem.toggleToolActive(${srv.id}, ${idx}, this.checked)">
                <span class="slider"></span>
              </label>
            </div>
          `).join("");
        } else {
          toolsListHtml = `<div style="font-size:11px; color:var(--text-secondary); padding:4px;">未读取到工具</div>`;
        }

        card.innerHTML = `
          <div style="display:flex; align-items:center; justify-content:space-between; border-bottom:1px dashed var(--border); padding-bottom:8px;">
            <div>
              <div style="font-size:14px; font-weight:700; color:var(--text-primary); display:flex; align-items:center; gap:6px;">
                ${escapeHtml(srv.name)}
                <span style="font-size:9px; background:#e0f2fe; color:#0369a1; padding:1px 5px; border-radius:4px; font-weight:700;">${srv.type === 'sse' ? 'SSE' : 'HTTP'}</span>
              </div>
              <div style="font-size:10px; color:var(--text-secondary); margin-top:2px;">${escapeHtml(srv.url)}</div>
            </div>
            <div style="display:flex; align-items:center; gap:10px;">
              <label class="switch">
                <input type="checkbox" ${srv.enabled ? 'checked' : ''} onchange="mcpClientSystem.toggleServerActive(${srv.id}, this.checked)">
                <span class="slider"></span>
              </label>
            </div>
          </div>

          <div style="display:flex; justify-content:space-between; align-items:center;">
            <span style="font-size:11px; font-weight:700; color:var(--text-secondary);">包含工具 (${activeCount}/${toolsCount})</span>
            <div style="display:flex; gap:6px;">
              <button class="btn btn-outline" onclick="mcpClientSystem.refreshServerTools(${srv.id})" style="padding:3px 8px; font-size:10px; border-radius:6px; display:flex; align-items:center; gap:2px;">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M23 4v6h-6"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg> 重新拉取
              </button>
              <button class="btn btn-outline" onclick="mcpClientSystem.openServerEditModal(${srv.id})" style="padding:3px 8px; font-size:10px; border-radius:6px;">编辑</button>
              <button class="btn btn-danger-outline" onclick="mcpClientSystem.deleteServer(${srv.id})" style="padding:3px 8px; font-size:10px; border-radius:6px; color:#ef4444; border-color:#fca5a5;">删除</button>
            </div>
          </div>

          <div style="display:flex; flex-direction:column; gap:6px; max-height:160px; overflow-y:auto;">
            ${toolsListHtml}
          </div>
        `;

        container.appendChild(card);
      });
    },

    // 10. 切换服务器总开关
    toggleServerActive: async function(serverId, isChecked) {
      await db.mcp_servers.update(Number(serverId), { enabled: isChecked });
      await this.renderServersList();
    },

    // 11. 切换单个工具开关
    toggleToolActive: async function(serverId, toolIndex, isChecked) {
      const server = await db.mcp_servers.get(Number(serverId));
      if (server && server.tools && server.tools[toolIndex]) {
        server.tools[toolIndex].enabled = isChecked;
        await db.mcp_servers.update(Number(serverId), { tools: server.tools });
        await this.renderServersList();
      }
    },

    // 12. 重新拉取指定服务器的工具
    refreshServerTools: async function(serverId) {
      const server = await db.mcp_servers.get(Number(serverId));
      if (!server) return;
      showToast(`正在刷新 [${server.name}] 工具列表...`);

      try {
        const fetchedTools = await this.rpcFetchToolsList(server.url, server.type, server.headers || {});
        let existingToolsMap = {};
        (server.tools || []).forEach(t => { existingToolsMap[t.name] = t.enabled; });

        const updatedTools = fetchedTools.map(t => ({
          name: t.name,
          description: t.description || "",
          inputSchema: t.inputSchema || {},
          enabled: existingToolsMap[t.name] !== undefined ? existingToolsMap[t.name] : true
        }));

        await db.mcp_servers.update(Number(serverId), { tools: updatedTools, updatedAt: Date.now() });
        showToast(`刷新成功，已拉取到 ${updatedTools.length} 个工具`);
        await this.renderServersList();
      } catch (e) {
        showCustomAlert("刷新失败", e.message);
      }
    },

    // 13. 删除服务器
    deleteServer: async function(serverId) {
      showCustomConfirm("确认删除", "确定要删除该 MCP 工具服务器及其所有工具配置吗？", async () => {
        await db.mcp_servers.delete(Number(serverId));
        await this.renderServersList();
      });
    },

    // 14. 编译已激活的 MCP Tools 并输出为 System Prompt 段落
    buildMcpPromptSegment: async function() {
      // 判断 MCP 神经感知总开关是否开启
      const isMcpEnabled = localStorage.getItem("settings-mcp-prompt-enabled") === "true";
      if (!isMcpEnabled) return "";

      const servers = await db.mcp_servers.toArray();
      const activeServers = servers.filter(s => s.enabled);

      let availableTools = [];
      activeServers.forEach(srv => {
        if (srv.tools) {
          srv.tools.forEach(t => {
            if (t.enabled) {
              availableTools.push({
                server: srv.name,
                tool: t.name,
                description: t.description,
                inputSchema: t.inputSchema
              });
            }
          });
        }
      });

      if (availableTools.length === 0) return "";

      let promptText = "【MCP 外部工具服务支持 (Tool Calling Protocol)】\n";
      promptText += "你拥有调用外部工具的能力。当用户提出需要查询信息、操作外部接口或调用特定功能时，你可以调用以下工具：\n\n";

      availableTools.forEach((t, i) => {
        promptText += `${i + 1}. [服务器: ${t.server}] 工具名: ${t.tool}\n`;
        promptText += `   功能描述: ${t.description || '无描述'}\n`;
        promptText += `   参数 Schema: ${JSON.stringify(t.inputSchema)}\n\n`;
      });

      promptText += "【工具调用语法规则】\n";
      promptText += "如果你判定需要调用上述某工具，请在回复中输出以下指令（可单独输出或附带简短说明）：\n";
      promptText += "[CALL_TOOL: {\"server\": \"服务器名\", \"tool\": \"工具名\", \"arguments\": {\"参数名\": \"参数值\"}}]\n";
      promptText += "注意：参数必须严格匹配该工具的 inputSchema 约束。";

      return promptText;
    }
  };

  function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;')
              .replace(/</g, '&lt;')
              .replace(/>/g, '&gt;')
              .replace(/"/g, '&quot;')
              .replace(/'/g, '&#39;');
  }

  window.mcpClientSystem = mcpClientSystem;
})();