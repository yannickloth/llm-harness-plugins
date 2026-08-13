---
name: identify-change-drivers
description: Step 1 of IVP — enumerate all code elements in scope, identify the change drivers, assign a driver set Gamma(e) to every element, and write the change-driver registry into the codebase's native doc convention (Javadoc / docblock), so the driver list lives beside the code. Use to start applying IVP to a codebase.
argument-hint: <scope> [<artifact-dir>]
---

# IVP — Change Driver Tier

Phase 1 of the IVP workflow. Produces the audited driver registry.

## Parameters

`$ARGUMENTS` =
- `<scope>` — codebase root or glob to review (required). Default: repo root.
- `[<artifact-dir>]` — optional directory of domain artifacts (regulations,
  contracts, specs, product docs) to anchor drivers.

## Flow

1. **Enumerate elements.** Classes, methods/functions, closures, attributes,
   and scoped variables that carry a change decision. Record file:line.
2. **Run `driver-identifier`** to identify change drivers, assign `Γ(e)` to
   every element, and write the registry into the native doc convention
   (Javadoc for Java, docblock for other languages). Its constraints are
   load-bearing — see its prompt and the IVP knowledge reference.
3. **Produce a first registry** at the root module's docblock (and per-element
   tags in the platform's doc convention).

## Guard

- If no candidate domain artifacts exist, run anyway but the registry will have
  unanchored drivers flagged. Do not fabricate artifacts.
- Do NOT refactor; this step is identification + documentation only.

## Output

A change-driver registry embedded beside the code:
```
(per module docblock)
@ivpDrivers: [
  driver: γ_name
  artifact: <anchored artifact>
  elements: [list governed by γ]
]
```
Plus a summary of elements enumerated, drivers identified, and assignments.

## See also

- `/review-ivp-to-convergence` — audit the drivers/assignments to convergence (step 2).
- `/sort-into-modules` — sort elements into modules by Γ-equivalence (step 3).
