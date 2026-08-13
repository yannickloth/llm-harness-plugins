---
name: sort-into-modules
description: Step 3 of IVP — sort code elements into modules by gamma-equivalence (same change-driver sets together, different apart), then decide sibling vs parent/child (nested) modules by the strict-subset driver rule Gamma(P) ⊊ Gamma(C) with reducibility guard. Runs AFTER change-driver identification + review converged.
argument-hint: <scope>
---

# IVP — Modularize

Phase 3 of the IVP workflow. Converts the (converged) Γ-map into a concrete
module structure: flat Γ-equality classes, then nesting.

## Parameters

`$ARGUMENTS` = `<scope>` — the code to modularize. The audited registry is read
from the codebase's doc convention.

## Prerequisites

- The driver registry + Γ-assignments must already exist and have been
  reviewed to convergence via `/review-ivp-to-convergence drivers`. Refuse to run otherwise.

## Flow — three phases

### Phase A — flat Γ-sort (gamma-modularizer)
Run `gamma-modularizer`: group elements with identical `Γ(e)` into the same
module (Unification); different `Γ(e)` into different modules (Separation).
Output: the flat Γ-equality partition `P_Γ` and a list of nesting candidates
(pairs where `Γ(P) ⊊ Γ(C)`). No nesting applied here.

### Phase B — nesting (nest-decider)
Run `nest-decider` over the Phase-A classes:
- **Nest** a pair iff `Γ(parent) ⊊ Γ(child)` AND the child is a valid *reducible
  composite* (Case 2) — the extra drivers are separable while preserving purpose.
- **Siblings / top-level** otherwise (equal / partial-overlap / disjoint sets).
- **Never nest** a pure (`|Γ|=1`) or irreducible-composite child — keep whole.

Apply the nested nesting decisions to the tree (move child modules inside
parents), preserving the composition: child may import parent; parent must not
import child's core.

### Phase C — placement verification (ivp-refactor-auditor) — REQUIRED
Verify every placed element is in the *right* module before the sort is done.
Run `ivp-refactor-auditor` over the sorted tree against the four conditions:
- **Separation** — no module mixes elements with different `Γ(e)`.
- **Unification** — no same-`Γ` elements scattered across modules.
- **Admissibility** — every placed element has `|Γ(e)| ≥ 1`, none missing.
- **Nesting soundness** — every parent/child edge satisfies `Γ(parent) ⊊ Γ(child)`;
  no pure/irreducible-composite child nested.

Fix every violation in this phase. Do NOT declare the sort complete while any
element is in the wrong module. This is the built-in correctness gate for
placement; `/review-ivp-to-convergence refactor` re-audits to full convergence
afterward.

## What NOT to do

- Do NOT touch Γ (drivers are audited & fixed).
- Do NOT force-split pure or irreducible-composite elements.
- Do NOT declare the sort complete until Phase C placement verification passes
  (every element confirmed in the right module, no violations).
- Do NOT skip the review loop — `/review-ivp-to-convergence drivers` must have converged first;
  `/review-ivp-to-convergence refactor` re-audits to full convergence afterward.

## Output

```
=== IVP MODULARIZATION: <scope> ===
Phase A: K gamma-classes, K modules
Phase B: M parent/child edges (guarded), S siblings
Module tree:
(root)
├── M1 (Γ={a})
└── M2 (Γ={c})  ... (children nested as applicable)
Phase C (placement verification):
  Separation ✓   Unification ✓   Admissibility ✓   Nesting ✓   Violations fixed: V
```

Phase C must show all checks passing (V = 0) before this skill reports success.
Then proceed to `/review-ivp-to-convergence refactor` to converge the new
structure (step 4).
