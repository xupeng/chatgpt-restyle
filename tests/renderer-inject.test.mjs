import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [template, css] = await Promise.all([
  fs.readFile(path.join(root, "assets", "renderer-inject.js"), "utf8"),
  fs.readFile(path.join(root, "assets", "chat-typography.css"), "utf8"),
]);

const ZOOM_CLASS = "chatgpt-restyle-content-zoom";
const ZOOM_STYLE_ID = "chatgpt-restyle-content-zoom-style";
const ZOOM_TOAST_ID = "chatgpt-restyle-content-zoom-toast";
const ZOOM_STORAGE_KEY = "chatgpt-restyle.contentZoomPercent.v1";

function styleDeclaration() {
  const values = new Map();
  return {
    values,
    setProperty(name, value) { values.set(name, value); },
    getPropertyValue(name) { return values.get(name) || ""; },
    removeProperty(name) { values.delete(name); },
  };
}

function classList() {
  const values = new Set();
  return {
    values,
    add(name) { values.add(name); },
    remove(name) { values.delete(name); },
    contains(name) { return values.has(name); },
  };
}

function fixture({
  fontAvailable = true,
  previewInsideThread = false,
  withMarkdownFileEditor = false,
  markdownFilename = "README.md",
  withPlan = false,
  planAriaLabel = "Plan",
  withQueuedMessages = false,
  withCodeSamples = false,
  storedZoom = null,
  storageThrows = false,
} = {}) {
  const nodes = new Map();
  const observers = [];
  const listeners = new Map();
  const storage = new Map();
  if (storedZoom !== null) storage.set(ZOOM_STORAGE_KEY, storedZoom);
  const zoomCandidates = new Set();
  const queuedMessages = {
    classList: classList(),
    style: styleDeclaration(),
  };
  const threadCode = {};
  const previewCode = {};
  const planCode = {};
  const makeThreadContent = () => ({
    classList: classList(),
    style: styleDeclaration(),
  });
  let threadContent = makeThreadContent();
  zoomCandidates.add(threadContent);
  const threadFooter = {
    classList: classList(),
    style: styleDeclaration(),
    previousElementSibling: threadContent,
  };
  const threadWrapper = { parentElement: null };
  const thread = {
    classList: classList(),
    style: styleDeclaration(),
    querySelector(selector) {
      if (selector === ':scope > * > [data-thread-scroll-footer="true"]') {
        return threadFooter;
      }
      return selector === "pre code, code, kbd, samp, .inline-markdown, .cm-markdown-code-line"
        && withCodeSamples
        ? threadCode
        : null;
    },
    querySelectorAll(selector) {
      return selector === '.vertical-scroll-fade-mask.hide-scrollbar[class*="max-h-[30dvh]"]'
        && withQueuedMessages
        ? [queuedMessages]
        : [];
    },
    contains(node) {
      return previewInsideThread && node === markdownFileEditor;
    },
  };
  threadWrapper.parentElement = thread;
  threadFooter.parentElement = threadWrapper;
  const markdownPanel = {
    getAttribute(name) { return name === "aria-label" ? markdownFilename : null; },
  };
  const markdownFileEditor = {
    classList: classList(),
    style: styleDeclaration(),
    querySelector(selector) {
      return selector === "pre code, code, kbd, samp, .inline-markdown, .cm-markdown-code-line"
        && withCodeSamples
        ? previewCode
        : null;
    },
    closest(selector) {
      return selector === '[role="tabpanel"][aria-label]' ? markdownPanel : null;
    },
  };
  zoomCandidates.add(markdownFileEditor);
  const makePlanContent = () => ({
    classList: classList(),
    style: styleDeclaration(),
    querySelector(selector) {
      return selector === "pre code, code, kbd, samp, .inline-markdown, .cm-markdown-code-line"
        && withCodeSamples
        ? planCode
        : null;
    },
  });
  let planContent = makePlanContent();
  zoomCandidates.add(planContent);
  const planPanel = {
    getAttribute(name) { return name === "aria-label" ? planAriaLabel : null; },
    querySelector(selector) {
      return selector === '[class*="_markdownContent_"].text-size-chat' ? planContent : null;
    },
  };
  const sidebar = { classList: classList(), style: styleDeclaration() };
  const rootNode = {
    appendChild(node) { nodes.set(node.id, node); },
  };
  const document = {
    documentElement: rootNode,
    head: rootNode,
    body: rootNode,
    fonts: { check() { return fontAvailable; } },
    createElement() {
      return {
        attributes: {},
        id: "",
        dataset: {},
        textContent: "",
        remove() { nodes.delete(this.id); },
        setAttribute(name, value) { this.attributes[name] = String(value); },
      };
    },
    getElementById(id) { return nodes.get(id) || null; },
    querySelector(selector) {
      if (selector === "main.main-surface .thread-scroll-container") return thread;
      if (selector === "aside.app-shell-left-panel") return sidebar;
      return null;
    },
    querySelectorAll(selector) {
      if (selector === 'main.main-surface [role="tabpanel"][aria-label] .cm-editor') {
        return withMarkdownFileEditor ? [markdownFileEditor] : [];
      }
      if (selector === '[role="tabpanel"][aria-label="Plan"]') {
        return withPlan && planAriaLabel === "Plan" ? [planPanel] : [];
      }
      if (selector === ".chatgpt-chat-typography-thread") {
        return thread.classList.contains(selector.slice(1)) ? [thread] : [];
      }
      if (selector === ".chatgpt-chat-typography-markdown-preview") {
        return markdownFileEditor.classList.contains(selector.slice(1))
          ? [markdownFileEditor]
          : [];
      }
      if (selector === ".chatgpt-chat-typography-plan") {
        return planContent.classList.contains(selector.slice(1)) ? [planContent] : [];
      }
      if (selector === ".chatgpt-chat-typography-native-ui") {
        return queuedMessages.classList.contains(selector.slice(1)) ? [queuedMessages] : [];
      }
      if (selector === `.${ZOOM_CLASS}`) {
        return [...zoomCandidates].filter((root) => root.classList.contains(ZOOM_CLASS));
      }
      return [];
    },
  };
  const timers = new Map();
  let nextTimer = 1;
  const window = {
    localStorage: {
      getItem(key) {
        if (storageThrows) throw new Error("storage unavailable");
        return storage.get(key) ?? null;
      },
      setItem(key, value) {
        if (storageThrows) throw new Error("storage unavailable");
        storage.set(key, String(value));
      },
    },
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(listener);
    },
    removeEventListener(type, listener) { listeners.get(type)?.delete(listener); },
  };
  const context = {
    window,
    document,
    MutationObserver: class {
      constructor(callback) { this.callback = callback; observers.push(this); }
      observe() {}
      disconnect() { this.disconnected = true; }
    },
    getComputedStyle(node) {
      if (node === threadCode) return { fontFamily: '"SFMono-Regular", monospace' };
      if (node === previewCode) return { fontFamily: '"Monaco", monospace' };
      if (node === planCode) return { fontFamily: 'ui-monospace, monospace' };
      if (node === thread) return { fontFamily: '-apple-system, "PingFang SC", sans-serif' };
      if (node === planContent) return { fontFamily: '-apple-system, "system-ui", sans-serif' };
      assert.equal(node, markdownFileEditor);
      return { fontFamily: 'Inter, -apple-system, sans-serif' };
    },
    setTimeout(callback) { const id = nextTimer++; timers.set(id, callback); return id; },
    clearTimeout(id) { timers.delete(id); },
  };
  const payload = template
    .replace("__CHATGPT_RESTYLE_CSS_JSON__", JSON.stringify(css))
    .replace("__CHATGPT_RESTYLE_VERSION_JSON__", JSON.stringify("test-revision"));
  return {
    context,
    dispatch(type, event) {
      for (const listener of [...(listeners.get(type) || [])]) listener(event);
    },
    listeners,
    nodes,
    observers,
    payload,
    markdownFileEditor,
    get threadContent() { return threadContent; },
    replaceThreadContent() {
      threadContent = makeThreadContent();
      threadFooter.previousElementSibling = threadContent;
      zoomCandidates.add(threadContent);
      return threadContent;
    },
    get planContent() { return planContent; },
    replacePlanContent() {
      planContent = makePlanContent();
      zoomCandidates.add(planContent);
      return planContent;
    },
    planPanel,
    queuedMessages,
    sidebar,
    thread,
    threadFooter,
    storage,
    timers,
  };
}

function keyboardEvent(code, overrides = {}) {
  return {
    altKey: false,
    code,
    ctrlKey: true,
    defaultPrevented: false,
    immediatePropagationStopped: false,
    isComposing: false,
    metaKey: false,
    shiftKey: true,
    preventDefault() { this.defaultPrevented = true; },
    stopImmediatePropagation() { this.immediatePropagationStopped = true; },
    ...overrides,
  };
}

test("CSS is scoped to the conversation and current Markdown file editor", () => {
  assert.match(css, /\.chatgpt-chat-typography-thread/);
  assert.match(css, /\.chatgpt-chat-typography-markdown-preview/);
  assert.match(css, /\.chatgpt-chat-typography-plan/);
  assert.match(css, /\.chatgpt-chat-typography-native-ui \*/);
  assert.match(css, /--chat-font-weight:\s*500/);
  assert.match(css, /--chat-code-font-weight:\s*400/);
  assert.match(css, /--chat-code-font-size:\s*14px/);
  assert.match(css, /--chat-code-font-family:\s*"Cascadia Code",\s*var\(--chat-native-code-font-family\)/);
  assert.match(css, /:where\(pre, code, kbd, samp, \.inline-markdown\)/);
  assert.match(css, /\.cm-markdown-code-line/);
  assert.match(css, /--chat-code-surface:\s*color-mix/);
  assert.match(css, /--chat-code-border-color:\s*color-mix/);
  assert.match(css, /"LXGW WenKai Screen"/);
  assert.match(css, /\[data-message-author-role\], article/);
  assert.match(css, /\.cm-editor/);
  assert.match(css, /\.cm-scroller, \.cm-content, \.cm-line/);
  assert.doesNotMatch(css, /Songti|STSong/i);
  assert.doesNotMatch(css, /(?:^|\n)\s*(?:html|body|main|:root)\b/);
});

test("excludes queued messages from every custom typography rule", () => {
  const current = fixture({ withQueuedMessages: true });
  const result = vm.runInNewContext(current.payload, current.context);
  assert.equal(result.nativeUiCount, 1);
  assert.equal(
    current.queuedMessages.classList.contains("chatgpt-chat-typography-native-ui"),
    true,
  );
  assert.equal(current.queuedMessages.style.values.size, 0);
  assert.equal(current.context.window.__CHATGPT_CHAT_TYPOGRAPHY_STATE__.cleanup(), true);
  assert.equal(current.queuedMessages.classList.values.size, 0);
});

test("styles the current Markdown file editor outside the thread", () => {
  const current = fixture({ withMarkdownFileEditor: true, withCodeSamples: true });
  const result = vm.runInNewContext(current.payload, current.context);
  assert.equal(result.previewCount, 1);
  assert.equal(
    current.markdownFileEditor.classList.contains("chatgpt-chat-typography-markdown-preview"),
    true,
  );
  assert.equal(
    current.markdownFileEditor.style.values.get("--chat-native-font-family"),
    "Inter, -apple-system, sans-serif",
  );
  assert.equal(
    current.markdownFileEditor.style.values.get("--chat-native-code-font-family"),
    '"Monaco", monospace',
  );
  assert.equal(current.context.window.__CHATGPT_CHAT_TYPOGRAPHY_STATE__.cleanup(), true);
  assert.equal(current.markdownFileEditor.classList.values.size, 0);
  assert.equal(current.markdownFileEditor.style.values.size, 0);
});

test("does not treat conversation Markdown as a file preview", () => {
  const current = fixture({
    previewInsideThread: true,
    withMarkdownFileEditor: true,
  });
  const result = vm.runInNewContext(current.payload, current.context);
  assert.equal(result.previewCount, 0);
  assert.equal(current.markdownFileEditor.classList.values.size, 0);
  assert.equal(current.markdownFileEditor.style.values.size, 0);
});

test("does not style a non-Markdown file editor", () => {
  const current = fixture({
    markdownFilename: "package.json",
    withMarkdownFileEditor: true,
  });
  const result = vm.runInNewContext(current.payload, current.context);
  assert.equal(result.previewCount, 0);
  assert.equal(current.markdownFileEditor.classList.values.size, 0);
  assert.equal(current.markdownFileEditor.style.values.size, 0);
});

test("styles only the Markdown root inside the semantic Plan tabpanel", () => {
  const current = fixture({ withPlan: true, withCodeSamples: true });
  const result = vm.runInNewContext(current.payload, current.context);
  assert.equal(result.planCount, 1);
  assert.equal(
    current.planContent.classList.contains("chatgpt-chat-typography-plan"),
    true,
  );
  assert.equal(
    current.planContent.style.values.get("--chat-native-font-family"),
    '-apple-system, "system-ui", sans-serif',
  );
  assert.equal(
    current.planContent.style.values.get("--chat-native-code-font-family"),
    "ui-monospace, monospace",
  );
  assert.equal(current.planPanel.classList, undefined, "tabpanel chrome must remain untouched");
});

test("does not style a non-Plan tabpanel", () => {
  const current = fixture({ withPlan: true, planAriaLabel: "README.md" });
  const result = vm.runInNewContext(current.payload, current.context);
  assert.equal(result.planCount, 0);
  assert.equal(current.planContent.classList.values.size, 0);
});

test("replaces and cleans up dynamically rendered Plan content", () => {
  const current = fixture({ withPlan: true });
  vm.runInNewContext(current.payload, current.context);
  const previous = current.planContent;
  const replacement = current.replacePlanContent();
  current.context.window.__CHATGPT_CHAT_TYPOGRAPHY_STATE__.sync();
  assert.equal(previous.classList.values.size, 0);
  assert.equal(previous.style.values.size, 0);
  assert.equal(replacement.classList.contains("chatgpt-chat-typography-plan"), true);
  assert.equal(current.context.window.__CHATGPT_CHAT_TYPOGRAPHY_STATE__.cleanup(), true);
  assert.equal(replacement.classList.values.size, 0);
  assert.equal(replacement.style.values.size, 0);
});

test("zooms the conversation, Markdown file, and Plan roots without the footer or queued UI", () => {
  const current = fixture({
    withMarkdownFileEditor: true,
    withPlan: true,
    withQueuedMessages: true,
  });
  const result = vm.runInNewContext(current.payload, current.context);

  assert.equal(result.contentZoomPercent, 100);
  assert.equal(current.threadContent.classList.contains(ZOOM_CLASS), true);
  assert.equal(current.markdownFileEditor.classList.contains(ZOOM_CLASS), true);
  assert.equal(current.planContent.classList.contains(ZOOM_CLASS), true);
  assert.equal(current.threadFooter.classList.contains(ZOOM_CLASS), false);
  assert.equal(current.queuedMessages.classList.contains(ZOOM_CLASS), false);
  assert.match(current.nodes.get(ZOOM_STYLE_ID).textContent, /zoom: 1 !important/);
});

test("loads persisted zoom and falls back for invalid or unavailable storage", () => {
  const persisted = fixture({ storedZoom: "130" });
  const result = vm.runInNewContext(persisted.payload, persisted.context);
  assert.equal(result.contentZoomPercent, 130);
  assert.match(persisted.nodes.get(ZOOM_STYLE_ID).textContent, /zoom: 1\.3 !important/);

  for (const storedZoom of ["59", "161", "90.5", "invalid"]) {
    const invalid = fixture({ storedZoom });
    assert.equal(
      vm.runInNewContext(invalid.payload, invalid.context).contentZoomPercent,
      100,
    );
  }

  const unavailable = fixture({ storageThrows: true });
  assert.equal(
    vm.runInNewContext(unavailable.payload, unavailable.context).contentZoomPercent,
    100,
  );
});

test("handles exact zoom shortcuts, persists changes, resets, and enforces limits", () => {
  const current = fixture();
  vm.runInNewContext(current.payload, current.context);

  const zoomIn = keyboardEvent("Equal");
  current.dispatch("keydown", zoomIn);
  assert.equal(zoomIn.defaultPrevented, true);
  assert.equal(zoomIn.immediatePropagationStopped, true);
  assert.equal(current.storage.get(ZOOM_STORAGE_KEY), "110");
  assert.equal(current.nodes.get(ZOOM_TOAST_ID).textContent, "正文缩放 110%");

  current.dispatch("keydown", keyboardEvent("Minus"));
  assert.equal(current.storage.get(ZOOM_STORAGE_KEY), "100");

  for (let index = 0; index < 10; index += 1) {
    current.dispatch("keydown", keyboardEvent("NumpadSubtract"));
  }
  assert.equal(current.storage.get(ZOOM_STORAGE_KEY), "60");
  assert.equal(current.context.window.__CHATGPT_CHAT_TYPOGRAPHY_STATE__.contentZoomPercent, 60);

  for (let index = 0; index < 20; index += 1) {
    current.dispatch("keydown", keyboardEvent("NumpadAdd"));
  }
  assert.equal(current.storage.get(ZOOM_STORAGE_KEY), "160");

  current.dispatch("keydown", keyboardEvent("Digit0"));
  assert.equal(current.storage.get(ZOOM_STORAGE_KEY), "100");
  assert.equal(current.context.window.__CHATGPT_CHAT_TYPOGRAPHY_STATE__.contentZoomPercent, 100);
});

test("ignores other shortcuts and synchronizes storage changes without a toast", () => {
  const current = fixture();
  vm.runInNewContext(current.payload, current.context);

  const nativeZoom = keyboardEvent("Equal", { ctrlKey: false, metaKey: true });
  current.dispatch("keydown", nativeZoom);
  assert.equal(nativeZoom.defaultPrevented, false);
  assert.equal(current.context.window.__CHATGPT_CHAT_TYPOGRAPHY_STATE__.contentZoomPercent, 100);

  const composing = keyboardEvent("Equal", { isComposing: true });
  current.dispatch("keydown", composing);
  assert.equal(composing.defaultPrevented, false);

  current.dispatch("storage", { key: ZOOM_STORAGE_KEY, newValue: "140" });
  assert.equal(current.context.window.__CHATGPT_CHAT_TYPOGRAPHY_STATE__.contentZoomPercent, 140);
  assert.equal(current.nodes.has(ZOOM_TOAST_ID), false);

  current.dispatch("storage", { key: ZOOM_STORAGE_KEY, newValue: "invalid" });
  assert.equal(current.context.window.__CHATGPT_CHAT_TYPOGRAPHY_STATE__.contentZoomPercent, 100);
});

test("resyncs replaced zoom roots and cleanup keeps the persisted preference", () => {
  const current = fixture({ withPlan: true, storedZoom: "120" });
  vm.runInNewContext(current.payload, current.context);
  const oldThreadContent = current.threadContent;
  const oldPlanContent = current.planContent;
  const nextThreadContent = current.replaceThreadContent();
  const nextPlanContent = current.replacePlanContent();

  current.context.window.__CHATGPT_CHAT_TYPOGRAPHY_STATE__.sync();
  assert.equal(oldThreadContent.classList.contains(ZOOM_CLASS), false);
  assert.equal(oldPlanContent.classList.contains(ZOOM_CLASS), false);
  assert.equal(nextThreadContent.classList.contains(ZOOM_CLASS), true);
  assert.equal(nextPlanContent.classList.contains(ZOOM_CLASS), true);

  current.dispatch("keydown", keyboardEvent("Equal"));
  assert.equal(current.storage.get(ZOOM_STORAGE_KEY), "130");
  assert.equal(current.context.window.__CHATGPT_CHAT_TYPOGRAPHY_STATE__.cleanup(), true);
  assert.equal(current.storage.get(ZOOM_STORAGE_KEY), "130");
  assert.equal(current.listeners.get("keydown").size, 0);
  assert.equal(current.listeners.get("storage").size, 0);
  assert.equal(current.timers.size, 0);
  assert.equal(current.nodes.size, 0);
  assert.equal(nextThreadContent.classList.contains(ZOOM_CLASS), false);
  assert.equal(nextPlanContent.classList.contains(ZOOM_CLASS), false);
});

test("injects once, captures native fonts, and leaves sidebar untouched", () => {
  const current = fixture({ withCodeSamples: true });
  const result = vm.runInNewContext(current.payload, current.context);
  assert.equal(result.installed, true);
  assert.equal(result.threadFound, true);
  assert.equal(result.fontAvailable, true);
  assert.equal(current.thread.classList.contains("chatgpt-chat-typography-thread"), true);
  assert.equal(
    current.thread.style.values.get("--chat-native-font-family"),
    '-apple-system, "PingFang SC", sans-serif',
  );
  assert.equal(
    current.thread.style.values.get("--chat-native-code-font-family"),
    '"SFMono-Regular", monospace',
  );
  assert.equal(current.sidebar.classList.values.size, 0);
  assert.equal(current.sidebar.style.values.size, 0);
  assert.equal(current.nodes.size, 2);
  assert.equal(current.listeners.get("keydown").size, 1);
  assert.equal(current.listeners.get("storage").size, 1);

  current.dispatch("keydown", keyboardEvent("Equal"));
  assert.equal(current.nodes.has(ZOOM_TOAST_ID), true);
  assert.equal(current.timers.size, 1);
  vm.runInNewContext(current.payload, current.context);
  assert.equal(current.nodes.size, 2, "reapply must reuse the two style elements");
  assert.equal(current.timers.size, 0, "reapply must clear the previous toast timer");
  assert.equal(current.listeners.get("keydown").size, 1);
  assert.equal(current.listeners.get("storage").size, 1);
  assert.equal(current.context.window.__CHATGPT_CHAT_TYPOGRAPHY_STATE__.contentZoomPercent, 110);
  assert.equal(
    current.context.window.__CHATGPT_CHAT_TYPOGRAPHY_STATE__.nativeFontFamily,
    '-apple-system, "PingFang SC", sans-serif',
  );
});

test("reports a missing font and cleanup fully detaches the thread", () => {
  const current = fixture({ fontAvailable: false, withCodeSamples: true });
  const result = vm.runInNewContext(current.payload, current.context);
  assert.equal(result.fontAvailable, false);
  assert.equal(current.context.window.__CHATGPT_CHAT_TYPOGRAPHY_STATE__.cleanup(), true);
  assert.equal(current.thread.classList.contains("chatgpt-chat-typography-thread"), false);
  assert.equal(current.thread.style.values.has("--chat-native-font-family"), false);
  assert.equal(current.thread.style.values.has("--chat-native-code-font-family"), false);
  assert.equal(current.nodes.size, 0);
  assert.equal(current.context.window.__CHATGPT_CHAT_TYPOGRAPHY_STATE__, undefined);
});
