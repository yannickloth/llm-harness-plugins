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
| 1 | `parseFrontmatter` | `v2-skills.ts:47` | {γ₁f} | single |
| 2 | `registerSkillDir` | `v2-skills.ts:22` | {γ₁,γ₁f} | **irreducible composite** — reads the directory convention and emits an editor record in one loop |
| 3 | `parseModelRef` | `model-ref.ts:25` | {γ₆} | single — see the ModelRef section |
| 4 | `isModelRef` | `model-ref.ts:33` | {γ₆} | single |
| 5 | `stripQuotes` (commands) | `v2-commands.ts:63` | {γ₃} | **follower** of `parseCommand` |
| 6 | `parseCommand` | `v2-commands.ts:72` | {γ₃,γ₆} | composite — validates a model ref while parsing a command record |
| 7 | `readCommandRecords` | `v2-commands.ts:97` | {γ₃} | single |
| 8 | `registerCommandDirV2` | `v2-commands.ts:123` | {γ₃} | single |
| 9 | `MODES` | `agents.ts:64` | {γ₂} | **follower**, but not a pure one — see note |
| 10 | `V2_ACTION` | `agents.ts:53` | {γ₂,γ₅} | **irreducible composite** — the V1→V2 verb bridge |
| 11 | `V1_PERMISSION` | `agents.ts:62` | {γ₅} | single |
| 12 | `stripQuotes` (agents) | `agents.ts:66` | {γ₂,γ₅} | follower of `parseAgent` |
| 13 | `asEffect` | `agents.ts:74` | {γ₂,γ₅} | follower of `parseAgent` |
| 14 | `parseAgent` | `agents.ts:83` | {γ₂,γ₅,γ₆} | **irreducible composite** |
| 15 | `readAgentRecords` | `agents.ts:142` | {γ₂} | single — delegates to `parseAgent`, holds no V1 logic |
| 16 | `registerAgentDirV2` | `agents.ts:172` | {γ₂,γ₆} | composite — the model ref is converted to `Agent.Info.model` here |
| 17 | `registerAgentDirV1` | `agents.ts:213` | {γ₅} | single |

## The follower rule (stated once, applied uniformly)

A non-exported helper with no caller outside one element inherits that element's
set for **placement**, because its requirement to change is derived rather than
independently caused. Applied to: `stripQuotes` (commands), `readCommandRecords`,
`MODES`, `stripQuotes` (agents), `asEffect`.

`MODES` is the documented exception: a mode-enum rename changes `MODES` without
changing `parseAgent`'s `MODES.has(...) ?? "subagent"` check, so `MODES` has its
own γ₂ dependency and is recorded as `{γ₂}` rather than `parseAgent`'s
`{γ₂,γ₅}`. The subset relation makes this harmless for placement.

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
| M₁ | {γ₁f} | 1 | `v2-skills.ts` |
| M₂ | {γ₁,γ₁f} | 2 | `v2-skills.ts` |
| M₃ | {γ₆} | 3, 4 | `model-ref.ts` — **complete** |
| M₄ | {γ₃} | 5, 7, 8 | `v2-commands.ts` |
| M₅ | {γ₃,γ₆} | 6 | `v2-commands.ts` |
| M₆ | {γ₂} | 9, 15 | `agents.ts` |
| M₇ | {γ₂,γ₅} | 10, 12, 13 | `agents.ts` |
| M₈ | {γ₂,γ₅,γ₆} | 14 | `agents.ts` |
| M₉ | {γ₂,γ₆} | 16 | `agents.ts` |
| M₁₀ | {γ₅} | 11, 17 | `agents.ts` |

`P_Γ` has **10** classes over 17 elements. The current tree has **4** files.

Driver coverage (`|{e : γ ∈ Γ(e)}|`): γ₁f → 2, γ₁ → 1, γ₂ → 6, γ₃ → 4, γ₅ → 5,
γ₆ → 6. Every driver governs at least one element.

**File grain** — each file's Γ is the union of its elements' sets:

| Module | Γ | Elements |
|---|---|---|
| `v2-skills.ts` | {γ₁,γ₁f} | 2 |
| `model-ref.ts` | {γ₆} | 2 |
| `v2-commands.ts` | {γ₃,γ₆} | 4 |
| `agents.ts` | {γ₂,γ₅,γ₆} | 9 |

Four distinct sets over four files: pure at file grain, nothing scattered.

## Findings (step 4, as-is vs `P_Γ`)

- **`v2-skills.ts`** — M₁ and M₂ are two classes in one file. M₂'s set is a strict
  superset of M₁'s **and** the causal test holds (no file format → no record), so
  this is a sound parent/child pair. No split is prescribed.
- **`agents.ts`, function grain** — five classes (M₆, M₇, M₈, M₉, M₁₀) in one
  container, **none nesting**. All five are siblings. This is the real finding at
  this grain — independent concerns sharing a file, not a hierarchy.
- **`v2-commands.ts`, function grain** — two classes (M₄, M₅), neither nesting.
- **File grain** — `Γ(agents.ts) = {γ₂,γ₅,γ₆}`, `Γ(v2-commands.ts) = {γ₃,γ₆}`, both
  pure; no violation, nothing to separate. Do not use file-grain purity to excuse
  the function-grain finding; they are different element sets.
- **IVP-4 (scattered classes)** — none. Every class sits wholly inside one file.
- **IVP-1/IVP-2** — no `|Γ(e)| = 0`; M₂, M₅, M₇, M₈, M₉ and elements 10, 14 are
  claimed irreducibly composite (element 14 verified by the audit).

## Nesting: subset is necessary, causality decides

`Γ(P) ⊊ Γ(C)` alone does **not** establish nesting. It is a set relation that a
stale or coincidental overlap can satisfy. Nesting also asserts a causal claim:
`P`'s driver must be a **precondition of `C`'s existence** — `C` exists to extend
a concern that `P`'s driver already creates. Fail the causal test and the pair is
**sibling**, not "loosely nested".

**Twelve pairs** in this partition satisfy the strict-subset test. **One** passes
the causal test.

| Parent | Child | Causal verdict |
|---|---|---|
| M₁ `{γ₁f}` | M₂ `{γ₁,γ₁f}` | **NEST.** No `SKILL.md` format → no record exists for the editor to add. The file format preconditions every `Skill.Info` emission. |
| M₃ `{γ₆}` | M₅, M₈, M₉ | **sibling.** The ModelRef grammar is a shared *vocabulary*. It does not cause a command parser or an agent parser to exist; those read it because a model field happens to be present. |
| M₄ `{γ₃}` | M₅ `{γ₃,γ₆}` | **sibling.** The command editor does not precondition ModelRef; ModelRef is used by the parser, not produced by the editor. |
| M₆ `{γ₂}` | M₇, M₈, M₉ | **sibling.** The V2 agent editor is the *sink* for the V1-derived permissions and the model ref, not their cause. |
| M₇ `{γ₂,γ₅}` | M₈ | **sibling.** γ₆ is an extra vocabulary, not an extension of the V1 bridge's concern. |
| M₉ `{γ₂,γ₆}` | M₈ | **sibling.** Same reason on the γ₅ axis. |
| M₁₀ `{γ₅}` | M₇, M₈ | **sibling.** `V1_PERMISSION` (`agents.ts:62`) is consumed only at `agents.ts:236`, inside `registerAgentDirV1`. The V1 verb schema stands alone. |

**Every subset pair inside `agents.ts` and `v2-commands.ts` is coincidental.** They
hold because those files serve two registries that share two vocabularies (the
V1 permission verbs and the ModelRef format). A subset is not a concern
hierarchy — it is what you get when two independent concerns consume the same
shared grammar.

An earlier revision of this file called the `agents.ts` pairs "the nesting
relation of §7". That was subset reasoning wearing a nesting claim, and it made
the status quo look better than it is. Corrected here.

## Grain note

At **file grain** `agents.ts` is one module with `Γ = {γ₂,γ₅,γ₆}`. It is pure: the
file's set is the union of its elements' sets, and no element carries a driver
outside it. File-grain purity needs no nesting claim — a file is one module with
one driver set.

At **function grain** the partition is ten classes. `agents.ts` holds five of them
(M₆, M₇, M₈, M₉, M₁₀) and **none nests**. They are siblings sharing a container.
Separateness is therefore not merely a placement preference: without nesting, they
are independent concerns that happen to live in one file.

`v2-skills.ts` is the one file where nesting is sound (M₁ in M₂).

Which grain governs is a modelling decision — at what grain do the change
decisions actually occur — and both partitions are valid. They yield different
verdicts; state the grain with every claim.

## Counterfactual tests (per edge, abridged)

Each test rewrites one artifact's amendment unit and asks whether the element's
requirement to change disappears.

- **A3 (command registry) removed** → 3–7 lose their requirement; 1–2, 9–16
  unaffected → γ₃ holds and is isolated.
- **A2's permission-action table rewritten** → 8, 9, 11, 12, 13, 14, 15 change.
  Element 13 also carries the V1 verb map, so the A2-only test does not remove its
  whole requirement → 13 is composite, not γ₂-single.
- **A5 (V1 path) removed** → 10 and 16 disappear; 9, 11, 12, 13 drop to {γ₂}. The
  A5-only test removes nothing from 14, which is why 14 is `{γ₂}` and not
  composite. **This test is what corrected the initial assignment** (the audit's
  finding 4: `readAgentRecords` was wrongly listed as `{γ₂,γ₅}`).
- **A1 (skill editor) rewritten** → 2 changes; 1 does not → γ₁ and γ₁f are
  distinct amendment units. **This test corrected the initial assignment** (the
  audit's finding 2: `parseFrontmatter` was wrongly assigned `{γ₁}`).
- **A1f (SKILL.md format) rewritten** → 1 and 2 both change, while `parseFrontmatter`
  alone would still satisfy a `Skill.Info`-only change → 1 is `{γ₁f}`, 2 is
  composite.
- **A4 (`opencode.json`) rewritten** → no element changes → γ₄ is not a driver of
  this set and is removed from `C` (the audit's finding 1).

Pass condition: every element ends with `|Γ(e)| ≥ 1`, and each driver is removed
by exactly one artifact's amendment.

## Revisit conditions

- A3 gains `update`/`get` (the docs already describe an `add`+`execute` shape):
  re-run element 8. If the two editors converge, γ₂ and γ₃ may collapse — a
  single amendment unit would then cover both.
- The ModelRef grammar changes → γ₆ fires on elements 3, 4, 6, 14, 16. Already
  resolved as one unit and extracted to `model-ref.ts`; keep it extracted.
- The V1 path is retired → γ₅ disappears. Elements 11 and 17 lose their whole set
  and leave `E`; 10, 12, 13, 14 drop a member. **Most likely collapse**: M₁₀ has no
  members and M₇/M₈ shrink.
- The skill file format and the editor record are determined to co-vary → γ₁ and
  γ₁f collapse to one unit, and M₁/M₂ merge (removing the only sound nesting).

## Unanchored candidates (not drivers)

Churn, file co-location, and "these are all v2 helpers" were rejected as proxies
(§4). `shared/` placement is not a driver.

## Audit record

Gate A run 1: `driver-assignment-auditor`, verdict **UNSOUND** (4 critical,
3 warnings). All four criticals were verified against the code and fixed — γ₄
removed, `γ₁f` split out, `readAgentRecords` re-grounded, follower rule stated
uniformly. Warnings 5 and 6 are resolved in this revision: the omitted constants
are now elements (10, 11), and ModelRef is extracted as γ₆.

Revision 2 (after Gate A): the nesting rule gained its **causal-existence
condition**, which the pack had omitted. Applying it changed the verdict for every
`agents.ts` pair from "nested" to **sibling**. The ModelRef question was resolved
as one amendment unit and the code was extracted to `model-ref.ts` to match.

Status: **PROVISIONAL pending re-audit.** The element set changed after the first
audit (17 elements, 10 classes), so the earlier verdict does not carry forward.

