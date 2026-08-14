---
name: naturalize
description: Audit writing for AI-generated markers and robotic patterns, then rewrite flagged passages as natural human prose. Domain-aware: `general` mode for any prose; `scientific` mode adds formal-environment and controlled-vocabulary constraints for articles, papers, and book volumes. Delegates to natural-prose-auditor then natural-prose-naturalizer.
argument-hint: <scope> [domain]
compatibility: Requires read/write access to content files
---

# Naturalize — AI-Prose → Human Prose

Two-phase naturalisation pass. Delegates to `natural-prose-auditor` then
`natural-prose-naturalizer`.

Usage: `/naturalize <scope> [domain]`

- `<scope>` — file path or glob. Required.
- `[domain]` — `general` (default) or `scientific`. Determines which reference
  the agents load and which constraints apply.

## Domain choice

| Domain | Use for | Constraints |
|--------|---------|-------------|
| `general` | reports, docs, prose, notes, articles (non-formal) | core registry only |
| `scientific` | formal papers, book volumes, `.typ` chapter prose | core + formal-environment preservation, notation, controlled vocabulary, British English, modal discipline |

## Flow

1. **Audit.** Run `natural-prose-auditor` with the active domain. It produces a
   grouped findings report (Structural / Lexical / Syntactic / Rhetorical) with
   severities and quoted text.
2. **Naturalise.** Run `natural-prose-naturalizer` with the active domain on the
   flagged passages. It rewrites to natural prose, preserving formal content
   (scientific mode) and never introducing new facts.
3. **Verify.** For `.typ`/`.tex` sources, build to confirm nothing broke:
   `nix build .#typst-volume-N` or `typst compile --root . <file>`.

## Agents

- `natural-prose-auditor` — read-only; flags AI markers and missing human
  targets; groups findings by category with severity; applies domain
  tolerances; may use `ProsePatternAnalyzer.java` as a cross-reference.
- `natural-prose-naturalizer` — edits flagged passages to natural prose,
  preserving domain-appropriate conventions and (scientific mode) all formal
  content.

## See also

- `/style` (general-skills) — the generic style audit pass; `naturalize`'s
  `general` mode overlaps but adds the positive human targets and the
  structural-rewrite principle.
- `scientific-ai-prose.md` — the scientific registry (loaded by scientific mode).
