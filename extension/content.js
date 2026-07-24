(function () {
  const { compress, approxTokenCount, defaultRuleState } = window.ProcdorCompress;

  let ruleState = defaultRuleState();
  chrome.storage.sync.get("procdorRules", (data) => {
    if (data.procdorRules) ruleState = Object.assign(ruleState, data.procdorRules);
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "sync" && changes.procdorRules) {
      ruleState = Object.assign(defaultRuleState(), changes.procdorRules.newValue);
    }
  });

  // Claude's composer markup isn't publicly documented and changes over time, so this
  // tries the most specific/stable signal first and falls back to a size heuristic —
  // verify against the live DOM and adjust if claude.ai's markup has shifted.
  const COMPOSER_SELECTORS = [
    'div[contenteditable="true"][aria-label]',
    'div[contenteditable="true"][data-placeholder]',
    'div[contenteditable="true"]'
  ];

  function isVisibleAndSizable(el) {
    const rect = el.getBoundingClientRect();
    return rect.width > 150 && rect.height > 20 && el.offsetParent !== null;
  }

  function findComposer() {
    for (const sel of COMPOSER_SELECTORS) {
      const match = Array.from(document.querySelectorAll(sel)).find(isVisibleAndSizable);
      if (match) return match;
    }
    return null;
  }

  function getComposerText(el) {
    return el.innerText;
  }

  function setComposerText(el, text) {
    el.focus();
    const range = document.createRange();
    range.selectNodeContents(el);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);

    // execCommand is deprecated but still the most reliable way to push text into a
    // framework-controlled contenteditable (React/ProseMirror) so its internal state
    // and the send button's enabled/disabled logic actually pick up the change.
    const inserted = document.execCommand("insertText", false, text);
    if (!inserted) {
      el.textContent = text;
      el.dispatchEvent(new InputEvent("input", { bubbles: true, cancelable: true }));
    }
  }

  function buildButton() {
    const button = document.createElement("button");
    button.id = "procdor-condense-btn";
    button.type = "button";
    button.textContent = "⟪ Condense";
    button.title = "Condense this prompt (Procdor)";

    const badge = document.createElement("span");
    badge.id = "procdor-badge";
    button.appendChild(badge);

    button.addEventListener("click", () => {
      const composer = findComposer();
      if (!composer) return;

      const original = getComposerText(composer);
      if (!original.trim()) return;

      const { output } = compress(original, ruleState);
      if (!output || output === original) return;

      const before = approxTokenCount(original);
      const after = approxTokenCount(output);
      setComposerText(composer, output);
      badge.textContent = before > 0 ? `${before}→${after}` : "";
      badge.classList.add("procdor-badge-show");
      setTimeout(() => badge.classList.remove("procdor-badge-show"), 2500);
    });

    return button;
  }

  function ensureButton() {
    if (document.getElementById("procdor-condense-btn")) return;
    if (!findComposer()) return;
    document.body.appendChild(buildButton());
  }

  ensureButton();

  // claude.ai is a single-page app — the composer gets unmounted/remounted on
  // navigation, so keep checking rather than relying on one-time page load setup.
  const observer = new MutationObserver(() => ensureButton());
  observer.observe(document.body, { childList: true, subtree: true });
})();
