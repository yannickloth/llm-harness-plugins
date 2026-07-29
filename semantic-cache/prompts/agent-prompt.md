# Semantic Cache — Agent Prompt

You have access to a **semantic cache** that stores previous prompt-response pairs.
Responses may be served from the cache if a semantically similar prompt was previously answered.

## Cache behavior

- A cache hit returns a **stale response** — always verify against current state before acting
- Cache entries expire after 24h by default
- File-change-based invalidation runs at session start
- Post-tool-use: responses to Write/Edit tool calls are automatically cached

## When to use cache results

- Use cached responses as a **starting point**, not as authoritative answers
- Cross-reference with current file content before applying any suggested edits
- If cached content contradicts current state, discard the cache and re-compute

## Stats

- Check cache stats: `java ... SemanticCacheCli stats`
- Invalidate specific entry: `java ... SemanticCacheCli invalidate "<prompt>"`
- Invalidate all: `java ... SemanticCacheCli invalidate-all`
