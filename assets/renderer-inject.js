((cssText, version, fontEnabled, zoomEnabled) => {
  const STATE_KEY = "__CHATGPT_CHAT_TYPOGRAPHY_STATE__";
  const STYLE_ID = "chatgpt-chat-typography-style";
  const ROOT_CLASS = "chatgpt-restyle-font-root";
  const THREAD_CLASS = "chatgpt-chat-typography-thread";
  const MESSAGE_CLASS = "chatgpt-chat-typography-message";
  const PREVIEW_CLASS = "chatgpt-chat-typography-markdown-preview";
  const PLAN_CLASS = "chatgpt-chat-typography-plan";
  const NATIVE_UI_CLASS = "chatgpt-chat-typography-native-ui";
  const ZOOM_CLASS = "chatgpt-restyle-content-zoom";
  const THREAD_ZOOM_LAYOUT_CLASS = "chatgpt-restyle-content-zoom-thread-layout";
  const ZOOM_STYLE_ID = "chatgpt-restyle-content-zoom-style";
  const ZOOM_TOAST_ID = "chatgpt-restyle-content-zoom-toast";
  const ZOOM_STORAGE_KEY = "chatgpt-restyle.contentZoomPercent.v1";
  const TERMINAL_ZOOM_STORAGE_KEY = "chatgpt-restyle.terminalZoomPercent.v1";
  const DEFAULT_ZOOM_PERCENT = 100;
  const MIN_ZOOM_PERCENT = 60;
  const MAX_ZOOM_PERCENT = 160;
  const ZOOM_STEP_PERCENT = 10;
  const MAIN_SURFACE_SELECTOR = 'main[data-app-shell-main-surface="default"]';
  const THREAD_SELECTOR = `${MAIN_SURFACE_SELECTOR} .thread-scroll-container`;
  const MESSAGE_SELECTOR = [
    '[data-markdown-text-tone="user-message"]',
    '[data-markdown-text-style="assistant-message"]',
  ].join(", ");
  const THREAD_FOOTER_SELECTOR =
    ':scope > * > [data-thread-scroll-footer="true"]';
  const QUEUED_MESSAGES_SELECTOR =
    '.vertical-scroll-fade-mask.hide-scrollbar[class*="max-h-[30dvh]"]';
  const MARKDOWN_FILE_EDITOR_SELECTOR =
    '[role="tabpanel"][aria-label] .cm-editor';
  const MARKDOWN_FILE_EXTENSION = /\.(?:md|markdown)$/i;
  const PLAN_PANEL_SELECTOR = '[role="tabpanel"][aria-label="Plan"]';
  const PLAN_CONTENT_SELECTOR =
    '[class*="_markdownContent_"].text-size-chat';
  const CODE_SELECTOR =
    "pre code, code, kbd, samp, .inline-markdown, .cm-markdown-code-line";
  const TERMINAL_SELECTOR = "[data-codex-xterm]";
  const TERMINAL_NATIVE_CODE_FONT_PROPERTY = "--chat-native-code-font-family";
  const TERMINAL_FIBER_DEPTH_LIMIT = 16;
  const TERMINAL_HOOK_LIMIT = 64;

  const previous = window[STATE_KEY];
  const previousNativeFontFamily = previous?.nativeFontFamily || null;
  if (previous?.cleanup) previous.cleanup();
  else {
    previous?.observer?.disconnect();
    if (previous?.timer) clearTimeout(previous.timer);
    previous?.disposeZoom?.();
  }

  let nativeFontFamily = fontEnabled ? previousNativeFontFamily : null;
  let currentThread = null;
  let currentMessages = new Set();
  let currentPreviews = new Set();
  let currentPlans = new Set();
  let currentNativeUiRoots = new Set();
  let currentTerminals = new Map();
  let currentZoomRoots = new Set();
  let timer = null;
  let zoomToastTimer = null;

  const parseZoomPercent = (value) => {
    if (typeof value !== "string" || !/^\d+$/.test(value)) return DEFAULT_ZOOM_PERCENT;
    const parsed = Number(value);
    return Number.isInteger(parsed)
      && parsed >= MIN_ZOOM_PERCENT
      && parsed <= MAX_ZOOM_PERCENT
      ? parsed
      : DEFAULT_ZOOM_PERCENT;
  };

  const readZoomPercent = (storageKey) => {
    try {
      return parseZoomPercent(window.localStorage.getItem(storageKey));
    } catch {
      return DEFAULT_ZOOM_PERCENT;
    }
  };

  let contentZoomPercent = readZoomPercent(ZOOM_STORAGE_KEY);
  let terminalZoomPercent = readZoomPercent(TERMINAL_ZOOM_STORAGE_KEY);

  const ensureStyle = () => {
    if (!fontEnabled) {
      document.documentElement.classList.remove(ROOT_CLASS);
      document.getElementById(STYLE_ID)?.remove();
      return;
    }
    let style = document.getElementById(STYLE_ID);
    if (!style) {
      style = document.createElement("style");
      style.id = STYLE_ID;
      (document.head || document.documentElement).appendChild(style);
    }
    if (style.textContent !== cssText) style.textContent = cssText;
    style.dataset.chatgptRestyleVersion = version;
    document.documentElement.classList.add(ROOT_CLASS);
  };

  const updateZoomStyle = () => {
    const zoomFactor = contentZoomPercent / 100;
    const inverseZoomPercent = 10000 / contentZoomPercent;
    let style = document.getElementById(ZOOM_STYLE_ID);
    if (!style) {
      style = document.createElement("style");
      style.id = ZOOM_STYLE_ID;
      (document.head || document.documentElement).appendChild(style);
    }
    style.dataset.chatgptRestyleVersion = version;
    style.textContent = `
.${ZOOM_CLASS} {
  inline-size: ${String(inverseZoomPercent)}% !important;
  zoom: ${String(zoomFactor)} !important;
}

.${ZOOM_CLASS}.${THREAD_ZOOM_LAYOUT_CLASS} {
  max-inline-size: calc(var(--thread-content-max-width) / ${String(zoomFactor)}) !important;
}

#${ZOOM_TOAST_ID} {
  position: fixed;
  left: 50%;
  bottom: 32px;
  z-index: 2147483647;
  transform: translateX(-50%);
  padding: 8px 12px;
  border-radius: 8px;
  color: white;
  background: rgba(30, 30, 30, 0.88);
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.22);
  font: 500 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  pointer-events: none;
}
`;
  };

  const showZoomToast = (label, percent) => {
    let toast = document.getElementById(ZOOM_TOAST_ID);
    if (!toast) {
      toast = document.createElement("div");
      toast.id = ZOOM_TOAST_ID;
      toast.setAttribute("role", "status");
      toast.setAttribute("aria-live", "polite");
      (document.body || document.documentElement).appendChild(toast);
    }
    toast.textContent = `${label} ${percent}%`;
    if (zoomToastTimer !== null) clearTimeout(zoomToastTimer);
    zoomToastTimer = setTimeout(() => {
      document.getElementById(ZOOM_TOAST_ID)?.remove();
      zoomToastTimer = null;
    }, 900);
  };

  const clampZoomPercent = (percent) => Math.min(
    MAX_ZOOM_PERCENT,
    Math.max(MIN_ZOOM_PERCENT, percent),
  );

  const applyZoomPercent = (nextPercent, { announce = false, persist = false } = {}) => {
    contentZoomPercent = clampZoomPercent(nextPercent);
    updateZoomStyle();
    if (persist) {
      try {
        window.localStorage.setItem(ZOOM_STORAGE_KEY, String(contentZoomPercent));
      } catch {}
    }
    if (announce) showZoomToast("正文缩放", contentZoomPercent);
  };

  const applyTerminalZoomPercent = (
    nextPercent,
    { announce = false, persist = false } = {},
  ) => {
    terminalZoomPercent = clampZoomPercent(nextPercent);
    currentTerminals.forEach(applyTerminalOptions);
    if (persist) {
      try {
        window.localStorage.setItem(
          TERMINAL_ZOOM_STORAGE_KEY,
          String(terminalZoomPercent),
        );
      } catch {}
    }
    if (announce) showZoomToast("Terminal 缩放", terminalZoomPercent);
  };

  const shortcutAction = (event) => {
    if (
      event.isComposing
      || !event.ctrlKey
      || !event.shiftKey
      || event.altKey
      || event.metaKey
    ) return null;
    if (["Equal", "NumpadAdd"].includes(event.code)) return "increase";
    if (["Minus", "NumpadSubtract"].includes(event.code)) return "decrease";
    if (["Digit0", "Numpad0"].includes(event.code)) return "reset";
    return null;
  };

  const onZoomKeyDown = (event) => {
    const action = shortcutAction(event);
    if (!action) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const terminalFocused = Boolean(
      document.activeElement?.closest?.(TERMINAL_SELECTOR),
    );
    if (terminalFocused) {
      syncTerminals();
      const nextPercent = action === "reset"
        ? DEFAULT_ZOOM_PERCENT
        : terminalZoomPercent
          + (action === "increase" ? ZOOM_STEP_PERCENT : -ZOOM_STEP_PERCENT);
      applyTerminalZoomPercent(nextPercent, { announce: true, persist: true });
      return;
    }
    const nextPercent = action === "reset"
      ? DEFAULT_ZOOM_PERCENT
      : contentZoomPercent + (action === "increase" ? ZOOM_STEP_PERCENT : -ZOOM_STEP_PERCENT);
    applyZoomPercent(nextPercent, { announce: true, persist: true });
  };

  const onZoomStorage = (event) => {
    if (event.key === ZOOM_STORAGE_KEY || event.key === null) {
      applyZoomPercent(parseZoomPercent(event.newValue));
    }
    if (event.key === TERMINAL_ZOOM_STORAGE_KEY || event.key === null) {
      applyTerminalZoomPercent(parseZoomPercent(event.newValue));
    }
  };

  const fontAvailable = () => {
    try {
      return (document.fonts?.check('16px "Oxanium"')
        && document.fonts.check('16px "LXGW WenKai Screen"')) ?? false;
    } catch {
      return false;
    }
  };

  const refreshFontAvailability = () => {
    const state = window[STATE_KEY];
    if (!fontEnabled || !state || typeof document.fonts?.load !== "function") return;
    Promise.all([
      document.fonts.load('16px "Oxanium"'),
      document.fonts.load('16px "LXGW WenKai Screen"'),
    ]).then(() => {
      if (window[STATE_KEY] === state) state.fontAvailable = fontAvailable();
    }).catch(() => {
      if (window[STATE_KEY] === state) state.fontAvailable = false;
    });
  };

  const detach = (thread) => {
    if (!thread) return;
    thread.classList.remove(THREAD_CLASS);
    thread.style.removeProperty("--chat-native-font-family");
    thread.style.removeProperty("--chat-native-code-font-family");
  };

  const detachMessage = (message) => message?.classList.remove(MESSAGE_CLASS);

  const detachPreview = (preview) => {
    if (!preview) return;
    preview.classList.remove(PREVIEW_CLASS);
    preview.style.removeProperty("--chat-native-font-family");
    preview.style.removeProperty("--chat-native-code-font-family");
  };

  const detachPlan = (plan) => {
    if (!plan) return;
    plan.classList.remove(PLAN_CLASS);
    plan.style.removeProperty("--chat-native-font-family");
    plan.style.removeProperty("--chat-native-code-font-family");
  };

  const findPreviews = (thread) => {
    return Array.from(
      document.querySelectorAll(MARKDOWN_FILE_EDITOR_SELECTOR),
    ).filter((editor) => {
      if (thread?.contains?.(editor)) return false;
      const panel = editor.closest?.('[role="tabpanel"][aria-label]');
      return MARKDOWN_FILE_EXTENSION.test(panel?.getAttribute?.("aria-label") || "");
    });
  };

  const findMessages = (thread) => thread?.querySelectorAll
    ? Array.from(thread.querySelectorAll(MESSAGE_SELECTOR))
    : [];

  const detachNativeUi = (root) => root?.classList.remove(NATIVE_UI_CLASS);

  const findPlans = () => Array.from(document.querySelectorAll(PLAN_PANEL_SELECTOR))
    .map((panel) => panel.querySelector?.(PLAN_CONTENT_SELECTOR))
    .filter(Boolean);

  const findNativeUiRoots = (thread) => thread?.querySelectorAll
    ? Array.from(thread.querySelectorAll(QUEUED_MESSAGES_SELECTOR))
    : [];

  const findThreadContent = (thread) => {
    const footer = thread?.querySelector?.(THREAD_FOOTER_SELECTOR);
    if (!footer || footer.parentElement?.parentElement !== thread) return null;
    return footer.previousElementSibling || null;
  };

  const syncZoomRoots = (thread, previews, plans) => {
    const threadContent = zoomEnabled ? findThreadContent(thread) : null;
    const roots = new Set(zoomEnabled ? [
      threadContent,
      ...previews,
      ...plans,
    ].filter(Boolean) : []);
    for (const root of currentZoomRoots) {
      if (!roots.has(root)) {
        root.classList.remove(ZOOM_CLASS);
        root.classList.remove(THREAD_ZOOM_LAYOUT_CLASS);
      }
    }
    roots.forEach((root) => {
      root.classList.add(ZOOM_CLASS);
      root.classList.remove(THREAD_ZOOM_LAYOUT_CLASS);
    });
    threadContent?.classList.add(THREAD_ZOOM_LAYOUT_CLASS);
    currentZoomRoots = roots;
  };

  const sampleNativeFontFamily = (root, fallback = "system-ui, sans-serif") => {
    if (!root) return fallback || "system-ui, sans-serif";
    const hadRoot = document.documentElement.classList.contains(ROOT_CLASS);
    if (hadRoot) document.documentElement.classList.remove(ROOT_CLASS);
    let family = null;
    try {
      family = getComputedStyle(root).fontFamily;
    } finally {
      if (hadRoot) document.documentElement.classList.add(ROOT_CLASS);
    }
    return family || fallback || "system-ui, sans-serif";
  };

  const captureNativeCodeFont = (root, className, fallbackSample = null) => {
    if (!root || root.style.getPropertyValue?.("--chat-native-code-font-family")) return;
    const wasStyled = root.classList.contains(className);
    const hadRoot = document.documentElement.classList.contains(ROOT_CLASS);
    if (wasStyled) root.classList.remove(className);
    if (hadRoot) document.documentElement.classList.remove(ROOT_CLASS);
    let family = null;
    try {
      const sample = root.querySelector?.(CODE_SELECTOR) || fallbackSample;
      if (sample) family = getComputedStyle(sample).fontFamily;
    } finally {
      if (hadRoot) document.documentElement.classList.add(ROOT_CLASS);
      if (wasStyled) root.classList.add(className);
    }
    if (family) root.style.setProperty("--chat-native-code-font-family", family);
  };

  // xterm and its FitAddon live in hook refs; identify a bounded matching pair.
  const findTerminalRuntime = (root) => {
    const fiberKey = Object.getOwnPropertyNames(root || {})
      .find((key) => key.startsWith("__reactFiber$"));
    let fiber = fiberKey ? root[fiberKey] : null;
    const hookRefs = [];
    let visitedHooks = 0;
    for (
      let depth = 0;
      fiber && depth < TERMINAL_FIBER_DEPTH_LIMIT && visitedHooks < TERMINAL_HOOK_LIMIT;
      depth += 1, fiber = fiber.return
    ) {
      let hook = fiber.memoizedState;
      const seen = new Set();
      while (
        hook
        && typeof hook === "object"
        && visitedHooks < TERMINAL_HOOK_LIMIT
        && !seen.has(hook)
      ) {
        seen.add(hook);
        visitedHooks += 1;
        const candidate = hook.memoizedState?.current;
        if (candidate && typeof candidate === "object") hookRefs.push(candidate);
        hook = hook.next;
      }
    }
    const instances = hookRefs.filter((candidate) => (
      candidate?.options
      && typeof candidate.open === "function"
      && typeof candidate.write === "function"
    ));
    for (const instance of instances) {
      const fitAddon = hookRefs.find((candidate) => (
        candidate?._terminal === instance
        && typeof candidate.fit === "function"
        && typeof candidate.dispose === "function"
      ));
      if (fitAddon) return { instance, fitAddon };
    }
    return null;
  };

  const validTerminalFontSize = (value) => (
    typeof value === "number" && Number.isFinite(value) && value > 0
  );

  const readTerminalFontFamily = (instance) => {
    try {
      const value = instance.options.fontFamily;
      return typeof value === "string" ? value : null;
    } catch {
      return null;
    }
  };

  const readTerminalFontSize = (instance) => {
    try {
      const value = instance.options.fontSize;
      return validTerminalFontSize(value) ? value : null;
    } catch {
      return null;
    }
  };

  const setTerminalFontSize = (record, fontSize) => {
    record.instance.options.fontSize = fontSize;
    try {
      record.fitAddon.fit();
    } catch {}
  };

  const restoreTerminalZoom = (record) => {
    if (!record || record.appliedFontSize === null) return;
    try {
      const currentFontSize = record.instance.options.fontSize;
      if (
        currentFontSize === record.appliedFontSize
        && currentFontSize !== record.nativeFontSize
      ) {
        setTerminalFontSize(record, record.nativeFontSize);
      }
    } catch {}
    record.appliedFontSize = null;
  };

  const detachTerminal = (record) => {
    if (!record) return;
    try {
      if (
        record.appliedFontFamily !== null
        && record.instance.options.fontFamily === record.appliedFontFamily
      ) {
        record.instance.options.fontFamily = record.nativeFontFamily;
      }
    } catch {}
    record.appliedFontFamily = null;
    // Restore size last so its fit measures the final native font metrics.
    restoreTerminalZoom(record);
    try {
      if (
        record.appliedNativeCodeFontFamily !== null
        && record.root.style.getPropertyValue(TERMINAL_NATIVE_CODE_FONT_PROPERTY)
          === record.appliedNativeCodeFontFamily
      ) {
        if (record.originalNativeCodeFontFamily) {
          record.root.style.setProperty(
            TERMINAL_NATIVE_CODE_FONT_PROPERTY,
            record.originalNativeCodeFontFamily,
            record.originalNativeCodeFontPriority,
          );
        } else {
          record.root.style.removeProperty(TERMINAL_NATIVE_CODE_FONT_PROPERTY);
        }
      }
    } catch {}
    record.appliedNativeCodeFontFamily = null;
  };

  const applyTerminalFont = (record) => {
    if (!fontEnabled) return;
    try {
      const currentFontFamily = readTerminalFontFamily(record.instance);
      if (currentFontFamily === null) return;
      if (
        record.appliedFontFamily === null
        || currentFontFamily !== record.appliedFontFamily
      ) {
        record.nativeFontFamily = currentFontFamily;
      }
      record.root.style.setProperty(
        TERMINAL_NATIVE_CODE_FONT_PROPERTY,
        record.nativeFontFamily,
      );
      record.appliedNativeCodeFontFamily = record.root.style.getPropertyValue(
        TERMINAL_NATIVE_CODE_FONT_PROPERTY,
      );
      record.customFontFamily = getComputedStyle(record.root)
        .getPropertyValue?.("--chat-code-font-family")?.trim() || null;
      if (!record.customFontFamily) return;
      if (currentFontFamily !== record.customFontFamily) {
        record.instance.options.fontFamily = record.customFontFamily;
      }
      record.appliedFontFamily = record.instance.options.fontFamily;
    } catch {}
  };

  const applyTerminalZoom = (record) => {
    if (!zoomEnabled) return;
    try {
      const currentFontSize = readTerminalFontSize(record.instance);
      if (currentFontSize === null) return;
      if (
        record.appliedFontSize === null
        || currentFontSize !== record.appliedFontSize
      ) {
        record.nativeFontSize = currentFontSize;
      }
      const nextFontSize = record.nativeFontSize * terminalZoomPercent / 100;
      if (currentFontSize !== nextFontSize) {
        setTerminalFontSize(record, nextFontSize);
      }
      record.appliedFontSize = record.instance.options.fontSize;
    } catch {}
  };

  const applyTerminalOptions = (record) => {
    if (!record) return;
    applyTerminalFont(record);
    applyTerminalZoom(record);
  };

  const syncTerminals = () => {
    const roots = new Set(fontEnabled || zoomEnabled
      ? Array.from(document.querySelectorAll(TERMINAL_SELECTOR))
      : []);
    for (const [root, record] of currentTerminals) {
      if (!roots.has(root)) detachTerminal(record);
    }
    const nextTerminals = new Map();
    for (const root of roots) {
      const runtime = findTerminalRuntime(root);
      const previous = currentTerminals.get(root);
      if (!runtime) {
        if (previous) nextTerminals.set(root, previous);
        continue;
      }
      const { instance, fitAddon } = runtime;
      if (previous && previous.instance !== instance) detachTerminal(previous);
      let record;
      if (previous?.instance === instance) {
        record = previous;
        record.fitAddon = fitAddon;
      } else {
        record = {
          root,
          instance,
          fitAddon,
          nativeFontFamily: readTerminalFontFamily(instance),
          nativeFontSize: readTerminalFontSize(instance),
          customFontFamily: null,
          originalNativeCodeFontFamily: root.style.getPropertyValue(
            TERMINAL_NATIVE_CODE_FONT_PROPERTY,
          ),
          originalNativeCodeFontPriority: root.style.getPropertyPriority?.(
            TERMINAL_NATIVE_CODE_FONT_PROPERTY,
          ) || "",
          appliedNativeCodeFontFamily: null,
          appliedFontFamily: null,
          appliedFontSize: null,
        };
      }
      applyTerminalOptions(record);
      nextTerminals.set(root, record);
    }
    currentTerminals = nextTerminals;
  };

  const sync = () => {
    const thread = document.querySelector(THREAD_SELECTOR);
    if (currentThread && currentThread !== thread) detach(currentThread);
    currentThread = thread;
    if (fontEnabled && thread && !nativeFontFamily) {
      nativeFontFamily = thread.style.getPropertyValue?.("--chat-native-font-family") || null;
    }
    if (fontEnabled && thread && !nativeFontFamily) {
      const nativeSample = thread.querySelector?.(MESSAGE_SELECTOR) || thread;
      nativeFontFamily = sampleNativeFontFamily(nativeSample);
    }

    const messages = new Set(fontEnabled ? findMessages(thread) : []);
    for (const message of currentMessages) {
      if (!messages.has(message)) detachMessage(message);
    }
    messages.forEach((message) => message.classList.add(MESSAGE_CLASS));
    currentMessages = messages;

    const nativeUiRoots = new Set(fontEnabled ? findNativeUiRoots(thread) : []);
    for (const root of currentNativeUiRoots) {
      if (!nativeUiRoots.has(root)) detachNativeUi(root);
    }
    nativeUiRoots.forEach((root) => root.classList.add(NATIVE_UI_CLASS));
    currentNativeUiRoots = nativeUiRoots;

    const previews = new Set(findPreviews(thread));
    for (const preview of currentPreviews) {
      if (!previews.has(preview)) detachPreview(preview);
    }
    for (const preview of previews) {
      if (!fontEnabled) {
        detachPreview(preview);
      }
      else if (!preview.classList.contains(PREVIEW_CLASS)) {
        preview.style.setProperty(
          "--chat-native-font-family",
          sampleNativeFontFamily(preview, nativeFontFamily),
        );
        preview.classList.add(PREVIEW_CLASS);
      }
      if (fontEnabled) captureNativeCodeFont(preview, PREVIEW_CLASS, preview);
    }
    currentPreviews = previews;

    const plans = new Set(findPlans());
    for (const plan of currentPlans) {
      if (!plans.has(plan)) detachPlan(plan);
    }
    for (const plan of plans) {
      if (!fontEnabled) {
        detachPlan(plan);
      }
      else if (!plan.classList.contains(PLAN_CLASS)) {
        plan.style.setProperty(
          "--chat-native-font-family",
          sampleNativeFontFamily(plan, nativeFontFamily),
        );
        plan.classList.add(PLAN_CLASS);
      }
      if (fontEnabled) captureNativeCodeFont(plan, PLAN_CLASS);
    }
    currentPlans = plans;
    if (fontEnabled && thread) {
      thread.style.setProperty("--chat-native-font-family", nativeFontFamily || "system-ui, sans-serif");
      captureNativeCodeFont(thread, THREAD_CLASS);
      thread.classList.add(THREAD_CLASS);
    }
    else detach(thread);
    ensureStyle();
    syncTerminals();
    syncZoomRoots(thread, previews, plans);
    if (window[STATE_KEY]) window[STATE_KEY].nativeFontFamily = nativeFontFamily;
    return Boolean(thread || previews.size || plans.size);
  };

  const schedule = () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      sync();
    }, 32);
  };

  const observer = new MutationObserver(schedule);
  const disposeZoom = () => {
    window.removeEventListener("keydown", onZoomKeyDown, true);
    window.removeEventListener("storage", onZoomStorage);
    if (zoomToastTimer !== null) clearTimeout(zoomToastTimer);
    zoomToastTimer = null;
    currentZoomRoots.forEach((root) => {
      root.classList.remove(ZOOM_CLASS);
      root.classList.remove(THREAD_ZOOM_LAYOUT_CLASS);
    });
    document.querySelectorAll(`.${ZOOM_CLASS}`).forEach((root) => root.classList.remove(ZOOM_CLASS));
    document.querySelectorAll(`.${THREAD_ZOOM_LAYOUT_CLASS}`)
      .forEach((root) => root.classList.remove(THREAD_ZOOM_LAYOUT_CLASS));
    currentZoomRoots = new Set();
    currentTerminals.forEach(restoreTerminalZoom);
    document.getElementById(ZOOM_TOAST_ID)?.remove();
    document.getElementById(ZOOM_STYLE_ID)?.remove();
  };

  const cleanup = () => {
    observer.disconnect();
    if (timer) clearTimeout(timer);
    currentTerminals.forEach(detachTerminal);
    currentTerminals = new Map();
    disposeZoom();
    detach(currentThread);
    currentMessages.forEach(detachMessage);
    currentPreviews.forEach(detachPreview);
    currentPlans.forEach(detachPlan);
    currentNativeUiRoots.forEach(detachNativeUi);
    document.querySelectorAll(`.${THREAD_CLASS}`).forEach(detach);
    document.querySelectorAll(`.${MESSAGE_CLASS}`).forEach(detachMessage);
    document.querySelectorAll(`.${PREVIEW_CLASS}`).forEach(detachPreview);
    document.querySelectorAll(`.${PLAN_CLASS}`).forEach(detachPlan);
    document.querySelectorAll(`.${NATIVE_UI_CLASS}`).forEach(detachNativeUi);
    document.getElementById(STYLE_ID)?.remove();
    document.documentElement.classList.remove(ROOT_CLASS);
    if (window[STATE_KEY]?.cleanup === cleanup) delete window[STATE_KEY];
    return true;
  };

  if (zoomEnabled) {
    updateZoomStyle();
    window.addEventListener("keydown", onZoomKeyDown, true);
    window.addEventListener("storage", onZoomStorage);
  }
  window[STATE_KEY] = {
    cleanup,
    disposeZoom,
    sync,
    observer,
    get timer() { return timer; },
    nativeFontFamily,
    get contentZoomPercent() { return contentZoomPercent; },
    get terminalZoomPercent() { return terminalZoomPercent; },
    fontEnabled,
    zoomEnabled,
    fontAvailable: fontEnabled ? fontAvailable() : null,
    version,
  };
  sync();
  window[STATE_KEY].nativeFontFamily = nativeFontFamily;
  refreshFontAvailability();
  observer.observe(document.documentElement, { childList: true, subtree: true });

  return {
    installed: true,
    threadFound: Boolean(currentThread),
    previewCount: currentPreviews.size,
    planCount: currentPlans.size,
    nativeUiCount: currentNativeUiRoots.size,
    contentZoomPercent,
    terminalZoomPercent,
    fontEnabled,
    zoomEnabled,
    fontAvailable: window[STATE_KEY].fontAvailable,
    nativeFontFamily,
    version,
  };
})(
  __CHATGPT_RESTYLE_CSS_JSON__,
  __CHATGPT_RESTYLE_VERSION_JSON__,
  __CHATGPT_RESTYLE_FONT_ENABLED_JSON__,
  __CHATGPT_RESTYLE_ZOOM_ENABLED_JSON__,
)
