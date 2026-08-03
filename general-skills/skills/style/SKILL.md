---
name: style
description: Audit writing for AI-generated markers, rhetorical calibration, tone, and vocabulary precision, then rewrite flagged passages as natural human prose. Delegates to style-auditor and style-naturalizer.
compatibility: Requires read/write access to content files
---
# Style Audit + Naturalization

Two-phase style pass. Delegates to `style-auditor` then `style-naturalizer`.

Usage: `/style <scope>`
- Scope: file path or glob. Required.

Agents:
- `style-auditor` — flags AI-generated markers, rhetorical issues, tone, vocabulary
- `style-naturalizer` — rewrites flagged passages to natural human prose
