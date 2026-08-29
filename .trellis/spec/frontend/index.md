# ChatGPT Restyle Development Guidelines

> Coding conventions for this repository, as it exists today.

---

## What this layer covers

`chatgpt-restyle` is **not** a web frontend. It is a macOS tool that restyles the
official ChatGPT Desktop app by injecting CSS and a small renderer script over
Chrome DevTools Protocol (CDP). The code ships in three tiers that work as one
tight unit:

| Tier | Location | Language | What it does |
|------|----------|----------|--------------|
| Renderer (injected) | `assets/renderer-inject.js`, `assets/chat-typography.css` | Vanilla JS (IIFE) + CSS | Runs inside the ChatGPT renderer; applies typography + zoom classes to ChatGPT's DOM |
| CDP injector | `scripts/injector.mjs` | Node ESM (zero npm deps) | Connects to the renderer over CDP, builds the payload, watches assets for hot reload |
| Shell orchestration | `scripts/*-macos.sh`, `*.command`, `raycast/` | Bash (macOS-only) | Discovers the ChatGPT app, validates signatures, manages launchd jobs and `state.json` |

There is **no React, no TypeScript, no bundler, no package.json dependencies**
(`"type": "module"`, `engines.node >= 20` only). "Frontend" here means the
renderer tier; the other two tiers exist only to deliver it.

The main risk in this codebase is **contract drift**: the same selector,
class name, or placeholder constant appearing in two files (e.g.
`injector.mjs` and `renderer-inject.js` cannot import each other, so strings
are duplicated deliberately). See [State Management](./state-management.md)
and [Validation Guidelines](./validation-guidelines.md) for the keep-in-sync
contracts.

---

## Guidelines Index

| Guide | When to read | Status |
|-------|--------------|--------|
| [Directory Structure](./directory-structure.md) | Any new file or directory | Ready |
| [Renderer Injection](./renderer-injection.md) | Editing `assets/renderer-inject.js` or `assets/chat-typography.css` | Ready |
| [CDP Injector](./injector-cdp.md) | Editing `scripts/injector.mjs` | Ready |
| [Shell Scripts](./shell-scripts.md) | Editing `scripts/*-macos.sh`, `*.command`, `raycast/` | Ready |
| [State Management](./state-management.md) | Anything touching config, `state.json`, renderer state, or the hot-reload path | Ready |
| [Validation Guidelines](./validation-guidelines.md) | Parsing args, config, CDP targets, or any external input | Ready |
| [Quality Guidelines](./quality-guidelines.md) | Before running tests or committing | Ready |

---

## Project language notes

- Code identifiers, comments, and this spec are in **English**.
- **User-facing strings are Chinese** (README, `fail()` messages in shell,
  zoom toast `正文缩放 N%`). New user-facing messages should be Chinese.
- Commit subjects use Conventional Commits in English type + Chinese description:
  `feat: 使用 Oxanium 作为英文界面字体`, `fix: 适配 ChatGPT 新版 DOM 并恢复排版样式`.
