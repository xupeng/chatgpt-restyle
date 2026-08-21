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
  const DEFAULT_ZOOM_PERCENT = 100;
  const MIN_ZOOM_PERCENT = 60;
  const MAX_ZOOM_PERCENT = 160;
  const ZOOM_STEP_PERCENT = 10;
  const MAIN_SURFACE_SELECTOR = "main.main-surface";
  const THREAD_SELECTOR = `${MAIN_SURFACE_SELECTOR} .thread-scroll-container`;
  const MESSAGE_SELECTOR = [
    '[data-user-message-bubble="true"] [class*="_markdownContent_"]',
    '[data-content-search-unit-key$=":assistant"] [class*="_markdownContent_"]',
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

  const readZoomPercent = () => {
    try {
      return parseZoomPercent(window.localStorage.getItem(ZOOM_STORAGE_KEY));
    } catch {
      return DEFAULT_ZOOM_PERCENT;
    }
  };

  let contentZoomPercent = readZoomPercent();

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

  const showZoomToast = () => {
    let toast = document.getElementById(ZOOM_TOAST_ID);
    if (!toast) {
      toast = document.createElement("div");
      toast.id = ZOOM_TOAST_ID;
      toast.setAttribute("role", "status");
      toast.setAttribute("aria-live", "polite");
      (document.body || document.documentElement).appendChild(toast);
    }
    toast.textContent = `正文缩放 ${contentZoomPercent}%`;
    if (zoomToastTimer !== null) clearTimeout(zoomToastTimer);
    zoomToastTimer = setTimeout(() => {
      document.getElementById(ZOOM_TOAST_ID)?.remove();
      zoomToastTimer = null;
    }, 900);
  };

  const applyZoomPercent = (nextPercent, { announce = false, persist = false } = {}) => {
    contentZoomPercent = Math.min(
      MAX_ZOOM_PERCENT,
      Math.max(MIN_ZOOM_PERCENT, nextPercent),
    );
    updateZoomStyle();
    if (persist) {
      try {
        window.localStorage.setItem(ZOOM_STORAGE_KEY, String(contentZoomPercent));
      } catch {}
    }
    if (announce) showZoomToast();
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
    const nextPercent = action === "reset"
      ? DEFAULT_ZOOM_PERCENT
      : contentZoomPercent + (action === "increase" ? ZOOM_STEP_PERCENT : -ZOOM_STEP_PERCENT);
    applyZoomPercent(nextPercent, { announce: true, persist: true });
  };

  const onZoomStorage = (event) => {
    if (event.key !== ZOOM_STORAGE_KEY && event.key !== null) return;
    applyZoomPercent(parseZoomPercent(event.newValue));
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
    document.getElementById(ZOOM_TOAST_ID)?.remove();
    document.getElementById(ZOOM_STYLE_ID)?.remove();
  };

  const cleanup = () => {
    observer.disconnect();
    if (timer) clearTimeout(timer);
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
