(function () {
  const { compress, approxTokenCount, defaultRuleState } = window.ProcdorCompress;

  let ruleState = defaultRuleState();
  let interceptLargePastes = true;
  let keepBigPasteAsFile = true;

  chrome.storage.sync.get(
    ["procdorRules", "procdorPasteIntercept", "procdorPasteAttach"],
    (data) => {
      if (data.procdorRules) ruleState = Object.assign(ruleState, data.procdorRules);
      if (typeof data.procdorPasteIntercept === "boolean") {
        interceptLargePastes = data.procdorPasteIntercept;
      }
      if (typeof data.procdorPasteAttach === "boolean") {
        keepBigPasteAsFile = data.procdorPasteAttach;
      }
    }
  );
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync") return;
    if (changes.procdorRules) {
      ruleState = Object.assign(defaultRuleState(), changes.procdorRules.newValue);
    }
    if (changes.procdorPasteIntercept &&
        typeof changes.procdorPasteIntercept.newValue === "boolean") {
      interceptLargePastes = changes.procdorPasteIntercept.newValue;
    }
    if (changes.procdorPasteAttach &&
        typeof changes.procdorPasteAttach.newValue === "boolean") {
      keepBigPasteAsFile = changes.procdorPasteAttach.newValue;
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

  // The structural (Role/Context/Task/Constraints bucketing) and duplicate-collapse
  // rules assume a short conversational prompt. On a long or markdown-structured
  // document they reorder sentences across sections and shred the formatting, so
  // for that kind of input stick to the surface trims.
  function rulesFor(text) {
    const structured =
      /^#{1,6}\s/m.test(text) ||       // markdown headings
      /^\s*\|.+\|\s*$/m.test(text) ||  // table rows
      /^\s*>\s/m.test(text) ||         // blockquotes
      text.split("\n").length > 60;
    if (text.length > 6000 || structured) {
      return Object.assign({}, ruleState, { structural: false, redundant: false });
    }
    return ruleState;
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
        ({ output } = compress(original, rulesFor(original)));
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
  // A big enough paste gets diverted by claude.ai into a "PASTED" file attachment,
  // which the Condense button then can't read. The exact cutover isn't a fixed
  // number (and shifts), so rather than shadow it we catch any clearly-large prose
  // paste in the capture phase (before the app's own handler), condense it, and
  // drop the result straight into the composer as ordinary text.
  const PASTE_MIN_CHARS = 6000;
  const PASTE_MIN_LINES = 40;

  // A pasted source file / data dump would only get mangled by the prose rules and
  // isn't what this is for — leave those to claude.ai's normal handling.
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

  function isBigText(t) {
    return t.length >= PASTE_MIN_CHARS || t.split("\n").length >= PASTE_MIN_LINES;
  }

  // Drop text into claude.ai's own attachment flow as a .txt file. Synthetic
  // ClipboardEvents don't trigger its paste-to-attachment path, but assigning a
  // File to the hidden <input type=file> and firing "change" does. Returns false
  // if the input isn't there so the caller can fall back to inline.
  function attachAsFile(text, name) {
    const input = document.querySelector('input[type="file"]');
    if (!input) return false;
    try {
      const dt = new DataTransfer();
      dt.items.add(new File([text], name, { type: "text/plain" }));
      input.files = dt.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    } catch (err) {
      console.error("[Procdor] attach-as-file failed:", err);
      return false;
    }
  }

  window.addEventListener("paste", (e) => {
    if (!interceptLargePastes) return;
    const composer = findComposer();
    if (!composer) return;
    // claude.ai routes an unfocused paste to the composer itself, so accept a
    // paste aimed at the composer OR at nothing in particular — only bail if it
    // landed in some other real input (e.g. the sidebar search box)
    const tgt = e.target;
    const otherField = tgt && tgt.closest &&
      tgt.closest('input, textarea, [contenteditable="true"]');
    if (otherField && otherField !== composer && !composer.contains(otherField)) return;

    const cd = e.clipboardData;
    if (!cd || (cd.files && cd.files.length)) return; // real file paste — leave it

    const text = cd.getData("text/plain");
    if (!text) return;
    if (!isBigText(text)) return;    // normal pastes: hands off
    if (looksLikeCode(text)) return;

    let output;
    try {
      output = compress(text, rulesFor(text)).output;
    } catch (err) {
      console.error("[Procdor] paste compress failed:", err);
      return;
    }
    // only take over the paste if condensing meaningfully shrinks it (>=5%);
    // otherwise leave it for claude.ai to handle however it normally would
    if (!output || !output.trim() || output.length > text.length * 0.95) return;

    e.preventDefault();
    e.stopImmediatePropagation();

    const before = approxTokenCount(text);
    const after = approxTokenCount(output);

    const insertInline = () => {
      composer.focus();
      document.execCommand("insertText", false, output);
      flash(`pasted · ${before}→${after}t`);
    };

    // still large after condensing → hand it to claude as a .txt attachment so the
    // composer stays clean; otherwise just drop the (now short) text inline
    if (keepBigPasteAsFile && isBigText(output) &&
        attachAsFile(output, "condensed-prompt.txt")) {
      flash(`condensed → .txt · ${before}→${after}t`);
      // if the attachment didn't actually land, don't lose the paste
      setTimeout(() => {
        if (!document.querySelector(ATTACHMENT_SELECTOR)) insertInline();
      }, 500);
    } else {
      insertInline();
    }
  }, true);

  ensureButton();

  // claude.ai is a single-page app — the composer gets unmounted/remounted on
  // navigation, so keep checking rather than relying on one-time page load setup.
  const observer = new MutationObserver(() => ensureButton());
  observer.observe(document.body, { childList: true, subtree: true });
})();
