---
name: style
description: Audit writing for AI-generated markers, rhetorical calibration, tone, and vocabulary precision, then rewrite flagged passages as natural human prose. Groups findings by category with severity and applies domain conventions. Delegates to style-auditor and style-naturalizer.
compatibility: Requires read/write access to content files
---
# Style Audit + Naturalization

Two-phase style pass. Delegates to `style-auditor` then `style-naturalizer`.

Usage: `/style <scope>`
- Scope: file path or glob. Required.

Agents:
- `style-auditor` — flags AI-generated markers, rhetorical issues, tone, vocabulary; groups findings by category (Structural/Lexical/Syntactic/Rhetorical) with severity; applies domain conventions; may use the optional `general-skills/tools/ProsePatternAnalyzer.java` helper as a deterministic cross-reference.
- `style-naturalizer` — rewrites flagged passages to natural human prose, preserving domain-appropriate conventions.
