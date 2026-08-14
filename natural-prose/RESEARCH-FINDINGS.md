# Natural-Prose Research Findings

Standalone documentation of the online research behind the natural-prose
plugin's style registries. **Not loaded by any plugin** — kept for
provenance and reuse. Every source below was live-fetched and verified;
every technique is grounded in a real URL. Honest gaps are flagged
explicitly, not papered over.

Scope of this research: what makes written prose — scientific papers, and
general articles/blog posts — read as genuinely human-authored rather than
AI-generated, plus existing agents/tools that others have built for the same
purpose.

---

## 1. Scientific prose: the "teach / guide the reader" anchor and its siblings

### 1.1 The anchor (confirmed as the #1 humanizing move)

The strongest humanizing technique in scientific writing is the guidance
tone: walking the reader through *what happens when X, what changes if ABC,
how KLM influences RST* — conditional, causal, mechanism-level reasoning —
rather than only stating outcomes.

**Critical scoping** (added after user clarification): this is **not**
textbook-style exposition. It is *phrase-level reader guidance* — linking
phrases, introductions, transitions that invite the reader to learn and steer
them through a *focused* artifact. The artifact stays focused; guidance lives
in the connective tissue (openings, pivots, signposts), not in expanding the
body.

### 1.2 Four verified sibling techniques (ranked by weight)

| # | Technique | What it does | Sources |
|---|-----------|--------------|---------|
| 1 | **First-person epistemic markers** | "we find", "this suggests", "we suspect", "the data indicate" — signal a reasoning author separating data from inference | UNC Writing Center (Scientific Reports); Duke Scientific Writing Resource |
| 2 | **Staging the gap (ABT: And–But–Therefore)** | name what's known, what's not known, what the paper does about it; the BUT (missing piece / surprise) is what a human narrator adds | MIT CEE Comm Lab "Scientific Storytelling: ABT"; Mensh & Kording, Rule 6 |
| 3 | **Question-led results paragraphs** | open each paragraph with "We next tested whether…", "To verify that…", "What is the reliability of…" — reader follows the author's logic, not a conclusion hand-out | Mensh & Kording, Rule 7; Montagnes et al. (2022) |
| 4 | **Honest limitation / negative-result acknowledgment** | name what the method does *not* handle, deviations, results that don't support the story | UNC Writing Center ×2; Mensh & Kording, Rule 8; Montagnes et al. |

### 1.3 Reach-limits (verified cautions)

| Technique | Hold back because |
|-----------|-------------------|
| **Chronological false-starts / dead-ends** in the narrative | "Readers do not care about the chronological path by which you reached a result; they just care about the ultimate claim and the logic supporting it" (Mensh & Kording, Rule 3). Keep only the mild form — acknowledging what didn't work. |
| **Counterfactual / degenerate-case reasoning** as a named prose move | Real, and lives naturally inside the guidance move, but no writing-guide authority treats it as a standalone prose technique. Frame it as part of guiding the reader, not as its own citable category. |

---

## 2. General prose (blogs, articles, posts)

### 2.1 Ranked techniques

| # | Technique | What it does | Sources |
|---|-----------|--------------|---------|
| 1 | **Ground every abstraction** | concrete anchors (names, numbers, scenes): "the meeting ran 40 minutes over" not "it was inefficient"; "Stripe, Datadog and PlanetScale…" not "many companies…" — the single strongest anti-AI signal, because AI smooths specifics into generic positives | Wikipedia "Signs of AI writing"; harshaneel/humanize Lever 5 |
| 2 | **Show, don't tell (concrete scene)** | render evidence, not verdict; Palahniuk's anti-thought-verb rule: avoid "she thought he was wrong", give the legible action | Wikipedia "Show, don't tell"; Chuck Palahniuk (LitReactor); Chekhov via Wikipedia |
| 3 | **Personal voice & lived experience** | first-person narrative, anecdote, idiosyncratic memory; avoid the generic frame | Viet Thanh Nguyen (NYT, The Millions); Surfer SEO |
| 4 | **Burstiness by intent** | deliberate sentence-length variance (short punch after long build, fragment for impact); contractions in informal registers | Surfer SEO; harshaneel/humanize Lever 2 |
| 5 | **Commit to a position** | superlative/definitive statements, disagreement, naming what's wrong; AI flattens negative affect | Wikipedia "Signs of human writing"; nicojan/humanize-text-prompt (stylometry) |
| 6 | **A defined point of view** | have something specific to say; the prerequisite that makes every other technique land | Surfer SEO; Nguyen (The Millions) |

### 2.2 Cross-cutting empirical finding

**Weight structure, voice, and specificity above surface word swaps.** Word
substitution has a low ceiling (per the research synthesis in
`nicojan/humanize-text-prompt`); structural, discourse, and section-level
moves carry the most weight for current models.

### 2.3 Existing agents/tools written by others (verified live)

| Tool | Offer |
|------|-------|
| `blader/humanizer` (GitHub, ~35.6k★) | Portable `SKILL.md` agent skill (Claude Code, Codex, Cursor, opencode); detects 33 AI patterns with before/after examples; voice calibration from a user writing sample. Based on Wikipedia "Signs of AI writing". |
| `harshaneel/humanize` (GitHub) | LLM-agnostic `humanize` + `ai-check` skills; nine humanisation levers grounded in 50+ peer-reviewed papers; benchmarked against the Binoculars detector. |
| `nicojan/humanize-text-prompt` (GitHub) | Research-backed `PROMPT.md` in six layers (vocabulary, structure, tone, discourse, texture, anti-patterns) with APA citations to 2023–2025 detection studies. |
| Wikipedia "Signs of AI writing" | Canonical, continuously-updated field guide by WikiProject AI Cleanup; includes a "Signs of human writing" section (simple verbs, superlatives, hedging qualifiers). Primary source for most tools above. |
| Chuck Palahniuk, "Nuts and Bolts: 'Thought' Verbs" (LitReactor) | Operational craft rule against thought-verbs / abstraction with worked rewrites. |
| Wikipedia "Show, don't tell" | Scholarly overview (Chekhov, Hemingway, Palahniuk); confirms the technique applies to nonfiction. |
| Surfer SEO, "How to Avoid AI Detection in Writing" | Content-industry guide; perplexity/burstiness + 10 techniques (contractions, anecdotes, questions, structural vs surface rewrites). |
| Viet Thanh Nguyen, "How Writers' Workshops Can Be Hostile" (NYT) | Respected writer on voice, lived experience, and the limits of "show, don't tell". |
| Sabrina Ramonov, "Best AI Prompt to Humanize AI Writing" (Substack) | Widely-shared free prompt; banned-word list and em-dash rule. |
| niksmac, "10 Prompts Will Humanize Your AI Content" (GitHub gist) | Ten copy-paste prompts (12-year-old framing, contractions, real-life anchors). Community-grade. |

---

## 3. Transition / linking-phrase craft

### 3.1 Grounding (the functional view)

- "Transitions are not just verbal decorations that embellish your paper…
  words with particular meanings that tell the reader to think and react in a
  particular way to your ideas." — UNC Writing Center, "Transitions"
- "Transitions cannot substitute for good organization, but they can make
  your organization clearer and easier to follow." — UNC Writing Center
- "Instead of writing transitions that could connect any paragraph to any
  other paragraph, write a transition that could only connect one specific
  paragraph to another specific paragraph." — Purdue OWL

### 3.2 The six functions (final repertoire)

| Function | What it does | Example voicings (illustrative, non-exhaustive) |
|----------|--------------|-------------------------------------------------|
| Mark a pivot / groundwork done | setup over, payoff begins | "With that in place…" · "Now, the payoff:…" · "Now that we can X, we turn to Y." |
| Orient / signpost what's next | tell the reader where the argument goes | "Here is where it gets interesting." · "The upshot:…" · "Which brings us to…" |
| Invite attention / explain why | open a claim so the reader follows the reasoning | "Notice that…" · "To see why, note that…" · "The intuition:…" |
| Concede / grant the reader's objection | anticipate and grant a counterpoint before countering | "Granted,…" · "To be sure,…" · "Although this appears true, here's the real story." |
| Manage tension / surprise / counterpoint | flag a catch, a turn, a reversal | "But here's the catch." · "And yet…" · "This cuts the other way." |
| Resume / return to the main line | reconnect a detour to the thread | "Back to the main line." · "All of which is to say…" · "Where does that leave us?" |

### 3.3 Sourced rules

- **Sparsity** — "If you use too many transitions, your readers might feel
  like you are over-explaining connections that are already clear."
  (UW–Madison). Transitions are the exception, not the norm; most connections
  should be carried by idea order.
- **Vary by function, not by word** — "Resist the temptation to use a
  different word to refer to the same concept — doing so makes readers wonder
  if the second word has a slightly different meaning." (Mensh & Kording,
  Rule 4). Vary the *kind of move*, don't mechanically swap synonyms.

### 3.4 Validation of the function-based approach

The **tension** ("here's the catch") and **resume-the-thread** ("back to the
main line") functions appear in **no** canonical transition-word list (UNC,
UW–Madison both omit them). They are function-based devices those lists miss —
which is precisely why they read human rather than mechanical.

---

## 4. Honest gaps (sources not found / not cited)

1. **No authoritative nonfiction source for curiosity/suspense devices.** The
   closest verified coverage is split: UNC's reversal gloss ("Although this
   idea appears to be true, here's the real story") for the essay case, and
   Jericho Writers' fiction-suspense mechanics (controlled release of
   information) for the underlying device. A dedicated nonfiction source on
   curiosity loops / open loops is still needed.
2. **Duke scientific-writing metadiscourse handout.** Unretrievable (all
   guessed URLs returned 404). No claim is attributed to it.
3. **The specific "In this article I will…" anti-metadiscourse warning** does
   NOT appear in the fetched Mensh & Kording paper (it lives in their
   companion slide deck / preprint, which was not retrieved). Not quoted here.
4. **"Don't repeat the same transition word back-to-back."** No authoritative
   source states this rule literally. The closest verified guidance is
   UW–Madison's "use sparingly / over-explaining / patronizing" — and Mensh &
   Kording Rule 4 actively pushes back on mechanical word-variation. The
   defensible rule is "vary by function and avoid piling on," NOT "never
   repeat a word."
5. **"Invite attention" function has no clean canonical equivalent.** Only the
   Emphasis / Importance / Intensification categories partially cover it
   ("indeed", "in fact", "most importantly").

---

## 5. How to reuse this research later

- **To update the plugin registries** (the living documents the agents
  actually load):
  - `references/natural-prose.md` — general-prose positive targets + mechanical
    anti-tell pass + existing-tools table.
  - `references/scientific-ai-prose.md` — scientific positive targets +
    reach-limits.
  - `references/reader-guidance-phrases.md` — the six transition functions +
    rules (this file is the consolidation of section 3).
- **To audit any existing or third-party tool against these findings**: use
  section 2.3's tool table as a checklist and section 4's gaps as known blind
  spots to verify before trusting a source.
- **To extend into a new prose domain**: the templates are the function-based
  repertoire (section 3.2), the positive-target list (sections 1.2 and 2.1),
  and the honest-gap discipline (section 4) — reuse the structure, verify the
  sources anew, and always flag what you could not verify.

## Key sources (master list)

- UNC Writing Center: "Transitions", "Transitions (ESL)", "Scientific
  Reports", "Scientific Writing" — writingcenter.unc.edu
- Purdue OWL: "Writing Transitions" — owl.purdue.edu
- UW–Madison Writing Center: "Using Transitional Words and Phrases",
  "Connecting Ideas Through Transitions" — writing.wisc.edu
- Mensh & Kording (2017), *Ten simple rules for structuring papers*, PLOS
  Comput Biol — journals.plos.org/ploscompbiol/article?id=10.1371/journal.pcbi.1005619
- MIT CEE Communication Lab: "Scientific Storytelling: The ABT Method" —
  mitcommlab.mit.edu
- Montagnes, Montagnes & Yang (2022), *Finding your scientific story by
  writing backwards* — pmc.ncbi.nlm.nih.gov (PMC10077155)
- Wikipedia: "Show, don't tell"; "Signs of AI writing" — en.wikipedia.org
- Chuck Palahniuk, "Nuts and Bolts: 'Thought' Verbs" — litreactor.com
- Viet Thanh Nguyen: NYT op-ed; The Millions interview
- Surfer SEO: "How to Avoid AI Detection in Writing"
- Grammarly: "How to Use Transition Sentences for Smoother Writing"
- Jericho Writers: "Suspense" craft article
- GitHub: `blader/humanizer`, `harshaneel/humanize`, `nicojan/humanize-text-prompt`
