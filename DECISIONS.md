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

## the button "does nothing" — silent no-op + fragment stripping (2026-09-09)

came back to it after a break: the condense button showed up on claude.ai but "wasn't doing anything." drove it live in the real composer — turned out it *was* working (verbose test prompt condensed 45→29, text landed in the tiptap/prosemirror composer fine, no selector rot). two real problems behind the "dead button" feeling:

1. **silent no-op.** the click handler had four early `return`s (no composer, empty input, `output === original`, falsy output) with zero feedback. an already-lean prompt → click → nothing visible → reads exactly like a broken button. fix: every click now flashes the badge — `no input box found` / `nothing typed yet` / `already lean · Nt` / `error — see console` / `N→Mt`. also wrapped `compress()` in try/catch so an engine throw surfaces instead of dying silently.

2. **hedge-stripping left sentence fragments.** `"I was wondering if you could possibly help me out here."` → `"Possibly help me out here."`; `"Thanks so much in advance, I really appreciate it."` → `"In advance, I appreciate it."`. root cause: the hedge regexes chop a leading verb-phrase but leave the rest of a now-pointless sentence, and `stripLeadingInterjection` eats just the first politeness token ("Thanks ") orphaning the rest so the full-sentence hedge pattern never matches. fix: added `dropPleasantries` — a pre-pass (gated by the `hedges` toggle, runs before interjection-strip and imperative) that matches a *whole* trimmed sentence against a list of pure-politeness patterns (thanks / I appreciate it / I hope this / I was wondering if you could help / any feedback welcome / no rush …) and drops the entire sentence. guards: skips any sentence containing a `CONSTRAINT_TRIGGER` (that's real content, extracted later), the patterns carry a trailing `[^?]*$` so a sentence that actually asks something survives, and if the pass would empty the whole prompt it's a no-op. also added a final guard in `compress()`: if the rules reduce the prompt to punctuation-noise with no alphanumerics, hand back the whitespace-normalized original instead.

3. **imperative `?`→`.` never fired** when the "?" sat in the *separator* chunk (`"? "`) rather than at the end of the sentence chunk. `applyImperative` now returns `{ text, converted }` and the compress loop rewrites the following separator's leading `?` to `.` when a conversion happened.

**known residual:** interjection-before-imperative still misses non-politeness connectives — `"Also, could you give an example?"` → `"Also, give an example?"` (the "?" stays). same class as the old "please, could you" bug but "also"/"then"/"additionally" aren't in the interjection list. also a trailing "?" on an *already*-imperative sentence isn't normalized to "." (`"Write a prime checker?"` stays). left as follow-ups.

### follow-up: "36→36t" non-wins + more fragments (2026-09-09, same day)

using it more: clicking condense sometimes replaced the text and flashed `36→36t` — i.e. a rule changed the wording (capitalization / word swap) without dropping any tokens, so it clobbered what was typed for no gain. fix in `content.js`: only rewrite when `after < before` — a same-or-longer result now falls through to the `already lean` badge and leaves the composer untouched.

also two more pleasantry shapes slipped through: `"Was wondering if you could…"` (casual dropped-"I") and `"…in advance, I appreciate it"` (the "Thanks so much" head already eaten by hedge-stripping, leaving `"Much in advance, I appreciate it."`). added patterns for both. the in-advance pattern requires the appreciation tail (`in advance, I appreciate` / `in advance, thanks` / `in advance for your help`) so `"In advance of the meeting, prepare a summary."` is left alone. verified against false-positive cases (`"Much of the program logic depends on…"`, `"In advance of the meeting…"`, `"Was wondering if you could review this?"` — the last kept because it actually asks something).

### engine de-duplication (finally did it)

the fragment fix would have meant hand-porting regex changes across `index.html` and `extension/lib/compress.js` again — the exact maintenance cost flagged earlier. so `index.html` now loads the shared engine via `<script src="extension/lib/compress.js">` (+ `const { RULES, compress, approxTokenCount } = window.ProcdorCompress;`) instead of carrying an inline copy. one engine now. only wrinkle: the test bench must be opened from a path where `extension/lib/compress.js` resolves relative to `index.html` (i.e. the repo root) — fine for `file://` in chrome, which allows sibling/subdir script loads.

## large pastes become an attachment the button can't reach (2026-09-09)

using it for real: pasting a big prompt (user said ">500 lines") into claude.ai turns it into a "PASTED" **file attachment** instead of composer text, so Procdor — which only reads the contenteditable — has nothing to work with.

measured claude.ai's behaviour live (real cmd-v pastes, browser automation):
- the trigger is **character count, not line count** — ~2900 chars over 600 short lines pasted inline fine; 20k / 30k / 40k single-line pasted inline; **~41k chars became an attachment**. so the threshold sits around 40–41k chars.
- the attachment pill is `[data-testid="file-thumbnail"]`.
- a **capture-phase `paste` listener on `window`** fires before claude.ai's own handler; `preventDefault()` + `stopImmediatePropagation()` fully suppresses the attachment, and our own `execCommand("insertText", …)` then populates the composer normally. (verified by injecting the listener into the live page.)

**what shipped (`content.js`):**
1. capture-phase `paste` listener.
2. on a qualifying paste: run it through `compress()` and `execCommand insertText` the result into the composer — **inline**, not an attachment, so it's visible/editable and the Condense button can still work on it.
3. `looksLikeCode()` guard — if >30% of the first 200 lines look like source/markup (indentation, trailing `;{}`, `def`/`function`/`import`/tag starts), don't touch it; claude.ai handles it normally (an attachment is the right call for a pasted file).
4. gated by a popup toggle **"Catch & condense big pastes"** (`chrome.storage.sync` key `procdorPasteIntercept`, default on).
5. the badge (`flash`) was lifted to module scope so the paste handler can report `pasted · 12800→900t`.

**threshold (revised same day):** first cut was `chars ≥ 40000` to shadow claude's cutover. but claude attaches at well under 40k in real use (it's not a fixed char count — the user originally hit it at ">500 lines"), so those pastes landed as attachments and never got condensed. dropped to **`chars ≥ 6000` OR `lines ≥ 40`**, whichever hits first — low enough to catch anything that could plausibly become an attachment, and normal short pastes (a paragraph, a snippet) are still untouched. a paste that qualifies but doesn't actually shrink is left alone (`output.length >= text.length` → no-op), as is a code/data dump. the toggle is the escape hatch if 40 lines feels too eager.

**also (#3, the confusion moment):** clicking Condense with an empty composer but an attachment present now flashes `"text is in an attachment — can't read it"` instead of `"nothing typed yet"`.

**not yet verified live** (needs an unpacked-extension reload, which can't be done from browser automation): the capture-phase listener registered from the content script's *isolated world* — as opposed to the page world, where it's proven — beating claude.ai's handler. Very likely fine (window capture is the earliest hook) but if big pastes still attach after reload, that's the reason and the fix is a `world: "MAIN"` shim.

### condense → back to an attachment (2026-09-09)

follow-up ask: instead of forcing a big condensed paste inline, condense it and keep it as an attachment so the composer stays clean.

what the live testing showed:
- a **synthetic `ClipboardEvent`** (re-dispatching a paste with condensed text) does **not** trigger claude.ai's paste-to-attachment path — it just goes inline. so we can't "re-paste" the condensed text.
- but assigning a `File` to claude's hidden `<input type=file>` and firing `change` **does** create an attachment — it shows as a normal `condensed-prompt.txt` / `TXT` chip (not the "PASTED" styling, but functionally the same document).
- claude.ai routes an **unfocused** paste to the composer via a document-level handler, so the old `e.target === composer` gate was too strict — loosened to "bail only if the paste landed in some *other* real input".

shipped in the paste handler: after condensing, if the result is still big (same `isBigText` check) and the **"Keep still-large results as a .txt attachment"** toggle is on (`procdorPasteAttach`, default on, nested under the master toggle), call `attachAsFile()`. if it doesn't land within 500ms, fall back to inserting inline so a paste is never lost. a result that condensed down small just goes inline regardless.

## a real 40k-char structured prompt "heavily glitches out" (2026-09-09)

user pasted their actual venture-analyst report system prompt (~40k chars, heavy markdown: `##` headings, `|` tables, `>` blockquotes, WRONG/RIGHT example pairs). ran it through the engine offline. three separate faults:

1. **`hierarchy` → `erarchy`.** the `hi`/`hello` hedge patterns were `/\bhi[,!]?\s*/gi` with no *trailing* `\b`, so they ate "hi" out of "**hi**erarchy", "highly", "him", etc. `thanks?` had the same hole ("thankfully" → "fully"). added the trailing `\b` to all three.
2. **`U.S. firm` → `U.S. Firm`, and `Role:` extraction splitting on the "." in "U.S."** the sentence splitter treats every `. ` as a boundary. fixes: (a) `capitalizeSentences` now skips a fragment whose previous chunk ends in an abbreviation (`endsWithAbbrev`: `U.S`, `e.g`, `Inc`, lone initials, …); (b) `ROLE_PATTERN` replaced with `ROLE_LEAD` + a procedural scan that walks to the first sentence-ending period that *isn't* preceded by a capital letter, so "leading U.S. firm." is captured whole. (note: `[A-Z]` inside a `/i` regex matches lowercase too — that's why the lookbehind approach failed and it's done procedurally with a case-sensitive check.)
3. **the `structural` (Role/Context/Task/Constraints bucketing) and `redundant` (dup-collapse) rules shredded the document** — they assume a short "you are X, do Y" prompt and instead reordered sentences across all 15 sections and yanked every constraint-shaped sentence into one blob. fix: `content.js` now has `rulesFor(text)` — if the input is long (>6k chars) or markdown-structured (headings / table rows / blockquotes / >60 lines), it runs **surface trims only** (hedges, filler, wordy, imperative), with `structural` and `redundant` forced off. applies to both the paste path and the Condense button.

also: `collapseWhitespace` was flattening all leading indentation (`/^[ \t]+/gm`), which breaks markdown nesting and the indented RIGHT/WRONG pairs — rewritten to be line-aware and preserve each line's leading indent while still tidying the rest. and the paste path now requires a **≥5% size reduction** before taking over the paste, so it leaves an already-tight structured doc alone rather than clobbering it to save 3 tokens.

## text-type classification + the attachment is claude's anti-truncation feature (2026-09-09)

two corrections from the user:

1. **the "PASTED" attachment is claude.ai's own workaround for very long pastes that would otherwise get truncated inline.** so forcing big text inline (the earlier instinct) re-introduces the truncation. the paste handler now: condense first, then place by size — `output.length <= SAFE_INLINE_MAX` (12k chars) → inline; larger → **must** be an attachment (toggle ignored at that size), built by us via `attachAsFile` so it carries the *condensed* text. if `attachAsFile` can't land it and the text is too big to inline safely, we flash "couldn't attach — paste again" rather than silently truncating.

2. **detect the text type.** new `classifyText(text)` → `code` / `data` (JSON or consistent CSV/TSV over 5+ rows) / `markdown` (2+ distinct md constructs: headings, lists, blockquotes, tables, bold/code spans, links) / `prose`. paste handler skips `code` and `data` entirely (claude's native handling is right for those). `rulesFor(text, kind)` runs surface-trims-only for `markdown` and `code` and for anything long, full rules only for short plain prose. badge and attachment filename reflect the kind (`condensed-prompt.md` vs `.txt`, `pasted markdown` vs `pasted text`).

`SAFE_INLINE_MAX` (12k) is a guess — claude allowed 40k inline in testing but the user reports truncation on their ~40k prompt, so the real safe ceiling is lower and unknown; 12k is deliberately conservative.

## current status

engine is single-source (`extension/lib/compress.js`, loaded by both the extension and `index.html`). silent-no-op, fragment-stripping, non-win, large-paste-intercept, and condense-to-attachment are all in. the individual mechanisms are verified against live claude.ai (capture-phase paste block; File→input→attachment); the **end-to-end flow through the reloaded extension still needs a live confirm** (content-script changes don't hot-reload, and browser automation can't reload an unpacked extension). rules keep getting refined as we go rather than being "finished" first.
