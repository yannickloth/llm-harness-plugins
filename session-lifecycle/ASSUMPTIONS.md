# session-lifecycle — Assumptions

Session bookkeeping plugin: a Java sidecar (fresh JVM per event) writes
`tmp/sessions/` state (TSV access log, commit snapshots, archive), and a pure-TS
`spend.ts` mirrors OpenCode's own SQLite DB for the per-session cost summary.
Everything is fail-soft: a failed sidecar call or DB read degrades to
"no bookkeeping", never a broken session.

## OpenCode API

- v1 path (`server()` export): assumes the factory receives `{ client,
  directory, worktree }`, the `event` hook yields `{ type, properties:
  { sessionID } }`, and `tool.execute.after` input is `{ tool, sessionID, args }`
  with the file under `args.filePath|file_path|path|file`.
- ⚠ Verified against opencode 2.2.5: the module loader accepts `{ id, setup }` /
  `{ id, effect }` modules and never invokes `server()` — the entire v1
  entrypoint is dead in the current harness.
- v1 assumes `client.tui.showToast` exists and resolves with `{ error }`
  instead of throwing (handled in `index.ts` v1 `notify`).
- v2 path: assumes `ctx.location.project.canonical` / `ctx.location.directory`,
  `ctx.event.subscribe({ signal })` yields `{ type, data }`, and
  `ctx.tool.hook("execute.after", cb)` events carry `{ tool, sessionID, input }`.
- ⚠ Verified against 2.2.5 source: `session.idle` is declared `// deprecated`
  (`packages/schema/src/session-status-event.ts`) and never published by the
  server; the v2 idle branch (`diff-commits`/`archive`/`spend.report`) is dead.
  The working v2 mechanism is `ctx.session.hook("experimental.idle", …)`
  (triggered in `packages/core/src/session/runner/llm.ts`).
- ⚠ v2 assumes no toast API on the server plugin context; the spend summary is
  written to stderr instead.

## Environment

- Java ≥ 25 on `PATH` for every sidecar call; each call is a fresh JVM
  (hundreds of ms startup, sequential `await`s on the event iterator).
- The JVM is launched with `--add-opens java.base/java.util=ALL-UNNAMED`
  (`JVM_OPTS`) so the wrapper can inject `CLAUDE_PROJECT_DIR` by reflection.
  ⚠ If the flag is rejected, env injection fails and every hook class falls
  back to `user.dir` (the bun process cwd), writing state to the wrong tree.
- Bun runtime for the TS entry (`bun:sqlite`, `Bun.sleep`, `$` template shell).
- `spend.ts` assumes `XDG_DATA_HOME` or `~/.local/share` holds OpenCode's data
  dir (`opencode.db`).

## Filesystem & layout

- All state under `<root>/tmp/sessions/`: `<sid>.tsv`, `<sid>.tsv.lock`,
  `<sid>.commits.start` / `.commits.end`, `archive/<YYYY-MM>/<sid>/`,
  `hook-errors.log` (rotated to 3 gzip files, 1 MiB live cap).
- ⚠ `archive()` moves with `REPLACE_EXISTING`: a session that goes idle,
  resumes, and goes idle again overwrites its own archived TSV, and the second
  idle's `diff-commits` silently no-ops because `.commits.start` was already
  moved away.
- ⚠ v1 root is `worktree ?? directory`; v2 root is
  `ctx.location.project.canonical ?? ctx.location.directory`. In a worktree
  session the two versions write state to different places.
- ⚠ `build/classes` must be compiled by `build.sh`; the design doc says the
  `.class` files are committed, but `**/build/` is gitignored and none are
  tracked — a fresh clone with no build has every sidecar call silently no-op.
- ⚠ The sidecar classpath is `<plugin>/build/classes` only; the
  `breaker-*` / `auto-gate-*` subcommand classes import
  `eu.infolead.llmhp.shared.CircuitBreaker`, which lives in
  `shared/build/classes` — they would `NoClassDefFoundError` if ever invoked.

## External services

- None. No network access in any code path.

## Configuration

- Plugin option `spend: false` (v1 `options` / v2 `ctx.options`) disables the
  cost summary. No other configuration; no per-repo config file.
- Retention is hardcoded: `RETENTION_DAYS = 30` (archive prune),
  `STALE_HOURS = 24` (sweep), `TAIL_ROWS = 4096` (spend sync window).

## Concurrency

- TSV appends are guarded by a `RandomAccessFile` channel lock on
  `<sid>.tsv.lock` (advisory, released on close); commits.start/end files have
  no lock (single-writer per session by construction).
- ⚠ Fresh JVM per event: `session.created` runs 3 sequential JVMs (sweep,
  snapshot-commits, check-errors), `session.idle` runs 2 plus the spend report.
  Unload bounds the wait at 500 ms and may abandon an in-flight JVM.
- Spend cache (`spend-cache.db`): WAL, `busy_timeout=5000`,
  `synchronous=NORMAL`; the main DB is opened read-only. ⚠ Concurrent opencode
  processes share the cache file; a crash mid-bootstrap leaves partial rows
  (mitigated by `INSERT OR REPLACE` on the next pass).
- `prune()` / `repairZeroCost()` run once per process, not per idle.

## Data & LLM behavior

- `spend.ts` assumes OpenCode DB schema: v1 `message` (role + cost inside the
  `data` JSON) + `session`; v2 `session_message` (role in `type`, cost in the
  assistant row's `data`) + `session_v2`, with `parent_id` on the session table.
  `message` wins when both exist. ⚠ Schema drift disables accounting with a
  warning only.
- ⚠ The rebuild check only fires when the source DB shrank
  (`srcMax < cachedRid`). A recreated `opencode.db` with a larger rowid space
  keeps stale cached rows (wrong session_id/cost for low rowids) because
  `sync()` only refetches the 4096-rowid tail and new rows, and `prune()` only
  deletes rids that vanished.
- ⚠ Cost corrections on messages older than the tail window stay stale forever
  unless their cached cost is 0 (`repairZeroCost` only targets zeros).
- TSV format assumes file paths contain no tabs or newlines (a tab in a path
  shifts columns).
- The Java consumers parse the wrapper's stdin JSON with a regex
  (`extractString`); `LogFileChange` unescapes `\"`/`\\` but the Start/End/
  Archive consumers do not — paths containing quotes parse differently per
  hook. The wrapper's `escape()` does not escape other control characters.
- The git "5 s timeout" in `SessionStartCommits`/`SessionEndCommits` is
  ineffective: the stream is drained before `waitFor` runs, so a hung git
  (e.g. credential prompt) blocks the event iterator indefinitely.
