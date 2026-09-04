# Renderer Injection

> Conventions for `assets/renderer-inject.js` (the injected script) and
> `assets/chat-typography.css` (the injected stylesheet). This file replaces
> the generic "component / hook" templates — this project has no React
> components; its "components" are DOM scopes inside the ChatGPT renderer.

---

## What this layer is

`renderer-inject.js` is a **template**, not a runnable script. The injector
reads it and replaces four placeholder constants before evaluation:

| Placeholder | Replaced with | Source |
|-------------|---------------|--------|
| `__CHATGPT_RESTYLE_CSS_JSON__` | `JSON.stringify(completeCss)` | `chat-typography.css` (+ inlined Google Fonts CSS) |
| `__CHATGPT_RESTYLE_VERSION_JSON__` | `JSON.stringify(revision)` | sha256 of css + template + config, 20 hex chars |
| `__CHATGPT_RESTYLE_FONT_ENABLED_JSON__` | `JSON.stringify(fontEnabled)` | `--font-enabled` / `.env` |
| `__CHATGPT_RESTYLE_ZOOM_ENABLED_JSON__` | `JSON.stringify(zoomEnabled)` | `--zoom-enabled` / `.env` |

**Any new placeholder constant must be added in *both* `renderer-inject.js`
and `buildPayload()` in `injector.mjs`.** The revision hash must also change so
the watcher re-injects after an edit (tests assert no
`__CHATGPT_RESTYLE_*_JSON__` token survives `buildPayload`).

The IIFE returns a status object (`installed`, `threadFound`, `previewCount`,
`planCount`, `nativeUiCount`, `contentZoomPercent`, `terminalZoomPercent`,
`fontEnabled`, `zoomEnabled`, `fontAvailable`, `nativeFontFamily`, `version`)
that the injector reads back for `--once` verification and `--status` output.

---

## Constant block conventions

All DOM selectors, class names, IDs, and storage keys are module-level
`UPPER_SNAKE_CASE` constants at the top of the IIFE, with a consistent prefix:

```js
const STATE_KEY = "__CHATGPT_CHAT_TYPOGRAPHY_STATE__";
const STYLE_ID = "chatgpt-chat-typography-style";
const ROOT_CLASS = "chatgpt-restyle-font-root";
const THREAD_CLASS = "chatgpt-chat-typography-thread";
const MESSAGE_CLASS = "chatgpt-chat-typography-message";
const PREVIEW_CLASS = "chatgpt-chat-typography-markdown-preview";
const PLAN_CLASS = "chatgpt-chat-typography-plan";
const NATIVE_UI_CLASS = "chatgpt-chat-typography-native-ui";
const ZOOM_CLASS = "chatgpt-restyle-content-zoom";
const ZOOM_STORAGE_KEY = "chatgpt-restyle.contentZoomPercent.v1";
const MIN_ZOOM_PERCENT = 60;
const MAX_ZOOM_PERCENT = 160;
const ZOOM_STEP_PERCENT = 10;
```

Rules:
- Theme classes on ChatGPT's own elements use `chatgpt-chat-typography-*`.
- Root/zoom infra classes use `chatgpt-restyle-*`.
- Do **not** inline raw selector strings deep inside functions — grep-ability
  and test assertions depend on these constants.

---

## DOM targeting: attribute selectors, not hashed classes

ChatGPT's renderer uses hashed CSS-module class names that change between
releases. Selectors therefore target **stable attributes and structural
positions**:

```js
const MESSAGE_SELECTOR = [
  '[data-markdown-text-tone="user-message"]',
  '[data-markdown-text-style="assistant-message"]',
].join(", ");
const MARKDOWN_FILE_EDITOR_SELECTOR = '[role="tabpanel"][aria-label] .cm-editor';
const PLAN_PANEL_SELECTOR = '[role="tabpanel"][aria-label="Plan"]';
const THREAD_SELECTOR =
  'main[data-app-shell-main-surface="default"] .thread-scroll-container';
```

Notes:
- `data-app-shell-main-surface`, `data-markdown-text-tone`, and
  `data-markdown-text-style` are semantic renderer attributes; prefer them to
  CSS-module class fragments and message-key suffixes.
- ChatGPT's DOM is volatile by design. When the renderer changes, update the
  selectors **and** the tests that assert them (see
  `tests/renderer-inject.test.mjs` and README "当前版本边界"). There are no
  compatibility branches for old DOM versions — this tool tracks the current
  ChatGPT release only.

---

## Idempotent re-injection contract

The script may be evaluated multiple times into the same page (hot reload,
new document via `Page.addScriptToEvaluateOnNewDocument`, re-apply). Re-entry
is handled through a state object on `window`:

```js
const previous = window[STATE_KEY];
const previousNativeFontFamily = previous?.nativeFontFamily || null;
if (previous?.cleanup) previous.cleanup();
else {
  previous?.observer?.disconnect();
  if (previous?.timer) clearTimeout(previous.timer);
  previous?.disposeZoom?.();
}
```

Rules:
- The **new** instance always disposes the **previous** instance before
  installing itself.
- `cleanup()` must be total: disconnect observer, clear timers, remove every
  injected class/style/ID, delete the state key when it owns it
  (`if (window[STATE_KEY]?.cleanup === cleanup) delete window[STATE_KEY]`).
- `cleanup()` returns `true` so the injector's `--remove` mode can call
  `window[STATE_KEY]?.cleanup?.() ?? true` and always get a value.
- `nativeFontFamily` is preserved across re-injection via `previousNativeFontFamily`.

---

## sync() model: class sets + detach functions

`sync()` reconciles the current DOM against four tracked sets
(`currentMessages`, `currentPreviews`, `currentPlans`, `currentNativeUiRoots`)
plus the thread. The pattern is always the same:

```js
const previews = new Set(findPreviews(thread));
for (const preview of currentPreviews) {
  if (!previews.has(preview)) detachPreview(preview);   // remove what vanished
}
for (const preview of previews) {
  if (!fontEnabled) detachPreview(preview);
  else if (!preview.classList.contains(PREVIEW_CLASS)) {
    preview.style.setProperty("--chat-native-font-family", sampleNativeFontFamily(preview, nativeFontFamily));
    preview.classList.add(PREVIEW_CLASS);
  }
  if (fontEnabled) captureNativeCodeFont(preview, PREVIEW_CLASS, preview);
}
currentPreviews = previews;                              // set diff, not full re-render
```

- **Set-diff both ways**: remove classes from nodes that left the set, add to
  nodes that entered. Never `classList.add` on already-classed nodes every sync.
- **Pair each `attach*` with a `detach*`** that removes exactly the classes
  and CSS custom properties the attach added (`detachMessage`,
  `detachPreview`, `detachPlan`, `detachNativeUi`, `detach` for the thread).
- `sync()` returns `Boolean(thread || previews.size || plans.size)` — the
  injector uses it as "is typography actually applied here".

The observer is debounced with a single shared timer:

```js
const schedule = () => {
  if (timer) return;
  timer = setTimeout(() => { timer = null; sync(); }, 32);
};
```

---

## Native font sampling (the root-class toggle trick)

The CSS forces fonts with `!important`, so the renderer's *native* font must be
sampled *before* the root class applies — computed style is read with the
restyling class temporarily removed:

```js
const sampleNativeFontFamily = (root, fallback = "system-ui, sans-serif") => {
  if (!root) return fallback;
  const hadRoot = document.documentElement.classList.contains(ROOT_CLASS);
  if (hadRoot) document.documentElement.classList.remove(ROOT_CLASS);
  let family = null;
  try {
    family = getComputedStyle(root).fontFamily;
  } finally {
    if (hadRoot) document.documentElement.classList.add(ROOT_CLASS);
  }
  return family || fallback;
};
```

The sampled family is stored per-scope as `--chat-native-font-family` (and
`--chat-native-code-font-family`), then referenced in the CSS fallback chain.
Never hardcode the native family; always sample it with the class toggled off
and restore state in a `finally` block.

---

## Zoom feature conventions

- Percent is clamped 60–160, steps of 10, persisted to
  `localStorage["chatgpt-restyle.contentZoomPercent.v1"]`.
- Keyboard: `Ctrl`+`Shift`+`=` / `-` / `0`, registered on `window` with
  capture (`addEventListener("keydown", onZoomKeyDown, true)`) plus
  `event.stopImmediatePropagation()` so ChatGPT's own bindings do not also fire.
- The zoom stylesheet is generated as a template-literal CSS string
  (`updateZoomStyle`), using `zoom` + `inline-size` with an inverse factor so
  the *layout width* stays constant while content scales.
- Toast announces the new percent, auto-removes after 900 ms, carries
  `role="status"` + `aria-live="polite"`.
- Storage events (`onZoomStorage`) keep multiple tabs/tasks in sync.

---

## Terminal xterm runtime integration

The current app mounts Terminal under the stable `[data-codex-xterm]`
attribute. Unlike ordinary DOM text, xterm measures glyph cells from its JS
runtime options, so CSS-only `font-family` or `zoom` overrides produce stale
metrics. The renderer must synchronize both layers:

1. Scope Terminal CSS through `.chatgpt-restyle-font-root [data-codex-xterm]`.
2. Find the xterm instance and matching FitAddon from the Terminal root's
   `__reactFiber$*` property, walking at most 16 parent fibers and 64 hooks.
   Identify xterm by `options`, `open()`, and `write()`; identify FitAddon by
   `fit()`, `dispose()`, and `_terminal === instance`. The 64-hook limit is one
   total budget across all visited fibers, not a fresh budget per fiber. Do not
   apply runtime overrides until a matching pair is available; a later DOM
   mutation will retry partially mounted Terminals. Never use minified names or
   fixed hook indices.
3. Track each root/instance/FitAddon in `currentTerminals`, preserving native
   `fontFamily`, native `fontSize`, and any pre-existing
   `--chat-native-code-font-family` value/priority.
4. Apply font and zoom independently: a font-option failure must not prevent
   `fontSize` synchronization, and vice versa.

Terminal zoom routes the existing `Ctrl`+`Shift`+`=` / `-` / `0` shortcuts by
checking `document.activeElement?.closest?.(TERMINAL_SELECTOR)`. A focused
Terminal updates the independent persisted Terminal ratio; any other focus
keeps the existing content-zoom behavior. Every mounted Terminal uses:

```js
instance.options.fontSize = nativeFontSize * terminalZoomPercent / 100;
```

After injected code changes or restores `fontSize`, call the matching
`fitAddon.fit()` so xterm recomputes columns against the panel width and keeps
its current input line and cursor visible. This applies to shortcuts, reset,
storage sync, theme-base changes, cleanup, and re-injection.

When the app theme changes an xterm option, treat a value different from the
last applied value as the new native baseline before reapplying custom state.
`disposeZoom()` restores native sizes; `detachTerminal()` additionally restores
font family and the original native-code CSS property. During a full detach,
restore `fontFamily` before `fontSize` so the size restoration's single fit uses
final native font metrics. Only restore a field when it still equals the value
owned by this injection, so app-side updates are not overwritten.

> **Compatibility warning**: React Fiber traversal is a current-app adapter,
> not a generic React contract. If Terminal mounting changes, update the bounded
> lookup, tests, and README "当前版本边界" together. Never target minified
> component/function names.

---

## CSS conventions (`chat-typography.css`)

- **Design tokens are CSS custom properties** declared for `:root`, the thread,
  Markdown preview, Plan, and
  `.chatgpt-restyle-font-root [data-codex-xterm]` scopes — font
  family/size/weight/line-height, block gap `0.75em`, message gap `24px`,
  code styling, and `--chat-code-surface` /
  `--chat-code-border-color` via `color-mix(in srgb, currentColor N%, transparent)`
  (theme-adaptive, no hardcoded colors).
- **Scope every rule** to an injected class (`.chatgpt-chat-typography-thread`,
  `-markdown-preview`, `-plan`, the `-native-ui` exclusion, or
  `.chatgpt-restyle-font-root` for Terminal) so the stylesheet never leaks into
  unrelated UI.
- **`!important` is the norm here, deliberately.** This CSS must override
  ChatGPT's own stylesheet; the root rule uses a double selector for
  specificity: `.chatgpt-chat-typography-plan.chatgpt-chat-typography-plan`.
- **Specificity control with `:where`/`:is`**: use `:where(...)` for
  zero-specificity structural matches (block spacing, generic elements) and
  `:is(...)` where you need the strongest selector in a group.
- **Exclusions** use `.chatgpt-chat-typography-message:not(.chatgpt-chat-typography-native-ui *)`
  — queued messages and other native UI must keep the app's own font.
- **Do not use `Songti` / `STSong`** anywhere — `doctor-macos.sh` greps the CSS
  for them and fails (deliberate: Chinese falls back to the native UI font).

---

## Anti-patterns

- Adding a new placeholder token to only one of `renderer-inject.js` /
  `buildPayload()` (silent breakage; revision hash may not change).
- Renaming `STATE_KEY` or a shared selector in one file only — keep
  `injector.mjs` and `renderer-inject.js` in sync (see
  [Validation Guidelines](./validation-guidelines.md), keep-in-sync list).
- Re-applying classes on every `sync()` run instead of set-diffing.
- Adding cleanup paths that miss one of the injected artifacts
  (style elements, toast, custom properties, root class).
- Targeting hashed CSS-module class names when a semantic attribute exists.
