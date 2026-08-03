---
name: latex-xref
description: Verify all LaTeX cross-references (\ref, \cref, \pageref, \autoref, \nameref, \eqref) resolve within and across .tex files. Delegates to latex-xref-checker.
compatibility: Requires latexmk (TeX Live)
---
# LaTeX Cross-Reference Check

Verifies LaTeX cross-references. Delegates to `latex-xref-checker`.

Usage: `/latex-xref <scope>`
- Scope: file path or glob. Required.

Agent: `latex-xref-checker` — read-only; verifies \ref, \cref, \pageref, \autoref, \nameref, \eqref resolve within and across .tex files.
