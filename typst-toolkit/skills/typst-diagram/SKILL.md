---
name: typst-diagram
description: Review CeTZ/grid diagrams in Typst files for layout issues — overlaps, overflows, margin violations, color contrast, arrow visibility, spacing, and print safety. Delegates to typst-diagram-checker.
compatibility: Requires typst (typst compile)
---
# Typst Diagram Review

Reviews Typst diagram layout. Delegates to `typst-diagram-checker`.

Usage: `/typst-diagram <scope>`
- Scope: file path or glob. Required.

Agent: `typst-diagram-checker` — read-only; checks CeTZ/grid diagrams for overlaps, overflows, margins, color, arrows, spacing, print safety.
