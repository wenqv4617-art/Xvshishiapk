#!/data/data/com.termux/files/usr/bin/bash
# ============================================================
# 叙事诗小手机 - Termux 一键部署引导（安装依赖 + 建立数据目录 + 内置脚本落地）
# ------------------------------------------------------------
# 用法：
#   1. 安装 Termux（务必用 F-Droid 版，Play 版已停更）
#      F-Droid: https://f-droid.org/packages/com.termux/
#   2. 复制本脚本内容到 Termux 保存为 ~/termux-ncm-api.sh 后执行，或在
#      App「设置 → 本地部署 → 部署引导」里一键复制部署命令（命令已内置
#      全部脚本内容，直接在 Termux 创建文件，无需联网下载）：
#      bash ~/termux-ncm-api.sh
#   3. 脚本会自动：安装依赖 → 写入内置脚本文件（cors-proxy.js / xvshishi-services.sh）
#      → 建立 ~/.xvshishi 数据目录 → 进入交互管理菜单
#
# 数据目录约定（登录态等数据持久化，重启 Termux 不会丢失）：
#   ~/.xvshishi/data/    持久化数据（cookie、账号信息等）
#   ~/.xvshishi/status/  各服务运行状态 JSON
#   ~/.xvshishi/logs/    各服务日志
#   ~/.xvshishi/pids/    PID 文件
#   ~/.xvshishi/services.conf  用户自定义服务配置
# ============================================================

set -u

XSH_DIR="$HOME/.xvshishi"

C_G="\033[32m"; C_R="\033[31m"; C_Y="\033[33m"; C_B="\033[34m"
C_DIM="\033[2m"; C_BOLD="\033[1m"; C_END="\033[0m"

banner() {
  echo -e "${C_BOLD}==============================================${C_END}"
  echo -e "${C_BOLD}   叙事诗小手机 - Termux 一键部署引导${C_END}"
  echo -e "${C_BOLD}==============================================${C_END}"
  echo -e "${C_DIM}数据目录: $XSH_DIR${C_END}"
  echo ""
}

step() { echo -e "${C_B}[*]${C_END} $1"; }
ok()   { echo -e "${C_G}[✓]${C_END} $1"; }
warn() { echo -e "${C_Y}[!]${C_END} $1"; }
fail() { echo -e "${C_R}[x]${C_END} $1"; }

# ---------- 1. 建立数据目录（登录态持久化基础） ----------
setup_dirs() {
  step "建立数据目录 $XSH_DIR ..."
  mkdir -p "$XSH_DIR/data" "$XSH_DIR/status" "$XSH_DIR/logs" "$XSH_DIR/pids"
  ok "数据目录已就绪（登录 Cookie / 服务状态将持久化保存）"
}

# ---------- 2. 写入内置脚本文件（内容与仓库 termux/ 目录保持一致，无需联网下载） ----------
write_cors_proxy() {
  step "创建 CORS 跨域中转脚本 $XSH_DIR/cors-proxy.js ..."
  cat > "$XSH_DIR/cors-proxy.js" <<'XSH_CORS_EOF'
// 叙事诗小手机 - 内置 CORS 跨域中转代理（端口 3001）
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
  console.log(`[xvshishi-cors-proxy] running @ http://localhost:${PORT}`);
});
XSH_CORS_EOF
  chmod 644 "$XSH_DIR/cors-proxy.js"
  ok "CORS 跨域中转脚本已就绪（端口 3001）"
}

write_services_manager() {
  step "部署服务管理器 $XSH_DIR/xvshishi-services.sh ..."
  cat > "$XSH_DIR/xvshishi-services.sh" <<'XSH_SVC_EOF'
#!/data/data/com.termux/files/usr/bin/bash
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
XSH_DIR="${XSH_DIR:-$HOME/.xvshishi}"
DATA_DIR="$XSH_DIR/data"      # 持久化数据（登录 cookie 等）
STATUS_DIR="$XSH_DIR/status"  # 各服务运行状态 JSON
LOG_DIR="$XSH_DIR/logs"       # 各服务日志
PID_DIR="$XSH_DIR/pids"       # PID 文件
mkdir -p "$DATA_DIR" "$STATUS_DIR" "$LOG_DIR" "$PID_DIR"

# ---------- 颜色 ----------
C_G="\033[32m"; C_R="\033[31m"; C_Y="\033[33m"; C_B="\033[34m"; C_C="\033[36m"
C_DIM="\033[2m"; C_BOLD="\033[1m"; C_END="\033[0m"

# ---------- 服务注册表 ----------
# 格式: 服务ID|显示名|描述|启动命令|健康检查URL|停止方式(kill|pkill)
SERVICES=(
  "ncm-api|网易云音乐 API|网易云登录代理/歌单同步/歌词搜索|NeteaseCloudMusicApi -p 3000|http://localhost:3000|kill"
  "cors-proxy|CORS 跨域中转|打破 PWA/网页版跨域限制|node \$HOME/.xvshishi/cors-proxy.js|http://localhost:3001/health|kill"
)

# ---------- 用户自定义服务（追加到数组末尾） ----------
USER_SERVICES_FILE="$XSH_DIR/services.conf"
if [ -f "$USER_SERVICES_FILE" ]; then
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    case "$line" in \#*) continue;; esac
    SERVICES+=("$line")
  done < "$USER_SERVICES_FILE"
fi

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
{"id":"$id","status":"$state","pid":${pid:-0},"updatedAt":"$ts"}
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
  mainfile=$(echo "$cmd" | sed -n 's/^[^ ]* \([^ ]*\.\(js\|sh\)\).*/\1/p')
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
  for entry in "${SERVICES[@]}"; do
    if [ "${entry%%|*}" = "$id" ]; then
      echo "$entry" | cut -d'|' -f4
      return
    fi
  done
  echo ""
}

get_name() {
  local id="$1" entry
  for entry in "${SERVICES[@]}"; do
    if [ "${entry%%|*}" = "$id" ]; then
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
    log "${C_Y}[!]${C_END} $name 已在运行（PID: $(get_pid "$id")）"
    return 0
  fi
  cmd=$(get_cmd "$id")
  [ -z "$cmd" ] && { log "${C_R}[x]${C_END} 未知服务: $id"; return 1; }

  # 预检：若命令指向本地脚本文件，先确认文件存在，避免静默失败
  mainfile=$(echo "$cmd" | sed -n 's/^[^ ]* \([^ ]*\.\(js\|sh\)\).*/\1/p')
  if [ -n "$mainfile" ]; then
    # 展开 $HOME 变量
    mainfile_expanded=$(eval echo "$mainfile")
    if [ ! -f "$mainfile_expanded" ]; then
      log "${C_R}[x]${C_END} $name 启动失败：找不到脚本文件 $mainfile_expanded"
      log "${C_Y}[!]${C_END} 请先运行部署脚本下载辅助文件，或检查该文件是否存在。"
      write_status "$id" "error" ""
      return 1
    fi
  fi

  logf=$(log_file "$id")
  pf=$(pid_file "$id")
  log "${C_B}[*]${C_END} 启动 $name ..."
  eval "nohup bash -c '$cmd' >> \"$logf\" 2>&1 &"
  echo $! > "$pf"
  sleep 1
  pid=$(get_pid "$id")
  if [ -n "$pid" ]; then
    write_status "$id" "running" "$pid"
    log "${C_G}[✓]${C_END} $name 已启动 (PID: $pid)"
  else
    write_status "$id" "error" ""
    log "${C_R}[x]${C_END} $name 启动失败，请查看日志: $logf"
    log "${C_Y}[!]${C_END} 日志内容: $(tail -5 "$logf" 2>/dev/null | tr '\n' ' ')"
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
  mainfile=$(echo "$cmd" | sed -n 's/^[^ ]* \([^ ]*\.\(js\|sh\)\).*/\1/p')
  if [ -n "$mainfile" ]; then
    mainfile_expanded=$(eval echo "$mainfile")
    pkill -f "$mainfile_expanded" 2>/dev/null
  else
    keyword=$(echo "$cmd" | awk '{print $1}')
    pkill -f "$keyword" 2>/dev/null
  fi
  sleep 1
  if is_running "$id"; then
    log "${C_R}[x]${C_END} $name 停止失败，进程仍在运行"
    return 1
  fi
  write_status "$id" "stopped" ""
  log "${C_G}[✓]${C_END} $name 已停止"
}

# ---------- 状态展示 ----------
show_status() {
  local id="$1" name pid
  id="$1"; name=$(get_name "$id"); pid=$(get_pid "$id")
  if [ -n "$pid" ]; then
    write_status "$id" "running" "$pid"
    log "  ${C_G}●${C_END} $name  ${C_G}运行中${C_END} (PID $pid)"
  else
    write_status "$id" "stopped" ""
    log "  ${C_DIM}○${C_END} $name  ${C_R}已停止${C_END}"
  fi
}

# ---------- 列出全部 ----------
list_all() {
  log ""
  log "${C_BOLD}叙事诗小手机 - Termux 服务列表${C_END}"
  log "${C_DIM}数据目录: $XSH_DIR${C_END}"
  log "------------------------------------------"
  local entry id
  for entry in "${SERVICES[@]}"; do
    id="${entry%%|*}"
    show_status "$id"
  done
  log "------------------------------------------"
  log ""
}

# ---------- 交互式 TUI 菜单 ----------
tui_menu() {
  while true; do
    clear 2>/dev/null || true
    log "${C_BOLD}============================================${C_END}"
    log "${C_BOLD}  叙事诗小手机 - Termux 服务管理器${C_END}"
    log "${C_BOLD}============================================${C_END}"
    list_all
    log "  请输入操作:"
    log "  ${C_C}[1]${C_END} 启动全部服务"
    log "  ${C_C}[2]${C_END} 停止全部服务"
    log "  ${C_C}[3]${C_END} 查看服务日志"
    log "  ${C_C}[4]${C_END} 一键部署/修复依赖"
    log "  ${C_C}[5]${C_END} 查看持久化数据文件"
    log "  ${C_C}[0]${C_END} 退出"
    log ""
    log "  ${C_DIM}—— 单独启停（推荐分开启动，避免相互干扰）——${C_END}"
    local idx entry id
    idx=0
    for entry in "${SERVICES[@]}"; do
      idx=$((idx+1))
      id="${entry%%|*}"
      log "  ${C_C}[S${idx}]${C_END} 启动 ${id}"
      log "  ${C_C}[T${idx}]${C_END} 停止 ${id}"
    done
    log ""
    printf "  选择: "
    read -r choice
    case "$choice" in
      1) for entry in "${SERVICES[@]}"; do start_service "${entry%%|*}"; done; sleep 1;;
      2) for entry in "${SERVICES[@]}"; do stop_service "${entry%%|*}"; done; sleep 1;;
      3) tui_logs;;
      4) tui_repair;;
      5) tui_data;;
      0) log "再见！随时输入 ${C_C}xvshishi${C_END} 可再次唤出本页面"; exit 0;;
      S1|s1) [ -n "${SERVICES[0]}" ] && start_service "${SERVICES[0]%%|*}"; sleep 1;;
      S2|s2) [ -n "${SERVICES[1]}" ] && start_service "${SERVICES[1]%%|*}"; sleep 1;;
      T1|t1) [ -n "${SERVICES[0]}" ] && stop_service "${SERVICES[0]%%|*}"; sleep 1;;
      T2|t2) [ -n "${SERVICES[1]}" ] && stop_service "${SERVICES[1]%%|*}"; sleep 1;;
      *) log "无效选项"; sleep 1;;
    esac
  done
}

tui_logs() {
  log ""
  log "可选日志:"
  local idx entry id
  idx=0
  for entry in "${SERVICES[@]}"; do
    id="${entry%%|*}"
    idx=$((idx+1))
    log "  [$idx] $id"
  done
  printf "查看哪个服务的日志? (0=返回): "
  read -r choice
  [ "$choice" = "0" ] && return
  local count=0 entry
  for entry in "${SERVICES[@]}"; do
    count=$((count+1))
    if [ "$count" = "$choice" ]; then
      id="${entry%%|*}"
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
  log "${C_BOLD}一键部署/修复依赖${C_END}"
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
      log "${C_G}[✓]${C_END} 依赖部署完成"
      log "${C_Y}[!]${C_END} 若 cors-proxy.js / xvshishi-services.sh 缺失，请重新复制 App 部署引导命令"
      ;;
    *) log "已取消";;
  esac
  sleep 1
}

tui_data() {
  log ""
  log "${C_BOLD}持久化数据文件 (${C_DIM}$DATA_DIR${C_END}${C_BOLD})${C_END}"
  ls -la "$DATA_DIR" 2>/dev/null | head -20
  log ""
  printf "按回车返回..."
  read -r _
}

# ---------- 命令分发 ----------
case "${1:-tui}" in
  start)   start_service "$2" ;;
  stop)    stop_service "$2" ;;
  restart) stop_service "$2"; start_service "$2" ;;
  status)  [ -n "$2" ] && show_status "$2" || list_all ;;
  list)    list_all ;;
  tui)     tui_menu ;;
  *)       log "用法: bash xvshishi-services.sh {tui|list|start <id>|stop <id>|restart <id>|status [id]}";;
esac
XSH_SVC_EOF
  chmod +x "$XSH_DIR/xvshishi-services.sh"
  ok "服务管理器已就绪: $XSH_DIR/xvshishi-services.sh"
}

write_launcher() {
  local prefix="${PREFIX:-/data/data/com.termux/files/usr}"
  step "安装唤出命令 xvshishi 到 $prefix/bin ..."
  mkdir -p "$prefix/bin"
  cat > "$prefix/bin/xvshishi" <<'XSH_LAUNCHER_EOF'
#!/data/data/com.termux/files/usr/bin/bash
# ============================================================
# 叙事诗小手机 - 脚本交互页面唤出命令
# ------------------------------------------------------------
# 部署（一键部署命令）时本文件会被安装到 $PREFIX/bin/xvshishi，
# 之后在 Termux 任意位置直接输入：
#     xvshishi
# 即可立刻唤出脚本交互页面（服务管理器 TUI），无需再输入长命令。
# ============================================================
exec bash "$HOME/.xvshishi/xvshishi-services.sh" tui
XSH_LAUNCHER_EOF
  chmod +x "$prefix/bin/xvshishi"
  ok "已安装！之后在 Termux 直接输入 xvshishi 即可唤出脚本交互页面"
}

# ---------- 4. 安装依赖 ----------
install_deps() {
  step "更新软件源..."
  pkg update -y || true

  step "检查 Node.js ..."
  if command -v node >/dev/null 2>&1; then
    ok "Node.js 已安装: $(node -v 2>/dev/null)"
  else
    pkg install -y nodejs-lts || { fail "Node.js 安装失败"; return 1; }
    ok "Node.js 安装完成"
  fi

  step "检查网易云音乐 API ..."
  if command -v NeteaseCloudMusicApi >/dev/null 2>&1; then
    ok "网易云 API 已安装"
  else
    warn "安装 NeteaseCloudMusicApi（国内镜像，耐心等待）..."
    npm install -g NeteaseCloudMusicApi --registry=https://registry.npmmirror.com || { fail "安装失败，可稍后重试"; return 1; }
    ok "网易云 API 安装完成"
  fi

  step "检查 termux-api（保活）..."
  if command -v termux-wake-lock >/dev/null 2>&1; then
    termux-wake-lock 2>/dev/null || true
    ok "已开启 Termux 保活"
  else
    warn "未安装 termux-api，跳过保活（可选: pkg install termux-api）"
  fi
}

# ---------- 主流程 ----------
banner
setup_dirs
install_deps
write_cors_proxy
write_services_manager
write_launcher

if [ -f "$XSH_DIR/xvshishi-services.sh" ]; then
  echo ""
  ok "部署完成！即将进入服务管理器（可独立启停每个脚本）..."
  echo ""
  ok "之后退出 Termux 再进入时，直接输入 xvshishi 即可唤出脚本交互页面"
  echo ""
  sleep 1
  exec bash "$XSH_DIR/xvshishi-services.sh" tui
else
  echo ""
  warn "服务管理器未就位，请重试部署。"
fi
