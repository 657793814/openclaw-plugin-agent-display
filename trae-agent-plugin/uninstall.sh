#!/usr/bin/env bash
# 卸载 NEBULA 作战大屏 agent 插件（仅当前版本目录）。
# 不动 extensions/、Trae 安装目录，也不删除其他已安装版本。
set -euo pipefail

PUBLISHER="nebula-lab"
NAME="nebula-screen"
PLUGIN="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST="$(dirname "$PLUGIN")"

if [ ! -d "$PLUGIN" ]; then
  echo "未安装：$PLUGIN 不存在" >&2
  exit 0
fi

# 1) 优先走 stop.mjs（会清 state 文件，并校验 PID 归属）
if [ -f "$PLUGIN/bin/stop.mjs" ]; then
  node "$PLUGIN/bin/stop.mjs" >/dev/null 2>&1 || true
fi

# 2) 兜底：state.json 里还有活着的 pid 就按 pid 结束
STATE="$PLUGIN/.runtime/state.json"
if [ -f "$STATE" ]; then
  PID="$(node -e "try{const s=require('fs').readFileSync(process.argv[1],'utf8');process.stdout.write(String(JSON.parse(s).pid||''))}catch{}" "$STATE" 2>/dev/null || true)"
  if [ -n "${PID:-}" ] && kill -0 "$PID" 2>/dev/null; then
    kill "$PID" 2>/dev/null || true
    sleep 1
    kill -9 "$PID" 2>/dev/null || true
  fi
fi

rm -rf "$PLUGIN"
# 只有在该插件下再无其他版本时才移除父目录
rmdir "$DEST" 2>/dev/null || true
echo "removed: $PLUGIN"
