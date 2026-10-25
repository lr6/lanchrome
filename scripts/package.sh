#!/usr/bin/env bash
# 打包 Chrome Web Store 上传包：只包含运行所需文件，manifest.json 位于 ZIP 根目录。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="$(node -p "require('$ROOT/manifest.json').version")"
OUT_DIR="$ROOT/dist"
OUT="$OUT_DIR/tidyfollows-$VERSION.zip"

cd "$ROOT"

for f in background.js src/page/agent.js src/page/bridge.js \
         src/ui/popup.js src/ui/dashboard.js; do
  node --check "$f" >/dev/null
done

mkdir -p "$OUT_DIR"
rm -f "$OUT"

zip -r -X "$OUT" manifest.json background.js src icons \
  -x '*.DS_Store' -x '__MACOSX/*' >/dev/null

echo "已生成：$OUT"
unzip -Z1 "$OUT"
