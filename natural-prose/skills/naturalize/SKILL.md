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

0. **Resolve scope to the FULL transitive document set.** A `.typ` file is
   complete with its transitive `#include`s, and a real audit covers every
   transitively-included file. Resolve the full include graph recursively
   (every `#import`/`#include`/`\input`/`\include`, followed transitively),
   NOT just the aggregator's direct chapters. Use
   `TypstIncludeResolver.java` (sibling tool) when available:
   ```bash
   java <tools-path>/TypstIncludeResolver.java <root.typ>
   ```
   This lists every reachable `.typ` file. Classify the result into
   (a) expository prose chapters — always audit; (b) `shared/**` formal
   definitions/claims/proofs — audit the prose *inside* the environments
   (they are terse by design, so expect few findings, but do not skip them);
   (c) `lib/**` and infrastructure files — NOT prose (only `#show`/`#let`/
   function definitions); do not run a prose analyzer on them. If the scope
   resolves to zero prose-bearing files, stop and confirm the intended scope.
1. **Deterministic scan (mandatory).** Extract the prose (strip Typst/LaTeX
   markup, `@labels`, `$math$`, `#...(...)` calls, bold markers) and run
   `ProsePatternAnalyzer.java` on EVERY prose-bearing file in the resolved
   set — the expository chapters AND the `shared/` files — with the active
   domain:
   ```bash
   java <path-from-tool> <file> [--domain scientific]
   ```
   Resolve the analyzer path with the `naturalize-analyzer-path` tool (never
   hardcode or search). If it returns NOT FOUND, STOP and report it.
   Record the pattern findings and the statistical layer (burstiness, entropy,
   perplexity). This is objective and cheap; it runs first so the LLM audit has
   a cross-reference to check against. If the analyzer is unavailable, STOP and
   report that it could not run — do not silently skip it.
2. **Audit.** Run `natural-prose-auditor` with the active domain, passing it the
   deterministic scan output. It produces a grouped findings report (Structural
   / Lexical / Syntactic / Rhetorical) with severities and quoted text, and
   reconciles its contextual read against the deterministic scan.
3. **Naturalise.** Run `natural-prose-naturalizer` with the active domain on the
   flagged passages. It rewrites to natural prose, preserving formal content
   (scientific mode) and never introducing new facts. The naturalizer loads the
   project's house-style guide first and will NOT rewrite patterns the project
   explicitly endorses (inline enumeration, finding blocks, deliberate rhetoric).
4. **Verify.** For `.typ`/`.tex` sources, build to confirm nothing broke:
   `nix build .#typst-volume-N` or `typst compile --root . <file>`.

## Agents

- `natural-prose-auditor` — read-only; flags AI markers and missing human
  targets; groups findings by category with severity; applies domain
  tolerances; reconciles with the deterministic `ProsePatternAnalyzer.java`
  scan (which the skill runs first).
- `natural-prose-naturalizer` — edits flagged passages to natural prose,
  preserving domain-appropriate conventions and (scientific mode) all formal
  content. It also adds reader-guidance connective tissue where it is missing.

## See also

- `/style` (general-skills) — the generic style audit pass; `naturalize`'s
  `general` mode overlaps but adds the positive human targets and the
  structural-rewrite principle.
- `scientific-ai-prose.md` — the scientific registry (loaded by scientific mode).
- `reader-guidance-phrases.md` — the six transition functions and rules the
  agents use to guide the reader through the artifact (non-exhaustive).
