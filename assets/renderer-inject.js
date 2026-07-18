((cssText, version) => {
  const STATE_KEY = "__CHATGPT_CHAT_TYPOGRAPHY_STATE__";
  const STYLE_ID = "chatgpt-chat-typography-style";
  const THREAD_CLASS = "chatgpt-chat-typography-thread";
  const PREVIEW_CLASS = "chatgpt-chat-typography-markdown-preview";
  const PLAN_CLASS = "chatgpt-chat-typography-plan";
  const NATIVE_UI_CLASS = "chatgpt-chat-typography-native-ui";
  const THREAD_SELECTOR = "main.main-surface .thread-scroll-container";
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
  let timer = null;

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
  const cleanup = () => {
    observer.disconnect();
    if (timer) clearTimeout(timer);
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

  window[STATE_KEY] = {
    cleanup,
    sync,
    observer,
    timer,
    nativeFontFamily,
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
    fontAvailable: window[STATE_KEY].fontAvailable,
    nativeFontFamily,
    version,
  };
})(__CHATGPT_RESTYLE_CSS_JSON__, __CHATGPT_RESTYLE_VERSION_JSON__)
