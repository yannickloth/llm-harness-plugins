---
name: latex-toolkit
description: LaTeX-specific tools — syntax fixing, formatting, cross-reference checking, citation validation, production readiness, figure captions, index coverage, and notation consistency.
argument-hint: <subskill> [<file-scope>]
---

# LaTeX Toolkit

Collection of LaTeX-specific audit and fix skills. Assumes `.tex` files and LaTeX syntax.

## Subskills

| Subskill | Agent(s) | Description |
|----------|----------|-------------|
| `syntax` | latex-syntax-fixer | Fix LaTeX compilation errors and warnings |
| `format` | latex-formatting-fixer | Convert Markdown to LaTeX; normalize conventions |
| `xref` | latex-xref-checker | Verify `\ref{...}` / `\cref{...}` cross-references resolve |
| `citation` | latex-citation-checker | Verify `\cite{...}` citations against bib file |
| `production` | latex-production-readiness-checker | Scan for TODOs, placeholders, draft mode, debug artifacts |
| `figure-caption` | latex-figure-caption-auditor | Audit figure/table captions for quality and labels |
| `index` | latex-index-auditor | Audit `\index` coverage and consistency |
| `notation` | latex-notation-consistency-checker | Check symbol consistency against notation doc |

## Usage

```
/latex-toolkit:syntax <scope>         Fix compilation errors
/latex-toolkit:format <scope>         Convert formatting to LaTeX
/latex-toolkit:xref <scope>           Verify cross-references
/latex-toolkit:citation <scope>       Verify citations
/latex-toolkit:production <scope>     Pre-submission scan
/latex-toolkit:figure-caption <scope> Audit figure/table captions
/latex-toolkit:index <scope>          Audit index coverage
/latex-toolkit:notation <scope>       Check notation consistency
```

## Arguments

- `$ARGUMENTS` — subskill name + scope. E.g., `syntax src/manuscript/`, `xref src/volume-1/`
- **Guard:** empty → list available subskills
- **Guard:** unknown subskill → report; suggest closest match
- **Guard:** subskill specified but no scope → ask user for file scope before proceeding
- **Guard:** scope does not resolve to any `.tex` files → report empty match; ask user to refine
