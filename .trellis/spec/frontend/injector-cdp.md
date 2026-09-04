# CDP Injector

> Conventions for `scripts/injector.mjs` — the Node CDP client, payload
> builder, and background watcher. Node ESM, zero dependencies, Node >= 20.

---

## Module shape

The module is a mix of **exported pure functions** (unit-tested directly) and
**internal side-effecting machinery**:

```js
// Exported (pure, unit-tested in tests/injector.test.mjs)
export function stateBelongsToWatcher(state, pid, port) { ... }
export async function removeOwnedState(statePath, pid, port) { ... }
export function validatedDebuggerUrl(target, port) { ... }
export function isValidCdpPageTarget(target, port) { ... }
export function parseArgs(argv) { ... }
export function processIsAlive(pid) { ... }
export async function inlineGoogleFontCss(fetchImpl = fetch) { ... }
export async function buildPayload(options, fontCss = "") { ... }
export function earlyPayloadFor(payload, revision) { ... }
export async function statusOf(session) { ... }

// Internal
class CdpSession { ... }        // WebSocket wrapper with id/waiter map + timeouts
async function listTargets(port) { ... }
async function connectChatGPTTargets(port, timeoutMs) { ... }
async function runOneShot(options) { ... }
async function runWatch(options) { ... }
async function main() { ... }   // guarded by import.meta.url === main check
```

Rules:
- **Pure, deterministic logic goes in exported functions** so tests can call
  them without a live ChatGPT (see the test file's `validTarget` fixture and
  injected `fetchImpl` for `inlineGoogleFontCss`).
- **Entry point is guarded**: the whole module runs only when executed
  directly (`import.meta.url === pathToFileURL(process.argv[1] || "").href`),
  so `tests/*.test.mjs` can import it safely.
- Exported functions that touch the filesystem take paths as parameters
  (`removeOwnedState(statePath, pid, port)`), never read globals.

---

## CLI contract (`parseArgs`)

Four mutually exclusive modes: `--watch`, `--once`, `--remove`, `--status`.

- Exactly one mode required, exactly one allowed — duplicate modes throw
  `"Choose exactly one mode"` / `"Choose --watch, --once, --remove, or --status"`.
- `--port` required, integer 1024–65535 (throws otherwise). `--chatgpt-pid`
  only valid with `--watch`. `--timeout-ms` defaults 15000.
- Feature switches take **only lowercase** `true`/`false`
  (`--font-enabled`, `--zoom-enabled`); anything else throws.
- Unknown arguments throw — never silently ignore.
- Result is a plain options object with defaults
  (`fontEnabled: true`, `zoomEnabled: true`).

Adding a flag means updating `parseArgs`, `main`/callers, `apply-macos.sh` (and
`common-macos.sh` `load_config` / `recorded_injector_matches` command-line
pattern when it changes the watcher invocation), plus `tests/injector.test.mjs`.

---

## Security posture: verify everything from CDP

The renderer is reached over a loopback CDP port. Nothing from the wire is
trusted until validated:

- `isValidCdpPageTarget` requires `type === "page"`, exact URL
  `app://-/index.html`, a bounded id (`TARGET_ID = /^[A-Za-z0-9._-]{1,200}$/`),
  and a `webSocketDebuggerUrl` that passes `validatedDebuggerUrl`.
- `validatedDebuggerUrl` rejects non-loopback hosts
  (`LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"])`), credentials,
  queries, hashes, wrong ports, and any pathname other than
  `/devtools/page/<id>` (bounded `[A-Za-z0-9._-]{1,200}`).
- `listTargets` fetches `http://127.0.0.1:<port>/json/list` with
  `redirect: "error"` and a 2 s AbortController timeout; non-JSON or
  non-array responses throw.
- `connectChatGPTTargets` probes each candidate with a `probe()` expression
  that must see **both** `main[data-app-shell-main-surface="default"]` and
  `aside.app-shell-left-panel` before accepting it as a ChatGPT renderer. It
  retries until `timeoutMs` deadline, 250 ms apart.
- `CdpSession.send` times out per command (default 10 s), rejects when the
  socket closes, and `evaluate` re-throws `exceptionDetails` so renderer
  exceptions surface as injector errors.

**Never** relax these checks for convenience; they are the boundary between
"styling our app" and "driving an unauthenticated loopback CDP endpoint".

---

## Payload building and revisions

`buildPayload(options, fontCss)`:

1. Reads `assets/chat-typography.css` + `assets/renderer-inject.js`.
2. Optionally prepends the Google Fonts CSS inlined to `data:` URLs
   (`inlineGoogleFontCss` fetches with a Chrome user-agent so Google returns
   the woff2 `@font-face` block, then base64-embeds every
   `fonts.gstatic.com` URL — see the test that asserts no `fonts.gstatic.com`
   survives).
3. Computes `revision = sha256(css + template + config).slice(0, 20)`.
4. Replaces the four `__CHATGPT_RESTYLE_*_JSON__` placeholders
   (always via `JSON.stringify` — values are embedded as JSON, never raw).

The revision drives **everything**:
- `--once` verification: exit code 2 when a target did not install.
- `--status` reporting: `version` field.
- `runWatch` hot reload: `refresh()` rebuilds and re-installs only when the
  revision changes; identical edits are no-ops.
- The early-generation guard in `earlyPayloadFor` (see below).

---

## Early injection and the watcher

`earlyPayloadFor(payload, revision)` wraps the payload so that a new document
evaluates it as soon as both shell markers exist (MutationObserver, 10 s cap),
and **skips** re-install when the page already carries a newer generation
(`window.__CHATGPT_CHAT_TYPOGRAPHY_EARLY_GENERATION__`).

`runWatch` lifecycle:

- Polls `listTargets` every 500 ms; new ChatGPT targets get a `CdpSession`,
  `Page.addScriptToEvaluateOnNewDocument` (early payload), and an immediate
  `evaluate` of the full payload.
- Watches `assets/` with `watchFs`; only `chat-typography.css` /
  `renderer-inject.js` changes trigger a 50 ms-debounced `refresh()`.
- Exits when the recorded `--chatgpt-pid` dies (`processIsAlive`).
- On SIGINT/SIGTERM and normal exit: removes early scripts, closes sessions,
  then deletes `state.json` **only if it owns it**
  (`removeOwnedState` — checks regular file, mode 0600, owner uid, and
  `stateBelongsToWatcher(state, pid, port)`).
- `--once`/`--remove`/`--status` print a JSON status object
  (`{ mode, targets: [...] }`) and set exit code 2 on failure; `--watch`
  logs to `[chatgpt-restyle] ...` prefixed lines for the launchd log files.

---

## Anti-patterns

- Trusting `webSocketDebuggerUrl` from `/json/list` without the loopback +
  pathname validation.
- Accepting any page target (workers, devtools, other apps) as a renderer.
- Skipping the `probe()` double-marker check — a partial shell match can hit
  the wrong document during startup.
- Removing `state.json` unconditionally on watcher exit (must verify
  ownership first — the shell layer relies on it to never kill another
  session's injector).
- Hardcoding ports or URLs instead of passing them through `parseArgs`.
- Using `eval`/`Function` for placeholder substitution instead of
  `template.replace("__TOKEN__", JSON.stringify(value))`.
