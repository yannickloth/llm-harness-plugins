---
name: logic
description: Audit documents for circular reasoning, completeness gaps, hidden assumptions, forward references, and ambiguous statements. Delegates to logic-auditor.
compatibility: Requires read access to content files
---
# Logic Audit

Audits logical structure of documents. Delegates to `logic-auditor`.

Usage: `/logic <scope>`
- Scope: file path or glob. Required.

Agent: `logic-auditor` — read-only; reports circular reasoning, gaps, hidden assumptions, forward references, and ambiguous statements.
