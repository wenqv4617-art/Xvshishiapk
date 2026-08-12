#!/data/data/com.termux/files/usr/bin/bash
# ============================================================
# 叙事诗小手机 - 网易云音乐 API 一键部署 (Termux / 安卓手机端)
#
# 用法：
#   1. 安装 Termux（务必用 F-Droid 版，Google Play 版已停更）
#      F-Droid 下载: https://f-droid.org/packages/com.termux/
#   2. 把本文件传到手机（或用文本方式复制内容），在 Termux 中执行：
#      bash termux-ncm-api.sh
#   3. 等脚本跑完，API 就运行在 http://localhost:3000
#
# 部署成功后：
#   - 手机 App 里网易云登录弹窗的 API 地址填: http://localhost:3000
#   - 手机浏览器打开网页版（Vercel 域名）时同样填 http://localhost:3000
#   - 电脑浏览器打开网页版时，填电脑本地 API 或本机 localhost:3000
# ============================================================

set -e

echo "======================================"
echo " 叙事诗小手机 - 网易云 API 一键部署"
echo "======================================"

echo ""
echo "==> 1/5 更新软件源..."
pkg update -y || true

echo ""
echo "==> 2/5 安装 Node.js (LTS)..."
pkg install -y nodejs-lts

echo ""
echo "==> 3/5 安装网易云音乐 API（国内镜像源，耐心等待）..."
npm install -g NeteaseCloudMusicApi --registry=https://registry.npmmirror.com

echo ""
echo "==> 4/5 申请后台保活（防止锁屏后 API 被杀）..."
if command -v termux-wake-lock >/dev/null 2>&1; then
  termux-wake-lock
  echo "    已开启 Termux 保活。"
else
  echo "    未安装 termux-api，跳过保活（可后续安装 termux-api 插件）。"
fi

echo ""
echo "==> 5/5 启动 API 服务 (端口 3000)..."
echo "    看到 'server running @ http://localhost:3000' 即成功！"
echo "    请保持 Termux 在前台或后台运行，勿滑动关闭 Termux。"
echo "    下次启动只需执行:  NeteaseCloudMusicApi -p 3000"
echo ""
NeteaseCloudMusicApi -p 3000
