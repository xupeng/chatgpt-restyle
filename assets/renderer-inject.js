((cssText, version) => {
  const STATE_KEY = "__CHATGPT_CHAT_TYPOGRAPHY_STATE__";
  const STYLE_ID = "chatgpt-chat-typography-style";
  const THREAD_CLASS = "chatgpt-chat-typography-thread";
  const PREVIEW_CLASS = "chatgpt-chat-typography-markdown-preview";
  const PLAN_CLASS = "chatgpt-chat-typography-plan";
  const NATIVE_UI_CLASS = "chatgpt-chat-typography-native-ui";
  const ZOOM_CLASS = "chatgpt-restyle-content-zoom";
  const ZOOM_STYLE_ID = "chatgpt-restyle-content-zoom-style";
  const ZOOM_TOAST_ID = "chatgpt-restyle-content-zoom-toast";
  const ZOOM_STORAGE_KEY = "chatgpt-restyle.contentZoomPercent.v1";
  const DEFAULT_ZOOM_PERCENT = 100;
  const MIN_ZOOM_PERCENT = 60;
  const MAX_ZOOM_PERCENT = 160;
  const ZOOM_STEP_PERCENT = 10;
  const THREAD_SELECTOR = "main.main-surface .thread-scroll-container";
  const THREAD_FOOTER_SELECTOR =
    ':scope > * > [data-thread-scroll-footer="true"]';
  const QUEUED_MESSAGES_SELECTOR =
    '.vertical-scroll-fade-mask.hide-scrollbar[class*="max-h-[30dvh]"]';
  const MARKDOWN_FILE_EDITOR_SELECTOR =
    'main.main-surface [role="tabpanel"][aria-label] .cm-editor';
  const MARKDOWN_FILE_EXTENSION = /\.(?:md|markdown)$/i;
  const PLAN_PANEL_SELECTOR = '[role="tabpanel"][aria-label="Plan"]';
  const PLAN_CONTENT_SELECTOR = '[class*="_markdownContent_"].text-size-chat';
  const CODE_SELECTOR =
    "pre code, code, kbd, samp, .inline-markdown, .cm-markdown-code-line";

  const previous = window[STATE_KEY];
  previous?.observer?.disconnect();
  if (previous?.timer) clearTimeout(previous.timer);
  previous?.disposeZoom?.();
  for (const className of [THREAD_CLASS, PREVIEW_CLASS, PLAN_CLASS]) {
    document.querySelectorAll(`.${className}`).forEach((root) => {
      root.style.removeProperty("--chat-native-code-font-family");
    });
  }

  let nativeFontFamily = previous?.nativeFontFamily || null;
  let currentThread = null;
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
    let style = document.getElementById(STYLE_ID);
    if (!style) {
      style = document.createElement("style");
      style.id = STYLE_ID;
      (document.head || document.documentElement).appendChild(style);
    }
    if (style.textContent !== cssText) style.textContent = cssText;
    style.dataset.chatgptRestyleVersion = version;
  };

  const updateZoomStyle = () => {
    let style = document.getElementById(ZOOM_STYLE_ID);
    if (!style) {
      style = document.createElement("style");
      style.id = ZOOM_STYLE_ID;
      (document.head || document.documentElement).appendChild(style);
    }
    style.dataset.chatgptRestyleVersion = version;
    style.textContent = `
.${ZOOM_CLASS} {
  zoom: ${String(contentZoomPercent / 100)} !important;
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
      return document.fonts?.check('16px "LXGW WenKai Screen"') ?? false;
    } catch {
      return false;
    }
  };

  const detach = (thread) => {
    if (!thread) return;
    thread.classList.remove(THREAD_CLASS);
    thread.style.removeProperty("--chat-native-font-family");
    thread.style.removeProperty("--chat-native-code-font-family");
  };

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
    const roots = new Set([
      findThreadContent(thread),
      ...previews,
      ...plans,
    ].filter(Boolean));
    for (const root of currentZoomRoots) {
      if (!roots.has(root)) root.classList.remove(ZOOM_CLASS);
    }
    roots.forEach((root) => root.classList.add(ZOOM_CLASS));
    currentZoomRoots = roots;
  };

  const captureNativeCodeFont = (root, className, fallbackSample = null) => {
    if (!root || root.style.getPropertyValue?.("--chat-native-code-font-family")) return;
    const wasStyled = root.classList.contains(className);
    if (wasStyled) root.classList.remove(className);
    let family = null;
    try {
      const sample = root.querySelector?.(CODE_SELECTOR) || fallbackSample;
      if (sample) family = getComputedStyle(sample).fontFamily;
    } finally {
      if (wasStyled) root.classList.add(className);
    }
    if (family) root.style.setProperty("--chat-native-code-font-family", family);
  };

  const sync = () => {
    ensureStyle();
    const thread = document.querySelector(THREAD_SELECTOR);
    if (currentThread && currentThread !== thread) detach(currentThread);
    currentThread = thread;
    if (thread && !nativeFontFamily) {
      nativeFontFamily = thread.style.getPropertyValue?.("--chat-native-font-family") || null;
    }
    if (thread && !nativeFontFamily) {
      const nativeSample = thread.querySelector?.(
        '[data-message-author-role], article, [class*="_markdown"]',
      ) || thread;
      nativeFontFamily = getComputedStyle(nativeSample).fontFamily;
    }
    if (thread) {
      thread.style.setProperty("--chat-native-font-family", nativeFontFamily || "system-ui, sans-serif");
      captureNativeCodeFont(thread, THREAD_CLASS);
      thread.classList.add(THREAD_CLASS);
    }

    const nativeUiRoots = new Set(findNativeUiRoots(thread));
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
      if (!preview.classList.contains(PREVIEW_CLASS)) {
        preview.style.setProperty(
          "--chat-native-font-family",
          getComputedStyle(preview).fontFamily || nativeFontFamily || "system-ui, sans-serif",
        );
        preview.classList.add(PREVIEW_CLASS);
      }
      captureNativeCodeFont(preview, PREVIEW_CLASS, preview);
    }
    currentPreviews = previews;

    const plans = new Set(findPlans());
    for (const plan of currentPlans) {
      if (!plans.has(plan)) detachPlan(plan);
    }
    for (const plan of plans) {
      if (!plan.classList.contains(PLAN_CLASS)) {
        plan.style.setProperty(
          "--chat-native-font-family",
          getComputedStyle(plan).fontFamily || nativeFontFamily || "system-ui, sans-serif",
        );
        plan.classList.add(PLAN_CLASS);
      }
      captureNativeCodeFont(plan, PLAN_CLASS);
    }
    currentPlans = plans;
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
    currentZoomRoots.forEach((root) => root.classList.remove(ZOOM_CLASS));
    document.querySelectorAll(`.${ZOOM_CLASS}`).forEach((root) => root.classList.remove(ZOOM_CLASS));
    currentZoomRoots = new Set();
    document.getElementById(ZOOM_TOAST_ID)?.remove();
    document.getElementById(ZOOM_STYLE_ID)?.remove();
  };

  const cleanup = () => {
    observer.disconnect();
    if (timer) clearTimeout(timer);
    disposeZoom();
    detach(currentThread);
    currentPreviews.forEach(detachPreview);
    currentPlans.forEach(detachPlan);
    currentNativeUiRoots.forEach(detachNativeUi);
    document.querySelectorAll(`.${THREAD_CLASS}`).forEach(detach);
    document.querySelectorAll(`.${PREVIEW_CLASS}`).forEach(detachPreview);
    document.querySelectorAll(`.${PLAN_CLASS}`).forEach(detachPlan);
    document.querySelectorAll(`.${NATIVE_UI_CLASS}`).forEach(detachNativeUi);
    document.getElementById(STYLE_ID)?.remove();
    if (window[STATE_KEY]?.cleanup === cleanup) delete window[STATE_KEY];
    return true;
  };

  updateZoomStyle();
  window.addEventListener("keydown", onZoomKeyDown, true);
  window.addEventListener("storage", onZoomStorage);
  window[STATE_KEY] = {
    cleanup,
    disposeZoom,
    sync,
    observer,
    get timer() { return timer; },
    nativeFontFamily,
    get contentZoomPercent() { return contentZoomPercent; },
    fontAvailable: fontAvailable(),
    version,
  };
  sync();
  window[STATE_KEY].nativeFontFamily = nativeFontFamily;
  observer.observe(document.documentElement, { childList: true, subtree: true });

  return {
    installed: true,
    threadFound: Boolean(currentThread),
    previewCount: currentPreviews.size,
    planCount: currentPlans.size,
    nativeUiCount: currentNativeUiRoots.size,
    contentZoomPercent,
    fontAvailable: window[STATE_KEY].fontAvailable,
    nativeFontFamily,
    version,
  };
})(__CHATGPT_RESTYLE_CSS_JSON__, __CHATGPT_RESTYLE_VERSION_JSON__)
