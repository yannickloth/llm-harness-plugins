---
name: latex-notation
description: Audit LaTeX source files for notation consistency against a notation reconciliation document. Detects symbol drift across files. Delegates to latex-notation-consistency-checker.
compatibility: Requires latexmk (TeX Live)
---
# LaTeX Notation Consistency

Checks notation consistency across .tex files. Delegates to `latex-notation-consistency-checker`.

Usage: `/latex-notation <scope>`
- Scope: file path or glob. Required.

Agent: `latex-notation-consistency-checker` — read-only; catches symbol drift across files against a notation reconciliation document.
