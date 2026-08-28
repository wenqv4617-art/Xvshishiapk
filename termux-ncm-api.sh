#!/data/data/com.termux/files/usr/bin/bash
# ============================================================
# 叙事诗小手机 - Termux 一键部署引导（安装依赖 + 建立数据目录 + 进入服务管理器）
# ------------------------------------------------------------
# 用法：
#   1. 安装 Termux（务必用 F-Droid 版，Play 版已停更）
#      F-Droid: https://f-droid.org/packages/com.termux/
#   2. 复制下面这一条命令到 Termux 执行（自动下载脚本 + 装依赖 + 建数据目录 + 进服务管理器）：
#      curl -L https://raw.githubusercontent.com/wenqv4617-art/Xvshishiapk/main/termux-ncm-api.sh -o ~/termux-ncm-api.sh && bash ~/termux-ncm-api.sh
#   3. 脚本会自动：安装依赖 → 下载辅助脚本 → 建立 ~/.xvshishi 数据目录 → 进入交互管理菜单
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
SCRIPT_SRC="$(cd "$(dirname "$0")" && pwd)"

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

# ---------- 2. 安装依赖 ----------
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

# ---------- 3. 部署服务管理器（自动从 GitHub 下载辅助脚本） ----------
GITHUB_RAW="https://raw.githubusercontent.com/wenqv4617-art/Xvshishiapk/main"

download_file() {
  local url="$1" dest="$2"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$url" -o "$dest" 2>/dev/null
  elif command -v wget >/dev/null 2>&1; then
    wget -q "$url" -O "$dest" 2>/dev/null
  else
    return 1
  fi
}

install_manager() {
  step "部署服务管理器..."
  local svc="$SCRIPT_SRC/xvshishi-services.sh"
  local proxy="$SCRIPT_SRC/cors-proxy.js"
  local svc_url="$GITHUB_RAW/termux/xvshishi-services.sh"
  local proxy_url="$GITHUB_RAW/termux/cors-proxy.js"

  # 优先使用同目录文件，否则自动从 GitHub 下载
  if [ -f "$svc" ]; then
    cp "$svc" "$XSH_DIR/xvshishi-services.sh"
    chmod +x "$XSH_DIR/xvshishi-services.sh"
    ok "服务管理器已安装: $XSH_DIR/xvshishi-services.sh"
  else
    warn "同目录未找到 xvshishi-services.sh，尝试从 GitHub 自动下载..."
    if download_file "$svc_url" "$XSH_DIR/xvshishi-services.sh"; then
      chmod +x "$XSH_DIR/xvshishi-services.sh"
      ok "服务管理器已从 GitHub 下载: $XSH_DIR/xvshishi-services.sh"
    else
      fail "自动下载失败，请检查网络后重试"
    fi
  fi

  if [ -f "$proxy" ]; then
    cp "$proxy" "$XSH_DIR/cors-proxy.js"
    ok "CORS 跨域中转脚本已安装: $XSH_DIR/cors-proxy.js"
  else
    warn "同目录未找到 cors-proxy.js，尝试从 GitHub 自动下载..."
    if download_file "$proxy_url" "$XSH_DIR/cors-proxy.js"; then
      ok "CORS 跨域中转脚本已从 GitHub 下载: $XSH_DIR/cors-proxy.js"
    else
      warn "自动下载失败（网页版才需要 CORS 中转，可跳过）"
    fi
  fi
}

# ---------- 主流程 ----------
banner
setup_dirs
install_deps
install_manager

if [ -f "$XSH_DIR/xvshishi-services.sh" ]; then
  echo ""
  ok "部署完成！即将进入服务管理器（可独立启停每个脚本）..."
  echo ""
  sleep 1
  exec bash "$XSH_DIR/xvshishi-services.sh" tui
else
  echo ""
  warn "服务管理器未就位。可手动执行: bash $SCRIPT_SRC/xvshishi-services.sh"
  echo "  或先安装依赖后直接启动网易云 API: NeteaseCloudMusicApi -p 3000"
fi
