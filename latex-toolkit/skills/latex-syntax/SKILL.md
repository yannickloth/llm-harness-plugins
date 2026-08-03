---
name: latex-syntax
description: Fix LaTeX compilation errors and warnings in .tex files. Delegates to latex-syntax-fixer. Use when latexmk or pdflatex build fails.
compatibility: Requires latexmk (TeX Live)
---
# LaTeX Syntax Fix

Fixes LaTeX compilation errors and warnings. Delegates to `latex-syntax-fixer`.

Usage: `/latex-syntax <scope>`
- Scope: file path or glob. Required.

Agent: `latex-syntax-fixer` — fixes compilation errors and warnings in .tex files.
