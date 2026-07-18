#!/bin/bash

set -euo pipefail
. "$(cd "$(dirname "$0")" && pwd -P)/common-macos.sh"

ensure_state_root
discover_chatgpt_app
require_macos_runtime
load_port_config

if [ -f "$STATE_PATH" ]; then
  port="$(state_field port)" || fail "现有 state.json 不安全或已损坏。"
  injector_pid="$(state_field injectorPid)" || fail "现有 state.json 缺少 injectorPid。"
  injector_started="$(state_field injectorStartedAt)" || fail "现有 state.json 缺少 injectorStartedAt。"
  saved_node="$(state_field node)" || fail "现有 state.json 缺少 node。"
  saved_injector="$(state_field injector)" || fail "现有 state.json 缺少 injector。"
  saved_chatgpt_pid="$(state_field chatgptPid)" || fail "现有 state.json 缺少 chatgptPid。"
  saved_chatgpt_started="$(state_field chatgptStartedAt)" || fail "现有 state.json 缺少 chatgptStartedAt。"
  saved_chatgpt_exe="$(state_field chatgptExe)" || fail "现有 state.json 缺少 chatgptExe。"
  if verified_cdp_endpoint "$port" \
    && recorded_chatgpt_matches "$saved_chatgpt_pid" "$saved_chatgpt_started" "$saved_chatgpt_exe" \
    && recorded_injector_matches "$injector_pid" "$injector_started" "$saved_node" "$saved_injector" "$port"; then
    "$NODE" "$INJECTOR" --once --port "$port"
    printf 'ChatGPT Restyle 已重新应用；当前端口：%s\n' "$port"
    if [ -n "$CONFIGURED_CDP_PORT" ] && [ "$CONFIGURED_CDP_PORT" -ne "$port" ]; then
      printf '提示：.env 配置端口 %s 将在下次 ChatGPT Restyle 会话启动时生效。\n' \
        "$CONFIGURED_CDP_PORT"
    fi
    exit 0
  fi
  if /bin/kill -0 "$injector_pid" 2>/dev/null; then
    fail "现有 state 对应一个无法验证身份的活动进程，请先运行 Status 排查。"
  fi
  /bin/rm -f "$STATE_PATH"
fi

if chatgpt_is_running; then
  if ! /usr/bin/osascript -e 'display dialog "ChatGPT 需要重启一次才能应用排版。" buttons {"取消", "重启并应用"} default button "重启并应用" with title "ChatGPT Restyle"' >/dev/null; then
    printf '操作已取消，ChatGPT 未改变。\n'
    exit 0
  fi
  stop_chatgpt
fi

select_cdp_port
port="$SELECTED_CDP_PORT"
if [ "$SELECTED_CDP_PORT_SOURCE" = configured ]; then
  printf '使用 .env 配置的 loopback 端口启动 ChatGPT：%s\n' "$port"
else
  printf '使用随机 loopback 端口启动 ChatGPT：%s\n' "$port"
fi
launch_chatgpt_with_cdp "$port"
if ! wait_for_cdp "$port"; then
  stop_chatgpt
  fail "ChatGPT 未能打开 CDP 端口 $port；请查看 $APP_ERROR_LOG"
fi

chatgpt_pid="$(chatgpt_main_pids | /usr/bin/head -n 1)"
[ -n "$chatgpt_pid" ] || fail "无法记录 ChatGPT PID。"
chatgpt_started="$(process_started_at "$chatgpt_pid")"
read -r injector_pid injector_label < <(launch_injector "$port" "$chatgpt_pid")
injector_started="$(process_started_at "$injector_pid")"
write_state "$port" "$injector_pid" "$injector_started" "$injector_label" \
  "$chatgpt_pid" "$chatgpt_started"

if ! "$NODE" "$INJECTOR" --once --port "$port" --timeout-ms 20000; then
  stop_recorded_injector || true
  /bin/rm -f "$STATE_PATH"
  fail "排版注入验证失败，请查看 $INJECTOR_ERROR_LOG"
fi

if [ "$SELECTED_CDP_PORT_SOURCE" = configured ]; then
  printf 'ChatGPT Restyle 已启用；固定端口：%s\n' "$port"
else
  printf 'ChatGPT Restyle 已启用；随机端口：%s\n' "$port"
fi
