# semantic-cache — Assumptions

OpenCode plugin that caches prompt–response pairs in a per-project on-disk
cache. A local Java daemon computes 384-dim character n-gram embeddings and
answers `lookup`/`store`/`invalidate`/`stats` frames. A hit injects a stale
cached answer into the session as a lazy-read pointer file. Prompts and
assistant replies are auto-stored per turn; `write`/`edit` tool results are
auto-stored and invalidate entries that mention the changed file name.

## OpenCode API (hooks used, v1 vs v2, version sensitivity)

- v2 entry: `id` + `setup(ctx)`; v1 served through `server(input, options)` as a function-form factory (opencode 1.x).
- v2 hooks used: `ctx.session.hook("prompt")`, `ctx.tool.hook("execute.after")`, `ctx.tool.transform` (3 tools), `ctx.session.synthetic({ sessionID, text })` for injection, `ctx.event.subscribe` for lifecycle.
- v2 event names assumed: `session.created`, `session.deleted`, and `session.next.text.ended` (assistant text capture).
- ⚠ `session.next.text.ended` does not exist in opencode 2.2.5 (verified in the binary; the real event is `session.text.ended`). On the running v2 runtime, assistant text is never captured, so auto-store of prompt+response pairs silently never happens.
- v2 prompt hook assumed to expose the user text at `event.prompt.text`; tool hook assumed to carry `event.tool`/`event.input` (with `event.name`/`event.args` fallbacks).
- v2 injection assumed to be `ctx.session.synthetic({ sessionID, text })` (same call knowledge-graph uses).
- v1 hooks used: `event` (session.created/session.deleted), `chat.message` (text from `output.parts[].text`), `experimental.text.complete` (assistant text), `tool.execute.after` (`input.tool`, `input.args`, `output.output`), `tool` map (3 tools).
- ⚠ v2 root anchor `ctx.location?.project?.canonical ?? ctx.location?.directory` has no null guard; if both are undefined, `cacheDir` throws during setup and plugin load fails.
- Injection re-entrancy guard: injected messages start with `[CACHE HIT]` and the prompt hook skips text with that prefix; hard cap of 8 injections per session.

## Environment (env vars, PATH, OS/process)

- `java` on PATH must be JDK 25 (classes compiled with `--release 25`; daemon `main` is public static, but `SemanticCacheCli` and the test class use a package-private instance `main` that only the JDK 25 launcher can start — JEP 512).
- No plugin-specific env vars. ⚠ `LLMHP_CANARY_DIR`/`LLMHP_CANARY_NONCE` (shared load canary) — no-op unless both set.
- Linux/macOS: relies on POSIX `ATOMIC_MOVE` rename, `FileChannel.force(true)` fsync, and `Bun.spawn`.
- Daemon lifecycle: one persistent JVM per cache dir per plugin process; 15 s per-request timeout; one respawn on failure; daemon self-exits after 10 min idle (watchdog) or on stdin EOF.
- ⚠ Daemon stderr is piped but never read; >64 KB of JVM stderr can block the daemon (pipe full) and wedge every request into timeouts until the timeout respawn.

## Filesystem & layout (paths, anchoring, formats)

- Cache dir: `<worktree|directory>/.agentmem/cache/` — v1 anchors on plugin input `worktree ?? directory`; v2 on the ctx root (see above).
- Entries: `<sha-less 64-bit hex key>.json`, hand-rolled JSON with Base64 prompt/response, comma-joined float embedding, ISO-8601 `timestamp`, `ttlSeconds`.
- Entry key: 64-bit polynomial hash of the stripped prompt (`hashKey`); hit-file names in v1/v2: 32-bit JS hash of the prompt.
- ⚠ Key collisions: two distinct prompts with the same hash overwrite one entry (store); lookup is embedding-based, so a collision can silently serve the other prompt's response.
- Temp writes under `.agentmem/cache/.tmp/<key>.<uuid>` (entries) and `<cacheDir>/.tmp.<uuid>` (stats); stale temp files are never cleaned.
- Hit detail files: `.agentmem/cache/hits/<hash>.md`, written by the TS side (`fs.writeFileSync`, no atomic rename).
- ⚠ `.agentmem/` is also agentmem plugin's state root; the two plugins share that namespace (no known file overlap today: agentmem does not touch `cache/`).
- Encodings: UTF-8 everywhere (daemon I/O explicit; Java 25 default charset is UTF-8; TS uses utf-8).
- Hand-rolled JSON parse (`deserializeEntry`) only catches `IOException`; a well-formed file with a bad embedding length or bad Base64 throws a RuntimeException that propagates out of `loadAll`, breaking every lookup (and the self-healing `invalidateStale`) until the file is deleted.

## External services

- None. No network, no LLM calls, no ports. All embedding is local computation.

## Configuration (opencode.json)

- ⚠ Root `opencode.json` does NOT register this plugin. `opencode.json.sample` registers `./semantic-cache/opencode` — the plugin is inert unless the sample (or an equivalent entry) is copied into the active config.
- No agent, command, or permission entries required.
- Optional plugin option `topicGate` (default `true`): when on, cache-hit injection only fires for sessions the shared `session-topic` classifier marks as project.
- Shared classifiers assume English/French/German/Spanish/Italian personal markers and code-word project markers; personal sessions are never injected.

## Concurrency (locks, multi-instance, atomicity)

- One daemon JVM serializes its own requests (single-threaded stdin loop + TS-side promise chain per daemon).
- ⚠ No cross-process lock: two opencode instances (or two worktrees) sharing one cache dir run two daemons on the same files. Entry writes are per-file atomic (tmp+fsync+rename), but eviction and StatsStore counters race (last writer wins; counters lost; possible double-delete).
- ⚠ `ensureDaemon` has no spawn mutex: two concurrent first requests each spawn a JVM; the map keeps only the second, the first is orphaned until its 10-min idle exit (leaked JVM + two writers on one dir meanwhile).
- `evictIfNeeded` loops while entry count exceeds max: if deletes keep failing (permissions), the loop never terminates.
- In-memory maps (`pendingBySession`, `assistantTextBySession`, `injectionsBySession`, `injectedKeys`) are process-local; cleaned only on `session.deleted` — sessions never deleted grow the maps unboundedly.

## Data & LLM behavior (trusted formats, model assumptions)

- Embedding: 2–4 char n-grams → hashed buckets → L2-normalized 384 floats; hit = best cosine ≥ 0.85; near-miss band ≥ 0.80. Quality assumption: near-duplicate prompts land ≥ 0.85 apart in cosine space; short or code-heavy prompts collide heavily in 384 buckets (design accepts this).
- Staleness: TTL 24 h per entry; `invalidateStale` (session start) deletes expired, unparseable, and unreadable entries; file-name containment in the cached prompt drives write/edit invalidation (filename only, no path match).
- ⚠ Auto-store trusts the assistant's final text as a correct answer to the user's prompt; cached answers are later re-served (with a "stale, verify" label) to semantically similar prompts from any session in the same cache dir — a wrong or context-bound answer (other files, other state) can be served to a different situation.
- File-op store keys are the constant template `the file <basename> was modified (<tool>)` — distinct edits to same-named files in different directories collide on key (last write wins).
- Stats counters are trusted arithmetic; `savedResponseBytes` is bytes, not tokens (documented proxy).
