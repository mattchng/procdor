# notes / how we got here

quick informal log of the reasoning behind this project so far, mostly so future-us remembers why things are the way they are.

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

## current status

test bench (`index.html`) works: paste a prompt, toggle rule categories, see token estimate + inline diff of what changed. next step is scaffolding the actual chrome extension (manifest v3, content script to grab the input box on chat sites) — rules will keep getting refined as we go rather than being "finished" first.
