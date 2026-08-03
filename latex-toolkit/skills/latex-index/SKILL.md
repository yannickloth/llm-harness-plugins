---
name: latex-index
description: Audit \index coverage — verify key terms, theorems, definitions, and named concepts are indexed, and index entries are consistent. Delegates to latex-index-auditor.
compatibility: Requires latexmk (TeX Live)
---
# LaTeX Index Audit

Audits \index coverage and consistency. Delegates to `latex-index-auditor`.

Usage: `/latex-index <scope>`
- Scope: file path or glob. Required.

Agent: `latex-index-auditor` — read-only; checks key terms, theorems, definitions, named concepts are indexed, entries are consistent.
