(function () {
  const RULES = [
    { id: "hedges", name: "Hedges & politeness", risky: false, default: true,
      desc: "please / could you / I was wondering if" },
    { id: "filler", name: "Filler & intensifiers", risky: false, default: true,
      desc: "just, basically, actually, really, very" },
    { id: "wordy", name: "Wordy phrase swap", risky: false, default: true,
      desc: "\"due to the fact that\" → \"because\"" },
    { id: "imperative", name: "Question → imperative", risky: false, default: true,
      desc: "\"Can you write...\" → \"Write...\"" },
    { id: "redundant", name: "Duplicate sentence collapse", risky: false, default: true,
      desc: "drops later sentences that just restate an earlier one" },
    { id: "structural", name: "Role / Context / Task / Constraints / Examples / Format", risky: false, default: true,
      desc: "buckets the prose into labeled fields" },
    { id: "stopwords", name: "Aggressive stopword trim", risky: true, default: false,
      desc: "strips a/an/the — experimental, often hurts clarity" }
  ];

  const TOKEN_RE = /⟪P(\d+)⟫/g;
  function makeTokenStore() {
    const store = [];
    return {
      store,
      add(type, text) {
        const idx = store.length;
        store.push({ type, text });
        return "⟪P" + idx + "⟫";
      }
    };
  }

  function extractProtected(text) {
    const ts = makeTokenStore();
    let out = text;

    out = out.replace(/```[\s\S]*?```/g, (m) => ts.add("code", m));
    out = out.replace(/`[^`\n]+`/g, (m) => ts.add("code", m));

    const scaffoldRe = /\b(thought|action(?: input)?|observation|final answer)\s*:/i;
    const cotRe = /\b(let'?s think step[\s-]by[\s-]step|step[\s-]by[\s-]step|think out loud|show your reasoning|explain your reasoning|take a deep breath|work through this)\b/i;
    const exampleRe = /^\s*(example\b\s*\d*\s*:?|q\s*:|a\s*:|input\s*:|output\s*:)/i;

    const chunks = out.split(/([.!?]+\s+|\n+)/);
    for (let i = 0; i < chunks.length; i += 2) {
      const seg = chunks[i];
      if (!seg || !seg.trim()) continue;
      if (exampleRe.test(seg)) {
        chunks[i] = ts.add("example", seg);
      } else if (scaffoldRe.test(seg) || cotRe.test(seg)) {
        chunks[i] = ts.add("scaffold", seg);
      }
    }
    out = chunks.join("");

    out = out.replace(/"[^"\n]{3,}"/g, (m) => ts.add("quote", m));

    return { text: out, store: ts.store };
  }

  function restoreProtected(text, store) {
    return text.replace(TOKEN_RE, (m, idxStr) => {
      const entry = store[Number(idxStr)];
      return entry ? entry.text : m;
    });
  }

  function splitChunks(text) {
    return text.split(/([.!?]+\s+|\n+)/);
  }

  function wordsOf(s) {
    return s.toLowerCase().replace(/[^a-z0-9\s']/g, "").split(/\s+/).filter(Boolean);
  }

  function jaccard(a, b) {
    const setA = new Set(a), setB = new Set(b);
    if (setA.size === 0 || setB.size === 0) return 0;
    let inter = 0;
    for (const w of setA) if (setB.has(w)) inter++;
    return inter / (setA.size + setB.size - inter);
  }

  function collapseRedundant(text) {
    const chunks = splitChunks(text);
    const keptWordSets = [];
    for (let i = 0; i < chunks.length; i += 2) {
      const seg = chunks[i];
      if (!seg || !seg.trim()) continue;
      const w = wordsOf(seg);
      if (w.length < 6) { keptWordSets.push(w); continue; }
      const isDup = keptWordSets.some((kw) => jaccard(w, kw) >= 0.6);
      if (isDup) {
        chunks[i] = "";
        if (chunks[i + 1] !== undefined) chunks[i + 1] = " ";
      } else {
        keptWordSets.push(w);
      }
    }
    return chunks.join("");
  }

  const CONSTRAINT_TRIGGER = /\b(must|should not|shouldn't|do not|don't|avoid|never|always|make sure|ensure|at least|no more than|limit(?:ed)? to)\b/i;

  function extractConstraints(text) {
    const chunks = splitChunks(text);
    const constraints = [];
    for (let i = 0; i < chunks.length; i += 2) {
      const seg = chunks[i];
      if (!seg || !seg.trim()) continue;
      if (CONSTRAINT_TRIGGER.test(seg) && wordsOf(seg).length <= 30) {
        constraints.push(seg.trim());
        chunks[i] = "";
        if (chunks[i + 1] !== undefined) chunks[i + 1] = " ";
      }
    }
    return { body: chunks.join(""), constraints };
  }

  const HEDGE_PATTERNS = [
    /\bi was wondering if you (could|can|would)\b,?\s*/gi,
    /\bi'?d like to know if you (could|can)\b,?\s*/gi,
    /\bwould you (mind |please )?,?\s*/gi,
    /\bcould you (please )?,?\s*/gi,
    /\bif (that'?s|it'?s) (okay|ok|alright|fine)[,]?\s*/gi,
    /\bi think (that )?,?\s*/gi,
    /\bi believe (that )?,?\s*/gi,
    /\bin my opinion,?\s*/gi,
    /\bplease\b,?\s*/gi,
    /\bthanks?( you)?( so much)?( in advance)?[.!]?,?\s*/gi,
    /\bthank you[.!]?,?\s*/gi,
    /\bhi[,!]?\s*/gi,
    /\bhello[,!]?\s*/gi
  ];

  const FILLER_WORDS = [
    "just", "basically", "actually", "really", "very", "simply",
    "essentially", "kind of", "sort of", "literally", "definitely",
    "certainly", "quite", "rather", "somewhat", "honestly", "so much"
  ];

  const WORDY_MAP = [
    [/\bin order to\b/gi, "to"],
    [/\bdue to the fact that\b/gi, "because"],
    [/\bat this point in time\b/gi, "now"],
    [/\ba large number of\b/gi, "many"],
    [/\bin the event that\b/gi, "if"],
    [/\bfor the purpose of\b/gi, "to"],
    [/\bwith regards? to\b/gi, "regarding"],
    [/\bin spite of the fact that\b/gi, "although"],
    [/\bon a regular basis\b/gi, "regularly"],
    [/\bmake sure that\b/gi, "ensure"],
    [/\btake into consideration\b/gi, "consider"],
    [/\ba (?:number|couple) of\b/gi, "some"]
  ];

  const IMPERATIVE_PATTERNS = [
    /^can you (please )?/i,
    /^could you (please )?/i,
    /^would you (be able to |please )?/i,
    /^do you think you could\s*/i,
    /^i need you to\s*/i,
    /^i want you to\s*/i
  ];

  const LEADING_INTERJECTION = /^(?:please|thanks?(?: you)?|hi|hello|well|so|hey)[,!]?\s+/i;

  function stripLeadingInterjection(text) {
    return text.replace(LEADING_INTERJECTION, "");
  }

  // Whole sentences that are pure politeness / meta-commentary carrying no task
  // content. Matched against the trimmed sentence; a match drops the sentence
  // entirely rather than word-trimming it (which strands fragments like
  // "Possibly help me out here." or "In advance, I appreciate it."). The
  // trailing [^?]* guard keeps a sentence that actually asks something
  // ("I was wondering if you could check whether this is right?") intact.
  const PLEASANTRY_SENTENCE = [
    /^thank(?:s| you)\b[^?]*$/i,
    /^(?:many thanks|much appreciated|thanks again|cheers)\b[^?]*$/i,
    /^i (?:really |truly |greatly |sincerely )?appreciate (?:it|this|your \w+)\b[^?]*$/i,
    /^i(?:'d| would)? (?:really |truly )?appreciate it if you (?:could|can|would)\b[^?]*$/i,
    /^i(?:'m| am) (?:really |very )?(?:hoping|grateful|thankful)\b[^?]*$/i,
    /^i hope (?:this|that|you|it|these|the above)\b[^?]*$/i,
    // leading "I" is often dropped in casual phrasing ("Was wondering if you could…")
    /^(?:i )?was wondering if you (?:could|can|would)\b[^?]*$/i,
    /^(?:i(?:'d| would) (?:love|like) it if) you (?:could|can|would)\b[^?]*$/i,
    // "…in advance, I appreciate it" — with or without the "thanks so much" head
    // that hedge-stripping may already have eaten. Requires the appreciation
    // tail so "In advance of the meeting, prepare X." is left alone.
    /^(?:thanks? )?(?:so much |much )?in advance[\s,.]*(?:i (?:really |truly )?appreciate|thank|for (?:your|the) (?:help|time))\b[^?]*$/i,
    /^any (?:help|assistance|input|guidance|advice|feedback|thoughts) [^?]*\b(?:appreciated|welcome|helpful)\b[^?]*$/i,
    /^no (?:rush|worries|hurry|pressure)\b[^?]*$/i
  ];

  function dropPleasantries(text) {
    const chunks = splitChunks(text);
    let dropped = false;
    for (let i = 0; i < chunks.length; i += 2) {
      const seg = chunks[i];
      if (!seg || !seg.trim()) continue;
      // keep anything that carries a constraint — that's real content, and it's
      // pulled out into its own field later
      if (CONSTRAINT_TRIGGER.test(seg)) continue;
      if (PLEASANTRY_SENTENCE.some((re) => re.test(seg.trim()))) {
        chunks[i] = "";
        // drop the trailing separator too, so the next sentence starts clean
        // (a stray leading space would break the ^-anchored imperative match)
        if (chunks[i + 1] !== undefined) chunks[i + 1] = "";
        dropped = true;
      }
    }
    if (!dropped) return text;
    const result = chunks.join("");
    // never let politeness-stripping empty the whole prompt
    return result.trim() ? result : text;
  }

  const ROLE_PATTERN = /(?:^|[.\n]\s*)(?:you are|act as|please act as|imagine you'?re|imagine you are)\s+(?:an?\s+)?([^.\n]{2,80})[.\n]/i;

  const FORMAT_PATTERNS = [
    /\bin bullet points?\b/i,
    /\bas a bulleted list\b/i,
    /\bas a list\b/i,
    /\bin (?:a )?json(?: format)?\b/i,
    /\bas (?:a )?table\b/i,
    /\bin table format\b/i,
    /\bas markdown\b/i,
    /\bin markdown\b/i,
    /\bunder (\d+) words\b/i,
    /\bin no more than (\d+) words\b/i,
    /\bin (\d+) words or less\b/i,
    /\bin (?:a )?(?:single )?markdown(?: code block)?\b/i,
    /\bas (?:a )?code block\b/i
  ];

  function collapseWhitespace(text) {
    return text
      .replace(/[ \t]+$/gm, "")
      .replace(/^[ \t]+/gm, "")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/[ \t]+/g, " ")
      .replace(/\s+([,.;:!?])/g, "$1")
      .replace(/(?<=^|\n|[.!?] )[ \t]*[,;:]+\s*/g, "")
      .replace(/([.!?,;:])[,;:]+/g, "$1")
      .trim();
  }

  function capitalizeFirst(text) {
    return text.replace(/^\s*([a-z])/, (m, c) => c.toUpperCase());
  }

  function capitalizeSentences(text) {
    const chunks = splitChunks(text);
    for (let i = 0; i < chunks.length; i += 2) {
      if (chunks[i] && chunks[i].trim()) chunks[i] = capitalizeFirst(chunks[i]);
    }
    return chunks.join("");
  }

  function applyImperative(text) {
    let out = text;
    let converted = false;
    for (const re of IMPERATIVE_PATTERNS) {
      if (re.test(out)) {
        out = out.replace(re, "");
        converted = true;
      }
    }
    if (converted) {
      out = capitalizeFirst(out);
      out = out.replace(/\?\s*$/, ".");
    }
    return { text: out, converted };
  }

  function applyFiller(text) {
    let out = text;
    for (const w of FILLER_WORDS) {
      const re = new RegExp("\\b" + w.replace(/ /g, "\\s+") + "\\b,?\\s*", "gi");
      out = out.replace(re, "");
    }
    return out;
  }

  function applyWordy(text) {
    let out = text;
    for (const [re, sub] of WORDY_MAP) out = out.replace(re, sub);
    return out;
  }

  function applyHedges(text) {
    let out = text;
    for (const re of HEDGE_PATTERNS) out = out.replace(re, "");
    return out;
  }

  function applyStopwords(text) {
    return text.replace(/\b(the|a|an)\b\s*/gi, "");
  }

  function extractContext(body) {
    const m = body.match(/(^|\n)\s*(?:context|background)\s*:\s*([^\n]+)\n?/i);
    if (!m) return { body, context: null };
    return { body: body.replace(m[0], m[1]), context: m[2].trim() };
  }

  function extractRoleAndFormat(body) {
    let role = null;
    const roleMatch = body.match(ROLE_PATTERN);
    if (roleMatch) {
      role = roleMatch[1].trim();
      body = body.replace(roleMatch[0], roleMatch[0].startsWith("\n") ? "\n" : " ");
    }

    const format = [];
    for (const re of FORMAT_PATTERNS) {
      const m = body.match(re);
      if (m) {
        format.push(m[0].trim());
        body = body.replace(re, "");
      }
    }

    return { body, role, format: format.join("; ") || null };
  }

  function relocateExamples(body, store) {
    const examples = [];
    body = body.replace(TOKEN_RE, (m, idxStr) => {
      const entry = store[Number(idxStr)];
      if (entry && entry.type === "example") {
        examples.push(m);
        return "";
      }
      return m;
    });
    return { body, examples };
  }

  function compress(text, opts) {
    if (!text.trim()) return { output: "", protectedCount: 0 };

    const { text: withTokens, store } = extractProtected(text);
    let body = withTokens;

    if (opts.hedges) {
      body = dropPleasantries(body);
      const chunks = splitChunks(body);
      for (let i = 0; i < chunks.length; i += 2) {
        if (chunks[i]) chunks[i] = stripLeadingInterjection(chunks[i]);
      }
      body = chunks.join("");
    }
    if (opts.imperative) {
      const chunks = splitChunks(body);
      for (let i = 0; i < chunks.length; i += 2) {
        if (!chunks[i]) continue;
        const res = applyImperative(chunks[i]);
        chunks[i] = res.text;
        // the "?" ending an imperatived sentence lives in the *separator*
        // chunk ("? "), not chunks[i] — rewrite it to "." here
        if (res.converted && chunks[i + 1] && /^\?/.test(chunks[i + 1])) {
          chunks[i + 1] = chunks[i + 1].replace(/^\?+/, ".");
        }
      }
      body = chunks.join("");
    }
    if (opts.hedges) body = applyHedges(body);
    if (opts.wordy) body = applyWordy(body);
    if (opts.filler) body = applyFiller(body);
    if (opts.redundant) body = collapseRedundant(body);
    if (opts.stopwords) body = applyStopwords(body);
    body = capitalizeSentences(body);

    let role = null, format = null, context = null, constraints = [], examples = [];
    if (opts.structural) {
      const ctx = extractContext(body);
      body = ctx.body;
      context = ctx.context;

      const rf = extractRoleAndFormat(body);
      body = rf.body;
      role = rf.role;
      format = rf.format;

      const cons = extractConstraints(body);
      body = cons.body;
      constraints = cons.constraints;

      const ex = relocateExamples(body, store);
      body = ex.body;
      examples = ex.examples;
    }

    body = collapseWhitespace(body);

    let output;
    if (opts.structural && (role || format || context || constraints.length || examples.length)) {
      const parts = [];
      if (role) parts.push("Role: " + role);
      if (context) parts.push("Context: " + context);
      if (body.trim()) parts.push("Task: " + body);
      if (constraints.length) parts.push("Constraints: " + constraints.join("; "));
      if (examples.length) parts.push("Examples:\n" + examples.map((e) => "- " + e).join("\n"));
      if (format) parts.push("Format: " + format);
      output = parts.join("\n");
    } else {
      output = body;
    }

    output = restoreProtected(output, store);

    // if the rules chewed the prompt down to nothing meaningful (e.g. the whole
    // thing was a pleasantry), don't hand back punctuation-noise — keep the
    // original, just whitespace-normalized
    if (/\w/.test(text) && !/[A-Za-z0-9]/.test(output)) {
      output = restoreProtected(collapseWhitespace(withTokens), store);
    }

    return { output, protectedCount: store.length };
  }

  function approxTokenCount(text) {
    if (!text.trim()) return 0;
    const matches = text.match(/[\w']+|[^\s\w]/g) || [];
    let count = 0;
    for (const m of matches) {
      count += /[\w']+/.test(m) && m.length >= 7 ? 2 : 1;
    }
    return count;
  }

  function defaultRuleState() {
    const state = {};
    RULES.forEach((r) => { state[r.id] = r.default; });
    return state;
  }

  window.ProcdorCompress = { RULES, compress, approxTokenCount, defaultRuleState };
})();
