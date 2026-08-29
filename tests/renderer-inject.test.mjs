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
const THREAD_ZOOM_LAYOUT_CLASS = "chatgpt-restyle-content-zoom-thread-layout";
const ZOOM_STYLE_ID = "chatgpt-restyle-content-zoom-style";
const ZOOM_TOAST_ID = "chatgpt-restyle-content-zoom-toast";
const ZOOM_STORAGE_KEY = "chatgpt-restyle.contentZoomPercent.v1";
const TERMINAL_ZOOM_STORAGE_KEY = "chatgpt-restyle.terminalZoomPercent.v1";
const TERMINAL_NATIVE_FONT_FAMILY = 'ui-monospace, "SFMono-Regular", Menlo, monospace';
const TERMINAL_CUSTOM_FONT_FAMILY = `"Cascadia Code", ${TERMINAL_NATIVE_FONT_FAMILY}`;
const MESSAGE_CLASS = "chatgpt-chat-typography-message";
const MESSAGE_SELECTOR = [
  '[data-user-message-bubble="true"] [class*="_markdownContent_"]',
  '[data-content-search-unit-key$=":assistant"] [class*="_markdownContent_"]',
].join(", ");

function styleDeclaration() {
  const values = new Map();
  const priorities = new Map();
  return {
    values,
    setProperty(name, value, priority = "") {
      values.set(name, value);
      priorities.set(name, priority);
    },
    getPropertyValue(name) { return values.get(name) || ""; },
    getPropertyPriority(name) { return priorities.get(name) || ""; },
    removeProperty(name) {
      values.delete(name);
      priorities.delete(name);
    },
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
  fontEnabled = true,
  zoomEnabled = true,
  fontAvailable = true,
  previewInsideThread = false,
  withMarkdownFileEditor = false,
  markdownFilename = "README.md",
  withPlan = false,
  planAriaLabel = "Plan",
  withQueuedMessages = false,
  withCodeSamples = false,
  withTerminal = false,
  withSecondTerminal = false,
  storedZoom = null,
  storedTerminalZoom = null,
  storageThrows = false,
  terminalFontWriteThrows = false,
  firstTerminalFontSizeWriteThrows = false,
  firstTerminalFitThrows = false,
} = {}) {
  const nodes = new Map();
  const observers = [];
  const listeners = new Map();
  const storage = new Map();
  if (storedZoom !== null) storage.set(ZOOM_STORAGE_KEY, storedZoom);
  if (storedTerminalZoom !== null) {
    storage.set(TERMINAL_ZOOM_STORAGE_KEY, storedTerminalZoom);
  }
  const zoomCandidates = new Set();
  const queuedMessages = {
    classList: classList(),
    style: styleDeclaration(),
  };
  const threadCode = {};
  const userMessage = { classList: classList(), style: styleDeclaration() };
  const assistantMessage = { classList: classList(), style: styleDeclaration() };
  const previewCode = {};
  const planCode = {};
  let terminalCount = 0;
  const hookChain = (candidates) => candidates.reduceRight((next, current) => ({
    memoizedState: { current },
    next,
  }), null);
  const setTerminalHookLayers = (root, layers) => {
    let parent = null;
    for (let index = layers.length - 1; index >= 0; index -= 1) {
      parent = { memoizedState: hookChain(layers[index]), return: parent };
    }
    root.__reactFiber$test = { memoizedState: null, return: parent };
  };
  const makeTerminal = (fontSize = 13) => {
    const terminalIndex = terminalCount;
    terminalCount += 1;
    let fontFamily = TERMINAL_NATIVE_FONT_FAMILY;
    let currentFontSize = fontSize;
    const instance = {
      options: {
        get fontFamily() { return fontFamily; },
        set fontFamily(value) {
          if (terminalFontWriteThrows) throw new Error("font update failed");
          fontFamily = value;
        },
        get fontSize() { return currentFontSize; },
        set fontSize(value) {
          if (firstTerminalFontSizeWriteThrows && terminalIndex === 0) {
            throw new Error("font size update failed");
          }
          currentFontSize = value;
        },
      },
      open() {},
      write() {},
    };
    const decoyInstance = {
      options: { fontFamily: "monospace", fontSize: 11 },
      open() {},
      write() {},
    };
    const decoyFitAddon = {
      _terminal: {},
      fitCalls: 0,
      fit() { this.fitCalls += 1; },
      dispose() {},
    };
    const fitAddon = {
      _terminal: instance,
      fitCalls: 0,
      fitFontFamilies: [],
      fit() {
        this.fitCalls += 1;
        this.fitFontFamilies.push(instance.options.fontFamily);
        if (firstTerminalFitThrows && terminalIndex === 0) {
          throw new Error("fit failed");
        }
      },
      dispose() {},
    };
    const root = { style: styleDeclaration() };
    const runtimeRefs = [decoyInstance, decoyFitAddon, fitAddon, instance];
    setTerminalHookLayers(root, [runtimeRefs]);
    const textarea = {
      closest(selector) { return selector === "[data-codex-xterm]" ? root : null; },
    };
    return {
      decoyFitAddon,
      decoyInstance,
      fitAddon,
      instance,
      root,
      runtimeRefs,
      setHookLayers(layers) { setTerminalHookLayers(root, layers); },
      textarea,
    };
  };
  const terminal = makeTerminal();
  const mountedTerminals = withTerminal ? [terminal] : [];
  if (withSecondTerminal) mountedTerminals.push(makeTerminal(15));
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
      if (selector === MESSAGE_SELECTOR) return assistantMessage;
      return selector === "pre code, code, kbd, samp, .inline-markdown, .cm-markdown-code-line"
        && withCodeSamples
        ? threadCode
        : null;
    },
    querySelectorAll(selector) {
      if (selector === MESSAGE_SELECTOR) return [userMessage, assistantMessage];
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
      return selector === '[class*="_markdownContent_"].text-size-chat'
        ? planContent
        : null;
    },
  };
  const sidebar = { classList: classList(), style: styleDeclaration() };
  const rootNode = {
    classList: classList(),
    appendChild(node) { nodes.set(node.id, node); },
  };
  const document = {
    activeElement: null,
    documentElement: rootNode,
    head: rootNode,
    body: rootNode,
    fonts: {
      check() { return fontAvailable; },
      load() { return Promise.resolve([]); },
    },
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
      if (selector === "main.main-surface .thread-scroll-container") {
        return thread;
      }
      if (selector === "aside.app-shell-left-panel") return sidebar;
      return null;
    },
    querySelectorAll(selector) {
      if (selector === '[role="tabpanel"][aria-label] .cm-editor') {
        return withMarkdownFileEditor
          ? [markdownFileEditor]
          : [];
      }
      if (selector === '[role="tabpanel"][aria-label="Plan"]') {
        return withPlan && planAriaLabel === "Plan" ? [planPanel] : [];
      }
      if (selector === "[data-codex-xterm]") {
        return mountedTerminals.map(({ root }) => root);
      }
      if (selector === ".chatgpt-chat-typography-thread") {
        return thread.classList.contains(selector.slice(1)) ? [thread] : [];
      }
      if (selector === `.${MESSAGE_CLASS}`) {
        return [userMessage, assistantMessage]
          .filter((message) => message.classList.contains(MESSAGE_CLASS));
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
      if (selector === `.${THREAD_ZOOM_LAYOUT_CLASS}`) {
        return [...zoomCandidates]
          .filter((root) => root.classList.contains(THREAD_ZOOM_LAYOUT_CLASS));
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
      if (node === assistantMessage) {
        return { fontFamily: '-apple-system, "PingFang SC", sans-serif' };
      }
      if (node === planContent) return { fontFamily: '-apple-system, "system-ui", sans-serif' };
      const terminalRoot = mountedTerminals
        .find(({ root: candidate }) => node === candidate)?.root;
      if (terminalRoot) {
        return {
          getPropertyValue(name) {
            if (name !== "--chat-code-font-family") return "";
            const nativeFamily = terminalRoot.style.getPropertyValue(
              "--chat-native-code-font-family",
            ) || "ui-monospace, monospace";
            return `"Cascadia Code", ${nativeFamily}`;
          },
        };
      }
      assert.equal(node, markdownFileEditor);
      return { fontFamily: 'Inter, -apple-system, sans-serif' };
    },
    setTimeout(callback) { const id = nextTimer++; timers.set(id, callback); return id; },
    clearTimeout(id) { timers.delete(id); },
  };
  const payloadFor = ({
    fontEnabled: nextFontEnabled = fontEnabled,
    zoomEnabled: nextZoomEnabled = zoomEnabled,
  } = {}) => template
    .replace("__CHATGPT_RESTYLE_CSS_JSON__", JSON.stringify(css))
    .replace("__CHATGPT_RESTYLE_VERSION_JSON__", JSON.stringify("test-revision"))
    .replace("__CHATGPT_RESTYLE_FONT_ENABLED_JSON__", JSON.stringify(nextFontEnabled))
    .replace("__CHATGPT_RESTYLE_ZOOM_ENABLED_JSON__", JSON.stringify(nextZoomEnabled));
  const payload = payloadFor();
  return {
    context,
    dispatch(type, event) {
      for (const listener of [...(listeners.get(type) || [])]) listener(event);
    },
    listeners,
    nodes,
    observers,
    payload,
    payloadFor,
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
    userMessage,
    assistantMessage,
    threadFooter,
    storage,
    get terminalInstance() { return terminal.instance; },
    get terminalInstances() { return mountedTerminals.map(({ instance }) => instance); },
    get terminalFitAddon() { return terminal.fitAddon; },
    get terminalFitAddons() { return mountedTerminals.map(({ fitAddon }) => fitAddon); },
    get terminalDecoyFitAddons() { return mountedTerminals.map(({ decoyFitAddon }) => decoyFitAddon); },
    get terminalDecoyInstances() { return mountedTerminals.map(({ decoyInstance }) => decoyInstance); },
    get terminalRoot() { return terminal.root; },
    buryTerminalRuntimeBeyondHookLimit(index = 0) {
      const selected = mountedTerminals[index];
      const padding = Array.from({ length: 32 }, () => ({}));
      selected?.setHookLayers([padding, padding.map(() => ({})), selected.runtimeRefs]);
    },
    restoreTerminalRuntime(index = 0) {
      const selected = mountedTerminals[index];
      if (selected) selected.setHookLayers([selected.runtimeRefs]);
    },
    focusTerminal(index = 0) { document.activeElement = mountedTerminals[index]?.textarea || null; },
    blurTerminal() { document.activeElement = null; },
    mountTerminal(fontSize = 13) {
      const next = makeTerminal(fontSize);
      mountedTerminals.push(next);
      return next;
    },
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

test("CSS styles the app UI, conversation, and current Markdown file editor", () => {
  assert.match(css, /\.chatgpt-chat-typography-thread/);
  assert.match(css, /\.chatgpt-chat-typography-markdown-preview/);
  assert.match(css, /\.file-editor-heading/);
  assert.match(css, /\.chatgpt-chat-typography-plan\.chatgpt-chat-typography-plan/);
  assert.match(css, /\.chatgpt-chat-typography-plan/);
  assert.match(css, /\.chatgpt-chat-typography-native-ui \*/);
  assert.match(css, /--chat-font-weight:\s*500/);
  assert.match(css, /--chat-code-font-weight:\s*400/);
  assert.match(css, /--chat-code-font-size:\s*14px/);
  assert.match(css, /--chat-code-font-family:\s*"Cascadia Code",\s*var\(--chat-native-code-font-family,\s*ui-monospace,\s*monospace\)/);
  assert.match(css, /:where\(pre, code, kbd, samp, \.inline-markdown\)/);
  assert.match(css, /\.cm-markdown-code-line/);
  assert.match(css, /--chat-code-surface:\s*color-mix/);
  assert.match(css, /--chat-code-border-color:\s*color-mix/);
  assert.match(css, /--chat-ui-font-family:\s*"Oxanium"/);
  assert.match(css, /--chat-font-family:\s*"Oxanium",\s*"LXGW WenKai Screen"/);
  assert.match(css, /\.chatgpt-restyle-font-root body \*/);
  assert.match(css, /font-family:\s*var\(--chat-ui-font-family\),\s*system-ui,\s*sans-serif/);
  assert.match(css, /\.chatgpt-restyle-font-root \[data-codex-xterm\] \*/);
  assert.match(css, /font-family:\s*var\(--chat-code-font-family\) !important/);
  assert.match(css, /\.chatgpt-chat-typography-message/);
  assert.match(css, /\.chatgpt-chat-typography-message:not\([\s\S]*?font-family:\s*var\(--chat-font-family\)/);
  assert.match(css, /\.cm-editor/);
  assert.match(css, /\.cm-scroller, \.cm-content, \.cm-line/);
  assert.match(template, /\[data-user-message-bubble="true"\]/);
  assert.match(template, /\[data-content-search-unit-key\$=":assistant"\]/);
  assert.match(template, /\.cm-editor/);
  assert.match(template, /\[class\*="_markdownContent_"\]\.text-size-chat/);
  assert.match(template, /\[data-codex-xterm\]/);
  assert.match(template, /__reactFiber\$/);
  assert.doesNotMatch(template, /data-plan-selection-surface/);
  assert.doesNotMatch(css, /\[data-message-author-role\]|\[class\*="_markdown"\]/);
  assert.doesNotMatch(css, /Songti|STSong/i);
  assert.doesNotMatch(css, /(?:^|\n)\s*(?:html|main)\b/);
});

test("applies persisted Terminal zoom to every xterm and restores native metrics", () => {
  const current = fixture({
    storedZoom: "130",
    storedTerminalZoom: "120",
    withTerminal: true,
    withSecondTerminal: true,
  });
  const result = vm.runInNewContext(current.payload, current.context);

  assert.equal(result.contentZoomPercent, 130);
  assert.equal(result.terminalZoomPercent, 120);
  assert.deepEqual(
    current.terminalInstances.map(({ options }) => options.fontSize),
    [15.6, 18],
  );
  assert.deepEqual(current.terminalFitAddons.map(({ fitCalls }) => fitCalls), [1, 1]);
  assert.deepEqual(current.terminalDecoyFitAddons.map(({ fitCalls }) => fitCalls), [0, 0]);
  assert.deepEqual(
    current.terminalDecoyInstances.map(({ options }) => options.fontSize),
    [11, 11],
    "an unrelated xterm ref must not be selected without its matching FitAddon",
  );
  for (const instance of current.terminalInstances) {
    assert.equal(instance.options.fontFamily, TERMINAL_CUSTOM_FONT_FAMILY);
  }
  assert.equal(
    current.terminalRoot.style.getPropertyValue("--chat-native-code-font-family"),
    TERMINAL_NATIVE_FONT_FAMILY,
  );

  vm.runInNewContext(current.payload, current.context);
  assert.deepEqual(
    current.terminalInstances.map(({ options }) => options.fontSize),
    [15.6, 18],
    "reapply must not compound Terminal zoom",
  );
  assert.deepEqual(
    current.terminalFitAddons.map(({ fitCalls }) => fitCalls),
    [3, 3],
    "reapply must fit both restored and reapplied sizes",
  );

  assert.equal(current.context.window.__CHATGPT_CHAT_TYPOGRAPHY_STATE__.cleanup(), true);
  assert.deepEqual(
    current.terminalInstances.map(({ options }) => options.fontSize),
    [13, 15],
  );
  assert.deepEqual(current.terminalFitAddons.map(({ fitCalls }) => fitCalls), [4, 4]);
  for (const instance of current.terminalInstances) {
    assert.equal(instance.options.fontFamily, TERMINAL_NATIVE_FONT_FAMILY);
  }
  for (const fitAddon of current.terminalFitAddons) {
    assert.equal(
      fitAddon.fitFontFamilies.at(-1),
      TERMINAL_NATIVE_FONT_FAMILY,
      "cleanup must fit the restored size against the restored native font",
    );
  }
  assert.equal(current.terminalRoot.style.values.size, 0);
});

test("bounds Terminal Fiber lookup across all parent hooks", () => {
  const current = fixture({
    storedTerminalZoom: "120",
    withTerminal: true,
  });
  current.buryTerminalRuntimeBeyondHookLimit();
  vm.runInNewContext(current.payload, current.context);

  assert.equal(current.terminalInstance.options.fontSize, 13);
  assert.equal(current.terminalFitAddon.fitCalls, 0);
  current.restoreTerminalRuntime();
  current.context.window.__CHATGPT_CHAT_TYPOGRAPHY_STATE__.sync();
  assert.equal(current.terminalInstance.options.fontSize, 15.6);
  assert.equal(current.terminalFitAddon.fitCalls, 1);
});

test("isolates Terminal font-size assignment and FitAddon failures", () => {
  const failedAssignment = fixture({
    firstTerminalFontSizeWriteThrows: true,
    storedTerminalZoom: "120",
    withTerminal: true,
    withSecondTerminal: true,
  });
  vm.runInNewContext(failedAssignment.payload, failedAssignment.context);
  assert.deepEqual(
    failedAssignment.terminalInstances.map(({ options }) => options.fontSize),
    [13, 18],
  );
  assert.deepEqual(
    failedAssignment.terminalFitAddons.map(({ fitCalls }) => fitCalls),
    [0, 1],
  );

  const failedFit = fixture({
    firstTerminalFitThrows: true,
    storedTerminalZoom: "120",
    withTerminal: true,
    withSecondTerminal: true,
  });
  vm.runInNewContext(failedFit.payload, failedFit.context);
  assert.deepEqual(
    failedFit.terminalInstances.map(({ options }) => options.fontSize),
    [15.6, 18],
  );
  assert.deepEqual(failedFit.terminalFitAddons.map(({ fitCalls }) => fitCalls), [1, 1]);
  assert.equal(failedFit.context.window.__CHATGPT_CHAT_TYPOGRAPHY_STATE__.cleanup(), true);
  assert.deepEqual(
    failedFit.terminalInstances.map(({ options }) => options.fontSize),
    [13, 15],
  );
  assert.deepEqual(failedFit.terminalFitAddons.map(({ fitCalls }) => fitCalls), [2, 2]);
});

test("tracks theme Terminal base size changes and resets to the latest base", () => {
  const current = fixture({
    storedTerminalZoom: "120",
    withTerminal: true,
  });
  vm.runInNewContext(current.payload, current.context);
  assert.equal(current.terminalInstance.options.fontSize, 15.6);
  assert.equal(current.terminalFitAddon.fitCalls, 1);

  current.terminalInstance.options.fontSize = 14;
  current.context.window.__CHATGPT_CHAT_TYPOGRAPHY_STATE__.sync();
  assert.equal(current.terminalInstance.options.fontSize, 16.8);
  assert.equal(current.terminalFitAddon.fitCalls, 2);

  current.focusTerminal();
  current.dispatch("keydown", keyboardEvent("Digit0"));
  assert.equal(current.terminalInstance.options.fontSize, 14);
  assert.equal(current.terminalFitAddon.fitCalls, 3);
  assert.equal(current.context.window.__CHATGPT_CHAT_TYPOGRAPHY_STATE__.cleanup(), true);
  assert.equal(current.terminalInstance.options.fontSize, 14);
  assert.equal(current.terminalFitAddon.fitCalls, 3);
});

test("keeps Terminal zoom independent when its runtime font update fails", () => {
  const current = fixture({
    storedTerminalZoom: "120",
    terminalFontWriteThrows: true,
    withTerminal: true,
  });
  vm.runInNewContext(current.payload, current.context);

  assert.equal(current.terminalInstance.options.fontFamily, TERMINAL_NATIVE_FONT_FAMILY);
  assert.equal(current.terminalInstance.options.fontSize, 15.6);
  assert.equal(current.context.window.__CHATGPT_CHAT_TYPOGRAPHY_STATE__.cleanup(), true);
  assert.equal(current.terminalInstance.options.fontSize, 13);
  assert.equal(current.terminalRoot.style.values.size, 0);
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
  assert.equal(
    current.threadContent.classList.contains(THREAD_ZOOM_LAYOUT_CLASS),
    true,
  );
  assert.equal(current.markdownFileEditor.classList.contains(ZOOM_CLASS), true);
  assert.equal(
    current.markdownFileEditor.classList.contains(THREAD_ZOOM_LAYOUT_CLASS),
    false,
  );
  assert.equal(current.planContent.classList.contains(ZOOM_CLASS), true);
  assert.equal(current.planContent.classList.contains(THREAD_ZOOM_LAYOUT_CLASS), false);
  assert.equal(current.threadFooter.classList.contains(ZOOM_CLASS), false);
  assert.equal(current.queuedMessages.classList.contains(ZOOM_CLASS), false);
  assert.match(
    current.nodes.get(ZOOM_STYLE_ID).textContent,
    /inline-size: 100% !important;\s+zoom: 1 !important/,
  );
  assert.match(
    current.nodes.get(ZOOM_STYLE_ID).textContent,
    /max-inline-size: calc\(var\(--thread-content-max-width\) \/ 1\) !important/,
  );
});

test("loads persisted zoom and falls back for invalid or unavailable storage", () => {
  const persisted = fixture({ storedZoom: "130" });
  const result = vm.runInNewContext(persisted.payload, persisted.context);
  assert.equal(result.contentZoomPercent, 130);
  assert.match(
    persisted.nodes.get(ZOOM_STYLE_ID).textContent,
    /inline-size: 76\.92307692307692% !important;\s+zoom: 1\.3 !important/,
  );
  assert.match(
    persisted.nodes.get(ZOOM_STYLE_ID).textContent,
    /max-inline-size: calc\(var\(--thread-content-max-width\) \/ 1\.3\) !important/,
  );

  for (const storedZoom of ["59", "161", "90.5", "invalid"]) {
    const invalid = fixture({ storedZoom });
    assert.equal(
      vm.runInNewContext(invalid.payload, invalid.context).contentZoomPercent,
      100,
    );
  }

  for (const storedTerminalZoom of ["59", "161", "90.5", "invalid"]) {
    const invalid = fixture({ storedTerminalZoom, withTerminal: true });
    assert.equal(
      vm.runInNewContext(invalid.payload, invalid.context).terminalZoomPercent,
      100,
    );
    assert.equal(invalid.terminalInstance.options.fontSize, 13);
  }

  const unavailable = fixture({ storageThrows: true });
  const unavailableResult = vm.runInNewContext(unavailable.payload, unavailable.context);
  assert.equal(unavailableResult.contentZoomPercent, 100);
  assert.equal(unavailableResult.terminalZoomPercent, 100);
});

test("keeps every zoom level within a fixed visual inline size", () => {
  for (const [percent, inversePercent, factor] of [
    [60, "166.66666666666666", "0.6"],
    [100, "100", "1"],
    [130, "76.92307692307692", "1.3"],
    [160, "62.5", "1.6"],
  ]) {
    const current = fixture({ storedZoom: String(percent) });
    vm.runInNewContext(current.payload, current.context);
    const zoomStyle = current.nodes.get(ZOOM_STYLE_ID).textContent;

    assert.match(
      zoomStyle,
      new RegExp(`inline-size: ${inversePercent.replaceAll(".", "\\.")}% !important;`),
    );
    assert.match(zoomStyle, new RegExp(`zoom: ${factor.replace(".", "\\.")} !important;`));
    assert.match(
      zoomStyle,
      new RegExp(
        `max-inline-size: calc\\(var\\(--thread-content-max-width\\) / ${
          factor.replace(".", "\\.")
        }\\) !important;`,
      ),
    );
  }
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

test("routes zoom shortcuts by Terminal focus without changing content zoom", () => {
  const current = fixture({ withTerminal: true, withSecondTerminal: true });
  vm.runInNewContext(current.payload, current.context);
  current.focusTerminal();

  const zoomIn = keyboardEvent("Equal");
  current.dispatch("keydown", zoomIn);
  assert.equal(zoomIn.defaultPrevented, true);
  assert.equal(zoomIn.immediatePropagationStopped, true);
  assert.equal(current.storage.get(TERMINAL_ZOOM_STORAGE_KEY), "110");
  assert.equal(current.storage.has(ZOOM_STORAGE_KEY), false);
  assert.equal(
    current.context.window.__CHATGPT_CHAT_TYPOGRAPHY_STATE__.contentZoomPercent,
    100,
  );
  assert.equal(
    current.context.window.__CHATGPT_CHAT_TYPOGRAPHY_STATE__.terminalZoomPercent,
    110,
  );
  assert.deepEqual(
    current.terminalInstances.map(({ options }) => options.fontSize),
    [14.3, 16.5],
  );
  assert.deepEqual(current.terminalFitAddons.map(({ fitCalls }) => fitCalls), [1, 1]);
  assert.deepEqual(current.terminalDecoyFitAddons.map(({ fitCalls }) => fitCalls), [0, 0]);
  assert.equal(current.nodes.get(ZOOM_TOAST_ID).textContent, "Terminal 缩放 110%");

  for (let index = 0; index < 10; index += 1) {
    current.dispatch("keydown", keyboardEvent("NumpadSubtract"));
  }
  assert.equal(current.storage.get(TERMINAL_ZOOM_STORAGE_KEY), "60");
  assert.deepEqual(
    current.terminalInstances.map(({ options }) => options.fontSize),
    [7.8, 9],
  );

  for (let index = 0; index < 20; index += 1) {
    current.dispatch("keydown", keyboardEvent("NumpadAdd"));
  }
  assert.equal(current.storage.get(TERMINAL_ZOOM_STORAGE_KEY), "160");
  assert.deepEqual(
    current.terminalInstances.map(({ options }) => options.fontSize),
    [20.8, 24],
  );

  current.dispatch("keydown", keyboardEvent("Digit0"));
  assert.equal(current.storage.get(TERMINAL_ZOOM_STORAGE_KEY), "100");
  assert.deepEqual(
    current.terminalInstances.map(({ options }) => options.fontSize),
    [13, 15],
  );
  assert.deepEqual(current.terminalFitAddons.map(({ fitCalls }) => fitCalls), [17, 17]);

  current.blurTerminal();
  current.dispatch("keydown", keyboardEvent("Equal"));
  assert.equal(current.storage.get(ZOOM_STORAGE_KEY), "110");
  assert.equal(current.storage.get(TERMINAL_ZOOM_STORAGE_KEY), "100");
  assert.equal(current.nodes.get(ZOOM_TOAST_ID).textContent, "正文缩放 110%");
});

test("synchronizes Terminal zoom across windows and newly mounted xterms", () => {
  const current = fixture({ withTerminal: true });
  vm.runInNewContext(current.payload, current.context);

  current.dispatch("storage", { key: TERMINAL_ZOOM_STORAGE_KEY, newValue: "140" });
  assert.equal(
    current.context.window.__CHATGPT_CHAT_TYPOGRAPHY_STATE__.terminalZoomPercent,
    140,
  );
  assert.equal(current.terminalInstance.options.fontSize, 18.2);
  assert.equal(current.terminalFitAddon.fitCalls, 1);
  assert.equal(current.context.window.__CHATGPT_CHAT_TYPOGRAPHY_STATE__.contentZoomPercent, 100);
  assert.equal(current.nodes.has(ZOOM_TOAST_ID), false);

  const mounted = current.mountTerminal(16);
  current.context.window.__CHATGPT_CHAT_TYPOGRAPHY_STATE__.sync();
  assert.equal(mounted.instance.options.fontSize, 22.4);
  assert.equal(mounted.fitAddon.fitCalls, 1);
  assert.equal(mounted.instance.options.fontFamily, TERMINAL_CUSTOM_FONT_FAMILY);

  current.dispatch("storage", { key: TERMINAL_ZOOM_STORAGE_KEY, newValue: "invalid" });
  assert.equal(current.terminalInstance.options.fontSize, 13);
  assert.equal(current.terminalFitAddon.fitCalls, 2);
  assert.equal(mounted.instance.options.fontSize, 16);
  assert.equal(mounted.fitAddon.fitCalls, 2);
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
  assert.equal(oldThreadContent.classList.contains(THREAD_ZOOM_LAYOUT_CLASS), false);
  assert.equal(oldPlanContent.classList.contains(ZOOM_CLASS), false);
  assert.equal(nextThreadContent.classList.contains(ZOOM_CLASS), true);
  assert.equal(
    nextThreadContent.classList.contains(THREAD_ZOOM_LAYOUT_CLASS),
    true,
  );
  assert.equal(nextPlanContent.classList.contains(ZOOM_CLASS), true);
  assert.equal(nextPlanContent.classList.contains(THREAD_ZOOM_LAYOUT_CLASS), false);

  current.dispatch("keydown", keyboardEvent("Equal"));
  assert.equal(current.storage.get(ZOOM_STORAGE_KEY), "130");
  assert.equal(current.context.window.__CHATGPT_CHAT_TYPOGRAPHY_STATE__.cleanup(), true);
  assert.equal(current.storage.get(ZOOM_STORAGE_KEY), "130");
  assert.equal(current.listeners.get("keydown").size, 0);
  assert.equal(current.listeners.get("storage").size, 0);
  assert.equal(current.timers.size, 0);
  assert.equal(current.nodes.size, 0);
  assert.equal(nextThreadContent.classList.contains(ZOOM_CLASS), false);
  assert.equal(
    nextThreadContent.classList.contains(THREAD_ZOOM_LAYOUT_CLASS),
    false,
  );
  assert.equal(nextPlanContent.classList.contains(ZOOM_CLASS), false);
});

test("injects once, captures native fonts, and leaves sidebar untouched", () => {
  const current = fixture({ withCodeSamples: true });
  const result = vm.runInNewContext(current.payload, current.context);
  assert.equal(result.installed, true);
  assert.equal(result.threadFound, true);
  assert.equal(result.fontAvailable, true);
  assert.equal(current.thread.classList.contains("chatgpt-chat-typography-thread"), true);
  assert.equal(current.context.document.documentElement.classList.contains("chatgpt-restyle-font-root"), true);
  assert.equal(current.userMessage.classList.contains(MESSAGE_CLASS), true);
  assert.equal(current.assistantMessage.classList.contains(MESSAGE_CLASS), true);
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
  assert.equal(current.userMessage.classList.contains(MESSAGE_CLASS), false);
  assert.equal(current.assistantMessage.classList.contains(MESSAGE_CLASS), false);
  assert.equal(current.thread.style.values.has("--chat-native-font-family"), false);
  assert.equal(current.thread.style.values.has("--chat-native-code-font-family"), false);
  assert.equal(current.nodes.size, 0);
  assert.equal(current.context.window.__CHATGPT_CHAT_TYPOGRAPHY_STATE__, undefined);
  assert.equal(current.context.document.documentElement.classList.contains("chatgpt-restyle-font-root"), false);
});

test("font can be disabled while zoom remains active", () => {
  const current = fixture({
    fontEnabled: false,
    zoomEnabled: true,
    storedTerminalZoom: "120",
    withTerminal: true,
  });
  const result = vm.runInNewContext(current.payload, current.context);

  assert.equal(result.fontEnabled, false);
  assert.equal(result.zoomEnabled, true);
  assert.equal(result.fontAvailable, null);
  assert.equal(current.nodes.has("chatgpt-chat-typography-style"), false);
  assert.equal(current.thread.classList.contains("chatgpt-chat-typography-thread"), false);
  assert.equal(current.userMessage.classList.contains(MESSAGE_CLASS), false);
  assert.equal(current.assistantMessage.classList.contains(MESSAGE_CLASS), false);
  assert.equal(current.thread.style.values.size, 0);
  assert.equal(current.threadContent.classList.contains(ZOOM_CLASS), true);
  assert.equal(
    current.threadContent.classList.contains(THREAD_ZOOM_LAYOUT_CLASS),
    true,
  );
  assert.equal(current.nodes.has(ZOOM_STYLE_ID), true);
  assert.equal(current.listeners.get("keydown").size, 1);
  assert.equal(current.terminalInstance.options.fontFamily, TERMINAL_NATIVE_FONT_FAMILY);
  assert.equal(current.terminalInstance.options.fontSize, 15.6);
  assert.equal(current.context.window.__CHATGPT_CHAT_TYPOGRAPHY_STATE__.cleanup(), true);
  assert.equal(current.terminalInstance.options.fontSize, 13);
});

test("zoom layout is identical with custom typography enabled or disabled", () => {
  const withFont = fixture({
    fontEnabled: true,
    zoomEnabled: true,
    storedZoom: "130",
    withMarkdownFileEditor: true,
    withPlan: true,
  });
  const withoutFont = fixture({
    fontEnabled: false,
    zoomEnabled: true,
    storedZoom: "130",
    withMarkdownFileEditor: true,
    withPlan: true,
  });

  vm.runInNewContext(withFont.payload, withFont.context);
  vm.runInNewContext(withoutFont.payload, withoutFont.context);

  assert.equal(
    withFont.nodes.get(ZOOM_STYLE_ID).textContent,
    withoutFont.nodes.get(ZOOM_STYLE_ID).textContent,
  );
  for (const current of [withFont, withoutFont]) {
    assert.equal(current.threadContent.classList.contains(ZOOM_CLASS), true);
    assert.equal(
      current.threadContent.classList.contains(THREAD_ZOOM_LAYOUT_CLASS),
      true,
    );
    assert.equal(current.markdownFileEditor.classList.contains(ZOOM_CLASS), true);
    assert.equal(
      current.markdownFileEditor.classList.contains(THREAD_ZOOM_LAYOUT_CLASS),
      false,
    );
    assert.equal(current.planContent.classList.contains(ZOOM_CLASS), true);
    assert.equal(
      current.planContent.classList.contains(THREAD_ZOOM_LAYOUT_CLASS),
      false,
    );
  }
});

test("zoom can be disabled while typography remains active", () => {
  const current = fixture({
    fontEnabled: true,
    zoomEnabled: false,
    storedZoom: "130",
    storedTerminalZoom: "120",
    withTerminal: true,
  });
  const result = vm.runInNewContext(current.payload, current.context);

  assert.equal(result.fontEnabled, true);
  assert.equal(result.zoomEnabled, false);
  assert.equal(result.contentZoomPercent, 130);
  assert.equal(current.thread.classList.contains("chatgpt-chat-typography-thread"), true);
  assert.equal(current.nodes.has("chatgpt-chat-typography-style"), true);
  assert.equal(current.threadContent.classList.contains(ZOOM_CLASS), false);
  assert.equal(current.nodes.has(ZOOM_STYLE_ID), false);
  assert.equal(current.listeners.has("keydown"), false);
  assert.equal(current.listeners.has("storage"), false);
  assert.equal(current.storage.get(ZOOM_STORAGE_KEY), "130");
  assert.equal(current.storage.get(TERMINAL_ZOOM_STORAGE_KEY), "120");
  assert.equal(current.terminalInstance.options.fontSize, 13);
  assert.equal(current.terminalInstance.options.fontFamily, TERMINAL_CUSTOM_FONT_FAMILY);
});

test("both features can be disabled without changing the renderer", () => {
  const current = fixture({ fontEnabled: false, zoomEnabled: false });
  const result = vm.runInNewContext(current.payload, current.context);

  assert.equal(result.installed, true);
  assert.equal(result.threadFound, true);
  assert.equal(result.fontEnabled, false);
  assert.equal(result.zoomEnabled, false);
  assert.equal(current.nodes.size, 0);
  assert.equal(current.thread.classList.values.size, 0);
  assert.equal(current.userMessage.classList.values.size, 0);
  assert.equal(current.assistantMessage.classList.values.size, 0);
  assert.equal(current.thread.style.values.size, 0);
  assert.equal(current.threadContent.classList.values.size, 0);
  assert.equal(current.listeners.size, 0);
});

test("reapply fully removes artifacts from features that become disabled", () => {
  const current = fixture({
    storedZoom: "120",
    storedTerminalZoom: "120",
    withTerminal: true,
  });
  vm.runInNewContext(current.payload, current.context);
  assert.equal(current.terminalInstance.options.fontSize, 15.6);
  current.focusTerminal();
  current.dispatch("keydown", keyboardEvent("Equal"));
  assert.equal(current.terminalInstance.options.fontSize, 16.9);
  assert.equal(current.nodes.has(ZOOM_TOAST_ID), true);

  const result = vm.runInNewContext(
    current.payloadFor({ fontEnabled: false, zoomEnabled: false }),
    current.context,
  );
  assert.equal(result.fontEnabled, false);
  assert.equal(result.zoomEnabled, false);
  assert.equal(current.nodes.size, 0);
  assert.equal(current.thread.classList.values.size, 0);
  assert.equal(current.userMessage.classList.values.size, 0);
  assert.equal(current.assistantMessage.classList.values.size, 0);
  assert.equal(current.thread.style.values.size, 0);
  assert.equal(current.threadContent.classList.contains(ZOOM_CLASS), false);
  assert.equal(
    current.threadContent.classList.contains(THREAD_ZOOM_LAYOUT_CLASS),
    false,
  );
  assert.equal(current.listeners.get("keydown").size, 0);
  assert.equal(current.listeners.get("storage").size, 0);
  assert.equal(current.timers.size, 0);
  assert.equal(current.storage.get(ZOOM_STORAGE_KEY), "120");
  assert.equal(current.storage.get(TERMINAL_ZOOM_STORAGE_KEY), "130");
  assert.equal(current.terminalInstance.options.fontSize, 13);
  assert.equal(current.terminalInstance.options.fontFamily, TERMINAL_NATIVE_FONT_FAMILY);
  assert.equal(current.terminalRoot.style.values.size, 0);
});
