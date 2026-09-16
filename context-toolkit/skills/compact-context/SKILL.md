---
name: compact-context
description: Compact a context file (AGENTS.md, memory, instructions) to reduce token cost while preserving semantic equivalence. Archives the original with a timestamp, rewrites the file in place, then runs repeated review-fix rounds (via the context-fidelity-auditor agent) until two consecutive rounds report zero issues.
argument-hint: <path-to-context-file>
---

# Compact Context

Compacts a Markdown context file in place. The original is archived (renamed
with a timestamp suffix), the compacted version takes the original filename,
and semantic fidelity is verified against the archived original.

## Input

A path to a Markdown context file (AGENTS.md, memory file, instruction file).
If the argument is missing, ask for the path — never guess.

## Flow

1. **Assess:** read the file and judge whether meaningful compaction is
   possible. A file already written in telegraphic style (tables/lists,
   little prose, no restatements) cannot be compacted further without loss —
   such a file is not "too small", it is already compact. If the estimated
   size reduction is <10%, stop and report that — do not archive, do not
   rewrite.
2. **Confirm:** state the estimated saving and the compaction strategy;
   proceed only after the user agrees.
3. **Archive:** rename the original to `<name>.<ext>.archive-<YYYYMMDD-HHMMSS>`
   (same directory). This file is the verification ground truth — never modify
   or delete it.
4. **Compact** and write the result to the original path. Apply the
   compaction rules below.
5. **Review:** dispatch the `context-fidelity-auditor` agent, passing both
   file paths (archived original + compacted file). It returns a list of
   issues or an empty list.
6. **Fix:** repair the compacted file for each issue found.
7. **Repeat steps 5–6** until convergence: convergence is reached only when
   **two consecutive review rounds** each report zero issues. Do not stop
   after a single clean round.
8. **Report** the result: original size, compacted size, rounds run, archive
   path.

## Compaction rules

| Rule | Detail |
|------|--------|
| Preserve facts | Every constraint, rule, threshold, path, identifier, command, API name, and numeric value must survive verbatim |
| Preserve intent | Directives ("never", "always", "ask first") keep their force; do not soften or strengthen them |
| Compress form | Prose → telegraphic tables/lists; drop filler words and restatements |
| Keep structure signals | Section intent must remain recognizable (heading or equivalent label) |
| Code examples | Preserve verbatim and complete — never summarize code |
| No new content | Never add rules, facts, or examples that were not in the original |
| No lossy paraphrase | If a rewrite could plausibly change behavior, keep the original wording |

## Guard

- Never fabricate: every claim in the compacted output must trace to the
  original. When in doubt, keep the original text.
- Never delete the archive file; it is the audit trail.
- This skill only compacts context/instruction files. Do not use it on
  source code, tests, or data files.
