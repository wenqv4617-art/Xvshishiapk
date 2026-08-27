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
  local id="$1" pid cmd keyword
  pid=$(get_pid "$id")
  [ -n "$pid" ] && return 0
  cmd=$(get_cmd "$id")
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
  local id="$1" cmd name logf pf pid
  name=$(get_name "$id")
  if is_running "$id"; then
    log "${C_Y}[!]${C_END} $name 已在运行（PID: $(get_pid "$id")）"
    return 0
  fi
  cmd=$(get_cmd "$id")
  [ -z "$cmd" ] && { log "${C_R}[x]${C_END} 未知服务: $id"; return 1; }
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
  fi
}

# ---------- 停止服务 ----------
stop_service() {
  local id="$1" name pid cmd keyword
  name=$(get_name "$id")
  pid=$(get_pid "$id")
  if [ -n "$pid" ]; then
    kill "$pid" 2>/dev/null
    sleep 1
    if kill -0 "$pid" 2>/dev/null; then
      kill -9 "$pid" 2>/dev/null
    fi
    write_status "$id" "stopped" ""
    log "${C_G}[✓]${C_END} $name 已停止"
    return 0
  fi
  cmd=$(get_cmd "$id")
  keyword=$(echo "$cmd" | awk '{print $1}')
  if pkill -f "$keyword" 2>/dev/null; then
    write_status "$id" "stopped" ""
    log "${C_G}[✓]${C_END} $name 已停止（关键字匹配）"
    return 0
  fi
  log "${C_Y}[!]${C_END} $name 未在运行"
  write_status "$id" "stopped" ""
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
    local idx entry id
    idx=0
    for entry in "${SERVICES[@]}"; do
      idx=$((idx+1))
      id="${entry%%|*}"
      log "  ${C_C}[S${idx}]${C_END} 切换 ${id}"
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
      0) log "再见！"; exit 0;;
      S1|s1) [ -n "${SERVICES[0]}" ] && start_service "${SERVICES[0]%%|*}"; sleep 1;;
      S2|s2) [ -n "${SERVICES[1]}" ] && start_service "${SERVICES[1]%%|*}"; sleep 1;;
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
  log "  4. 安装 CORS 代理: npm install -g local-cors-proxy --registry=https://registry.npmmirror.com"
  printf "  立即执行? (y/N): "
  read -r yn
  case "$yn" in
    y|Y)
      pkg update -y || true
      pkg install -y nodejs-lts || true
      npm install -g NeteaseCloudMusicApi --registry=https://registry.npmmirror.com || true
      npm install -g local-cors-proxy --registry=https://registry.npmmirror.com || true
      log "${C_G}[✓]${C_END} 依赖部署完成"
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
