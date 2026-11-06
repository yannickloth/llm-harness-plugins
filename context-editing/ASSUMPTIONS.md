# context-editing — Assumptions

Projects the session's live history into an editable mirror file
(`.context-editing/<sid>/context.md`), traces textual parts to `trace.jsonl`,
enforces a token budget with transient notices, and (edit mode) applies the
model's mirror edits to the outgoing message array. Dual entrypoint: legacy v1
`server()` factory and v2 `id` + `setup(ctx)`.

## OpenCode API (hooks used, v1 vs v2, version sensitivity)

- v1 hooks: `config`, `chat.message`, `experimental.chat.system.transform`,
  `experimental.chat.messages.transform`, `tool.execute.after`,
  `experimental.session.compacting`, `experimental.compaction.autocontinue` —
  all valid v1 names per `@opencode-ai/plugin` 1.19.3 `Hooks`.
- ⚠ v1 registers session lifecycle as top-level `"session.compacted"` /
  `"session.deleted"` keys; v1 dispatches events only through the `event`
  hook, so these handlers never run under opencode 1.x.
- ⚠ v1 lifecycle payload shape assumed: `input.properties.session.id`; actual
  v1 shapes are `properties.info.id` (created/deleted) and flat
  `properties.sessionID` (compacted).
- v2: `ctx.session.hook("prompt" | "context" | "compaction")`,
  `ctx.tool.hook("execute.after")`, `ctx.tool.transform`,
  `ctx.event.subscribe`, `ctx.location`, `ctx.options` — names verified
  against `@opencode/plugin` 2.0.29 and the opencode 2.2.5 binary.
- ⚠ v2 `session.hook("context")` payload `messages` is LLM wire format
  (`{role, content: [...]}`, `@opencode/ai` `Message`), not native
  `{info, parts}`; `sessionFromMessages` reads `m.info.sessionID` and finds
  nothing, so `project()` is a silent no-op in v2 (notices, trace, mirror,
  edits never run).
- ⚠ v2 listens for event type `session.compacted`; no such event exists in
  v2 (only `session.compaction.ended`), so the post-compaction mirror rebuild
  never runs in v2.
- ⚠ v2 `SessionCompaction` payload has no `context` or `autocontinue` field;
  the compaction note is dropped and auto-continue is never suppressed in v2
  (v1 had both).
- ⚠ The v2 API is untyped in the declared dependency (`ctx: any`);
  `@opencode-ai/plugin` 1.19.3 types none of the v2 surface. Verified
  manually against `@opencode/plugin` 2.0.29 and opencode 2.2.5.
- ⚠ Two `ctx.session.hook("context", …)` registrations (system block, then
  message projection) assume both callbacks run, in registration order.
- Version sensitivity: v1 path only works under opencode 1.x; v2 path targets
  opencode 2.x (exercised here on 2.2.5). Each runtime uses exactly one
  path; the extra `server`/`setup` key is ignored by the other.

## Environment (env vars, binaries, OS/process)

- `LLMHP_CONTEXT_EDITING=0` disables the plugin (checked in both entries).
- `LLMHP_CONTEXT_EDITING_MODE` (`off` | `notices-only` | `edit`),
  `LLMHP_CONTEXT_EDITING_BUDGET`, `LLMHP_CONTEXT_EDITING_WINDOW` — env wins
  over constructor options and the config block; invalid values warn and fall
  back to `notices-only` / defaults.
- `LLMHP_CANARY_DIR` + `LLMHP_CANARY_NONCE` — load canary marker written only
  under `shared/canary_preflight.sh`; no-op otherwise.
- Synchronous Node/Bun `fs` API; `process.pid` in temp filenames; POSIX
  assumed (template-string path joins).
- No external binaries.

## Filesystem & layout

- ⚠ Root anchor: v1 = `worktree ?? directory` (plugin input); v2 =
  `ctx.location.project.canonical ?? ctx.location.directory`. If both are
  undefined, `sessionPaths` builds the relative path
  `"undefined/.context-editing/…"` (literal directory in cwd) — no null check.
- Writes `<root>/.context-editing/<sessionID>/{context.md, trace.jsonl,
  edits/rNNNN.json, metrics.jsonl}`; creates directories on demand.
- ⚠ `sessionID` is interpolated into paths without a traversal guard
  (host-generated `ses_*` ids in practice).
- Mirror format (v1): `# Head` / `# Context` sections plus
  `<!-- ce:b msg=<id> id=<partId> role=<role>[ kind=pinned type=…] -->` …
  `<!-- /ce:b -->` markers, version comment `context-editing:mirror v1`.
- ⚠ Marker collision: a block body containing a close-marker line truncates
  the block; a body containing an open-marker line is skipped (last
  `lastIndex` jump); the protocol tells the model not to edit markers.
- ⚠ Trace truncates each part's text to 4000 chars — the trace is not a
  complete copy of the conversation.
- Atomic writes: `<file>.tmp-<pid>` then rename; stale tmp files are not
  cleaned.

## External services

- None. No network I/O.

## Configuration

- ⚠ v1 `context_editing` block (opencode.json) relies on the host passing
  unknown top-level config keys to the `config` hook; the v1 `Config` type
  has no such key.
- The block is absent from the repo `opencode.json` and
  `opencode.json.sample`; defaults apply (`notices-only`, `50%`, 200000).
- Registered in the root `opencode.json` (`./context-editing/opencode`) and in
  the sample config, so the plugin loads in both.
- README install paths (`./llm-harness-plugins/context-editing/…`) assume the
  repo is a subdirectory of the consumer workspace.

## Concurrency

- All session state lives in a process-local `Map` keyed by session id.
- ⚠ A process restart loses state: `tracedIds` empty → trace parts
  re-appended (duplicates); `revision` resets to 0 → `edits/rNNNN.json`
  files overwritten; `firedReminders` re-fire.
- Synchronous fs in single-threaded hook handlers; no locks.
- ⚠ `writeAtomic` temp name is per-pid; two processes sharing one root can
  overwrite each other's mirrors via the final rename.
- v2 event subscription is torn down through the dispose function returned
  from `setup` (AbortController); ⚠ relies on the promise bridge honoring the
  signal.

## Data & LLM behavior

- ⚠ Trusts that v1 `messages.transform` delivers full session history in
  native `{info, parts}` shape, with stable part ids across requests
  (reconcile and dedupe depend on id stability).
- Token accounting: `ceil(chars/4)` over text parts only; tool input/output
  and media are not counted → size is an underestimate.
- The budget notice part is prepended to the oldest message; ⚠ this mutates
  the head of history and invalidates the prefix cache on notice requests
  (design §12 mandates prepending; §9.3 prefers tail placement).
- Assumes the model respects the edit protocol (markers, protected region).
  Violations are caught by projection validation (tool-pair atomicity,
  protected region) → ⚠ but a rejected mirror is not restored to the
  last-good revision (design §10), so a bad edit yields silent raw-history
  requests until the model or a reset fixes the file.
- Reminder steps 25/50/75 are one-shot per in-memory session state; ⚠ they
  never re-fire after compaction.
- Recall gate is fail-closed (all three conditions must hold); trace recall
  is a case-insensitive line-substring search returning up to 10 raw JSONL
  lines.
