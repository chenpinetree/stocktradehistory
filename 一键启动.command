#!/bin/zsh
set -e

APP_DIR="/Users/chen/Downloads/stocktradehistory"

if [ ! -d "$APP_DIR" ]; then
  echo "未找到应用目录: $APP_DIR"
  echo "请先确认项目已创建完成。"
  read -k 1 "?按任意键退出..."
  echo
  exit 1
fi

cd "$APP_DIR"

if [ ! -d "node_modules" ]; then
  echo "首次启动，正在安装依赖..."
  npm install
fi

echo "正在编译本地数据库驱动（better-sqlite3）以匹配 Electron..."
npm run rebuild:electron

echo "正在启动本地应用..."
echo "目录: $APP_DIR"
npm run dev
