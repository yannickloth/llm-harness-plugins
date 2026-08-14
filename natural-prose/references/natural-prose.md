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
6. **Ground every abstraction.** Require a concrete anchor — name, number,
   scene, tool, date — wherever a general claim appears. "The meeting ran 40
   minutes over" not "the meeting was inefficient"; "Stripe, Datadog and
   PlanetScale all pulled this off the same way" not "many companies have
   adopted this." Specifics are the single strongest anti-AI signal because
   AI statistically smooths them into generic positives.
7. **Show, don't tell (concrete scene).** Render the evidence, not the
   verdict. Operationally, this is Palahniuk's anti-thought-verb rule: avoid
   naming internal states ("she thought he was wrong", "he wanted out") and
   instead give the action that makes the state legible. In nonfiction this is
   the concrete anecdote that carries the claim.
8. **Personal voice and lived experience.** First-person narrative, a concrete
   memory, an idiosyncratic opinion anchor the text in one actual person.
   Avoid the generic frame (the "every immigrant story" shape); the specific,
   committed telling is the human one.
9. **Burstiness by intent.** Vary sentence length deliberately — a short punch
   after a long build, a fragment for impact. In informal registers, use
   contractions and colloquial rhythm. Uniform sentence length is the most
   measurable robotic signal.
10. **Commit to a position.** Make the call: superlative or definitive
    statements, disagreement, naming what is wrong. AI regresses to the mean
    and flattens negative affect; humans say "is the only", "was the first",
    "this is broken". Stance, not summary.
11. **A defined point of view.** Have something specific to say; a real angle
    or insight, not a restatement. This is the prerequisite that makes every
    other technique land.
12. **Guide the reader through the artifact (and stay focused).** The goal is
    phrase-level reader guidance, not full exposition: linking phrases,
    introductions, and transitions that invite the reader to learn and steer
    them along. See `reader-guidance-phrases.md` for a non-exhaustive
    repertoire of voicings. Use them *in passing* to help a claim land —
    never open out into a lecture. The article or post stays focused on its
    one point; the guidance lives in the connective tissue (openings, pivots,
    signposts), not in expanding the body.

## Mechanical enforcement (the anti-tell pass)

Weight **structure, voice, and specificity** above surface word swaps — the
empirical finding across detection research. Still, run a final pass for the
high-frequency tells AI leans on:

- Em dashes used for mid-sentence asides ("like this — like this —") — the
  single strongest AI punctuation tell (3–5× human rate). Hard limit ~one per
  300 words; prefer periods, colons, or parentheses.
- "Not just X but Y", "in today's era", rule-of-three constructions,
  generic concluding summaries, "it's worth noting".
- AI vocabulary: delve, tapestry, pivotal, elevate, foster, harness,
  landscape, journey.

This is an *audit layer*, not a naturalisation goal: catching leftover tells
after the substance techniques (6–11) are applied.

## Existing agents and tools (research cross-reference)

Others have built agents and skills for exactly this. Consult these when
building or tuning the naturalizer; they mirror and cross-validate the targets
above (all verified live):

| Tool | What it offers |
|------|----------------|
| `blader/humanizer` (GitHub) | Portable `SKILL.md` agent skill (Claude Code, Codex, Cursor, opencode); detects 33 AI patterns with before/after examples; voice calibration from a user writing sample. Based on Wikipedia "Signs of AI writing". |
| `harshaneel/humanize` (GitHub) | LLM-agnostic `humanize` + `ai-check` skills; nine humanisation levers grounded in 50+ peer-reviewed papers; benchmarked against the Binoculars detector. |
| `nicojan/humanize-text-prompt` (GitHub) | Research-backed `PROMPT.md` in six layers (vocabulary, structure, tone, discourse, texture, anti-patterns) with APA citations to 2023–2025 detection studies. |
| Wikipedia "Signs of AI writing" | Canonical, continuously-updated field guide by WikiProject AI Cleanup; includes a "Signs of human writing" section (simple verbs, superlatives, hedging qualifiers). Primary source for most tools above. |
| Chuck Palahniuk, "Nuts and Bolts: 'Thought' Verbs" (LitReactor) | Operational craft rule against thought-verbs/abstraction with worked rewrites. |
| Wikipedia "Show, don't tell" | Scholarly overview (Chekhov, Hemingway, Palahniuk); confirms the technique applies to nonfiction. |
| Surfer SEO, "How to Avoid AI Detection in Writing" | Content-industry guide covering perplexity/burstiness and 10 techniques (contractions, anecdotes, questions, structural vs surface rewrites). |
| Viet Thanh Nguyen, NYT "How Writers' Workshops Can Be Hostile" | Respected writer on voice, lived experience, and the limits of "show, don't tell". |

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
writing and on reducing detection risk, and from verified craft sources:
Wikipedia "Show, don't tell" and "Signs of AI writing"; Chuck Palahniuk,
"Nuts and Bolts: 'Thought' Verbs" (LitReactor); Viet Thanh Nguyen (NYT, The
Millions); Surfer SEO's AI-detection guide; and the open-source humaniser
agents `blader/humanizer`, `harshaneel/humanize`, and
`nicojan/humanize-text-prompt` (which summarise 50+ peer-reviewed detection
studies). Detector claims are reported as tendencies, not guarantees. The
empirical weight favouring structure, voice, and specificity over surface word
swaps follows those research-backed sources. For the scientific subset, see
`scientific-ai-prose.md`.
