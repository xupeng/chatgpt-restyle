# Shell Scripts

> Conventions for the macOS Bash tier: `scripts/common-macos.sh` and the
> `*-macos.sh` entry points, plus the `*.command` wrappers and Raycast script.

---

## Baseline

Every script starts with:

```bash
#!/bin/bash

set -euo pipefail
. "$(cd "$(dirname "$0")" && pwd -P)/common-macos.sh"
```

- **`set -euo pipefail` always** — no exceptions. Any unhandled failure aborts
  loudly instead of limping on.
- **Sourcing is path-safe**: `common-macos.sh` is resolved from the script's
  own directory, so the whole family works from any CWD (Terminal, Finder
  double-click, Raycast).
- **`common-macos.sh` holds all shared functions**; entry scripts only
  orchestrate. Never redefine a helper in an entry script
  (`port_is_available` overrides in tests are the only sanctioned exception).

---

## System tool discipline

Call macOS system tools by **absolute path** and never rely on PATH:

| Purpose | Tool |
|---------|------|
| Diagnostics / process info | `/usr/bin/awk`, `/bin/ps`, `/usr/sbin/lsof` |
| Launch agents/jobs | `/bin/launchctl` |
| Property lists | `/usr/bin/plutil` |
| Code signing | `/usr/bin/codesign` |
| HTTP probe | `/usr/bin/curl --noproxy '*' --silent --fail --max-time 1` |
| User prompt | `/usr/bin/osascript` (AppleScript) |
| Random port | `/usr/bin/jot` + `/usr/bin/od` |
| File ops | `/bin/mkdir`, `/bin/chmod`, `/bin/mv`, `/bin/rm`, `/bin/sleep`, `/bin/kill` |

Rules:
- `curl` probes must pass `--noproxy '*'` (a local loopback endpoint must not
  go through a proxy).
- Never use `grep` on binary/signature data — `codesign --verify --strict`
  is the signature check; `file`/`ps`/`lsof` output parsing uses `/usr/bin/awk`
  with explicit field cuts.
- Random ports come from `/dev/urandom` via `/usr/bin/od`, ranged into
  `49152–65535` (IANA dynamic range) with `port_is_available` retries — see
  `generate_random_port` and its test.

---

## Error contract: `fail()`

```bash
fail() {
  printf 'ChatGPT Restyle: %s\n' "$*" >&2
  exit 1
}
```

- All user-facing errors go through `fail` — **Chinese messages**, prefixed
  `ChatGPT Restyle: `, on stderr.
- `fail` is the only exit path for detected problems; `exit 0` only for
  "nothing to do" cases (e.g. `Status` when `state.json` is absent).
- State-corruption and identity-mismatch errors use specific messages so
  `apply-macos.sh`'s troubleshooting path ("请先运行 Status 排查") stays honest.

---

## Config loading (`.env`)

`load_config` parses `$PROJECT_ROOT/.env` with strict rules (all covered by
`tests/random-port.test.mjs`):

- Only `CHATGPT_RESTYLE_PORT`, `CHATGPT_RESTYLE_FONT_ENABLED`,
  `CHATGPT_RESTYLE_ZOOM_ENABLED` are read; unrelated keys are ignored.
- Each key may appear **at most once** — duplicates `fail`.
- `PORT` must match `^\s*PORT\s*=\s*([0-9]+)\s*$`; leading zeros stripped,
  then validated to 1024–65535. Anything else fails with the same message
  (no silent fallback to random).
- Feature switches must be exactly lowercase `true`/`false`.
- `.env` must be a regular file, not a symlink.
- Unset keys default to `true` / random port.

## State file (`state.json`)

Lives at `~/Library/Application Support/ChatGPTRestyle/state.json`
(`STATE_ROOT` / `STATE_PATH`). Hard safety requirements (`state_file_is_safe`
+ `write_state`, tested in `tests/state.test.mjs`):

- Regular file, mode `0600`, owned by the current user — anything else is
  treated as unsafe/unreadable.
- Written atomically: temp file with `flag: "wx"`, mode 0600, then `mv`.
- Schema is versioned (`schemaVersion: 3`); older versions are read via
  `state_feature_enabled` (v1/v2 lack feature flags) and `apply-macos.sh`
  upgrades in place.
- Fields are read with `state_field` (only string/number/boolean pass through).
- `injectorLabel = com.xupeng.chatgpt-restyle.<port>` is derived, not stored
  freely — `stop_recorded_injector` validates it matches the port.

## Process identity verification

Before touching *any* process or endpoint, the scripts verify recorded
identity (`recorded_chatgpt_matches`, `recorded_injector_matches`,
`pid_is_chatgpt_descendant`, `chatgpt_main_pid_for_process`):

- A saved PID is only trusted when its **start time** (`process_started_at`)
  and **executable path** (`process_executable_path` via `lsof -d txt`)
  match the record — this prevents killing a recycled PID.
- The injector command line must match the exact expected pattern
  (`"$NODE $INJECTOR --watch --port $port ..."`).
- `chatgpt_pid_for_port` walks the ancestor chain up to 32 levels to find the
  ChatGPT main process holding a port, and requires a single consistent
  answer.
- `verify_cdp_endpoint` requires the port to belong to a ChatGPT process
  **and** respond to `/json/version` before any CDP traffic.

This "verify, then act" discipline is why Restore/Status refuse to operate on
an endpoint that a *different* session owns.

## Launchd watcher management

- The watcher runs via a one-shot **submitted** job
  (`launchctl submit -l <label> -o log -e error-log -- <node> <injector> ...`),
  not a LaunchAgent; it dies with the ChatGPT process and cleans up after
  itself.
- `launch_injector` retries up to 3 times (launchd can briefly reject label
  reuse), waits for a live PID, and fails with the error-log path otherwise.
- `stop_recorded_injector` removes the job by label, falls back to
  `kill -TERM`, re-verifies identity before `kill -KILL`, and only then
  declares failure. It never SIGKILLs an unverified process.

## Wrapper files

- `Apply.command` / `Status.command` / `Restore.command`: thin wrappers that
  `cd` to the repo and exec the matching script.
- `raycast/chatgpt-with-restyle.sh`: Raycast Script Command with the required
  `@raycast.*` headers, `@raycast.mode silent`, validates the apply script
  exists, then `exec`s it (no lingering Raycast window).

## Anti-patterns

- Relying on `PATH` (`node`, `grep`, `curl` unqualified) — use absolute paths.
- Reading or writing `state.json` without the 0600/owner/regular-file guard.
- Killing a PID recorded in `state.json` without matching start-time +
  executable + command-line identity.
- Falling back to a random port when a configured port is invalid — `.env`
  errors must fail loudly (README: "配置无效、重复或端口已被占用时，Apply 会明确报错，
  不会回退到随机端口").
- Putting Chinese prose only in comments — user-facing strings must be
  *output* messages, and error paths must use `fail`.
