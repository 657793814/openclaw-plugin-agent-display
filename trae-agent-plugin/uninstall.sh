#!/usr/bin/env bash
# 卸载 NEBULA 作战大屏 agent 插件。
# 只删 ~/.trae-cn/plugins/nebula-lab/nebula-screen/，不动 extensions/ 与 Trae 安装目录。
set -euo pipefail

PUBLISHER="nebula-lab"
NAME="nebula-screen"
DEST="$HOME/.trae-cn/plugins/$PUBLISHER/$NAME"
PLUGIN="$DEST/0.1.0"

if [ ! -d "$DEST" ]; then
  echo "未安装：$DEST 不存在" >&2
  exit 0
fi

# 1) 优先走 stop.mjs（会清 state 文件）
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

rm -rf "$DEST"
echo "removed: $DEST"
