# decision log

informal running log of the reasoning + decisions behind this project, mostly so future-us (and anyone else poking around this repo) can see why things are the way they are instead of just what they are.

## quick summary

- **no llm calls for the core rewrite** — compression runs as plain regex/heuristics, client-side, free. paying tokens to save tokens defeats the point.
- **protected spans are always on** — code blocks, few-shot examples, reasoning scaffolds (ReAct/CoT), and quotes are preserved verbatim, never touched by compression rules.
- **plain labeled text (`Role:`/`Task:`) is the default output, not json or xml** — both cost more tokens than plain text due to tag/quote overhead. xml is a claude-specific quality lever, not a compression one.
- **semantic (embedding-based) duplicate detection is deferred to v2** — current jaccard/word-overlap dedup only catches literal restatements, not paraphrases. fine for now.
- **building for claude.ai first, not chatgpt** — claude's usage limit is token-based (shorter prompts = more messages before hitting the cap), chatgpt plus's is a flat message count (prompt length doesn't matter). the product's core pitch is only mechanically true on claude.

## the original idea

started as "make a chrome extension that condenses prompts to save tokens," inspired by machine-style prompting (`Role: ___`, `Task: ___`) being more efficient than natural conversational phrasing.

first instinct was to use langchain / spacy / beautifulsoup for the actual condensing. turns out that doesn't really work: chrome extensions run in plain js/ts in the browser sandbox, they can't execute python. beautifulsoup doesn't apply at all (dom apis handle page reading), and spacy/langchain would need a separate backend server the extension calls over http.

## the big fork: call an llm to rewrite, or not?

first design leaned toward "extension calls an llm api directly (bring your own key) to rewrite the prompt into a condensed form."

then realized: if the whole point is saving tokens / usage-quota, paying for an api call to do the condensing is often a net loss. spending tokens to save tokens doesn't make sense unless the rewrite call is way cheaper than what it saves.

**decision: no llm calls for the core rewrite.** everything runs as plain regex/heuristic text processing in js, in the browser, for free, instantly. this is the whole thing that makes the product make sense.

## what the rule engine actually does

- strip hedges/politeness ("i was wondering if you could", "please", "thanks in advance")
- strip filler/intensifiers ("just", "basically", "actually", "really")
- swap wordy phrases ("due to the fact that" -> "because")
- convert questions to imperatives ("can you write..." -> "write...")
- collapse duplicate/restated sentences (jaccard word-overlap similarity, threshold 0.6)
- pull structure out into labeled fields: `Role:` / `Context:` / `Task:` / `Constraints:` / `Examples:` / `Format:`
- **protected spans (always on, not a toggle):** code blocks, few-shot examples (`Q:`/`A:`, `Input:`/`Output:`), reasoning scaffolds (ReAct `Thought:`/`Action:`/`Observation:`, CoT triggers like "step by step"), and quoted text all get fenced off before any rule runs and spliced back in verbatim. this exists because naive filler-stripping would absolutely mangle a chain-of-thought trigger phrase or a few-shot example, and those aren't fluff, they're load-bearing.

## on "10x compression" / json / xml

wanted to push compression way further using a json-style or xml-style machine format. reality check:

- json/xml both cost *more* tokens than plain `key: value` text because of the open+close tag / quote+brace overhead. neither is a compression lever.
- xml tags specifically are a claude-ism (claude's tuned to attend well to `<role>`/`<task>` style tags) — that's a reliability/steerability thing, not a token-savings thing, and it's model-specific (doesn't help gpt/gemini the same way).
- realistic ceiling for structural relabeling is more like +20-40% on top of surface trims, not 10x. actual 10x would mean cutting real content/meaning, which needs semantic understanding (i.e. a model), which is the exact cost tradeoff we already ruled out.
- **decision:** plain labeled text stays the default output (cheapest, universal). xml-tag mode for claude specifically is a good v2 idea (site-aware: detect the domain, switch format) but not default.

## semantic similarity (catching paraphrased duplicates)

the jaccard/word-overlap dedup only catches literal restatements, not synonym-level paraphrases ("checks if" vs "determines whether" share basically no words, so they don't get flagged even though they mean the same thing).

fixing that properly needs embeddings (vector similarity, not word-overlap), which means either:
- calling a remote embeddings api (cheap per-call, but real cost + latency + sends prompt text to a third party), or
- running a small embedding model locally in-browser (transformers.js style — zero marginal cost but adds real bundle size + device compute)

**decision:** leave as a documented limitation for now, scoped as a v2/opt-in feature. not worth the complexity for a refinement on top of an already-working tool.

## bugs found while building the richer rule set

worth remembering since they were sneaky:

1. filler-word regex didn't consume a trailing comma ("basically, i need" -> ", i need" — stray comma left behind)
2. hedge-stripping and imperative-conversion rules both matched "could you" — hedges ran first and silently ate it as plain politeness, so by the time imperative-conversion looked for a sentence starting with "could you" it was already gone, and the trailing "?" never got fixed to "."
3. the imperative pass used a lookbehind-based sentence splitter that didn't reliably consume single newlines, leaving stray blank lines around protected-span tokens

fixed by: reordering imperative-conversion before hedge-stripping, switching the imperative pass to the same chunk-splitter (exact separator preservation) the other rules use, and patching the filler regex to eat an optional trailing comma.

## which platform to build for first: claude.ai vs chatgpt

technically the two are basically a wash — both use a contenteditable rich-text input rather than a plain textarea, so dom handling complexity is similar either way.

the deciding factor turned out to be how each platform actually enforces usage limits, which we looked up rather than assumed:

- **claude.ai**: the usage limit explicitly tracks *tokens*, not message count — long messages, large files, and deep conversation history all draw down the same pool. shortening a prompt genuinely buys more turns before hitting the wall.
- **chatgpt plus**: the cap is a flat *message count* (e.g. 160 messages per 3-hour window) — a message is a message regardless of length. condensing a prompt doesn't stretch this cap at all (short of hitting context/file-size ceilings).

that's a real problem for chatgpt-first: the whole pitch is "condense your prompt to preserve usage allowance," and that claim is basically false on chatgpt. it's mechanically true on claude.

audience fit also favors claude: its userbase skews toward developers/prompt-engineering-literate power users who actually hit and care about usage caps, vs chatgpt's much larger but more casual free-tier base. plus the xml-tag v2 feature is claude-specific anyway, so building there first gives it somewhere to land immediately.

**decision: build the content script against claude.ai first.** structuring the extension with a site-adapter pattern from day one (one small module per site defining how to find/read/write the input box) so chatgpt support later is additive, not a rewrite — just note its marketing pitch would need to shift to something honest like "avoid context overflow" rather than "beat the usage cap," since the quota story doesn't apply there.

## bug: orphaned commas + interjections blocking imperative conversion

found while actually using the extension: `"Please, could you help me..."` left a stray leading comma behind. root cause turned out to be two things, not one:

1. several hedge patterns (`please`, `could you`, `i think`, `thanks`, etc.) didn't consume a trailing comma, unlike the fix already applied to filler words earlier.
2. bigger issue — imperative-conversion (the thing that turns "could you write...?" into "Write...") only checks if the question-form is the *very first* thing in the sentence. any interjection in front ("Please, could you...", "Thanks, can you...", "Well, I think...") blocked the match entirely, so hedges quietly ate the interjection on its own and left a lowercase, still-question-marked fragment behind with no capitalization/punctuation fix.

patching the imperative regexes to individually special-case "please" fixed only that one word — "Thanks, can you...?" hit the identical bug with a different interjection. the actual fix: added a dedicated pre-pass (`stripLeadingInterjection`, gated by the hedges toggle) that strips any leading interjection — please/thanks/hi/hello/well/so/hey — from each sentence *before* imperative-conversion runs, so imperative always sees a clean sentence start no matter which politeness word came first. also broadened the orphaned-comma cleanup to fire after any sentence boundary (not just start-of-string/newline), and added a final `capitalizeSentences` pass so capitalization no longer depends on which specific rule happened to touch a sentence first.

ported the identical fix to `extension/lib/compress.js` and diffed outputs against `index.html` on the same test cases to confirm both engines still agree — worth remembering that duplicating the engine between the test bench and the extension means every fix has to be applied twice by hand; that's a real maintenance cost worth revisiting (e.g. have `index.html` load `extension/lib/compress.js` via `<script src>` instead of an embedded copy) if bugs like this keep recurring.

## scaffolding the extension

built `extension/` as a manifest v3 chrome extension targeting claude.ai: `lib/compress.js` (the same rule engine as `index.html`, extracted so both share one tested implementation), `content.js` (finds the composer, injects a floating condense button), `content.css`, and a `popup.html`/`popup.js` for toggling which rules are active (synced via `chrome.storage.sync` so the content script picks up changes live).

one thing worth flagging about `content.js`:

- **writing text back into the composer uses `document.execCommand("insertText", ...)`**, not a direct `textContent` assignment. claude's composer is almost certainly a framework-controlled contenteditable (react/prosemirror-ish), and directly mutating the dom bypasses the input events those frameworks listen for — the displayed text and the framework's internal state end up disagreeing, which is why programmatic text injection into rich editors like this conventionally goes through execCommand (or a fired `InputEvent`) instead.

**update:** loaded it unpacked and tested against the real claude.ai — the composer-detection fallback chain (aria-label / data-placeholder / bare contenteditable, filtered by visible size) worked on the first try, no selector fixes needed. button shows up, condensing works, popup rule toggles take effect.

## current status

test bench (`index.html`) and extension (`extension/`) both work end to end, confirmed against the real claude.ai. rules keep getting refined as we go rather than being "finished" first.
