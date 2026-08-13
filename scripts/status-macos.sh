#!/bin/bash

set -euo pipefail
. "$(cd "$(dirname "$0")" && pwd -P)/common-macos.sh"

discover_chatgpt_app
require_macos_runtime

if [ ! -f "$STATE_PATH" ]; then
  printf '状态：未启用\n'
  exit 0
fi

port="$(state_field port)" || fail "state.json 不安全或已损坏。"
injector_pid="$(state_field injectorPid)" || fail "state.json 缺少 injectorPid。"
injector_started="$(state_field injectorStartedAt)" || fail "state.json 缺少 injectorStartedAt。"
saved_node="$(state_field node)" || fail "state.json 缺少 node。"
saved_injector="$(state_field injector)" || fail "state.json 缺少 injector。"
saved_chatgpt_pid="$(state_field chatgptPid)" || fail "state.json 缺少 chatgptPid。"
saved_chatgpt_started="$(state_field chatgptStartedAt)" || fail "state.json 缺少 chatgptStartedAt。"
saved_chatgpt_exe="$(state_field chatgptExe)" || fail "state.json 缺少 chatgptExe。"
schema_version="$(state_field schemaVersion)" || fail "state.json 缺少 schemaVersion。"
saved_font_enabled="$(state_feature_enabled fontEnabled "$schema_version")" \
  || fail "state.json 缺少有效的 fontEnabled。"
saved_zoom_enabled="$(state_feature_enabled zoomEnabled "$schema_version")" \
  || fail "state.json 缺少有效的 zoomEnabled。"
identity_font_enabled=""
identity_zoom_enabled=""
if [ "$schema_version" -eq 3 ]; then
  identity_font_enabled="$saved_font_enabled"
  identity_zoom_enabled="$saved_zoom_enabled"
fi

verified_cdp_endpoint "$port" || fail "记录的端口不是当前 ChatGPT 的 loopback CDP endpoint。"
recorded_chatgpt_matches "$saved_chatgpt_pid" "$saved_chatgpt_started" "$saved_chatgpt_exe" \
  || fail "ChatGPT 进程身份校验失败。"
recorded_injector_matches "$injector_pid" "$injector_started" \
  "$saved_node" "$saved_injector" "$port" \
  "$identity_font_enabled" "$identity_zoom_enabled" \
  || fail "injector 进程身份校验失败。"

output="$($NODE "$INJECTOR" --status --port "$port" --timeout-ms 5000)"
printf '状态：已启用\n当前端口：%s\ninjector PID：%s\n%s\n' "$port" "$injector_pid" "$output"
if printf '%s' "$output" | /usr/bin/grep -q '"fontEnabled": true' \
  && printf '%s' "$output" | /usr/bin/grep -q '"fontAvailable": false'; then
  printf '提示：未同时检测到 Oxanium 和 LXGW WenKai Screen；英文或中文会回退到系统字体。\n'
fi
