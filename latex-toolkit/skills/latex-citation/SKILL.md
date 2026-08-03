---
name: latex-citation
description: Verify all LaTeX \cite citations resolve against the bibliography file and check consistency in .tex files. Delegates to latex-citation-checker.
compatibility: Requires latexmk (TeX Live)
---
# LaTeX Citation Check

Verifies LaTeX citations against the bibliography. Delegates to `latex-citation-checker`.

Usage: `/latex-citation <scope>`
- Scope: file path or glob. Required.

Agent: `latex-citation-checker` — read-only; finds undefined citations, checks bibliography consistency in .tex files.
