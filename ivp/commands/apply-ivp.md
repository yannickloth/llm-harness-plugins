---
description: Run the full six-step IVP process on a codebase, with both review gates
agent: build
---
Load the skill `apply-ivp` and run the six-step process end to end on the scope
below. Do not skip a step and do not skip a gate.

Scope: $ARGUMENTS

Order of work:
0. State boundary, grain, and artifacts. Check gates G1–G4 — report
   `NOT APPLICABLE` and stop if one fails.
1–3. Run `/identify-change-drivers`: elements, drivers, `Γ`.
   **Gate A** — `/review-ivp-to-convergence drivers`. Do not continue while
   critical findings remain.
4. `/assess-ivp` — the report-only baseline.
5. `/sort-into-modules`, after recording the baseline commit and confirming a
   clean tree. **Gate B** — `/review-ivp-to-convergence refactor`, then build.
6. Compare against the baseline, state the hypothesis status honestly, and name
   the revisit conditions.

Report with the output block the skill specifies.

The canonical reference is `ivp-knowledge.md` in this plugin's `prompts/`
directory; your system prompt states its absolute path.
