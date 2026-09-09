(function () {
  const { compress, approxTokenCount, defaultRuleState } = window.ProcdorCompress;

  let ruleState = defaultRuleState();
  let interceptLargePastes = true;

  chrome.storage.sync.get(["procdorRules", "procdorPasteIntercept"], (data) => {
    if (data.procdorRules) ruleState = Object.assign(ruleState, data.procdorRules);
    if (typeof data.procdorPasteIntercept === "boolean") {
      interceptLargePastes = data.procdorPasteIntercept;
    }
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync") return;
    if (changes.procdorRules) {
      ruleState = Object.assign(defaultRuleState(), changes.procdorRules.newValue);
    }
    if (changes.procdorPasteIntercept &&
        typeof changes.procdorPasteIntercept.newValue === "boolean") {
      interceptLargePastes = changes.procdorPasteIntercept.newValue;
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

  // The pill claude.ai shows when it has diverted a big paste into a file
  // attachment instead of composer text.
  const ATTACHMENT_SELECTOR = '[data-testid="file-thumbnail"]';

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

  // Badge feedback — shared by the button and the paste handler.
  let badgeEl = null;
  let hideTimer;
  function flash(msg) {
    if (!badgeEl) return;
    badgeEl.textContent = msg;
    badgeEl.classList.add("procdor-badge-show");
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => badgeEl.classList.remove("procdor-badge-show"), 3000);
  }

  function buildButton() {
    const button = document.createElement("button");
    button.id = "procdor-condense-btn";
    button.type = "button";
    button.textContent = "⟪ Condense";
    button.title = "Condense this prompt (Procdor)";

    badgeEl = document.createElement("span");
    badgeEl.id = "procdor-badge";
    button.appendChild(badgeEl);

    // every click gives visible feedback — a silent no-op is indistinguishable
    // from a broken button
    button.addEventListener("click", () => {
      const composer = findComposer();
      if (!composer) {
        flash("no input box found");
        return;
      }

      const original = getComposerText(composer);
      if (!original.trim()) {
        flash(document.querySelector(ATTACHMENT_SELECTOR)
          ? "text is in an attachment — can't read it"
          : "nothing typed yet");
        return;
      }

      let output;
      try {
        ({ output } = compress(original, ruleState));
      } catch (err) {
        console.error("[Procdor] compress failed:", err);
        flash("error — see console");
        return;
      }

      const before = approxTokenCount(original);
      const after = approxTokenCount(output);

      // only rewrite if it's an actual win — a same-or-longer "condense" that
      // just reshuffles words isn't worth clobbering what the user typed
      if (!output.trim() || output.trim() === original.trim() || after >= before) {
        flash(before > 0 ? `already lean · ${before}t` : "already lean");
        return;
      }

      setComposerText(composer, output);
      flash(before > 0 ? `${before}→${after}t` : "condensed");
    });

    return button;
  }

  function ensureButton() {
    if (document.getElementById("procdor-condense-btn")) return;
    if (!findComposer()) return;
    document.body.appendChild(buildButton());
  }

  // ---- large-paste interception ----
  // Past ~40k characters claude.ai diverts a paste into a file attachment, which
  // the Condense button then can't read. Catch the paste in the capture phase
  // (before the app's own handler), condense it, and drop the result straight
  // into the composer as ordinary text so it stays visible and editable.
  // ~40000 shadows claude.ai's threshold as measured; adjust if that shifts.
  const PASTE_MIN_CHARS = 40000;

  // A pasted source file / data dump shouldn't be run through the prose rules —
  // force it inline (so it's still reachable) but leave the text untouched.
  function looksLikeCode(text) {
    const lines = text.split("\n", 200);
    if (lines.length < 5) return false;
    let codey = 0;
    for (const l of lines) {
      if (/^\s{2,}\S/.test(l) ||
          /[;{}]\s*$/.test(l) ||
          /^\s*(def |class |function |import |from |const |let |var |public |private |#include|package |return |<\/?[a-zA-Z])/.test(l)) {
        codey++;
      }
    }
    return codey / lines.length > 0.3;
  }

  window.addEventListener("paste", (e) => {
    if (!interceptLargePastes) return;
    const composer = findComposer();
    if (!composer) return;
    if (e.target !== composer && !composer.contains(e.target)) return;

    const cd = e.clipboardData;
    if (!cd || (cd.files && cd.files.length)) return; // real file paste — leave it

    const text = cd.getData("text/plain");
    if (!text || text.length < PASTE_MIN_CHARS) return; // normal pastes: hands off

    let output = text;
    if (!looksLikeCode(text)) {
      try {
        const r = compress(text, ruleState);
        if (r.output && r.output.trim() && r.output.length < text.length) output = r.output;
      } catch (err) {
        console.error("[Procdor] paste compress failed:", err);
      }
    }

    e.preventDefault();
    e.stopImmediatePropagation();
    composer.focus();
    document.execCommand("insertText", false, output);

    const before = approxTokenCount(text);
    const after = approxTokenCount(output);
    flash(output === text ? `pasted inline · ${before}t` : `pasted · ${before}→${after}t`);
  }, true);

  ensureButton();

  // claude.ai is a single-page app — the composer gets unmounted/remounted on
  // navigation, so keep checking rather than relying on one-time page load setup.
  const observer = new MutationObserver(() => ensureButton());
  observer.observe(document.body, { childList: true, subtree: true });
})();
