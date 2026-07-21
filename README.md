# Procdor

A rule-based prompt condenser: rewrites verbose prompts into a leaner form (and, optionally, a structured `Role: / Task: / Format:` shape) without calling an LLM to do it — so testing and using the compression costs zero extra tokens.

## Why rule-based, not an LLM call

The initial idea was to have a model rewrite prompts into a token-efficient form. But if the goal is to reduce token spend / usage-quota consumption, paying for a rewrite call to save a few tokens on the original prompt is usually a net loss. Plain-text pattern matching (strip hedges/filler, swap wordy phrases, question → imperative, detect role/format) gets a meaningful chunk of the same benefit for free and instantly.

## `index.html`

Self-contained test bench: paste a prompt, toggle rule categories on/off, see token estimate before/after and an inline diff of what each rule changed. No build step — open the file directly in a browser.

## Status

Early prototype. Next: port the rule engine into a Chrome extension (Manifest V3) that runs it against the input box on chat.openai.com / claude.ai before submission.
