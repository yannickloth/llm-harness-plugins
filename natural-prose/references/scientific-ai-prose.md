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
6. **Guide the reader, don't just report — and don't write a textbook.** The
   goal is *reader guidance at the phrase level*, not full exposition. Invite
   the reader to learn something and steer them through the artifact via the
   linking phrases, introductions, and transitions that orient. See
   `reader-guidance-phrases.md` for a non-exhaustive repertoire of voicings
   ("to see why, note that…", "with that in place, …", "here's the catch").
   In a *focused* paper or post you do **not** open out into a lecture — the
   conditional/causal/mechanism framing ("what happens when X", "how KLM
   influences RST") is used *in passing* to help a claim land, never as a
   textbook walk-through. The artifact stays focused; the guidance is light
   touch, in the connective tissue, not the body.
7. **Mark the interpretive stance, don't hide behind the passive.** Prefer
   first-person epistemic verbs — "we find", "this suggests", "we suspect",
   "the data indicate" — over pure neutral restatement. These signal a
   reasoning author actively separating data from inference, the closest
   sibling to reader-guidance. (Active-voice *agency* stays
   governed by the passive-voice tolerances below: objectivity sections keep
   the passive when the genre demands it; the epistemic marker is about
   *stance*, not voice.)
8. **Stage the gap.** Name what is known, what is not known, and what the
   paper does about it — the "And / But / Therefore" engine. The *BUT* (the
   missing piece, the surprise, what prior work overlooked) is what a human
   narrator adds that a data-dump omits. A gap statement sets the reader's
   expectation for what the paper delivers.
9. **Open results paragraphs with the question they answer.** "To verify that
   there are no artifacts…", "We next tested whether…", "What is the
   test-retest reliability…". Let the reader follow the author's chain of
   logic rather than handing over conclusions. This is the paragraph-level
   form of "to see why, note that…".
10. **Acknowledge limitations, anomalies, and negative results.** Name what the
    method does *not* handle, deviations from expectation, and results that
    do not support the story (or park them in supplementary material). Honest
    uncertainty — "your readers will doubt your authority if you overlook a
    key piece of data that doesn't square with your perspective" — signals a
    careful human anticipating doubt, not an omniscient machine. Qualify
    conclusions where the data cannot support them ("supported/indicated/
    suggested" over "proves").

## Reach limits (what NOT to over-do)

Two candidate techniques are tempting but should be held back, per the
sourced guidance and the registry's own discipline:

| Technique | Hold back because |
|-----------|-------------------|
| Chronological false-starts / dead-ends in the narrative | Readers "do not care about the chronological path by which you reached a result; they just care about the ultimate claim and the logic supporting it" (Mensh & Kording, Rule 3). Keep its mild, defensible form — acknowledging what did *not* work or anomalous results (#10) — not a tour of failed attempts. |
| Counterfactual / degenerate-case reasoning as a named *prose* move | It is real, and lives naturally inside the reader-guidance phrasing (#6: "the degenerate case, the parameter sweep"), but no writing-guide authority treats it as a standalone prose technique. Frame it as part of guiding the reader through a claim, not as its own citable category. |

## Didactic parallelism vs. rote parallelism

A deliberate phrase-level contrast (a "what happens when X… what changes if
ABC…" pair) invites the reader to hold two cases together — good guidance.
Keep it from decaying into the formulaic repetition the registry already
flags:

| Didactic (positive) | Rote (flag) |
|---------------------|-------------|
| "What happens when X: the invariant collapses. What changes if ABC is instead required: the proof goes through." | "What happens when X, what happens when Y, what happens when Z." — unvarying skeleton, filler items |
| Vary the *grammar* of the contrast (conditional / question / clause / modal) even when the *concept* is parallel | Identical opening phrase repeated in lockstep; only the subject noun changes |
| Each branch adds a distinct causal claim or mechanism | Branches restate the same claim with swapped labels |
| Parallelism is the point of the sentence (a deliberate either/or, a case split) | Parallelism is accidental rhythm from list-shaped filler |

A phrase-level contrast is a scaffold for *reasoning*; it earns its place when
each arm carries new content. When the arms only re-skin one idea, the variation
is cosmetic and reads mechanical — treat it as the formulaic-parallelism pattern
above.

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
ePortfolio essay on AI detection in academic writing). The positive targets
for *human scientific voice* (#7–#10, and the reach limits) follow verified
writing-guide sources: UNC Writing Center ("Scientific Reports", "Scientific
Writing"); Mensh & Kording, *Ten simple rules for structuring papers* (PLOS
Comput Biol 2017); MIT CEE Communication Lab, "Scientific Storytelling: The
ABT Method"; Montagnes, Montagnes & Yang, *Finding your scientific story by
writing backwards* (2022). Counterfactual/degenerate-case reasoning is held
as part of the teaching tone (#6) because no writing-guide authority treats it
as a standalone prose category. Claims about detector behaviour are reported
as tendencies, not as a guarantee. The positive targets follow standard
academic-writing guidance and the project's own voice conventions.
