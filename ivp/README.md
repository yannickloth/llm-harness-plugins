# `ivp` — Independent Variation Principle skill pack

Applies IVP to a codebase: identify change drivers, assign `Γ`, refactor to the
Γ-equivalence partition, and review both the drivers and the existing structure.

## Where the theory lives

**This directory is not the authority.** The canonical statement is:

| Source | Path |
|---|---|
| Statement of IVP (`prc:ivp`), `def:change-driver`, `def:element-form`, `def:separation` | `ivp-book-series/src/main/latex/ivp/ivp-graph-proof-2/ch02-graph-model.tex` |
| Uniqueness theorem + hypothesis ledger (`thm:uniqueness`, `tab:ledger`) | `ivp-book-series/src/main/latex/ivp/ivp-graph-proof-2/ch04-ivp.tex` |
| Four conditions, one file each | `ivp-book-series/src/main/typst/shared/four-conditions/` |
| Six-step process, worked example | `https://yannickloth.github.io/independentvariation/ivp-software/` |
| Published artifact | Loth, *The Independent Variation Principle*, Zenodo 2026, `10.5281/zenodo.20794332` |

`prompts/ivp-knowledge.md` is the working restatement used by the agents in this
pack. It carries the four directives, the hypothesis ledger, the proxy
prohibitions, and the six-step process. When it and the canonical source
disagree, the canonical source wins — fix the restatement.

Two boundaries to keep straight:

- **The four directives are the principle.** Optimality of `P_Γ` is a theorem
  under S1–S2, T1–T4, M2–M3, with the boundary cost `Ω` excluded as a scope
  decision. Never state one as the other.
- **Purity constrains modules, never elements** (`def:separation`). An element is
  single-driver or irreducibly composite.

## Six-step process → skill → command → agents

| Step | Skill | Command | Agents |
|---|---|---|---|
| 0. Grain and scope | `/apply-ivp` | `/apply-ivp` | — |
| 1. Identify the elements | `/identify-change-drivers` | `/identify-change-drivers` | `driver-identifier` |
| 2. Identify the change drivers | `/identify-change-drivers` | `/identify-change-drivers` | `driver-identifier` |
| 3. Map drivers to elements (Γ) | `/identify-change-drivers` | `/identify-change-drivers` | `driver-identifier` |
| **Gate A** — driver convergence | `/review-ivp-to-convergence drivers` | `/review-ivp-to-convergence drivers` | `driver-assignment-auditor` |
| 4. Assess the current modularization | `/assess-ivp` | `/assess-ivp` | `current-modularization-auditor` |
| 5. Refactor toward compliance | `/sort-into-modules` | `/sort-into-modules` | `gamma-modularizer`, `nest-decider` |
| **Gate B** — structure convergence | `/review-ivp-to-convergence refactor` | `/review-ivp-to-convergence refactor` | `ivp-refactor-auditor` |
| 6. Verify and iterate | `/apply-ivp` | `/apply-ivp` | — |

Two ways in, same procedure:

- **Skill** (`@assess-ivp` in a prompt, or the model loading it when the task
  fits) — reaches for the procedure from any session, no argument handling.
- **Command** (`/assess-ivp src/`) — user-invoked, so `$ARGUMENTS` is
  substituted, and the command can pin an agent and a session type: `/assess-ivp`
  runs read-only in a child session, `/identify-change-drivers` and
  `/sort-into-modules` run under their owning agent.

`/apply-ivp` runs all six steps with both gates. Run the per-step skills or
commands when a single step needs to be re-run.

### Two review modes, not one

| Need | Skill | Edits? |
|---|---|---|
| Diagnose the existing code (drivers + module structure) | `/assess-ivp` | No — report only |
| Fix findings until two clean rounds | `/review-ivp-to-convergence` | Yes, per auditor finding |

Do not run the fix loop over the as-is state: that refactors without a target.
Assess first, then converge.

## Agents

| Agent | Role | Mode |
|---|---|---|
| `driver-identifier` | Steps 1–3: enumerate elements, identify drivers, write the registry | edits docblocks only |
| `driver-assignment-auditor` | Gate A: adversarial audit of `Γ` (proxy grounding, conflation, missed drivers, admissibility) | read-only |
| `current-modularization-auditor` | Step 4: as-is assessment against IVP-1…IVP-4, propagation price, ranked prescription | read-only |
| `gamma-modularizer` | Step 5 Phase A: flat Γ-equality partition, apply the moves | edits code |
| `nest-decider` | Step 5 Phase B: siblings vs parent/child, reducibility guard | read-only |
| `ivp-refactor-auditor` | Gate B: post-refactor compliance with the four directives | read-only |

## Guards the pack enforces

| Guard | Where | Why |
|---|---|---|
| Applicability gates G1–G4 | `/apply-ivp` step 0, `/assess-ivp` preflight | IVP decides placement only. A failed gate gives `NOT APPLICABLE`, not a weaker model |
| One grain per run | steps 0–3 | `Γ` is meaningless across mixed grains |
| Clean tree + baseline commit | `/sort-into-modules`, `/apply-ivp` step 5 | Separates IVP moves from prior work |
| Registry is not clobbered | `driver-identifier` | Re-runs report a diff; `AUDITED` is not overwritten silently |
| `λ` is optional | all | Activation counts serve cost claims only; compliance needs none |
| Compliance ≠ optimality | Gate A/B reports | A compliance verdict needs no hypothesis; a cost claim needs the ledger |
| Purity is per module | all auditors | A namespace holding two modules is compliant |

## Nesting is an extension

`prc:ivp` partitions `E`; it prescribes no containment tree. The rule
`Γ(P) ⊊ Γ(C)` with the reducibility guard is this pack's extension for code
trees. Nesting is **namespace containment**: the parent and child remain distinct
modules, each one Γ-class. Label it as such in every report; never present it as
a consequence of the partition theorem, and never charge a namespace with a
purity violation.

## Consumption — reference, never copy

This pack is **shared, not installed**. A consuming project points its own
`opencode.json` at this directory and leaves the files here:

```json
{
  "plugin": ["../llm-harness-plugins/ivp/opencode/index.ts"],
  "agent": {
    "driver-identifier": {
      "mode": "subagent",
      "model": "deepseek/deepseek-flash",
      "prompt": "{file:../llm-harness-plugins/ivp/agents/driver-identifier.md}"
    }
  }
}
```

Rules:

- Do **not** copy `ivp/` into the consuming project. Editing a copy forks the
  theory and nobody notices.
- The path is relative to the *consumer's* `opencode.json`, so `ivp/` must stay
  at `llm-harness-plugins/ivp/`. Moving or renaming it breaks every consumer.
- Consumers may pin their own `model` per agent; the frontmatter value is the
  fallback used by self-registration.
- The harness itself does not load the pack. `ivp/opencode/index.test.ts` asserts
  that non-registration, and it checks that every sibling project referencing
  `../llm-harness-plugins/ivp/...` still resolves.

## Registration and models

`opencode/index.ts` self-registers three channels with OpenCode when a consuming
project loads it:

| Directory | Registered via | Invoked as |
|---|---|---|
| `skills/` | `ctx.skill.transform` (v2), `config.skills.paths` (v1) | `@skill-id`, or the model loading it |
| `commands/` | `ctx.command.transform` → `add` (v2 only) | `/name` |
| `agents/` | `ctx.agent.transform` → `update` (v2), `config.agent` (v1) | spawned as a subagent |

`prompts/` is not registered — agents read `ivp-knowledge.md` on demand. Because
a subagent runs with the *target* codebase as cwd, the entrypoint prepends a
preamble to every agent system prompt that states the **absolute** path of
`prompts/ivp-knowledge.md` and of the canonical `ivp-book-series/` checkout (or
says the checkout is absent). The preamble is computed from the plugin's own
location, so moving the pack breaks no reference.

Rules are deliberately **not** injected: IVP is an activity, not a standing
invariant. A rule costs its full text on every request; a skill or command costs
nothing until used.

Each agent pins `model: deepseek/deepseek-v4-pro` in frontmatter. A bare alias
such as `sonnet` also resolves, through the host's alias map, to whatever that
map points at — the explicit reference is used so a remapped alias cannot change
this agent's model silently. Verify with `opencode debug agents` (a reload is
needed after editing frontmatter; the host caches agent definitions). To change
the model for one repository, override the agent in that repository's
`opencode.json`; the explicit entry wins over self-registration.

Permissions: the four auditors are read-only (`edit: deny`, `bash: deny`).
`driver-identifier` edits docblocks only. `gamma-modularizer` edits code and runs
shell commands, because it must verify the build it is required to check.

## Tests

```bash
bun test ivp/opencode/index.test.ts   # 42 checks: skills, agents, models, registration, reference
./build.sh                            # also checks ivp agent registration + runs the pack tests
```

The test fails when a skill or agent is renamed, when an agent is not registered
in `opencode.json`, when a model declaration is a bare alias, or when a
read-only agent gains edit or shell access.
