---
name: typst-format
description: Convert Markdown/LaTeX formatting remnants to proper Typst syntax and normalize formatting conventions in .typ files. Delegates to typst-formatting-fixer.
compatibility: Requires typst (typst compile)
---
# Typst Format Fix

Converts formatting to proper Typst. Delegates to `typst-formatting-fixer`.

Usage: `/typst-format <scope>`
- Scope: file path or glob. Required.

Agent: `typst-formatting-fixer` — converts Markdown syntax to Typst, normalizes formatting conventions in .typ files.
