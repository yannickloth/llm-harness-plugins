# Change-driver registry — `shared/` v2 registry helpers

Grain: **function** (exported functions and module-level constants). Scope:
`shared/v2-skills.ts`, `shared/v2-commands.ts`, `shared/model-ref.ts`,
`shared/agents.ts`.
Status: **PROVISIONAL** — Gate A returned UNSOUND on the first draft; the criticals
are corrected and the element set has since changed (γ₆ added, `model-ref.ts`
extracted). A re-audit is required.

Produced by an IVP steps 1–3 pass. Every driver below is an amendment unit of a
governing artifact that is **external** to this repository.

## Governing artifacts

| ID | Artifact | Amendment unit |
|---|---|---|
| A1 | OpenCode skill registry (`ctx.skill.transform`) | the editor surface: `add`, `update`, `get`, `list`, `remove`; the `Skill.Info` record shape |
| A1f | OpenCode skill **file** format (`<dir>/<name>/SKILL.md`) | the frontmatter keys and the directory convention |
| A2 | OpenCode agent registry (`ctx.agent.transform`) | the editor surface: `update`-only creation; the `Agent.Info` record shape; permission-verb mapping |
| A3 | OpenCode command registry (`ctx.command.transform`) | the editor surface: `add`-only; the `CommandV2Info` record shape |
| A5 | Opencode V1 config/hook contract | the `config` hook, `skills.paths`, the V1 `agent` map, V1 permission verbs |
| A6 | The ModelRef format (`provider/model[#variant]`) | the grammar itself — shared by the agent and command record shapes |

A4 (the consumer-side `opencode.json` plugin array) is **removed from `C`**: no
element in these three files reads or writes it, so it governs nothing in scope.
It is a real condition of the wider system — the entrypoint's load-order
constraints live with the plugin, not here — but it is not a driver of this
element set.

A1 and A1f are **different amendment units**: the editor record and the on-disk
`SKILL.md` format change independently (a `Skill.Info` field can be added without
touching the file format, and the file format can gain a key the editor ignores).
The initial registry folded them into one `γ₁`; the audit caught that.

## Drivers

| γ | Anchor | Condition: when this artifact changes, the element must change |
|---|---|---|
| γ₁ | A1 | The skill **editor** or `Skill.Info` changes (method renamed, field added, `directory` source replaces per-skill `add`) |
| γ₁f | A1f | The `SKILL.md` frontmatter keys or the `<dir>/<name>/SKILL.md` directory convention change |
| γ₂ | A2 | The agent editor or `Agent.Info` changes, incl. the V2 permission action names |
| γ₃ | A3 | The command editor or `CommandV2Info` changes |
| γ₅ | A5 | The V1 config/hook contract changes (`skills.paths`, V1 `agent` map, V1 permission verbs) |
| γ₆ | A6 | The `provider/model[#variant]` grammar changes — one unit, shared by both registries |

Note γ₂ ≠ γ₅: the V2 agent editor and the V1 config hook are amended by
different units of different artifacts. They are not one driver even though both
concern agents.

## Assignment Γ(e)

| # | Element | `file:line` | Γ(e) | Form |
|---|---|---|---|---|
| 1 | `parseFrontmatter` | `v2-skills.ts:35` | {γ₁f} | single |
| 2 | `readSkillRecords` | `v2-skills.ts:51` | {γ₁f} | single — enumerates the SKILL.md convention, no editor |
| 3 | `registerSkillRecords` | `v2-skills.ts:73` | {γ₁} | single — pushes records into the editor, no file access |
| 4 | `registerSkillDir` | `v2-skills.ts:94` | {γ₁,γ₁f} | **composition** — calls 2 then 3 (see note) |
| 5 | `MODEL_REF` | `model-ref.ts:22` | {γ₆} | single — the grammar regex; follower of `parseModelRef` |
| 6 | `parseModelRef` | `model-ref.ts:25` | {γ₆} | single |
| 7 | `isModelRef` | `model-ref.ts:33` | {γ₆} | single |
| 8 | `stripQuotes (commands)` | `v2-commands.ts:63` | {γ₃} | **follower** of `parseCommand` |
| 9 | `parseCommand` | `v2-commands.ts:72` | {γ₃,γ₆} | composite — validates a model ref while parsing a command record |
| 10 | `readCommandRecords` | `v2-commands.ts:97` | {γ₃} | single |
| 11 | `registerCommandDirV2` | `v2-commands.ts:123` | {γ₃,γ₆} | composite — the model ref becomes `CommandV2Info.model` here |
| 12 | `MODES` | `agents.ts:64` | {γ₂} | single — the mode enum, validated at `agents.ts:115` |
| 13 | `V2_ACTION` | `agents.ts:53` | {γ₂,γ₅} | **irreducible composite** — the V1→V2 verb bridge |
| 14 | `V1_PERMISSION` | `agents.ts:62` | {γ₅} | single |
| 15 | `stripQuotes (agents)` | `agents.ts:66` | {γ₂,γ₅} | follower of `parseAgent` |
| 16 | `asEffect` | `agents.ts:74` | {γ₂,γ₅} | follower of `parseAgent` |
| 17 | `parseAgent` | `agents.ts:83` | {γ₂,γ₅,γ₆} | **irreducible composite** |
| 18 | `readAgentRecords` | `agents.ts:142` | {γ₂} | single — delegates to `parseAgent`, holds no V1 logic |
| 19 | `registerAgentDirV2` | `agents.ts:172` | {γ₂,γ₆} | composite — the model ref becomes `Agent.Info.model` here |
| 20 | `registerAgentDirV1` | `agents.ts:213` | {γ₅} | single |

**Element 4 is a composition, not a composite.** After the audit's IVP-2 finding,
`registerSkillDir` no longer fuses the two phases: it calls `readSkillRecords` then
`registerSkillRecords`. It carries the union of its callees' sets by construction
and is decomposable by definition. It is retained because plugins call it, but its
form is *composition* (a derived union), not *irreducible composite*. It is not a
driver-bearing locus of its own.

## The follower rule

A non-exported helper whose only caller is **one** element, and whose own change
requirement is derived from that caller's, is recorded with a **derived** Γ rather
than an independently-argued one. It is not a third element form: §5 admits only
single-driver and irreducibly composite. "Follower" annotates *how the set was
obtained*, not a form.

Applied, and only applied, to:

| Element | Caller(s) | Γ |
|---|---|---|
| 7 `stripQuotes` (commands) | `parseCommand` only (`v2-commands.ts:83`) | derived `{γ₃}` |
| 14 `stripQuotes` (agents) | `parseAgent` (`agents.ts:105`) and `asEffect` (`agents.ts:75`) | derived `{γ₂,γ₅}` |
| 15 `asEffect` | `parseAgent` only (`agents.ts:96`) | derived `{γ₂,γ₅}` |

Element 14 has two callers, but both sit inside `parseAgent`'s closure, so its
requirement is still derived from one element. Its Γ matches its callers' because
both callers carry `{γ₂,γ₅}`.

**Not followers** (recorded so the distinction is unambiguous):

- **11 `MODES`** — the mode enum `{subagent, primary, all}`. A rename changes the
  constant without changing `parseAgent`'s `MODES.has(..) ?? "subagent"` check, so
  it has an **independent** γ₂ dependency. Single-driver.
- **9 `readCommandRecords`** — exported, lists files independently of
  `parseCommand`. Independent γ₃. Single-driver.

A follower's placement follows its caller only when the derived set equals the
caller's. Element 7 (`{γ₃}`) is in M₅ while `parseCommand` (element 8, `{γ₃,γ₆}`)
is in M₆ — IVP-4-correct, because the helper genuinely has a narrower set.

`readCommandRecords` is exported and lists files independently of
`parseCommand`, so it stands as its own element rather than folding into it; its
γ₃ is not derived, and it is not a follower in the strict sense.

## ModelRef — γ₆, resolved by extraction

The ModelRef grammar (`provider/model[#variant]`) is used by **both** the agent
registry (`Agent.Info.model`) and the command registry
(`CommandV2Info.model`). The first revision of this registry folded it into γ₂ and
γ₃ and flagged the question as open.

**Resolved: it is one amendment unit, so it is one driver.** The evidence is that
the format is a property of the reference itself, not of either registry: a
change to it (`provider:model`, a new separator, a variant syntax) requires the
same edit in every consumer regardless of which registry the consumer serves. That
is the definition of one amendment unit.

The code was changed to match the model rather than the other way round:

- `shared/model-ref.ts` now holds the single definition
  (`parseModelRef`, `isModelRef`, `ModelRef`).
- The three former copies are gone: `agents.ts` (two inline regexes) and
  `v2-commands.ts` (one) now import it.
- `shared/model-ref.test.ts` fails if the grammar is re-inlined anywhere else in
  `shared/`.

| γ | Anchor | Condition |
|---|---|---|
| γ₆ | A6 — the ModelRef format | The `provider/model[#variant]` grammar changes |

Reassignment that follows: `parseModelRef` is `{γ₆}`, not `{γ₃}`. The agent-side
sites (`agents.ts` model validation and `Agent.Info.model` construction) change
from `{γ₂}` to `{γ₂,γ₆}` — where element 13 (`parseAgent`) is composite either
way, so its set gains a member: `{γ₂,γ₅,γ₆}`.

**This is a driver change the audit could not have found**, because the three
copies were a code fact the registry described but did not treat as a modelling
constraint. Recorded here as the resolution; a full re-audit at the new element
set is still required.

## Γ-equivalence classes → modules

| Class | Γ | Elements | Module |
|---|---|---|---|
| M₁ | {γ₁} | 3 | `v2-skills.ts` |
| M₂ | {γ₁,γ₁f} | 4 | `v2-skills.ts` |
| M₃ | {γ₁f} | 1, 2 | `v2-skills.ts` |
| M₄ | {γ₂} | 12, 18 | `agents.ts` |
| M₅ | {γ₂,γ₅} | 13, 15, 16 | `agents.ts` |
| M₆ | {γ₂,γ₅,γ₆} | 17 | `agents.ts` |
| M₇ | {γ₂,γ₆} | 19 | `agents.ts` |
| M₈ | {γ₃} | 8, 10 | `v2-commands.ts` |
| M₉ | {γ₃,γ₆} | 9, 11 | `v2-commands.ts` |
| M₁₀ | {γ₅} | 14, 20 | `agents.ts` |
| M₁₁ | {γ₆} | 5, 6, 7 | `model-ref.ts` — **complete** |

`P_Γ` has **11** classes over 20 elements. The current tree has **4** files.

Driver coverage (`|{e : γ ∈ Γ(e)}|`): γ₁ → 2, γ₁f → 3, γ₂ → 7, γ₃ → 4, γ₅ → 6,
γ₆ → 7. Every driver governs at least one element.

**File grain** — each file's Γ is the union of its elements' sets:

| Module | Γ | Elements |
|---|---|---|
| `v2-skills.ts` | {γ₁,γ₁f} | 4 |
| `model-ref.ts` | {γ₆} | 3 |
| `v2-commands.ts` | {γ₃,γ₆} | 4 |
| `agents.ts` | {γ₂,γ₅,γ₆} | 9 |

Four distinct sets over four files: pure at file grain, nothing scattered.

## Findings (step 4, as-is vs `P_Γ`)

- **`v2-skills.ts`** — three classes (M₁, M₂, M₃). M₃ nests inside M₂ (sound: the
  file format preconditions the record, and element 4 is a composition). M₁ is a
  sibling of M₂: editor and format change independently.
- **`agents.ts`, function grain** — five classes (M₄, M₅, M₆, M₇, M₁₀) in one
  container, **none nesting**. All five are siblings. The real finding at this
  grain: independent concerns sharing a file, not a hierarchy.
- **`v2-commands.ts`, function grain** — two classes (M₈, M₉), neither nesting.
- **`model-ref.ts`** — one class (M₁₁), complete.
- **File grain** — `Γ(agents.ts) = {γ₂,γ₅,γ₆}`, `Γ(v2-commands.ts) = {γ₃,γ₆}`, both
  pure; no violation, nothing to separate. Do not use file-grain purity to excuse
  the function-grain finding; they are different element sets.
- **IVP-4 (scattered classes)** — none. Every class sits wholly inside one file.
- **IVP-1/IVP-2** — no `|Γ(e)| = 0`. Irreducibly composite: element 13 (`V2_ACTION`)
  and element 17 (`parseAgent`), both verified by the audits. Element 4 is a
  **composition**, not a composite (second audit C2): it was decomposed into 2 and 3.

## Nesting: subset is necessary, causality decides

`Γ(P) ⊊ Γ(C)` alone does **not** establish nesting. It is a set relation that a
stale or coincidental overlap can satisfy. Nesting asserts **three** things:

1. `Γ(P) ⊊ Γ(C)` — a strict subset (necessary);
2. `P`'s driver is a **causal precondition** of `C`'s existence;
3. the child `C` is decomposable — nesting asserts that its extra drivers are
   separable additions (§7 rationale guard).

**Thirteen pairs** satisfy the strict-subset test. **One** passes all three.

| Parent | Child | Verdict |
|---|---|---|
| M₃ `{γ₁f}` | M₂ `{γ₁,γ₁f}` | **NEST.** No `SKILL.md` format → no record exists to add; the format preconditions every emission. Element 4 is a *composition* (`readSkillRecords` then `registerSkillRecords`), so condition 3 holds — decomposable by construction. |
| M₁ `{γ₁}` | M₂ | **sibling.** Editor from format: the record shape does not precondition the on-disk convention. |
| M₁₁ `{γ₆}` | M₆, M₇, M₉ | **sibling.** ModelRef is a shared *vocabulary*. It does not cause a parser to exist. |
| M₈ `{γ₃}` | M₉ | **sibling.** The command editor does not precondition ModelRef; the parser consumes it. |
| M₄ `{γ₂}` | M₅, M₆, M₇ | **sibling.** The V2 agent editor is the *sink* for the V1 verbs and the model ref, not their cause. |
| M₅ `{γ₂,γ₅}` | M₆ | **sibling.** γ₆ is an extra vocabulary, not an extension of the V1 bridge. |
| M₇ `{γ₂,γ₆}` | M₆ | **sibling.** Same, on the γ₅ axis. |
| M₁₀ `{γ₅}` | M₅, M₆ | **sibling.** `V1_PERMISSION` is consumed only inside `registerAgentDirV1`; the V1 verb schema stands alone. |

**Every subset pair inside `agents.ts` and `v2-commands.ts` is coincidental.** They
hold because those files serve two registries sharing two vocabularies (the V1
permission verbs, the ModelRef format). A subset is not a concern hierarchy — it
is what you get when two independent concerns consume the same grammar.

History: an early revision called the `agents.ts` pairs "the nesting relation of
§7" (subset reasoning wearing a nesting claim). A second revision then over-
corrected to "one nest" while the child was still an irreducible composite, which
fails condition 3. This revision fixes the element, then the claim.

## Grain note

At **file grain** each file is one module with the union of its elements' sets.
All four are pure: no element carries a driver outside its file's set. File-grain
purity needs no nesting claim — a file is one module with one driver set.

At **function grain** the partition is eleven classes. `agents.ts` holds five of
them (M₄, M₅, M₆, M₇, M₁₀) and **none nests**; they are siblings sharing a
container. Separateness is therefore not merely a placement preference: without
nesting, they are independent concerns that happen to live in one file.

`v2-skills.ts` is the one file with a sound nesting (M₃ in M₂).

Which grain governs is a modelling decision — at what grain do the change
decisions actually occur — and both partitions are valid. They yield different
verdicts; state the grain with every claim.

## Counterfactual tests (per edge, abridged)

Each test rewrites one artifact's amendment unit and asks whether the element's
requirement to change disappears. Element numbers refer to the current table (19
elements).

- **A3 (command editor) removed** → 7, 9, 10 lose their *editor* requirement; 8
  also loses its record-emission half but keeps γ₆ via its model validation. 1–6,
  11–19 unaffected → γ₃ isolated.
- **A2 (agent editor) rewritten** → 11, 12, 14, 15, 16, 17, 18 change. Element 16
  also carries the V1 verb map and the ModelRef ref, so the A2-only test does not
  remove its whole requirement → 16 is composite. 18 keeps γ₆ → composite.
- **A5 (V1 path) removed** → 13 and 19 disappear; 12, 14, 15, 16 drop to {γ₂,γ₆}.
  The A5-only test removes **nothing** from 17, which is why 17 is `{γ₂}`, not
  composite. *(This corrected the first audit's finding: `readAgentRecords` was
  wrongly `{γ₂,γ₅}`.)*
- **A1 (skill editor) rewritten** → 3 and 4 change; 1 and 2 do not → γ₁ and γ₁f
  are distinct units. *(This corrected the first audit's finding:
  `parseFrontmatter` was wrongly `{γ₁}`.)*
- **A1f (SKILL.md format) rewritten** → 1, 2 and 4 change → 1 and 2 are `{γ₁f}`,
  4 is the composition.
- **A6 (ModelRef grammar) rewritten** → 5, 6, 8, 10, 16, 18 change. Element 10
  (command registration) was missing γ₆ until the second audit; it converts a ref
  at `v2-commands.ts:131` exactly as element 18 does at `agents.ts:186`.
- **A4 (`opencode.json`) rewritten** → no element changes → γ₄ is not a driver of
  this set (first audit's finding 1).

Pass condition: every element ends with `|Γ(e)| ≥ 1`, and each driver is removed
by exactly one artifact's amendment.

## Revisit conditions

- **A3 gains `update`/`get`** (the docs already describe an `add`+`execute` shape):
  re-run elements 8–11. If the command editor converges with the agent editor,
  γ₂ and γ₃ may collapse into one amendment unit.
- **The ModelRef grammar changes** → γ₆ fires on 5, 6, 7, 9, 11, 17, 19. Resolved
  as one unit and extracted to `model-ref.ts`; keep it extracted.
- **The V1 path is retired** → γ₅ disappears. Elements 14 and 20 lose their whole
  set and leave `E`; 13, 15, 16, 17 drop a member. Most likely collapse: M₁₀ has
  no members.
- **The skill file format and editor record co-vary** → γ₁ and γ₁f collapse, and
  M₁/M₂/M₃ merge (removing the only sound nesting).

## Unanchored candidates (not drivers)

Churn, file co-location, and "these are all v2 helpers" were rejected as proxies
(§4). `shared/` placement is not a driver.

## Audit record

**Gate A run 1** — `driver-assignment-auditor`: **UNSOUND** (4 critical,
3 warnings). Fixed: γ₄ removed (governed no element), `γ₁f` split from γ₁,
`readAgentRecords` re-grounded to `{γ₂}`, follower rule stated uniformly.

**Revision 2** — the nesting rule gained its **causal-existence condition**, which
the pack had omitted. Every `agents.ts` pair moved from "nested" to **sibling**.
ModelRef resolved as one unit (γ₆) and extracted to `model-ref.ts`.

**Gate A run 2** — `driver-assignment-auditor`: **UNSOUND** (3 critical,
6 warnings). Fixed:

- C1: element `registerCommandDirV2` was missing γ₆ — `v2-commands.ts:131` converts
  a ModelRef exactly as `agents.ts:186` does. Reassigned `{γ₃,γ₆}`.
- C2: `registerSkillDir` was labeled an irreducible composite but is **reducible**
  (IVP-2) — the readdir/parse half and the `editor.add` half have unidirectional
  data flow. **Decomposed in code** into `readSkillRecords` (γ₁f) and
  `registerSkillRecords` (γ₁); `registerSkillDir` is now a one-line composition.
- C3: the sole nesting claim depended on an irreducible composite child, which §7
  forbids. After C2 the child is a composition, so the nesting is sound — but the
  claim is now recorded with all three conditions.
- Warnings: counterfactual numbering, coverage counts, follower-rule contradiction,
  and the omitted `MODEL_REF` element are all corrected.

Status: **PROVISIONAL pending re-audit.** Element set changed again after run 2
(20 elements, 11 classes).
