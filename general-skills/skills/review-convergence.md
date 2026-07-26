---
name: review-convergence
description: Generic review-fix convergence loop — orchestrates specialized review/audit skills to zero findings (2 consecutive clean rounds). Metaskill: requires one or more specific review skills to be called.
argument-hint: <skill-name> [<file-scope>]
---

# Review Convergence

Iterative review-fix loop until convergence (two consecutive zero-finding rounds) or max rounds. Metaskill — MUST be used with one or more domain-specific review/audit skills.

## Arguments

- `$ARGUMENTS` — skill name(s) to invoke + optional file scope (e.g., `review-chapter src/main/chapter-3`, `review-adversarial CLAUDE.md`)
- **Guard:** empty/blank → ask user which review skill(s) to run; do not start without specified skills
- **Guard:** skill not found → report; do not run

## Protocol

Per round (R1, R2, ...):

1. **INVOKE** — For each specified review skill, invoke it with the file scope. The called skill determines its own audit criteria and fix strategy.

2. **COLLECT** — Gather findings from all invoked skills. Count total findings (critical + major + minor).

3. **FIX** — Apply all unambiguous fixes reported by the invoked skills.

4. **VERIFY** — If any invoked skill specifies a validation step (build, lint, tests), run it now. Verification failure → stop and report.

5. **REPORT:**
   ```
   Round RN: X findings from Y skills — fixed
   By skill: skill-A: A1 findings, skill-B: B1 findings
   ```

6. **DECIDE:**
   - findings > 0 AND round < 10 → next round
   - findings = 0 → increment consecutive-clean counter (resets to 0 on any round with findings > 0)
     - counter < 2 → next round (confirmation pass)
     - counter ≥ 2 → declare convergence; stop
   - round = 10 AND findings > 0 → stop; report remaining findings for human review

**Convergence = 2 consecutive rounds of 0 findings across ALL invoked skills.**

## Checkpoint

Every 3 rounds → write continuation checkpoint to `tmp/review-checkpoint-convergence.md`:
- Invoked skills + file scope + current round
- Cumulative findings by skill
- Remaining known issues
- Exact next steps to resume

## Constraints

- Do NOT invent content or factual claims
- Do NOT add content beyond what is needed to fix a finding
- Do NOT refactor code that is not broken
- Unsure about a finding → flag for human review; do not change
- Respect each invoked skill's own constraints
- A single clean round is insufficient — require two consecutive zero-finding rounds
