---
name: cite-bib
description: Bibliography-only audit — duplicates, broken citations, missing fields, uncited entries, retracted papers. Delegates to bibliography-auditor. Use when only the bibliography file needs checking, not citation-claim fidelity.
compatibility: Requires read access to bibliography and content files
---
# Bibliography Audit

Bibliography integrity check only. Delegates to `bibliography-auditor`.

Usage: `/cite-bib <scope>`
- Scope: file path or glob. Required.

Agent: `bibliography-auditor` — read-only; reports duplicates, broken citations, missing fields, uncited entries, retracted papers. Does NOT verify citation-claim fidelity.
