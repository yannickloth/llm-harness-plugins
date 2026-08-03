---
name: eval-loop
description: Deterministic self-correcting eval loop — exec → score → fix → re-run until green or rounds exhausted. Use when iterating on a fallible task until its gates pass, converge-to-green, eval loop, self-correcting implementation, fix failures then re-run. Use ONLY when there is a runnable artifact with a project-declared binary gate set. NOT for prose/structure review (use review-convergence), NOT for runtime model routing, NOT for LLM-judge scoring.
argument-hint: <gate=command...> [rounds=N]
---

# Eval Loop (self-correcting)

Generic, stateless self-correcting loop. Per-session state only. Deterministic gates. Bounded retries. No persistent memory, no cross-session feedback, no curator, no LLM-judge.

Eval-agnostic. A *code* eval (compile → test → integration) is one instance; the loop also covers data pipelines, schema validation, deployment dry-runs, doc builds — any reproducible task with binary pass/fail gates and a corrective action.

## Parameters

`$ARGUMENTS` = space/nl-separated `gate=command...` in gate order, plus optional `rounds=N`.

Gates are **project configuration** passed in, not hardcoded here. Example code instance:

- `compile=...` — build; pass/fail
- `test=...` — test; pass/fail
- `verify=...` — optional integration/verification gate; pass/fail

**Guards:**
- No gates declared → ask; do not proceed
- Missing executor invoked by a gate → report; halt

## Per-Run Scoring

Binary pass/fail per gate. Snapshot each run to a session-local file:

`<project>/tmp/eval-loop-score.md` — append one line: `round, gate, pass/fail, elapsed?`.

Score = ordered pass-set (bit per gate), in declared gate order.

## Loop

Per round (cap default 5 unless `rounds=N`):

1. Run gates in order until one fails
2. Failing gate → dispatch its corrector → fix → next round
3. All gates pass → **green**; write final snapshot; report
4. **UPDATE** — append snapshot to history (`<project>/tmp/eval-loop-history.md`); compute monotonic progress (pass-set grows or strictly non-decreasing)
5. **DECIDE:**
   - no progress vs prior round → stop-and-report (avoid oscillation)
   - rounds exhausted → abort
   - else → next round

## Corrector Dispatch

Corrective agent set = **project wiring**. Map each failure class to the corrector the project has defined. Example code wiring:

| Failure class | Corrector role |
|---------------|----------------|
| compile / style | modern-java-agent (if wired) |
| test failures | test-writer (if wired) |
| build / wiring | quarkus-expert / maven-expert (if wired) |

For non-code instances, wire the class to the relevant expert (e.g. schema/dtla → data-expert). If the wired corrector is absent → report, do not fabricate.

## Abort & Report

On abort, report:
- failing gate (which gate, last result)
- rounds used / cap
- best snapshot (max pass-set from history)

## Constraints

- Stateless across sessions — do not read prior-session history as input
- Fix only what the failing gate signals — no drive-by changes
- Unsure → flag, don't change
- No invented fixes/claims
- History lives under `tmp/` — never under `.claude/`, never committed
