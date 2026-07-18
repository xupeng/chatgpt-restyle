#!/bin/bash

set -euo pipefail
. "$(cd "$(dirname "$0")" && pwd -P)/common-macos.sh"

for file in \
  "$PROJECT_ROOT/assets/chat-typography.css" \
  "$PROJECT_ROOT/assets/renderer-inject.js" \
  "$PROJECT_ROOT/scripts/injector.mjs"; do
  [ -f "$file" ] || fail "缺少文件：$file"
done

if /usr/bin/grep -Eiq 'Songti|STSong' "$PROJECT_ROOT/assets/chat-typography.css"; then
  fail "CSS 中不应包含宋体 fallback。"
fi
/usr/bin/grep -q '^\.chatgpt-chat-typography-thread' "$PROJECT_ROOT/assets/chat-typography.css" \
  || fail "CSS 缺少对话容器作用域。"

for script in "$PROJECT_ROOT"/*.command "$PROJECT_ROOT/scripts"/*.sh; do /bin/bash -n "$script"; done
discover_chatgpt_app
require_macos_runtime
"$NODE" --check "$PROJECT_ROOT/scripts/injector.mjs"
printf 'PASS: ChatGPT Restyle 文件、Shell、Node、ChatGPT 签名和内置 runtime 检查通过。\n'
