---
name: sort-into-modules
description: Step 5 of IVP — refactor code elements into modules by gamma-equivalence (same change-driver sets together, different apart), then decide sibling vs parent/child (nested) modules by the strict-subset driver rule Gamma(P) ⊊ Gamma(C) together with a causal-existence test (the parent's driver must precondition the child's existence), plus a reducibility guard. Runs AFTER the driver registry has converged and the current modularization has been assessed.
argument-hint: <scope>
---

# IVP — Refactor to the Γ-Equivalence Partition (step 5)

Converts the converged `Γ`-map into a module structure: flat Γ-equality classes,
then guarded nesting. Applies placement changes only — `Γ` is fixed.

Reference: `ivp/prompts/ivp-knowledge.md` §2 (directives), §6 (partition and the
two defect charges), §7 (nesting — a harness extension).

## Parameters

`$ARGUMENTS` = `<scope>` — the code to modularize. The audited registry is read
from the codebase's doc convention.

## Prerequisites

1. The driver registry and `Γ`-assignments exist and have converged via
   `/review-ivp-to-convergence drivers`. Refuse to run otherwise — an unaudited
   `Γ` is hypothesis S2 unverified.
2. The current modularization has been assessed via `/assess-ivp`, so the
   baseline numbers exist. Without them, step 6 cannot show improvement.
3. The working tree is clean and the baseline commit is recorded. Refuse to move
   files on a dirty tree: the session could not separate IVP moves from prior work.

## Flow

### Phase A — flat Γ-sort (`gamma-modularizer`)

- Group elements with identical `Γ(e)` into one module (IVP-4, Unification).
- Put different `Γ(e)` in different modules (IVP-3, Separation).
- Exact equality only. Elements that share *a* driver but differ in their full
  set are separate; co-locating them is contamination.
- Every element lands in exactly one module. Tooling/config files that carry no
  change decision are set aside and flagged — they are not elements.
- Output: the flat partition `P_Γ` plus the list of strict-subset pairs
  (`Γ(P) ⊊ Γ(C)`) for Phase B. No nesting applied yet.

### Phase B — nesting (`nest-decider`)

Nesting is **not** part of `prc:ivp` — the principle partitions `E`, it does not
prescribe a containment tree. Apply the harness extension and label it. Nesting
is **namespace containment**, not element merging: the parent module and the
child module stay distinct, each one Γ-class, and purity is checked per module,
never per namespace (`ivp-knowledge.md` §7 "Nesting — engineering extension").

- **Nest** iff **both** conditions hold:
  1. `Γ(parent) ⊊ Γ(child)` — a strict subset. Necessary, not sufficient.
  2. The parent's driver **causally preconditions** the child's existence. Test:
     *if the parent's driver did not exist, would the child still have a reason
     to exist?* No → nest. Yes → **sibling** (the subset is coincidental).
  Also require the child to be a valid reducible composite (Case 2) — its extra
  drivers are separable while preserving purpose.
- **Siblings / top-level** otherwise: equal, partial-overlap, disjoint sets, **and
  coincidental subsets** (subset holds, causal test fails).
- Determine direction before comparing sets: a child whose vocabulary is derived
  *from* the parent's driver nests; a child that merely *emits into* the parent's
  driver does not — the parent is its sink, not its cause.
- **Never nest** a single-driver element or an irreducible composite. The
  containment would assert a decomposition that does not exist.
- Apply the decisions to the tree: child may import parent; parent must not
  import the child's core.

### Phase C — placement verification (`ivp-refactor-auditor`) — REQUIRED

Verify every placed element is in the right module before reporting success:

- **IVP-3** — no module mixes elements with different `Γ(e)`.
- **IVP-4** — no same-`Γ` elements scattered across modules.
- **IVP-1** — every placed element has `|Γ(e)| ≥ 1`; none is missing.
- **IVP-2** — no reducible composite kept whole; no irreducible composite
  force-split.
- **Nesting** — every parent/child edge satisfies `Γ(parent) ⊊ Γ(child)` **and**
  the causal-existence condition (the parent's driver preconditions the child's
  existence); no single-driver or irreducible-composite child nested; no
  coincidental subset nested.

Fix every violation here. Do not declare the sort complete while any element is
in the wrong module.

## Gate

Run `/review-ivp-to-convergence refactor` to converge the new structure, then
verify the tree builds. `gamma-modularizer` has shell access; it must run the
project's own build or test command. If no build command is discoverable, record
`Build: not verified` — never report a pass you did not observe.

Report the result to step 6 of `/apply-ivp` — or, on a standalone run, report the
unnecessary touches removed against the `/assess-ivp` baseline.

## What NOT to do

- Do NOT touch `Γ` — drivers are audited and fixed upstream.
- Do NOT force-split a single-driver element or an irreducible composite.
- Do NOT merge on a shared subset of drivers.
- Do NOT present nesting as a consequence of the partition theorem.
- Do NOT claim optimality. The target is `P_Γ`; the optimality statement needs
  S1–S2, T1–T4, M2–M3 and the `Ω` exclusion (`ivp-knowledge.md` §3 "What is a theorem, not a statement").

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
  IVP-3 ✓  IVP-4 ✓  IVP-1 ✓  IVP-2 ✓  Nesting ✓  Violations fixed: V
Gate B: /review-ivp-to-convergence refactor — CONVERGED (round n)
Build: PASS
Unnecessary touches removed vs baseline: ...
```

Phase C must show all checks passing (V = 0) before this skill reports success.

## See also

- `/identify-change-drivers` — steps 1–3, produces the registry.
- `/assess-ivp` — step 4, the baseline this step is measured against.
- `/review-ivp-to-convergence` — Gate B.
- `/apply-ivp` — all six steps in one run.
