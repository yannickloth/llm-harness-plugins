---
name: latex-figure-caption
description: Audit LaTeX figure and table captions — must state a claim, be standalone-readable, have labels, and be referenced in text. Delegates to latex-figure-caption-auditor.
compatibility: Requires latexmk (TeX Live)
---
# LaTeX Figure/Table Caption Audit

Audits LaTeX captions for quality and labels. Delegates to `latex-figure-caption-auditor`.

Usage: `/latex-figure-caption <scope>`
- Scope: file path or glob. Required.

Agent: `latex-figure-caption-auditor` — read-only; checks captions state a claim, are standalone-readable, have labels, are referenced.
