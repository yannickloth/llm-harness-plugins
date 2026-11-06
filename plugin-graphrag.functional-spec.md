# GraphRAG Plugin v2 — Functional Specification: Lifecycle Integrity

Author: plugin audit of 2026-11-05 (agent-conducted, author-approved scope).
Status: specification — implementation brief for `graphrag/opencode/` (TypeScript) and `graphrag/src/main/java/.../IndexCli.java` (Java).
Companion: `plugin-graphrag.design.md` (architecture of record). This spec hardens lifecycle behavior only. No exporter semantics change.

## 1. Evidence base (audit 2026-11-05, ivp-book-series)

| # | Observed defect |
|---|---|
| E1 | `graph-index/output/` holds only 1-row `documents.parquet` + `text_units.parquet`. No `entities`, `relationships`, `communities`, `community_reports`, `covariates`, no `lancedb/`. Full index never completed since 2026-08-07. |
| E2 | Update spawns (Aug-7, five) die at config validation: `API Key is required for chat`. Spawn env lacks `DEEPSEEK_API_KEY`. `.envrc` is `use flake`; the key exists only in the devShell. The plugin spawns blind. |
| E3 | Full run of 2026-08-07 17:11 died mid-`extract_graph` (7/91). Detached spawn (`proc.unref()`) records nothing. |
| E4 | `manifest.dirty` grew to 2368 files. No threshold. No full-reindex trigger. |
| E5 | Queries crash raw: `ValueError: Could not find entities.parquet in storage!`. |
| E6 | Embedding endpoint `localhost:1234` (LM Studio) has nothing behind it. Probe 2026-11-05: connection refused. |
| E7 | Sessions receive no signal that the index is non-functional. |
| E8 | **GraphRAG 2.7 validates all configured models at start** (litellm). A dead embedding endpoint aborts `graphrag index` before any workflow runs. Embeddings are a start-time precondition, not a tail-stage option. |
| E9 | Latent Java crash: `IndexCli.update()` first-run path reads `manifest.json` inside `if (firstRun)` where `firstRun = !Files.exists(manifestFile)` → `NoSuchFileException`. |

## 2. Principles

| # | Principle |
|---|---|
| P1 | The plugin reports only what is true. An incomplete index is never presented as available. |
| P2 | Spawn only when preconditions hold. A doomed run is skipped with one recorded reason. |
| P3 | A run succeeds when its artifact set is complete, not when the process exits. |
| P4 | Shared infrastructure: every new behavior is config-gated. Defaults preserve prior behavior for other consumers. |
| P5 | Lifecycle state lives in `manifest.json` (schema 2). Hooks act on state, not optimism. |
| P6 | Ownership split: Java (`IndexCli`) owns the completion gate, reindex threshold, manifest status writes. TypeScript owns preflight, key injection, query gating, notices, status composition. Rationale: the TS side spawns detached; only Java observes the run. |

## 3. Manifest v2 contract

JSON keys. Java writes gate fields; TS merges its fields read-modify-write. Old manifests (no schema key) are read with defaults: `schema=1`, `status="unknown"`, `consecutive_failures=0`, null reasons, empty `artifacts_present`.

```json
{
  "schema": 2,
  "commit": "...", "timestamp": "...", "graphrag_version": "...", "graphrag_binary": "...",
  "dirty": ["..."],
  "status": "idle|building|complete|partial|failed_preflight|failed_run|stale|unknown",
  "last_good_build": "ISO|null",
  "partial_reason": "missing: entities.parquet, ...|null",
  "failure_reason": "graphrag index exit 1|missing env DEEPSEEK_API_KEY|embedding endpoint unreachable at http://localhost:1234/v1|null",
  "consecutive_failures": 0,
  "artifacts_present": ["documents.parquet", "text_units.parquet", "..."]
}
```

Writes are atomic (tmp + rename). Both sides preserve fields they do not own.

## 4. Requirements

### FS-1 Preflight (E2, E6, E8) — owner: TypeScript
- Trigger: before every index/update spawn; at `session.created` for reporting.
- Steps:
  1. Key resolution chain for `chat_api_key_env` and `embedding_api_key_env` (names from `config/graphrag.yaml`): `process.env` → `graph-index/.env` then project-root `.env` (`KEY=VALUE` lines) → `direnv exec <root> printenv KEY` (20 s cap).
  2. Probe `embedding_api_base` + `/models` (GET, default 2000 ms).
  3. Required key missing or embedding endpoint unreachable → **do not spawn**. Write `status=failed_preflight`, `failure_reason`. Log one line. Return a clean message from tool modes.
- Spawn passes resolved keys explicitly: `Bun.spawn(..., { env: { ...process.env, ...resolved } })`.
- Acceptance: reproduce Aug-7 (key unset, endpoint down) → one log line, no graphrag launch, manifest records reason.

### FS-2 Completion gate (E1, E3) — owner: Java
- In `IndexCli.init`/`update`, record `runStartMs` before `runGraphrag`.
- On exit 0, verify required artifacts (mtime ≥ start − 5 s, size > 0): `documents.parquet`, `text_units.parquet`, `entities.parquet`, `relationships.parquet`, `communities.parquet`, `community_reports.parquet`; `covariates.parquet` when `settings.yaml` enables `extract_claims`; `lancedb/` present.
- `update` gate checks the staged `update_output/<latest>/` set; `promote()` runs **only** when the gate passes (baseline stays intact on partial).
- Pass → `status=complete`, `last_good_build=now`, `dirty` cleared, `consecutive_failures=0`.
- Fail → `status=partial`, `partial_reason="missing: <files>"`, `dirty` preserved, `consecutive_failures++`.
- Non-zero exit → `status=failed_run`, `failure_reason="graphrag <subcommand> exit N"`, `dirty` preserved, `consecutive_failures++`.
- Dirty reconciliation: a run lasts minutes, and the plugin host records edits while it executes. The gate merges, never overwrites: a passed run keeps only the entries recorded during the run; a failed or partial run writes the union of start-of-run and during-run entries. Writing the start-of-run snapshot would silently drop edits made while the run was executing.
- Acceptance: kill mid-`extract_graph` → manifest `partial` naming missing files; queries blocked.

### FS-3 Reindex threshold (E4) — owner: Java
- In `update()`: when `dirty.size() > reindex_threshold` (config, default 400) **or** the previous status is `partial`, `failed_run`, **or `building`**, take the full path: export the whole corpus and run `graphrag index`, not `graphrag update`.
- A surviving `building` marker counts as broken: `update()` runs under the index lock, so a marker that still stands belongs to a run that died. Only a warm index with nothing dirty is a no-op — a cold index root always runs.
- A cold start (or full rebuild) exports the whole corpus. The empty dirty list must be passed as "no filter" (`null`), never as the filter itself, or the export silently writes nothing.
- Cache reuse makes the full rerun cheap for unchanged units.
- Acceptance: 2368 dirty files trigger a full index on the next idle.

### FS-4 Fail-loud status (E7) — owner: TypeScript
- `mode=status` output = Java status + TS-composed block: `status`, `last_good_build`, `consecutive_failures`, `partial_reason`/`failure_reason`, artifact checklist, embedding endpoint probe result, version match.
- Healthy = `status=complete` **and** `dirty` empty. On `session.created` with any other state: inject exactly one notice per session. The notice names the state, then whatever reasons exist, then `Run graphrag mode=index.` It never claims queries are unavailable — the per-mode artifact gate (FS-5) is the authority, and a failed preflight can coexist with a complete older index whose queries still work. Example (live state 2026-11-05):
  `graphrag index unknown; 2368 files dirty since 2026-08-07; Run graphrag mode=index.`
- A complete but stale index (`status=complete`, `dirty` non-empty) notifies `graphrag index stale: <n> files changed since <date>.` Silence there would hide staleness that the previous plugin reported.
- `status_notice: per_session|per_run|off` (default `per_session`).
- Acceptance: a session opened against today's stub index shows the line above.

### FS-5 Query gating (E5, E8) — owner: TypeScript
- Before spawning `graphrag query`, check mode prerequisites in `output/`:
  `local`: `text_units.parquet` + `lancedb/`; `global`: `communities.parquet` + `community_reports.parquet`; `drift`: `covariates.parquet` + graph parquets.
- Missing → return `index incomplete: <mode> requires <missing list>. Run mode=index to build.` No CLI spawn, no traceback.
- Version-mismatch refusal (design §3) unchanged.
- Acceptance: stub index (E1) → clean blocked message in all three modes.

### FS-6 Embedding precondition (E6, E8) — owner: TypeScript, reporting by Java
- Established fact: GraphRAG 2.7 validates the embedding model at start; graph workflows cannot proceed without a reachable embedding endpoint. `index` is therefore **blocked at preflight** when the endpoint is down (FS-1.2).
- The plugin must state this in the failure reason, so users fix the cause (start LM Studio / serve `nomic-embed-text` at the configured base) rather than re-run blindly.
- The `graph_complete_no_embeddings` status of draft v1 of this spec is **withdrawn**: the engine does not support that state.

### FS-7 Tool description and routing (E7, agent gap) — owner: TypeScript
- Tool description (both registrations, v1 `tool.graphrag` + v2 `editor.add`) adds the routing rule:
  `Use grep for exact strings, labels, and file anchors. Use graphrag local/global/drift only for thematic, cross-chapter, community, or semantic-relationship questions over the whole corpus. Queries run an LLM at query time (seconds to minutes).`
- Consumer-project authors add an AGENTS.md routing paragraph; the plugin does not write it.

### FS-8 Bug fix — owner: Java
- Fix E9: guard the `firstRun` manifest read (`Files.exists` check); treat missing manifest as empty dirty list.

### FS-9 Concurrency and child lifecycle — owner: Java
- `writeSettings` must not hardcode `concurrent_requests`. `chat_concurrent_requests` and `embedding_concurrent_requests` come from `config/graphrag.yaml` (default 10). A single-slot local server needs 1: extra in-flight requests only wait, and the queue makes a slow endpoint look hung.
- `IndexCli.runGraphrag` installs a shutdown hook that terminates the graphrag child. A killed CLI must never orphan it: an orphan keeps the model's connections and keeps consuming the cache with no supervisor (observed: an orphaned child ran 13 h against a one-slot model after its Java parent was killed).
- Acceptance: kill the CLI mid-run → no graphrag process survives; a run against a one-slot server shows one in-flight request, not ten.

### FS-10 Batch knobs and throughput guard — owner: Java + TypeScript
- `writeSettings` emits the batch controls GraphRAG 2.7 supports: `reasoning_effort` (default `low` — a reasoning model without an effort cap can consume the whole `max_tokens` budget as thinking and return zero content), `max_tokens`, `request_timeout`, `tokens_per_minute` + `rate_limit_strategy`, `requests_per_minute`. Keys: `chat_reasoning_effort`, `chat_max_tokens`, `chat_request_timeout`, `chat_tokens_per_minute`, `chat_requests_per_minute`.
- A throughput guard belongs in the plugin preflight: one probe call measures output rate; when the projected index time exceeds a budget (config `max_index_minutes`, default 120), the run is refused with the estimate and the reason. A ten-hour run that looks like a ten-minute one is a P1 violation, same as an unreported failure.
- Acceptance: a local single-slot backend with `chat_concurrent_requests: 1` and xhigh effort produces a refusal, not a silent multi-hour run; settings written for a fast backend carry `reasoning_effort: low`.

### FS-11 Change-detection completeness — owner: TypeScript + Java
- The editor/file-watcher hooks see only edits this process makes. The plugin must not depend on them alone:
  - **Removals**: `file.watcher.updated` with `unlink` records the source in `manifest.removed` (renames record the old path too). Ignoring `unlink` was why a deleted chapter kept its documents and entities forever.
  - **Structural inputs**: `.bib`, `.bst`, `.sty`, `.cls`, figure files (`.png`, `.jpg`, `.jpeg`, `.svg`, `.pdf`) and `.puml` set `manifest.full_reindex`. They change the rendered blocks without touching any indexed source.
  - **Git reconciliation**: at `session.idle`, before deciding whether work exists, union `git status --porcelain --untracked-files=all` (plus `git diff --name-status <commit>..HEAD` when the manifest carries a real commit) into the manifest. A checkout, rebase, or external editor otherwise leaves the dirty set empty while the tree changed. More than 2000 *new* paths escalate to `full_reindex`; an inherited large dirty list is history and is never cleared by this pass.
- Java consumes both signals: documents for removed sources are deleted from `input/`, and a removal or `full_reindex` forces `graphrag index` rather than `update` (an update cannot be trusted to drop the entities of a document that no longer exists). A completed run clears `dirty`, `removed` and `full_reindex`; a failed or partial run keeps the union.
- Acceptance: delete a `.tex` and modify a `.bib` while no harness edit runs → the next idle pass shows `1 files removed` and `structural inputs changed` in `mode=status`, and the run takes the full path.

## 5. Config additions — `config/graphrag.yaml`

```yaml
reindex_threshold: 400          # FS-3 (Java reads; TS passes through status text)
preflight: true                 # FS-1 (TS; false restores legacy blind spawn)
status_notice: per_session      # FS-4 (per_session | per_run | off)
embed_endpoint_timeout_ms: 2000 # FS-1 probe
```

All keys optional. `preflight: false` + `status_notice: off` reproduces the v1 plugin exactly (P4).

## 6. Acceptance suite

| ID | Scenario | Expectation |
|---|---|---|
| A1 | Key unset, endpoint down, `session.idle` fires | no spawn; manifest `failed_preflight`; one log line |
| A2 | Run killed mid-`extract_graph` | manifest `partial` with missing-file list; baseline output preserved |
| A3 | `dirty=2368` | full-index path chosen |
| A4 | Query on stub index | blocked message per mode, no traceback |
| A5 | Session on `partial` index | exactly one notice line naming the state and ending with `Run graphrag mode=index.`; no claim about query availability |
| A6 | Full run, keys + endpoint live | `status=complete`, `dirty` cleared; global query answers |
| A7 | Old manifest (schema 1) | readable with defaults; no crash |
| A8 | `bun test` green: gate, threshold decision inputs, key-chain, notice composition | unit-verified |

## 7. Defects found during the first end-to-end attempt (2026-11-05, paper-scoped run)

The implementation above was audited and unit-tested before this section existed. The first real end-to-end attempt (`update` over `src/main/latex/ivp/ivp-graph-proof-2`) then exposed four defects that unit tests and code review had missed. All are fixed; the acceptance suite must cover them.

| # | Defect | Symptom | Fix |
|---|---|---|---|
| E10 | Cold start with an empty dirty set exited as a no-op | `[update] dirty-set empty, nothing to do` on a fresh index root; nothing ever built | no-op guard requires a warm index (`hasIndex && !firstRun`) |
| E11 | Cold start passed the empty dirty list to the exporter, which read it as a file filter | export reported `exported=0`, graphrag aborted with "No InputFileType.text files found" | export the whole corpus (`null`) whenever the run is cold or full |
| E12 | `latex_root: .` matched no files: `root.resolve(".")` keeps a `.` component, so `Path.startsWith()` fails for every file | export `latex=0` with no error | normalize the resolved root before the prefix test |
| E13 | A killed run leaves `status=building`; the next `update` treated it as a healthy warm index | silent no-op after a crash, stale marker never cleared | `building` counts as broken inside the lock; the session notice reports a `building` marker older than 6 h as stuck |
| E14 | A killed CLI orphans its graphrag child | the orphan ran 13 h against a one-slot model, keeping 10 connections and cache activity with no supervisor; the CLI looked exited | shutdown hook in `runGraphrag` terminates the child |
| E15 | `concurrent_requests: 10` hardcoded in the written settings | nine of ten requests sat idle behind a single-slot local server, so throughput and liveness were unreadable | `chat_concurrent_requests` / `embedding_concurrent_requests` config keys (default 10; single-slot servers use 1) |
| E16 | `unlink` events were ignored | a deleted chapter kept its documents and entities in the index forever | removals recorded in `manifest.removed`; documents deleted before export; a deletion forces `graphrag index` |
| E17 | No reconciliation with git | edits made outside the opencode process (checkout, rebase, external editor) never entered the dirty set | `reconcileFromGit` at `session.idle` unions `git status` and commits since the indexed commit; >2000 new paths escalate to a full reindex |
| E18 | Structural inputs were invisible | a `.bib`, `.sty` or figure change left the rendered blocks stale with no dirty entry | structural inputs set `full_reindex` |

Also verified in this attempt: `$(options)` is not a Bun 1.3 API (`.env({...})` is the supported spawn form), and the plugin host must merge dirty entries recorded during a run instead of rewriting the start-of-run snapshot.

## 8. Out of scope

Exporter semantics, `knowledge-graph` plugin, health-me-cfs enablement, query-answer quality scoring, AGENTS.md content (author writes).

## 9. Decisions (author-approved 2026-11-05)

| # | Decision | Resolution |
|---|---|---|
| D1 | `reindex_threshold` | 400 |
| D2 | Notice frequency | one line per session at `session.created` |
| D3 | Key source chain | `process.env` → `.env` files → `direnv exec` fallback; no secrets in the plugin repo |
| D4 | `graph_complete_no_embeddings` | withdrawn (E8) — index blocked at preflight instead |
| D5 | AGENTS.md routing paragraph | drafted for author approval; plugin does not write consumer docs |
