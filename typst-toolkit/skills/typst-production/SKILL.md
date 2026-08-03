---
name: typst-production
description: Scan Typst files for TODOs, placeholders, debug artifacts, LaTeX remnants, and production readiness issues. Delegates to typst-production-readiness-checker.
compatibility: Requires typst (typst compile)
---
# Typst Production Readiness

Pre-release scan of Typst files. Delegates to `typst-production-readiness-checker`.

Usage: `/typst-production <scope>`
- Scope: file path or glob. Required.

Agent: `typst-production-readiness-checker` — read-only; scans for TODOs, placeholders, debug artifacts, LaTeX remnants in .typ files.
