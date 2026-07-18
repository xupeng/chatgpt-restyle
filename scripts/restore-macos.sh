#!/bin/bash

set -euo pipefail
. "$(cd "$(dirname "$0")" && pwd -P)/common-macos.sh"

discover_chatgpt_app
require_macos_runtime

if [ ! -f "$STATE_PATH" ]; then
  printf 'ChatGPT Restyle 当前没有活动状态。\n'
  exit 0
fi

port="$(state_field port)" || fail "state.json 不安全或已损坏。"
saved_chatgpt_pid="$(state_field chatgptPid)" || fail "state.json 缺少 chatgptPid。"
saved_chatgpt_started="$(state_field chatgptStartedAt)" || fail "state.json 缺少 chatgptStartedAt。"
saved_chatgpt_exe="$(state_field chatgptExe)" || fail "state.json 缺少 chatgptExe。"
if verified_cdp_endpoint "$port"; then
  recorded_chatgpt_matches "$saved_chatgpt_pid" "$saved_chatgpt_started" "$saved_chatgpt_exe" \
    || fail "记录的 ChatGPT 进程身份不匹配，拒绝操作 renderer。"
  "$NODE" "$INJECTOR" --remove --port "$port" --timeout-ms 5000 || fail "无法确认 renderer 样式已移除。"
fi
stop_recorded_injector
chatgpt_is_running && stop_chatgpt
/bin/rm -f "$STATE_PATH"
launch_chatgpt_normally
printf 'ChatGPT Restyle 已恢复；ChatGPT 已按正常模式启动。\n'
