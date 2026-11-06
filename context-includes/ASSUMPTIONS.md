# context-includes — Assumptions

Merges `<root>/CLAUDE.md` and `<root>/AGENTS.md` (with `@include`
resolution) and injects the result into each new session as a synthetic
no-reply user message, re-injecting after compaction. Dual entrypoint:
legacy v1 `server()` factory and v2 `id` + `setup(ctx)`.

## OpenCode API (hooks used, v1 vs v2, version sensitivity)

- ⚠ v1 registers `"session.created"` / `"session.compacted"` /
  `"session.deleted"` as top-level handler keys; v1 (per
  `@opencode-ai/plugin` 1.19.3 `Hooks`) dispatches lifecycle events only
  through the single `event` hook, so the entire v1 path is a no-op under
  opencode 1.x. Sibling v1 plugins in this repo all use the `event:` hook.
- ⚠ v1 payload shape assumed: `input.properties.session.id`; no v1 event
  carries this shape (flat `properties.sessionID` on compaction,
  `properties.info.id` on created/deleted). The tests fire handlers with
  exactly this shape, which masks both issues.
- v1 injection: `client.session.prompt({ path: { id }, body:
  { noReply: true, parts: [{ type: "text", text }] } })` — `session.prompt`
  and `noReply` verified in `@opencode-ai/sdk` 1.19.3.
- v2: `ctx.event.subscribe` (async iterator of `{ type, data }`),
  `ctx.session.synthetic({ sessionID, text })`, `ctx.location.project.
  canonical` — names verified against `@opencode/plugin` 2.0.29 and the
  opencode 2.2.5 binary.
- ⚠ v2 event loop branches on type `session.compacted`; no such v2 event
  exists (only `session.compaction.ended`), so the v2 cache-clear and
  re-injection branch is dead code.
- v2 `session.created` / `session.deleted` consumed from the subscribe
  stream match the `V2Event` union.
- ⚠ The v2 API is untyped in the declared dependency (`ctx: any`);
  `@opencode-ai/plugin` 1.19.3 types none of the v2 surface.
- Version sensitivity: v1 path only runs under opencode 1.x (`server`);
  v2 under 2.x (`setup`). Each runtime uses exactly one path.

## Environment (env vars, binaries, OS/process)

- `LLMHP_CANARY_DIR` + `LLMHP_CANARY_NONCE` — load canary marker written in
  both entrypoints (shared/load-canary); no-op otherwise.
- `HOME` / `USERPROFILE` must be set if any include uses `~/` (throws
  otherwise).
- Synchronous Node/Bun `fs` API; POSIX path semantics assumed.
- No external binaries.

## Filesystem & layout

- ⚠ Root anchor: v1 = `worktree ?? directory`; v2 =
  `ctx.location?.project?.canonical ?? ctx.location?.directory`. If both
  are undefined, `path.join(root, …)` throws at load time and fails plugin
  load — no null check.
- Only `<root>/CLAUDE.md` and `<root>/AGENTS.md` are read. No directory
  walk, no nested `AGENTS.md`, no other instruction files.
- ⚠ AGENTS.md is double-injected: opencode 2.x natively loads AGENTS.md
  into the system prompt (verified in the 2.2.5 binary: walks up,
  `targets: ["AGENTS.md"]`), and this plugin injects it again as a user
  message. CLAUDE.md is never loaded natively by 2.2.5.
- `@include` rules (shared/instructions-md.ts): an include is a whole line
  matching `^@\S+$` (no trailing text on the line, undocumented); depth
  cap 16, file cap 2 MB, cycle detection, binary-extension blocklist,
  symlink resolution.
- ⚠ Include path syntax as implemented: `@rel` and `@./rel` resolve
  relative to the including file's directory; `@@/rel` also resolves
  relative to that directory (`resolvePath`'s `@/` branch handles the
  `@@/` token); `@/rel` is treated as an absolute path and resolves against
  the filesystem root (verified: `@/docs/style.md` → "file not found:
  /docs/style.md"). No project-root-relative syntax exists that works.
- ⚠ The root-escape guard runs only when the include target exists;
  nonexistent targets skip the guard and fail as "file not found".
- A missing include target is swallowed: the `@include` line is preserved
  verbatim in the injected text (the model sees the raw directive).
- A parse failure in one file (e.g. path escape) drops only that file;
  the other file still resolves and injects.

## External services

- None. No network I/O.

## Configuration

- ⚠ Not registered in the repo `opencode.json` nor in
  `opencode.json.sample` — the plugin is dormant; findings matter only if a
  consumer adds it.
- No configuration surface: no enable flag, no file list, no
  `ctx.options` / options argument consumed. CLAUDE.md + AGENTS.md are
  hardcoded.

## Concurrency

- `cachedMerged` and `injectionInFlight` live in the plugin-instance
  closure and are shared by all sessions: deleting any one session clears
  the merge cache for every session.
- ⚠ `injectionInFlight` is a single boolean, not per-session: a
  `session.created` for a second session arriving while the first
  injection is in flight is skipped with no retry — that session never
  receives instructions (the test suite asserts the skip as intended).
- The v2 event loop is a single serial `for await`; events cannot
  interleave within v2. The v1 path (if it dispatched) would fire
  handlers concurrently per event.
- ⚠ File changes to CLAUDE.md/AGENTS.md are not detected; only
  compaction (and session deletion) clear the cache. A session started
  before an edit keeps the stale merge for its whole lifetime.
- Synchronous fs reads; no locks.

## Data & LLM behavior

- The merged text arrives as a user message (v1 `noReply` prompt / v2
  synthetic) and is assumed to be treated as standing instructions.
- ⚠ Injection fires once per session creation; every compaction
  re-injects, so long sessions accumulate duplicate copies of the
  instructions (in v2 this never happens, since the event does not exist).
- HTML comments are stripped only for include extraction, not from the
  injected content; a `<!-- … -->` block in the files reaches the model.
