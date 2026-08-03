---
name: typst-citation
description: Verify all Typst @key citations resolve against the bibliography file and check consistency in .typ files. Delegates to typst-citation-checker.
compatibility: Requires typst (typst compile)
---
# Typst Citation Check

Verifies Typst citations against the bibliography. Delegates to `typst-citation-checker`.

Usage: `/typst-citation <scope>`
- Scope: file path or glob. Required.

Agent: `typst-citation-checker` — read-only; finds undefined citations, checks bibliography consistency in .typ files.
