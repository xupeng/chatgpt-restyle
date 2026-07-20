#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd -P)"
INJECTOR="$SCRIPT_DIR/injector.mjs"
STATE_ROOT="$HOME/Library/Application Support/ChatGPTRestyle"
STATE_PATH="$STATE_ROOT/state.json"
INJECTOR_LOG="$STATE_ROOT/injector.log"
INJECTOR_ERROR_LOG="$STATE_ROOT/injector-error.log"
APP_LOG="$STATE_ROOT/chatgpt-launch.log"
APP_ERROR_LOG="$STATE_ROOT/chatgpt-launch-error.log"
PORT_CONFIG_PATH="$PROJECT_ROOT/.env"
EXPECTED_CHATGPT_TEAM_ID="2DC432GLL2"
EXPECTED_CHATGPT_REQUIREMENT="anchor apple generic and certificate leaf[subject.OU] = \"$EXPECTED_CHATGPT_TEAM_ID\""

fail() {
  printf 'ChatGPT Restyle: %s\n' "$*" >&2
  exit 1
}

ensure_state_root() {
  /bin/mkdir -p "$STATE_ROOT"
  [ ! -L "$STATE_ROOT" ] || fail "状态目录不能是符号链接：$STATE_ROOT"
  [ "$(/usr/bin/stat -f '%Su' "$STATE_ROOT")" = "$(/usr/bin/id -un)" ] \
    || fail "状态目录不属于当前用户：$STATE_ROOT"
  /bin/chmod 700 "$STATE_ROOT"
}

discover_chatgpt_app() {
  local candidate identifier executable_name configured="${CHATGPT_APP_BUNDLE:-}"
  CHATGPT_BUNDLE=""
  for candidate in "$configured" \
    "/Applications/ChatGPT.app" "$HOME/Applications/ChatGPT.app"; do
    [ -n "$candidate" ] || continue
    [ -f "$candidate/Contents/Info.plist" ] || continue
    identifier="$(/usr/bin/plutil -extract CFBundleIdentifier raw -o - "$candidate/Contents/Info.plist" 2>/dev/null || true)"
    if [ "$identifier" = "com.openai.codex" ]; then CHATGPT_BUNDLE="$candidate"; break; fi
  done
  [ -n "$CHATGPT_BUNDLE" ] || fail "找不到官方 ChatGPT 应用（com.openai.codex）。"
  executable_name="$(/usr/bin/plutil -extract CFBundleExecutable raw -o - "$CHATGPT_BUNDLE/Contents/Info.plist")"
  CHATGPT_EXE="$CHATGPT_BUNDLE/Contents/MacOS/$executable_name"
  [ -x "$CHATGPT_EXE" ] || fail "ChatGPT 可执行文件不存在：$CHATGPT_EXE"
  export CHATGPT_BUNDLE CHATGPT_EXE
}

codesign_team_id() {
  /usr/bin/codesign -dv --verbose=4 "$1" 2>&1 \
    | /usr/bin/awk -F= '/^TeamIdentifier=/{print $2; exit}'
}

require_macos_runtime() {
  local app_team node_team node_major machine_arch
  [ "$(/usr/bin/uname -s)" = "Darwin" ] || fail "仅支持 macOS。"
  NODE="$CHATGPT_BUNDLE/Contents/Resources/cua_node/bin/node"
  [ -x "$NODE" ] || fail "找不到 ChatGPT 内置 Node：$NODE"
  /usr/bin/codesign --verify --strict --test-requirement "=$EXPECTED_CHATGPT_REQUIREMENT" "$NODE" >/dev/null 2>&1 \
    || fail "ChatGPT 内置 Node 签名校验失败。"
  /usr/bin/codesign --verify --strict --test-requirement "=$EXPECTED_CHATGPT_REQUIREMENT" "$CHATGPT_BUNDLE" >/dev/null 2>&1 \
    || fail "ChatGPT 应用签名校验失败。"
  app_team="$(codesign_team_id "$CHATGPT_BUNDLE")"
  node_team="$(codesign_team_id "$NODE")"
  [ "$app_team" = "$EXPECTED_CHATGPT_TEAM_ID" ] && [ "$node_team" = "$EXPECTED_CHATGPT_TEAM_ID" ] \
    || fail "ChatGPT 或内置 Node 的签名 Team ID 不符合预期。"
  machine_arch="$(/usr/bin/uname -m)"
  /usr/bin/file "$NODE" | /usr/bin/grep -q "$machine_arch" || fail "ChatGPT 内置 Node 架构不匹配。"
  NODE_VERSION="$($NODE --version)"
  node_major="${NODE_VERSION#v}"; node_major="${node_major%%.*}"
  case "$node_major" in ''|*[!0-9]*) fail "无法识别 Node 版本：$NODE_VERSION" ;; esac
  [ "$node_major" -ge 20 ] || fail "需要 Node 20 或更高版本。"
  export NODE NODE_VERSION
}

canonical_existing_path() {
  local input="$1" directory basename
  [ -e "$input" ] || return 1
  directory="$(cd "$(dirname "$input")" 2>/dev/null && pwd -P)" || return 1
  basename="$(basename "$input")"
  printf '%s/%s\n' "$directory" "$basename"
}

process_executable_path() {
  /usr/sbin/lsof -a -p "$1" -d txt -Fn 2>/dev/null \
    | /usr/bin/awk '/^n/{sub(/^n/, ""); print; exit}'
}

pid_is_chatgpt_executable() {
  local actual expected
  actual="$(canonical_existing_path "$(process_executable_path "$1")" 2>/dev/null || true)"
  expected="$(canonical_existing_path "$CHATGPT_EXE" 2>/dev/null || true)"
  [ -n "$actual" ] && [ "$actual" = "$expected" ]
}

process_parent_pid() {
  /bin/ps -p "$1" -o ppid= 2>/dev/null | /usr/bin/awk '{$1=$1; print}'
}

chatgpt_main_pids() {
  local pid command_line
  while read -r pid command_line; do
    [ -n "$pid" ] || continue
    case "$command_line" in "$CHATGPT_EXE"*) pid_is_chatgpt_executable "$pid" && printf '%s\n' "$pid" ;; esac
  done < <(/bin/ps -axo pid=,command=)
}

chatgpt_is_running() { [ -n "$(chatgpt_main_pids)" ]; }

process_started_at() {
  /bin/ps -p "$1" -o lstart= 2>/dev/null | /usr/bin/awk '{$1=$1; print}'
}

listener_pids() {
  /usr/sbin/lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null | /usr/bin/sort -u || true
}

port_is_available() { [ -z "$(listener_pids "$1")" ]; }

load_port_config() {
  local line value normalized declarations=0
  CONFIGURED_CDP_PORT=""
  [ -e "$PORT_CONFIG_PATH" ] || return 0
  [ -f "$PORT_CONFIG_PATH" ] && [ ! -L "$PORT_CONFIG_PATH" ] \
    || fail "端口配置必须是普通文件且不能是符号链接：$PORT_CONFIG_PATH"

  while IFS= read -r line || [ -n "$line" ]; do
    if [[ "$line" =~ ^[[:space:]]*($|#) ]]; then continue; fi
    if [[ "$line" =~ ^[[:space:]]*CHATGPT_RESTYLE_PORT([[:space:]]|=|$) ]]; then
      declarations=$((declarations + 1))
      [ "$declarations" -eq 1 ] || fail ".env 中 CHATGPT_RESTYLE_PORT 不能重复配置。"
      if [[ "$line" =~ ^[[:space:]]*CHATGPT_RESTYLE_PORT[[:space:]]*=[[:space:]]*([0-9]+)[[:space:]]*$ ]]; then
        value="${BASH_REMATCH[1]}"
      else
        fail ".env 中 CHATGPT_RESTYLE_PORT 必须是 1024–65535 的整数。"
      fi
      normalized="$value"
      while [ "${normalized#0}" != "$normalized" ]; do normalized="${normalized#0}"; done
      [ -n "$normalized" ] || normalized=0
      [ "${#normalized}" -le 5 ] \
        || fail ".env 中 CHATGPT_RESTYLE_PORT 必须是 1024–65535 的整数。"
      value=$((10#$normalized))
      [ "$value" -ge 1024 ] && [ "$value" -le 65535 ] \
        || fail ".env 中 CHATGPT_RESTYLE_PORT 必须是 1024–65535 的整数。"
      CONFIGURED_CDP_PORT="$value"
    fi
  done < "$PORT_CONFIG_PATH"
}

select_cdp_port() {
  if [ -n "$CONFIGURED_CDP_PORT" ]; then
    port_is_available "$CONFIGURED_CDP_PORT" \
      || fail ".env 配置的端口 $CONFIGURED_CDP_PORT 已被占用。"
    SELECTED_CDP_PORT="$CONFIGURED_CDP_PORT"
    SELECTED_CDP_PORT_SOURCE=configured
    return 0
  fi
  SELECTED_CDP_PORT="$(generate_random_port)" || fail "无法生成可用的随机高位端口。"
  SELECTED_CDP_PORT_SOURCE=random
}

pid_is_chatgpt_descendant() {
  chatgpt_main_pid_for_process "$1" >/dev/null
}

chatgpt_main_pid_for_process() {
  local current="$1" parent depth=0
  while [ "$current" -gt 1 ] 2>/dev/null && [ "$depth" -lt 32 ]; do
    if pid_is_chatgpt_executable "$current"; then
      printf '%s\n' "$current"
      return 0
    fi
    parent="$(process_parent_pid "$current")"
    case "$parent" in ''|*[!0-9]*) return 1 ;; esac
    [ "$parent" -ne "$current" ] || return 1
    current="$parent"; depth=$((depth + 1))
  done
  return 1
}

chatgpt_pid_for_port() {
  local port="$1" pid candidate resolved="" found=false
  while IFS= read -r pid; do
    [ -n "$pid" ] || continue
    found=true
    candidate="$(chatgpt_main_pid_for_process "$pid")" || return 1
    if [ -n "$resolved" ] && [ "$candidate" -ne "$resolved" ]; then return 1; fi
    resolved="$candidate"
  done < <(listener_pids "$port")
  [ "$found" = true ] && printf '%s\n' "$resolved"
}

port_belongs_to_chatgpt() { chatgpt_pid_for_port "$1" >/dev/null; }

verified_cdp_endpoint() {
  local port="$1"
  port_belongs_to_chatgpt "$port" || return 1
  /usr/bin/curl --noproxy '*' --silent --fail --max-time 1 \
    "http://127.0.0.1:${port}/json/version" >/dev/null 2>&1
}

generate_random_port() {
  local attempt raw port
  for attempt in $(/usr/bin/jot 32 1); do
    raw="$(/usr/bin/od -An -N2 -tu2 /dev/urandom | /usr/bin/awk '{$1=$1; print}')"
    case "$raw" in ''|*[!0-9]*) continue ;; esac
    port=$((49152 + raw % 16384))
    if port_is_available "$port"; then printf '%s\n' "$port"; return 0; fi
  done
  return 1
}

wait_for_cdp() {
  local port="$1" deadline=$((SECONDS + 30))
  while [ "$SECONDS" -lt "$deadline" ]; do
    verified_cdp_endpoint "$port" && return 0
    /bin/sleep 0.25
  done
  return 1
}

stop_chatgpt() {
  local pid deadline
  chatgpt_is_running || return 0
  /usr/bin/osascript -e 'tell application id "com.openai.codex" to quit' >/dev/null 2>&1 || true
  deadline=$((SECONDS + 15))
  while chatgpt_is_running && [ "$SECONDS" -lt "$deadline" ]; do /bin/sleep 0.25; done
  if chatgpt_is_running; then
    while IFS= read -r pid; do [ -n "$pid" ] && /bin/kill -TERM "$pid" 2>/dev/null || true; done < <(chatgpt_main_pids)
  fi
  deadline=$((SECONDS + 5))
  while chatgpt_is_running && [ "$SECONDS" -lt "$deadline" ]; do /bin/sleep 0.25; done
  chatgpt_is_running && fail "无法安全停止 ChatGPT。"
}

launch_chatgpt_with_cdp() {
  local port="$1"
  : > "$APP_LOG"; : > "$APP_ERROR_LOG"
  /usr/bin/open -na "$CHATGPT_BUNDLE" --args \
    --remote-debugging-address=127.0.0.1 --remote-debugging-port="$port" \
    >>"$APP_LOG" 2>>"$APP_ERROR_LOG"
}

launch_chatgpt_normally() { /usr/bin/open -na "$CHATGPT_BUNDLE"; }

state_file_is_safe() {
  [ -f "$STATE_PATH" ] && [ ! -L "$STATE_PATH" ] || return 1
  [ "$(/usr/bin/stat -f '%Lp' "$STATE_PATH" 2>/dev/null || true)" = "600" ] \
    && [ "$(/usr/bin/stat -f '%Su' "$STATE_PATH" 2>/dev/null || true)" = "$(/usr/bin/id -un)" ]
}

state_field() {
  local key="$1"
  state_file_is_safe || return 1
  "$NODE" -e '
    const fs = require("node:fs");
    const [file, key] = process.argv.slice(1);
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    const value = data[key];
    if (typeof value !== "string" && typeof value !== "number") process.exit(2);
    process.stdout.write(String(value));
  ' "$STATE_PATH" "$key"
}

write_state() {
  local port="$1" injector_pid="$2" injector_started_at="$3" injector_label="$4"
  local chatgpt_pid="$5" chatgpt_started_at="$6"
  local temporary="$STATE_PATH.$$.tmp"
  "$NODE" -e '
    const fs = require("node:fs");
    const [file, port, injectorPid, injectorStartedAt, injectorLabel, chatgptPid, chatgptStartedAt, node, injector, exe] = process.argv.slice(1);
    const state = { schemaVersion: 2, port: Number(port), injectorPid: Number(injectorPid), injectorStartedAt,
      injectorLabel, chatgptPid: Number(chatgptPid), chatgptStartedAt, node, injector, chatgptExe: exe,
      createdAt: new Date().toISOString() };
    fs.writeFileSync(file, JSON.stringify(state, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  ' "$temporary" "$port" "$injector_pid" "$injector_started_at" "$injector_label" \
    "$chatgpt_pid" "$chatgpt_started_at" "$NODE" "$INJECTOR" "$CHATGPT_EXE"
  /bin/chmod 600 "$temporary"
  /bin/mv "$temporary" "$STATE_PATH"
}

recorded_injector_matches() {
  local pid="$1" expected_start="$2" expected_node="$3" expected_injector="$4" expected_port="$5"
  local command_line actual_start
  /bin/kill -0 "$pid" 2>/dev/null || return 1
  command_line="$(/bin/ps -p "$pid" -o command= 2>/dev/null || true)"
  case "$command_line" in "$expected_node $expected_injector --watch --port $expected_port"*) ;; *) return 1 ;; esac
  actual_start="$(process_started_at "$pid")"
  [ -n "$actual_start" ] && [ "$actual_start" = "$expected_start" ]
}

recorded_chatgpt_matches() {
  local pid="$1" expected_start="$2" expected_exe="$3" actual_start canonical_saved canonical_current
  canonical_saved="$(canonical_existing_path "$expected_exe" 2>/dev/null || true)"
  canonical_current="$(canonical_existing_path "$CHATGPT_EXE" 2>/dev/null || true)"
  [ -n "$canonical_saved" ] && [ "$canonical_saved" = "$canonical_current" ] || return 1
  pid_is_chatgpt_executable "$pid" || return 1
  actual_start="$(process_started_at "$pid")"
  [ -n "$actual_start" ] && [ "$actual_start" = "$expected_start" ]
}

injector_label_for_port() {
  printf 'com.xupeng.chatgpt-restyle.%s\n' "$1"
}

submitted_job_pid() {
  local label="$1"
  /bin/launchctl print "gui/$(/usr/bin/id -u)/$label" 2>/dev/null \
    | /usr/bin/awk '/^[[:space:]]*pid = [0-9]+$/{print $3; exit}' \
    || true
}

job_is_submitted() {
  /bin/launchctl print "gui/$(/usr/bin/id -u)/$1" >/dev/null 2>&1
}

wait_for_job_removal() {
  local label="$1" deadline=$((SECONDS + 5))
  while job_is_submitted "$label" && [ "$SECONDS" -lt "$deadline" ]; do
    /bin/sleep 0.1
  done
  ! job_is_submitted "$label"
}

stop_recorded_injector() {
  local schema_version pid started node injector label expected_label port deadline
  [ -f "$STATE_PATH" ] || return 0
  schema_version="$(state_field schemaVersion)" || fail "state.json 中缺少 schemaVersion。"
  pid="$(state_field injectorPid)" || fail "state.json 中缺少 injectorPid。"
  started="$(state_field injectorStartedAt)" || fail "state.json 中缺少 injectorStartedAt。"
  node="$(state_field node)" || fail "state.json 中缺少 node。"
  injector="$(state_field injector)" || fail "state.json 中缺少 injector。"
  port="$(state_field port)" || fail "state.json 中缺少 port。"
  case "$schema_version" in
    1) label="" ;;
    2) label="$(state_field injectorLabel)" || fail "state.json 中缺少 injectorLabel。" ;;
    *) fail "不支持的 state.json schemaVersion：$schema_version" ;;
  esac
  if [ -n "$label" ]; then
    expected_label="$(injector_label_for_port "$port")"
    [ "$label" = "$expected_label" ] || fail "记录的 injector launchd label 不符合预期。"
  fi
  if ! /bin/kill -0 "$pid" 2>/dev/null; then
    [ -z "$label" ] || /bin/launchctl remove "$label" >/dev/null 2>&1 || true
    [ -z "$label" ] || wait_for_job_removal "$label" \
      || fail "injector launchd job 未能按时移除。"
    return 0
  fi
  recorded_injector_matches "$pid" "$started" "$node" "$injector" "$port" \
    || fail "记录的 injector 进程身份不匹配，拒绝结束该进程。"
  if [ -n "$label" ]; then
    /bin/launchctl remove "$label" >/dev/null 2>&1 || /bin/kill -TERM "$pid"
  else
    /bin/kill -TERM "$pid"
  fi
  deadline=$((SECONDS + 6))
  while /bin/kill -0 "$pid" 2>/dev/null && [ "$SECONDS" -lt "$deadline" ]; do /bin/sleep 0.2; done
  if /bin/kill -0 "$pid" 2>/dev/null; then
    recorded_injector_matches "$pid" "$started" "$node" "$injector" "$port" \
      || fail "injector 未按时退出且进程身份已变化，拒绝强制结束。"
    /bin/kill -KILL "$pid"
    deadline=$((SECONDS + 3))
    while /bin/kill -0 "$pid" 2>/dev/null && [ "$SECONDS" -lt "$deadline" ]; do /bin/sleep 0.2; done
  fi
  /bin/kill -0 "$pid" 2>/dev/null && fail "injector 未能按时退出。"
  [ -z "$label" ] || wait_for_job_removal "$label" \
    || fail "injector launchd job 未能按时移除。"
}

launch_injector() {
  local port="$1" chatgpt_pid="$2" label pid deadline attempt
  : > "$INJECTOR_LOG"; : > "$INJECTOR_ERROR_LOG"
  label="$(injector_label_for_port "$port")"
  for attempt in 1 2 3; do
    /bin/launchctl remove "$label" >/dev/null 2>&1 || true
    if wait_for_job_removal "$label"; then
      # launchd can briefly reject reuse after `print` stops showing a removed submitted job.
      /bin/sleep 0.2
      if /bin/launchctl submit -l "$label" -o "$INJECTOR_LOG" -e "$INJECTOR_ERROR_LOG" -- \
        "$NODE" "$INJECTOR" --watch --port "$port" --chatgpt-pid "$chatgpt_pid"; then
        deadline=$((SECONDS + 5))
        while [ "$SECONDS" -lt "$deadline" ]; do
          pid="$(submitted_job_pid "$label")"
          if [ -n "$pid" ] && /bin/kill -0 "$pid" 2>/dev/null; then
            printf '%s %s\n' "$pid" "$label"
            return 0
          fi
          /bin/sleep 0.1
        done
      fi
    fi
    /bin/launchctl remove "$label" >/dev/null 2>&1 || true
    wait_for_job_removal "$label" || true
  done
  fail "injector 启动失败，请查看 $INJECTOR_ERROR_LOG"
}
