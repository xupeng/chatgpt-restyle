# Validation Guidelines

> Data-safety conventions. This project has **no TypeScript** — type safety is
> achieved by validating every untrusted input at the boundary it enters,
> with explicit checks and exact error messages. (Replaces the generic
> "type-safety" template: there are no TS types to organize.)

---

## Trust model

| Input | Untrusted? | Validation layer |
|-------|-----------|------------------|
| CDP target list (`/json/list`) + WS URLs | **Yes** | `isValidCdpPageTarget` / `validatedDebuggerUrl` (injector) |
| `webSocketDebuggerUrl` from the wire | **Yes** | same, plus pathname/id regex |
| Renderer DOM (hashed classes) | **Yes** | attribute-based selectors, `?.` guards |
| `localStorage` zoom value | **Yes** | `parseZoomPercent` |
| `state.json` on disk | **Yes** | `state_file_is_safe` + `state_field` + `state_feature_enabled` |
| `.env` config | **Yes** | `load_config` strict regex + duplicate check |
| CLI args | **Yes** | `parseArgs` (every arg validated or thrown) |
| Injected template constants | No (we generate them) | `JSON.stringify` embedding only |
| Google Fonts CSS/font URLs | Yes (remote) | HTTP status checks + URL extraction regex |

**Rule**: no field from the right-hand side is ever used before its validator
passes. When adding a new input path (new config key, new CDP message,
new renderer value), add its validator in the same change — and a test.

---

## Node tier patterns (`injector.mjs`)

### Exact-match validators return booleans or throw with a reason

```js
const TARGET_ID = /^[A-Za-z0-9._-]{1,200}$/;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

export function validatedDebuggerUrl(target, port) {
  const url = new URL(target.webSocketDebuggerUrl);
  if (
    url.protocol !== "ws:"
    || !LOOPBACK_HOSTS.has(url.hostname)
    || Number(url.port) !== Number(port)
    || url.username || url.password || url.search || url.hash
    || !/^\/devtools\/page\/[A-Za-z0-9._-]{1,200}$/.test(url.pathname)
  ) throw new Error("Rejected CDP WebSocket URL");
  return url.href;
}
```

- Prefer explicit conditions over clever one-liners — each rejected vector
  (protocol/host/port/credentials/query/hash/pathname) is visible.
- All regexes have **length bounds** (`{1,200}`) — nothing unbounded from the
  wire.
- `Number(x) === Number(port)` avoids string/number coercion bugs.

### Numeric parsing with clamp and fallback (renderer)

```js
const parseZoomPercent = (value) => {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return DEFAULT_ZOOM_PERCENT;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= MIN && parsed <= MAX ? parsed : DEFAULT;
};
```

Same shape in the shell tier for `CHATGPT_RESTYLE_PORT` (strip leading zeros,
range 1024–65535, fail on anything else).

### JSON with explicit guards

```js
// removeOwnedState
let state;
try { state = JSON.parse(await fs.readFile(statePath, "utf8")); }
catch (error) {
  if (error?.code === "ENOENT" || error instanceof SyntaxError) return false;
  throw error;
}
```

- `ENOENT`/`SyntaxError` are "not ours" outcomes; other errors rethrow.
- Ownership checks (regular file, mode 0600, uid match, pid+port match)
  happen **before** trusting the parsed content.

### Arg parsing: throw on anything unexpected

`parseArgs` throws for: no mode, two modes, unknown flag, non-integer port,
port out of range, invalid pid, `--font-enabled` not `true|false` (lowercase),
`--chatgpt-pid` outside `--watch`. There is no "best-effort" fallback except
documented defaults (`timeoutMs: 15000`, flags `true`).

---

## Shell tier patterns (`common-macos.sh`)

- `.env` lines are matched with anchored regexes including the key boundary
  (`^[[:space:]]*CHATGPT_RESTYLE_PORT([[:space:]]|=|$)`), so unrelated keys
  like `CHATGPT_RESTYLE_PORTABLE` never match.
- Duplicate declarations are counted and rejected per key.
- Numeric strings go through `10#$normalized` (base-10, no octal surprises)
  after leading-zero stripping.
- `state_field` allows only `string | number | boolean` to pass through
  (`process.exit(2)` otherwise) — arrays/objects from a corrupt state file
  cannot reach the caller.
- `state_feature_enabled` switches on `schema_version` and rejects unknown
  schema versions.

---

## Rendering into code: always `JSON.stringify`, never string interpolation

All values that cross into evaluated code are embedded as JSON:

```js
template
  .replace("__CHATGPT_RESTYLE_CSS_JSON__", JSON.stringify(completeCss))
  .replace("__CHATGPT_RESTYLE_VERSION_JSON__", JSON.stringify(revision))
  .replace("__CHATGPT_RESTYLE_FONT_ENABLED_JSON__", JSON.stringify(options.fontEnabled));
```

Likewise `probe()`/`statusOf()` interpolate selectors with
`JSON.stringify(MAIN_SURFACE_SELECTOR)` inside template expressions. If a CSS
payload ever contained backticks or `${...}`, raw interpolation would inject
arbitrary code into the renderer — JSON encoding keeps it data.

---

## Anti-patterns

- `parseInt(value)` without base/range/type checks (leading-zero octal traps,
  `"12abc"` partial parses).
- Trusting `webSocketDebuggerUrl` from a CDP listing without loopback +
  pathname validation.
- `JSON.parse` on files without ENOENT/type guards or ownership checks.
- Non-anchored `grep`/regex on `.env` keys (matches prefixes of other keys).
- Interpolating CSS/HTML/JS values into evaluated expressions with template
  literals instead of `JSON.stringify`.
- New config/flag/state fields without a matching test in
  `tests/{injector,state,random-port}.test.mjs`.
