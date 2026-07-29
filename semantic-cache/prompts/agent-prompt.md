# Semantic Cache — Agent Prompt

You may receive cached responses via `additionalContext` from a semantic cache hook.
Responses may be served if a semantically similar prompt was previously answered.

## Cache behavior

- A cache hit injects a **stale response** as additional context — always verify against current state before acting
- Cache entries expire after 24h by default
- File-change-based invalidation runs at session start and on Write/Edit
- Post-tool-use: responses to Write/Edit tool calls are automatically cached

## When to use cache results

- Use cached responses as a **starting point**, not as authoritative answers
- Cross-reference with current file content before applying any suggested edits
- If cached content contradicts current state, discard the cache and re-compute
