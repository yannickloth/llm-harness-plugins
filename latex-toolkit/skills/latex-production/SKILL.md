---
name: latex-production
description: Scan LaTeX files for TODOs, placeholders, debug artifacts, draft mode, and production readiness issues. Delegates to latex-production-readiness-checker.
compatibility: Requires latexmk (TeX Live)
---
# LaTeX Production Readiness

Pre-submission scan of LaTeX files. Delegates to `latex-production-readiness-checker`.

Usage: `/latex-production <scope>`
- Scope: file path or glob. Required.

Agent: `latex-production-readiness-checker` — read-only; scans for TODOs, placeholders, debug artifacts, draft mode in .tex files.
