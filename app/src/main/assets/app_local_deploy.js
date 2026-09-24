/**
 * app_local_deploy.js - 本地部署中心（Termux 脚本管理）
 * 内置网易云 API(3000) + CORS 跨域中转(3001)；
 * 部署引导命令内置全部脚本内容（heredoc 直接在 Termux 创建文件，无需联网下载）；
 * 每个脚本提供「查看 / 编辑 / 删除」，查看可展开面板显示详情与脚本源码。
 *
 * ⚠️ 本文件由 tools/sync-embedded-assets.js 生成：
 *    - 修改 termux/cors-proxy.js 或 termux/xvshishi-services.sh 后，运行
 *      node tools/sync-embedded-assets.js 重新生成本文件；
 *    - 只允许编辑 tools/app_local_deploy.template.js（文件内两处内嵌常量占位符
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

  // ============ 内置脚本文件内容（由 tools/sync-embedded-assets.js 同步，勿手改）============
  var CORS_PROXY_SOURCE = `// 叙事诗小手机 - 内置 CORS 跨域中转代理（端口 3001）
// 用途：为 PWA/网页版打破跨域限制，代理任意 HTTP/HTTPS 请求
// 启动：node cors-proxy.js
const http = require('http');
const https = require('https');
const url = require('url');

const PORT = process.env.PORT || 3001;

const server = http.createServer((req, res) => {
  // CORS 头
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Expose-Headers', '*');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // 健康检查
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, service: 'xvshishi-cors-proxy', port: PORT }));
    return;
  }

  // 代理格式: /proxy?url=<目标URL>
  const parsed = url.parse(req.url, true);
  const target = parsed.query.url || '';
  if (!target) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'missing url param', usage: '/proxy?url=https://example.com' }));
    return;
  }

  let targetUrl;
  try { targetUrl = new URL(target); } catch (e) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid url' }));
    return;
  }

  const isHttps = targetUrl.protocol === 'https:';
  const lib = isHttps ? https : http;

  const headers = { ...req.headers };
  delete headers.host;
  delete headers['accept-encoding'];

  const proxyReq = lib.request(targetUrl, {
    method: req.method,
    headers: headers
  }, (proxyRes) => {
    res.writeHead(proxyRes.statusCode || 200, proxyRes.headers);
    proxyRes.pipe(res);
  });

  proxyReq.on('error', (err) => {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'proxy error', message: err.message }));
  });

  req.pipe(proxyReq);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(\`[xvshishi-cors-proxy] running @ http://localhost:\${PORT}\`);
});
`;
  var SERVICES_MANAGER_SOURCE = `#!/data/data/com.termux/files/usr/bin/bash
# ============================================================
# 叙事诗小手机 - Termux 服务管理器（独立启停 + 状态读取 + 数据持久化）
# ------------------------------------------------------------
# 功能：
#  1. 统一管理所有本地脚本服务（网易云 API / CORS 跨域中转 / 用户自定义）
#  2. 每个服务独立启停，状态写入 $XSH_DIR/status/*.json
#  3. 登录态 Cookie 等数据持久化到 $XSH_DIR/data/
#  4. 提供可交互 TUI 菜单（bash 纯终端，无需额外依赖）
#  5. 提供子命令供外部调用：start|stop|restart|status|list|tui
# ------------------------------------------------------------
# 说明：cors-proxy.js 为内置脚本，部署时随本文件一起写入
#       $XSH_DIR/cors-proxy.js（内容与仓库 termux/cors-proxy.js 一致），
#       无需联网下载；缺失时重新复制 App「本地部署 → 部署引导」命令即可。
# 随时唤出：部署时已把 xvshishi 安装到 $PREFIX/bin，之后在 Termux
#       直接输入 xvshishi 即可再次进入本交互页面（无需输入长命令）。
# ------------------------------------------------------------
# 用法：
#   bash xvshishi-services.sh tui      # 进入交互式管理菜单
#   bash xvshishi-services.sh list     # 列出全部服务与状态
#   bash xvshishi-services.sh start ncm-api
#   bash xvshishi-services.sh stop  ncm-api
#   bash xvshishi-services.sh status ncm-api
# ============================================================

# ---------- 基础配置 ----------
XSH_DIR="\${XSH_DIR:-$HOME/.xvshishi}"
DATA_DIR="$XSH_DIR/data"      # 持久化数据（登录 cookie 等）
STATUS_DIR="$XSH_DIR/status"  # 各服务运行状态 JSON
LOG_DIR="$XSH_DIR/logs"       # 各服务日志
PID_DIR="$XSH_DIR/pids"       # PID 文件
mkdir -p "$DATA_DIR" "$STATUS_DIR" "$LOG_DIR" "$PID_DIR"

# ---------- 颜色 ----------
C_G="\\033[32m"; C_R="\\033[31m"; C_Y="\\033[33m"; C_B="\\033[34m"; C_C="\\033[36m"
C_DIM="\\033[2m"; C_BOLD="\\033[1m"; C_END="\\033[0m"

# ---------- 服务注册表 ----------
# 格式: 服务ID|显示名|描述|启动命令|健康检查URL|停止方式(kill|pkill)
SERVICES=(
  "ncm-api|网易云音乐 API|网易云登录代理/歌单同步/歌词搜索|NeteaseCloudMusicApi -p 3000|http://localhost:3000|kill"
  "cors-proxy|CORS 跨域中转|打破 PWA/网页版跨域限制|node \\$HOME/.xvshishi/cors-proxy.js|http://localhost:3001/health|kill"
  "cmd-runner|AI 命令执行服务|工作台 Agent 执行 termux 命令/git 仓库操作（端口 3002）|node $HOME/.xvshishi/cmd-runner.js|http://localhost:3002/health|kill"
  "link-meta|分享链接解析服务|解析小红书/B站等分享链接的标题/封面/摘要（端口 3003）|node $HOME/.xvshishi/link-meta.js|http://localhost:3003/health|kill"
  # 微信 Claw 接入：在手机上跑 OpenClaw + 腾讯官方「微信 ClawBot」插件，把 AI 接成微信联系人。
  # 注意：它不是 HTTP 服务，没有健康检查地址；启动/停止都通过 wechat-claw.sh 的子命令。
  # 第一次用请先 \`xvshishi guide wechat-claw\` 看步骤（要先在微信里确认灰度到 ClawBot 插件）。
  "wechat-claw|微信 Claw 接入|用官方 ClawBot 插件把 OpenClaw 接成微信里的联系人（非 HTTP 服务，无端口）|bash \\$HOME/.xvshishi/wechat-claw.sh start|\\$HOME/.xvshishi/wechat-claw.sh status|kill"
)

# ---------- 用户自定义服务（追加到数组末尾） ----------
USER_SERVICES_FILE="$XSH_DIR/services.conf"
if [ -f "$USER_SERVICES_FILE" ]; then
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    case "$line" in \\#*) continue;; esac
    SERVICES+=("$line")
  done < "$USER_SERVICES_FILE"
fi

# ---------- 内置脚本自愈（缺失时从仓库 raw 自动补齐） ----------
GITHUB_RAW="https://raw.githubusercontent.com/wenqv4617-art/Xvshishiapk/main/termux"

# 内置服务 id → 远程文件名（非内置/无需下载则输出空）
builtin_remote() {
  case "$1" in
    cors-proxy) echo "$GITHUB_RAW/cors-proxy.js" ;;
    cmd-runner) echo "$GITHUB_RAW/cmd-runner.js" ;;
    wechat-claw) echo "$GITHUB_RAW/wechat-claw.sh" ;;
    *) echo "" ;;
  esac
}

builtin_script_file() {
  case "$1" in
    cors-proxy) echo "$HOME/.xvshishi/cors-proxy.js" ;;
    cmd-runner) echo "$HOME/.xvshishi/cmd-runner.js" ;;
    link-meta) echo "$HOME/.xvshishi/link-meta.js" ;;
    wechat-claw) echo "$HOME/.xvshishi/wechat-claw.sh" ;;
    *) echo "" ;;
  esac
}

# 确保脚本存在；缺失则尝试用 curl/wget 从 GitHub 下载
ensure_script() {
  local id="$1" file base dl url
  file=$(builtin_script_file "$id")
  [ -z "$file" ] && return 0
  [ -f "$file" ] && [ -s "$file" ] && return 0
  base=$(basename "$file")
  log "\${C_Y}[!]\${C_END} 缺少脚本文件: $file，尝试自动补齐..."
  mkdir -p "$(dirname "$file")"
  # 1) 优先从 App 导出的手机存储目录复制（无需网络）
  for src in "/sdcard/Download/Storypoem/xvshishi-scripts/$base" "/storage/emulated/0/Download/Storypoem/xvshishi-scripts/$base"; do
    if [ -f "$src" ] && cp "$src" "$file" 2>/dev/null && [ -s "$file" ]; then
      log "\${C_G}[✓]\${C_END} 已从手机存储补齐: $file"
      return 0
    fi
  done
  dl=""
  if command -v curl >/dev/null 2>&1; then
    dl="curl -fsSL"
  elif command -v wget >/dev/null 2>&1; then
    dl="wget -qO-"
  fi
  if [ -z "$dl" ]; then
    log "\${C_R}[x]\${C_END} 未安装 curl/wget，请先执行: pkg install -y curl"
    return 1
  fi
  # 主源 GitHub raw，备用源 jsDelivr CDN（国内网络更易成功）
  for url in "$GITHUB_RAW/$base" "https://cdn.jsdelivr.net/gh/wenqv4617-art/Xvshishiapk@main/termux/$base"; do
    if $dl "$url" > "$file" 2>/dev/null && [ -s "$file" ]; then
      log "\${C_G}[✓]\${C_END} 已补齐脚本: $file"
      return 0
    fi
  done
  rm -f "$file" 2>/dev/null
  log "\${C_R}[x]\${C_END} 自动下载失败（请检查网络），或重新复制 App「本地部署→部署引导」命令"
  return 1
}

# 一键补齐全部内置脚本（xvshishi repair）
repair_all() {
  log ""
  log "\${C_BOLD}修复/补齐内置脚本\${C_END}"
  local ok=0 fail=0
  for id in cors-proxy cmd-runner link-meta wechat-claw; do
    if ensure_script "$id"; then ok=$((ok+1)); else fail=$((fail+1)); fi
  done
  log "------------------------------------------"
  log "\${C_G}已就绪: $ok\${C_END}  \${C_R}失败: $fail\${C_END}"
  log "\${C_DIM}提示: 还需 pkg install -y nodejs-lts git curl 以运行脚本与 git 工具\${C_END}"
  log ""
}

# ---------- 工具函数 ----------
log() { echo -e "$*"; }
now() { date '+%Y-%m-%d %H:%M:%S'; }

pid_file() { echo "$PID_DIR/$1.pid"; }
log_file() { echo "$LOG_DIR/$1.log"; }
status_file() { echo "$STATUS_DIR/$1.json"; }

# 写入服务状态 JSON
write_status() {
  local id="$1" state="$2" pid="$3" ts
  ts=$(now)
  cat > "$(status_file "$id")" <<EOF
{"id":"$id","status":"$state","pid":\${pid:-0},"updatedAt":"$ts"}
EOF
}

# 读取某服务的 PID（若进程存活）
get_pid() {
  local id="$1" pf pid
  pf=$(pid_file "$id")
  [ -f "$pf" ] || { echo ""; return; }
  pid=$(cat "$pf" 2>/dev/null | tr -d ' ')
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    echo "$pid"
  else
    echo ""
  fi
}

is_running() {
  local id="$1" pid cmd keyword mainfile mainfile_expanded
  pid=$(get_pid "$id")
  [ -n "$pid" ] && return 0
  cmd=$(get_cmd "$id")
  # 若命令指向本地脚本文件，优先用脚本路径精确匹配，
  # 避免与其它 node 进程（如网易云 API）混淆导致误判已在运行
  mainfile=$(echo "$cmd" | sed -n 's/^[^ ]* \\([^ ]*\\.\\(js\\|sh\\)\\).*/\\1/p')
  if [ -n "$mainfile" ]; then
    mainfile_expanded=$(eval echo "$mainfile")
    if pgrep -f "$mainfile_expanded" >/dev/null 2>&1; then
      return 0
    fi
    return 1
  fi
  keyword=$(echo "$cmd" | awk '{print $1}')
  if pgrep -f "$keyword" >/dev/null 2>&1; then
    return 0
  fi
  return 1
}

get_cmd() {
  local id="$1" entry
  for entry in "\${SERVICES[@]}"; do
    if [ "\${entry%%|*}" = "$id" ]; then
      echo "$entry" | cut -d'|' -f4
      return
    fi
  done
  echo ""
}

get_name() {
  local id="$1" entry
  for entry in "\${SERVICES[@]}"; do
    if [ "\${entry%%|*}" = "$id" ]; then
      echo "$entry" | cut -d'|' -f2
      return
    fi
  done
  echo "$id"
}

# ---------- 启动服务 ----------
start_service() {
  local id="$1" cmd name logf pf pid mainfile
  name=$(get_name "$id")
  if is_running "$id"; then
    log "\${C_Y}[!]\${C_END} $name 已在运行（PID: $(get_pid "$id")）"
    return 0
  fi
  cmd=$(get_cmd "$id")
  [ -z "$cmd" ] && { log "\${C_R}[x]\${C_END} 未知服务: $id"; return 1; }

  # 预检：若命令指向本地脚本文件，先确认文件存在；缺失则尝试自动下载补齐
  mainfile=$(echo "$cmd" | sed -n 's/^[^ ]* \\([^ ]*\\.\\(js\\|sh\\)\\).*/\\1/p')
  if [ -n "$mainfile" ]; then
    # 展开 $HOME 变量
    mainfile_expanded=$(eval echo "$mainfile")
    if [ ! -s "$mainfile_expanded" ]; then
      if ! ensure_script "$id"; then
        log "\${C_R}[x]\${C_END} $name 启动失败：脚本文件缺失 $mainfile_expanded"
        log "\${C_Y}[!]\${C_END} 可执行 xvshishi repair 自动补齐，或重新复制 App「本地部署→部署引导」命令。"
        write_status "$id" "error" ""
        return 1
      fi
      if [ ! -s "$mainfile_expanded" ]; then
        log "\${C_R}[x]\${C_END} $name 启动失败：脚本文件仍缺失"
        write_status "$id" "error" ""
        return 1
      fi
    fi
  fi

  logf=$(log_file "$id")
  pf=$(pid_file "$id")
  log "\${C_B}[*]\${C_END} 启动 $name ..."
  eval "nohup bash -c '$cmd' >> \\"$logf\\" 2>&1 &"
  echo $! > "$pf"
  sleep 1
  pid=$(get_pid "$id")
  if [ -n "$pid" ]; then
    write_status "$id" "running" "$pid"
    log "\${C_G}[✓]\${C_END} $name 已启动 (PID: $pid)"
  else
    write_status "$id" "error" ""
    log "\${C_R}[x]\${C_END} $name 启动失败，请查看日志: $logf"
    log "\${C_Y}[!]\${C_END} 日志内容: $(tail -5 "$logf" 2>/dev/null | tr '\\n' ' ')"
    if tail -30 "$logf" 2>/dev/null | grep -q "Cannot find module"; then
      log "\${C_Y}[!]\${C_END} 检测到脚本文件缺失（Cannot find module）→ 执行 \${C_C}xvshishi repair\${C_END} 可自动补齐"
    fi
    # 微信 Claw 接入的失败原因几乎都是「还没绑定/还没装」，直接给对指引，别让人去猜日志
    if [ "$id" = "wechat-claw" ]; then
      log "\${C_Y}[!]\${C_END} 微信 Claw 接入没起来，通常是还没装插件或还没扫码绑定。先跑一次自检和引导："
      log "      \${C_C}bash \\$HOME/.xvshishi/wechat-claw.sh check\${C_END}"
      log "      \${C_C}xvshishi guide wechat-claw\${C_END}"
    fi
  fi
}

# ---------- 停止服务 ----------
stop_service() {
  local id="$1" name pid cmd keyword mainfile mainfile_expanded
  name=$(get_name "$id")
  # 1) 按 PID 文件停止外层包装进程
  pid=$(get_pid "$id")
  if [ -n "$pid" ]; then
    kill "$pid" 2>/dev/null
    sleep 1
    if kill -0 "$pid" 2>/dev/null; then
      kill -9 "$pid" 2>/dev/null
    fi
  fi
  # 2) 再按脚本路径/关键字兜底清理真实进程（包装 shell 退出后子进程可能残留）
  cmd=$(get_cmd "$id")
  mainfile=$(echo "$cmd" | sed -n 's/^[^ ]* \\([^ ]*\\.\\(js\\|sh\\)\\).*/\\1/p')
  if [ -n "$mainfile" ]; then
    mainfile_expanded=$(eval echo "$mainfile")
    pkill -f "$mainfile_expanded" 2>/dev/null
  else
    keyword=$(echo "$cmd" | awk '{print $1}')
    pkill -f "$keyword" 2>/dev/null
  fi
  sleep 1
  if is_running "$id"; then
    log "\${C_R}[x]\${C_END} $name 停止失败，进程仍在运行"
    return 1
  fi
  write_status "$id" "stopped" ""
  log "\${C_G}[✓]\${C_END} $name 已停止"
}

# ---------- 状态展示 ----------
show_status() {
  local id="$1" name pid
  id="$1"; name=$(get_name "$id"); pid=$(get_pid "$id")
  if [ -n "$pid" ]; then
    write_status "$id" "running" "$pid"
    log "  \${C_G}●\${C_END} $name  \${C_G}运行中\${C_END} (PID $pid)"
  else
    write_status "$id" "stopped" ""
    log "  \${C_DIM}○\${C_END} $name  \${C_R}已停止\${C_END}"
  fi
}

# ---------- 列出全部 ----------
list_all() {
  log ""
  log "\${C_BOLD}叙事诗小手机 - Termux 服务列表\${C_END}"
  log "\${C_DIM}数据目录: $XSH_DIR\${C_END}"
  log "------------------------------------------"
  local entry id
  for entry in "\${SERVICES[@]}"; do
    id="\${entry%%|*}"
    show_status "$id"
  done
  log "------------------------------------------"
  log ""
}

# ---------- 交互式 TUI 菜单 ----------
tui_menu() {
  while true; do
    clear 2>/dev/null || true
    log "\${C_BOLD}============================================\${C_END}"
    log "\${C_BOLD}  叙事诗小手机 - Termux 服务管理器\${C_END}"
    log "\${C_BOLD}============================================\${C_END}"
    list_all
    log "  请输入操作:"
    log "  \${C_C}[1]\${C_END} 启动全部服务（\${C_DIM}不含微信 Claw，它要先扫码绑定\${C_END}）"
    log "  \${C_C}[2]\${C_END} 停止全部服务"
    log "  \${C_C}[3]\${C_END} 查看服务日志"
    log "  \${C_C}[4]\${C_END} 一键部署/修复依赖"
    log "  \${C_C}[5]\${C_END} 查看持久化数据文件"
    log "  \${C_C}[6]\${C_END} 修复/补齐内置脚本（cmd-runner 等）"
    log "  \${C_C}[G]\${C_END} 微信 Claw 接入的分步引导（第一次用先看这个）"
    log "  \${C_C}[0]\${C_END} 退出"
    log ""
    log "  \${C_DIM}—— 单独启停（推荐分开启动，避免相互干扰）——\${C_END}"
    local idx entry id
    idx=0
    for entry in "\${SERVICES[@]}"; do
      idx=$((idx+1))
      id="\${entry%%|*}"
      log "  \${C_C}[S\${idx}]\${C_END} 启动 \${id}"
      log "  \${C_C}[T\${idx}]\${C_END} 停止 \${id}"
    done
    log ""
    printf "  选择: "
    read -r choice
    case "$choice" in
      1) for entry in "\${SERVICES[@]}"; do
           # 微信 Claw 是交互式扫码通道，不在「启动全部」里硬拉，避免白跑一遍
           [ "\${entry%%|*}" = "wechat-claw" ] && continue
           start_service "\${entry%%|*}"
         done
         log "\${C_DIM}（微信 Claw 接入未包含，需要时用 [S5] 或先看 [G] 引导）\${C_END}"
         sleep 1;;
      2) for entry in "\${SERVICES[@]}"; do stop_service "\${entry%%|*}"; done; sleep 1;;
      3) tui_logs;;
      4) tui_repair;;
      5) tui_data;;
      6) repair_all; sleep 1;;
      G|g) claw_guide; printf "  回车继续..."; read -r _dummy;;
      0) log "再见！随时输入 \${C_C}xvshishi\${C_END} 可再次唤出本页面"; exit 0;;
      S1|s1) [ -n "\${SERVICES[0]}" ] && start_service "\${SERVICES[0]%%|*}"; sleep 1;;
      S2|s2) [ -n "\${SERVICES[1]}" ] && start_service "\${SERVICES[1]%%|*}"; sleep 1;;
      S3|s3) [ -n "\${SERVICES[2]}" ] && start_service "\${SERVICES[2]%%|*}"; sleep 1;;
      T1|t1) [ -n "\${SERVICES[0]}" ] && stop_service "\${SERVICES[0]%%|*}"; sleep 1;;
      T2|t2) [ -n "\${SERVICES[1]}" ] && stop_service "\${SERVICES[1]%%|*}"; sleep 1;;
      T3|t3) [ -n "\${SERVICES[2]}" ] && stop_service "\${SERVICES[2]%%|*}"; sleep 1;;
      S4|s4) [ -n "\${SERVICES[3]}" ] && start_service "\${SERVICES[3]%%|*}"; sleep 1;;
      T4|t4) [ -n "\${SERVICES[3]}" ] && stop_service "\${SERVICES[3]%%|*}"; sleep 1;;
      S5|s5) [ -n "\${SERVICES[4]}" ] && start_service "\${SERVICES[4]%%|*}"; sleep 1;;
      T5|t5) [ -n "\${SERVICES[4]}" ] && stop_service "\${SERVICES[4]%%|*}"; sleep 1;;
      *) log "无效选项"; sleep 1;;
    esac
  done
}

tui_logs() {
  log ""
  log "可选日志:"
  local idx entry id
  idx=0
  for entry in "\${SERVICES[@]}"; do
    id="\${entry%%|*}"
    idx=$((idx+1))
    log "  [$idx] $id"
  done
  printf "查看哪个服务的日志? (0=返回): "
  read -r choice
  [ "$choice" = "0" ] && return
  local count=0 entry
  for entry in "\${SERVICES[@]}"; do
    count=$((count+1))
    if [ "$count" = "$choice" ]; then
      id="\${entry%%|*}"
      log "--- $id 日志 (tail -30) ---"
      tail -30 "$(log_file "$id")" 2>/dev/null || log "(无日志)"
      printf "按回车返回..."
      read -r _
      return
    fi
  done
}

tui_repair() {
  log ""
  log "\${C_BOLD}一键部署/修复依赖\${C_END}"
  log "  1. 更新软件源: pkg update -y"
  log "  2. 安装 nodejs: pkg install -y nodejs-lts"
  log "  3. 安装网易云 API: npm install -g NeteaseCloudMusicApi --registry=https://registry.npmmirror.com"
  log "  4. 重建脚本文件: 重新复制 App「本地部署 → 部署引导」的部署命令执行即可（已内置脚本内容，无需下载）"
  printf "  立即执行? (y/N): "
  read -r yn
  case "$yn" in
    y|Y)
      pkg update -y || true
      pkg install -y nodejs-lts || true
      npm install -g NeteaseCloudMusicApi --registry=https://registry.npmmirror.com || true
      log "\${C_G}[✓]\${C_END} 依赖部署完成"
      log "\${C_Y}[!]\${C_END} 若 cors-proxy.js / xvshishi-services.sh 缺失，请重新复制 App 部署引导命令"
      ;;
    *) log "已取消";;
  esac
  sleep 1
}

tui_data() {
  log ""
  log "\${C_BOLD}持久化数据文件 (\${C_DIM}$DATA_DIR\${C_END}\${C_BOLD})\${C_END}"
  ls -la "$DATA_DIR" 2>/dev/null | head -20
  log ""
  printf "按回车返回..."
  read -r _
}

# ---------- 微信 Claw 接入：分步引导 / 查看日志 ----------
# 这服务不是 HTTP 服务，「启动」只是把网关挂到后台，真正的关键步骤（扫码绑定）
# 必须在 Termux 里看得到输出，所以单独给一个 guide 和 logs 入口。
claw_guide() {
  log ""
  log "\${C_BOLD}============================================\${C_END}"
  log "\${C_BOLD}  微信 Claw 接入 · 步骤\${C_END}"
  log "\${C_BOLD}============================================\${C_END}"
  log ""
  log "\${C_BOLD}第 1 步 · 确认微信灰度到了 ClawBot 插件\${C_END}"
  log "  微信需 >= 8.0.70。打开： 我 → 设置 → 插件"
  log "  看列表里有没有 \${C_BOLD}「微信 ClawBot」\${C_END}"
  log "  \${C_DIM}没有的话：把微信从后台彻底杀掉重开再看；仍没有就是还没灰度到你，只能等。\${C_END}"
  log ""
  log "\${C_BOLD}第 2 步 · 装依赖\${C_END}"
  log "  pkg install -y nodejs-lts"
  log "  \${C_DIM}需要 Node >= 22，脚本会自己检测版本。\${C_END}"
  log ""
  log "\${C_BOLD}第 3 步 · 装微信 Channel 插件\${C_END}"
  log "  bash \\$HOME/.xvshishi/wechat-claw.sh install"
  log "  \${C_DIM}它会调用官方 CLI。若报错，请以微信插件详情页显示的安装命令为准。\${C_END}"
  log ""
  log "\${C_BOLD}第 4 步 · 扫码绑定\${C_END}"
  log "  安装/登录时会显示二维码 → 微信里进 ClawBot 插件详情页 → 扫一扫 → 点绿色「连接」"
  log "  掉线或换号后重新出码： bash \\$HOME/.xvshishi/wechat-claw.sh login"
  log ""
  log "\${C_BOLD}第 5 步 · 挂到后台常驻\${C_END}"
  log "  xvshishi start wechat-claw"
  log "  \${C_DIM}脚本会自动申请 Termux 唤醒锁，尽量避免被系统冻结。\${C_END}"
  log ""
  log "\${C_BOLD}常用命令\${C_END}"
  log "  xvshishi status wechat-claw      # 看有没有在跑"
  log "  xvshishi logs wechat-claw        # 看日志（二维码/报错都在这里）"
  log "  xvshishi stop wechat-claw        # 停掉"
  log "  bash \\$HOME/.xvshishi/wechat-claw.sh check   # 环境自检"
  log ""
  log "\${C_Y}[!]\${C_END} 这条通道是「你 ↔ 你自己的 AI」，它只能跟 ClawBot 这个联系人一对一聊，"
  log "     \${C_Y}\${C_END} 不能代替你给微信好友发消息（那需要另一种方案）。"
  log ""
}

claw_logs() {
  local f="$LOG_DIR/wechat-claw.log"
  log ""
  log "\${C_BOLD}微信 Claw 接入 · 日志（末尾 40 行）\${C_END}"
  log "\${C_DIM}$f\${C_END}"
  log "------------------------------------------"
  if [ -f "$f" ]; then tail -40 "$f"; else log "（还没有日志，先跑一次 install 或 start）"; fi
  log "------------------------------------------"
  log ""
}

# ---------- 命令分发 ----------
case "\${1:-tui}" in
  start)   start_service "$2" ;;
  stop)    stop_service "$2" ;;
  restart) stop_service "$2"; start_service "$2" ;;
  status)  [ -n "$2" ] && show_status "$2" || list_all ;;
  list)    list_all ;;
  repair)  repair_all ;;
  logs)    if [ "$2" = "wechat-claw" ] || [ -z "$2" ]; then
             claw_logs
           else
             lf=$(log_file "$2")
             if [ -f "$lf" ]; then tail -40 "$lf"; else log "没有日志: $lf"; fi
           fi ;;
  guide)   if [ "$2" = "wechat-claw" ]; then claw_guide; else
             log "目前只有 wechat-claw 有分步引导： xvshishi guide wechat-claw"
           fi ;;
  tui)     tui_menu ;;
  *)       log "用法: bash xvshishi-services.sh {tui|list|start <id>|stop <id>|restart <id>|status [id]|logs [id]|guide wechat-claw|repair}";;
esac
`;
  var XSHISHI_LAUNCHER_SOURCE = `#!/data/data/com.termux/files/usr/bin/bash
# ============================================================
# 叙事诗小手机 - 脚本交互页面唤出命令
# ------------------------------------------------------------
# 部署（一键部署命令）时本文件会被安装到 $PREFIX/bin/xvshishi，
# 之后在 Termux 任意位置直接输入：
#     xvshishi
# 即可立刻唤出脚本交互页面（服务管理器 TUI），无需再输入长命令。
# ============================================================
# 用法：
#     xvshishi              # 进入交互式管理菜单
#     xvshishi repair       # 修复/补齐内置脚本（如 cmd-runner 缺失）
#     xvshishi start cmd-runner
#     xvshishi list
# ============================================================
if [ $# -gt 0 ]; then
  exec bash "$HOME/.xvshishi/xvshishi-services.sh" "$@"
fi
exec bash "$HOME/.xvshishi/xvshishi-services.sh" tui
`;
var CMD_RUNNER_SOURCE = `
#!/data/data/com.termux/files/usr/bin/env node
// ============================================================
// 叙事诗小手机 - cmd-runner（内置脚本3 · AI 命令执行服务）
// ------------------------------------------------------------
// 用途：让「工作台 Agent」能执行 termux 命令 / 运行自己写的脚本 /
//       做 git 仓库操作（clone/commit/push），并取回 stdout/stderr。
// 原理：在 Termux 内常驻一个只监听 127.0.0.1 的小 HTTP 服务（端口 3002），
//       工作台通过 http://127.0.0.1:3002/run 提交 { cmd, cwd, timeout_ms }。
// 安全：
//   - 只绑定 127.0.0.1（仅本机可访问）；
//   - 若存在 ~/.xvshishi/.cmd_token 文件，则要求请求头 X-Cmd-Token 一致才执行
//     （echo -n '你的随机口令' > ~/.xvshishi/.cmd_token 即可启用）；
//   - 命令以 Termux 用户身份运行，请勿随意开放给不可信来源。
// 管理：由 xvshishi-services.sh 统一启停：xvshishi start cmd-runner
// ============================================================

'use strict';
const http = require('http');
const { exec } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 3002;
const HOME = os.homedir();
const TOKEN_FILE = path.join(HOME, '.xvshishi', '.cmd_token');

function token() {
  try { return fs.readFileSync(TOKEN_FILE, 'utf8').trim() || null; } catch (e) { return null; }
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Cmd-Token');
  res.setHeader('Access-Control-Max-Age', '86400');
}

function sendJson(res, code, obj) {
  cors(res);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function runCmd(cmd, cwd, timeoutMs, cb) {
  const target = (cwd && fs.existsSync(cwd)) ? cwd : HOME;
  exec(cmd, {
    cwd: target,
    timeout: timeoutMs || 90000,
    maxBuffer: 4 * 1024 * 1024,
    encoding: 'utf8'
  }, function (err, stdout, stderr) {
    cb({
      ok: !err,
      exitCode: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
      killed: !!(err && err.killed),
      stdout: String(stdout || ''),
      stderr: String(stderr || '')
    });
  });
}

const server = http.createServer(function (req, res) {
  cors(res);
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const tk = token();
  if (tk) {
    const given = req.headers['x-cmd-token'];
    if (given !== tk) { sendJson(res, 403, { ok: false, error: 'token 校验失败（请检查请求头 X-Cmd-Token）' }); return; }
  }

  const url = String(req.url || '/');

  if (req.method === 'GET' && url.indexOf('/health') === 0) {
    exec('git --version', { timeout: 5000 }, function (e, so) {
      sendJson(res, 200, { ok: true, service: 'cmd-runner', port: PORT, git: e ? null : String(so || '').trim() });
    });
    return;
  }

  if (req.method === 'POST' && url.indexOf('/run') === 0) {
    let body = '';
    req.on('data', function (c) { body += c; if (body.length > 524288) req.destroy(); });
    req.on('end', function () {
      let p = {};
      try { p = JSON.parse(body || '{}'); } catch (e) { sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' }); return; }
      const cmd = String(p.cmd || '').trim();
      if (!cmd) { sendJson(res, 400, { ok: false, error: '缺少 cmd' }); return; }
      runCmd(cmd, String(p.cwd || ''), p.timeout_ms || 90000, function (r) { sendJson(res, 200, r); });
    });
    return;
  }

  sendJson(res, 404, { ok: false, error: 'not found' });
});

server.listen(PORT, '127.0.0.1', function () {
  console.log('[cmd-runner] listening on http://127.0.0.1:' + PORT + (token() ? ' (token 已启用)' : ' (未启用 token，仅绑定本机)'));
});
`;


  // link-meta 源码以 Base64 内嵌（避免模板字符串转义破坏正则/\u 序列）
  var LINK_META_SOURCE_B64 = "IyEvZGF0YS9kYXRhL2NvbS50ZXJtdXgvZmlsZXMvdXNyL2Jpbi9lbnYgbm9kZQovLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0KLy8g5Y+Z5LqL6K+X5bCP5omL5py6IC0gbGluay1tZXRh77yI5YaF572u6ISa5pysNCDCtyDliIbkuqvpk77mjqXlhYPmlbDmja7op6PmnpDmnI3liqHvvIznq6/lj6MgMzAwM++8iQovLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0KLy8g55So6YCU77yaQXBwL+e9kemhteWPlyBXZWJWaWV3IOaymeeuseS4jiBDT1JTIOmZkOWItu+8jOaXoOazleebtOaOpeaKk+WPluWIhuS6q+mTvuaOpeeahOagh+mimC/lsIHpnaIv5pGY6KaB44CCCi8vICAgICAgIOacrOacjeWKoeWcqCBUZXJtdXgg5YaF5Lul44CM5pyN5Yqh56uv44CN6Lqr5Lu95oqT5Y+W5bm26Kej5p6Q77yM6L+U5Zue5bmy5YeAIEpTT04g57uZIEFwcCDmuLLmn5PliIbkuqvljaHniYfjgIIKLy8g6IO95Yqb77yaCi8vICAgLSDot5/pmo/ph43lrprlkJHvvIh4aHNsaW5rLmNuIOefremTviDihpIg5bCP57qi5Lmm56yU6K6wL+S4u+mhte+8iQovLyAgIC0g56e75Yqo56uvIFVBIOS8quijhe+8iOWwj+e6ouS5puWvueahjOmdoiBVQSDkuI3ov5Tlm57lhoXlrrnvvIkKLy8gICAtIOWwj+e6ouS5pueslOiusOOAjOWFqOS/oeaBr+OAje+8muagh+mimC/mraPmlocv5L2c6ICFL+WbvueJh+WIl+ihqCArIOeCuei1ni/mlLbol48v6K+E6K66L+WIhuS6q+aVsCArIOWPkeW4g+aXtumXtAovLyAgICAgKyDor53popjmoIfnrb4gKyDpppblsY/or4TorrrvvIjlkKvlrZDor4TorrrvvInvvIzljbMi54K56L+b6ZO+5o6l6IO955yL5Yiw5LuA5LmI77yM5bCx6L+U5Zue5LuA5LmIIgovLyAgIC0g6YCa55So572R6aG177yab2c6dGl0bGUvb2c6ZGVzY3JpcHRpb24vb2c6aW1hZ2UvdHdpdHRlcjoqIC8gPHRpdGxlPgovLyAgIC0gL2ltZyDlm77niYfku6PnkIbvvIjooaUgQ09SUyDlpLTvvIzkvpsgQXBwIOaKiuW4luWtkOmFjeWbvuWOi+e8qeWQjumaj+a2iOaBr+mAgee7meinhuinieaooeWei++8iQovLyDmjqXlj6PvvJoKLy8gICBHRVQgL2hlYWx0aCAgICAgICAgICAgICAgICDihpIg5YGl5bq35qOA5p+lCi8vICAgR0VUIC9tZXRhP3VybD0855uu5qCH6ZO+5o6lPiAgICDihpIg6L+U5ZueIHtvaywgZmluYWxVcmwsIHNpdGUsIGtpbmQsIHRpdGxlLCBkZXNjLCBhdXRob3IsIGltYWdlc1tdLAovLyAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBsaWtlZENvdW50LCBjb2xsZWN0ZWRDb3VudCwgY29tbWVudENvdW50LCBzaGFyZUNvdW50LAovLyAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBwdWJsaXNoVGltZSwgdGFnc1tdLCBub3RlSWQsIGNvbW1lbnRzW10sIGNvbW1lbnRzSGFzTW9yZX0KLy8gICBHRVQgL2ltZz91cmw9POWbvueJh+WcsOWdgD4gICAgIOKGkiDljp/moLfovazlj5Hlm77niYflrZfoioLvvIhBY2Nlc3MtQ29udHJvbC1BbGxvdy1PcmlnaW46ICrvvIkKLy8gICBHRVQgL3Jhdz91cmw9POebruagh+mTvuaOpT4gICAgIOKGkiDljp/moLfovazlj5HpobXpnaIgSFRNTO+8iOW3peS9nOWPsCBmZXRjaF91cmwg5oqT5q2j5paH5YWc5bqV77yJCi8vIOeuoeeQhu+8mnh2c2hpc2hpIHN0YXJ0IGxpbmstbWV0YQovLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0KCid1c2Ugc3RyaWN0JzsKY29uc3QgaHR0cCA9IHJlcXVpcmUoJ2h0dHAnKTsKY29uc3QgaHR0cHMgPSByZXF1aXJlKCdodHRwcycpOwpjb25zdCB0bHMgPSByZXF1aXJlKCd0bHMnKTsKCmNvbnN0IFBPUlQgPSBwcm9jZXNzLmVudi5QT1JUIHx8IDMwMDM7CmNvbnN0IE1BWF9SRURJUkVDVCA9IDg7CmNvbnN0IFRJTUVPVVRfTVMgPSAxNTAwMDsKY29uc3QgTUFYX0JZVEVTID0gMyAqIDEwMjQgKiAxMDI0Owpjb25zdCBNQVhfSU1HX0JZVEVTID0gOCAqIDEwMjQgKiAxMDI0Owpjb25zdCBNQVhfSU1BR0VTID0gMjA7CmNvbnN0IE1BWF9DT01NRU5UUyA9IDEyOwoKY29uc3QgTU9CSUxFX1VBID0gJ01vemlsbGEvNS4wIChpUGhvbmU7IENQVSBpUGhvbmUgT1MgMTdfMCBsaWtlIE1hYyBPUyBYKSBBcHBsZVdlYktpdC82MDUuMS4xNSAoS0hUTUwsIGxpa2UgR2Vja28pIFZlcnNpb24vMTcuMCBNb2JpbGUvMTVFMTQ4IFNhZmFyaS82MDQuMSc7Cgpjb25zdCBTSVRFX01BUCA9IFsKICBbL3hoc2xpbmtcLmNufHhpYW9ob25nc2h1XC5jb20vaSwgJ+Wwj+e6ouS5piddLAogIFsvKD86XnxcL1wvKSg/Ond3d1wuKT8oPzp4fHR3aXR0ZXIpXC5jb20vaSwgJ1jvvIjmjqjnibnvvIknXSwKICBbL2JpbGliaWxpXC5jb218YjIzXC50di9pLCAn5ZOU5ZOp5ZOU5ZOpJ10sCiAgWy9kb3V5aW5cLmNvbXxpZXNkb3V5aW4vaSwgJ+aKlumfsyddLAogIFsvd2VpYm9cLihjbnxjb20pL2ksICflvq7ljZonXSwKICBbL3poaWh1XC5jb20vaSwgJ+efpeS5jiddLAogIFsvZ2l0aHViXC5jb20vaSwgJ0dpdEh1YiddLAogIFsveW91dHViZVwuY29tfHlvdXR1XC5iZS9pLCAnWW91VHViZSddLAogIFsvdGFvYmFvXC5jb218dG1hbGxcLmNvbXx0YlwuY24vaSwgJ+a3mOWunSddLAogIFsvamRcLmNvbS9pLCAn5Lqs5LicJ10sCiAgWy9tdXNpY1wuMTYzXC5jb20vaSwgJ+e9keaYk+S6kemfs+S5kCddLAogIFsveVwucXFcLmNvbXxxcVwuY29tL2ksICdRUemfs+S5kCddLAogIFsvbXBcLndlaXhpblwucXFcLmNvbS9pLCAn5b6u5L+h5YWs5LyX5Y+3J10KXTsKCmZ1bmN0aW9uIGNvcnMocmVzKSB7CiAgcmVzLnNldEhlYWRlcignQWNjZXNzLUNvbnRyb2wtQWxsb3ctT3JpZ2luJywgJyonKTsKICByZXMuc2V0SGVhZGVyKCdBY2Nlc3MtQ29udHJvbC1BbGxvdy1NZXRob2RzJywgJ0dFVCwgT1BUSU9OUycpOwogIHJlcy5zZXRIZWFkZXIoJ0FjY2Vzcy1Db250cm9sLUFsbG93LUhlYWRlcnMnLCAnKicpOwogIHJlcy5zZXRIZWFkZXIoJ0FjY2Vzcy1Db250cm9sLU1heC1BZ2UnLCAnODY0MDAnKTsKfQoKZnVuY3Rpb24gc2VuZEpzb24ocmVzLCBjb2RlLCBvYmopIHsKICBjb3JzKHJlcyk7CiAgcmVzLndyaXRlSGVhZChjb2RlLCB7ICdDb250ZW50LVR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7CiAgcmVzLmVuZChKU09OLnN0cmluZ2lmeShvYmopKTsKfQoKZnVuY3Rpb24gc2l0ZU9mKHVybCkgewogIGZvciAoY29uc3QgW3JlLCBuYW1lXSBvZiBTSVRFX01BUCkgaWYgKHJlLnRlc3QodXJsKSkgcmV0dXJuIG5hbWU7CiAgdHJ5IHsgcmV0dXJuIG5ldyBVUkwodXJsKS5ob3N0bmFtZTsgfSBjYXRjaCAoZSkgeyByZXR1cm4gJyc7IH0KfQoKZnVuY3Rpb24gdW5lc2NhcGVKc29uKHMpIHsKICBpZiAoIXMpIHJldHVybiAnJzsKICByZXR1cm4gU3RyaW5nKHMpCiAgICAucmVwbGFjZSgvXFx1MDAyRi9naSwgJy8nKQogICAgLnJlcGxhY2UoL1xcdTAwMmYvZywgJy8nKQogICAgLnJlcGxhY2UoL1xcXC8vZywgJy8nKQogICAgLnJlcGxhY2UoL1xcbi9nLCAnXG4nKQogICAgLnJlcGxhY2UoL1xcdC9nLCAnICcpCiAgICAucmVwbGFjZSgvXFwiL2csICciJykKICAgIC5yZXBsYWNlKC9cXHUoWzAtOWEtZkEtRl17NH0pL2csIChtLCBoKSA9PiBTdHJpbmcuZnJvbUNoYXJDb2RlKHBhcnNlSW50KGgsIDE2KSkpOwp9CgpmdW5jdGlvbiBjbGVhblRleHQocykgewogIHJldHVybiB1bmVzY2FwZUpzb24oU3RyaW5nKHMgfHwgJycpKQogICAgLnJlcGxhY2UoLzxbXj5dKz4vZywgJycpCiAgICAucmVwbGFjZSgvW1x1MDAwMC1cdTAwMWZdL2csICcgJykKICAgIC5yZXBsYWNlKC9ccysvZywgJyAnKQogICAgLnRyaW0oKTsKfQoKLyoqIOW3suaYryBKU09OLnBhcnNlIOWQjueahOWtl+espuS4su+8muWPquWBmuagh+etvuWJpeemu+S4juepuueZveaVtOeQhu+8jOWPr+S/neeVmeaNouihjCAqLwpmdW5jdGlvbiB0aWR5VGV4dChzLCBrZWVwTmV3bGluZXMpIHsKICBsZXQgdCA9IFN0cmluZyhzID09IG51bGwgPyAnJyA6IHMpLnJlcGxhY2UoLzxbXj5dKz4vZywgJycpLnJlcGxhY2UoL1xyL2csICcnKTsKICBpZiAoa2VlcE5ld2xpbmVzKSB7CiAgICB0ID0gdC5yZXBsYWNlKC9bIFx0XHUwMGEwXSsvZywgJyAnKS5yZXBsYWNlKC9cbnszLH0vZywgJ1xuXG4nKTsKICAgIHJldHVybiB0LnNwbGl0KCdcbicpLm1hcCgobCkgPT4gbC50cmltKCkpLmpvaW4oJ1xuJykudHJpbSgpOwogIH0KICByZXR1cm4gdC5yZXBsYWNlKC9ccysvZywgJyAnKS50cmltKCk7Cn0KCmZ1bmN0aW9uIHRvSW50KHYpIHsKICBpZiAodiA9PSBudWxsKSByZXR1cm4gbnVsbDsKICBpZiAodHlwZW9mIHYgPT09ICdudW1iZXInICYmIGlzRmluaXRlKHYpKSByZXR1cm4gTWF0aC5yb3VuZCh2KTsKICBjb25zdCBtID0gU3RyaW5nKHYpLnJlcGxhY2UoL1teXGQuXS9nLCAnJyk7CiAgaWYgKCFtKSByZXR1cm4gbnVsbDsKICBjb25zdCBmID0gcGFyc2VGbG9hdChtKTsKICByZXR1cm4gaXNOYU4oZikgPyBudWxsIDogTWF0aC5yb3VuZChmKTsKfQoKZnVuY3Rpb24gdG9IdHRwcyh1KSB7CiAgY29uc3QgcyA9IFN0cmluZyh1IHx8ICcnKTsKICBpZiAoL15odHRwOlwvXC8vaS50ZXN0KHMpKSByZXR1cm4gJ2h0dHBzOi8vJyArIHMuc2xpY2UoNyk7CiAgcmV0dXJuIHM7Cn0KCi8vIC0tLS0g5Y+v6YCJ5Luj55CG77ya5aKD5aSW56uZ54K577yIWC9Ud2l0dGVy44CBR2l0SHViIOetie+8ieWcqOaJi+acuuS4iumAmuW4uOmcgOimgei1sOS7o+eQhiAtLS0tCi8vIOWPquimgeiuvue9ruS6hiBIVFRQU19QUk9YWSAvIEFMTF9QUk9YWe+8iOS+i+WmgiBDbGFzaCDnmoQgaHR0cDovLzEyNy4wLjAuMTo3ODkw77yJ77yM5pys5pyN5Yqh5bCx6LWwIENPTk5FQ1Qg6Zqn6YGT44CCCmNvbnN0IFBST1hZX1VSTCA9IHByb2Nlc3MuZW52LkhUVFBTX1BST1hZIHx8IHByb2Nlc3MuZW52LkFMTF9QUk9YWSB8fCBwcm9jZXNzLmVudi5odHRwc19wcm94eSB8fCAnJzsKCi8qKiDnu5/kuIAgR0VU77ya5peg5Luj55CG55u06L+e77yb5pyJ5Luj55CG5pe25YWIIENPTk5FQ1Qg5YaN5Zyo6Zqn6YGT5LiK5Y+RIEhUVFBTIOivt+axgiAqLwpmdW5jdGlvbiByYXdHZXQodSwgaGVhZGVycywgb25SZXNwLCBvbkVycikgewogIGNvbnN0IGlzSHR0cHMgPSB1LnByb3RvY29sID09PSAnaHR0cHM6JzsKICBjb25zdCBkaXJlY3QgPSAoZXh0cmEpID0+IHsKICAgIGNvbnN0IGxpYiA9IGlzSHR0cHMgPyBodHRwcyA6IGh0dHA7CiAgICBjb25zdCByZXEgPSBsaWIucmVxdWVzdChPYmplY3QuYXNzaWduKHsKICAgICAgbWV0aG9kOiAnR0VUJywgaGVhZGVycywgdGltZW91dDogVElNRU9VVF9NUywKICAgICAgaG9zdG5hbWU6IHUuaG9zdG5hbWUsIHBvcnQ6IHUucG9ydCB8fCAoaXNIdHRwcyA/IDQ0MyA6IDgwKSwKICAgICAgcGF0aDogdS5wYXRobmFtZSArIHUuc2VhcmNoCiAgICB9LCBleHRyYSB8fCB7fSksIG9uUmVzcCk7CiAgICByZXEub24oJ3RpbWVvdXQnLCAoKSA9PiB7IHJlcS5kZXN0cm95KCk7IG9uRXJyKG5ldyBFcnJvcigndGltZW91dCcpKTsgfSk7CiAgICByZXEub24oJ2Vycm9yJywgb25FcnIpOwogICAgcmVxLmVuZCgpOwogICAgcmV0dXJuIHJlcTsKICB9OwoKICBsZXQgcHJveHkgPSBudWxsOwogIGlmIChQUk9YWV9VUkwgJiYgaXNIdHRwcykgeyB0cnkgeyBwcm94eSA9IG5ldyBVUkwoUFJPWFlfVVJMKTsgfSBjYXRjaCAoZSkgeyBwcm94eSA9IG51bGw7IH0gfQogIGlmICghcHJveHkpIHJldHVybiBkaXJlY3QoKTsKCiAgY29uc3QgY29ubmVjdFJlcSA9IGh0dHAucmVxdWVzdCh7CiAgICBob3N0OiBwcm94eS5ob3N0bmFtZSwgcG9ydDogcHJveHkucG9ydCB8fCA4MCwgbWV0aG9kOiAnQ09OTkVDVCcsCiAgICBwYXRoOiB1Lmhvc3RuYW1lICsgJzo0NDMnLCB0aW1lb3V0OiBUSU1FT1VUX01TCiAgfSk7CiAgY29ubmVjdFJlcS5vbignY29ubmVjdCcsIChyZXMsIHNvY2tldCkgPT4gewogICAgaWYgKHJlcy5zdGF0dXNDb2RlICE9PSAyMDApIHsgc29ja2V0LmRlc3Ryb3koKTsgcmV0dXJuIG9uRXJyKG5ldyBFcnJvcigncHJveHkgQ09OTkVDVCAnICsgcmVzLnN0YXR1c0NvZGUpKTsgfQogICAgY29uc3QgdGxzU29jayA9IHRscy5jb25uZWN0KHsgc29ja2V0LCBzZXJ2ZXJuYW1lOiB1Lmhvc3RuYW1lIH0sICgpID0+IHsKICAgICAgZGlyZWN0KHsgY3JlYXRlQ29ubmVjdGlvbjogKCkgPT4gdGxzU29jaywgaG9zdG5hbWU6IHUuaG9zdG5hbWUsIHBvcnQ6IDQ0MyB9KTsKICAgIH0pOwogICAgdGxzU29jay5vbignZXJyb3InLCBvbkVycik7CiAgfSk7CiAgY29ubmVjdFJlcS5vbigndGltZW91dCcsICgpID0+IHsgY29ubmVjdFJlcS5kZXN0cm95KCk7IG9uRXJyKG5ldyBFcnJvcigncHJveHkgdGltZW91dCcpKTsgfSk7CiAgY29ubmVjdFJlcS5vbignZXJyb3InLCBvbkVycik7CiAgY29ubmVjdFJlcS5lbmQoKTsKICByZXR1cm4gY29ubmVjdFJlcTsKfQoKLyoqIOW4pumHjeWumuWQkeeahCBHRVTvvIzov5Tlm54geyBmaW5hbFVybCwgYm9keSwgc3RhdHVzIH0gKi8KZnVuY3Rpb24gZmV0Y2hGb2xsb3codGFyZ2V0VXJsLCBkZXB0aCkgewogIGRlcHRoID0gZGVwdGggfHwgMDsKICByZXR1cm4gbmV3IFByb21pc2UoKHJlc29sdmUsIHJlamVjdCkgPT4gewogICAgbGV0IHU7CiAgICB0cnkgeyB1ID0gbmV3IFVSTCh0YXJnZXRVcmwpOyB9IGNhdGNoIChlKSB7IHJldHVybiByZWplY3QobmV3IEVycm9yKCdpbnZhbGlkIHVybCcpKTsgfQogICAgbGV0IHJlcSA9IG51bGw7CiAgICByZXEgPSByYXdHZXQodSwgewogICAgICAnVXNlci1BZ2VudCc6IE1PQklMRV9VQSwKICAgICAgJ0FjY2VwdCc6ICd0ZXh0L2h0bWwsYXBwbGljYXRpb24veGh0bWwreG1sLGFwcGxpY2F0aW9uL2pzb247cT0wLjksKi8qO3E9MC44JywKICAgICAgJ0FjY2VwdC1MYW5ndWFnZSc6ICd6aC1DTix6aDtxPTAuOSxlbjtxPTAuOCcsCiAgICAgICdBY2NlcHQtRW5jb2RpbmcnOiAnaWRlbnRpdHknCiAgICB9LCAocmVzcCkgPT4gewogICAgICBjb25zdCBjb2RlID0gcmVzcC5zdGF0dXNDb2RlIHx8IDA7CiAgICAgIGlmIChjb2RlID49IDMwMCAmJiBjb2RlIDwgNDAwICYmIHJlc3AuaGVhZGVycy5sb2NhdGlvbikgewogICAgICAgIGlmIChkZXB0aCA+PSBNQVhfUkVESVJFQ1QpIHsgcmVzcC5yZXN1bWUoKTsgcmV0dXJuIHJlamVjdChuZXcgRXJyb3IoJ3RvbyBtYW55IHJlZGlyZWN0cycpKTsgfQogICAgICAgIGNvbnN0IG5leHQgPSBuZXcgVVJMKHJlc3AuaGVhZGVycy5sb2NhdGlvbiwgdSkudG9TdHJpbmcoKTsKICAgICAgICByZXNwLnJlc3VtZSgpOwogICAgICAgIHJldHVybiByZXNvbHZlKGZldGNoRm9sbG93KG5leHQsIGRlcHRoICsgMSkpOwogICAgICB9CiAgICAgIGxldCBzaXplID0gMDsKICAgICAgY29uc3QgY2h1bmtzID0gW107CiAgICAgIHJlc3Aub24oJ2RhdGEnLCAoYykgPT4gewogICAgICAgIHNpemUgKz0gYy5sZW5ndGg7CiAgICAgICAgaWYgKHNpemUgPiBNQVhfQllURVMpIHsgaWYgKHJlcSAmJiByZXEuZGVzdHJveSkgcmVxLmRlc3Ryb3koKTsgcmV0dXJuOyB9CiAgICAgICAgY2h1bmtzLnB1c2goYyk7CiAgICAgIH0pOwogICAgICByZXNwLm9uKCdlbmQnLCAoKSA9PiB7CiAgICAgICAgcmVzb2x2ZSh7IGZpbmFsVXJsOiB1LnRvU3RyaW5nKCksIHN0YXR1czogY29kZSwgYm9keTogQnVmZmVyLmNvbmNhdChjaHVua3MpLnRvU3RyaW5nKCd1dGY4JykgfSk7CiAgICAgIH0pOwogICAgfSwgcmVqZWN0KTsKICAgIHJlcS5vbigndGltZW91dCcsICgpID0+IHsgcmVxLmRlc3Ryb3koKTsgcmVqZWN0KG5ldyBFcnJvcigndGltZW91dCcpKTsgfSk7CiAgICByZXEub24oJ2Vycm9yJywgcmVqZWN0KTsKICAgIHJlcS5lbmQoKTsKICB9KTsKfQoKLyoqIOS4i+i9veWbvueJh+Wtl+iKgu+8iOi3n+maj+mHjeWumuWQke+8ie+8jOi/lOWbniB7IHR5cGUsIGJ1ZiB9ICovCmZ1bmN0aW9uIGZldGNoSW1hZ2UodGFyZ2V0VXJsLCBkZXB0aCkgewogIGRlcHRoID0gZGVwdGggfHwgMDsKICByZXR1cm4gbmV3IFByb21pc2UoKHJlc29sdmUsIHJlamVjdCkgPT4gewogICAgbGV0IHU7CiAgICB0cnkgeyB1ID0gbmV3IFVSTCh0YXJnZXRVcmwpOyB9IGNhdGNoIChlKSB7IHJldHVybiByZWplY3QobmV3IEVycm9yKCdpbnZhbGlkIHVybCcpKTsgfQogICAgY29uc3QgbGliID0gdS5wcm90b2NvbCA9PT0gJ2h0dHBzOicgPyBodHRwcyA6IGh0dHA7CiAgICAvLyDlsI/nuqLkuablm77luorvvIh4aHNjZG7vvInlr7noh6rouqvln5/lkI0gUmVmZXJlciDov5Tlm54gNDAz77yM5b+F6aG75Lyq6KOF5oiQ56uZ5YaF5p2l5rqQCiAgICBjb25zdCByZWZlcmVyID0gL3hoc2NkblwuY29tfHhpYW9ob25nc2h1XC5jb218eGhzbGlua1wuY24vaS50ZXN0KHUuaG9zdG5hbWUpCiAgICAgID8gJ2h0dHBzOi8vd3d3LnhpYW9ob25nc2h1LmNvbS8nCiAgICAgIDogKHUub3JpZ2luICsgJy8nKTsKICAgIGNvbnN0IHJlcSA9IGxpYi5yZXF1ZXN0KHUsIHsKICAgICAgbWV0aG9kOiAnR0VUJywKICAgICAgaGVhZGVyczogewogICAgICAgICdVc2VyLUFnZW50JzogTU9CSUxFX1VBLAogICAgICAgICdBY2NlcHQnOiAnaW1hZ2UvYXZpZixpbWFnZS93ZWJwLGltYWdlL2FwbmcsaW1hZ2UvKiwqLyo7cT0wLjgnLAogICAgICAgICdSZWZlcmVyJzogcmVmZXJlciwKICAgICAgICAnQWNjZXB0LUVuY29kaW5nJzogJ2lkZW50aXR5JwogICAgICB9LAogICAgICB0aW1lb3V0OiBUSU1FT1VUX01TCiAgICB9LCAocmVzcCkgPT4gewogICAgICBjb25zdCBjb2RlID0gcmVzcC5zdGF0dXNDb2RlIHx8IDA7CiAgICAgIGlmIChjb2RlID49IDMwMCAmJiBjb2RlIDwgNDAwICYmIHJlc3AuaGVhZGVycy5sb2NhdGlvbikgewogICAgICAgIGlmIChkZXB0aCA+PSBNQVhfUkVESVJFQ1QpIHsgcmVzcC5yZXN1bWUoKTsgcmV0dXJuIHJlamVjdChuZXcgRXJyb3IoJ3RvbyBtYW55IHJlZGlyZWN0cycpKTsgfQogICAgICAgIGNvbnN0IG5leHQgPSBuZXcgVVJMKHJlc3AuaGVhZGVycy5sb2NhdGlvbiwgdSkudG9TdHJpbmcoKTsKICAgICAgICByZXNwLnJlc3VtZSgpOwogICAgICAgIHJldHVybiByZXNvbHZlKGZldGNoSW1hZ2UobmV4dCwgZGVwdGggKyAxKSk7CiAgICAgIH0KICAgICAgaWYgKGNvZGUgIT09IDIwMCkgeyByZXNwLnJlc3VtZSgpOyByZXR1cm4gcmVqZWN0KG5ldyBFcnJvcignaHR0cCAnICsgY29kZSkpOyB9CiAgICAgIGxldCBzaXplID0gMDsKICAgICAgY29uc3QgY2h1bmtzID0gW107CiAgICAgIHJlc3Aub24oJ2RhdGEnLCAoYykgPT4gewogICAgICAgIHNpemUgKz0gYy5sZW5ndGg7CiAgICAgICAgaWYgKHNpemUgPiBNQVhfSU1HX0JZVEVTKSB7IHJlcS5kZXN0cm95KCk7IHJldHVybjsgfQogICAgICAgIGNodW5rcy5wdXNoKGMpOwogICAgICB9KTsKICAgICAgcmVzcC5vbignZW5kJywgKCkgPT4gewogICAgICAgIGNvbnN0IHR5cGUgPSBTdHJpbmcocmVzcC5oZWFkZXJzWydjb250ZW50LXR5cGUnXSB8fCAnJykuc3BsaXQoJzsnKVswXS50cmltKCk7CiAgICAgICAgaWYgKCEvXmltYWdlXC8vaS50ZXN0KHR5cGUpKSByZXR1cm4gcmVqZWN0KG5ldyBFcnJvcignbm90IGFuIGltYWdlOiAnICsgdHlwZSkpOwogICAgICAgIHJlc29sdmUoeyB0eXBlLCBidWY6IEJ1ZmZlci5jb25jYXQoY2h1bmtzKSB9KTsKICAgICAgfSk7CiAgICB9KTsKICAgIHJlcS5vbigndGltZW91dCcsICgpID0+IHsgcmVxLmRlc3Ryb3koKTsgcmVqZWN0KG5ldyBFcnJvcigndGltZW91dCcpKTsgfSk7CiAgICByZXEub24oJ2Vycm9yJywgcmVqZWN0KTsKICAgIHJlcS5lbmQoKTsKICB9KTsKfQoKZnVuY3Rpb24gbWV0YVRhZyhodG1sLCBwcm9wKSB7CiAgY29uc3QgcmUgPSBuZXcgUmVnRXhwKCc8bWV0YVtePl0rKD86cHJvcGVydHl8bmFtZSk9WyJcJ10nICsgcHJvcC5yZXBsYWNlKC9bLiorP14ke30oKXxbXF1cXF0vZywgJ1xcJCYnKSArICdbIlwnXVtePl0qPicsICdpJyk7CiAgY29uc3QgbSA9IGh0bWwubWF0Y2gocmUpOwogIGlmICghbSkgcmV0dXJuICcnOwogIGNvbnN0IGMgPSBtWzBdLm1hdGNoKC9jb250ZW50PVsiXCddKFtcc1xTXSo/KVsiXCddL2kpOwogIHJldHVybiBjID8gY2xlYW5UZXh0KGNbMV0pIDogJyc7Cn0KCi8qKiDku47ku7vmhI/kvY3nva7otbflgZrmi6zlj7fphY3lr7nmiKrlj5bvvIjlrZfnrKbkuLIv6L2s5LmJ5oSf55+l77yJ77yM55So5LqO5Y+W5YaF5bWMIEpTT04g54mH5q61ICovCmZ1bmN0aW9uIGJhbGFuY2VkU2xpY2Uocywgc3RhcnQpIHsKICBsZXQgZCA9IDAsIGluU3RyID0gZmFsc2UsIGVzYyA9IGZhbHNlOwogIGZvciAobGV0IGkgPSBzdGFydDsgaSA8IHMubGVuZ3RoOyBpKyspIHsKICAgIGNvbnN0IGNoID0gc1tpXTsKICAgIGlmIChpblN0cikgewogICAgICBpZiAoZXNjKSB7IGVzYyA9IGZhbHNlOyBjb250aW51ZTsgfQogICAgICBpZiAoY2ggPT09ICdcXCcpIHsgZXNjID0gdHJ1ZTsgY29udGludWU7IH0KICAgICAgaWYgKGNoID09PSAnIicpIGluU3RyID0gZmFsc2U7CiAgICAgIGNvbnRpbnVlOwogICAgfQogICAgaWYgKGNoID09PSAnIicpIHsgaW5TdHIgPSB0cnVlOyBjb250aW51ZTsgfQogICAgaWYgKGNoID09PSAneycgfHwgY2ggPT09ICdbJykgZCsrOwogICAgZWxzZSBpZiAoY2ggPT09ICd9JyB8fCBjaCA9PT0gJ10nKSB7IGQtLTsgaWYgKGQgPT09IDApIHJldHVybiBzLnNsaWNlKHN0YXJ0LCBpICsgMSk7IH0KICB9CiAgcmV0dXJuICcnOwp9CgovKiog5Y+W6aG16Z2i5YaF5bWMIHdpbmRvdy5fX0lOSVRJQUxfU1RBVEVfX++8iOWwj+e6ouS5puS4uuWNleihjCBKU09O77yM5Y+v6IO95ZCrIHVuZGVmaW5lZCDpnIDlhZzlupXkv67lpI3vvIkgKi8KZnVuY3Rpb24gZXh0cmFjdEluaXRpYWxTdGF0ZShodG1sKSB7CiAgY29uc3QgbSA9IGh0bWwubWF0Y2goL3dpbmRvd1wuX19JTklUSUFMX1NUQVRFX19ccyo9XHMqLyk7CiAgaWYgKCFtKSByZXR1cm4gbnVsbDsKICBjb25zdCBzdGFydCA9IG0uaW5kZXggKyBtWzBdLmxlbmd0aDsKICBsZXQgZW5kID0gaHRtbC5pbmRleE9mKCc8L3NjcmlwdD4nLCBzdGFydCk7CiAgaWYgKGVuZCA8IDApIGVuZCA9IGh0bWwubGVuZ3RoOwogIGNvbnN0IHJhdyA9IGh0bWwuc2xpY2Uoc3RhcnQsIGVuZCkudHJpbSgpLnJlcGxhY2UoLztccyokLywgJycpOwogIHRyeSB7IHJldHVybiBKU09OLnBhcnNlKHJhdyk7IH0gY2F0Y2ggKGUpIHt9CiAgdHJ5IHsgcmV0dXJuIEpTT04ucGFyc2UocmF3LnJlcGxhY2UoLzpccyp1bmRlZmluZWQoPz1ccypbLH1cXV0pL2csICc6bnVsbCcpKTsgfSBjYXRjaCAoZSkge30KICByZXR1cm4gbnVsbDsKfQoKLyoqIOaMiSBrZXkg5Y+W5YaF5bWM5a+56LGhL+aVsOe7hO+8iOato+WImeWumuS9jSArIOaLrOWPt+mFjeWvuSArIEpTT04ucGFyc2XvvInvvIzkvZzkuLrmlbTpobXop6PmnpDlpLHotKXml7bnmoTlhZzlupUgKi8KZnVuY3Rpb24gZ3JhYkpzb24oaHRtbCwga2V5KSB7CiAgY29uc3QgaSA9IGh0bWwuaW5kZXhPZignIicgKyBrZXkgKyAnIjonKTsKICBpZiAoaSA8IDApIHJldHVybiBudWxsOwogIGNvbnN0IHMgPSBodG1sLmluZGV4T2YoJ3snLCBpKTsKICBjb25zdCBhID0gaHRtbC5pbmRleE9mKCdbJywgaSk7CiAgbGV0IHN0YXJ0ID0gLTE7CiAgaWYgKHMgPj0gMCAmJiBhID49IDApIHN0YXJ0ID0gTWF0aC5taW4ocywgYSk7CiAgZWxzZSBzdGFydCA9IHMgPj0gMCA/IHMgOiBhOwogIGlmIChzdGFydCA8IDApIHJldHVybiBudWxsOwogIGNvbnN0IHJhdyA9IGJhbGFuY2VkU2xpY2UoaHRtbCwgc3RhcnQpOwogIGlmICghcmF3KSByZXR1cm4gbnVsbDsKICB0cnkgeyByZXR1cm4gSlNPTi5wYXJzZShyYXcpOyB9IGNhdGNoIChlKSB7IHJldHVybiBudWxsOyB9Cn0KCi8qKiDlsI/nuqLkuablm77niYfmnaHnm64g4oaSIOacgOS9syBVUkzvvIjkvJjlhYggaDVfMTA4MCAvIEg1X0RUTCDpq5jmuIXniYjvvIkgKi8KZnVuY3Rpb24gcGlja0ltYWdlVXJsKGl0ZW0pIHsKICBpZiAoIWl0ZW0gfHwgdHlwZW9mIGl0ZW0gIT09ICdvYmplY3QnKSByZXR1cm4gJyc7CiAgY29uc3QgY2FuZHMgPSBbXTsKICBpZiAodHlwZW9mIGl0ZW0udXJsID09PSAnc3RyaW5nJykgY2FuZHMucHVzaChpdGVtLnVybCk7CiAgKGl0ZW0uaW5mb0xpc3QgfHwgW10pLmZvckVhY2goKGlpKSA9PiB7IGlmIChpaSAmJiB0eXBlb2YgaWkudXJsID09PSAnc3RyaW5nJykgY2FuZHMucHVzaChpaS51cmwpOyB9KTsKICBpZiAoIWNhbmRzLmxlbmd0aCkgcmV0dXJuICcnOwogIGNvbnN0IGJlc3QgPSBjYW5kcy5maW5kKCh1KSA9PiAvaDVfMTA4MHxINV9EVEwvaS50ZXN0KHUpKSB8fCBjYW5kc1swXTsKICByZXR1cm4gdG9IdHRwcyhiZXN0KTsKfQoKLyoqIOmmluWxj+ivhOiuuiDihpIg57K+566A57uT5p6EICovCmZ1bmN0aW9uIG1hcENvbW1lbnQoYykgewogIGlmICghYyB8fCB0eXBlb2YgYyAhPT0gJ29iamVjdCcpIHJldHVybiBudWxsOwogIGNvbnN0IHVzZXIgPSAoYy51c2VyICYmIChjLnVzZXIubmlja25hbWUgfHwgYy51c2VyLm5pY2tOYW1lKSkgfHwgJyc7CiAgY29uc3QgY29udGVudCA9IHRpZHlUZXh0KGMuY29udGVudCB8fCAnJywgdHJ1ZSk7CiAgaWYgKCFjb250ZW50ICYmICF1c2VyKSByZXR1cm4gbnVsbDsKICByZXR1cm4gewogICAgdXNlciwKICAgIGNvbnRlbnQsCiAgICBsaWtlOiB0b0ludChjLmxpa2VDb3VudCkgfHwgMCwKICAgIGlwOiBjLmlwTG9jYXRpb24gfHwgJycsCiAgICB0aW1lOiB0b0ludChjLnRpbWUpIHx8IDAsCiAgICBzdWJzOiAoYy5zdWJDb21tZW50cyB8fCBbXSkuc2xpY2UoMCwgMykubWFwKChzKSA9PiAoewogICAgICB1c2VyOiAocyAmJiBzLnVzZXIgJiYgKHMudXNlci5uaWNrbmFtZSB8fCBzLnVzZXIubmlja05hbWUpKSB8fCAnJywKICAgICAgY29udGVudDogdGlkeVRleHQoKHMgJiYgcy5jb250ZW50KSB8fCAnJywgdHJ1ZSkKICAgIH0pKS5maWx0ZXIoKHMpID0+IHMuY29udGVudCkKICB9Owp9CgovKiog5bCP57qi5Lmm56yU6K6w6Kej5p6Q77ya5LyY5YWI5pW06aG1IF9fSU5JVElBTF9TVEFURV9fIOe7k+aehOWMluivu+WPlu+8jOWksei0peWbnumAgOato+WImSAqLwpmdW5jdGlvbiBwYXJzZVhoc05vdGUoaHRtbCkgewogIGNvbnN0IG91dCA9IHsKICAgIHRpdGxlOiAnJywgZGVzYzogJycsIGF1dGhvcjogJycsIGltYWdlczogW10sCiAgICBsaWtlZENvdW50OiBudWxsLCBjb2xsZWN0ZWRDb3VudDogbnVsbCwgY29tbWVudENvdW50OiBudWxsLCBzaGFyZUNvdW50OiBudWxsLAogICAgcHVibGlzaFRpbWU6IDAsIHRhZ3M6IFtdLCBub3RlSWQ6ICcnLCBjb21tZW50czogW10sIGNvbW1lbnRzSGFzTW9yZTogZmFsc2UKICB9OwoKICBjb25zdCBzdCA9IGV4dHJhY3RJbml0aWFsU3RhdGUoaHRtbCk7CiAgY29uc3QgZGF0YSA9IHN0ICYmIHN0Lm5vdGVEYXRhICYmIHN0Lm5vdGVEYXRhLmRhdGE7CiAgY29uc3Qgbm90ZSA9IGRhdGEgJiYgZGF0YS5ub3RlRGF0YTsKICBjb25zdCBjZGF0YSA9IGRhdGEgJiYgZGF0YS5jb21tZW50RGF0YTsKCiAgaWYgKG5vdGUpIHsKICAgIG91dC50aXRsZSA9IHRpZHlUZXh0KG5vdGUudGl0bGUgfHwgJycpOwogICAgb3V0LmRlc2MgPSB0aWR5VGV4dChub3RlLmRlc2MgfHwgJycsIHRydWUpOwogICAgb3V0LmF1dGhvciA9IChub3RlLnVzZXIgJiYgKG5vdGUudXNlci5uaWNrTmFtZSB8fCBub3RlLnVzZXIubmlja25hbWUpKSB8fCAnJzsKICAgIG91dC5ub3RlSWQgPSBub3RlLm5vdGVJZCB8fCAnJzsKICAgIG91dC5wdWJsaXNoVGltZSA9IHRvSW50KG5vdGUudGltZSkgfHwgMDsKICAgIG91dC50YWdzID0gKG5vdGUudGFnTGlzdCB8fCBbXSkubWFwKCh0KSA9PiB0aWR5VGV4dCgodCAmJiB0Lm5hbWUpIHx8ICcnKSkuZmlsdGVyKEJvb2xlYW4pOwogICAgY29uc3QgaWkgPSBub3RlLmludGVyYWN0SW5mbyB8fCB7fTsKICAgIG91dC5saWtlZENvdW50ID0gdG9JbnQoaWkubGlrZWRDb3VudCk7CiAgICBvdXQuY29sbGVjdGVkQ291bnQgPSB0b0ludChpaS5jb2xsZWN0ZWRDb3VudCk7CiAgICBvdXQuY29tbWVudENvdW50ID0gdG9JbnQoaWkuY29tbWVudENvdW50KTsKICAgIG91dC5zaGFyZUNvdW50ID0gdG9JbnQoaWkuc2hhcmVDb3VudCk7CiAgICBjb25zdCBzZWVuID0ge307CiAgICAobm90ZS5pbWFnZUxpc3QgfHwgW10pLmZvckVhY2goKGl0KSA9PiB7CiAgICAgIGNvbnN0IHUgPSBwaWNrSW1hZ2VVcmwoaXQpOwogICAgICBpZiAoIXUpIHJldHVybjsKICAgICAgaWYgKC9cL2F2YXRhclwvL2kudGVzdCh1KSkgcmV0dXJuOwogICAgICBjb25zdCBrZXkgPSAoaXQgJiYgaXQuZmlsZUlkKSB8fCAodS5tYXRjaCgvMTA0MGdbMC05YS16XSsvaSkgfHwgW3VdKVswXTsKICAgICAgaWYgKHNlZW5ba2V5XSkgcmV0dXJuOwogICAgICBzZWVuW2tleV0gPSB1OwogICAgfSk7CiAgICBvdXQuaW1hZ2VzID0gT2JqZWN0LnZhbHVlcyhzZWVuKS5zbGljZSgwLCBNQVhfSU1BR0VTKTsKICB9CgogIC8vIC0tLS0g5YWc5bqV77ya5pW06aG1IEpTT04g6Kej5p6Q5aSx6LSl5pe255So5q2j5YiZ6YCQ5Liq5a2X5q615Y+WIC0tLS0KICBpZiAoIW91dC50aXRsZSkgewogICAgY29uc3QgbSA9IGh0bWwubWF0Y2goLyJ0aXRsZSJccyo6XHMqIigoPzpbXiJcXF18XFwuKSopIi8pOwogICAgaWYgKG0pIG91dC50aXRsZSA9IGNsZWFuVGV4dChtWzFdKTsKICB9CiAgaWYgKCFvdXQuZGVzYykgewogICAgY29uc3QgbSA9IGh0bWwubWF0Y2goLyJkZXNjIlxzKjpccyoiKCg/OlteIlxcXXxcXC4pKikiLyk7CiAgICBpZiAobSkgb3V0LmRlc2MgPSBjbGVhblRleHQobVsxXSk7CiAgfQogIGlmICghb3V0LmF1dGhvcikgewogICAgY29uc3QgbSA9IGh0bWwubWF0Y2goLyJuaWNrTmFtZSJccyo6XHMqIigoPzpbXiJcXF18XFwuKSopIi8pOwogICAgaWYgKG0pIG91dC5hdXRob3IgPSBjbGVhblRleHQobVsxXSk7CiAgfQogIGlmICghb3V0LmltYWdlcy5sZW5ndGgpIHsKICAgIGNvbnN0IHVybHMgPSBbXTsKICAgIGNvbnN0IHJlID0gLyJ1cmwiXHMqOlxzKiIoaHR0cFteIl0qP3Nucy0oPzp3ZWJwaWN8aW1nKVteIl0qKSIvZzsKICAgIGxldCBtbTsKICAgIHdoaWxlICgobW0gPSByZS5leGVjKGh0bWwpKSAhPT0gbnVsbCkgewogICAgICBjb25zdCB1ID0gdW5lc2NhcGVKc29uKG1tWzFdKTsKICAgICAgaWYgKCEvXmh0dHBzPzpcL1wvLy50ZXN0KHUpKSBjb250aW51ZTsKICAgICAgaWYgKC9cLyhhdmF0YXJ8bG9nbylcLy9pLnRlc3QodSkpIGNvbnRpbnVlOwogICAgICB1cmxzLnB1c2godSk7CiAgICB9CiAgICBjb25zdCBzZWVuID0ge307CiAgICBmb3IgKGNvbnN0IHUgb2YgdXJscykgewogICAgICBjb25zdCBrZXkgPSAodS5tYXRjaCgvMTA0MGdbMC05YS16XSsvaSkgfHwgW3VdKVswXTsKICAgICAgaWYgKHNlZW5ba2V5XSkgewogICAgICAgIGlmICgvaDVfMTA4MHxINV9EVEwvaS50ZXN0KHUpICYmICEvaDVfMTA4MHxINV9EVEwvaS50ZXN0KHNlZW5ba2V5XSkpIHNlZW5ba2V5XSA9IHU7CiAgICAgICAgY29udGludWU7CiAgICAgIH0KICAgICAgc2VlbltrZXldID0gdTsKICAgICAgaWYgKHVybHMubGVuZ3RoID4gNjApIGJyZWFrOwogICAgfQogICAgb3V0LmltYWdlcyA9IE9iamVjdC52YWx1ZXMoc2Vlbikuc2xpY2UoMCwgTUFYX0lNQUdFUykubWFwKHRvSHR0cHMpOwogIH0KICBpZiAob3V0Lmxpa2VkQ291bnQgPT0gbnVsbCAmJiBvdXQuY29tbWVudENvdW50ID09IG51bGwpIHsKICAgIGNvbnN0IGlpID0gZ3JhYkpzb24oaHRtbCwgJ2ludGVyYWN0SW5mbycpOwogICAgaWYgKGlpKSB7CiAgICAgIG91dC5saWtlZENvdW50ID0gdG9JbnQoaWkubGlrZWRDb3VudCk7CiAgICAgIG91dC5jb2xsZWN0ZWRDb3VudCA9IHRvSW50KGlpLmNvbGxlY3RlZENvdW50KTsKICAgICAgb3V0LmNvbW1lbnRDb3VudCA9IHRvSW50KGlpLmNvbW1lbnRDb3VudCk7CiAgICAgIG91dC5zaGFyZUNvdW50ID0gdG9JbnQoaWkuc2hhcmVDb3VudCk7CiAgICB9CiAgfQogIGlmICghb3V0LnRhZ3MubGVuZ3RoKSB7CiAgICBjb25zdCB0bCA9IGdyYWJKc29uKGh0bWwsICd0YWdMaXN0Jyk7CiAgICBpZiAoQXJyYXkuaXNBcnJheSh0bCkpIG91dC50YWdzID0gdGwubWFwKCh0KSA9PiBjbGVhblRleHQoKHQgJiYgdC5uYW1lKSB8fCAnJykpLmZpbHRlcihCb29sZWFuKTsKICB9CiAgaWYgKCFvdXQucHVibGlzaFRpbWUpIHsKICAgIGNvbnN0IHRtID0gaHRtbC5tYXRjaCgvImF0VXNlckxpc3QiXHMqOlxzKlxbXHMqXF1ccyosXHMqInRpbWUiXHMqOlxzKihcZHsxM30pLyk7CiAgICBjb25zdCB0bTIgPSB0bSB8fCBodG1sLm1hdGNoKC8idGltZSJccyo6XHMqKFxkezEzfSkvKTsKICAgIGlmICh0bTIpIG91dC5wdWJsaXNoVGltZSA9IE51bWJlcih0bTJbMV0pOwogIH0KICBpZiAoIW91dC5jb21tZW50cy5sZW5ndGgpIHsKICAgIGNvbnN0IGNkID0gZ3JhYkpzb24oaHRtbCwgJ2NvbW1lbnREYXRhJyk7CiAgICBpZiAoY2QgJiYgQXJyYXkuaXNBcnJheShjZC5jb21tZW50cykpIHsKICAgICAgb3V0LmNvbW1lbnRDb3VudCA9IG91dC5jb21tZW50Q291bnQgIT0gbnVsbCA/IG91dC5jb21tZW50Q291bnQgOiB0b0ludChjZC5jb21tZW50Q291bnQpOwogICAgICBvdXQuY29tbWVudHNIYXNNb3JlID0gISFjZC5oYXNNb3JlOwogICAgfQogIH0KICBpZiAoY2RhdGEpIHsKICAgIGlmIChvdXQuY29tbWVudENvdW50ID09IG51bGwpIG91dC5jb21tZW50Q291bnQgPSB0b0ludChjZGF0YS5jb21tZW50Q291bnQpOwogICAgb3V0LmNvbW1lbnRzSGFzTW9yZSA9ICEhY2RhdGEuaGFzTW9yZTsKICAgIG91dC5jb21tZW50cyA9IChjZGF0YS5jb21tZW50cyB8fCBbXSkubWFwKG1hcENvbW1lbnQpLmZpbHRlcihCb29sZWFuKS5zbGljZSgwLCBNQVhfQ09NTUVOVFMpOwogIH0gZWxzZSBpZiAoIW91dC5jb21tZW50cy5sZW5ndGgpIHsKICAgIGNvbnN0IGNkID0gZ3JhYkpzb24oaHRtbCwgJ2NvbW1lbnREYXRhJyk7CiAgICBpZiAoY2QgJiYgQXJyYXkuaXNBcnJheShjZC5jb21tZW50cykpIHsKICAgICAgb3V0LmNvbW1lbnRzID0gY2QuY29tbWVudHMubWFwKG1hcENvbW1lbnQpLmZpbHRlcihCb29sZWFuKS5zbGljZSgwLCBNQVhfQ09NTUVOVFMpOwogICAgICBvdXQuY29tbWVudHNIYXNNb3JlID0gISFjZC5oYXNNb3JlOwogICAgfQogIH0KCiAgcmV0dXJuIG91dDsKfQoKLyoqIOmAmueUqOe9kemhteino+aekO+8mm9nIC8gdHdpdHRlciAvIHRpdGxlIC8g6aaW5Zu+ICovCmZ1bmN0aW9uIHBhcnNlR2VuZXJpYyhodG1sLCBmaW5hbFVybCkgewogIGNvbnN0IG91dCA9IHsgdGl0bGU6ICcnLCBkZXNjOiAnJywgYXV0aG9yOiAnJywgaW1hZ2VzOiBbXSB9OwogIG91dC50aXRsZSA9IG1ldGFUYWcoaHRtbCwgJ29nOnRpdGxlJykgfHwgbWV0YVRhZyhodG1sLCAndHdpdHRlcjp0aXRsZScpOwogIG91dC5kZXNjID0gbWV0YVRhZyhodG1sLCAnb2c6ZGVzY3JpcHRpb24nKSB8fCBtZXRhVGFnKGh0bWwsICdkZXNjcmlwdGlvbicpIHx8IG1ldGFUYWcoaHRtbCwgJ3R3aXR0ZXI6ZGVzY3JpcHRpb24nKTsKICBjb25zdCBvZ0ltZyA9IG1ldGFUYWcoaHRtbCwgJ29nOmltYWdlJykgfHwgbWV0YVRhZyhodG1sLCAndHdpdHRlcjppbWFnZScpOwogIGlmICghb3V0LnRpdGxlKSB7CiAgICBjb25zdCB0ID0gaHRtbC5tYXRjaCgvPHRpdGxlW14+XSo+KFtcc1xTXSo/KTxcL3RpdGxlPi9pKTsKICAgIGlmICh0KSBvdXQudGl0bGUgPSBjbGVhblRleHQodFsxXSk7CiAgfQogIGlmIChvZ0ltZykgb3V0LmltYWdlcy5wdXNoKHVuZXNjYXBlSnNvbihvZ0ltZykpOwogIHJldHVybiBvdXQ7Cn0KCi8vIC0tLS0tLS0tLS0tLS0tLS0gWCAvIFR3aXR0ZXIgLS0tLS0tLS0tLS0tLS0tLQovKiog5LuO5Lu75oSPIHguY29tIC8gdHdpdHRlci5jb20g6ZO+5o6l6YeM5Y+W5o6o5paHIGlkICovCmZ1bmN0aW9uIHR3ZWV0SWRPZih1cmwpIHsKICBjb25zdCBtID0gU3RyaW5nKHVybCB8fCAnJykubWF0Y2goLyg/Ol58XC9cLykoPzp3d3dcLnxtb2JpbGVcLik/KD86eHx0d2l0dGVyKVwuY29tXC9bXi8/I10rXC9zdGF0dXMoPzplcyk/XC8oXGQrKS9pKTsKICByZXR1cm4gbSA/IG1bMV0gOiAnJzsKfQoKLyoqCiAqIOaOqOaWh+ino+aekO+8muS8mOWFiOWumOaWueWFjemJtOadg+aOpeWPoyBjZG4uc3luZGljYXRpb24udHdpbWcuY29t77yI6IO95ou/5Yiw5q2j5paHL+S9nOiAhS/ngrnotZ4v6YWN5Zu+77yJ77yMCiAqIOWksei0peWGjeeUseiwg+eUqOaWueWbnumAgOmhtemdoiBvZyDmoIfnrb7jgILms6jmhI/vvJrlooPlpJbnq5nngrnvvIzmiYvmnLrpnIDog73nm7Tov54geC5jb20gLyB0d2ltZy5jb23jgIIKICovCmFzeW5jIGZ1bmN0aW9uIHBhcnNlVHdlZXRCeUlkKGlkKSB7CiAgY29uc3Qgb3V0ID0geyB0aXRsZTogJycsIGRlc2M6ICcnLCBhdXRob3I6ICcnLCBpbWFnZXM6IFtdLCBsaWtlZENvdW50OiBudWxsLCBjb21tZW50Q291bnQ6IG51bGwsIHB1Ymxpc2hUaW1lOiAwIH07CiAgaWYgKCFpZCkgcmV0dXJuIG91dDsKICBjb25zdCByID0gYXdhaXQgZmV0Y2hGb2xsb3coJ2h0dHBzOi8vY2RuLnN5bmRpY2F0aW9uLnR3aW1nLmNvbS90d2VldC1yZXN1bHQ/aWQ9JyArIGlkICsgJyZ0b2tlbj14Jmxhbmc9emgnKTsKICBjb25zdCBqID0gSlNPTi5wYXJzZShyLmJvZHkgfHwgJ3t9Jyk7CiAgaWYgKCFqIHx8ICFqLnRleHQpIHJldHVybiBvdXQ7CiAgb3V0LmRlc2MgPSB0aWR5VGV4dChqLnRleHQsIHRydWUpOwogIG91dC50aXRsZSA9IG91dC5kZXNjLnNwbGl0KCdcbicpLmZpbHRlcihCb29sZWFuKVswXSB8fCBvdXQuZGVzYzsKICBpZiAob3V0LnRpdGxlLmxlbmd0aCA+IDgwKSBvdXQudGl0bGUgPSBvdXQudGl0bGUuc2xpY2UoMCwgODApICsgJ+KApic7CiAgaWYgKGoudXNlcikgewogICAgb3V0LmF1dGhvciA9IChqLnVzZXIubmFtZSB8fCAnJykgKyAoai51c2VyLnNjcmVlbl9uYW1lID8gJyBAJyArIGoudXNlci5zY3JlZW5fbmFtZSA6ICcnKTsKICB9CiAgb3V0Lmxpa2VkQ291bnQgPSB0b0ludChqLmZhdm9yaXRlX2NvdW50KTsKICBvdXQuY29tbWVudENvdW50ID0gdG9JbnQoai5jb252ZXJzYXRpb25fY291bnQpOwogIG91dC5wdWJsaXNoVGltZSA9IGouY3JlYXRlZF9hdCA/IChEYXRlLnBhcnNlKGouY3JlYXRlZF9hdCkgfHwgMCkgOiAwOwogIGNvbnN0IGltZ3MgPSBbXTsKICAoai5waG90b3MgfHwgW10pLmZvckVhY2goKHApID0+IHsgaWYgKHAgJiYgcC51cmwpIGltZ3MucHVzaCh0b0h0dHBzKHAudXJsKSk7IH0pOwogIChqLm1lZGlhRGV0YWlscyB8fCBbXSkuZm9yRWFjaCgobW0pID0+IHsKICAgIGlmIChtbSAmJiBtbS5tZWRpYV91cmxfaHR0cHMgJiYgKCFtbS50eXBlIHx8IG1tLnR5cGUgPT09ICdwaG90bycpKSBpbWdzLnB1c2godG9IdHRwcyhtbS5tZWRpYV91cmxfaHR0cHMpKTsKICB9KTsKICBvdXQuaW1hZ2VzID0gaW1ncy5maWx0ZXIoKHUsIGkpID0+IHUgJiYgaW1ncy5pbmRleE9mKHUpID09PSBpKS5zbGljZSgwLCBNQVhfSU1BR0VTKTsKICByZXR1cm4gb3V0Owp9Cgphc3luYyBmdW5jdGlvbiBidWlsZE1ldGEodGFyZ2V0KSB7CiAgLy8gWC9Ud2l0dGVyIOaOqOaWh++8muWFiOi1sOWumOaWueWFjemJtOadg+aOpeWPo++8iHguY29tIOmhtemdouacrOi6q+aYryBKUyDmuLLmn5MgKyDlooPlpJbnq5nngrnvvIzkvJjlhYjov5nmnaHmm7TnqLPvvIkKICBjb25zdCB0d2VldElkID0gdHdlZXRJZE9mKHRhcmdldCk7CiAgaWYgKHR3ZWV0SWQpIHsKICAgIHRyeSB7CiAgICAgIGNvbnN0IHQgPSBhd2FpdCBwYXJzZVR3ZWV0QnlJZCh0d2VldElkKTsKICAgICAgaWYgKHQgJiYgdC5kZXNjKSB7CiAgICAgICAgcmV0dXJuIHsKICAgICAgICAgIG9rOiB0cnVlLAogICAgICAgICAgZmluYWxVcmw6IHRhcmdldCwKICAgICAgICAgIHNpdGU6ICdY77yI5o6o54m577yJJywKICAgICAgICAgIGtpbmQ6ICd0d2VldCcsCiAgICAgICAgICB0aXRsZTogdC50aXRsZSB8fCB0LmRlc2Muc2xpY2UoMCwgODApLAogICAgICAgICAgZGVzYzogdC5kZXNjLAogICAgICAgICAgYXV0aG9yOiB0LmF1dGhvciB8fCAnJywKICAgICAgICAgIGltYWdlczogdC5pbWFnZXMgfHwgW10sCiAgICAgICAgICBsaWtlZENvdW50OiB0Lmxpa2VkQ291bnQsCiAgICAgICAgICBjb21tZW50Q291bnQ6IHQuY29tbWVudENvdW50LAogICAgICAgICAgcHVibGlzaFRpbWU6IHQucHVibGlzaFRpbWUgfHwgMCwKICAgICAgICAgIHR3ZWV0SWQ6IHR3ZWV0SWQKICAgICAgICB9OwogICAgICB9CiAgICB9IGNhdGNoIChlKSB7CiAgICAgIC8vIOaOpeWPo+S4jemAmu+8iOWig+Wklue9kee7nO+8ieKGkiDnu6fnu63otbDpgJrnlKjpobXpnaLop6PmnpAKICAgIH0KICB9CgogIGNvbnN0IHIgPSBhd2FpdCBmZXRjaEZvbGxvdyh0YXJnZXQpOwogIGNvbnN0IGh0bWwgPSByLmJvZHkgfHwgJyc7CiAgY29uc3QgZmluYWxVcmwgPSByLmZpbmFsVXJsOwogIGNvbnN0IHNpdGUgPSBzaXRlT2YoZmluYWxVcmwpIHx8IHNpdGVPZih0YXJnZXQpOwogIGNvbnN0IGlzWGhzID0gL3hpYW9ob25nc2h1XC5jb218eGhzbGlua1wuY24vaS50ZXN0KGZpbmFsVXJsKTsKICBjb25zdCBpc1hoc05vdGUgPSAveGlhb2hvbmdzaHVcLmNvbVwvKGRpc2NvdmVyeVwvaXRlbXxleHBsb3JlKVwvL2kudGVzdChmaW5hbFVybCk7CiAgY29uc3QgaXNUd2VldCA9ICEhdHdlZXRJZE9mKGZpbmFsVXJsKSB8fCAhIXR3ZWV0SWRPZih0YXJnZXQpOwoKICBsZXQgcGFyc2VkOwogIGxldCBraW5kID0gJ3dlYic7CiAgaWYgKGlzWGhzICYmIGlzWGhzTm90ZSkgewogICAgcGFyc2VkID0gcGFyc2VYaHNOb3RlKGh0bWwpOwogICAga2luZCA9ICd4aHMtbm90ZSc7CiAgfSBlbHNlIGlmIChpc1R3ZWV0KSB7CiAgICBwYXJzZWQgPSBwYXJzZUdlbmVyaWMoaHRtbCwgZmluYWxVcmwpOwogICAga2luZCA9ICd0d2VldCc7CiAgfSBlbHNlIHsKICAgIHBhcnNlZCA9IHBhcnNlR2VuZXJpYyhodG1sLCBmaW5hbFVybCk7CiAgICBraW5kID0gaXNYaHMgPyAneGhzLXByb2ZpbGUnIDogJ3dlYic7CiAgfQogIC8vIOWwj+e6ouS5puS4u+mhteihpeWFhe+8mmRlc2NyaXB0aW9uIOmHjOmAmuW4uOacieeyieS4nS/lhbPms6jkv6Hmga8KICBpZiAoa2luZCA9PT0gJ3hocy1wcm9maWxlJyAmJiAhcGFyc2VkLmRlc2MpIHBhcnNlZC5kZXNjID0gbWV0YVRhZyhodG1sLCAnZGVzY3JpcHRpb24nKTsKCiAgY29uc3QgbWV0YSA9IHsKICAgIG9rOiB0cnVlLAogICAgZmluYWxVcmwsCiAgICBzaXRlLAogICAga2luZCwKICAgIHRpdGxlOiBwYXJzZWQudGl0bGUgfHwgc2l0ZSB8fCBmaW5hbFVybCwKICAgIGRlc2M6IHBhcnNlZC5kZXNjIHx8ICcnLAogICAgYXV0aG9yOiBwYXJzZWQuYXV0aG9yIHx8ICcnLAogICAgaW1hZ2VzOiBwYXJzZWQuaW1hZ2VzIHx8IFtdCiAgfTsKICAvLyDlsI/nuqLkuabnrJTorrDpmYTluKblhajph4/kupLliqgv6K+E6K665L+h5oGv77yI6Z2e56yU6K6w57G75LiN6L+U5Zue77yM5L+d5oyB6YCa55So57uT5p6E5bmy5YeA77yJCiAgaWYgKGtpbmQgPT09ICd4aHMtbm90ZScpIHsKICAgIG1ldGEubGlrZWRDb3VudCA9IHBhcnNlZC5saWtlZENvdW50OwogICAgbWV0YS5jb2xsZWN0ZWRDb3VudCA9IHBhcnNlZC5jb2xsZWN0ZWRDb3VudDsKICAgIG1ldGEuY29tbWVudENvdW50ID0gcGFyc2VkLmNvbW1lbnRDb3VudDsKICAgIG1ldGEuc2hhcmVDb3VudCA9IHBhcnNlZC5zaGFyZUNvdW50OwogICAgbWV0YS5wdWJsaXNoVGltZSA9IHBhcnNlZC5wdWJsaXNoVGltZSB8fCAwOwogICAgbWV0YS50YWdzID0gcGFyc2VkLnRhZ3MgfHwgW107CiAgICBtZXRhLm5vdGVJZCA9IHBhcnNlZC5ub3RlSWQgfHwgJyc7CiAgICBtZXRhLmNvbW1lbnRzID0gcGFyc2VkLmNvbW1lbnRzIHx8IFtdOwogICAgbWV0YS5jb21tZW50c0hhc01vcmUgPSAhIXBhcnNlZC5jb21tZW50c0hhc01vcmU7CiAgfQogIC8vIOaOqOaWh++8mumhtemdoiBvZyDlm57pgIDml7bkuZ/og73luKbkuIrmjqjmlocgaWTvvIzkvpvljaHniYfmmL7npLoKICBpZiAoa2luZCA9PT0gJ3R3ZWV0JykgbWV0YS50d2VldElkID0gdHdlZXRJZE9mKGZpbmFsVXJsKSB8fCB0d2VldElkT2YodGFyZ2V0KSB8fCAnJzsKICByZXR1cm4gbWV0YTsKfQoKLy8gLS0tLSDlm77niYfku6PnkIbvvJrlhoXlrZjlsI/nvJPlrZjvvIzpgb/lhY3lkIzkuIDluJblpJrlm77ooqvlj43lpI3kuIvovb0gLS0tLQpjb25zdCBpbWdDYWNoZSA9IG5ldyBNYXAoKTsKY29uc3QgSU1HX0NBQ0hFX1RUTCA9IDEwICogNjAgKiAxMDAwOwpjb25zdCBJTUdfQ0FDSEVfTUFYID0gNDA7CgpmdW5jdGlvbiBjYWNoZUdldChrZXkpIHsKICBjb25zdCBoaXQgPSBpbWdDYWNoZS5nZXQoa2V5KTsKICBpZiAoIWhpdCkgcmV0dXJuIG51bGw7CiAgaWYgKERhdGUubm93KCkgLSBoaXQuYXQgPiBJTUdfQ0FDSEVfVFRMKSB7IGltZ0NhY2hlLmRlbGV0ZShrZXkpOyByZXR1cm4gbnVsbDsgfQogIHJldHVybiBoaXQ7Cn0KCmZ1bmN0aW9uIGNhY2hlU2V0KGtleSwgdHlwZSwgYnVmKSB7CiAgaWYgKGltZ0NhY2hlLnNpemUgPj0gSU1HX0NBQ0hFX01BWCkgewogICAgY29uc3QgZmlyc3QgPSBpbWdDYWNoZS5rZXlzKCkubmV4dCgpOwogICAgaWYgKCFmaXJzdC5kb25lKSBpbWdDYWNoZS5kZWxldGUoZmlyc3QudmFsdWUpOwogIH0KICBpbWdDYWNoZS5zZXQoa2V5LCB7IGF0OiBEYXRlLm5vdygpLCB0eXBlLCBidWYgfSk7Cn0KCmNvbnN0IHNlcnZlciA9IGh0dHAuY3JlYXRlU2VydmVyKChyZXEsIHJlcykgPT4gewogIGNvcnMocmVzKTsKICBpZiAocmVxLm1ldGhvZCA9PT0gJ09QVElPTlMnKSB7IHJlcy53cml0ZUhlYWQoMjA0KTsgcmVzLmVuZCgpOyByZXR1cm47IH0KICBjb25zdCB1ID0gbmV3IFVSTChyZXEudXJsIHx8ICcvJywgJ2h0dHA6Ly8xMjcuMC4wLjEnKTsKICBpZiAodS5wYXRobmFtZSA9PT0gJy9oZWFsdGgnKSB7CiAgICByZXR1cm4gc2VuZEpzb24ocmVzLCAyMDAsIHsgb2s6IHRydWUsIHNlcnZpY2U6ICdsaW5rLW1ldGEnLCBwb3J0OiBQT1JUIH0pOwogIH0KICBpZiAodS5wYXRobmFtZSA9PT0gJy9pbWcnKSB7CiAgICBjb25zdCB0YXJnZXQgPSB1LnNlYXJjaFBhcmFtcy5nZXQoJ3VybCcpIHx8ICcnOwogICAgaWYgKCEvXmh0dHBzPzpcL1wvL2kudGVzdCh0YXJnZXQpKSByZXR1cm4gc2VuZEpzb24ocmVzLCA0MDAsIHsgb2s6IGZhbHNlLCBlcnJvcjogJ21pc3Npbmcgb3IgaW52YWxpZCB1cmwnIH0pOwogICAgY29uc3QgY2FjaGVkID0gY2FjaGVHZXQodGFyZ2V0KTsKICAgIGlmIChjYWNoZWQpIHsKICAgICAgcmVzLndyaXRlSGVhZCgyMDAsIHsgJ0NvbnRlbnQtVHlwZSc6IGNhY2hlZC50eXBlLCAnQ2FjaGUtQ29udHJvbCc6ICdwdWJsaWMsIG1heC1hZ2U9NjAwJywgJ0NvbnRlbnQtTGVuZ3RoJzogY2FjaGVkLmJ1Zi5sZW5ndGggfSk7CiAgICAgIHJldHVybiByZXMuZW5kKGNhY2hlZC5idWYpOwogICAgfQogICAgcmV0dXJuIGZldGNoSW1hZ2UodGFyZ2V0KS50aGVuKChyKSA9PiB7CiAgICAgIGNhY2hlU2V0KHRhcmdldCwgci50eXBlLCByLmJ1Zik7CiAgICAgIHJlcy53cml0ZUhlYWQoMjAwLCB7ICdDb250ZW50LVR5cGUnOiByLnR5cGUsICdDYWNoZS1Db250cm9sJzogJ3B1YmxpYywgbWF4LWFnZT02MDAnLCAnQ29udGVudC1MZW5ndGgnOiByLmJ1Zi5sZW5ndGggfSk7CiAgICAgIHJlcy5lbmQoci5idWYpOwogICAgfSkuY2F0Y2goKGUpID0+IHNlbmRKc29uKHJlcywgNTAyLCB7IG9rOiBmYWxzZSwgZXJyb3I6IGUubWVzc2FnZSB8fCAnaW1hZ2UgZmV0Y2ggZmFpbGVkJyB9KSk7CiAgfQogIGlmICh1LnBhdGhuYW1lID09PSAnL3JhdycpIHsKICAgIC8vIOWOn+Wni+mhtemdouS7o+eQhu+8mue7meW3peS9nOWPsCBmZXRjaF91cmwg5YGa44CM5oqT5q2j5paH44CN5YWc5bqV77yI6L+U5Zue5a6M5pW0IEhUTUzvvIzogIzpnZ7op6PmnpDlkI7nmoQgbWV0Ye+8iQogICAgY29uc3QgdGFyZ2V0ID0gdS5zZWFyY2hQYXJhbXMuZ2V0KCd1cmwnKSB8fCAnJzsKICAgIGlmICghL15odHRwcz86XC9cLy9pLnRlc3QodGFyZ2V0KSkgcmV0dXJuIHNlbmRKc29uKHJlcywgNDAwLCB7IG9rOiBmYWxzZSwgZXJyb3I6ICdtaXNzaW5nIG9yIGludmFsaWQgdXJsJyB9KTsKICAgIHJldHVybiBmZXRjaEZvbGxvdyh0YXJnZXQpLnRoZW4oKHIpID0+IHsKICAgICAgcmVzLndyaXRlSGVhZCgyMDAsIHsgJ0NvbnRlbnQtVHlwZSc6ICd0ZXh0L2h0bWw7IGNoYXJzZXQ9dXRmLTgnIH0pOwogICAgICByZXMuZW5kKHIuYm9keSB8fCAnJyk7CiAgICB9KS5jYXRjaCgoZSkgPT4gc2VuZEpzb24ocmVzLCA1MDIsIHsgb2s6IGZhbHNlLCBlcnJvcjogZS5tZXNzYWdlIHx8ICdmZXRjaCBmYWlsZWQnIH0pKTsKICB9CiAgaWYgKHUucGF0aG5hbWUgIT09ICcvbWV0YScpIHsKICAgIHJldHVybiBzZW5kSnNvbihyZXMsIDQwNCwgeyBvazogZmFsc2UsIGVycm9yOiAnbm90IGZvdW5kJywgdXNhZ2U6ICcvbWV0YT91cmw9aHR0cHM6Ly94aHNsaW5rLmNuL28veHh4eCcgfSk7CiAgfQogIGNvbnN0IHRhcmdldCA9IHUuc2VhcmNoUGFyYW1zLmdldCgndXJsJykgfHwgJyc7CiAgaWYgKCEvXmh0dHBzPzpcL1wvL2kudGVzdCh0YXJnZXQpKSB7CiAgICByZXR1cm4gc2VuZEpzb24ocmVzLCA0MDAsIHsgb2s6IGZhbHNlLCBlcnJvcjogJ21pc3Npbmcgb3IgaW52YWxpZCB1cmwnIH0pOwogIH0KICBidWlsZE1ldGEodGFyZ2V0KS50aGVuKChtZXRhKSA9PiBzZW5kSnNvbihyZXMsIDIwMCwgbWV0YSkpLmNhdGNoKChlKSA9PiB7CiAgICBzZW5kSnNvbihyZXMsIDIwMCwgeyBvazogZmFsc2UsIGVycm9yOiBlLm1lc3NhZ2UgfHwgJ2ZldGNoIGZhaWxlZCcsIGZpbmFsVXJsOiB0YXJnZXQsIHNpdGU6IHNpdGVPZih0YXJnZXQpIH0pOwogIH0pOwp9KTsKCnNlcnZlci5saXN0ZW4oUE9SVCwgJzEyNy4wLjAuMScsICgpID0+IHsKICBjb25zb2xlLmxvZygnW2xpbmstbWV0YV0gbGlzdGVuaW5nIG9uIGh0dHA6Ly8xMjcuMC4wLjE6JyArIFBPUlQpOwp9KTsK";
  function getLinkMetaSource() {
    try { return decodeURIComponent(escape(atob(LINK_META_SOURCE_B64))); } catch (e) { return ""; }
  }

  // wechat-claw.sh 同样以 Base64 内嵌：它是 bash 脚本，含 $ / ` / \ 等字符，
  // 直接放进模板字符串会被转义破坏，Base64 最稳（与 link-meta 同一套做法）。
  var WECHAT_CLAW_SOURCE_B64 = "IyEvZGF0YS9kYXRhL2NvbS50ZXJtdXgvZmlsZXMvdXNyL2Jpbi9iYXNoCiMgPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09CiMg5Y+Z5LqL6K+X5bCP5omL5py6IC0g5b6u5L+hIENsYXcg5o6l5YWl77yI5YaF572u6ISa5pysNe+8iQojIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLQojIOW5suS7gOS5iO+8muWcqOS9oOiHquW3seeahOaJi+acuuS4iui3keS4gOS4qiBPcGVuQ2xhd++8jOW5tumAmui/h+iFvuiur+WumOaWueeahAojICAgICAgICDjgIzlvq7kv6EgQ2xhd0JvdOOAjeaPkuS7tuaKiuWug+aOpeaIkOW+ruS/oemHjOeahOS4gOS4quiBlOezu+S6uuOAggojCiMg5Li65LuA5LmI55So6L+Z5p2h6Lev77yI6ICM5LiN5piv5peg6Zqc56KN77yJ77yaCiMgICAtIENsYXdCb3Qg5piv6IW+6K6v5a6Y5pa55o+S5Lu277yM6LWw5q2j6KeE5o+S5Lu25L2T57O777yM5LiN6Ieq5Yqo5YyW5L2g55qE5b6u5L+h6LSm5Y+377ybCiMgICAtIOWboOatpOWHoOS5juayoeaciemjjuaOpy/lsIHlj7fpo47pmanvvJsKIyAgIC0g5Luj5Lu377ya5a6D5Y+q5piv44CM5L2gIOKGlCDkvaDoh6rlt7HnmoQgQUnjgI3ov5nkuIDmnaHpgJrpgZPvvIwKIyAgICAg5LiN6IO96K6pIGNoYXIg5Lul5L2g55qE6Lqr5Lu95Y676Lef5Yir5Lq66IGK5aSp77yI6YKj5piv5peg6Zqc56KN5pa55qGI55qE6IO95Yqb77yJ44CCCiMKIyDliY3mj5DvvJoKIyAgIDEpIOW+ruS/oSBpT1MvQW5kcm9pZCDpnIAgPj0gOC4wLjcw77yM5LiU5bey54Gw5bqm5YiwIENsYXdCb3Qg5o+S5Lu2CiMgICAgICDvvIjlvq7kv6Eg4oaSIOaIkSDihpIg6K6+572uIOKGkiDmj5Lku7bvvIznnIvmnInmsqHmnInjgIzlvq7kv6EgQ2xhd0JvdOOAje+8iQojICAgMikgTm9kZS5qcyA+PSAyMu+8iOacrOiEmuacrOS8muiHquWKqOajgOa1i+W5tuaPkOekuuWuieijhe+8iQojCiMg55So5rOV77yI5Lmf5Y+v55SxIHh2c2hpc2hpIOacjeWKoeeuoeeQhuWZqOe7n+S4gOWQr+WBnO+8ie+8mgojICAgYmFzaCB3ZWNoYXQtY2xhdy5zaCBjaGVjayAgICAgICMg546v5aKD6Ieq5qOA77yaTm9kZSDniYjmnKwgLyDlvq7kv6Hmj5Lku7bliY3mj5AgLyDlt7Loo4XmsqHoo4UKIyAgIGJhc2ggd2VjaGF0LWNsYXcuc2ggaW5zdGFsbCAgICAjIOWuieijheW+ruS/oSBDaGFubmVsIOaPkuS7tu+8iOS8muiHquWKqOiwg+i1t+WumOaWueWuieijheWRveS7pO+8iQojICAgYmFzaCB3ZWNoYXQtY2xhdy5zaCBsb2dpbiAgICAgICMg6YeN5paw55Sf5oiQ57uR5a6a5LqM57u056CB77yI5o2i5Y+3L+aOiee6v+aXtueUqO+8iQojICAgYmFzaCB3ZWNoYXQtY2xhdy5zaCBydW4gICAgICAgICMg5YmN5Y+w6L+Q6KGMIE9wZW5DbGF3IOe9keWFs++8iOiwg+ivleeUqO+8jEN0cmwrQyDpgIDlh7rvvIkKIyAgIGJhc2ggd2VjaGF0LWNsYXcuc2ggc3RhcnQgICAgICAjIOWQjuWPsOW4uOmpu+i/kOihjO+8iOiHquW4piB0ZXJtdXgtd2FrZS1sb2NrIOS/nea0u++8iQojICAgYmFzaCB3ZWNoYXQtY2xhdy5zaCBzdG9wCiMgICBiYXNoIHdlY2hhdC1jbGF3LnNoIHN0YXR1cwojICAgYmFzaCB3ZWNoYXQtY2xhdy5zaCBsb2dzCiMgPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09CgpzZXQgLW8gcGlwZWZhaWwKClhTSF9ESVI9IiR7WFNIX0RJUjotJEhPTUUvLnh2c2hpc2hpfSIKTE9HX0RJUj0iJFhTSF9ESVIvbG9ncyIKUElEX0RJUj0iJFhTSF9ESVIvcGlkcyIKbWtkaXIgLXAgIiRMT0dfRElSIiAiJFBJRF9ESVIiICIkWFNIX0RJUi93ZWNoYXQtY2xhdyIKCkxPR19GSUxFPSIkTE9HX0RJUi93ZWNoYXQtY2xhdy5sb2ciClBJRF9GSUxFPSIkUElEX0RJUi93ZWNoYXQtY2xhdy5waWQiCldBS0VfTE9DS19GSUxFPSIkWFNIX0RJUi93ZWNoYXQtY2xhdy8ud2FrZS1sb2NrIgoKQ19HPSJcMDMzWzMybSI7IENfUj0iXDAzM1szMW0iOyBDX1k9IlwwMzNbMzNtIjsgQ19CPSJcMDMzWzM0bSI7IENfRElNPSJcMDMzWzJtIjsgQ19CT0xEPSJcMDMzWzFtIjsgQ19FTkQ9IlwwMzNbMG0iCmxvZygpIHsgZWNobyAtZSAiJCoiOyB9CgojIOWumOaWueWuieijheWRveS7pO+8mueUseW+ruS/oeOAjENsYXdCb3TjgI3mj5Lku7bor6bmg4XpobXnu5nlh7rvvIzov5nph4znlKjlroPlkIzmupDnmoQgQ0xJIOWMheWQjeOAggojIOiLpeiFvuiur+iwg+aVtOS6huWMheWQjS/lkb3ku6TvvIzku6Xmj5Lku7bor6bmg4XpobXmmL7npLrnmoTkuLrlh4bvvIzmnKzohJrmnKznmoQgaW5zdGFsbCDkvJrmj5DnpLrkvaDku6XpobXpnaLkuLrlh4bjgIIKT0ZGSUNJQUxfQ0xJX1BLRz0iQHRlbmNlbnQtd2VpeGluL29wZW5jbGF3LXdlaXhpbi1jbGlAbGF0ZXN0IgoKbmVlZF9ub2RlKCkgewogIGlmICEgY29tbWFuZCAtdiBub2RlID4vZGV2L251bGwgMj4mMTsgdGhlbgogICAgbG9nICIke0NfUn1beF0ke0NfRU5EfSDmsqHmib7liLAgbm9kZeOAguivt+WFiOWcqCBUZXJtdXgg5omn6KGM77yaIHBrZyBpbnN0YWxsIC15IG5vZGVqcy1sdHMiCiAgICByZXR1cm4gMQogIGZpCiAgbG9jYWwgbWFqb3IKICBtYWpvcj0kKG5vZGUgLXAgJ3Byb2Nlc3MudmVyc2lvbnMubm9kZS5zcGxpdCgiLiIpWzBdJyAyPi9kZXYvbnVsbCB8IHRyIC1kICdbOnNwYWNlOl0nKQogICMg5b+F6aG755yf55qE5piv5Liq5pWw5a2X5omN5pWi5q+U6L6D77ya5ZCm5YiZIGBbICJ4eCIgLWx0IDIyIF1gIOS8muaKpSBpbnRlZ2VyIGV4cHJlc3Npb24gZXhwZWN0ZWQKICAjIOW5tuS4lOOAjOS4jea7oei2s+OAjeS8muiiq+W9k+aIkOOAjOa7oei2s+OAje+8jOebtOaOpeaUvui/h+WOuyDigJTigJQg6YKj5piv5pyA5Z2P55qE5oOF5Ya177yI5ZCO6Z2iIG5weCDmiY3ngrjvvInjgIIKICBjYXNlICIkbWFqb3IiIGluCiAgICAnJ3wqWyEwLTldKikKICAgICAgbG9nICIke0NfUn1beF0ke0NfRU5EfSDor7vkuI3liLAgbm9kZSDkuLvniYjmnKzlj7fvvIhub2RlIC1wIOayoei/lOWbnuaVsOWtl++8ieOAgiIKICAgICAgbG9nICIgICAgICAgIOivt+ehruiupCBub2RlIOijheWlveS6hu+8miBub2RlIC12IgogICAgICByZXR1cm4gMQogICAgICA7OwogIGVzYWMKICBpZiBbICIkbWFqb3IiIC1sdCAyMiBdOyB0aGVuCiAgICBsb2cgIiR7Q19ZfVshXSR7Q19FTkR9IOW9k+WJjSBOb2RlIOeJiOacrOaYryAkKG5vZGUgLXYp77yMQ2xhd0JvdCDpnIDopoEgPj0gMjLjgIIiCiAgICBsb2cgIiAgICAgICAg6K+35Y2H57qn77yaIHBrZyBpbnN0YWxsIC15IG5vZGVqcy1sdHMgICDvvIjmiJYgcGtnIHVwZ3JhZGUgbm9kZWpzLWx0c++8iSIKICAgIHJldHVybiAxCiAgZmkKICBsb2cgIiR7Q19HfVvinJNdJHtDX0VORH0gTm9kZSDniYjmnKwgJChub2RlIC12KSDmu6HotrPopoHmsYIiCiAgcmV0dXJuIDAKfQoKY21kX2NoZWNrKCkgewogIGxvZyAiIgogIGxvZyAiJHtDX0JPTER95b6u5L+hIENsYXcg5o6l5YWlIMK3IOeOr+Wig+iHquajgCR7Q19FTkR9IgogIGxvZyAiLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tIgogIG5lZWRfbm9kZSB8fCB0cnVlCgogIGxvZyAiIgogIGxvZyAiJHtDX0JPTER95b6u5L+h5L6n5YmN5o+Q77yI6ZyA6KaB5L2g5omL5Yqo56Gu6K6k77yM6ISa5pys6K+75LiN5Yiw5b6u5L+h5o+S5Lu25YiX6KGo77yJJHtDX0VORH0iCiAgbG9nICIgIDEuIOW+ruS/oeeJiOacrOmcgCA+PSA4LjAuNzAiCiAgbG9nICIgIDIuIOaJk+W8gOW+ruS/oe+8miDmiJEg4oaSIOiuvue9riDihpIg5o+S5Lu2IgogIGxvZyAiICAzLiDnnIvliJfooajph4zmnInmsqHmnIkgJHtDX0JPTER944CM5b6u5L+hIENsYXdCb3TjgI0ke0NfRU5EfSIKICBsb2cgIiAgICAgJHtDX0RJTX3lpoLmnpzmsqHmnInvvJrmiorlvq7kv6Hku47lkI7lj7DlvbvlupXmnYDmjonph43lvIDlho3nnIvkuIDmrKHvvJvku43msqHmnInlsLHmmK/ov5jmsqHngbDluqbliLDkvaDvvIzlj6rog73nrYnjgIIke0NfRU5EfSIKCiAgbG9nICIiCiAgbG9nICIke0NfQk9MRH3mnKzmnLrnirbmgIEke0NfRU5EfSIKICBpZiBjb21tYW5kIC12IG9wZW5jbGF3ID4vZGV2L251bGwgMj4mMTsgdGhlbgogICAgbG9nICIgICR7Q19HfeKXjyR7Q19FTkR9IOW3suaJvuWIsCBvcGVuY2xhdyDlkb3ku6QiCiAgZWxzZQogICAgbG9nICIgICR7Q19ESU194peLJHtDX0VORH0g6L+Y5rKh6KOFIE9wZW5DbGF3IOeahOW+ruS/oeaPkuS7tu+8iOWFiOi3kSBpbnN0YWxs77yJIgogIGZpCiAgaWYgWyAtZiAiJFBJRF9GSUxFIiBdICYmIGtpbGwgLTAgIiQoY2F0ICIkUElEX0ZJTEUiIDI+L2Rldi9udWxsKSIgMj4vZGV2L251bGw7IHRoZW4KICAgIGxvZyAiICAke0NfR33il48ke0NfRU5EfSDlkI7lj7DnvZHlhbPov5DooYzkuK3vvIhQSUQgJChjYXQgIiRQSURfRklMRSIp77yJIgogIGVsc2UKICAgIGxvZyAiICAke0NfRElNfeKXiyR7Q19FTkR9IOWQjuWPsOe9keWFs+acqui/kOihjCIKICBmaQogIGxvZyAiICDmlbDmja7nm67lvZXvvJokWFNIX0RJUi93ZWNoYXQtY2xhdyIKICBsb2cgIiAg5pel5b+X77yaJExPR19GSUxFIgogIGxvZyAiLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tIgogIGxvZyAiIgp9CgpjbWRfaW5zdGFsbCgpIHsKICBuZWVkX25vZGUgfHwgcmV0dXJuIDEKICBsb2cgIiIKICBsb2cgIiR7Q19CT0xEfeWuieijheW+ruS/oSBDbGF3Qm90IOaPkuS7tiR7Q19FTkR9IgogIGxvZyAi5Y2z5bCG5omn6KGM5a6Y5pa5IENMSe+8miIKICBsb2cgIiAgJHtDX0RJTX1ucHggLXkgJE9GRklDSUFMX0NMSV9QS0cgaW5zdGFsbCR7Q19FTkR9IgogIGxvZyAiIgogIGxvZyAiJHtDX1l9WyFdJHtDX0VORH0g6Iul5LiL6Z2i5oql6ZSZ44CB5oiW5o+Q56S65ZG95Luk5LiN5a2Y5Zyo77yM6K+35LulJHtDX0JPTER95b6u5L+h6YeM44CMQ2xhd0JvdCDmj5Lku7bor6bmg4XpobXjgI3mmL7npLrnmoTlronoo4Xlkb3ku6TkuLrlh4Yke0NfRU5EfSIKICBsb2cgIiAgICAg77yI6IW+6K6v5Y+v6IO95Lya6LCD5pW05YyF5ZCN5oiW5ZG95Luk5b2i5byP77yM5o+S5Lu26aG157uZ5Ye655qE5oC75piv5a+555qE77yJIgogIGxvZyAiIgogIHByaW50ZiAi57un57ut5ZCX77yfW3kvTl0gIgogIHJlYWQgLXIgYW5zCiAgY2FzZSAiJGFucyIgaW4KICAgIHl8WXx5ZXN8WUVTKSA7OwogICAgKikgbG9nICLlt7Llj5bmtogiOyByZXR1cm4gMDs7CiAgZXNhYwogICggY2QgIiRYU0hfRElSL3dlY2hhdC1jbGF3IiAmJiBucHggLXkgIiRPRkZJQ0lBTF9DTElfUEtHIiBpbnN0YWxsICkgMj4mMSB8IHRlZSAtYSAiJExPR19GSUxFIgogIGxvY2FsIHJjPSR7UElQRVNUQVRVU1swXX0KICBsb2cgIiIKICBpZiBbICIkcmMiIC1lcSAwIF07IHRoZW4KICAgIGxvZyAiJHtDX0d9W+Kck10ke0NfRU5EfSDlronoo4XmtYHnqIvnu5PmnZ/jgILoi6Xnu4jnq6/mmL7npLrkuobkuoznu7TnoIHvvJoiCiAgICBsb2cgIiAgICDmiZPlvIDlvq7kv6Eg4oaSIOaIkSDihpIg6K6+572uIOKGkiDmj5Lku7Yg4oaSIOW+ruS/oSBDbGF3Qm90IOKGkiDmiavkuIDmiavvvIzmiavnoIHlkI7ngrnnu7/oibLjgIzov57mjqXjgI3jgIIiCiAgICBsb2cgIiAgICDov57kuIrlkI7lvq7kv6Hph4zkvJrlh7rnjrDjgIzlvq7kv6EgQ2xhd0JvdOOAjeeahOWvueivneWFpeWPo++8iOWPr+iDveS4jeWcqOWIl+ihqOmHjO+8jOmcgOimgeaQnOe0ou+8ieOAgiIKICBlbHNlCiAgICBsb2cgIiR7Q19SfVt4XSR7Q19FTkR9IOWuieijheWRveS7pOi/lOWbnueggSAkcmPvvIzor7fmiorkuIrpnaLnmoTovpPlh7rlj5Hnu5nlvIDlj5HogIXvvIzmiJbku6Xmj5Lku7bor6bmg4XpobXnmoTlkb3ku6TkuLrlh4bph43or5XjgIIiCiAgZmkKfQoKY21kX2xvZ2luKCkgewogIG5lZWRfbm9kZSB8fCByZXR1cm4gMQogIGxvZyAiJHtDX0J9WypdJHtDX0VORH0g6YeN5paw55Sf5oiQ57uR5a6a5LqM57u056CBIC4uLiIKICAoIGNkICIkWFNIX0RJUi93ZWNoYXQtY2xhdyIgJiYgbnB4IC15ICIkT0ZGSUNJQUxfQ0xJX1BLRyIgbG9naW4gKSAyPiYxIHwgdGVlIC1hICIkTE9HX0ZJTEUiCn0KCiMg5Y+W5ZCO5Y+w6L+b56iL5a2Y5rS754q25oCBCnJ1bm5pbmdfcGlkKCkgewogIFsgLWYgIiRQSURfRklMRSIgXSB8fCByZXR1cm4gMQogIGxvY2FsIHAKICBwPSQoY2F0ICIkUElEX0ZJTEUiIDI+L2Rldi9udWxsIHwgdHIgLWQgJyAnKQogIFsgLW4gIiRwIiBdICYmIGtpbGwgLTAgIiRwIiAyPi9kZXYvbnVsbCAmJiBlY2hvICIkcCIKfQoKd2FrZV9sb2NrX29uKCkgewogICMg5a6J5Y2T5Lya5oqKIFRlcm11eCDov5vnqIvlhrvnu5Mv5Zue5pS277yM6ZW/6am75b+F6aG75oyBIHdha2UgbG9ja++8m+iusOW9leS4gOS4i+S7peS+vyBzdG9wIOaXtumHiuaUvgogIGlmIGNvbW1hbmQgLXYgdGVybXV4LXdha2UtbG9jayA+L2Rldi9udWxsIDI+JjE7IHRoZW4KICAgIHRlcm11eC13YWtlLWxvY2sgMj4vZGV2L251bGwgJiYgdG91Y2ggIiRXQUtFX0xPQ0tfRklMRSIgJiYgbG9nICIke0NfR31b4pyTXSR7Q19FTkR9IOW3sueUs+ivtyBUZXJtdXgg5ZSk6YaS6ZSB77yI6Ziy5q2i6KKr57O757uf5Ya757uT77yJIgogIGVsc2UKICAgIGxvZyAiJHtDX1l9WyFdJHtDX0VORH0g5rKh5pyJIHRlcm11eC13YWtlLWxvY2vvvIzlkI7lj7Dlj6/og73ooqvns7vnu5/lhrvnu5PjgILlu7rorq4gcGtnIGluc3RhbGwgLXkgdGVybXV4LWFwaSIKICBmaQp9Cgp3YWtlX2xvY2tfb2ZmKCkgewogIGlmIFsgLWYgIiRXQUtFX0xPQ0tfRklMRSIgXSAmJiBjb21tYW5kIC12IHRlcm11eC13YWtlLXVubG9jayA+L2Rldi9udWxsIDI+JjE7IHRoZW4KICAgIHRlcm11eC13YWtlLXVubG9jayAyPi9kZXYvbnVsbAogICAgcm0gLWYgIiRXQUtFX0xPQ0tfRklMRSIKICBmaQp9CgpjbWRfcnVuKCkgewogIG5lZWRfbm9kZSB8fCByZXR1cm4gMQogIGxvY2FsIGJpbj0iIgogIGlmIGNvbW1hbmQgLXYgb3BlbmNsYXcgPi9kZXYvbnVsbCAyPiYxOyB0aGVuCiAgICBiaW49Im9wZW5jbGF3IgogIGZpCiAgaWYgWyAteiAiJGJpbiIgXTsgdGhlbgogICAgbG9nICIke0NfUn1beF0ke0NfRU5EfSDov5jmsqHmib7liLAgb3BlbmNsYXcg5ZG95Luk77yM6K+35YWI6L+Q6KGM77yaIGJhc2ggJDAgaW5zdGFsbCIKICAgIHJldHVybiAxCiAgZmkKICB3YWtlX2xvY2tfb24KICBsb2cgIiR7Q19CfVsqXSR7Q19FTkR9IOWJjeWPsOWQr+WKqCBPcGVuQ2xhdyDnvZHlhbPvvIhDdHJsK0Mg6YCA5Ye677yJLi4uIgogICggY2QgIiRYU0hfRElSL3dlY2hhdC1jbGF3IiAmJiAiJGJpbiIgKSAyPiYxIHwgdGVlIC1hICIkTE9HX0ZJTEUiCn0KCmNtZF9zdGFydCgpIHsKICBpZiBbIC1uICIkKHJ1bm5pbmdfcGlkKSIgXTsgdGhlbgogICAgbG9nICIke0NfWX1bIV0ke0NfRU5EfSDlt7LlnKjov5DooYzvvIhQSUQgJChydW5uaW5nX3BpZCnvvIkiCiAgICByZXR1cm4gMAogIGZpCiAgbG9jYWwgYmluPSIiCiAgY29tbWFuZCAtdiBvcGVuY2xhdyA+L2Rldi9udWxsIDI+JjEgJiYgYmluPSJvcGVuY2xhdyIKICBpZiBbIC16ICIkYmluIiBdOyB0aGVuCiAgICBsb2cgIiR7Q19SfVt4XSR7Q19FTkR9IOaJvuS4jeWIsCBvcGVuY2xhdyDlkb3ku6TvvIzor7flhYjov5DooYzvvJogYmFzaCAkMCBpbnN0YWxsIgogICAgcmV0dXJuIDEKICBmaQogIHdha2VfbG9ja19vbgogIGxvZyAiJHtDX0J9WypdJHtDX0VORH0g5ZCO5Y+w5ZCv5YqoIE9wZW5DbGF3IOe9keWFsyAuLi4iCiAgKCBjZCAiJFhTSF9ESVIvd2VjaGF0LWNsYXciICYmIG5vaHVwICIkYmluIiA+PiAiJExPR19GSUxFIiAyPiYxICYgZWNobyAkISA+ICIkUElEX0ZJTEUiICkKICBzbGVlcCAyCiAgbG9jYWwgcAogIHA9JChydW5uaW5nX3BpZCkKICBpZiBbIC1uICIkcCIgXTsgdGhlbgogICAgbG9nICIke0NfR31b4pyTXSR7Q19FTkR9IOW3suWQr+WKqO+8iFBJRCAkcO+8ie+8jOaXpeW/l++8miRMT0dfRklMRSIKICBlbHNlCiAgICBsb2cgIiR7Q19SfVt4XSR7Q19FTkR9IOWQr+WKqOWksei0pe+8jOacgOi/keaXpeW/l++8miIKICAgIHRhaWwgLTE1ICIkTE9HX0ZJTEUiIDI+L2Rldi9udWxsIHwgc2VkICdzL14vICAgIC8nCiAgICBsb2cgIiAgICDluLjop4Hljp/lm6DvvJrov5jmsqEgaW5zdGFsbCAvIE5vZGUg54mI5pys5LiN5aSfIC8g572R5YWz6YWN572u57y65aSxIgogIGZpCn0KCmNtZF9zdG9wKCkgewogIGxvY2FsIHAKICBwPSQocnVubmluZ19waWQpCiAgaWYgWyAtbiAiJHAiIF07IHRoZW4KICAgIGtpbGwgIiRwIiAyPi9kZXYvbnVsbAogICAgc2xlZXAgMQogICAga2lsbCAtOSAiJHAiIDI+L2Rldi9udWxsCiAgICBybSAtZiAiJFBJRF9GSUxFIgogICAgbG9nICIke0NfR31b4pyTXSR7Q19FTkR9IOW3suWBnOatou+8iFBJRCAkcO+8iSIKICBlbHNlCiAgICBsb2cgIiR7Q19ZfVshXSR7Q19FTkR9IOacrOadpeWwseayoeWcqOi3kSIKICBmaQogICMg5YWc5bqV5riF55CG5q6L55WZ55qEIG9wZW5jbGF3IOi/m+eoi++8iOWPquWMuemFjeWPr+aJp+ihjOWQje+8jOS4jeivr+S8pOWIq+eahCBub2Rl77yJCiAgcGtpbGwgLWYgIm9wZW5jbGF3IiAyPi9kZXYvbnVsbAogIHdha2VfbG9ja19vZmYKfQoKY21kX3N0YXR1cygpIHsKICBsb2NhbCBwCiAgcD0kKHJ1bm5pbmdfcGlkKQogIGlmIFsgLW4gIiRwIiBdOyB0aGVuCiAgICBsb2cgIiAgJHtDX0d94pePJHtDX0VORH0g5b6u5L+hIENsYXcg5o6l5YWlICDov5DooYzkuK0gKFBJRCAkcCkiCiAgZWxzZQogICAgbG9nICIgICR7Q19ESU194peLJHtDX0VORH0g5b6u5L+hIENsYXcg5o6l5YWlICDlt7LlgZzmraIiCiAgZmkKfQoKY21kX2xvZ3MoKSB7CiAgaWYgWyAtZiAiJExPR19GSUxFIiBdOyB0aGVuCiAgICB0YWlsIC00MCAiJExPR19GSUxFIgogIGVsc2UKICAgIGxvZyAi6L+Y5rKh5pyJ5pel5b+X77yIJExPR19GSUxF77yJIgogIGZpCn0KCmNhc2UgIiR7MTotY2hlY2t9IiBpbgogIGNoZWNrKSAgIGNtZF9jaGVjayA7OwogIGluc3RhbGwpIGNtZF9pbnN0YWxsIDs7CiAgbG9naW4pICAgY21kX2xvZ2luIDs7CiAgcnVuKSAgICAgY21kX3J1biA7OwogIHN0YXJ0KSAgIGNtZF9zdGFydCA7OwogIHN0b3ApICAgIGNtZF9zdG9wIDs7CiAgc3RhdHVzKSAgY21kX3N0YXR1cyA7OwogIGxvZ3MpICAgIGNtZF9sb2dzIDs7CiAgKikgICAgICAgbG9nICLnlKjms5U6IGJhc2ggd2VjaGF0LWNsYXcuc2gge2NoZWNrfGluc3RhbGx8bG9naW58cnVufHN0YXJ0fHN0b3B8c3RhdHVzfGxvZ3N9IiA7Owplc2FjCg==";
  function getWechatClawSource() {
    try { return decodeURIComponent(escape(atob(WECHAT_CLAW_SOURCE_B64))); } catch (e) { return ""; }
  }

  var BUILTIN_SCRIPTS = [
    { id: "ncm-api", name: "网易云音乐 API", desc: "网易云登录代理 / 歌单同步 / 歌词搜索（端口 3000）", port: 3000, healthUrl: "http://localhost:3000/search?keywords=test&limit=1", termuxCmd: "NeteaseCloudMusicApi -p 3000", fileContent: "", isBuiltin: true },
    { id: "cors-proxy", name: "CORS 跨域中转", desc: "为 PWA/网页版打破跨域限制，代理任意 HTTP/HTTPS 请求（端口 3001）", port: 3001, healthUrl: "http://localhost:3001/health", termuxCmd: "node $HOME/.xvshishi/cors-proxy.js", fileContent: CORS_PROXY_SOURCE, isBuiltin: true },
    { id: "cmd-runner", name: "AI 命令执行服务（工作台）", desc: "工作台 Agent 执行 termux 命令 / 自写脚本 / git 仓库操作（端口 3002）", port: 3002, healthUrl: "http://localhost:3002/health", termuxCmd: "node $HOME/.xvshishi/cmd-runner.js", fileContent: CMD_RUNNER_SOURCE, isBuiltin: true },
    { id: "link-meta", name: "分享链接解析服务", desc: "解析小红书/B站等分享链接的标题/封面/摘要，供聊天分享卡片使用（端口 3003）", port: 3003, healthUrl: "http://localhost:3003/health", termuxCmd: "node $HOME/.xvshishi/link-meta.js", fileContent: getLinkMetaSource(), isBuiltin: true },
    // 微信 Claw 接入：不是 HTTP 服务（没有端口/健康检查），由 wechat-claw.sh 自己管启停
    { id: "wechat-claw", name: "微信 Claw 接入", desc: "用腾讯官方「微信 ClawBot」插件把 OpenClaw 接成微信里的联系人（非 HTTP 服务）", port: 0, healthUrl: "", termuxCmd: "bash $HOME/.xvshishi/wechat-claw.sh start", fileContent: getWechatClawSource(), isBuiltin: true }
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
              通过 Termux 在手机上运行本地脚本服务（网易云 API / CORS 跨域中转 / AI 命令执行服务 / 分享链接解析 / 微信 Claw 接入），App 通过 localhost 访问。
              部署引导命令已内置全部脚本内容，复制到 Termux 执行即可直接创建脚本文件，无需联网下载。
            </div>
          </div>
          <div class="form-actions" style="margin-bottom:14px;">
            <button id="btn-local-deploy-guide" class="btn btn-outline" style="flex:1;">部署引导（命令可一键复制）</button>
          </div>

          <!-- 微信 Claw 接入：与上面那几个 HTTP 服务不是一类东西，单独一张卡讲清楚 -->
          <div style="background:linear-gradient(135deg,#EAF6F3,#F3F9FC); border:1.5px solid #CDE9E3; border-radius:14px; padding:14px; margin-bottom:14px;">
            <div style="display:flex; align-items:center; gap:8px; margin-bottom:8px;">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="#2C6E63" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>
              </svg>
              <span style="font-size:13.5px; font-weight:800; color:#2C6E63;">微信 Claw 接入（官方插件）</span>
            </div>
            <div style="font-size:11.5px; line-height:1.75; color:#3D5A56;">
              用腾讯官方的<b>「微信 ClawBot」插件</b>，把你自己的 OpenClaw 接成微信里的一个联系人。
              <b>走官方插件体系，不用自动化你的微信账号，基本没有封号风险</b>；代价是它只能“你和自己的 AI”一对一聊，
              <b>不能让 char 代替你给微信好友发消息</b>（那种能力在「聊天 → 我的 → 微信接入」那条无障碍通道里）。
            </div>
            <div style="font-size:11px; line-height:1.7; color:#6B8A85; margin-top:6px;">
              前提：微信 ≥ 8.0.70 且已灰度到 ClawBot 插件（微信 → 我 → 设置 → 插件 里能看到）；Node ≥ 22。
            </div>
            <div style="display:flex; gap:8px; margin-top:10px;">
              <button id="btn-local-deploy-claw-guide" class="btn btn-primary" style="flex:1; font-size:12px;">查看接入步骤</button>
              <button id="btn-local-deploy-claw-export" class="btn btn-outline" style="flex:1; font-size:12px;">导出脚本到手机</button>
            </div>
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
      var btnClawGuide = document.getElementById("btn-local-deploy-claw-guide");
      if (btnClawGuide) btnClawGuide.onclick = function () { self.showClawGuide(); };
      var btnClawExport = document.getElementById("btn-local-deploy-claw-export");
      if (btnClawExport) btnClawExport.onclick = function () { self.exportScriptsToPhone(); };
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
      var trimSrc = function (s) { return String(s || "").replace(/^\n+/, "").replace(/\n+$/, ""); };
      L.push("mkdir -p ~/.xvshishi/data ~/.xvshishi/status ~/.xvshishi/logs ~/.xvshishi/pids");
      L.push("cat > ~/.xvshishi/cors-proxy.js <<'XSH_EOF'");
      L.push(trimSrc(CORS_PROXY_SOURCE));
      L.push("XSH_EOF");
      L.push("cat > ~/.xvshishi/cmd-runner.js <<'XSH_EOF'");
      L.push(trimSrc(CMD_RUNNER_SOURCE));
      L.push("XSH_EOF");
      L.push("cat > ~/.xvshishi/link-meta.js <<'XSH_EOF'");
      L.push(trimSrc(getLinkMetaSource()));
      L.push("XSH_EOF");
      L.push("cat > ~/.xvshishi/wechat-claw.sh <<'XSH_EOF'");
      L.push(trimSrc(getWechatClawSource()));
      L.push("XSH_EOF");
      L.push("cat > ~/.xvshishi/xvshishi-services.sh <<'XSH_EOF'");
      L.push(trimSrc(SERVICES_MANAGER_SOURCE));
      L.push("XSH_EOF");
      L.push("mkdir -p $PREFIX/bin");
      L.push("cat > $PREFIX/bin/xvshishi <<'XSH_EOF'");
      L.push(trimSrc(XSHISHI_LAUNCHER_SOURCE));
      L.push("XSH_EOF");
      L.push("chmod +x $PREFIX/bin/xvshishi");
      L.push("chmod +x ~/.xvshishi/xvshishi-services.sh");
      L.push("chmod +x ~/.xvshishi/wechat-claw.sh");
      L.push("pkg update -y");
      L.push("pkg install -y nodejs-lts");
      L.push("pkg install -y git");
      L.push("npm install -g NeteaseCloudMusicApi --registry=https://registry.npmmirror.com");
      L.push("bash ~/.xvshishi/xvshishi-services.sh tui");
      return L.join("\n");
    },

    // 导出内置脚本到手机公共存储（Download/Storypoem/xvshishi-scripts/），Termux 一条短命令即可安装
    exportScriptsToPhone: function () {
      var bridge = window.AndroidMCP;
      if (!bridge || typeof bridge.saveLocalDeployScript !== "function") {
        showToastSafe("当前环境不支持导出，请在 APK 内使用");
        return;
      }
      var files = [
        ["cors-proxy.js", CORS_PROXY_SOURCE],
        ["cmd-runner.js", CMD_RUNNER_SOURCE],
        ["link-meta.js", getLinkMetaSource()],
        ["wechat-claw.sh", getWechatClawSource()],
        ["xvshishi-services.sh", SERVICES_MANAGER_SOURCE],
        ["xvshishi", XSHISHI_LAUNCHER_SOURCE]
      ];
      var ok = 0, err = "";
      files.forEach(function (f) {
        try {
          var body = String(f[1] || "").replace(/^\n+/, "").replace(/\n+$/, "");
          var r = JSON.parse(bridge.saveLocalDeployScript(f[0], body) || "{}");
          if (r && r.ok) ok++; else err = (r && r.error) || "未知错误";
        } catch (e) { err = e.message || String(e); }
      });
      var dir = "";
      try { dir = (JSON.parse(bridge.getLocalDeployScriptDir() || "{}") || {}).dir || ""; } catch (e) {}
      if (ok === files.length) {
        showToastSafe("已导出 " + ok + " 个脚本 → " + (dir || "Download/Storypoem/xvshishi-scripts"));
      } else {
        showToastSafe("导出成功 " + ok + "/" + files.length + " 个" + (err ? ("，失败原因：" + err) : ""));
      }
    },

    showGuide: function () {
      var overlay = document.getElementById("local-deploy-guide-overlay");
      var body = document.getElementById("local-deploy-guide-body");
      if (!overlay || !body) return;

      var steps = [
        { title: "第 1 步：安装 Termux", desc: "务必用 F-Droid 版（Play 版已停更）：https://f-droid.org/packages/com.termux/　首次使用请先执行一次 termux-setup-storage 授权存储（否则读不到手机 Download 目录）", cmd: "termux-setup-storage" },
        { title: "第 2 步（推荐）：导出脚本到手机存储", desc: "先点下面的『导出脚本到手机存储』按钮（App 会把 6 个脚本直接写进手机 Download/Storypoem/xvshishi-scripts/，不经过剪贴板，绝不会被截断），然后在 Termux 执行这条短命令安装：", cmd: "mkdir -p ~/.xvshishi \"$PREFIX/bin\" && cp /sdcard/Download/Storypoem/xvshishi-scripts/* ~/.xvshishi/ && cp ~/.xvshishi/xvshishi \"$PREFIX/bin/xvshishi\" && chmod +x ~/.xvshishi/xvshishi-services.sh \"$PREFIX/bin/xvshishi\" && xvshishi" },
        { title: "第 2 步（备选）：一键长命令部署", desc: "若不想用导出方式，也可复制下面整条命令到 Termux 执行（内容较长，注意别被截断）：", cmd: this.buildDeployCommand() },
        { title: "第 3 步：启动服务", desc: "在服务管理器菜单按 [1] 启动全部；或分别执行（微信 Claw 接入是另一条路，先看上面那张卡，别盲目启动）：", cmd: "bash $HOME/.xvshishi/xvshishi-services.sh start ncm-api\nbash $HOME/.xvshishi/xvshishi-services.sh start cors-proxy\nbash $HOME/.xvshishi/xvshishi-services.sh start cmd-runner" },
        { title: "脚本缺失 / 启动失败时", desc: "若某服务提示找不到脚本（Cannot find module），执行这条短命令即可自动补齐：优先从手机存储复制，其次从仓库下载：", cmd: "xvshishi repair" },
        { title: "第 4 步：随时唤出脚本页面", desc: "退出 Termux 后再进入时，直接输入下面的命令即可再次进入脚本交互页面：", cmd: "xvshishi" },
        { title: "第 5 步：保活", desc: "安装 termux-api 并开启保活：", cmd: "pkg install termux-api && termux-wake-lock" },
        { title: "第 6 步：回到 App 使用", desc: "网易云登录弹窗的 API 地址填（网页版跨域中转为 3001 端口）：", cmd: "http://localhost:3000" }
      ];

      var html = '<div style="margin-bottom:12px; display:flex; flex-direction:column; gap:8px;">' +
        '<button class="btn btn-primary" style="width:100%;padding:10px 0;font-size:12px;" id="btn-export-scripts">📥 导出脚本到手机存储（推荐，防截断）</button>' +
        '<button class="btn btn-outline" style="width:100%;padding:8px 0;font-size:11px;" id="btn-check-services">🔎 自检本地服务（3001/3002/3003 是否在跑）</button>' +
        '<button class="btn btn-outline" style="width:100%;padding:8px 0;font-size:11px;" id="btn-copy-all-cmds">＋ 一键复制全部命令</button></div>';

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

      var btnExport = document.getElementById("btn-export-scripts");
      if (btnExport) {
        btnExport.onclick = function () { localDeploySystem.exportScriptsToPhone(); };
      }

      // 一键自检：3001/3002/3003 三个本地服务是否在运行
      var btnCheck = document.getElementById("btn-check-services");
      if (btnCheck) {
        btnCheck.onclick = async function () {
          var items = [["cors-proxy", 3001], ["cmd-runner", 3002], ["link-meta", 3003]];
          var lines = [];
          for (var i = 0; i < items.length; i++) {
            try {
              var r = await fetch("http://127.0.0.1:" + items[i][1] + "/health");
              var j = await r.json();
              lines.push(items[i][0] + ": " + (j && j.ok ? "运行中" : "异常"));
            } catch (e) { lines.push(items[i][0] + ": 未启动"); }
          }
          showToastSafe(lines.join(" · "));
        };
      }

      overlay.style.display = "flex";
    },

    hideGuide: function () {
      var overlay = document.getElementById("local-deploy-guide-overlay");
      if (overlay) overlay.style.display = "none";
    },

    // ============ 微信 Claw 接入：分步引导 ============
    // 复用部署引导那个弹层，只换内容。命令都可点击复制。
    showClawGuide: function () {
      var overlay = document.getElementById("local-deploy-guide-overlay");
      var body = document.getElementById("local-deploy-guide-body");
      if (!overlay || !body) return;

      var steps = [
        {
          title: "第 1 步：确认微信灰度到了 ClawBot 插件",
          desc: "微信版本需 ≥ 8.0.70。打开：我 → 设置 → 插件，看列表里有没有「微信 ClawBot」。没有的话把微信从后台彻底杀掉重开再看一次；仍然没有就是还没灰度到你，只能等（这一步脚本帮不上忙）。",
          cmd: ""
        },
        {
          title: "第 2 步：装 Node（≥ 22）",
          desc: "ClawBot 需要 Node 22 以上，先在 Termux 装好：",
          cmd: "pkg install -y nodejs-lts"
        },
        {
          title: "第 3 步：把脚本装进 Termux",
          desc: "先点上面那张卡的『导出脚本到手机』，再在 Termux 执行这条命令把它装到工作目录：",
          cmd: "mkdir -p ~/.xvshishi && cp /sdcard/Download/Storypoem/xvshishi-scripts/wechat-claw.sh ~/.xvshishi/ && chmod +x ~/.xvshishi/wechat-claw.sh && bash ~/.xvshishi/wechat-claw.sh check"
        },
        {
          title: "第 4 步：装微信 Channel 插件（关键）",
          desc: "打开微信 → 我 → 设置 → 插件 → 微信 ClawBot → 进插件详情页，页面上会给出官方安装命令（也可以直接复制命令）。把那条命令整条复制到 Termux 执行 —— 以插件页显示的命令为准，别用别处抄来的。装完终端会显示一个二维码。",
          cmd: ""
        },
        {
          title: "第 5 步：扫码绑定",
          desc: "回到微信 ClawBot 插件详情页 → 点「扫一扫」→ 扫 Termux 里那个二维码 → 弹出确认页后点绿色的「连接」。连上后微信里会出现「微信 ClawBot」的对话入口（有时不在聊天列表里，用微信搜索框搜「微信 ClawBot」能找到）。",
          cmd: ""
        },
        {
          title: "第 6 步：挂到后台常驻",
          desc: "绑好后让它后台跑着，并申请唤醒锁防止被系统冻结。之后在微信里给 ClawBot 发消息就是在跟你的 AI 对话：",
          cmd: "bash ~/.xvshishi/wechat-claw.sh start && bash ~/.xvshishi/wechat-claw.sh status"
        },
        {
          title: "掉线 / 换号了怎么办",
          desc: "重新出一张二维码再扫一次：",
          cmd: "bash ~/.xvshishi/wechat-claw.sh login"
        },
        {
          title: "出问题看日志",
          desc: "二维码、报错、网关输出都在日志里：",
          cmd: "bash ~/.xvshishi/wechat-claw.sh logs"
        }
      ];

      var html = '<div style="margin-bottom:12px; padding:10px; border-radius:10px; background:rgba(44,110,99,0.08); color:#2C6E63; font-size:11.5px; line-height:1.75;">' +
        '<b>先说清楚它能做什么</b><br>' +
        'ClawBot 是腾讯官方插件，走正规插件体系、不会自动化你的微信账号，所以基本没有封号风险。<br>' +
        '但它是<b>「你 ↔ 你自己的 AI」</b>这一条通道：你只能跟 ClawBot 这个联系人一对一聊，' +
        '<b>不能让 char 代替你给微信好友发消息</b>。想要后者，用「聊天 → 我的 → 微信接入」那条无障碍通道。' +
        '</div>';

      steps.forEach(function (step, i) {
        html += '<div style="margin-bottom:12px;">';
        html += '<b style="color:var(--text-primary);">' + esc(step.title) + '</b><br>';
        if (step.desc) html += '<span style="color:var(--text-secondary);">' + esc(step.desc) + '</span>';
        if (step.cmd) {
          html += '<br><code class="ld-cmd" data-idx="' + i + '" style="background:rgba(0,0,0,0.06);padding:6px 8px;border-radius:6px;display:inline-block;max-width:100%;overflow-x:auto;word-break:break-all;cursor:pointer;color:var(--text-primary);">' + esc(step.cmd) + '</code>';
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

      overlay.style.display = "flex";
    }
  };

  window.localDeploySystem = localDeploySystem;
})();
