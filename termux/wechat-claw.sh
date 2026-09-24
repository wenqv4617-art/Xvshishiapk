#!/data/data/com.termux/files/usr/bin/bash
# ============================================================
# 叙事诗小手机 - 微信 Claw 接入（内置脚本5）
# ------------------------------------------------------------
# 干什么：在你自己的手机上跑一个 OpenClaw，并通过腾讯官方的
#        「微信 ClawBot」插件把它接成微信里的一个联系人。
#
# 为什么用这条路（而不是无障碍）：
#   - ClawBot 是腾讯官方插件，走正规插件体系，不自动化你的微信账号；
#   - 因此几乎没有风控/封号风险；
#   - 代价：它只是「你 ↔ 你自己的 AI」这一条通道，
#     不能让 char 以你的身份去跟别人聊天（那是无障碍方案的能力）。
#
# 前提：
#   1) 微信 iOS/Android 需 >= 8.0.70，且已灰度到 ClawBot 插件
#      （微信 → 我 → 设置 → 插件，看有没有「微信 ClawBot」）
#   2) Node.js >= 22（本脚本会自动检测并提示安装）
#
# 用法（也可由 xvshishi 服务管理器统一启停）：
#   bash wechat-claw.sh check      # 环境自检：Node 版本 / 微信插件前提 / 已装没装
#   bash wechat-claw.sh install    # 安装微信 Channel 插件（会自动调起官方安装命令）
#   bash wechat-claw.sh login      # 重新生成绑定二维码（换号/掉线时用）
#   bash wechat-claw.sh run        # 前台运行 OpenClaw 网关（调试用，Ctrl+C 退出）
#   bash wechat-claw.sh start      # 后台常驻运行（自带 termux-wake-lock 保活）
#   bash wechat-claw.sh stop
#   bash wechat-claw.sh status
#   bash wechat-claw.sh logs
# ============================================================

set -o pipefail

XSH_DIR="${XSH_DIR:-$HOME/.xvshishi}"
LOG_DIR="$XSH_DIR/logs"
PID_DIR="$XSH_DIR/pids"
mkdir -p "$LOG_DIR" "$PID_DIR" "$XSH_DIR/wechat-claw"

LOG_FILE="$LOG_DIR/wechat-claw.log"
PID_FILE="$PID_DIR/wechat-claw.pid"
WAKE_LOCK_FILE="$XSH_DIR/wechat-claw/.wake-lock"

C_G="\033[32m"; C_R="\033[31m"; C_Y="\033[33m"; C_B="\033[34m"; C_DIM="\033[2m"; C_BOLD="\033[1m"; C_END="\033[0m"
log() { echo -e "$*"; }

# 官方安装命令：由微信「ClawBot」插件详情页给出，这里用它同源的 CLI 包名。
# 若腾讯调整了包名/命令，以插件详情页显示的为准，本脚本的 install 会提示你以页面为准。
OFFICIAL_CLI_PKG="@tencent-weixin/openclaw-weixin-cli@latest"

need_node() {
  if ! command -v node >/dev/null 2>&1; then
    log "${C_R}[x]${C_END} 没找到 node。请先在 Termux 执行： pkg install -y nodejs-lts"
    return 1
  fi
  local major
  major=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null | tr -d '[:space:]')
  # 必须真的是个数字才敢比较：否则 `[ "xx" -lt 22 ]` 会报 integer expression expected
  # 并且「不满足」会被当成「满足」，直接放过去 —— 那是最坏的情况（后面 npx 才炸）。
  case "$major" in
    ''|*[!0-9]*)
      log "${C_R}[x]${C_END} 读不到 node 主版本号（node -p 没返回数字）。"
      log "        请确认 node 装好了： node -v"
      return 1
      ;;
  esac
  if [ "$major" -lt 22 ]; then
    log "${C_Y}[!]${C_END} 当前 Node 版本是 $(node -v)，ClawBot 需要 >= 22。"
    log "        请升级： pkg install -y nodejs-lts   （或 pkg upgrade nodejs-lts）"
    return 1
  fi
  log "${C_G}[✓]${C_END} Node 版本 $(node -v) 满足要求"
  return 0
}

cmd_check() {
  log ""
  log "${C_BOLD}微信 Claw 接入 · 环境自检${C_END}"
  log "------------------------------------------"
  need_node || true

  log ""
  log "${C_BOLD}微信侧前提（需要你手动确认，脚本读不到微信插件列表）${C_END}"
  log "  1. 微信版本需 >= 8.0.70"
  log "  2. 打开微信： 我 → 设置 → 插件"
  log "  3. 看列表里有没有 ${C_BOLD}「微信 ClawBot」${C_END}"
  log "     ${C_DIM}如果没有：把微信从后台彻底杀掉重开再看一次；仍没有就是还没灰度到你，只能等。${C_END}"

  log ""
  log "${C_BOLD}本机状态${C_END}"
  if command -v openclaw >/dev/null 2>&1; then
    log "  ${C_G}●${C_END} 已找到 openclaw 命令"
  else
    log "  ${C_DIM}○${C_END} 还没装 OpenClaw 的微信插件（先跑 install）"
  fi
  if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE" 2>/dev/null)" 2>/dev/null; then
    log "  ${C_G}●${C_END} 后台网关运行中（PID $(cat "$PID_FILE")）"
  else
    log "  ${C_DIM}○${C_END} 后台网关未运行"
  fi
  log "  数据目录：$XSH_DIR/wechat-claw"
  log "  日志：$LOG_FILE"
  log "------------------------------------------"
  log ""
}

cmd_install() {
  need_node || return 1
  log ""
  log "${C_BOLD}安装微信 ClawBot 插件${C_END}"
  log "即将执行官方 CLI："
  log "  ${C_DIM}npx -y $OFFICIAL_CLI_PKG install${C_END}"
  log ""
  log "${C_Y}[!]${C_END} 若下面报错、或提示命令不存在，请以${C_BOLD}微信里「ClawBot 插件详情页」显示的安装命令为准${C_END}"
  log "     （腾讯可能会调整包名或命令形式，插件页给出的总是对的）"
  log ""
  printf "继续吗？[y/N] "
  read -r ans
  case "$ans" in
    y|Y|yes|YES) ;;
    *) log "已取消"; return 0;;
  esac
  ( cd "$XSH_DIR/wechat-claw" && npx -y "$OFFICIAL_CLI_PKG" install ) 2>&1 | tee -a "$LOG_FILE"
  local rc=${PIPESTATUS[0]}
  log ""
  if [ "$rc" -eq 0 ]; then
    log "${C_G}[✓]${C_END} 安装流程结束。若终端显示了二维码："
    log "    打开微信 → 我 → 设置 → 插件 → 微信 ClawBot → 扫一扫，扫码后点绿色「连接」。"
    log "    连上后微信里会出现「微信 ClawBot」的对话入口（可能不在列表里，需要搜索）。"
  else
    log "${C_R}[x]${C_END} 安装命令返回码 $rc，请把上面的输出发给开发者，或以插件详情页的命令为准重试。"
  fi
}

cmd_login() {
  need_node || return 1
  log "${C_B}[*]${C_END} 重新生成绑定二维码 ..."
  ( cd "$XSH_DIR/wechat-claw" && npx -y "$OFFICIAL_CLI_PKG" login ) 2>&1 | tee -a "$LOG_FILE"
}

# 取后台进程存活状态
running_pid() {
  [ -f "$PID_FILE" ] || return 1
  local p
  p=$(cat "$PID_FILE" 2>/dev/null | tr -d ' ')
  [ -n "$p" ] && kill -0 "$p" 2>/dev/null && echo "$p"
}

wake_lock_on() {
  # 安卓会把 Termux 进程冻结/回收，长驻必须持 wake lock；记录一下以便 stop 时释放
  if command -v termux-wake-lock >/dev/null 2>&1; then
    termux-wake-lock 2>/dev/null && touch "$WAKE_LOCK_FILE" && log "${C_G}[✓]${C_END} 已申请 Termux 唤醒锁（防止被系统冻结）"
  else
    log "${C_Y}[!]${C_END} 没有 termux-wake-lock，后台可能被系统冻结。建议 pkg install -y termux-api"
  fi
}

wake_lock_off() {
  if [ -f "$WAKE_LOCK_FILE" ] && command -v termux-wake-unlock >/dev/null 2>&1; then
    termux-wake-unlock 2>/dev/null
    rm -f "$WAKE_LOCK_FILE"
  fi
}

cmd_run() {
  need_node || return 1
  local bin=""
  if command -v openclaw >/dev/null 2>&1; then
    bin="openclaw"
  fi
  if [ -z "$bin" ]; then
    log "${C_R}[x]${C_END} 还没找到 openclaw 命令，请先运行： bash $0 install"
    return 1
  fi
  wake_lock_on
  log "${C_B}[*]${C_END} 前台启动 OpenClaw 网关（Ctrl+C 退出）..."
  ( cd "$XSH_DIR/wechat-claw" && "$bin" ) 2>&1 | tee -a "$LOG_FILE"
}

cmd_start() {
  if [ -n "$(running_pid)" ]; then
    log "${C_Y}[!]${C_END} 已在运行（PID $(running_pid)）"
    return 0
  fi
  local bin=""
  command -v openclaw >/dev/null 2>&1 && bin="openclaw"
  if [ -z "$bin" ]; then
    log "${C_R}[x]${C_END} 找不到 openclaw 命令，请先运行： bash $0 install"
    return 1
  fi
  wake_lock_on
  log "${C_B}[*]${C_END} 后台启动 OpenClaw 网关 ..."
  ( cd "$XSH_DIR/wechat-claw" && nohup "$bin" >> "$LOG_FILE" 2>&1 & echo $! > "$PID_FILE" )
  sleep 2
  local p
  p=$(running_pid)
  if [ -n "$p" ]; then
    log "${C_G}[✓]${C_END} 已启动（PID $p），日志：$LOG_FILE"
  else
    log "${C_R}[x]${C_END} 启动失败，最近日志："
    tail -15 "$LOG_FILE" 2>/dev/null | sed 's/^/    /'
    log "    常见原因：还没 install / Node 版本不够 / 网关配置缺失"
  fi
}

cmd_stop() {
  local p
  p=$(running_pid)
  if [ -n "$p" ]; then
    kill "$p" 2>/dev/null
    sleep 1
    kill -9 "$p" 2>/dev/null
    rm -f "$PID_FILE"
    log "${C_G}[✓]${C_END} 已停止（PID $p）"
  else
    log "${C_Y}[!]${C_END} 本来就没在跑"
  fi
  # 兜底清理残留的 openclaw 进程（只匹配可执行名，不误伤别的 node）
  pkill -f "openclaw" 2>/dev/null
  wake_lock_off
}

cmd_status() {
  local p
  p=$(running_pid)
  if [ -n "$p" ]; then
    log "  ${C_G}●${C_END} 微信 Claw 接入  运行中 (PID $p)"
  else
    log "  ${C_DIM}○${C_END} 微信 Claw 接入  已停止"
  fi
}

cmd_logs() {
  if [ -f "$LOG_FILE" ]; then
    tail -40 "$LOG_FILE"
  else
    log "还没有日志（$LOG_FILE）"
  fi
}

case "${1:-check}" in
  check)   cmd_check ;;
  install) cmd_install ;;
  login)   cmd_login ;;
  run)     cmd_run ;;
  start)   cmd_start ;;
  stop)    cmd_stop ;;
  status)  cmd_status ;;
  logs)    cmd_logs ;;
  *)       log "用法: bash wechat-claw.sh {check|install|login|run|start|stop|status|logs}" ;;
esac
