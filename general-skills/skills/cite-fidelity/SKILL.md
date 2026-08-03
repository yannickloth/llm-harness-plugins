---
name: cite-fidelity
description: Citation-claim fidelity verification — check that cited sources actually support the claims they back. Detects misrepresented sources, cherry-picked quotations, and scope mismatches. Delegates to citation-fidelity-auditor. Use when only claim verification is needed, not bibliography integrity.
compatibility: Requires read access to content files; internet access for source verification
---
# Citation Fidelity Audit

Citation-claim verification only. Delegates to `citation-fidelity-auditor`.

Usage: `/cite-fidelity <scope>`
- Scope: file path or glob. Required.

Agent: `citation-fidelity-auditor` — read-only; verifies claims against cited sources. Does NOT check bibliography integrity.
