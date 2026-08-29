# Directory Structure

> Where files live in this repository and why.

---

## Overview

The repo is a single Node ESM package (`"type": "module"`, Node >= 20) with no
dependencies. Everything is organized by *role*: assets to be injected,
scripts that orchestrate, tests, and launch entry points. There is no `src/`
tree — the three code tiers live at the top level because the shell scripts and
`.command` wrappers reference them by fixed relative paths.

---

## Directory Layout

```
chatgpt-restyle/
├── assets/                    # Injected into the ChatGPT renderer
│   ├── chat-typography.css    # Typography + zoom CSS (hot-reloaded on save)
│   └── renderer-inject.js     # IIFE template, placeholders replaced at build time
├── scripts/                   # Node + Bash implementation
│   ├── injector.mjs           # CDP client / payload builder / watcher (ESM, the only .mjs)
│   ├── common-macos.sh        # Shared Bash library (sourced by every *-macos.sh)
│   ├── apply-macos.sh         # Start or re-apply; restarts ChatGPT with CDP if needed
│   ├── status-macos.sh        # Verify renderer + process identities
│   ├── restore-macos.sh       # Remove injection, stop watcher, relaunch normally
│   └── doctor-macos.sh        # Read-only health check (files, syntax, signatures)
├── raycast/
│   └── chatgpt-with-restyle.sh  # Raycast Script Command → exec apply-macos.sh
├── tests/                     # node:test suites, one file per unit under test
│   ├── injector.test.mjs
│   ├── random-port.test.mjs
│   ├── renderer-inject.test.mjs
│   └── state.test.mjs
├── Apply.command              # Finder double-click → apply-macos.sh
├── Restore.command            # Finder double-click → restore-macos.sh
├── Status.command             # Finder double-click → status-macos.sh
├── .env                       # Local config (gitignored); copy from .env.example
├── .env.example               # Documented template of all supported keys
├── package.json               # "type": "module", engines.node >= 20, scripts.test = node --test
└── README.md                  # User-facing documentation (Chinese)
```

---

## Module organization rules

- **`assets/` only contains what gets injected.** If a file is not read by
  `buildPayload` (`chat-typography.css`, `renderer-inject.js`) or shipped as a
  static asset, it does not belong here.
- **`scripts/` only contains entry points and the shared Bash library.**
  Reusable Bash functions live in `common-macos.sh` — never define a function
  in two `*-macos.sh` files (see `apply-macos.sh`, `status-macos.sh`, and
  `restore-macos.sh` all sourcing `common-macos.sh`).
- **`tests/` mirrors units, not directories.** The four suites map to
  `injector.mjs` (CDP/payload/state ownership), `common-macos.sh` + `apply-macos.sh`
  (state + port logic), and the renderer template (DOM behavior under a VM).
- **`.command` files are thin wrappers.** They only `cd` to the repo and exec
  the matching `scripts/*-macos.sh`; business logic lives in the scripts.
- **New entry points** (e.g. a new `.command` or Raycast script) must be listed
  in `doctor-macos.sh`'s syntax-check glob and covered by existing tests where
  behavior changes.

---

## Naming conventions

| Thing | Convention | Example |
|-------|-----------|---------|
| Shell orchestration scripts | `*-macos.sh` | `apply-macos.sh`, `restore-macos.sh` |
| Shared Bash library | `common-macos.sh` | — |
| Node module | `*.mjs` (ESM entry) | `injector.mjs` |
| Test files | `*.test.mjs` | `renderer-inject.test.mjs` |
| Finder double-click wrappers | PascalCase `*.command` | `Apply.command` |
| Raycast script commands | `chatgpt-with-restyle.sh` under `raycast/` | — |
| Injector CLI modes | kebab-case flags | `--watch`, `--once`, `--remove`, `--status` |
| Renderer CSS/JS class & key constants | kebab-case, `chatgpt-restyle-` / `chatgpt-chat-typography-` prefixes | see [Renderer Injection](./renderer-injection.md) |
| Config keys | `CHATGPT_RESTYLE_*` UPPER_SNAKE | `CHATGPT_RESTYLE_PORT`, `CHATGPT_RESTYLE_ZOOM_ENABLED` |
| Runtime state keys | camelCase in `state.json` / localStorage / `window` state | `schemaVersion`, `contentZoomPercent` |

---

## Anti-patterns

- **Adding a new script under `scripts/` that duplicates `common-macos.sh` helpers.**
  Source the shared library with `set -euo pipefail; . "$(cd "$(dirname "$0")" && pwd -P)/common-macos.sh"`.
- **Putting a file in `assets/` that the renderer never receives.** Asset
  additions must be wired through `buildPayload` and the watcher's allowlist
  (`watchFs` filter in `runWatch`: only `chat-typography.css` and
  `renderer-inject.js` trigger refresh).
- **Hardcoding paths relative to the caller's CWD.** All scripts resolve
  `SCRIPT_DIR`/`PROJECT_ROOT` from their own location so they work from any
  working directory (Raycast, Finder, Terminal).
