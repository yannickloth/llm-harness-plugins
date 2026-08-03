---
name: citation
description: Full citation audit — bibliography integrity plus citation-claim verification. Checks duplicates, missing fields, broken citations, uncited entries, retracted papers, and whether sources actually support the claims they back. Delegates to bibliography-auditor and citation-fidelity-auditor.
compatibility: Requires read access to content files and bibliography; internet access for source verification
---
# Citation Audit (Full)

Two-phase citation pass. Delegates to `bibliography-auditor` then `citation-fidelity-auditor`.

Usage: `/citation <scope>`
- Scope: file path or glob. Required.

Agents:
- `bibliography-auditor` — bibliography integrity: duplicates, missing fields, broken citations, uncited entries, retracted papers
- `citation-fidelity-auditor` — citation-claim verification: does the source back the claim?
