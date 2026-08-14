# Natural-Prose Core Registry

Reference for `natural-prose-auditor` and `natural-prose-naturalizer` in
**general** mode. For the scientific specialization, load
`scientific-ai-prose.md` instead (or in addition, for the positive targets it
shares).

**Goal**: turn AI-typical writing into natural human prose for any text —
reports, docs, prose, emails, notes, articles. The aim is *better writing*
(specific, varied, engaged), not detection evasion. Do not treat any detector
score as evidence of authorship.

## Why AI text reads as robotic (the mechanism)

Both the "robotic feel" and detector signals reduce to two statistics:

| Signal | Meaning | AI behaviour | Human behaviour |
|--------|---------|--------------|-----------------|
| **Perplexity** | How predictable each word is | Picks the most likely next token → low perplexity | Surprising, specific choices → higher perplexity |
| **Burstiness** | Variation in sentence length/structure | Uniform lengths and grammar | Irregular rhythm: long sentence, short punch, aside |

Every technique below disrupts one or both. **Load-bearing rule: structural
rewrites matter; surface word swaps do not.** Replacing a synonym leaves the
rhythm and predictability unchanged. Reorganise paragraphs, split/merge
sentences, reorder ideas, vary length. That is the single highest-leverage
move.

## Patterns to flag (generic)

### Over-used "tell-words" — replace with plain, precise alternatives

| AI tell-word | Replace with |
|--------------|--------------|
| moreover / furthermore / additionally / consequently / thus | one meaningful transition per boundary, varied |
| delve / elevate / leverage / utilize / facilitate / streamline / foster / harness | the plain verb: use, apply, examine, exploit |
| tapestry / landscape / realm / journey / beacon / cornerstone | the concrete thing |
| "it's worth noting" / "it's important to understand" / "one might argue" | a direct statement, or drop |
| "in today's landscape" / "in an era of" | name the actual context |

Do not swap one fancy word for another. Write how a person would actually
explain the point to a colleague.

### Formulaic construction

| Pattern | Fix |
|---------|-----|
| Every paragraph = topic → evidence → conclusion | vary length, structure, density |
| "In conclusion," / "To summarize," mid-text | remove or transition forward |
| Repeated sentence openings ("In X..., In Y..., In Z...") | vary openings |
| Excessive parallelism ("Not only X, but also Y. Both A and B.") | break parallel structures |
| "This is not X — it is Y" | natural rephrasing |
| Itemised lists for exposition (bold headers, bullets) | flowing prose, unless a genuine list |

### Voice, rhythm, and precision

- **One hedge per claim.** Triple-hedging ("might potentially possibly")
  reads machine-made. Use one precise qualifier.
- **Convert nominalisation to verbs** where abstraction is not the point.
- **Prefer active voice** for agency ("we observed", "I found"), unless the
  genre or claim requires passive.
- **Vary sentence length** deliberately: short for impact, long for
  complexity.
- **Read-aloud test.** If a sentence feels mechanical or reads like a slide
  deck, rewrite it.

### Description over argument

The strongest human marker is *describing a situation* rather than marching
the reader to a verdict. Flag:

- Staccato beats and prosecutorial rhythm ("X. Y. And therefore Z.")
- "Not A. Not B. C." negation-then-assertion
- Conclusions the reader is cornered into rather than led to

Fix: report what you observe; let the reader draw the conclusion.

## What makes prose genuinely human (positive targets)

Flag the *absence* of these as much as the presence of robotic patterns.

1. **A distinct voice.** Interpret, question, synthesise — do not neutrally
   restate. Say *why* something matters in its specific context.
2. **Analysis beyond description.** Ask what assumptions underlie the subject;
   consider alternative viewpoints.
3. **Specificity.** Name the concrete thing, instance, or detail. Vague
   generality is the strongest tell.
4. **Original examples and reasoning.** A writer's own concrete example or
   chain of reasoning is information the model never generated.
5. **Human texture.** Occasional imperfection and rhythm variation; perfect
   uniformity is the giveaway.

## Domain tolerances (what NOT to flag)

| Convention | Accept in | Do not flag when |
|------------|-----------|------------------|
| Passive voice | measurement / methods / formal results | objectivity or the genre requires it |
| Hedging | claims about uncertainty | precise qualification is required |
| Abstract language | theoretical sections | abstraction is conceptually necessary |
| Formulaic structure | abstracts, summaries, specs | the genre requires it |
| Controlled vocabulary | technical volumes | the project mandates approved terms |
| Teaching tone | tutorials, educational material | scaffolding is the intent |

**General mode** has the loosest tolerances: the domain conventions table in
`style-auditor` (general-skills) applies. Only flag a pattern when it harms
clarity or naturalness in context.

## Source notes

Techniques synthesised from public 2026 guidance on natural AI-assisted
writing and on reducing detection risk. Detector claims are reported as
tendencies, not guarantees. The positive targets follow standard writing
guidance. For the scientific subset, see `scientific-ai-prose.md`.
