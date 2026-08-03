---
name: review-convergence
description: Meta-skill — review-fix loop to zero findings (2 consecutive clean rounds). Parameterized by reviewer/criteria list.
argument-hint: <reviewer-or-criterion> [<scope>]
---

# Review Convergence

Meta-skill. Runs review-fix rounds until 2 consecutive zero-finding rounds or max 10 rounds.

## Parameters

`$ARGUMENTS` = space-separated list of reviewers/criteria + optional scope.

Each reviewer is either:
- A named skill (`/review-typst`, `/review-style`, `/review-formalism`)
- A named agent (from `.claude/agents/`)
- An ad-hoc criterion in quotes: `"check for NPEs"` / `"audit boundary conditions"` / `"find dead code"`
- A project-relative file/glob to scope reviews to

**Guards:**
- Empty `$ARGUMENTS` → ask what to review; do not proceed
- Skill/agent not found → report; halt

## Protocol

Per round:

1. **REVIEW** — apply each specified reviewer/criterion against scope. Collect findings (severity + location + description + fix).
2. **FIX** — apply unambiguous fixes. Ambiguous/conflicting → flag, skip.
3. **VERIFY** — if build/lint/test is relevant to the scope, run it. Failure → halt.
4. **REPORT** — `Round RN: N findings (A from reviewer-1, B from reviewer-2) — fixed`
5. **DECIDE:**
   - findings > 0 AND round < 10 → next round
   - findings = 0 → if prior round also 0 → **converged**; else next round (confirmation pass)
   - round ≥ 10 AND findings > 0 → halt; report stranded findings

**Convergence = 2 consecutive rounds of 0 findings.**

## Checkpoint

Every 3 rounds → `tmp/review-checkpoint-convergence.md`: round, reviewers, cumulative findings, stranded issues, resume steps.

## Constraints

- Only fix what a reviewer flags — no drive-by refactors
- Unsure → flag, don't change
- No invented content/claims
- Defer to each reviewer's own constraints
