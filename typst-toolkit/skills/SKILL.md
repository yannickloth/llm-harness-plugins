---
name: typst-toolkit
description: Typst-specific tools — syntax fixing, formatting, cross-reference checking, citation validation, production readiness, and diagram auditing.
argument-hint: <subskill> [<file-scope>]
---

# Typst Toolkit

Collection of Typst-specific audit and fix skills. Assumes `.typ` files and Typst syntax.

## Subskills

| Subskill | Agent(s) | Description |
|----------|----------|-------------|
| `syntax` | typst-syntax-fixer | Fix Typst compilation errors and warnings |
| `format` | typst-formatting-fixer | Convert Markdown/LaTeX remnants to Typst |
| `xref` | typst-xref-checker | Verify `@label` cross-references resolve |
| `citation` | typst-citation-checker | Verify `@key` citations against bib file |
| `production` | typst-production-readiness-checker | Scan for TODOs, placeholders, debug artifacts, LaTeX remnants |
| `diagram` | typst-diagram-checker | Review CeTZ/grid diagrams for layout issues |

## Usage

```
/typst-toolkit:syntax <scope>       Fix compilation errors
/typst-toolkit:format <scope>       Convert formatting to Typst
/typst-toolkit:xref <scope>         Verify cross-references
/typst-toolkit:citation <scope>     Verify citations
/typst-toolkit:production <scope>   Pre-release scan
/typst-toolkit:diagram <scope>      Review diagram layout
```

## Arguments

- `$ARGUMENTS` — subskill name + scope. E.g., `syntax src/chapter.typ`, `xref src/content/`
- **Guard:** empty → list available subskills
- **Guard:** unknown subskill → report; suggest closest match
- **Guard:** subskill specified but no scope → ask user for file scope before proceeding
- **Guard:** scope does not resolve to any `.typ` files → report empty match; ask user to refine
