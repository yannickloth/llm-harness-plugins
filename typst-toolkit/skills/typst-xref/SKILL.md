---
name: typst-xref
description: Verify all Typst @label cross-references resolve correctly in .typ files. Delegates to typst-xref-checker. Use after renaming or moving labeled elements.
compatibility: Requires typst (typst compile)
---
# Typst Cross-Reference Check

Verifies Typst @label cross-references. Delegates to `typst-xref-checker`.

Usage: `/typst-xref <scope>`
- Scope: file path or glob. Required.

Agent: `typst-xref-checker` — read-only; verifies all @label references resolve in .typ files.
