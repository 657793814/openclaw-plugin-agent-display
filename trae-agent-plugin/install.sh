#!/usr/bin/env bash
# 安装 NEBULA 作战大屏 agent 插件到 ~/.trae-cn/plugins/
# 只写 ~/.trae-cn/plugins/，不动 extensions/ 与 Trae 安装目录。
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PUBLISHER="nebula-lab"
NAME="nebula-screen"
VERSION="$(node -e "process.stdout.write(require(process.argv[1]).version)" "$SRC/.trae-plugin/plugin.json")"
DEST="$HOME/.trae-cn/plugins/$PUBLISHER/$NAME/$VERSION"
RUNTIME="$SRC/../trae-ide-ext/media"

if [ ! -f "$RUNTIME/screen.html" ]; then
  echo "找不到渲染资源：$RUNTIME/screen.html" >&2
  exit 1
fi

if [ -f "$DEST/bin/stop.mjs" ]; then
  node "$DEST/bin/stop.mjs" >/dev/null 2>&1 || true
fi

rm -rf "$DEST"
mkdir -p "$DEST/assets/nebula/vendor"
cp -R "$SRC/.trae-plugin" "$SRC/skills" "$SRC/bin" "$SRC/lib" "$SRC/assets" "$DEST/"
cp "$SRC/README.md" "$SRC/uninstall.sh" "$DEST/"
cp "$RUNTIME/screen.html" "$RUNTIME/screen.css" "$RUNTIME/screen.js" "$RUNTIME/nebula-core.js" "$DEST/assets/"
cp "$RUNTIME/nebula/template.html" "$RUNTIME/nebula/theme.js" "$DEST/assets/nebula/"
cp "$RUNTIME/nebula/vendor/"*.js "$DEST/assets/nebula/vendor/"
chmod +x "$DEST/bin/"*.mjs "$DEST/uninstall.sh"

echo "installed: $DEST"
echo "files: $(find "$DEST" -type f | wc -l | tr -d ' ')"
