# Scientific AI-Prose Registry

Reference for `scientific-prose-auditor` and `scientific-prose-naturalizer`.

**Scope**: prose in formal scientific articles, papers, and book volumes. The
goal is *better scholarship* — specificity, depth, voice, reasoned engagement —
not detection evasion. Writing that is genuinely specific, analytical, and
grounded naturally reads as human. Do not treat any detector score as evidence
of authorship; detectors have high false-positive rates on non-native English
and formal academic prose.

## Why AI text reads as robotic (the mechanism)

Detectors and the "robotic feel" both reduce to two statistical signals:

| Signal | Meaning | AI behaviour | Human behaviour |
|--------|---------|--------------|-----------------|
| **Perplexity** | How predictable each word is | Trained to pick the most likely next token → low perplexity | Surprising, specific word choices → higher perplexity |
| **Burstiness** | Variation in sentence length/structure | Uniform lengths and grammar | Irregular rhythm: long sentence, short punch, parenthetical aside |

Every technique below disrupts one or both signals. **The load-bearing rule:
structural rewrites matter; surface word swaps do not.** Replacing a synonym
("delve" → "explore") leaves the sentence rhythm and predictability unchanged.
Reorganising paragraphs, splitting/merging sentences, reordering ideas, and
varying length change how the text flows. That is the single highest-leverage
move.

## Patterns to flag (scientific specific)

### Over-used "tell-words" — replace with precise, plain alternatives

| AI tell-word | Replace with |
|--------------|--------------|
| moreover / furthermore / additionally / consequently / thus | one meaningful transition per boundary, varied |
| delve / elevate / leverage / utilize / facilitate / streamline / foster / harness | the plain verb: use, apply, examine, exploit |
| tapestry / landscape / realm / journey / beacon / cornerstone | the concrete thing |
| "it's worth noting" / "it's important to understand" / "one might argue" | a direct statement, or drop entirely |
| "in today's landscape" / "in an era of" | name the actual context |

Do not swap one fancy word for another. Write how a researcher would actually
explain the point to a colleague.

### Formulaic scientific construction

| Pattern | Fix |
|---------|-----|
| Every paragraph = topic sentence → evidence → conclusion | vary length, structure, density |
| "In conclusion," / "To summarize," mid-text | remove or transition forward |
| Repeated sentence openings ("In X..., In Y..., In Z...") | vary openings |
| Excessive parallelism ("Not only X, but also Y. Both A and B.") | break parallel structures |
| "This is not X — it is Y" | natural rephrasing |

### Hedging, voice, and modal discipline

- **One hedge per claim.** Triple-hedging ("might potentially possibly")
  reads machine-made. Use one precise qualifier.
- **Convert nominalisation to verbs** where the abstraction is not the point:
  "the implementation of the utilisation of" → "we use".
- **Active voice for agency** — "we observe", "I argue" — unless the field or
  the claim requires passive (measurement objectivity). In scientific prose,
  passive is *conventional and allowed*; flag only when active is clearly
  clearer and the convention does not require it.
- **Modal discipline (IVP-critical):** do not collapse "can cause change" into
  "does cause change", or "could vary" into "has varied". Hedging precision is
  a *virtue* in science, not an AI marker. Only flag hedging that is either
  stacked or that weakens a claim the text actually proves.

### Description over argument

The strongest human marker in scientific writing is *describing a situation*
rather than *marching the reader to a verdict*. Flag:

- Staccato beats and prosecutorial rhythm ("X. Y. And therefore Z.")
- "Not A. Not B. C." negation-then-assertion
- Conclusions the reader is cornered into, rather than led to

Fix: report what you observe; let the reader draw the conclusion. This is the
IVP voice principle ("Describe, don't argue").

## What makes scientific writing genuinely human (positive targets)

These are the *additive* goals. Flag their absence as much as the presence of
robotic patterns.

1. **Develop a distinct authorial voice.** Interpret, question, synthesise —
   do not neutrally restate. Say *why* a result matters in its specific
   context. Voice emerges in revision, not generation.
2. **Deepen analysis beyond description.** Ask what assumptions a theory rests
   on; consider alternative viewpoints; move from *what X is* to *why X
   matters*.
3. **Ground in specificity.** Name the particular study, framework, lemma,
   historical context. Vague generality is the strongest tell. Prefer precise
   and meaningful language over broad statements.
4. **Use original examples and reasoning.** A researcher's own worked example,
   counterexample, or chain of reasoning is information the model never
   generated — the most durable marker of human authorship.
5. **Handle sources actively, not decoratively.** Each citation should carry
   the argument forward and be interpreted, not cited and abandoned.

## Domain tolerances (what NOT to flag)

Scientific writing legitimately resembles "AI style" in specific places.
Respect these exceptions — flagging them is a false positive.

| Convention | Accept in | Do not flag when |
|------------|-----------|------------------|
| Passive voice | measurement / methods / results | objectivity is the point |
| Hedging / modality | claims about uncertainty | the field requires precise qualification |
| Abstract / nominalised language | theoretical sections | abstraction is conceptually necessary |
| Formulaic structure | abstracts, summaries, statements of results | the genre requires it |
| Controlled vocabulary | entire volume | a project mandates approved terms (see project terminology) |

## Formal-environment boundary (IVP-critical)

Naturalisation applies to **expository prose only**. It **never touches**
formal environments: `#definition`, `#theorem`, `#proposition`,
`#corollary`, `#lemma`, `#proof`, `#example`, `#remark`, `#observation`,
`#key-insight`, and all display mathematics. Those stay terse, exact, and
complete. Preserve all notation, symbols, and formulas exactly. No
rhetorical questions, no narrative flourish, no "where does this lead" inside
a box. If a motivating question is needed, it belongs in the surrounding
prose — never inside the claim or proof body.

## Detector-awareness (context, not an audit target)

The shared `ProsePatternAnalyzer.java` emits a **statistical layer** that
mirrors professional detector metrics: burstiness (sentence-length coefficient
of variation and buckets), structure-type diversity, word/char entropy, and
unigram/bigram perplexity approximations. Use it strictly as a cross-reference.

- **Directionality**: human prose is "burstier" (higher sentence-length CoV,
  spread across short/medium/long buckets) and higher-entropy (more varied
  vocabulary). Uniform AI-style prose clusters lengths, repeats sentence
  shapes, and lowers vocabulary entropy.
- **Reliable discriminators** (validated to separate AI-typical from
  human-typical cleanly): Sentence-Length CoV (burstiness), Structure-Type
  Diversity, Word Entropy, Unigram Perplexity. Treat these four as the signals.
- **Informational, NOT discriminators**: Bigram Conditional Entropy and Bigram
  Perplexity track vocabulary richness and text length, not robotic uniformity;
  real formal prose often scores *higher* than synthetic AI text here. Do not
  use them to infer AI style.
- **Scientific caveat**: formal/scientific prose legitimately runs *lower*
  burstiness (measured, uniform rhythm) and lower apparent variety. A low
  burstiness score on its own is NOT an AI marker in this domain.
- **Perplexity here is an approximation** (corpus-free word unigram/bigram).
  True LLM perplexity needs a trained language model with prompt-token
  logprobs, which standard chat APIs (including DeepSeek) do not expose. Do not
  treat any number here as detector-grade.
- **Never a verdict.** A low burstiness + low structure diversity + low entropy
  + pattern findings together warrant a closer human read. They never establish
  authorship. Never ask the author to chase a score.
- **No humanizer/paraphrase tooling.** Turnitin's August 2025 update flags text
  modified by such tools, and paraphrasing alone does not change underlying
  statistical patterns. Rewrite by hand with the techniques in this registry —
  structural rewriting plus original content is the only durable fix.
- Detector scores are unreliable (2026 studies: ~61% false-positive rate on
  non-native English essays). Never cite a score as evidence of authorship;
  never ask the author to chase a percentage.
- The honest goal is better scholarship, aligned with academic integrity: the
  author's own thinking, interpretation, and specificity must be present.

## Source notes

Techniques synthesised from public 2026 guidance on natural AI-assisted
writing and on reducing detection risk in academic work (Surfer; UChicago
ePortfolio essay on AI detection in academic writing). Claims about detector
behaviour are reported as tendencies, not as a guarantee. The positive
targets (voice, depth, specificity, original examples, active sources) follow
standard academic-writing guidance and the project's own voice conventions.
