---
name: xref
description: Audit internal cross-references — verify labels resolve, detect broken refs, orphans, duplicates. Adapts to project citation format (LaTeX, Typst, Markdown, reST, AsciiDoc). Delegates to xref-checker.
compatibility: Requires read access to content files
---
# Cross-Reference Audit

Audits internal cross-references. Delegates to `xref-checker`.

Usage: `/xref <scope>`
- Scope: file path or glob. Required.

Agent: `xref-checker` — read-only; reports broken refs, orphans, duplicates. Adapts to project format automatically.
