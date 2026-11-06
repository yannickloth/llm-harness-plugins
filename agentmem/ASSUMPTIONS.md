# agentmem — Assumptions

File-based, auto-persisted memory for OpenCode. A TypeScript plugin (`opencode/index.ts`, v1 + v2 entry) injects memory context into sessions, classifies user messages, and spawns `memory-keeper` / `memory-dreamer` subagents via `opencode run`. All storage logic is compiled Java (`eu.infolead.llmhp.memory.MemorySystemCli`) in `build/classes`, invoked as a subprocess. Memory is Markdown: a `MEMORY.md` index plus topic files under `<project>/.agentmem/`, plus an entity index, a consolidation lock, and per-session token budgets.

## OpenCode API (hooks used, v1 vs v2, version sensitivity)

- v1 hooks: `chat.message`, `tool.execute.after`, `event` (`session.created`, `session.deleted`, `session.idle`, `file.edited`), `config` (agent registration), `tool` map. Assumes `@opencode-ai/plugin` ≥ 1.19.x.
- ⚠ v1 `session.created` / `session.deleted` events are typed (SDK 1.18/1.19) as `properties: { info: Session }`; the v1 code reads `properties.sessionID`, which is `undefined` for those events — only the v2 handler reads the correct `info.id` fallback.
- ⚠ v2 surface (`ctx.session.hook("prompt")`, `ctx.session.synthetic`, `ctx.session.remove`, `ctx.tool.hook`, `ctx.tool.transform`, `ctx.agent.transform`, `ctx.event.subscribe`, `ctx.location.project.canonical`) is accessed through `ctx: any` — no compile-time check; pinned to the 1.19.x runtime shape.
- ⚠ `opencode run` creates a fresh session per invocation; the keeper/dreamer are spawned without `--session`/`--continue`, so they cannot see the parent conversation. Only the classifier works, because it ships the user text on stdin (verified: `opencode run` appends stdin to the message).
- ⚠ `opencode run --format json` output is assumed to be NDJSON with a top-level `sessionID` per event and text events `{ type: "text", part: { text } }` (used to delete throwaway sessions and parse YES/NO).
- ⚠ v2 agent registration uses `ctx.agent.transform` create-by-update; `opencode run --agent memory-keeper` in a child process only resolves if that transform is persisted where the child sees it.
- v1 tool context assumed to carry `sessionID`, `directory`, `worktree` (per `ToolContext`); ⚠ v1 code prefers a process-global `injectedSessionId` over the per-call `context.sessionID` for reinjection.
- Legacy v1 loader treats every top-level function export of the plugin entry as a plugin factory — `isInRoot` lives in `path-utils.ts` to avoid that.

## Environment

- ⚠ `java` on PATH at runtime version ≥ 25 (classes compiled with `--release 25`); a Java 21 runtime fails to load every class.
- ⚠ `opencode` on PATH and able to run headless (`opencode run`) with the same config/plugins as the parent.
- `git` on PATH (only for the `bootstrap` / `init-memory` path).
- ⚠ `kill(1)` on PATH for the classify-lock staleness check (`kill -0 <pid>`); EPERM (other user's live process) is treated as "dead".
- ⚠ Linux: `/proc/sys/kernel/random/boot_id` for the consolidation lock; on other OS it falls back to `"unknown"`, which matches any lock (lock judged live by PID only).
- ⚠ Recursion guard `LLMHP_NO_SUBSPAWN=1` set on spawned children; effective only if the plugin also loads inside the child `opencode run` process (its own server). If a child instead attaches to a shared server whose env lacks the var, the guard is a no-op.
- `OPENCODE_MEMORY_MODEL` — model for keeper/dreamer; default `"auto"`.
- `OPENCODE_MEMORY_CLASSIFY_INTERVAL_MS` — classifier rate limit; default `300000`; non-numeric / ≤ 0 falls back to default.
- ⚠ Classifier model is hard-coded `deepseek/deepseek-flash`; that provider must be configured and authenticated or every classification silently returns NO.
- Sample config assumes an `openai/gpt-4.1-nano` provider for the keeper/dreamer agents.
- `LLMHP_CANARY_DIR` / `LLMHP_CANARY_NONCE` — only for the load canary; unset = no-op.
- `user.home` used by the (unused) `tiered-inject` CLI path.

## Filesystem & layout

- Project root = `worktree ?? directory` (v1) / `ctx.location.project.canonical ?? ctx.location.directory` (v2). ⚠ If both v2 fields are undefined, `setup` throws and the plugin fails to load.
- Memory dir `<root>/.agentmem/` — created on demand; never garbage-collected.
- ⚠ `MEMORY.md` index writes are not atomic (plain `writeString`) and not locked — two concurrent saves can lose an index update; topic-file writes are atomic (tmp → fsync → rename).
- ⚠ Topic file name is validated `[a-zA-Z0-9_-]+` only on `save`; `delete` (`forget-memory`) performs no name validation or containment check (path traversal sink).
- ⚠ `MEMORY.md` index cap (200 lines / 25 KB) is enforced on save; scoped `MEMORY.md` files in subfolders (injected on file tool use) have no size cap.
- Topic file 250 KB cap is NOT enforced on the save path (only a 500 KB warn from guardrail-chain); the cap lives in `QualityGateRunner`, which is never invoked by the plugin.
- ⚠ Frontmatter values from the model (`description`, `context`, `who`, `contradicts`, `guard_trigger`) are written to YAML unquoted — embedded newlines/colons corrupt the frontmatter.
- State files: `.entities.json`, `.entities-graph.json`, `.model-trust.json`, `.consolidate-lock`, `.classify-lock`, `.classify-last`, `.sessions/budget-<sid>.json`, `.tmp/`, `.cold/`, `.history/`, `injections/<sid>.md` — all UTF-8.
- ⚠ `.entities.json` / `.entities-graph.json` / `.model-trust.json` are written non-atomically and parsed by hand-rolled parsers that do not unescape `\"` / `\\`; a quoted entity corrupts the index permanently. Corrupt JSON is not auto-rebuilt (design promises rebuild).
- ⚠ `injections/<sid>.md` detail files are never cleaned (one per injected session id, including throwaway maintenance sessions).
- Encodings: Java `Files.readString` (UTF-8) and TS `readFileSync("utf-8")`; no BOM handling.
- ⚠ `ScopedMemoryLoader` / `collectScopedMem` walk upward from the touched file to the project root and inject every `MEMORY.md` found; the design text contradicts itself on cascade direction (inward vs outward).

## External services

- None required. The sync-server features (design §7.3, §12.10) are not implemented; `sync-delta` is local-only and never reads `.sync-state.json`.
- No URLs, ports, or network calls in live code paths.

## Configuration

- ⚠ `opencode.json` must list `./agentmem/opencode` under `plugin` for any of this to work. The repo's `opencode.json` does NOT register it; only `opencode.json.sample` does.
- Sample registers `instructions.memory → ./agentmem/prompts/agent-prompt.md` (file exists).
- ⚠ Sample commands `/init-memory` and `/forget-memory` reference `agentmem/MemorySystem.java` — that file does not exist (real entry is `eu.infolead.llmhp.memory.MemorySystemCli` in `src/main/java`); both commands are broken.
- ⚠ Sample defines `agent.memory-keeper` / `agent.memory-dreamer` entries (model/steps/permission, no prompt); the plugin's `registerAgentDirV1/V2` skips ids that already exist, so with the sample as-is those agents run with no memory system prompt.
- ⚠ The dreamer prompt tells the agent to run a `memorysystem` binary (`entity-rebuild`, `graph-build`, `lifecycle-prune`, `review`, `quality-health`, `history-prune`) — no such binary exists in the repo or on PATH; those Phase 4 steps fail with command-not-found.
- `topicGate` plugin option, default `true` (personal/non-coding sessions are never injected or classified).
- No per-project `config.json` is read at runtime (only by the never-invoked `migrate` command).

## Concurrency

- ⚠ No lock on the save path: two processes saving in parallel both pass the index-size check and both read-modify-write `MEMORY.md` (lost update) and `.entities.json`.
- Consolidation lock `.consolidate-lock` = `<ownerPid>:<bootId>:<ownerStartMs>`; owner must outlive the dream (the plugin passes its own `process.pid`); stale > 60 min or dead owner PID → free; acquisition is non-atomic write + 50 ms sleep + read-back.
- ⚠ `lock-release` deletes the lock file without checking ownership — a delayed release (320 s cap path) can remove a newer holder's lock.
- ⚠ Per-process module state: `lastDreamRun`, `injectedSessionId`, `injectedScopes`, `classifierBusy` are per plugin process; multi-process opencode instances each maintain their own (cross-process coordination only via the lock/timestamp files).
- ⚠ Classify coordination: `.classify-lock` (O_EXCL, PID body) is removed immediately after the check — it serializes the check, not the classification; `.classify-last` timestamp gives the cross-process 5-minute window; a crash between O_EXCL and timestamp write leaves a stale lock, recovered only by PID death.
- Budget files are written atomically (tmp + fsync + rename); topic files too; index/entity files are not.
- ⚠ `sweepMaintenanceSessions` runs on every plugin load (including in spawned children) and deletes any root session titled `Memory maintenance…` — it can delete a sibling process's in-flight maintenance session.

## Data & LLM behavior

- ⚠ Classifier answer must equal exactly `YES` (case-insensitive) — `YES.`, `Yes, ...` count as NO (missed capture).
- ⚠ Token budget math assumes 4 chars = 1 token; section token counts are computed from full content even when the section is character-truncated (over-counts consumption); `budget-inject-delta` accumulates only the token delta while injecting the full context each time (budget under-counts actual injection after the first save).
- ⚠ Quality gates (duplicate name, 250 KB body, type consistency, exclusion list, hook quality, secrets) exist only in `QualityGateRunner` (CLI `quality-validate`) — the actual `save` path runs only guardrail-chain checks; saving an existing name silently overwrites (ADD-only violated), and a name that is a suffix of an existing name (e.g. `test` vs `unit_test`) silently drops the index pointer (substring match `name.md)`).
- ⚠ Decay/prune thresholds key off `type` only; `failure`/`anomaly`/`serendipity` are subtypes, so the design's 365/180-day subtype curves are unreachable — everything project-type prunes at 60 days.
- Model trust tracking (`model-record`/`model-correct`/`model-trust` CLI, `model`/`model_tier` frontmatter) is dead: the TS never passes a model id to `save` and nothing calls the trust CLI.
- ⚠ Topic gating uses shared regex keyword markers (`session-topic.ts`) — once a session is classified `project` it stays project forever (in-memory, per process).
- Entity extraction is regex-only: file paths `[\w/.-]+\.[a-z]{1,6}`, backticked spans, uppercase abbreviations, URLs.
- ⚠ The classifier reuses the full `memory-keeper` agent (edit + bash allowed, 5 steps) to answer YES/NO; the keeper's own system prompt instructs it to save memories, so a classifier call can write memory files in response to an arbitrary user message.
- Dreamer convergence (max 5 rounds, 5-minute wall clock) is enforced only by prompt; code enforces the 300 s kill and the lock.
- ⚠ The keeper/dreamer/verifier agents are trusted to write valid frontmatter and index lines directly (Write tool) without going through `MemoryStore`; nothing re-validates their output until the next `quality-health` run.
