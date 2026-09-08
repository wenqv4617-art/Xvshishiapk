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
  "cmd-runner|AI 命令执行服务|工作台 Agent 执行 termux 命令/git 仓库操作（端口 3002）|node \\$HOME/.xvshishi/cmd-runner.js|http://localhost:3002/health|kill"
  "link-meta|分享链接解析服务|解析小红书/B站等分享链接的标题/封面/摘要（端口 3003）|node \\$HOME/.xvshishi/link-meta.js|http://localhost:3003/health|kill"
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

builtin_remote() {
  case "$1" in
    cors-proxy) echo "$GITHUB_RAW/cors-proxy.js" ;;
    cmd-runner) echo "$GITHUB_RAW/cmd-runner.js" ;;
    *) echo "" ;;
  esac
}

builtin_script_file() {
  case "$1" in
    cors-proxy) echo "$HOME/.xvshishi/cors-proxy.js" ;;
    cmd-runner) echo "$HOME/.xvshishi/cmd-runner.js" ;;
    link-meta) echo "$HOME/.xvshishi/link-meta.js" ;;
    *) echo "" ;;
  esac
}

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

repair_all() {
  log ""
  log "\${C_BOLD}修复/补齐内置脚本\${C_END}"
  local ok=0 fail=0
  for id in cors-proxy cmd-runner link-meta; do
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
    log "  \${C_C}[1]\${C_END} 启动全部服务"
    log "  \${C_C}[2]\${C_END} 停止全部服务"
    log "  \${C_C}[3]\${C_END} 查看服务日志"
    log "  \${C_C}[4]\${C_END} 一键部署/修复依赖"
    log "  \${C_C}[5]\${C_END} 查看持久化数据文件"
    log "  \${C_C}[6]\${C_END} 修复/补齐内置脚本（cmd-runner 等）"
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
      1) for entry in "\${SERVICES[@]}"; do start_service "\${entry%%|*}"; done; sleep 1;;
      2) for entry in "\${SERVICES[@]}"; do stop_service "\${entry%%|*}"; done; sleep 1;;
      3) tui_logs;;
      4) tui_repair;;
      5) tui_data;;
      6) repair_all; sleep 1;;
      0) log "再见！随时输入 \${C_C}xvshishi\${C_END} 可再次唤出本页面"; exit 0;;
      S1|s1) [ -n "\${SERVICES[0]}" ] && start_service "\${SERVICES[0]%%|*}"; sleep 1;;
      S2|s2) [ -n "\${SERVICES[1]}" ] && start_service "\${SERVICES[1]%%|*}"; sleep 1;;
      S3|s3) [ -n "\${SERVICES[2]}" ] && start_service "\${SERVICES[2]%%|*}"; sleep 1;;
      T1|t1) [ -n "\${SERVICES[0]}" ] && stop_service "\${SERVICES[0]%%|*}"; sleep 1;;
      T2|t2) [ -n "\${SERVICES[1]}" ] && stop_service "\${SERVICES[1]%%|*}"; sleep 1;;
      T3|t3) [ -n "\${SERVICES[2]}" ] && stop_service "\${SERVICES[2]%%|*}"; sleep 1;;
      S4|s4) [ -n "\${SERVICES[3]}" ] && start_service "\${SERVICES[3]%%|*}"; sleep 1;;
      T4|t4) [ -n "\${SERVICES[3]}" ] && stop_service "\${SERVICES[3]%%|*}"; sleep 1;;
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

# ---------- 命令分发 ----------
case "\${1:-tui}" in
  start)   start_service "$2" ;;
  stop)    stop_service "$2" ;;
  restart) stop_service "$2"; start_service "$2" ;;
  status)  [ -n "$2" ] && show_status "$2" || list_all ;;
  list)    list_all ;;
  repair)  repair_all ;;
  tui)     tui_menu ;;
  *)       log "用法: bash xvshishi-services.sh {tui|list|start <id>|stop <id>|restart <id>|status [id]|repair}";;
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
# 也支持子命令：xvshishi repair / xvshishi start cmd-runner / xvshishi list
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
  var LINK_META_SOURCE_B64 = "IyEvZGF0YS9kYXRhL2NvbS50ZXJtdXgvZmlsZXMvdXNyL2Jpbi9lbnYgbm9kZQovLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0KLy8g5Y+Z5LqL6K+X5bCP5omL5py6IC0gbGluay1tZXRh77yI5YaF572u6ISa5pysNCDCtyDliIbkuqvpk77mjqXlhYPmlbDmja7op6PmnpDmnI3liqHvvIznq6/lj6MgMzAwM++8iQovLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0KLy8g55So6YCU77yaQXBwL+e9kemhteWPlyBXZWJWaWV3IOaymeeuseS4jiBDT1JTIOmZkOWItu+8jOaXoOazleebtOaOpeaKk+WPluWIhuS6q+mTvuaOpeeahOagh+mimC/lsIHpnaIv5pGY6KaB44CCCi8vICAgICAgIOacrOacjeWKoeWcqCBUZXJtdXgg5YaF5Lul44CM5pyN5Yqh56uv44CN6Lqr5Lu95oqT5Y+W5bm26Kej5p6Q77yM6L+U5Zue5bmy5YeAIEpTT04g57uZIEFwcCDmuLLmn5PliIbkuqvljaHniYfjgIIKLy8g6IO95Yqb77yaCi8vICAgLSDot5/pmo/ph43lrprlkJHvvIh4aHNsaW5rLmNuIOefremTviDihpIg5bCP57qi5Lmm56yU6K6wL+S4u+mhte+8iQovLyAgIC0g56e75Yqo56uvIFVBIOS8quijhe+8iOWwj+e6ouS5puWvueahjOmdoiBVQSDkuI3ov5Tlm57lhoXlrrnvvIkKLy8gICAtIOWwj+e6ouS5pueslOiusOOAjOWFqOS/oeaBr+OAje+8muagh+mimC/mraPmlocv5L2c6ICFL+WbvueJh+WIl+ihqCArIOeCuei1ni/mlLbol48v6K+E6K66L+WIhuS6q+aVsCArIOWPkeW4g+aXtumXtAovLyAgICAgKyDor53popjmoIfnrb4gKyDpppblsY/or4TorrrvvIjlkKvlrZDor4TorrrvvInvvIzljbMi54K56L+b6ZO+5o6l6IO955yL5Yiw5LuA5LmI77yM5bCx6L+U5Zue5LuA5LmIIgovLyAgIC0g6YCa55So572R6aG177yab2c6dGl0bGUvb2c6ZGVzY3JpcHRpb24vb2c6aW1hZ2UvdHdpdHRlcjoqIC8gPHRpdGxlPgovLyAgIC0gL2ltZyDlm77niYfku6PnkIbvvIjooaUgQ09SUyDlpLTvvIzkvpsgQXBwIOaKiuW4luWtkOmFjeWbvuWOi+e8qeWQjumaj+a2iOaBr+mAgee7meinhuinieaooeWei++8iQovLyDmjqXlj6PvvJoKLy8gICBHRVQgL2hlYWx0aCAgICAgICAgICAgICAgICDihpIg5YGl5bq35qOA5p+lCi8vICAgR0VUIC9tZXRhP3VybD0855uu5qCH6ZO+5o6lPiAgICDihpIg6L+U5ZueIHtvaywgZmluYWxVcmwsIHNpdGUsIGtpbmQsIHRpdGxlLCBkZXNjLCBhdXRob3IsIGltYWdlc1tdLAovLyAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBsaWtlZENvdW50LCBjb2xsZWN0ZWRDb3VudCwgY29tbWVudENvdW50LCBzaGFyZUNvdW50LAovLyAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBwdWJsaXNoVGltZSwgdGFnc1tdLCBub3RlSWQsIGNvbW1lbnRzW10sIGNvbW1lbnRzSGFzTW9yZX0KLy8gICBHRVQgL2ltZz91cmw9POWbvueJh+WcsOWdgD4gICAgIOKGkiDljp/moLfovazlj5Hlm77niYflrZfoioLvvIhBY2Nlc3MtQ29udHJvbC1BbGxvdy1PcmlnaW46ICrvvIkKLy8g566h55CG77yaeHZzaGlzaGkgc3RhcnQgbGluay1tZXRhCi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PQoKJ3VzZSBzdHJpY3QnOwpjb25zdCBodHRwID0gcmVxdWlyZSgnaHR0cCcpOwpjb25zdCBodHRwcyA9IHJlcXVpcmUoJ2h0dHBzJyk7Cgpjb25zdCBQT1JUID0gcHJvY2Vzcy5lbnYuUE9SVCB8fCAzMDAzOwpjb25zdCBNQVhfUkVESVJFQ1QgPSA4Owpjb25zdCBUSU1FT1VUX01TID0gMTUwMDA7CmNvbnN0IE1BWF9CWVRFUyA9IDMgKiAxMDI0ICogMTAyNDsKY29uc3QgTUFYX0lNR19CWVRFUyA9IDggKiAxMDI0ICogMTAyNDsKY29uc3QgTUFYX0lNQUdFUyA9IDIwOwpjb25zdCBNQVhfQ09NTUVOVFMgPSAxMjsKCmNvbnN0IE1PQklMRV9VQSA9ICdNb3ppbGxhLzUuMCAoaVBob25lOyBDUFUgaVBob25lIE9TIDE3XzAgbGlrZSBNYWMgT1MgWCkgQXBwbGVXZWJLaXQvNjA1LjEuMTUgKEtIVE1MLCBsaWtlIEdlY2tvKSBWZXJzaW9uLzE3LjAgTW9iaWxlLzE1RTE0OCBTYWZhcmkvNjA0LjEnOwoKY29uc3QgU0lURV9NQVAgPSBbCiAgWy94aHNsaW5rXC5jbnx4aWFvaG9uZ3NodVwuY29tL2ksICflsI/nuqLkuaYnXSwKICBbL2JpbGliaWxpXC5jb218YjIzXC50di9pLCAn5ZOU5ZOp5ZOU5ZOpJ10sCiAgWy9kb3V5aW5cLmNvbXxpZXNkb3V5aW4vaSwgJ+aKlumfsyddLAogIFsvd2VpYm9cLihjbnxjb20pL2ksICflvq7ljZonXSwKICBbL3poaWh1XC5jb20vaSwgJ+efpeS5jiddLAogIFsvZ2l0aHViXC5jb20vaSwgJ0dpdEh1YiddLAogIFsveW91dHViZVwuY29tfHlvdXR1XC5iZS9pLCAnWW91VHViZSddLAogIFsvdGFvYmFvXC5jb218dG1hbGxcLmNvbXx0YlwuY24vaSwgJ+a3mOWunSddLAogIFsvamRcLmNvbS9pLCAn5Lqs5LicJ10sCiAgWy9tdXNpY1wuMTYzXC5jb20vaSwgJ+e9keaYk+S6kemfs+S5kCddLAogIFsveVwucXFcLmNvbXxxcVwuY29tL2ksICdRUemfs+S5kCddLAogIFsvbXBcLndlaXhpblwucXFcLmNvbS9pLCAn5b6u5L+h5YWs5LyX5Y+3J10KXTsKCmZ1bmN0aW9uIGNvcnMocmVzKSB7CiAgcmVzLnNldEhlYWRlcignQWNjZXNzLUNvbnRyb2wtQWxsb3ctT3JpZ2luJywgJyonKTsKICByZXMuc2V0SGVhZGVyKCdBY2Nlc3MtQ29udHJvbC1BbGxvdy1NZXRob2RzJywgJ0dFVCwgT1BUSU9OUycpOwogIHJlcy5zZXRIZWFkZXIoJ0FjY2Vzcy1Db250cm9sLUFsbG93LUhlYWRlcnMnLCAnKicpOwogIHJlcy5zZXRIZWFkZXIoJ0FjY2Vzcy1Db250cm9sLU1heC1BZ2UnLCAnODY0MDAnKTsKfQoKZnVuY3Rpb24gc2VuZEpzb24ocmVzLCBjb2RlLCBvYmopIHsKICBjb3JzKHJlcyk7CiAgcmVzLndyaXRlSGVhZChjb2RlLCB7ICdDb250ZW50LVR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7CiAgcmVzLmVuZChKU09OLnN0cmluZ2lmeShvYmopKTsKfQoKZnVuY3Rpb24gc2l0ZU9mKHVybCkgewogIGZvciAoY29uc3QgW3JlLCBuYW1lXSBvZiBTSVRFX01BUCkgaWYgKHJlLnRlc3QodXJsKSkgcmV0dXJuIG5hbWU7CiAgdHJ5IHsgcmV0dXJuIG5ldyBVUkwodXJsKS5ob3N0bmFtZTsgfSBjYXRjaCAoZSkgeyByZXR1cm4gJyc7IH0KfQoKZnVuY3Rpb24gdW5lc2NhcGVKc29uKHMpIHsKICBpZiAoIXMpIHJldHVybiAnJzsKICByZXR1cm4gU3RyaW5nKHMpCiAgICAucmVwbGFjZSgvXFx1MDAyRi9naSwgJy8nKQogICAgLnJlcGxhY2UoL1xcdTAwMmYvZywgJy8nKQogICAgLnJlcGxhY2UoL1xcXC8vZywgJy8nKQogICAgLnJlcGxhY2UoL1xcbi9nLCAnXG4nKQogICAgLnJlcGxhY2UoL1xcdC9nLCAnICcpCiAgICAucmVwbGFjZSgvXFwiL2csICciJykKICAgIC5yZXBsYWNlKC9cXHUoWzAtOWEtZkEtRl17NH0pL2csIChtLCBoKSA9PiBTdHJpbmcuZnJvbUNoYXJDb2RlKHBhcnNlSW50KGgsIDE2KSkpOwp9CgpmdW5jdGlvbiBjbGVhblRleHQocykgewogIHJldHVybiB1bmVzY2FwZUpzb24oU3RyaW5nKHMgfHwgJycpKQogICAgLnJlcGxhY2UoLzxbXj5dKz4vZywgJycpCiAgICAucmVwbGFjZSgvW1x1MDAwMC1cdTAwMWZdL2csICcgJykKICAgIC5yZXBsYWNlKC9ccysvZywgJyAnKQogICAgLnRyaW0oKTsKfQoKLyoqIOW3suaYryBKU09OLnBhcnNlIOWQjueahOWtl+espuS4su+8muWPquWBmuagh+etvuWJpeemu+S4juepuueZveaVtOeQhu+8jOWPr+S/neeVmeaNouihjCAqLwpmdW5jdGlvbiB0aWR5VGV4dChzLCBrZWVwTmV3bGluZXMpIHsKICBsZXQgdCA9IFN0cmluZyhzID09IG51bGwgPyAnJyA6IHMpLnJlcGxhY2UoLzxbXj5dKz4vZywgJycpLnJlcGxhY2UoL1xyL2csICcnKTsKICBpZiAoa2VlcE5ld2xpbmVzKSB7CiAgICB0ID0gdC5yZXBsYWNlKC9bIFx0XHUwMGEwXSsvZywgJyAnKS5yZXBsYWNlKC9cbnszLH0vZywgJ1xuXG4nKTsKICAgIHJldHVybiB0LnNwbGl0KCdcbicpLm1hcCgobCkgPT4gbC50cmltKCkpLmpvaW4oJ1xuJykudHJpbSgpOwogIH0KICByZXR1cm4gdC5yZXBsYWNlKC9ccysvZywgJyAnKS50cmltKCk7Cn0KCmZ1bmN0aW9uIHRvSW50KHYpIHsKICBpZiAodiA9PSBudWxsKSByZXR1cm4gbnVsbDsKICBpZiAodHlwZW9mIHYgPT09ICdudW1iZXInICYmIGlzRmluaXRlKHYpKSByZXR1cm4gTWF0aC5yb3VuZCh2KTsKICBjb25zdCBtID0gU3RyaW5nKHYpLnJlcGxhY2UoL1teXGQuXS9nLCAnJyk7CiAgaWYgKCFtKSByZXR1cm4gbnVsbDsKICBjb25zdCBmID0gcGFyc2VGbG9hdChtKTsKICByZXR1cm4gaXNOYU4oZikgPyBudWxsIDogTWF0aC5yb3VuZChmKTsKfQoKZnVuY3Rpb24gdG9IdHRwcyh1KSB7CiAgY29uc3QgcyA9IFN0cmluZyh1IHx8ICcnKTsKICBpZiAoL15odHRwOlwvXC8vaS50ZXN0KHMpKSByZXR1cm4gJ2h0dHBzOi8vJyArIHMuc2xpY2UoNyk7CiAgcmV0dXJuIHM7Cn0KCi8qKiDluKbph43lrprlkJHnmoQgR0VU77yM6L+U5ZueIHsgZmluYWxVcmwsIGJvZHksIHN0YXR1cyB9ICovCmZ1bmN0aW9uIGZldGNoRm9sbG93KHRhcmdldFVybCwgZGVwdGgpIHsKICBkZXB0aCA9IGRlcHRoIHx8IDA7CiAgcmV0dXJuIG5ldyBQcm9taXNlKChyZXNvbHZlLCByZWplY3QpID0+IHsKICAgIGxldCB1OwogICAgdHJ5IHsgdSA9IG5ldyBVUkwodGFyZ2V0VXJsKTsgfSBjYXRjaCAoZSkgeyByZXR1cm4gcmVqZWN0KG5ldyBFcnJvcignaW52YWxpZCB1cmwnKSk7IH0KICAgIGNvbnN0IGxpYiA9IHUucHJvdG9jb2wgPT09ICdodHRwczonID8gaHR0cHMgOiBodHRwOwogICAgY29uc3QgcmVxID0gbGliLnJlcXVlc3QodSwgewogICAgICBtZXRob2Q6ICdHRVQnLAogICAgICBoZWFkZXJzOiB7CiAgICAgICAgJ1VzZXItQWdlbnQnOiBNT0JJTEVfVUEsCiAgICAgICAgJ0FjY2VwdCc6ICd0ZXh0L2h0bWwsYXBwbGljYXRpb24veGh0bWwreG1sLGFwcGxpY2F0aW9uL2pzb247cT0wLjksKi8qO3E9MC44JywKICAgICAgICAnQWNjZXB0LUxhbmd1YWdlJzogJ3poLUNOLHpoO3E9MC45LGVuO3E9MC44JywKICAgICAgICAnQWNjZXB0LUVuY29kaW5nJzogJ2lkZW50aXR5JwogICAgICB9LAogICAgICB0aW1lb3V0OiBUSU1FT1VUX01TCiAgICB9LCAocmVzcCkgPT4gewogICAgICBjb25zdCBjb2RlID0gcmVzcC5zdGF0dXNDb2RlIHx8IDA7CiAgICAgIGlmIChjb2RlID49IDMwMCAmJiBjb2RlIDwgNDAwICYmIHJlc3AuaGVhZGVycy5sb2NhdGlvbikgewogICAgICAgIGlmIChkZXB0aCA+PSBNQVhfUkVESVJFQ1QpIHsgcmVzcC5yZXN1bWUoKTsgcmV0dXJuIHJlamVjdChuZXcgRXJyb3IoJ3RvbyBtYW55IHJlZGlyZWN0cycpKTsgfQogICAgICAgIGNvbnN0IG5leHQgPSBuZXcgVVJMKHJlc3AuaGVhZGVycy5sb2NhdGlvbiwgdSkudG9TdHJpbmcoKTsKICAgICAgICByZXNwLnJlc3VtZSgpOwogICAgICAgIHJldHVybiByZXNvbHZlKGZldGNoRm9sbG93KG5leHQsIGRlcHRoICsgMSkpOwogICAgICB9CiAgICAgIGxldCBzaXplID0gMDsKICAgICAgY29uc3QgY2h1bmtzID0gW107CiAgICAgIHJlc3Aub24oJ2RhdGEnLCAoYykgPT4gewogICAgICAgIHNpemUgKz0gYy5sZW5ndGg7CiAgICAgICAgaWYgKHNpemUgPiBNQVhfQllURVMpIHsgcmVxLmRlc3Ryb3koKTsgcmV0dXJuOyB9CiAgICAgICAgY2h1bmtzLnB1c2goYyk7CiAgICAgIH0pOwogICAgICByZXNwLm9uKCdlbmQnLCAoKSA9PiB7CiAgICAgICAgcmVzb2x2ZSh7IGZpbmFsVXJsOiB1LnRvU3RyaW5nKCksIHN0YXR1czogY29kZSwgYm9keTogQnVmZmVyLmNvbmNhdChjaHVua3MpLnRvU3RyaW5nKCd1dGY4JykgfSk7CiAgICAgIH0pOwogICAgfSk7CiAgICByZXEub24oJ3RpbWVvdXQnLCAoKSA9PiB7IHJlcS5kZXN0cm95KCk7IHJlamVjdChuZXcgRXJyb3IoJ3RpbWVvdXQnKSk7IH0pOwogICAgcmVxLm9uKCdlcnJvcicsIHJlamVjdCk7CiAgICByZXEuZW5kKCk7CiAgfSk7Cn0KCi8qKiDkuIvovb3lm77niYflrZfoioLvvIjot5/pmo/ph43lrprlkJHvvInvvIzov5Tlm54geyB0eXBlLCBidWYgfSAqLwpmdW5jdGlvbiBmZXRjaEltYWdlKHRhcmdldFVybCwgZGVwdGgpIHsKICBkZXB0aCA9IGRlcHRoIHx8IDA7CiAgcmV0dXJuIG5ldyBQcm9taXNlKChyZXNvbHZlLCByZWplY3QpID0+IHsKICAgIGxldCB1OwogICAgdHJ5IHsgdSA9IG5ldyBVUkwodGFyZ2V0VXJsKTsgfSBjYXRjaCAoZSkgeyByZXR1cm4gcmVqZWN0KG5ldyBFcnJvcignaW52YWxpZCB1cmwnKSk7IH0KICAgIGNvbnN0IGxpYiA9IHUucHJvdG9jb2wgPT09ICdodHRwczonID8gaHR0cHMgOiBodHRwOwogICAgLy8g5bCP57qi5Lmm5Zu+5bqK77yIeGhzY2Ru77yJ5a+56Ieq6Lqr5Z+f5ZCNIFJlZmVyZXIg6L+U5ZueIDQwM++8jOW/hemhu+S8quijheaIkOermeWGheadpea6kAogICAgY29uc3QgcmVmZXJlciA9IC94aHNjZG5cLmNvbXx4aWFvaG9uZ3NodVwuY29tfHhoc2xpbmtcLmNuL2kudGVzdCh1Lmhvc3RuYW1lKQogICAgICA/ICdodHRwczovL3d3dy54aWFvaG9uZ3NodS5jb20vJwogICAgICA6ICh1Lm9yaWdpbiArICcvJyk7CiAgICBjb25zdCByZXEgPSBsaWIucmVxdWVzdCh1LCB7CiAgICAgIG1ldGhvZDogJ0dFVCcsCiAgICAgIGhlYWRlcnM6IHsKICAgICAgICAnVXNlci1BZ2VudCc6IE1PQklMRV9VQSwKICAgICAgICAnQWNjZXB0JzogJ2ltYWdlL2F2aWYsaW1hZ2Uvd2VicCxpbWFnZS9hcG5nLGltYWdlLyosKi8qO3E9MC44JywKICAgICAgICAnUmVmZXJlcic6IHJlZmVyZXIsCiAgICAgICAgJ0FjY2VwdC1FbmNvZGluZyc6ICdpZGVudGl0eScKICAgICAgfSwKICAgICAgdGltZW91dDogVElNRU9VVF9NUwogICAgfSwgKHJlc3ApID0+IHsKICAgICAgY29uc3QgY29kZSA9IHJlc3Auc3RhdHVzQ29kZSB8fCAwOwogICAgICBpZiAoY29kZSA+PSAzMDAgJiYgY29kZSA8IDQwMCAmJiByZXNwLmhlYWRlcnMubG9jYXRpb24pIHsKICAgICAgICBpZiAoZGVwdGggPj0gTUFYX1JFRElSRUNUKSB7IHJlc3AucmVzdW1lKCk7IHJldHVybiByZWplY3QobmV3IEVycm9yKCd0b28gbWFueSByZWRpcmVjdHMnKSk7IH0KICAgICAgICBjb25zdCBuZXh0ID0gbmV3IFVSTChyZXNwLmhlYWRlcnMubG9jYXRpb24sIHUpLnRvU3RyaW5nKCk7CiAgICAgICAgcmVzcC5yZXN1bWUoKTsKICAgICAgICByZXR1cm4gcmVzb2x2ZShmZXRjaEltYWdlKG5leHQsIGRlcHRoICsgMSkpOwogICAgICB9CiAgICAgIGlmIChjb2RlICE9PSAyMDApIHsgcmVzcC5yZXN1bWUoKTsgcmV0dXJuIHJlamVjdChuZXcgRXJyb3IoJ2h0dHAgJyArIGNvZGUpKTsgfQogICAgICBsZXQgc2l6ZSA9IDA7CiAgICAgIGNvbnN0IGNodW5rcyA9IFtdOwogICAgICByZXNwLm9uKCdkYXRhJywgKGMpID0+IHsKICAgICAgICBzaXplICs9IGMubGVuZ3RoOwogICAgICAgIGlmIChzaXplID4gTUFYX0lNR19CWVRFUykgeyByZXEuZGVzdHJveSgpOyByZXR1cm47IH0KICAgICAgICBjaHVua3MucHVzaChjKTsKICAgICAgfSk7CiAgICAgIHJlc3Aub24oJ2VuZCcsICgpID0+IHsKICAgICAgICBjb25zdCB0eXBlID0gU3RyaW5nKHJlc3AuaGVhZGVyc1snY29udGVudC10eXBlJ10gfHwgJycpLnNwbGl0KCc7JylbMF0udHJpbSgpOwogICAgICAgIGlmICghL15pbWFnZVwvL2kudGVzdCh0eXBlKSkgcmV0dXJuIHJlamVjdChuZXcgRXJyb3IoJ25vdCBhbiBpbWFnZTogJyArIHR5cGUpKTsKICAgICAgICByZXNvbHZlKHsgdHlwZSwgYnVmOiBCdWZmZXIuY29uY2F0KGNodW5rcykgfSk7CiAgICAgIH0pOwogICAgfSk7CiAgICByZXEub24oJ3RpbWVvdXQnLCAoKSA9PiB7IHJlcS5kZXN0cm95KCk7IHJlamVjdChuZXcgRXJyb3IoJ3RpbWVvdXQnKSk7IH0pOwogICAgcmVxLm9uKCdlcnJvcicsIHJlamVjdCk7CiAgICByZXEuZW5kKCk7CiAgfSk7Cn0KCmZ1bmN0aW9uIG1ldGFUYWcoaHRtbCwgcHJvcCkgewogIGNvbnN0IHJlID0gbmV3IFJlZ0V4cCgnPG1ldGFbXj5dKyg/OnByb3BlcnR5fG5hbWUpPVsiXCddJyArIHByb3AucmVwbGFjZSgvWy4qKz9eJHt9KCl8W1xdXFxdL2csICdcXCQmJykgKyAnWyJcJ11bXj5dKj4nLCAnaScpOwogIGNvbnN0IG0gPSBodG1sLm1hdGNoKHJlKTsKICBpZiAoIW0pIHJldHVybiAnJzsKICBjb25zdCBjID0gbVswXS5tYXRjaCgvY29udGVudD1bIlwnXShbXHNcU10qPylbIlwnXS9pKTsKICByZXR1cm4gYyA/IGNsZWFuVGV4dChjWzFdKSA6ICcnOwp9CgovKiog5LuO5Lu75oSP5L2N572u6LW35YGa5ous5Y+36YWN5a+55oiq5Y+W77yI5a2X56ym5LiyL+i9rOS5ieaEn+efpe+8ie+8jOeUqOS6juWPluWGheW1jCBKU09OIOeJh+autSAqLwpmdW5jdGlvbiBiYWxhbmNlZFNsaWNlKHMsIHN0YXJ0KSB7CiAgbGV0IGQgPSAwLCBpblN0ciA9IGZhbHNlLCBlc2MgPSBmYWxzZTsKICBmb3IgKGxldCBpID0gc3RhcnQ7IGkgPCBzLmxlbmd0aDsgaSsrKSB7CiAgICBjb25zdCBjaCA9IHNbaV07CiAgICBpZiAoaW5TdHIpIHsKICAgICAgaWYgKGVzYykgeyBlc2MgPSBmYWxzZTsgY29udGludWU7IH0KICAgICAgaWYgKGNoID09PSAnXFwnKSB7IGVzYyA9IHRydWU7IGNvbnRpbnVlOyB9CiAgICAgIGlmIChjaCA9PT0gJyInKSBpblN0ciA9IGZhbHNlOwogICAgICBjb250aW51ZTsKICAgIH0KICAgIGlmIChjaCA9PT0gJyInKSB7IGluU3RyID0gdHJ1ZTsgY29udGludWU7IH0KICAgIGlmIChjaCA9PT0gJ3snIHx8IGNoID09PSAnWycpIGQrKzsKICAgIGVsc2UgaWYgKGNoID09PSAnfScgfHwgY2ggPT09ICddJykgeyBkLS07IGlmIChkID09PSAwKSByZXR1cm4gcy5zbGljZShzdGFydCwgaSArIDEpOyB9CiAgfQogIHJldHVybiAnJzsKfQoKLyoqIOWPlumhtemdouWGheW1jCB3aW5kb3cuX19JTklUSUFMX1NUQVRFX1/vvIjlsI/nuqLkuabkuLrljZXooYwgSlNPTu+8jOWPr+iDveWQqyB1bmRlZmluZWQg6ZyA5YWc5bqV5L+u5aSN77yJICovCmZ1bmN0aW9uIGV4dHJhY3RJbml0aWFsU3RhdGUoaHRtbCkgewogIGNvbnN0IG0gPSBodG1sLm1hdGNoKC93aW5kb3dcLl9fSU5JVElBTF9TVEFURV9fXHMqPVxzKi8pOwogIGlmICghbSkgcmV0dXJuIG51bGw7CiAgY29uc3Qgc3RhcnQgPSBtLmluZGV4ICsgbVswXS5sZW5ndGg7CiAgbGV0IGVuZCA9IGh0bWwuaW5kZXhPZignPC9zY3JpcHQ+Jywgc3RhcnQpOwogIGlmIChlbmQgPCAwKSBlbmQgPSBodG1sLmxlbmd0aDsKICBjb25zdCByYXcgPSBodG1sLnNsaWNlKHN0YXJ0LCBlbmQpLnRyaW0oKS5yZXBsYWNlKC87XHMqJC8sICcnKTsKICB0cnkgeyByZXR1cm4gSlNPTi5wYXJzZShyYXcpOyB9IGNhdGNoIChlKSB7fQogIHRyeSB7IHJldHVybiBKU09OLnBhcnNlKHJhdy5yZXBsYWNlKC86XHMqdW5kZWZpbmVkKD89XHMqWyx9XF1dKS9nLCAnOm51bGwnKSk7IH0gY2F0Y2ggKGUpIHt9CiAgcmV0dXJuIG51bGw7Cn0KCi8qKiDmjIkga2V5IOWPluWGheW1jOWvueixoS/mlbDnu4TvvIjmraPliJnlrprkvY0gKyDmi6zlj7fphY3lr7kgKyBKU09OLnBhcnNl77yJ77yM5L2c5Li65pW06aG16Kej5p6Q5aSx6LSl5pe255qE5YWc5bqVICovCmZ1bmN0aW9uIGdyYWJKc29uKGh0bWwsIGtleSkgewogIGNvbnN0IGkgPSBodG1sLmluZGV4T2YoJyInICsga2V5ICsgJyI6Jyk7CiAgaWYgKGkgPCAwKSByZXR1cm4gbnVsbDsKICBjb25zdCBzID0gaHRtbC5pbmRleE9mKCd7JywgaSk7CiAgY29uc3QgYSA9IGh0bWwuaW5kZXhPZignWycsIGkpOwogIGxldCBzdGFydCA9IC0xOwogIGlmIChzID49IDAgJiYgYSA+PSAwKSBzdGFydCA9IE1hdGgubWluKHMsIGEpOwogIGVsc2Ugc3RhcnQgPSBzID49IDAgPyBzIDogYTsKICBpZiAoc3RhcnQgPCAwKSByZXR1cm4gbnVsbDsKICBjb25zdCByYXcgPSBiYWxhbmNlZFNsaWNlKGh0bWwsIHN0YXJ0KTsKICBpZiAoIXJhdykgcmV0dXJuIG51bGw7CiAgdHJ5IHsgcmV0dXJuIEpTT04ucGFyc2UocmF3KTsgfSBjYXRjaCAoZSkgeyByZXR1cm4gbnVsbDsgfQp9CgovKiog5bCP57qi5Lmm5Zu+54mH5p2h55uuIOKGkiDmnIDkvbMgVVJM77yI5LyY5YWIIGg1XzEwODAgLyBINV9EVEwg6auY5riF54mI77yJICovCmZ1bmN0aW9uIHBpY2tJbWFnZVVybChpdGVtKSB7CiAgaWYgKCFpdGVtIHx8IHR5cGVvZiBpdGVtICE9PSAnb2JqZWN0JykgcmV0dXJuICcnOwogIGNvbnN0IGNhbmRzID0gW107CiAgaWYgKHR5cGVvZiBpdGVtLnVybCA9PT0gJ3N0cmluZycpIGNhbmRzLnB1c2goaXRlbS51cmwpOwogIChpdGVtLmluZm9MaXN0IHx8IFtdKS5mb3JFYWNoKChpaSkgPT4geyBpZiAoaWkgJiYgdHlwZW9mIGlpLnVybCA9PT0gJ3N0cmluZycpIGNhbmRzLnB1c2goaWkudXJsKTsgfSk7CiAgaWYgKCFjYW5kcy5sZW5ndGgpIHJldHVybiAnJzsKICBjb25zdCBiZXN0ID0gY2FuZHMuZmluZCgodSkgPT4gL2g1XzEwODB8SDVfRFRML2kudGVzdCh1KSkgfHwgY2FuZHNbMF07CiAgcmV0dXJuIHRvSHR0cHMoYmVzdCk7Cn0KCi8qKiDpppblsY/or4Torrog4oaSIOeyvueugOe7k+aehCAqLwpmdW5jdGlvbiBtYXBDb21tZW50KGMpIHsKICBpZiAoIWMgfHwgdHlwZW9mIGMgIT09ICdvYmplY3QnKSByZXR1cm4gbnVsbDsKICBjb25zdCB1c2VyID0gKGMudXNlciAmJiAoYy51c2VyLm5pY2tuYW1lIHx8IGMudXNlci5uaWNrTmFtZSkpIHx8ICcnOwogIGNvbnN0IGNvbnRlbnQgPSB0aWR5VGV4dChjLmNvbnRlbnQgfHwgJycsIHRydWUpOwogIGlmICghY29udGVudCAmJiAhdXNlcikgcmV0dXJuIG51bGw7CiAgcmV0dXJuIHsKICAgIHVzZXIsCiAgICBjb250ZW50LAogICAgbGlrZTogdG9JbnQoYy5saWtlQ291bnQpIHx8IDAsCiAgICBpcDogYy5pcExvY2F0aW9uIHx8ICcnLAogICAgdGltZTogdG9JbnQoYy50aW1lKSB8fCAwLAogICAgc3ViczogKGMuc3ViQ29tbWVudHMgfHwgW10pLnNsaWNlKDAsIDMpLm1hcCgocykgPT4gKHsKICAgICAgdXNlcjogKHMgJiYgcy51c2VyICYmIChzLnVzZXIubmlja25hbWUgfHwgcy51c2VyLm5pY2tOYW1lKSkgfHwgJycsCiAgICAgIGNvbnRlbnQ6IHRpZHlUZXh0KChzICYmIHMuY29udGVudCkgfHwgJycsIHRydWUpCiAgICB9KSkuZmlsdGVyKChzKSA9PiBzLmNvbnRlbnQpCiAgfTsKfQoKLyoqIOWwj+e6ouS5pueslOiusOino+aekO+8muS8mOWFiOaVtOmhtSBfX0lOSVRJQUxfU1RBVEVfXyDnu5PmnoTljJbor7vlj5bvvIzlpLHotKXlm57pgIDmraPliJkgKi8KZnVuY3Rpb24gcGFyc2VYaHNOb3RlKGh0bWwpIHsKICBjb25zdCBvdXQgPSB7CiAgICB0aXRsZTogJycsIGRlc2M6ICcnLCBhdXRob3I6ICcnLCBpbWFnZXM6IFtdLAogICAgbGlrZWRDb3VudDogbnVsbCwgY29sbGVjdGVkQ291bnQ6IG51bGwsIGNvbW1lbnRDb3VudDogbnVsbCwgc2hhcmVDb3VudDogbnVsbCwKICAgIHB1Ymxpc2hUaW1lOiAwLCB0YWdzOiBbXSwgbm90ZUlkOiAnJywgY29tbWVudHM6IFtdLCBjb21tZW50c0hhc01vcmU6IGZhbHNlCiAgfTsKCiAgY29uc3Qgc3QgPSBleHRyYWN0SW5pdGlhbFN0YXRlKGh0bWwpOwogIGNvbnN0IGRhdGEgPSBzdCAmJiBzdC5ub3RlRGF0YSAmJiBzdC5ub3RlRGF0YS5kYXRhOwogIGNvbnN0IG5vdGUgPSBkYXRhICYmIGRhdGEubm90ZURhdGE7CiAgY29uc3QgY2RhdGEgPSBkYXRhICYmIGRhdGEuY29tbWVudERhdGE7CgogIGlmIChub3RlKSB7CiAgICBvdXQudGl0bGUgPSB0aWR5VGV4dChub3RlLnRpdGxlIHx8ICcnKTsKICAgIG91dC5kZXNjID0gdGlkeVRleHQobm90ZS5kZXNjIHx8ICcnLCB0cnVlKTsKICAgIG91dC5hdXRob3IgPSAobm90ZS51c2VyICYmIChub3RlLnVzZXIubmlja05hbWUgfHwgbm90ZS51c2VyLm5pY2tuYW1lKSkgfHwgJyc7CiAgICBvdXQubm90ZUlkID0gbm90ZS5ub3RlSWQgfHwgJyc7CiAgICBvdXQucHVibGlzaFRpbWUgPSB0b0ludChub3RlLnRpbWUpIHx8IDA7CiAgICBvdXQudGFncyA9IChub3RlLnRhZ0xpc3QgfHwgW10pLm1hcCgodCkgPT4gdGlkeVRleHQoKHQgJiYgdC5uYW1lKSB8fCAnJykpLmZpbHRlcihCb29sZWFuKTsKICAgIGNvbnN0IGlpID0gbm90ZS5pbnRlcmFjdEluZm8gfHwge307CiAgICBvdXQubGlrZWRDb3VudCA9IHRvSW50KGlpLmxpa2VkQ291bnQpOwogICAgb3V0LmNvbGxlY3RlZENvdW50ID0gdG9JbnQoaWkuY29sbGVjdGVkQ291bnQpOwogICAgb3V0LmNvbW1lbnRDb3VudCA9IHRvSW50KGlpLmNvbW1lbnRDb3VudCk7CiAgICBvdXQuc2hhcmVDb3VudCA9IHRvSW50KGlpLnNoYXJlQ291bnQpOwogICAgY29uc3Qgc2VlbiA9IHt9OwogICAgKG5vdGUuaW1hZ2VMaXN0IHx8IFtdKS5mb3JFYWNoKChpdCkgPT4gewogICAgICBjb25zdCB1ID0gcGlja0ltYWdlVXJsKGl0KTsKICAgICAgaWYgKCF1KSByZXR1cm47CiAgICAgIGlmICgvXC9hdmF0YXJcLy9pLnRlc3QodSkpIHJldHVybjsKICAgICAgY29uc3Qga2V5ID0gKGl0ICYmIGl0LmZpbGVJZCkgfHwgKHUubWF0Y2goLzEwNDBnWzAtOWEtel0rL2kpIHx8IFt1XSlbMF07CiAgICAgIGlmIChzZWVuW2tleV0pIHJldHVybjsKICAgICAgc2VlbltrZXldID0gdTsKICAgIH0pOwogICAgb3V0LmltYWdlcyA9IE9iamVjdC52YWx1ZXMoc2Vlbikuc2xpY2UoMCwgTUFYX0lNQUdFUyk7CiAgfQoKICAvLyAtLS0tIOWFnOW6le+8muaVtOmhtSBKU09OIOino+aekOWksei0peaXtueUqOato+WImemAkOS4quWtl+auteWPliAtLS0tCiAgaWYgKCFvdXQudGl0bGUpIHsKICAgIGNvbnN0IG0gPSBodG1sLm1hdGNoKC8idGl0bGUiXHMqOlxzKiIoKD86W14iXFxdfFxcLikqKSIvKTsKICAgIGlmIChtKSBvdXQudGl0bGUgPSBjbGVhblRleHQobVsxXSk7CiAgfQogIGlmICghb3V0LmRlc2MpIHsKICAgIGNvbnN0IG0gPSBodG1sLm1hdGNoKC8iZGVzYyJccyo6XHMqIigoPzpbXiJcXF18XFwuKSopIi8pOwogICAgaWYgKG0pIG91dC5kZXNjID0gY2xlYW5UZXh0KG1bMV0pOwogIH0KICBpZiAoIW91dC5hdXRob3IpIHsKICAgIGNvbnN0IG0gPSBodG1sLm1hdGNoKC8ibmlja05hbWUiXHMqOlxzKiIoKD86W14iXFxdfFxcLikqKSIvKTsKICAgIGlmIChtKSBvdXQuYXV0aG9yID0gY2xlYW5UZXh0KG1bMV0pOwogIH0KICBpZiAoIW91dC5pbWFnZXMubGVuZ3RoKSB7CiAgICBjb25zdCB1cmxzID0gW107CiAgICBjb25zdCByZSA9IC8idXJsIlxzKjpccyoiKGh0dHBbXiJdKj9zbnMtKD86d2VicGljfGltZylbXiJdKikiL2c7CiAgICBsZXQgbW07CiAgICB3aGlsZSAoKG1tID0gcmUuZXhlYyhodG1sKSkgIT09IG51bGwpIHsKICAgICAgY29uc3QgdSA9IHVuZXNjYXBlSnNvbihtbVsxXSk7CiAgICAgIGlmICghL15odHRwcz86XC9cLy8udGVzdCh1KSkgY29udGludWU7CiAgICAgIGlmICgvXC8oYXZhdGFyfGxvZ28pXC8vaS50ZXN0KHUpKSBjb250aW51ZTsKICAgICAgdXJscy5wdXNoKHUpOwogICAgfQogICAgY29uc3Qgc2VlbiA9IHt9OwogICAgZm9yIChjb25zdCB1IG9mIHVybHMpIHsKICAgICAgY29uc3Qga2V5ID0gKHUubWF0Y2goLzEwNDBnWzAtOWEtel0rL2kpIHx8IFt1XSlbMF07CiAgICAgIGlmIChzZWVuW2tleV0pIHsKICAgICAgICBpZiAoL2g1XzEwODB8SDVfRFRML2kudGVzdCh1KSAmJiAhL2g1XzEwODB8SDVfRFRML2kudGVzdChzZWVuW2tleV0pKSBzZWVuW2tleV0gPSB1OwogICAgICAgIGNvbnRpbnVlOwogICAgICB9CiAgICAgIHNlZW5ba2V5XSA9IHU7CiAgICAgIGlmICh1cmxzLmxlbmd0aCA+IDYwKSBicmVhazsKICAgIH0KICAgIG91dC5pbWFnZXMgPSBPYmplY3QudmFsdWVzKHNlZW4pLnNsaWNlKDAsIE1BWF9JTUFHRVMpLm1hcCh0b0h0dHBzKTsKICB9CiAgaWYgKG91dC5saWtlZENvdW50ID09IG51bGwgJiYgb3V0LmNvbW1lbnRDb3VudCA9PSBudWxsKSB7CiAgICBjb25zdCBpaSA9IGdyYWJKc29uKGh0bWwsICdpbnRlcmFjdEluZm8nKTsKICAgIGlmIChpaSkgewogICAgICBvdXQubGlrZWRDb3VudCA9IHRvSW50KGlpLmxpa2VkQ291bnQpOwogICAgICBvdXQuY29sbGVjdGVkQ291bnQgPSB0b0ludChpaS5jb2xsZWN0ZWRDb3VudCk7CiAgICAgIG91dC5jb21tZW50Q291bnQgPSB0b0ludChpaS5jb21tZW50Q291bnQpOwogICAgICBvdXQuc2hhcmVDb3VudCA9IHRvSW50KGlpLnNoYXJlQ291bnQpOwogICAgfQogIH0KICBpZiAoIW91dC50YWdzLmxlbmd0aCkgewogICAgY29uc3QgdGwgPSBncmFiSnNvbihodG1sLCAndGFnTGlzdCcpOwogICAgaWYgKEFycmF5LmlzQXJyYXkodGwpKSBvdXQudGFncyA9IHRsLm1hcCgodCkgPT4gY2xlYW5UZXh0KCh0ICYmIHQubmFtZSkgfHwgJycpKS5maWx0ZXIoQm9vbGVhbik7CiAgfQogIGlmICghb3V0LnB1Ymxpc2hUaW1lKSB7CiAgICBjb25zdCB0bSA9IGh0bWwubWF0Y2goLyJhdFVzZXJMaXN0IlxzKjpccypcW1xzKlxdXHMqLFxzKiJ0aW1lIlxzKjpccyooXGR7MTN9KS8pOwogICAgY29uc3QgdG0yID0gdG0gfHwgaHRtbC5tYXRjaCgvInRpbWUiXHMqOlxzKihcZHsxM30pLyk7CiAgICBpZiAodG0yKSBvdXQucHVibGlzaFRpbWUgPSBOdW1iZXIodG0yWzFdKTsKICB9CiAgaWYgKCFvdXQuY29tbWVudHMubGVuZ3RoKSB7CiAgICBjb25zdCBjZCA9IGdyYWJKc29uKGh0bWwsICdjb21tZW50RGF0YScpOwogICAgaWYgKGNkICYmIEFycmF5LmlzQXJyYXkoY2QuY29tbWVudHMpKSB7CiAgICAgIG91dC5jb21tZW50Q291bnQgPSBvdXQuY29tbWVudENvdW50ICE9IG51bGwgPyBvdXQuY29tbWVudENvdW50IDogdG9JbnQoY2QuY29tbWVudENvdW50KTsKICAgICAgb3V0LmNvbW1lbnRzSGFzTW9yZSA9ICEhY2QuaGFzTW9yZTsKICAgIH0KICB9CiAgaWYgKGNkYXRhKSB7CiAgICBpZiAob3V0LmNvbW1lbnRDb3VudCA9PSBudWxsKSBvdXQuY29tbWVudENvdW50ID0gdG9JbnQoY2RhdGEuY29tbWVudENvdW50KTsKICAgIG91dC5jb21tZW50c0hhc01vcmUgPSAhIWNkYXRhLmhhc01vcmU7CiAgICBvdXQuY29tbWVudHMgPSAoY2RhdGEuY29tbWVudHMgfHwgW10pLm1hcChtYXBDb21tZW50KS5maWx0ZXIoQm9vbGVhbikuc2xpY2UoMCwgTUFYX0NPTU1FTlRTKTsKICB9IGVsc2UgaWYgKCFvdXQuY29tbWVudHMubGVuZ3RoKSB7CiAgICBjb25zdCBjZCA9IGdyYWJKc29uKGh0bWwsICdjb21tZW50RGF0YScpOwogICAgaWYgKGNkICYmIEFycmF5LmlzQXJyYXkoY2QuY29tbWVudHMpKSB7CiAgICAgIG91dC5jb21tZW50cyA9IGNkLmNvbW1lbnRzLm1hcChtYXBDb21tZW50KS5maWx0ZXIoQm9vbGVhbikuc2xpY2UoMCwgTUFYX0NPTU1FTlRTKTsKICAgICAgb3V0LmNvbW1lbnRzSGFzTW9yZSA9ICEhY2QuaGFzTW9yZTsKICAgIH0KICB9CgogIHJldHVybiBvdXQ7Cn0KCi8qKiDpgJrnlKjnvZHpobXop6PmnpDvvJpvZyAvIHR3aXR0ZXIgLyB0aXRsZSAvIOmmluWbviAqLwpmdW5jdGlvbiBwYXJzZUdlbmVyaWMoaHRtbCwgZmluYWxVcmwpIHsKICBjb25zdCBvdXQgPSB7IHRpdGxlOiAnJywgZGVzYzogJycsIGF1dGhvcjogJycsIGltYWdlczogW10gfTsKICBvdXQudGl0bGUgPSBtZXRhVGFnKGh0bWwsICdvZzp0aXRsZScpIHx8IG1ldGFUYWcoaHRtbCwgJ3R3aXR0ZXI6dGl0bGUnKTsKICBvdXQuZGVzYyA9IG1ldGFUYWcoaHRtbCwgJ29nOmRlc2NyaXB0aW9uJykgfHwgbWV0YVRhZyhodG1sLCAnZGVzY3JpcHRpb24nKSB8fCBtZXRhVGFnKGh0bWwsICd0d2l0dGVyOmRlc2NyaXB0aW9uJyk7CiAgY29uc3Qgb2dJbWcgPSBtZXRhVGFnKGh0bWwsICdvZzppbWFnZScpIHx8IG1ldGFUYWcoaHRtbCwgJ3R3aXR0ZXI6aW1hZ2UnKTsKICBpZiAoIW91dC50aXRsZSkgewogICAgY29uc3QgdCA9IGh0bWwubWF0Y2goLzx0aXRsZVtePl0qPihbXHNcU10qPyk8XC90aXRsZT4vaSk7CiAgICBpZiAodCkgb3V0LnRpdGxlID0gY2xlYW5UZXh0KHRbMV0pOwogIH0KICBpZiAob2dJbWcpIG91dC5pbWFnZXMucHVzaCh1bmVzY2FwZUpzb24ob2dJbWcpKTsKICByZXR1cm4gb3V0Owp9Cgphc3luYyBmdW5jdGlvbiBidWlsZE1ldGEodGFyZ2V0KSB7CiAgY29uc3QgciA9IGF3YWl0IGZldGNoRm9sbG93KHRhcmdldCk7CiAgY29uc3QgaHRtbCA9IHIuYm9keSB8fCAnJzsKICBjb25zdCBmaW5hbFVybCA9IHIuZmluYWxVcmw7CiAgY29uc3Qgc2l0ZSA9IHNpdGVPZihmaW5hbFVybCkgfHwgc2l0ZU9mKHRhcmdldCk7CiAgY29uc3QgaXNYaHMgPSAveGlhb2hvbmdzaHVcLmNvbXx4aHNsaW5rXC5jbi9pLnRlc3QoZmluYWxVcmwpOwogIGNvbnN0IGlzWGhzTm90ZSA9IC94aWFvaG9uZ3NodVwuY29tXC8oZGlzY292ZXJ5XC9pdGVtfGV4cGxvcmUpXC8vaS50ZXN0KGZpbmFsVXJsKTsKCiAgbGV0IHBhcnNlZDsKICBsZXQga2luZCA9ICd3ZWInOwogIGlmIChpc1hocyAmJiBpc1hoc05vdGUpIHsKICAgIHBhcnNlZCA9IHBhcnNlWGhzTm90ZShodG1sKTsKICAgIGtpbmQgPSAneGhzLW5vdGUnOwogIH0gZWxzZSB7CiAgICBwYXJzZWQgPSBwYXJzZUdlbmVyaWMoaHRtbCwgZmluYWxVcmwpOwogICAga2luZCA9IGlzWGhzID8gJ3hocy1wcm9maWxlJyA6ICd3ZWInOwogIH0KICAvLyDlsI/nuqLkuabkuLvpobXooaXlhYXvvJpkZXNjcmlwdGlvbiDph4zpgJrluLjmnInnsonkuJ0v5YWz5rOo5L+h5oGvCiAgaWYgKGtpbmQgPT09ICd4aHMtcHJvZmlsZScgJiYgIXBhcnNlZC5kZXNjKSBwYXJzZWQuZGVzYyA9IG1ldGFUYWcoaHRtbCwgJ2Rlc2NyaXB0aW9uJyk7CgogIGNvbnN0IG1ldGEgPSB7CiAgICBvazogdHJ1ZSwKICAgIGZpbmFsVXJsLAogICAgc2l0ZSwKICAgIGtpbmQsCiAgICB0aXRsZTogcGFyc2VkLnRpdGxlIHx8IHNpdGUgfHwgZmluYWxVcmwsCiAgICBkZXNjOiBwYXJzZWQuZGVzYyB8fCAnJywKICAgIGF1dGhvcjogcGFyc2VkLmF1dGhvciB8fCAnJywKICAgIGltYWdlczogcGFyc2VkLmltYWdlcyB8fCBbXQogIH07CiAgLy8g5bCP57qi5Lmm56yU6K6w6ZmE5bim5YWo6YeP5LqS5YqoL+ivhOiuuuS/oeaBr++8iOmdnueslOiusOexu+S4jei/lOWbnu+8jOS/neaMgemAmueUqOe7k+aehOW5suWHgO+8iQogIGlmIChraW5kID09PSAneGhzLW5vdGUnKSB7CiAgICBtZXRhLmxpa2VkQ291bnQgPSBwYXJzZWQubGlrZWRDb3VudDsKICAgIG1ldGEuY29sbGVjdGVkQ291bnQgPSBwYXJzZWQuY29sbGVjdGVkQ291bnQ7CiAgICBtZXRhLmNvbW1lbnRDb3VudCA9IHBhcnNlZC5jb21tZW50Q291bnQ7CiAgICBtZXRhLnNoYXJlQ291bnQgPSBwYXJzZWQuc2hhcmVDb3VudDsKICAgIG1ldGEucHVibGlzaFRpbWUgPSBwYXJzZWQucHVibGlzaFRpbWUgfHwgMDsKICAgIG1ldGEudGFncyA9IHBhcnNlZC50YWdzIHx8IFtdOwogICAgbWV0YS5ub3RlSWQgPSBwYXJzZWQubm90ZUlkIHx8ICcnOwogICAgbWV0YS5jb21tZW50cyA9IHBhcnNlZC5jb21tZW50cyB8fCBbXTsKICAgIG1ldGEuY29tbWVudHNIYXNNb3JlID0gISFwYXJzZWQuY29tbWVudHNIYXNNb3JlOwogIH0KICByZXR1cm4gbWV0YTsKfQoKLy8gLS0tLSDlm77niYfku6PnkIbvvJrlhoXlrZjlsI/nvJPlrZjvvIzpgb/lhY3lkIzkuIDluJblpJrlm77ooqvlj43lpI3kuIvovb0gLS0tLQpjb25zdCBpbWdDYWNoZSA9IG5ldyBNYXAoKTsKY29uc3QgSU1HX0NBQ0hFX1RUTCA9IDEwICogNjAgKiAxMDAwOwpjb25zdCBJTUdfQ0FDSEVfTUFYID0gNDA7CgpmdW5jdGlvbiBjYWNoZUdldChrZXkpIHsKICBjb25zdCBoaXQgPSBpbWdDYWNoZS5nZXQoa2V5KTsKICBpZiAoIWhpdCkgcmV0dXJuIG51bGw7CiAgaWYgKERhdGUubm93KCkgLSBoaXQuYXQgPiBJTUdfQ0FDSEVfVFRMKSB7IGltZ0NhY2hlLmRlbGV0ZShrZXkpOyByZXR1cm4gbnVsbDsgfQogIHJldHVybiBoaXQ7Cn0KCmZ1bmN0aW9uIGNhY2hlU2V0KGtleSwgdHlwZSwgYnVmKSB7CiAgaWYgKGltZ0NhY2hlLnNpemUgPj0gSU1HX0NBQ0hFX01BWCkgewogICAgY29uc3QgZmlyc3QgPSBpbWdDYWNoZS5rZXlzKCkubmV4dCgpOwogICAgaWYgKCFmaXJzdC5kb25lKSBpbWdDYWNoZS5kZWxldGUoZmlyc3QudmFsdWUpOwogIH0KICBpbWdDYWNoZS5zZXQoa2V5LCB7IGF0OiBEYXRlLm5vdygpLCB0eXBlLCBidWYgfSk7Cn0KCmNvbnN0IHNlcnZlciA9IGh0dHAuY3JlYXRlU2VydmVyKChyZXEsIHJlcykgPT4gewogIGNvcnMocmVzKTsKICBpZiAocmVxLm1ldGhvZCA9PT0gJ09QVElPTlMnKSB7IHJlcy53cml0ZUhlYWQoMjA0KTsgcmVzLmVuZCgpOyByZXR1cm47IH0KICBjb25zdCB1ID0gbmV3IFVSTChyZXEudXJsIHx8ICcvJywgJ2h0dHA6Ly8xMjcuMC4wLjEnKTsKICBpZiAodS5wYXRobmFtZSA9PT0gJy9oZWFsdGgnKSB7CiAgICByZXR1cm4gc2VuZEpzb24ocmVzLCAyMDAsIHsgb2s6IHRydWUsIHNlcnZpY2U6ICdsaW5rLW1ldGEnLCBwb3J0OiBQT1JUIH0pOwogIH0KICBpZiAodS5wYXRobmFtZSA9PT0gJy9pbWcnKSB7CiAgICBjb25zdCB0YXJnZXQgPSB1LnNlYXJjaFBhcmFtcy5nZXQoJ3VybCcpIHx8ICcnOwogICAgaWYgKCEvXmh0dHBzPzpcL1wvL2kudGVzdCh0YXJnZXQpKSByZXR1cm4gc2VuZEpzb24ocmVzLCA0MDAsIHsgb2s6IGZhbHNlLCBlcnJvcjogJ21pc3Npbmcgb3IgaW52YWxpZCB1cmwnIH0pOwogICAgY29uc3QgY2FjaGVkID0gY2FjaGVHZXQodGFyZ2V0KTsKICAgIGlmIChjYWNoZWQpIHsKICAgICAgcmVzLndyaXRlSGVhZCgyMDAsIHsgJ0NvbnRlbnQtVHlwZSc6IGNhY2hlZC50eXBlLCAnQ2FjaGUtQ29udHJvbCc6ICdwdWJsaWMsIG1heC1hZ2U9NjAwJywgJ0NvbnRlbnQtTGVuZ3RoJzogY2FjaGVkLmJ1Zi5sZW5ndGggfSk7CiAgICAgIHJldHVybiByZXMuZW5kKGNhY2hlZC5idWYpOwogICAgfQogICAgcmV0dXJuIGZldGNoSW1hZ2UodGFyZ2V0KS50aGVuKChyKSA9PiB7CiAgICAgIGNhY2hlU2V0KHRhcmdldCwgci50eXBlLCByLmJ1Zik7CiAgICAgIHJlcy53cml0ZUhlYWQoMjAwLCB7ICdDb250ZW50LVR5cGUnOiByLnR5cGUsICdDYWNoZS1Db250cm9sJzogJ3B1YmxpYywgbWF4LWFnZT02MDAnLCAnQ29udGVudC1MZW5ndGgnOiByLmJ1Zi5sZW5ndGggfSk7CiAgICAgIHJlcy5lbmQoci5idWYpOwogICAgfSkuY2F0Y2goKGUpID0+IHNlbmRKc29uKHJlcywgNTAyLCB7IG9rOiBmYWxzZSwgZXJyb3I6IGUubWVzc2FnZSB8fCAnaW1hZ2UgZmV0Y2ggZmFpbGVkJyB9KSk7CiAgfQogIGlmICh1LnBhdGhuYW1lICE9PSAnL21ldGEnKSB7CiAgICByZXR1cm4gc2VuZEpzb24ocmVzLCA0MDQsIHsgb2s6IGZhbHNlLCBlcnJvcjogJ25vdCBmb3VuZCcsIHVzYWdlOiAnL21ldGE/dXJsPWh0dHBzOi8veGhzbGluay5jbi9vL3h4eHgnIH0pOwogIH0KICBjb25zdCB0YXJnZXQgPSB1LnNlYXJjaFBhcmFtcy5nZXQoJ3VybCcpIHx8ICcnOwogIGlmICghL15odHRwcz86XC9cLy9pLnRlc3QodGFyZ2V0KSkgewogICAgcmV0dXJuIHNlbmRKc29uKHJlcywgNDAwLCB7IG9rOiBmYWxzZSwgZXJyb3I6ICdtaXNzaW5nIG9yIGludmFsaWQgdXJsJyB9KTsKICB9CiAgYnVpbGRNZXRhKHRhcmdldCkudGhlbigobWV0YSkgPT4gc2VuZEpzb24ocmVzLCAyMDAsIG1ldGEpKS5jYXRjaCgoZSkgPT4gewogICAgc2VuZEpzb24ocmVzLCAyMDAsIHsgb2s6IGZhbHNlLCBlcnJvcjogZS5tZXNzYWdlIHx8ICdmZXRjaCBmYWlsZWQnLCBmaW5hbFVybDogdGFyZ2V0LCBzaXRlOiBzaXRlT2YodGFyZ2V0KSB9KTsKICB9KTsKfSk7CgpzZXJ2ZXIubGlzdGVuKFBPUlQsICcxMjcuMC4wLjEnLCAoKSA9PiB7CiAgY29uc29sZS5sb2coJ1tsaW5rLW1ldGFdIGxpc3RlbmluZyBvbiBodHRwOi8vMTI3LjAuMC4xOicgKyBQT1JUKTsKfSk7Cg==";
  function getLinkMetaSource() {
    try { return decodeURIComponent(escape(atob(LINK_META_SOURCE_B64))); } catch (e) { return ""; }
  }

  var BUILTIN_SCRIPTS = [
    { id: "ncm-api", name: "网易云音乐 API", desc: "网易云登录代理 / 歌单同步 / 歌词搜索（端口 3000）", port: 3000, healthUrl: "http://localhost:3000/search?keywords=test&limit=1", termuxCmd: "NeteaseCloudMusicApi -p 3000", fileContent: "", isBuiltin: true },
    { id: "cors-proxy", name: "CORS 跨域中转", desc: "为 PWA/网页版打破跨域限制，代理任意 HTTP/HTTPS 请求（端口 3001）", port: 3001, healthUrl: "http://localhost:3001/health", termuxCmd: "node $HOME/.xvshishi/cors-proxy.js", fileContent: CORS_PROXY_SOURCE, isBuiltin: true },
    { id: "cmd-runner", name: "AI 命令执行服务（工作台）", desc: "工作台 Agent 执行 termux 命令 / 自写脚本 / git 仓库操作（端口 3002）", port: 3002, healthUrl: "http://localhost:3002/health", termuxCmd: "node $HOME/.xvshishi/cmd-runner.js", fileContent: CMD_RUNNER_SOURCE, isBuiltin: true },
    { id: "link-meta", name: "分享链接解析服务", desc: "解析小红书/B站等分享链接的标题/封面/摘要，供聊天分享卡片使用（端口 3003）", port: 3003, healthUrl: "http://localhost:3003/health", termuxCmd: "node $HOME/.xvshishi/link-meta.js", fileContent: getLinkMetaSource(), isBuiltin: true }
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
              通过 Termux 在手机上运行本地脚本服务（网易云 API / CORS 跨域中转 / AI 命令执行服务 / 分享链接解析），App 通过 localhost 访问。
              部署引导命令已内置全部脚本内容，复制到 Termux 执行即可直接创建脚本文件，无需联网下载。
            </div>
          </div>
          <div class="form-actions" style="margin-bottom:14px;">
            <button id="btn-local-deploy-guide" class="btn btn-outline" style="flex:1;">部署引导（命令可一键复制）</button>
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
      L.push("cat > ~/.xvshishi/xvshishi-services.sh <<'XSH_EOF'");
      L.push(trimSrc(SERVICES_MANAGER_SOURCE));
      L.push("XSH_EOF");
      L.push("mkdir -p $PREFIX/bin");
      L.push("cat > $PREFIX/bin/xvshishi <<'XSH_EOF'");
      L.push(trimSrc(XSHISHI_LAUNCHER_SOURCE));
      L.push("XSH_EOF");
      L.push("chmod +x $PREFIX/bin/xvshishi");
      L.push("chmod +x ~/.xvshishi/xvshishi-services.sh");
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
        { title: "第 2 步（推荐）：导出脚本到手机存储", desc: "先点下面的『导出脚本到手机存储』按钮（App 会把 4 个脚本直接写进手机 Download/Storypoem/xvshishi-scripts/，不经过剪贴板，绝不会被截断），然后在 Termux 执行这条短命令安装：", cmd: "mkdir -p ~/.xvshishi \"$PREFIX/bin\" && cp /sdcard/Download/Storypoem/xvshishi-scripts/* ~/.xvshishi/ && cp ~/.xvshishi/xvshishi \"$PREFIX/bin/xvshishi\" && chmod +x ~/.xvshishi/xvshishi-services.sh \"$PREFIX/bin/xvshishi\" && xvshishi" },
        { title: "第 2 步（备选）：一键长命令部署", desc: "若不想用导出方式，也可复制下面整条命令到 Termux 执行（内容较长，注意别被截断）：", cmd: this.buildDeployCommand() },
        { title: "第 3 步：启动服务", desc: "在服务管理器菜单按 [1] 启动全部；或分别执行：", cmd: "bash $HOME/.xvshishi/xvshishi-services.sh start ncm-api\nbash $HOME/.xvshishi/xvshishi-services.sh start cors-proxy\nbash $HOME/.xvshishi/xvshishi-services.sh start cmd-runner" },
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
    }
  };

  window.localDeploySystem = localDeploySystem;
})();
