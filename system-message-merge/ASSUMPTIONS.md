# system-message-merge — Assumptions

Coalesces the multiple system-prompt entries of selected providers into a
single entry. v1 mutates `output.system` (a `string[]`) inside
`experimental.chat.system.transform`; v2 merges the `event.system` parts
inside `ctx.session.hook("context")`.

## OpenCode API (hooks used, v1 vs v2, version sensitivity)

- v1 hook: `experimental.chat.system.transform` with mutable
  `output: { system: string[] }` — valid v1 hook name and shape per
  `@opencode-ai/plugin` 1.19.3.
- v2: `ctx.session.hook("context", …)` receiving `event.system` (array of
  `{ type, text, cache?, metadata? }` parts) and `event.model` — names
  verified against `@opencode/plugin` 2.0.29 and the opencode 2.2.5
  binary.
- ⚠ The v2 merge replaces every part with one `{ type: "text", text }`
  part and drops `cache` / `metadata` from all of them — provider
  prompt-cache hints on system parts are wiped for matched providers.
- ⚠ The v1 and v2 hooks assume `output.system` / `event.system` is the
  live array used for the outgoing request (in-place mutation).
- ⚠ Hook-order coupling: this plugin and context-editing both register
  `context` hooks, and their relative order is the plugin registration
  (load) order. Assuming registration order = execution order: the root
  `opencode.json` (context-editing before system-message-merge) folds
  context-editing's protocol block into the merged part; the sample
  config (system-message-merge before context-editing) leaves two system
  parts per request while context-editing is in edit mode.
- ⚠ The v2 API is untyped in the declared dependency (`ctx: any`).
- Version sensitivity: v1 path only runs under opencode 1.x (`server`);
  v2 under 2.x (`setup`).

## Environment (env vars, binaries, OS/process)

- `LLMHP_CANARY_DIR` + `LLMHP_CANARY_NONCE` — load canary marker written
  in both entrypoints (shared/load-canary); no-op otherwise.
- No other env vars, no binaries, no I/O.

## Filesystem & layout

- None. No files are read or written.

## External services

- None. No network I/O.

## Configuration

- Options: `providers` (string array, default `["hetzner"]`) and
  `enabled` (boolean, default `true`).
- ⚠ v1 options arrive as the second argument of `server(input, options)`
  and v2 options via `ctx.options`; both assume the host forwards the
  per-plugin registration options. The repo configs register the plugin
  without options, so only the default provider matches.
- ⚠ The default `providers: ["hetzner"]` is specific to this repo's
  provider; on a different provider the plugin silently does nothing.
- Provider match is case-insensitive exact match on `model.providerID`.

## Concurrency

- The v1 handler and the v2 hook closure are stateless per call (options
  read once at load); no shared mutable state, no concurrency concerns.

## Data & LLM behavior

- ⚠ All-empty input: v1 sets `output.system = []` and v2 splices the
  array to empty. Downstream handling of an empty system array is
  unverified; a provider SDK that requires at least one entry would see
  a degenerate request.
- The merge preserves part order and joins with a blank line; whitespace
  only parts are dropped. Text content is otherwise lossless.
- Only matched providers are affected; all other providers keep the
  original system entries unchanged.
- Assumes the model does not depend on boundaries between separate
  system entries (e.g. per-entry cache breakpoints).
