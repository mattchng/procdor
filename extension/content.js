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

  // Classify a paste so we can (a) skip things we'd only damage and (b) pick a
  // rule profile that fits.
  //   "code"     — source / markup: leave it entirely alone
  //   "data"     — JSON, CSV/TSV: leave it entirely alone
  //   "markdown" — formatted prose: surface trims only, keep the structure
  //   "prose"    — plain text: full rules if short, surface trims if long
  function classifyText(text) {
    const lines = text.split("\n");
    const sample = lines.slice(0, 300);
    const n = sample.length || 1;

    const trimmed = text.trim();
    if ((trimmed[0] === "{" || trimmed[0] === "[") && trimmed.length > 40) {
      try { JSON.parse(trimmed); return "data"; } catch (_) { /* not JSON */ }
    }
    const delimConsistent = (re) => {
      if (n < 5) return false; // need several rows to call it a table
      const counts = sample.map((l) => (l.match(re) || []).length);
      return counts[0] >= 2 &&
             counts.filter((c) => c === counts[0]).length / n > 0.85;
    };
    if (delimConsistent(/,/g) || delimConsistent(/\t/g)) return "data";

    let codey = 0;
    for (const l of sample) {
      if (/^\s{2,}\S/.test(l) || /[;{}]\s*$/.test(l) ||
          /^\s*(def |class |function |import |from |const |let |var |public |private |#include|package |return |<\/?[a-zA-Z])/.test(l)) {
        codey++;
      }
    }
    if (codey / n > 0.3) return "code";

    let md = 0;
    if (/^#{1,6}\s/m.test(text)) md++;
    if (/^\s*(?:[-*+]|\d+\.)\s+\S/m.test(text)) md++;
    if (/^\s*>\s/m.test(text)) md++;
    if (/^\s*\|.+\|\s*$/m.test(text)) md++;
    if (/\*\*[^*\n]+\*\*/.test(text) || /`[^`\n]+`/.test(text)) md++;
    if (/\[[^\]\n]+\]\([^)\n]+\)/.test(text)) md++;
    if (md >= 2) return "markdown";

    return "prose";
  }

  // The structural (Role/Context/Task/Constraints bucketing) and duplicate-collapse
  // rules assume a short conversational prompt. On markdown or on any long document
  // they reorder sentences across sections and shred the formatting.
  function rulesFor(text, kind) {
    kind = kind || classifyText(text);
    if (kind === "markdown" || kind === "code" ||
        text.length > 6000 || text.split("\n").length > 60) {
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
  // claude.ai diverts a big paste into a file attachment on purpose: past a
  // certain size, inline composer text gets truncated, and the attachment is its
  // workaround. So the goal here isn't to force big text inline — it's to condense
  // it *first*, then put it wherever it belongs: inline if the condensed result is
  // safely small, otherwise as an attachment (which we build ourselves so it's the
  // condensed text, not the original).
  const PASTE_MIN_CHARS = 6000;
  const PASTE_MIN_LINES = 40;
  // Below this many characters we're confident claude.ai won't truncate inline
  // text; above it, the condensed result has to go in as an attachment.
  const SAFE_INLINE_MAX = 12000;

  function isBigText(t) {
    return t.length >= PASTE_MIN_CHARS || t.split("\n").length >= PASTE_MIN_LINES;
  }

  // Feed text into claude.ai's own attachment flow. Synthetic ClipboardEvents
  // don't trigger its paste-to-attachment path, but assigning a File to the
  // hidden <input type=file> and firing "change" does. Returns false if the input
  // isn't present.
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
    if (!text || !isBigText(text)) return; // normal pastes: hands off

    const kind = classifyText(text);
    if (kind === "code" || kind === "data") return; // don't touch — claude handles it

    let output;
    try {
      output = compress(text, rulesFor(text, kind)).output;
    } catch (err) {
      console.error("[Procdor] paste compress failed:", err);
      return;
    }
    if (!output || !output.trim()) return;

    const gain = 1 - output.length / text.length;
    // if we can't shrink it much AND it would fit inline anyway, stay out of it
    if (gain < 0.05 && text.length <= SAFE_INLINE_MAX) return;

    e.preventDefault();
    e.stopImmediatePropagation();

    const before = approxTokenCount(text);
    const after = approxTokenCount(output);
    const label = kind === "markdown" ? "markdown" : "text";

    const goInline = () => {
      composer.focus();
      document.execCommand("insertText", false, output);
      flash(`pasted ${label} · ${before}→${after}t`);
    };

    // small enough to be safe inline, and not forced to a file → inline
    const wantFile = output.length > SAFE_INLINE_MAX ||
                     (keepBigPasteAsFile && isBigText(output));
    if (!wantFile) {
      goInline();
      return;
    }

    const fname = kind === "markdown" ? "condensed-prompt.md" : "condensed-prompt.txt";
    if (attachAsFile(output, fname)) {
      flash(`condensed ${label} → file · ${before}→${after}t`);
      setTimeout(() => {
        if (document.querySelector(ATTACHMENT_SELECTOR)) return;
        // attachment didn't land — inline is only safe if it's small enough
        if (output.length <= SAFE_INLINE_MAX) goInline();
        else flash("couldn't attach — paste again");
      }, 600);
    } else if (output.length <= SAFE_INLINE_MAX) {
      goInline();
    } else {
      flash("couldn't attach — paste again");
    }
  }, true);

  ensureButton();

  // claude.ai is a single-page app — the composer gets unmounted/remounted on
  // navigation, so keep checking rather than relying on one-time page load setup.
  const observer = new MutationObserver(() => ensureButton());
  observer.observe(document.body, { childList: true, subtree: true });
})();
