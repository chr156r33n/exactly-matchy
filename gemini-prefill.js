(() => {
  const MAX_PROMPT_CHARS = 8_000;
  const COMPOSER_SELECTORS = [
    "rich-textarea textarea",
    'rich-textarea [contenteditable="true"]',
    'textarea[aria-label*="prompt" i]',
    'textarea[placeholder*="Gemini" i]',
    '[contenteditable="true"][role="textbox"]',
    '.ql-editor[contenteditable="true"]',
  ];

  function promptFromUrl(value) {
    try {
      const url = new URL(value);
      const prompt = (url.searchParams.get("q") || url.searchParams.get("prompt") || "")
        .trim()
        .slice(0, MAX_PROMPT_CHARS);
      return prompt || null;
    } catch {
      return null;
    }
  }

  function findComposer(root = document) {
    for (const selector of COMPOSER_SELECTORS) {
      for (const element of root.querySelectorAll(selector)) {
        const style = getComputedStyle(element);
        if (
          !element.disabled &&
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          element.getClientRects().length
        ) {
          return element;
        }
      }
    }
    return null;
  }

  function insertPrompt(element, prompt) {
    element.focus();
    if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) {
      const prototype =
        element instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
      if (setter) setter.call(element, prompt);
      else element.value = prompt;
    } else {
      const selection = getSelection();
      const range = document.createRange();
      range.selectNodeContents(element);
      selection?.removeAllRanges();
      selection?.addRange(range);
      const inserted = document.execCommand("insertText", false, prompt);
      if (!inserted) element.textContent = prompt;
      selection?.removeAllRanges();
    }
    element.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        composed: true,
        inputType: "insertText",
        data: prompt,
      }),
    );
    element.dispatchEvent(new Event("change", { bubbles: true }));
    element.focus();
    return true;
  }

  function clearPromptParameter() {
    const url = new URL(location.href);
    url.searchParams.delete("q");
    url.searchParams.delete("prompt");
    history.replaceState(history.state, "", `${url.pathname}${url.search}${url.hash}`);
  }

  function prefill() {
    const prompt = promptFromUrl(location.href);
    if (!prompt) return;

    const started = Date.now();
    let observer;
    let timer;
    const stop = () => {
      observer?.disconnect();
      clearInterval(timer);
    };
    const attempt = () => {
      const composer = findComposer();
      if (composer) {
        insertPrompt(composer, prompt);
        clearPromptParameter();
        stop();
        return;
      }
      if (Date.now() - started >= 20_000) stop();
    };

    observer = new MutationObserver(attempt);
    observer.observe(document.documentElement, { childList: true, subtree: true });
    timer = setInterval(attempt, 300);
    attempt();
  }

  globalThis.GeminiPromptPrefill = {
    promptFromUrl,
    findComposer,
    insertPrompt,
  };

  if (typeof document !== "undefined" && /(^|\.)gemini\.google\.com$/i.test(location.hostname)) {
    prefill();
  }
})();
