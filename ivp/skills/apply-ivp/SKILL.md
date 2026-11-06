---
name: apply-ivp
description: Full IVP modularization — run the six-step process end to end on a codebase (identify elements, identify change drivers, build Γ, assess the current modularization, refactor to the Γ-equivalence partition with guarded nesting, verify to convergence), with review gates between the steps. Use to modularize a codebase by IVP from scratch or after a domain change.
argument-hint: <scope> [<artifact-dir>]
---

# IVP — Apply the Principle (six steps)

Orchestrates the whole application process. Each step is owned by one agent, and
two review gates must converge before the next step starts. Do not skip a step;
do not skip a gate.

IVP is applied as a **criterion**, not a recipe: the target structure is the
Γ-equivalence partition `P_Γ`, read off the change drivers. You do not design a
module tree; you read one.

## Parameters

`$ARGUMENTS` =

- `<scope>` — codebase root or glob (default: repo root).
- `<artifact-dir>` — optional directory of domain artifacts to anchor drivers.

## Step 0 — Scope, grain, and applicability

Confirm, in one line each: the system boundary, the element grain (function,
class, module, config key), and the artifacts available to anchor drivers.
Depth is proportionate to the system's expected lifetime and rate of change.
State the grain explicitly — `Γ` is meaningless without it, and one run uses one
grain only.

Then check the four applicability gates. If any gate fails, report
`NOT APPLICABLE` with the reason and stop — do not manufacture a `Γ` to satisfy
the request.

| Gate | Requirement |
|---|---|
| G1 | A system boundary and one element grain can be stated |
| G2 | Driver candidates are anchorable in governing artifacts |
| G3 | `E` and `C` are finite and listable at that grain |
| G4 | The question is placement; IVP does not decide correctness, performance, security, deployment, or team allocation |

## Steps 1–3 — Elements, drivers, Γ

Run the `/identify-change-drivers` flow, or its agent `driver-identifier`:

1. **Identify the elements.** Enumerate every element at the chosen grain.
   Record `file:line`.
2. **Identify the change drivers.** Discovery, not invention. Apply *who asks
   for this change?* and the *independent clock* test, then the counterfactual
   test per candidate edge. Anchor each driver in a governing artifact. Never
   fabricate an artifact.
3. **Map drivers to elements.** Build `Γ : E → 2^C`. Enforce IVP-1
   (`|Γ(e)| ≥ 1`) and record IVP-2 form per element (single-driver or
   irreducibly composite; decompose reducible composites recursively).

**Gate A — driver convergence.** Run `/review-ivp-to-convergence drivers`.
`Γ` is the input to every later step; an unaudited `Γ` makes the result optimal
for the wrong system (hypothesis S2). Do not proceed while critical findings
remain.

## Step 4 — Assess the current modularization

Run `/assess-ivp` (or `current-modularization-auditor`) — report-only. Record
the baseline: which modules are mixed (IVP-3), which classes are scattered
(IVP-4), the element defects, and the unnecessary touches per driver. The
baseline is what step 6 compares against; without it you cannot show improvement.

## Step 5 — Refactor toward compliance

### Checkpoint first

Before any file moves, require a clean working tree (`git status --porcelain`
empty). A dirty tree means the session cannot separate IVP moves from prior
work — stop and ask the user to commit or stash. Record the baseline commit hash
and report it. Create one checkpoint commit after Phase C passes.

Run `/sort-into-modules`:

- **Phase A** — `gamma-modularizer` builds the flat Γ-equality partition:
  identical `Γ(e)` together (IVP-4), different `Γ(e)` apart (IVP-3). Exact
  equality only; a shared subset is not a shared module.
- **Phase B** — `nest-decider` decides siblings vs parent/child. Nesting is a
  harness extension, not part of `prc:ivp`: nest iff `Γ(P) ⊊ Γ(C)` **and** the
  child is a reducible composite (Case 2). Never force-split a single-driver
  element or an irreducible composite.
- **Phase C** — placement verification with `ivp-refactor-auditor`. No element
  may sit in the wrong module when the phase reports success.

**Gate B — structure convergence.** Run
`/review-ivp-to-convergence refactor` to convergence, then verify the tree
builds.

## Step 6 — Verify and iterate

1. **Re-check against the baseline.** Compare step 4's numbers with the new
   structure: unnecessary touches per driver before and after. Report both.
   Never report the *required* change set as a cost — that is the domain's
   structure, and IVP cannot reduce it.
2. **State the hypothesis status honestly.** Every optimality claim needs
   S1–S2, T1–T4, M2–M3, and the `Ω` boundary-cost exclusion
   (`ivp-knowledge.md` §3 "What is a theorem, not a statement"). If `Ω` is not negligible for this system, say so:
   the target remains `P_Γ`, but its optimality claim does not hold as stated.
3. **Name the revisit conditions.** `Γ` changes when the domain changes —
   a new regulation, a harmonised regulation that collapses two drivers, a new
   platform. Write them down beside the registry.
4. **Record what stayed out of scope.** `Ω`, other axes (performance, security,
   deployment, team allocation), and any element you could not anchor. IVP
   answers one question: where does each element belong.

## Guards

- **Gates first.** If a G1–G4 gate fails, report `NOT APPLICABLE` and stop. Do
  not weaken the model to fit the request.
- One step per gate. Do not start step 5 while Gate A is open; do not report
  success while Gate B is open.
- **Clean tree before moves.** No refactor on a dirty working tree. Record the
  baseline commit; make one checkpoint commit after Phase C.
- `Γ` is fixed by step 3 and audited at Gate A. Step 5 changes placement only —
  never assignments.
- No driver ranking, no proxy grounding, no driver elimination, no
  existence-by-probability, no causal reversal (see `ivp-knowledge.md` §4 "Change driver", §11 "Prohibited framings").
- Do not call a multi-driver module a violation when its elements share one
  irreducible assignment set. Purity is per module, never per namespace.
- Report-only steps stay report-only: step 4 never edits.
- Do not adopt an optimality claim into the report unless the ledger holds. A
  compliance result needs no hypothesis; do not dress it as an optimality result.
- If the driver analysis is underdetermined, stop and ask for artifacts. A
  guessed `Γ` produces a confident wrong structure.

## Output

```
=== IVP APPLICATION: <scope> ===
Gates: G1 ok  G2 ok  G3 ok  G4 ok        (else: NOT APPLICABLE — reason)
Grain: <unit>   Elements: N   Drivers: K

Step 1-3: registry written at <path> (status PROVISIONAL → AUDITED)
Gate A (drivers): CONVERGED (round n, 0 findings)
Step 4 (baseline): IVP-3 violated in n modules, IVP-4 in m classes,
                   unnecessary touches: γ_a=..., γ_b=...
Baseline commit: <hash>   Working tree: clean
Step 5: P_Γ classes: k   modules: k   nesting edges: j (guarded)
Gate B (structure): CONVERGED (round n, 0 findings)   Build: PASS
Step 6: unnecessary touches before → after; revisit conditions listed
Hypotheses: S1 <ok|not asserted>  S2 <ok|provisional>  T1-T4 <ok>  M2-M3 <ok>
            Ω <negligible|not negligible — claim bounded>

RESULT: <n> modules, <m> moves, <t> unnecessary touches removed
```

## See also

- `/identify-change-drivers` — steps 1–3 only.
- `/assess-ivp` — step 4 only, report-only.
- `/sort-into-modules` — step 5 only.
- `/review-ivp-to-convergence` — the gates.
- `ivp-knowledge.md` — the reference this skill applies.
