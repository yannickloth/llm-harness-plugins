# context-editing

Lets the session model manage its own context. Before a request the conversation
is projected into an editable **file** (`context.md`); the model curates it with
its ordinary tools, and the curated version becomes its next input. OpenCode's
stored session is left untouched.

The goal is **relevance density**, not smallness: long sessions stop rotting
under their own history. See [`../plugin-context-editing.design.md`](../plugin-context-editing.design.md)
for the full design.

Three layers, event-sourced:

| Layer | File | Role |
|-------|------|------|
| Trace | `.context-editing/<session>/trace.jsonl` | append-only, cold, never in the prompt — ground truth |
| Mirror | `.context-editing/<session>/context.md` | mutable, in-context — the curated view |
| Diffs | `.context-editing/<session>/edits/rNNNN.json` | audit + revert |

## Install

Add to your project's `opencode.json`:

```json
{
  "plugin": ["./llm-harness-plugins/context-editing/opencode/index.ts"]
}
```

No build step, no Java backend.

## Modes

- `notices-only` (**default**, Phase 0) — injects a budget notice and an overflow
  guard; history is otherwise raw (the transient notice is stripped before the
  next request). No mirror, no editing. Use this to measure whether budget
  pressure alone changes behaviour.
- `edit` (Phase 1) — adds the mirror projection, the edit vocabulary, and the
  cache-aware application of edits.
- `off` — inert.

```json
{
  "plugin": [["./llm-harness-plugins/context-editing/opencode/index.ts", { "mode": "edit", "budget": "50%" }]]
}
```

## Options

| Option | Default | Meaning |
|--------|---------|---------|
| `mode` | `"notices-only"` | `off` \| `notices-only` \| `edit` |
| `budget` | `"50%"` | `"50%"` \| `"64k"` \| `"window"` \| a literal token count |
| `windowTokens` | `200000` | model window used to resolve `%` and `window` |

The same keys can be set on a `context_editing` block in `opencode.json` (useful
when a path-loaded plugin does not receive constructor options); env, then
constructor options, take precedence over it:

```json
{
  "context_editing": { "mode": "edit", "budget": "64k", "windowTokens": 128000 }
}
```

Env overrides: `LLMHP_CONTEXT_EDITING=0` disables; `LLMHP_CONTEXT_EDITING_MODE`,
`LLMHP_CONTEXT_EDITING_BUDGET`, `LLMHP_CONTEXT_EDITING_WINDOW`.

## Tools

- `context-editing-status` — mode, budget, window, revision, reminders, metrics, paths.
- `context-editing-reset` — discard the mirror so the next request re-renders it (trace untouched).
- `context-editing-recall` — **gated** recall from the trace. Fires only when all
  of: a fact is missing from the mirror, it is not re-derivable from the
  environment, it plausibly exists in the trace, and the step cannot proceed
  without it. Fails closed.

## Safety

- **Tool pairs are atomic.** A tool call and its result are never split; pinned
  parts are re-spliced from the trace, so the request stays structurally valid.
- **Fail-open budget.** Overshooting is allowed; fabricating to hit a number is
  not. If a projection would break the wire format or empty the protected region,
  it is rejected and the raw history is used.
- **Cache-aware.** With no edits, the message array is left untouched; edits are
  applied only when they change something.

## Tests

```bash
bun test context-editing/opencode/helpers.test.ts   # pure logic
bun test context-editing/opencode/index.test.ts     # hooks + tools
```
