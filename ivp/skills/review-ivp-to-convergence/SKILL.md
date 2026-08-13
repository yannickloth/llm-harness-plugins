---
name: review-ivp-to-convergence
description: Review IVP output to convergence — run adversarial IVP auditors over the change-driver registry/assignments (step 2) OR the post-refactor module structure (step 4), fixing all findings each round until 2 consecutive clean rounds. Reuses the review-convergence meta-skill for the fix loop.
argument-hint: <drivers|refactor> [<scope>]
---

# IVP — Review to Convergence

Meta-skill. Applies the review-fix loop (via the reusable `review-convergence`
meta-skill) to either of the two IVP phases, using the IVP-specific auditors as
the adversary. Fixes all findings each round until 2 consecutive zero-finding
rounds or max 10 rounds.

## Parameters

`$ARGUMENTS` = `<target>` [<scope>]

- `<target>` — which artifact to converge:
  - `drivers`  → the driver registry + Γ-assignments (step 2).
  - `refactor` → the post-modularization module structure (step 4).
- `[<scope>]` — files/glob to restrict review. Default: full registry/codebase.

## Reviewer sets (chosen by target)

**`drivers`** (step 2) — reviewers under the convergence loop:
- `driver-assignment-auditor` — ADVISORY core: proxy grounding, counterfactual
  failure, driver conflation, missed drivers, admissibility.
- `logic-auditor` — circularity / hidden assumptions in the driver pathways
  (reused from `general-skills`).
- `proof-soundness-auditor` — if any irreducible/irreducibility claims are made.
- Scope: the module docblock + `@ivpDrivers` tags + artifact dir.

**`refactor`** (step 4) — reviewers under the convergence loop:
- `ivp-refactor-auditor` — ADVISORY core: Separation, Unification, Admissibility,
  Element Form, nesting soundness.
- `logic-auditor` — hidden assumptions in the module mapping.
- `proof-soundness-auditor` — if composite/irreducibility claims are made.

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

Every 3 rounds → `tmp/review-ivp-checkpoint.md`: target, round, cumulative
findings, stranded issues, resume steps.

```
=== IVP REVIEW (target: <drivers|refactor>) ===
Round RN: N findings (driver-assignment-auditor: a, logic-auditor: b) — fixed
...
CONVERGED / STRANDED (round, remaining findings)
```
