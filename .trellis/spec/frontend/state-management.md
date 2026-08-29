# State Management

> How configuration and state flow across the three tiers: shell → injector →
> renderer. There is no React/Redux — state is *contracts between layers*.

---

## The five state stores

| Store | Location | Written by | Read by | Persistence |
|-------|----------|-----------|---------|-------------|
| Config | `$PROJECT_ROOT/.env` | Developer (copy of `.env.example`) | `common-macos.sh` `load_config` | File, survives restarts |
| Runtime state | `~/Library/Application Support/ChatGPTRestyle/state.json` | `write_state` (apply) / watcher cleanup | `apply/status/restore` + injector `removeOwnedState` | File, per session |
| Renderer state | `window["__CHATGPT_CHAT_TYPOGRAPHY_STATE__"]` | injected `renderer-inject.js` | itself (re-entry), injector `statusOf`/`--remove` | Memory only (dies with page) |
| Content zoom preference | `localStorage["chatgpt-restyle.contentZoomPercent.v1"]` | renderer (`applyZoomPercent`, `persist: true`) | renderer on load (`readZoomPercent`) + `storage` events | localStorage, survives restarts |
| Terminal zoom preference | `localStorage["chatgpt-restyle.terminalZoomPercent.v1"]` | renderer (`applyTerminalZoomPercent`, `persist: true`) | renderer on load + xterm sync + `storage` events | localStorage, survives restarts |

---

## Config flow: `.env` → CLI → payload

```
.env (CHATGPT_RESTYLE_*)                 — source of truth, shell-only
  └─ load_config (common-macos.sh)       — strict parse, lowercase true/false
       └─ injector args (--port, --font-enabled, --zoom-enabled)
            └─ parseArgs (injector.mjs)  — re-validates everything
                 └─ buildPayload         — fontEnabled/zoomEnabled JSON placeholders
                      └─ renderer IIFE args
```

Rules:
- **The shell parses `.env`; the injector parses CLI args.** Both validate —
  parseArgs is the second line of defense, not a duplicate source of truth.
- Feature flags default to `true` when unset, in both tiers
  (`load_config` defaults and `parseArgs` defaults must stay in sync).
- A configured port takes effect **only on the next session**; the current
  session keeps its port. `apply-macos.sh` prints this hint explicitly.
- The watcher is restarted (not the renderer) when flags change on an existing
  session: `apply-macos.sh` compares `saved_*` vs `CONFIGURED_*` and re-runs
  `launch_injector` in place — ChatGPT keeps running.

## Runtime state: `state.json`

One JSON object, `schemaVersion: 3`, fields:
`port`, `injectorPid`, `injectorStartedAt`, `injectorLabel`, `chatgptPid`,
`chatgptStartedAt`, `node`, `injector`, `chatgptExe`, `fontEnabled`,
`zoomEnabled`, `createdAt`.

- **Ownership**: a watcher deletes `state.json` on exit only when
  `stateBelongsToWatcher(state, process.pid, options.port)` matches (tested).
  `restore-macos.sh` removes it only after killing its own recorded injector.
- **Schema migrations live in the readers**: `state_field` +
  `state_feature_enabled` handle v1/v2 gracefully; new fields bump
  `schemaVersion` and both readers. There is no migration file.
- Every read goes through `state_file_is_safe` (regular file, 0600, owner).

## Renderer state: `window[STATE_KEY]`

The injected script keeps a single state object on `window` so re-injection
and diagnostics share one identity:

```js
window[STATE_KEY] = {
  cleanup, disposeZoom, sync, observer,
  get timer() { return timer; },
  nativeFontFamily,
  get contentZoomPercent() { return contentZoomPercent; },
  get terminalZoomPercent() { return terminalZoomPercent; },
  fontEnabled, zoomEnabled, fontAvailable, version,
};
```

- **Idempotency**: the next evaluation reads `previous = window[STATE_KEY]`,
  calls `previous.cleanup()`, and replaces it (see
  [Renderer Injection](./renderer-injection.md)).
- `statusOf(session)` (injector) evaluates a read-only expression that maps
  this object to the `--status` JSON — it must tolerate a missing state
  (`installed: false`, with both zoom ratios defaulting to `100`).
- `--remove` runs `window[STATE_KEY]?.cleanup?.() ?? true`.
- `nativeFontFamily` survives re-injection through
  `previousNativeFontFamily`, so hot reloads do not re-sample/re-flow.

## Zoom preferences: localStorage

- Content key: `chatgpt-restyle.contentZoomPercent.v1`.
- Terminal key: `chatgpt-restyle.terminalZoomPercent.v1`.
- Both values are decimal strings parsed by `parseZoomPercent`: only `/^\d+$/`
  integers in 60–160 are accepted; anything else becomes `100` (storage access
  is also guarded by `try/catch`).
- The ratios are independent. A shortcut routed to a focused Terminal must not
  write the content key; a shortcut outside Terminal must not write the
  Terminal key.
- `storage` events re-apply the matching ratio in other windows/tasks. A
  `key === null` clear event resets both ratios to `100`.
- Restore/Remove do **not** clear either key (README: "Restore.command 只移除
  当前注入效果，不删除已保存的比例").

### Scenario: Terminal zoom persistence and runtime restoration

#### 1. Scope / Trigger

Use this contract whenever Terminal zoom state, focus routing, xterm runtime
options, storage synchronization, or cleanup behavior changes.

#### 2. Signatures

```js
readZoomPercent(storageKey) -> integer
applyTerminalZoomPercent(nextPercent, { announce = false, persist = false })
onZoomStorage({ key, newValue })
```

#### 3. Contracts

- `terminalZoomPercent` is shared by every mounted `[data-codex-xterm]` in the
  renderer and by other renderer windows through the Terminal storage key.
- Each Terminal record preserves its latest theme-provided `nativeFontSize`.
  The applied xterm size is `nativeFontSize * terminalZoomPercent / 100`.
- Assign through `instance.options.fontSize`; CSS scaling is insufficient
  because xterm measures cell geometry from the runtime option. After every
  injected size change or restore, call the matching FitAddon's `fit()`.
- `disposeZoom()` restores native sizes but leaves the persisted preference;
  a later enabled injection reapplies that preference without compounding it.

#### 4. Validation & Error Matrix

| Condition | Required behavior |
|-----------|-------------------|
| Stored value is an integer from 60 through 160 | Accept it |
| Missing, malformed, fractional, below 60, or above 160 | Use `100` |
| localStorage read/write throws | Continue with in-memory/default state |
| xterm `fontSize` is non-finite, non-number, or non-positive | Do not apply zoom to that instance |
| Runtime option assignment or FitAddon `fit()` throws | Keep other Terminal/font/zoom work running |

#### 5. Good/Base/Bad Cases

- Good: base `13`, ratio `120` -> xterm `15.6`; cleanup -> `13`.
- Base: ratio `100` -> theme size is unchanged.
- Bad: derive the next size from the already-scaled `15.6`; re-injection would
  compound to `18.72` instead of remaining `15.6`.

#### 6. Tests Required

- Assert persisted Terminal zoom applies to multiple xterms with different
  native sizes and re-injection does not compound.
- Assert bounded Fiber lookup selects only an xterm/FitAddon pair linked by
  `_terminal`, and assignment/fit failures do not block other Terminals.
- Assert focused shortcuts change only Terminal state; unfocused shortcuts
  change only content state; test reset and 60/160 boundaries.
- Assert storage events update mounted and newly mounted Terminals.
- Assert a theme base-size change becomes the new reset baseline.
- Assert zoom-disabled and cleanup paths restore native size while retaining
  localStorage.

#### 7. Wrong vs Correct

```js
// Wrong: CSS changes glyph appearance but leaves xterm cell metrics stale.
terminalRoot.style.zoom = terminalZoomPercent / 100;

// Correct: update runtime metrics, then fit columns to the panel.
terminal.options.fontSize = nativeFontSize * terminalZoomPercent / 100;
fitAddon.fit();
```

---

## Hot-reload flow (the state you usually touch)

```
save assets/chat-typography.css
  → watchFs (injector) fires for allowed filename only
  → refresh(): buildPayload → new revision != old?
  → install(record): Page.addScriptToEvaluateOnNewDocument (early payload)
                     + evaluate(full payload)
  → renderer: previous.cleanup() → new IIFE installs → sync()
```

Because every refresh rebuilds the whole payload and re-evaluates the
template, **edits to either asset always go through the same revision-gated
path** — there is no incremental patch mechanism. Do not introduce one;
keep edits revision-visible.

---

## Keep-in-sync contracts (drift causes real bugs)

These values are duplicated *by design* across tiers that cannot import each
other. Changing one **requires** changing the others + tests:

1. `STATE_KEY = "__CHATGPT_CHAT_TYPOGRAPHY_STATE__"` — `injector.mjs`
   (`statusOf`, `--remove`, `earlyPayloadFor` generation key) and
   `renderer-inject.js`.
2. `MAIN_SURFACE_SELECTOR` / `SIDEBAR_SELECTOR` — `injector.mjs` probe and
   `renderer-inject.js` thread detection. Tests assert the exact probe
   selectors (`tests/injector.test.mjs`: `/main\.main-surface/`,
   `/aside\.app-shell-left-panel/`).
3. Placeholder tokens `__CHATGPT_RESTYLE_*_JSON__` — template + `buildPayload`.
4. Feature-flag defaults (true) — `load_config`, `parseArgs`, README.
5. Class names asserted by `statusOf` (`chatgpt-chat-typography-markdown-preview`,
   `-plan`, `-native-ui`) — same literals in renderer + injector + tests.

**Before changing any of these, grep both files and the tests first.**

---

## Anti-patterns

- Reading `.env` in `injector.mjs` — config is passed via CLI args, always.
- Storing secrets or paths in localStorage/`window` state — renderer state is
  diagnostic-only.
- Letting `statusOf` throw when the renderer has no state — it must degrade to
  `installed: false`.
- Deleting `state.json` without ownership verification.
- Adding a sixth sync-point that bypasses the revision-gated refresh path.
