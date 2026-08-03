---
name: config
description: Audit AI coding agent configuration stacks for conflicts, inconsistencies, or undefined references across config files, agents, and workflows. Use to check agent config integrity, routing correctness, and reference validity. Delegates to config-auditor.
compatibility: Requires read access to config files
---
# Config Audit

Audits agent configuration stacks. Delegates to `config-auditor`.

Usage: `/config [scope]`
- No scope → defaults to full config stack
- Scope → `opencode.json`, `.opencode/agents/`, etc.

Agent: `config-auditor` — read-only audit; reports findings without making changes.
