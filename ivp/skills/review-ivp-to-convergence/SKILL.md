---
name: review-ivp-to-convergence
description: Review IVP output to convergence — run adversarial IVP auditors over the change-driver registry/assignments (gate A) OR the post-refactor module structure (gate B), fixing all findings each round until 2 consecutive clean rounds. Reuses the review-convergence meta-skill for the fix loop.
argument-hint: <drivers|refactor> [<scope>]
---

# IVP — Review to Convergence

The convergence gate for the two IVP steps that change a persistent artifact:
Gate A around the driver registry (steps 1–3), Gate B around the module
structure (step 5). Applies the review-fix loop (via the reusable
`review-convergence` meta-skill) with the IVP-specific auditors as the adversary.
Fixes all findings each round until 2 consecutive zero-finding rounds or max 10
rounds.

Assessment of an existing structure is **not** a target here — it is
report-only, and lives in `/assess-ivp` (`current-modularization-auditor`). Do
not run the fix loop over the as-is state: you would be refactoring without a
target.

## Parameters

`$ARGUMENTS` = `<target>` [<scope>]

- `<target>` — which artifact to converge:
  - `drivers`  → Gate A: the driver registry + Γ-assignments (steps 1–3).
  - `refactor` → Gate B: the post-modularization module structure (step 5).
- `[<scope>]` — files/glob to restrict review. Default: full registry/codebase.

## Reviewer sets (chosen by target)

**`drivers`** (Gate A) — reviewers under the convergence loop:
- `driver-assignment-auditor` — ADVISORY core: proxy grounding, counterfactual
  failure, driver conflation, missed drivers, admissibility.
- `logic-auditor` — circularity / hidden assumptions in the driver pathways
  (reused from `general-skills`).
- `proof-soundness-auditor` — if any irreducibility claims are made.
- Scope: the module docblock + `@ivpDrivers` tags + artifact dir.

**`refactor`** (Gate B) — reviewers under the convergence loop:
- `ivp-refactor-auditor` — ADVISORY core: IVP-1 Admissibility, IVP-2 Element
  Form, IVP-3 Separation, IVP-4 Unification, nesting soundness.
- `logic-auditor` — hidden assumptions in the module mapping.
- `proof-soundness-auditor` — if composite/irreducibility claims are made.

Neither set audits optimality. The auditors check compliance with the four
directives; an optimality claim is a separate statement that needs S1–S2,
T1–T4, M2–M3 and the `Ω` exclusion (`ivp-knowledge.md` §3 "What is a theorem, not a statement"). Do not let a review
round add one.

## Protocol (driven by review-convergence)

Per round, for each target:

1. **ADVERSARIAL PASS** — run the target's reviewer set over scope. Each auditor
   returns findings (severity + location + description + fix).
2. **CONVERGE** — apply the `review-convergence` protocol: fix unambiguous
   findings, re-review, repeat until 2 consecutive zero-finding rounds or round
   ≥ 10 (halt, report stranded).
3. **VERIFY** — if the target is `refactor`, ensure the tree still builds after
   fixes (compile/import check).
4. **REPORT** — `Round RN: N findings — fixed` per reviewer; convergence verdict.

## Convergence = 2 consecutive rounds of 0 findings.

## Guards

- `review-convergence` guards apply: empty `$ARGUMENTS` → ask; missing auditor →
  report & halt.
- Fix only what an auditor flags — no drive-by refactors.
- These two review steps deliberately reuse the same meta-loop (`review-convergence`)
  for both phases; only the reviewer sets differ.
- The book repo's `review-adversarial` is for auditing Typst prose about IVP,
  NOT code — do not use it here; these IVP-specific auditors cover code.

## Checkpoint

Every 3 rounds → write a checkpoint with: target, round, cumulative findings,
stranded issues, resume steps. Put it in the target repository's `tmp/` (create
the directory if needed; add nothing that the repository would track). If the
repository has no `tmp/` convention and must stay clean, use the session's
temporary directory instead and report the path.

## Guards (target selection)

- Gate B runs only after Phase C of `/sort-into-modules` passes. Converging a
  half-applied structure wastes rounds on moves that are not finished.
- Gate A runs before step 4. Assessing a structure against an unaudited `Γ` only
  produces a confident wrong diagnosis.
- Neither gate audits the as-is state; `/assess-ivp` does, and it is report-only.

```
=== IVP REVIEW (target: <drivers|refactor>) ===
Round RN: N findings (driver-assignment-auditor: a, logic-auditor: b) — fixed
...
CONVERGED / STRANDED (round, remaining findings)
```
