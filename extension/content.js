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
  // Past ~40k characters claude.ai diverts a paste into a file attachment. For a
  // *prompt* that's the wrong place: the model treats an attached file as a
  // document to analyze ("I read through the file..."), not as instructions to
  // follow, and you can't review it. So condense the paste and put the result in
  // the composer as ordinary text — where the model obeys it and you can read and
  // edit it before sending.
  const PASTE_MIN_CHARS = 6000;
  const PASTE_MIN_LINES = 40;
  // At/above this we always take the paste over and force it inline, even if we
  // can't condense it — claude.ai's own paste-to-attachment cutover was measured
  // around 40k but varies, so this sits well below it as a safety margin.
  const FORCE_INLINE_AT = 15000;
  // A still-sizable inline prompt is worth a "go read it" nudge.
  const REVIEW_WARN_AT = 30000;

  function isBigText(t) {
    return t.length >= PASTE_MIN_CHARS || t.split("\n").length >= PASTE_MIN_LINES;
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
    if (!output || !output.trim()) output = text;

    const gain = 1 - output.length / text.length;
    // small enough that claude keeps it inline anyway, and we can't help → stay out
    if (gain < 0.03 && text.length < FORCE_INLINE_AT) return;

    e.preventDefault();
    e.stopImmediatePropagation();
    composer.focus();
    document.execCommand("insertText", false, output);

    const before = approxTokenCount(text);
    const after = approxTokenCount(output);
    const label = kind === "markdown" ? "markdown" : "text";
    if (output.length >= REVIEW_WARN_AT) {
      flash(`${label} inline, ~${Math.round(output.length / 1000)}k chars — review before sending`);
    } else {
      flash(`pasted ${label} · ${before}→${after}t`);
    }
  }, true);

  ensureButton();

  // claude.ai is a single-page app — the composer gets unmounted/remounted on
  // navigation, so keep checking rather than relying on one-time page load setup.
  const observer = new MutationObserver(() => ensureButton());
  observer.observe(document.body, { childList: true, subtree: true });
})();
