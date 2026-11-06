---
name: assess-ivp
description: Step 4 of IVP, report-only — review an existing codebase's change drivers and current module structure against IVP, name every violation (mixed modules, scattered classes, element defects, unsound nesting), price the wasted change propagation, and hand off a ranked prescription. Never edits. Use before any refactor, or to answer "how far from IVP are we?".
argument-hint: <scope> [--drivers-only|--structure-only] [<artifact-dir>]
---

# IVP — Assess an Existing Modularization

Report-only review of a codebase as it stands. Produces the diagnosis that step 5
needs. Applies no fix — that is `/sort-into-modules`, gated by
`/review-ivp-to-convergence`.

This is the skill to run on code that has **never** had an IVP pass, and on code
that has drifted since its last one.

## Parameters

`$ARGUMENTS` =

- `<scope>` — codebase root or glob (default: repo root).
- `--drivers-only` — review the change-driver registry and `Γ` only (skip the
  structural assessment).
- `--structure-only` — assess the module structure only (requires an existing
  registry).
- `<artifact-dir>` — optional directory of domain artifacts (regulations,
  contracts, specs, product docs) to anchor drivers.

## Precondition: is there a registry?

Look for the driver registry in the codebase's doc convention (Javadoc /
docblock / `@ivpDrivers` tags).

| Found | Action |
|---|---|
| Registry present | Read `Γ` from it. It is authoritative — do not re-derive. |
| Not found | Ask the user. Offer: (a) `/identify-change-drivers` first (recommended — an audited `Γ` is what `Γ`-claims rest on), (b) proceed with a `PROVISIONAL` `Γ`, clearly labelled, or (c) abort. Never silently invent `Γ`. |

## Preflight — applicability gates

Check these before reading code. If one fails, report `NOT APPLICABLE` with the
reason and stop.

| Gate | Requirement |
|---|---|
| G1 | A system boundary and one element grain can be stated |
| G2 | Driver candidates are anchorable in governing artifacts |
| G3 | `E` and `C` are finite and listable at that grain |
| G4 | The question is placement — not correctness, performance, security, deployment, or team allocation |

## Flow

1. **Resolve scope and artifacts.** Confirm what the analysis covers. State it
   back in one line.
2. **Review the change drivers** (skip under `--structure-only`). Run
   `driver-assignment-auditor` over the registry and the code it annotates:
   proxy grounding, counterfactual failure, driver conflation, missed drivers,
   admissibility. Report its findings unchanged — do not soften them.
3. **Review the current structure** (skip under `--drivers-only`). Run
   `current-modularization-auditor` over the same scope. It maps the as-is
   modules, applies IVP-1…IVP-4, checks nesting as an extension, and prices the
   unnecessary touches.
4. **Consolidate.** Merge the two reports. Order every finding by *unnecessary
   touches removed per element moved*, smallest diff first. State which
   directive each finding violates.
5. **State the verdict.** `COMPLIANT` / `MOSTLY COMPLIANT` / `VIOLATING`, plus
   `Γ confidence: AUDITED | PROVISIONAL`.
6. **Report and hand off.** No edits in this skill. End with the next command:
   - `Γ` provisional or `driver-assignment-auditor` found criticals →
     `/review-ivp-to-convergence drivers`.
   - `Γ` sound and structural violations found → `/sort-into-modules`.
   - Notebook only → stop.

## Guards

- **No edits.** This skill never moves, splits, merges, renames, or re-annotates
  anything. Report only.
- A compliance verdict needs no hypothesis and no `λ`. Do not demand activation
  counts, and do not import the optimality ledger into a compliance report.
- Do not charge a module for elements that are irreducibly composite. A module
  whose elements share one multi-driver set is compliant.
- **Purity is per module, not per namespace.** A namespace holding two modules
  of different classes is compliant.
- Do not charge the *required* change set to the design. Price the unnecessary
  touches only.
- Do not invent drivers, artifacts, or `Γ` values.
- Layering, packaging, and naming are not IVP conditions. Do not report a style
  preference as a violation.
- Nesting is a harness extension, not part of `prc:ivp`. Report its breaches as
  warnings.

## Output

```
=== IVP ASSESSMENT: <scope> ===
Registry: <path | PROVISIONAL>     Γ confidence: AUDITED | PROVISIONAL

### Change drivers
Critical: n   Warnings: m
[driver-assignment-auditor summary — unchanged]

### Current modularization
IVP-1 Admissibility: PASS | VIOLATED (n)
IVP-2 Element Form:  PASS | VIOLATED (n)
IVP-3 Unit purity:   PASS | VIOLATED (n modules)
IVP-4 Unit completeness: PASS | VIOLATED (n classes)
Nesting (extension): SOUND | WARNINGS (n)
[ranked findings with file:line and unnecessary-touch counts]

### Not IVP defects
[irreducibly composite modules, tooling files, layer choices]

### Ranked prescription
1. [fix] serves [directive] — moves [elements] — removes [n] touches

VERDICT: COMPLIANT / MOSTLY COMPLIANT / VIOLATING
NEXT: /review-ivp-to-convergence drivers | /sort-into-modules | none
```

## See also

- `/identify-change-drivers` — build the registry this skill reads (steps 1–3).
- `/sort-into-modules` — apply the prescription (step 5).
- `/review-ivp-to-convergence` — fix-loop convergence, per target.
- `/apply-ivp` — the whole six-step process in one run.
