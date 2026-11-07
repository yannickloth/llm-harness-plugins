---
description: IVP step 5 — refactor elements into the Γ-equivalence partition, then decide guarded nesting
agent: gamma-modularizer
---
Load the skill `sort-into-modules` and apply it. This is step 5 of IVP: build
the flat Γ-equality partition (identical `Γ(e)` together, different `Γ(e)`
apart), then hand the nesting decision to `nest-decider`.

Scope: $ARGUMENTS

Preconditions — check them before any file moves, and stop if one fails:
1. an **audited** registry exists (Gate A converged). A provisional `Γ` must not
   drive a refactor;
2. the working tree is clean (`git status --porcelain` empty). Report the
   baseline commit hash; a dirty tree means the moves cannot be separated from
   prior work;
3. step 4 has run, so the before/after comparison has a baseline.

Guards from the skill that must hold:
- `Γ` is fixed and audited — you change placement only, never assignments;
- exact set equality is a module; a shared subset is not;
- never force-split a single-driver element or an irreducible composite.

After Phase C, verify the tree builds and point at
`/review-ivp-to-convergence refactor` for Gate B.

The canonical reference is `ivp-knowledge.md` in this plugin's `prompts/`
directory; your system prompt states its absolute path.
