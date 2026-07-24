# Procdor

A rule-based prompt condenser: rewrites verbose prompts into a leaner form (and, optionally, a structured `Role: / Task: / Format:` shape) without calling an LLM to do it — so testing and using the compression costs zero extra tokens.

## Why rule-based, not an LLM call

The initial idea was to have a model rewrite prompts into a token-efficient form. But if the goal is to reduce token spend / usage-quota consumption, paying for a rewrite call to save a few tokens on the original prompt is usually a net loss. Plain-text pattern matching (strip hedges/filler, swap wordy phrases, question → imperative, detect role/format) gets a meaningful chunk of the same benefit for free and instantly.

## `index.html`

Self-contained test bench: paste a prompt, toggle rule categories on/off, see token estimate before/after and an inline diff of what each rule changed. No build step — open the file directly in a browser.

## `extension/`

The actual Chrome extension (Manifest V3), targeting claude.ai first. Shares the same rule engine as `index.html` via `extension/lib/compress.js`.

To load it locally: open `chrome://extensions`, enable Developer Mode, click "Load unpacked," and select the `extension/` folder. A small "⟪ Condense" button should appear on claude.ai; click it to rewrite whatever's in the composer. Click the extension icon in the toolbar to toggle which rules are active.

**Known caveat:** the composer-detection selectors in `content.js` were written without live access to claude.ai's DOM (couldn't verify against the real page this session) — they use a fallback chain of semantic/size-based heuristics rather than a single brittle selector, but they haven't been confirmed against the live site yet. If the Condense button doesn't show up, that's the first thing to check.

## `DECISIONS.md`

Running log of the reasoning behind the project's design choices (why rule-based, why Claude first, known limitations, bugs found along the way). Worth a read if you want the "why" behind the code, not just the "what."
