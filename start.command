#!/bin/sh
# macOS 双击启动；Windows / Linux 用 npm start。
# 关闭终端窗口或按 Ctrl+C 即停止服务。
cd "$(dirname "$0")" || exit 1

NODE_BIN="$(command -v node 2>/dev/null)"
if [ -z "$NODE_BIN" ]; then
  echo "找不到 Node.js（需要 >= 18）。请安装 Node 后重试。"
  echo "macOS: brew install node    或 https://nodejs.org"
  exit 1
fi

NODE_MAJOR=$("$NODE_BIN" -p "process.versions.node.split('.')[0]" 2>/dev/null)
if [ -n "$NODE_MAJOR" ] && [ "$NODE_MAJOR" -lt 18 ] 2>/dev/null; then
  echo "Node 版本过低（需要 >= 18，当前 $NODE_MAJOR）。请升级 Node。"
  exit 1
fi

echo "BGM Grab 启动中…  浏览器将自动打开本地地址。"
echo "停止服务：按 Ctrl+C 或关闭本窗口。"
exec "$NODE_BIN" server.mjs
