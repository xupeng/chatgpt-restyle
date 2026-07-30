#!/usr/bin/env node

import { createHash } from "node:crypto";
import { watch as watchFs } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
const TARGET_ID = /^[A-Za-z0-9._-]{1,200}$/;
const STATE_KEY = "__CHATGPT_CHAT_TYPOGRAPHY_STATE__";
const MAIN_SURFACE_SELECTOR = "main[data-app-shell-main-surface]";
const SIDEBAR_SELECTOR = "aside.app-shell-left-panel";
const RUNTIME_STATE_PATH = process.env.HOME
  ? path.join(
    process.env.HOME,
    "Library",
    "Application Support",
    "ChatGPTRestyle",
    "state.json",
  )
  : null;

export function stateBelongsToWatcher(state, pid, port) {
  return state?.injectorPid === pid && state?.port === port;
}

export async function removeOwnedState(statePath, pid, port) {
  try {
    const metadata = await fs.lstat(statePath);
    if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o777) !== 0o600) {
      return false;
    }
    if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) return false;
    const state = JSON.parse(await fs.readFile(statePath, "utf8"));
    if (!stateBelongsToWatcher(state, pid, port)) return false;
    await fs.unlink(statePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) return false;
    throw error;
  }
}

export function validatedDebuggerUrl(target, port) {
  const url = new URL(target.webSocketDebuggerUrl);
  if (
    url.protocol !== "ws:"
    || !LOOPBACK_HOSTS.has(url.hostname)
    || Number(url.port) !== Number(port)
    || url.username
    || url.password
    || url.search
    || url.hash
    || !/^\/devtools\/page\/[A-Za-z0-9._-]{1,200}$/.test(url.pathname)
  ) throw new Error("Rejected CDP WebSocket URL");
  return url.href;
}

export function isValidCdpPageTarget(target, port) {
  if (
    target?.type !== "page"
    || target.url !== "app://-/index.html"
    || typeof target.id !== "string"
    || !TARGET_ID.test(target.id)
    || !target.webSocketDebuggerUrl
  ) return false;
  try {
    return new URL(validatedDebuggerUrl(target, port)).pathname === `/devtools/page/${target.id}`;
  } catch {
    return false;
  }
}

export function parseArgs(argv) {
  const options = {
    mode: null,
    port: null,
    timeoutMs: 15000,
    chatgptPid: null,
    fontEnabled: true,
    zoomEnabled: true,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (["--watch", "--once", "--remove", "--status"].includes(arg)) {
      if (options.mode) throw new Error("Choose exactly one mode");
      options.mode = arg.slice(2);
    }
    else if (arg === "--port") options.port = Number(argv[++index]);
    else if (arg === "--chatgpt-pid") options.chatgptPid = Number(argv[++index]);
    else if (arg === "--timeout-ms") options.timeoutMs = Number(argv[++index]);
    else if (arg === "--font-enabled") {
      const value = argv[++index];
      if (!["true", "false"].includes(value)) {
        throw new Error("--font-enabled must be true or false");
      }
      options.fontEnabled = value === "true";
    }
    else if (arg === "--zoom-enabled") {
      const value = argv[++index];
      if (!["true", "false"].includes(value)) {
        throw new Error("--zoom-enabled must be true or false");
      }
      options.zoomEnabled = value === "true";
    }
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!options.mode) throw new Error("Choose --watch, --once, --remove, or --status");
  if (!Number.isInteger(options.port) || options.port < 1024 || options.port > 65535) {
    throw new Error("A valid --port is required");
  }
  if (options.chatgptPid != null && (!Number.isInteger(options.chatgptPid) || options.chatgptPid < 1)) {
    throw new Error("A valid --chatgpt-pid is required");
  }
  if (options.mode !== "watch" && options.chatgptPid != null) {
    throw new Error("--chatgpt-pid is only valid with --watch");
  }
  return options;
}

export function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

class CdpSession {
  constructor(target, port) {
    this.ws = new WebSocket(validatedDebuggerUrl(target, port));
    this.nextId = 1;
    this.pending = new Map();
    this.closed = false;
    this.closeListeners = [];
  }

  async open() {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("CDP connection timed out")), 5000);
      this.ws.addEventListener("open", () => { clearTimeout(timeout); resolve(); }, { once: true });
      this.ws.addEventListener("error", () => { clearTimeout(timeout); reject(new Error("CDP connection failed")); }, { once: true });
    });
    this.ws.addEventListener("message", (event) => this.onMessage(event));
    this.ws.addEventListener("close", () => this.onClose());
    await this.send("Runtime.enable");
    await this.send("Page.enable");
    return this;
  }

  onMessage(event) {
    let message;
    try { message = JSON.parse(String(event.data)); } catch { this.close(); return; }
    if (!message?.id) return;
    const waiter = this.pending.get(message.id);
    if (!waiter) return;
    clearTimeout(waiter.timeout);
    this.pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message));
    else waiter.resolve(message.result);
  }

  onClose() {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timeout);
      waiter.reject(new Error("CDP connection closed"));
    }
    this.pending.clear();
    for (const listener of this.closeListeners) listener();
  }

  send(method, params = {}, timeoutMs = 10000) {
    if (this.closed) return Promise.reject(new Error("CDP connection is closed"));
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP command timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timeout });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression, timeoutMs = 10000) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: false,
    }, timeoutMs);
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    }
    return result.result?.value;
  }

  close() {
    try { this.ws.close(); } catch {}
    this.onClose();
  }
}

async function listTargets(port) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2000);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
      redirect: "error",
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`CDP returned HTTP ${response.status}`);
    const targets = await response.json();
    if (!Array.isArray(targets)) throw new Error("Invalid CDP target list");
    return targets.filter((target) => isValidCdpPageTarget(target, port));
  } finally {
    clearTimeout(timeout);
  }
}

async function probe(session) {
  return session.evaluate(`(() => ({
    shell: Boolean(document.querySelector(${JSON.stringify(MAIN_SURFACE_SELECTOR)})),
    sidebar: Boolean(document.querySelector(${JSON.stringify(SIDEBAR_SELECTOR)})),
    href: location.href,
  }))()`);
}

async function connectChatGPTTargets(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = new Error("No ChatGPT renderer found");
  while (Date.now() < deadline) {
    const connected = [];
    try {
      for (const target of await listTargets(port)) {
        let session;
        try {
          session = await new CdpSession(target, port).open();
          const markers = await probe(session);
          if (markers.shell && markers.sidebar) connected.push({ target, session });
          else session.close();
        } catch (error) {
          session?.close();
          lastError = error;
        }
      }
      if (connected.length) return connected;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`No verified ChatGPT renderer: ${lastError.message}`);
}

export async function buildPayload(options) {
  const [css, template] = await Promise.all([
    fs.readFile(path.join(root, "assets", "chat-typography.css"), "utf8"),
    fs.readFile(path.join(root, "assets", "renderer-inject.js"), "utf8"),
  ]);
  const configuration = JSON.stringify({
    fontEnabled: options.fontEnabled,
    zoomEnabled: options.zoomEnabled,
  });
  const revision = createHash("sha256")
    .update(css)
    .update(template)
    .update(configuration)
    .digest("hex")
    .slice(0, 20);
  return {
    payload: template
      .replace("__CHATGPT_RESTYLE_CSS_JSON__", JSON.stringify(css))
      .replace("__CHATGPT_RESTYLE_VERSION_JSON__", JSON.stringify(revision))
      .replace("__CHATGPT_RESTYLE_FONT_ENABLED_JSON__", JSON.stringify(options.fontEnabled))
      .replace("__CHATGPT_RESTYLE_ZOOM_ENABLED_JSON__", JSON.stringify(options.zoomEnabled)),
    revision,
  };
}

export function earlyPayloadFor(payload, revision) {
  return `(() => {
    const generation = ${JSON.stringify(revision)};
    window.__CHATGPT_CHAT_TYPOGRAPHY_EARLY_GENERATION__ = generation;
    const install = () => {
      if (window.__CHATGPT_CHAT_TYPOGRAPHY_EARLY_GENERATION__ !== generation) return true;
      if (!document.querySelector(${JSON.stringify(MAIN_SURFACE_SELECTOR)}) || !document.querySelector(${JSON.stringify(SIDEBAR_SELECTOR)})) return false;
      ${payload};
      return true;
    };
    if (install()) return;
    const observer = new MutationObserver(() => { if (install()) observer.disconnect(); });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    setTimeout(() => observer.disconnect(), 10000);
  })()`;
}

export async function statusOf(session) {
  return session.evaluate(`(() => {
    const state = window.${STATE_KEY};
    return state ? {
      installed: true,
      threadFound: Boolean(document.querySelector(${JSON.stringify(`${MAIN_SURFACE_SELECTOR} .thread-scroll-container`)})),
      previewCount: document.querySelectorAll('.chatgpt-chat-typography-markdown-preview').length,
      planCount: document.querySelectorAll('.chatgpt-chat-typography-plan').length,
      nativeUiCount: document.querySelectorAll('.chatgpt-chat-typography-native-ui').length,
      contentZoomPercent: Number(state.contentZoomPercent) || 100,
      fontEnabled: state.fontEnabled !== false,
      zoomEnabled: state.zoomEnabled !== false,
      fontAvailable: state.fontEnabled === false ? null : Boolean(state.fontAvailable),
      nativeFontFamily: state.nativeFontFamily || null,
      version: state.version,
    } : {
      installed: false,
      threadFound: false,
      previewCount: 0,
      planCount: 0,
      nativeUiCount: 0,
      contentZoomPercent: 100,
      fontEnabled: false,
      zoomEnabled: false,
      fontAvailable: null,
    };
  })()`);
}

async function runOneShot(options) {
  const connected = await connectChatGPTTargets(options.port, options.timeoutMs);
  const built = options.mode === "once" ? await buildPayload(options) : null;
  const results = [];
  for (const { target, session } of connected) {
    try {
      if (options.mode === "once") await session.evaluate(built.payload);
      if (options.mode === "remove") {
        await session.evaluate(`window.${STATE_KEY}?.cleanup?.() ?? true`);
      }
      results.push({ targetId: target.id, ...(await statusOf(session)) });
    } finally {
      session.close();
    }
  }
  console.log(JSON.stringify({ mode: options.mode, targets: results }, null, 2));
  if (!results.length || (options.mode === "once" && results.some((item) => !item.installed))) {
    process.exitCode = 2;
  }
}

async function runWatch(options) {
  let built = await buildPayload(options);
  const sessions = new Map();
  let stopping = false;
  let refreshTimer = null;
  process.on("SIGINT", () => { stopping = true; });
  process.on("SIGTERM", () => { stopping = true; });

  const install = async (record) => {
    const identifier = await record.session.send("Page.addScriptToEvaluateOnNewDocument", {
      source: earlyPayloadFor(built.payload, built.revision),
    });
    if (record.earlyId) {
      await record.session.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: record.earlyId }).catch(() => {});
    }
    record.earlyId = identifier.identifier;
    await record.session.evaluate(built.payload);
  };

  const refresh = async () => {
    const next = await buildPayload(options);
    if (next.revision === built.revision) return;
    built = next;
    await Promise.all([...sessions.values()].map((record) => install(record).catch((error) => {
      console.error(`[chatgpt-restyle] refresh failed: ${error.message}`);
    })));
  };

  const watcher = watchFs(path.join(root, "assets"), { persistent: false }, (_event, filename) => {
    if (filename && !["chat-typography.css", "renderer-inject.js"].includes(String(filename))) return;
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => refresh().catch((error) => console.error(error.message)), 50);
  });
  watcher.on("error", (error) => {
    console.error(`[chatgpt-restyle] asset watch unavailable: ${error.message}`);
  });

  try {
    while (!stopping) {
      if (options.chatgptPid != null && !processIsAlive(options.chatgptPid)) {
        console.log("[chatgpt-restyle] ChatGPT process exited; stopping watcher.");
        break;
      }
      try {
        const targets = await listTargets(options.port);
        for (const target of targets) {
          if (sessions.has(target.id)) continue;
          let session;
          try {
            session = await new CdpSession(target, options.port).open();
            const markers = await probe(session);
            if (!markers.shell || !markers.sidebar) { session.close(); continue; }
            const record = { session, earlyId: null };
            sessions.set(target.id, record);
            session.closeListeners.push(() => sessions.delete(target.id));
            await install(record);
          } catch (error) {
            session?.close();
            console.error(`[chatgpt-restyle] target setup failed: ${error.message}`);
          }
        }
      } catch (error) {
        console.error(`[chatgpt-restyle] discovery failed: ${error.message}`);
      }
      if (!stopping) await new Promise((resolve) => setTimeout(resolve, 500));
    }
  } finally {
    watcher.close();
    clearTimeout(refreshTimer);
    for (const record of sessions.values()) {
      if (record.earlyId) {
        await record.session.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: record.earlyId }, 1000).catch(() => {});
      }
      record.session.close();
    }
    if (RUNTIME_STATE_PATH) {
      await removeOwnedState(RUNTIME_STATE_PATH, process.pid, options.port).catch((error) => {
        console.error(`[chatgpt-restyle] state cleanup failed: ${error.message}`);
      });
    }
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.mode === "watch") await runWatch(options);
  else await runOneShot(options);
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch((error) => {
    console.error(`chatgpt-restyle: ${error.message}`);
    process.exitCode = 1;
  });
}
