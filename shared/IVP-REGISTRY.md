# Change-driver registry — `shared/` v2 registry helpers

Grain: **function** (exported functions and module-level constants). Scope:
`shared/v2-skills.ts`, `shared/v2-commands.ts`, `shared/agents.ts`.
Status: **PROVISIONAL** — Gate A ran once and returned UNSOUND; the four criticals
are corrected below and a re-audit is required.

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

Note γ₂ ≠ γ₅: the V2 agent editor and the V1 config hook are amended by
different units of different artifacts. They are not one driver even though both
concern agents.

## Assignment Γ(e)

| # | Element | `file:line` | Γ(e) | Form |
|---|---|---|---|---|
| 1 | `parseFrontmatter` | `v2-skills.ts:47` | {γ₁f} | single |
| 2 | `registerSkillDir` | `v2-skills.ts:22` | {γ₁,γ₁f} | **irreducible composite** — reads the directory convention and emits an editor record in one loop |
| 3 | `parseModelRef` | `v2-commands.ts:56` | {γ₃} | single — see the ModelRef note |
| 4 | `stripQuotes` (commands) | `v2-commands.ts:62` | {γ₃} | **follower** of `parseCommand` |
| 5 | `parseCommand` | `v2-commands.ts:71` | {γ₃} | single |
| 6 | `readCommandRecords` | `v2-commands.ts:96` | {γ₃} | **follower** — see the follower rule |
| 7 | `registerCommandDirV2` | `v2-commands.ts:122` | {γ₃} | single |
| 8 | `MODES` | `agents.ts:63` | {γ₂} | **follower**, but not a pure one — see note |
| 9 | `V2_ACTION` | `agents.ts:52` | {γ₂,γ₅} | **irreducible composite** — the V1→V2 verb bridge |
| 10 | `V1_PERMISSION` | `agents.ts:61` | {γ₅} | single |
| 11 | `stripQuotes` (agents) | `agents.ts:65` | {γ₂,γ₅} | follower of `parseAgent` |
| 12 | `asEffect` | `agents.ts:73` | {γ₂,γ₅} | follower of `parseAgent` |
| 13 | `parseAgent` | `agents.ts:82` | {γ₂,γ₅} | **irreducible composite** |
| 14 | `readAgentRecords` | `agents.ts:141` | {γ₂} | single — delegates to `parseAgent`, holds no V1 logic |
| 15 | `registerAgentDirV2` | `agents.ts:171` | {γ₂} | single |
| 16 | `registerAgentDirV1` | `agents.ts:212` | {γ₅} | single |

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

## ModelRef note (open question, not resolved)

`parseModelRef` (`v2-commands.ts:56`) and the two inline ModelRef regexes in
`agents.ts:117` and `agents.ts:185` encode the same `provider/model[#variant]`
convention. If OpenCode defines ModelRef once, as a single amendment unit shared
by both registries, then `γ_modelref` is a real driver currently folded into γ₂
and γ₃, and these three sites are mis-grounded. The registry leaves it as
assigned to γ₃ pending that determination — **flagged, not settled.**

## Γ-equivalence classes → modules

| Class | Γ | Elements | Module |
|---|---|---|---|
| M₁ | {γ₁f} | 1 | `v2-skills.ts` |
| M₂ | {γ₁,γ₁f} | 2 | `v2-skills.ts` |
| M₃ | {γ₃} | 3, 4, 5, 6, 7 | `v2-commands.ts` — **complete** |
| M₄ | {γ₂} | 8, 14, 15 | part of `agents.ts` |
| M₅ | {γ₂,γ₅} | 9, 11, 12, 13 | part of `agents.ts` |
| M₆ | {γ₅} | 10, 16 | part of `agents.ts` |

`P_Γ` has **6** classes over 16 elements. The current tree has **3** files.

Driver coverage (`|{e : γ ∈ Γ(e)}|`): γ₁f → 2, γ₁ → 1, γ₂ → 7, γ₃ → 5, γ₅ → 6.
Every driver governs at least one element (the γ₄ defect from the audit is fixed).

## Findings (step 4, as-is vs `P_Γ`)

- **IVP-4, `v2-skills.ts`** — M₁ and M₂ are two classes in one file. M₂'s set is a
  strict superset of M₁'s. Under the nesting extension this is a valid
  parent/child pair (`Γ(M₁) ⊊ Γ(M₂)`), so no split is prescribed; the
  single-driver `parseFrontmatter` is reducible into `registerSkillDir`'s concern
  only if the directory convention and the editor record keep changing together.
- **IVP-3, `agents.ts`** — one file holds three classes (M₄, M₅, M₆). At **file
  grain** this is not a violation: the module's Γ is `{γ₂,γ₅}`, and the other
  members' sets are strict subsets of it, which is exactly the §7 nesting
  relation. At **function grain** it is three classes sharing a container, and
  separation is a placement preference.
- **IVP-4 (scattered classes)** — none. Every class sits wholly inside one file.
- **IVP-1/IVP-2** — no `|Γ(e)| = 0`; M₂, M₅, and element 9 are claimed
  irreducibly composite (see the audit's verification of element 11).

## Grain note (required for a correct reading)

At **function grain** the partition is the six classes above; `agents.ts` is a
container holding three of them (M₄, M₅, M₆), and separateness is a placement
preference under this grain. At **file grain** `agents.ts` is one module with
`Γ = {γ₂,γ₅}` — pure, because the composite elements (9, 11, 12, 13) carry exactly
that set and the other members are strict subsets of it (`{γ₂} ⊊ {γ₂,γ₅}`,
`{γ₅} ⊊ {γ₂,γ₅}`). This is the nesting relation of §7 (`Γ(P) ⊊ Γ(C)`), and any
move must respect the reducibility guard.

`v2-skills.ts` is the same shape at two classes: `{γ₁f} ⊊ {γ₁,γ₁f}`.

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
  re-run element 7. If the two editors converge, γ₂ and γ₃ may collapse — a
  single amendment unit would then cover both.
- **ModelRef is determined to be one shared amendment unit** → split
  `γ_modelref` out of γ₂ and γ₃; elements 3 and 15 are re-grounded. Open question;
  see the ModelRef note.
- The V1 path is retired → γ₅ disappears, elements 9, 10, 11, 12, 16 lose a
  member of their sets, and 10/16 have no set left. **This is the most likely
  collapse**; M₆ then has no members and M₅ shrinks to `{γ₂}`.
- The skill file format and the editor record are determined to co-vary → γ₁ and
  γ₁f collapse to one unit, and M₁/M₂ merge.

## Unanchored candidates (not drivers)

Churn, file co-location, and "these are all v2 helpers" were rejected as proxies
(§4). `shared/` placement is not a driver.

## Audit record

Gate A run: `driver-assignment-auditor`, verdict **UNSOUND** on the first draft
(4 critical, 3 warnings). All four criticals were verified against the code and
fixed — γ₄ removed, `γ₁f` split out, `readAgentRecords` re-grounded, follower rule
stated uniformly. Findings 5 and 6 are recorded as the two open items above
(ModelRef, and the omitted-constants enumeration, now listed as elements 9 and 10).
Status after fixes: **PROVISIONAL pending re-audit.**

