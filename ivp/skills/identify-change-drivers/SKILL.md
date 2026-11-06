---
name: identify-change-drivers
description: Steps 1-3 of IVP — enumerate all code elements in scope, identify the change drivers, assign a driver set Gamma(e) to every element, and write the change-driver registry into the codebase's native doc convention (Javadoc / docblock), so the driver list lives beside the code. Use to start applying IVP to a codebase.
argument-hint: <scope> [<artifact-dir>]
---

# IVP — Elements, Change Drivers, Γ (steps 1–3)

Covers steps 1–3 of the application process. Produces the audited driver
registry that every later step reads.

Reference: `ivp/prompts/ivp-knowledge.md` §4–§5 (drivers, elements) and §8
(process). Canonical: `prc:ivp`, `def:change-driver`, `def:element-form` in
`ivp-book-series/src/main/latex/ivp/ivp-graph-proof-2/`.

## Parameters

`$ARGUMENTS` =

- `<scope>` — codebase root or glob to review (required). Default: repo root.
- `[<artifact-dir>]` — optional directory of domain artifacts (regulations,
  contracts, specs, product docs) to anchor drivers.

## Step 0 — Grain

State the element grain before anything else: function, method, class, module,
config key. `Γ` is meaningless without a stated grain, and one run uses one grain
only. Depth is proportionate to the system's lifetime and rate of change.

Check the four applicability gates (G1 boundary and grain, G2 anchors,
G3 enumerability, G4 placement question — see `/apply-ivp` step 0). If one
fails, report `NOT APPLICABLE` and stop.

## Step 1 — Identify the elements

Enumerate classes, methods/functions, closures, attributes, and scoped variables
that carry a change decision. Record `file:line` for each.

## Step 2 — Identify the change drivers

Discovery, not invention. For each candidate driver:

- **Who asks for this change?** Name the governing artifact and the authority.
- **Independent clock:** can this source change without forcing the others to
  change?
- **Counterfactual test** per candidate edge: if the amendment unit anchoring
  the condition were rewritten to remove it, would the requirement to modify
  that element disappear? Yes → anchored driver for that element. No →
  mis-analysis, not a driver.

Two distinct external authorities are two drivers, unless both impose conditions
through one shared document — then they collapse to one driver.

A condition that passes anchoring but governs **no** element is not a driver of
`C`. Record it as an out-of-scope condition, not as a driver.

Revision history is **evidence**, not the criterion: a co-change pattern may
corroborate the grouping, but the amendment-unit structure of the artifact
individuates the driver. Do not demand history, and do not treat it as proof.

Never fabricate an artifact. Never ground a driver in a proxy: activation
frequency, co-modification history, team ownership, module structure, layers,
functional similarity, deployment units, dependencies, bounded contexts, use
cases, security zones.

## Step 3 — Assign Γ and record element form

- Map each element to the set of drivers that govern it: `Γ : E → 2^C`.
- Enforce **IVP-1** — `|Γ(e)| ≥ 1`. An element with `Γ(e) = ∅` is inadmissible:
  flag it, do not fabricate a driver, do not keep it silently.
- Record **IVP-2** form per element: **single-driver** (`|Γ(e)| = 1`) or
  **irreducibly composite**. Decompose a reducible composite (Case 1: a proper
  subset already preserves purpose; Case 2: sub-elements with strictly smaller
  driver sets jointly preserve purpose) before it enters the registry.
- Note: a multi-driver element is not a defect. Purity constrains modules
  (IVP-3), never elements.
- `λ(γ)` activation counts are optional. They matter only if a cost or
  optimality claim is made (T3, M1). A compliance assessment and the refactor
  need none — do not invent them, do not demand them.

## Output — the registry

The registry is one authoritative, machine-readable artifact. Format and
per-language placement: `ivp-knowledge.md` §10 ("Registry format", "Boundary
decisions").

```text
@ivpRegistry version=1 status=PROVISIONAL grain=<function|method|class|module>
@ivpDriver γ_name artifact="<governing artifact>" governs="e1, e2, ..."
@ivpElement e_name file=<path:line> gamma="{γ_a, γ_b}" form=<single|irreducible>
```

Touch doc comments only — this step never moves or refactors code.

**Preserve prior work.** If a registry already exists, read it and report a diff
(drivers added/removed, assignments changed, form changed). Do not overwrite an
`AUDITED` registry silently. The status flips to `AUDITED` only when Gate A
passes.

## Gate

`Γ` is the input to every later step. An unaudited `Γ` makes the refactor
optimal for the wrong system (hypothesis S2). Run
`/review-ivp-to-convergence drivers` and converge before step 4. Do not proceed
while critical findings remain.

## See also

- `/assess-ivp` — step 4, assess the current modularization (report-only).
- `/sort-into-modules` — step 5, refactor to `P_Γ`.
- `/review-ivp-to-convergence` — the gates.
- `/apply-ivp` — all six steps in one run.
