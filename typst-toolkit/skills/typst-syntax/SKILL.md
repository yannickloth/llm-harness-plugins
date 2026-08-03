---
name: typst-syntax
description: Fix Typst compilation errors and warnings in .typ files. Delegates to typst-syntax-fixer. Use when typst compile fails or produces warnings.
compatibility: Requires typst (typst compile)
---
# Typst Syntax Fix

Fixes Typst compilation errors and warnings. Delegates to `typst-syntax-fixer`.

Usage: `/typst-syntax <scope>`
- Scope: file path or glob. Required.

Agent: `typst-syntax-fixer` — fixes compilation errors and warnings in .typ files. Assumes Typst syntax.
