---
name: review-convergence
description: Meta-skill — per-region sliding-window review-fix loop. Round 1 covers everything; later rounds cover only regions changed in the previous two rounds that have not converged. Parameterized by reviewer/criteria list.
argument-hint: <reviewer-or-criterion> [<scope>]
---

# Review Convergence (per-region sliding window)

Meta-skill. Runs review-fix rounds until every region has converged. Round 1 is
the only complete pass; every later round audits **only muddy water** — regions
recently changed that have not yet converged. Cleared ground is not re-audited.

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

## Core model

- **Region** = one file, or a line range inside a large file. Fix the
  granularity once at round 1; keep it stable for the whole loop.
- **Change** = any edit to a region made during a round's FIX phase.
- **Review set, round N:**
  - `N = 1` — every region in scope (the broad pass).
  - `N > 1` — regions changed during round `N-1` or round `N-2`, minus regions
    already converged.
- **Converged (eliminated):** a region whose two most recent in-window review
  rounds both returned zero findings for it, and which has not been changed
  since. Eliminated regions are never re-reviewed on schedule. Elimination is
  the converged state — not a parked, deferred, or ledgered state.
- **Re-add (cleared regions can come back):** a region eliminated in an earlier
  round may be changed in a later round — directly, or indirectly when a fix
  elsewhere requires editing it. Any such change re-adds the region as a review
  target, with its clean history reset. A previously converged region that must
  be modified converges again the same way: two clean rounds over the new
  content.
- **Termination:** the review set computed for the next round is empty →
  converged; stop. Round 10 with findings still open → halt; report remaining
  findings for human review.

There is no global counter. Two regions can be clean while a third re-opens;
only per-region state decides what is reviewed next.

## Findings discipline

- A finding is **fixed** in the current batch, or **flagged for human review**
  when it cannot be verified or fixed unambiguously. No third state exists.
- Never park open findings in a ledger, backlog, or known-issues file as a step
  toward convergence. An unresolved finding means its region is not converged.
- Do not cite a ledger entry as closure. Closure = the text is correct.

## Protocol

Per round (R1, R2, ...):

1. **COMPUTE REVIEW SET** — from the window rule (R1: everything). State the set
   and why each region is in it (initial / changed R-1 / changed R-2).
2. **REVIEW** — apply each specified reviewer/criterion **against the review set
   only**. Collect findings per region (severity + location + description + fix).
3. **FIX** — apply unambiguous fixes. Ambiguous/conflicting → flag for human
   review; skip.
4. **SELF-AUDIT the batch before closing the round** — this is what keeps the
   window from re-opening on your own fixes:
   - every cross-reference/locator added resolves to a target containing the
     claimed content;
   - arithmetic re-checked on every number the batch touched;
   - family-grep: for each hedge, correction, or disclosure added, grep the
     whole scope for every other site stating the same readout and fix all of
     them in the same batch. A correction that lands at one site while its
     family persists elsewhere is the defect class that re-opens regions.
   - minimal prose: smallest edit that fixes the finding; every new sentence is
     new attack surface.
5. **VERIFY** — if build/lint/test is relevant to the scope, run it. Failure → halt.
6. **REPORT:**
   ```
   Round RN: review set = [regions]; findings by region {region: count}
     (A from reviewer-1, B from reviewer-2) — fixed
   Changed this round: [regions]
   Next round's review set: [regions]
   Converged and eliminated: [regions with two clean rounds]
   ```
7. **DECIDE:** build the next round's review set from the window rule; stop when
   empty.

## Gotchas

- The round-1 broad pass is the only complete pass. Its quality sets the floor
  for everything the window eliminates — a shallow broad pass eliminates
  under-reviewed regions. Do not let R1 be a skim.
- Cleared ≠ permanent: a region cleared in earlier rounds can be changed in
  later rounds — directly, or because a fix elsewhere requires it. Every such
  change re-adds it as a review target. Expect eliminated regions to re-enter;
  that is the model working, not a failure of it.
- A round with zero findings over a non-empty set eliminates those regions; the
  next set is whatever else is still in its window, else empty → stop.
- Do not re-audit cleared ground to "be safe" — that is how this loop used to
  burn rounds without converging. If a region is converged and untouched, it is
  out of scope.

## Checkpoint

Every 3 rounds → write a continuation checkpoint (region state table — region /
last change round / last reviewed round / clean-round count / converged — plus
round, reviewers, remaining findings, resume steps) to an **ephemeral,
out-of-repo** location — never into the working tree, `tmp/`, or any tracked
config directory:

- Prefer `$XDG_RUNTIME_DIR/review-convergence-checkpoint.md` (tmpfs, user-private).
- Fallback if `$XDG_RUNTIME_DIR` is unset: `$TMPDIR` or `~/.cache/review-convergence-checkpoint.md`.
- Checkpoint is a throwaway resume aid. Do not commit it; delete it once the loop converges.

## Constraints

- Only fix what a reviewer flags — no drive-by refactors
- Unsure → flag for human review, don't change
- No invented content/claims
- Defer to each reviewer's own constraints
