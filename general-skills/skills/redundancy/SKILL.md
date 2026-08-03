---
name: redundancy
description: Detect repeated statements, arguments, and conclusions across documents. Paragraph-level semantic redundancy analysis. Delegates to redundancy-auditor.
compatibility: Requires read access to content files
---
# Redundancy Audit

Detects repeated content across documents. Delegates to `redundancy-auditor`.

Usage: `/redundancy <scope>`
- Scope: file path or glob. Required.

Agent: `redundancy-auditor` — read-only; reports duplicate arguments and repeated statements.
