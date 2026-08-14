---
name: naturalize-judge
description: Run an LLM naturalness/perplexity judgment pass on prose. Uses the session model as a second-opinion naturalness rater (passage-by-passage, 1-10), complementing the deterministic statistical layer from ProsePatternAnalyzer. For any prose; scientific domain for formal/academic text. Delegates to natural-prose-perplexity-judge.
argument-hint: <scope> [domain]
compatibility: Requires read access to content files
---

# Naturalize-Judge — LLM Naturalness / Perplexity Judgment

Second-opinion naturalness pass. Complements the deterministic statistical
layer and the pattern audit.

Usage: `/naturalize-judge <scope> [domain]`

- `<scope>` — file path or glob. Required.
- `[domain]` — `general` (default) or `scientific`. Sets the judge's domain
  awareness (formal/academic tolerance).

## What this is

A SUBJECTIVE LLM judgment, not measured perplexity. The session model reads each
passage and rates how naturally human it reads, exactly as a trained language
model perceives text predictability. It is a cross-check, never an authorship
verdict.

## Flow

1. **Statistical layer (mandatory).** Extract the prose (strip markup) and run
   `ProsePatternAnalyzer.java` on every prose-bearing file with the active
   domain:
   ```bash
   java <path-from-tool> <file> [--domain scientific]
   ```
   Resolve the analyzer path with the `naturalize-analyzer-path` tool (never
   hardcode or search). If it returns NOT FOUND, STOP and report it.
   If the analyzer is unavailable, STOP and report that it could not run — do
   not silently skip the deterministic baseline.
2. **Judge.** Run `natural-prose-perplexity-judge` on the scope, passing it the
   statistical-layer output. It rates each file 1-10, notes predictability,
   checks positive human markers (voice, specificity, stance, reader guidance)
   against the loaded registry, quotes findings with file:line, and ranks
   "naturalise first" candidates.
3. **Reconcile.** Compare the judge's ratings against the statistical layer.
   Agreement = high confidence; disagreement = note it, do not silently override.
4. **Report.** Overall verdict + ranked naturalisation list. If the user asked
   for fixes, hand the flagged passages to `natural-prose-naturalizer`.

## Honesty rules (enforced by the agent, restated for the orchestrator)

- This is judgment, NOT perplexity. Never present a rating as measured perplexity.
- Never cite a rating as evidence of AI authorship.
- Never ask the author to chase a score.
- Formal/scientific prose legitimately reads measured; low "burstiness" there is
  the scientific caveat, not an AI marker.

## See also

- `/naturalize` — the audit + rewrite naturalisation pass (pattern-based).
- `natural-prose-perplexity-judge` — the rating agent.
- `ProsePatternAnalyzer.java` — the deterministic statistical layer.
