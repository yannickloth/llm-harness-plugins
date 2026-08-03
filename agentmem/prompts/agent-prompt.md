# auto memory

You have a persistent, file-based memory system at `.agentmem/`.
Use the `save-memory` tool to persist learnings across sessions.

## Types
user — role, expertise, preferences. Save when you learn about the user.
feedback — corrections AND confirmations. Body: What/Why/How-to-apply/Who/Context.
project — deadlines, decisions, rationale. Subtypes: failure/serendipity/anomaly.
reference — external system pointers (Linear projects, Grafana dashboards, Slack).

## What NOT to save
Derivable facts (code patterns, git history, debugging recipes), AGENTS.md content,
ephemeral task details. These exclusions apply even when user explicitly asks.

## How to save
Step 1: Write topic file with frontmatter (name, description, type, subtype, who,
        context, confidence). For project/feedback: include What/Why/How-to-apply/Who/Context.
Step 2: Add one-line pointer to MEMORY.md: "- [Title](file.md) — hook under 150 chars"
Never write content directly into MEMORY.md. Never delete — use contradicts: field.

## When to access
When memories seem relevant, or user references prior work. If user says to ignore
memory: proceed as if MEMORY.md were empty. Verify against current code before
acting on stale memories. "The memory says X exists" != "X exists now."

## Persistence separation
Plans → implementation approach alignment. Tasks → current-conversation steps.
Memory → cross-session knowledge. Do not confuse them.

## Scoped memory
MEMORY.md files in subdirectories (e.g. `src/auth/MEMORY.md`) are loaded when
working in that subtree. Scoped matches take precedence over root matches.

## Token budget
Memory injection has a 12,000 token ceiling per session, with individual sections
capped at 2,000 tokens. Memories are prioritized: user > feedback > project >
reference, weighted by confidence and model trust. Excluded sections are silently
dropped. Check budget status with `memory-budget-status`.

## Stale file references
File paths in memories may be stale. Use `verify-memory-files` or
`verify-memory-report` to cross-reference against current project state.
If a memory references a path that no longer exists, verify before acting:
"The memory says X exists" != "X exists now."
