# Quality Guidelines

> Testing, checks, and standards for this repo. No linter, no formatter, no CI
> config — the quality gates are `npm test` (node:test) and
> `scripts/doctor-macos.sh`.

---

## Testing stack

- **`node --test`** with `node:assert/strict` — zero test dependencies
  (`package.json` scripts: `"test": "node --test"`, engines `node >= 20`).
- One test file per unit under test:
  - `tests/injector.test.mjs` — exported pure functions of `injector.mjs`
    (target validation, arg parsing, payload/revision, Google Fonts inlining,
    state ownership).
  - `tests/state.test.mjs` — `common-macos.sh` state/launchd logic by
    spawning real Bash.
  - `tests/random-port.test.mjs` — `load_config`, `generate_random_port`,
    `.env` edge cases.
  - `tests/renderer-inject.test.mjs` — the renderer template executed under
    `node:vm` against a fake DOM fixture.

## Test harness patterns

### Renderer template under `vm` (DOM fixture)

`tests/renderer-inject.test.mjs` reads the real `assets/renderer-inject.js` +
`assets/chat-typography.css`, replaces the placeholder tokens, then runs the
IIFE in `vm.runInNewContext` with a hand-built DOM (Map-backed `classList`,
`style` with `setProperty/getPropertyValue/removeProperty`, fake
`MutationObserver`, `localStorage`, `document.fonts`, listeners map). The
fixture is configurable via options:

```js
function fixture({ fontEnabled = true, zoomEnabled = true, withPlan = false,
                   storedZoom = null, storageThrows = false, ... } = {}) { ... }
```

- Assert **side effects on the fixture**: which classes were added/removed,
  which CSS custom properties were set, listener registration, cleanup totals.
- Every constant under test is re-declared in the test file (e.g.
  `ZOOM_CLASS`, `MESSAGE_SELECTOR`) so selector drift fails the test.

### Shell logic via `spawnSync("/bin/bash", [...])`

`tests/state.test.mjs` / `tests/random-port.test.mjs` source the real
`common-macos.sh` in a subprocess with a **temporary HOME** and override
functions when needed:

```js
const result = spawnSync("/bin/bash", ["-c", `
  source "$1"
  NODE="$2"
  CHATGPT_EXE=/bin/echo
  ensure_state_root
  write_state 54321 123 "Mon Jan 1 00:00:00 2024" ...
  state_file_is_safe
  test "$(/usr/bin/stat -f '%Lp' "$STATE_PATH")" = 600
`, "test", common, process.execPath], { encoding: "utf8", env: { ...process.env, HOME: temporaryHome } });
assert.equal(result.status, 0, result.stderr);
```

- Assert `result.status === 0` **and** surface `result.stderr` in the message.
- Clean up temp dirs with `context.after(...)` / `t.after(...)`.

### Pure functions directly

`tests/injector.test.mjs` calls exported functions with crafted fixtures
(`validTarget`, injected `fetchImpl` for `inlineGoogleFontCss`, `vm` fake
session for `statusOf`).

---

## Required: when to add or update tests

- **Any change to `assets/`** (CSS or renderer template): the renderer suite
  must still pass — add fixture cases for new DOM scopes.
- **Any change to selectors, class names, `STATE_KEY`, placeholder tokens, or
  feature-flag defaults**: update the matching assertions (they are mirrored
  in test files on purpose).
- **Any new CLI flag / config key / state.json field**: extend
  `parseArgs` / `load_config` / `write_state` tests, including invalid-input
  cases (`assert.throws`, unsafe-mode rejections, duplicate-key failures).
- Run the full suite before commit: `npm test`.

---

## `doctor-macos.sh` (read-only health gate)

Checks, in order, and fails with `fail()` on the first problem:

1. Required files exist: `assets/chat-typography.css`,
   `assets/renderer-inject.js`, `scripts/injector.mjs`.
2. **No `Songti`/`STSong`** in the CSS (case-insensitive grep) — banned
   Chinese fallback.
3. `chat-typography.css` contains a line starting with the
   `.chatgpt-chat-typography-thread` selector (grep `^\.chatgpt-chat-typography-thread`)
   — CSS must be scoped to the injected container.
4. All `*.command` and `scripts/*.sh` pass `bash -n` (syntax check).
5. ChatGPT app + its built-in Node runtime pass `codesign --verify --strict`
   against the expected Team ID (`2DC432GLL2`) and architecture match.
6. `$NODE --check scripts/injector.mjs` passes.

`doctor` never restarts ChatGPT or modifies anything. Extend it when adding a
new entry-point file or a new forbidden pattern.

---

## Forbidden patterns

| Pattern | Why it's banned |
|---------|-----------------|
| `Songti` / `STSong` in CSS | Chinese text would fall back to a serif system font; `doctor` greps for it |
| Hardcoded CDP port / non-loopback listener | Ports come from `.env` or random `49152–65535`; listeners bind `127.0.0.1` only |
| Falling back to random port when `.env` port is invalid | Silent misconfiguration; Apply must error loudly (README contract) |
| Killing a PID from `state.json` without identity verification | PID recycling could kill an unrelated process (start-time + exe + command-line must match) |
| Accepting unvalidated `webSocketDebuggerUrl` | Unauthenticated loopback CDP must not be driven blindly |
| Editing `.app` / `app.asar` / ChatGPT config files | Breaks app signature; the tool only injects into renderer memory over CDP |
| Sending `Songti`-style fallbacks or unbounded regexes from the wire | Length-bounded validation everywhere (`{1,200}`) |
| Adding npm dependencies | The project intentionally has zero deps; native Node APIs + Bash cover everything |
| Multi-line raw string interpolation into evaluated code | Must be `JSON.stringify`-encoded (see [Validation](./validation-guidelines.md)) |

---

## Review checklist (for `trellis-check` and PRs)

- [ ] `npm test` passes; new behavior has matching tests (incl. invalid input)
- [ ] `./scripts/doctor-macos.sh` passes
- [ ] No `__CHATGPT_RESTYLE_*_JSON__` token survives `buildPayload` (tests assert)
- [ ] Changed selector/class/`STATE_KEY`/flag appears in **both** tiers + tests
      (grep both `injector.mjs` and `renderer-inject.js`)
- [ ] `revision` changes when the change should trigger hot reload
- [ ] `state.json` writes/reads keep the 0600/owner/regular-file guards and
      `schemaVersion` handling
- [ ] Watcher cleanup still deletes `state.json` only when it owns it
- [ ] Renderer cleanup removes every artifact it can add (style ids, toast,
      custom properties, root class)
- [ ] User-facing messages are Chinese; commit subject uses Conventional
      Commits (`feat:` / `fix:` + Chinese description)
- [ ] README "当前版本边界" updated when DOM targeting changes
