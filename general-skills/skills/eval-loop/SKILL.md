---
name: eval-loop
description: Deterministic self-correcting eval loop — exec → score → fix → re-run until green or rounds exhausted. Use when iterating on a fallible task until its gates pass, converge-to-green, eval loop, self-correcting implementation, fix failures then re-run. Use ONLY when there is a runnable artifact with a project-declared binary gate set. NOT for prose/structure review (use review-convergence), NOT for runtime model routing, NOT for LLM-judge scoring.
argument-hint: <gate=command...> [rounds=N]
---

# Eval Loop (self-correcting)

Generic, stateless self-correcting loop. Per-session state only. Deterministic gates. Bounded retries. No persistent memory, no cross-session feedback, no curator, no LLM-judge.

Eval-agnostic. A *code* eval (compile → test → integration) is one instance; the loop also covers data pipelines, schema validation, deployment dry-runs, doc builds — any reproducible task with binary pass/fail gates and a corrective action.

## Parameters

`$ARGUMENTS` = space/nl-separated `gate=<command>` in gate order, plus optional `rounds=N`. Commands containing spaces must be quoted: `gate="mvn -q test"`.

Correctors are per-gate wiring: `corrector=<agent>`, matched to gates by position (first corrector → first gate, etc.).

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

1. Run **all** gates to completion; stop early only when a gate errors before it can run (missing executor)
2. For each failing gate, dispatch its positional corrector → apply fixes → next round
3. All gates pass → **green**; write final snapshot; report
4. **UPDATE** — append snapshot to history (`<project>/tmp/eval-loop-history.md`); compute progress = pass-set strictly grows vs prior round
5. **DECIDE:**
   - no progress vs prior round → stop-and-report (avoid oscillation)
   - rounds exhausted → abort
   - else → next round

## Corrector Dispatch

Corrective agent set = **project wiring** passed via `$ARGUMENTS`, one corrector per gate in gate order. Each gate's failure dispatches the corrector wired at the same position. Illustrative wiring for a code eval:

| Gate | Corrector (project-defined) |
|------|------------------------------|
| 1 compile | a build/style expert |
| 2 test | a test expert |
| 3 verify | a deploy/integration expert |

Names above are placeholders — the project supplies the actual expert agents. If the wired corrector is absent → report, do not fabricate.

## Abort & Report

On abort, report:
- failing gate (which gate, last result)
- rounds used / cap
- best snapshot (last round's full pass-set — monotonic growth means this is the max)

## Constraints

- Stateless across sessions — do not read prior-session history as input
- Fix only what the failing gate signals — no drive-by changes
- Unsure → flag, don't change
- No invented fixes/claims
- History lives under `tmp/` — never under `.claude/`, never committed
