# agentfeed — Assumptions

agentfeed coordinates multiple agents in one project. Agents publish events (messages, task claims, resource holds, questions) to a shared append-only JSONL ledger. The plugin injects a watermark digest of new entries into later prompts, injects a static coordination note into the system prompt, auto-records git/file activity from tool calls, exposes 12 `coord_*` tools, and regenerates per-agent and aggregate Atom feeds via a compiled Java CLI after each write.

## OpenCode API (hooks used, v1 vs v2, version sensitivity)

- ⚠ Both v1 (function form via `server()`) and v2 (`id` + `setup(ctx)`) entrypoints are shipped; a host picks one. The plugin is dead if the host supports neither shape.
- v1 hooks used: `config`, `chat.message`, `experimental.chat.system.transform`, `tool.execute.after`, `tool` map via `@opencode-ai/plugin` `tool()` (zod args).
- ⚠ `experimental.chat.system.transform` carries an `experimental.` prefix; a rename in a plugin-SDK release silently drops the system-note injection.
- v2 hooks used: `ctx.session.hook("prompt")`, `ctx.session.hook("context")`, `ctx.tool.hook("execute.after")`, `ctx.tool.transform(editor)`, `ctx.skill.transform(editor)`.
- ⚠ v2 v1 payload field names differ; the code reads `event.agent ?? event.info?.agent`, `event.tool ?? event.name`, `event.system` as `{type,text}[]`. A field rename means silently less bookkeeping or no injection (best-effort by design, not detected).
- ⚠ v2 root comes from `ctx.location?.project?.canonical ?? ctx.location?.directory`; if both are absent, `path.join` throws during `setup` and the whole plugin fails to load.
- ⚠ v1 root comes from `worktree ?? directory`; the ledger anchors to the *session* worktree, so separate worktrees get separate ledgers (no cross-worktree coordination without git commits of the ledger).
- Tool execute context: v1 `ctx.agent` names the acting agent; v2 `context.agent ?? "default"`.
- Installed SDK is `@opencode-ai/plugin` 1.18.18 (repo tasking says 1.19.3); hook names match the installed d.ts.

## Environment (env vars read, with defaults; binaries on PATH; OS/process assumptions)

- `LLMHP_CANARY_DIR` / `LLMHP_CANARY_NONCE` (shared load canary): marker file written only under `shared/canary_preflight.sh`; no-op when unset. No other env vars are read by this plugin.
- ⚠ `java` on PATH (option `javaBinary`, default `"java"`), version ≥ 25. The feed-regen spawn is fire-and-forget: a missing java means feeds never regenerate (warn logged), ledger keeps working.
- ⚠ Java tests use JEP 512 compact source files / instance `main` (GA in JDK 25); a JDK 24 toolchain cannot compile `AtomFeedTest.java`.
- ⚠ POSIX host assumed: `rename(2)` atomicity for tmp+rename writes, `O_APPEND` append, `process.kill(pid, 0)` liveness probe, `os.hostname()` per-host identity. Not tested on Windows.
- Bun runtime for TS plugins and tests (`bun test`); the v2 entry assumes `import.meta.url` is a `file:` URL (module-dir fallback).

## Filesystem & layout (paths read/written, where anchored — cwd / repo root / XDG; formats; encodings)

- All paths anchor at the session root (v1 `worktree ?? directory`, v2 `ctx.location`), not at cwd or an XDG dir.
- `<root>/agentfeed/ledger.jsonl` — the ledger (JSONL, UTF-8). Default `ledgerDir` equals the plugin's own directory in this repo.
- ⚠ `agentfeed/ledger.jsonl` is git-ignored by the root `.gitignore` (line 19) even though design doc, manual, and code comments state the ledger is committed to git and that git is the durable record. The cross-host merge model and the `.gitattributes` merge driver are inactive for an ignored file.
- `<root>/agentfeed/.ledger.lock` — same-host lockfile (JSON `{pid, ts}`), git-ignored.
- `<root>/agentfeed/feeds/feed.xml`, `feeds/feed-<agent>.xml`, `feeds/digest.md` — generated outputs, git-ignored; `digest.md` is a single file shared by all sessions.
- `<root>/agentfeed/.agentfeed/watermarks/<session>_<agent>.json` — per-(session,agent) read position (watermark), git-ignored; filenames sanitize non-`[a-zA-Z0-9_.-]` to `_` (different inputs can collide).
- `<root>/agentfeed/.agentfeed/ledger-archive/YYYY-MM.ledger.jsonl.gz` — compact archives (concatenated gzip members), git-ignored.
- `agentfeed/opencode/../build/classes` (i.e. `agentfeed/build/classes`) — must be compiled by the repo `build.sh` before live feeds work; `eu.infolead.llmhp.agentfeed.AtomCli` is the invoked main class.
- `.gitattributes` maps `agentfeed/ledger.jsonl merge=agentfeed-ledger`; each host must also run `git config merge.agentfeed-ledger.driver 'java agentfeed/tools/AppendOnlyMergeDriver.java %O %A %B'` (not automated; not possible while the file is ignored).
- Encoding is UTF-8 in all TS I/O (explicit `"utf8"`) and in Java I/O (JDK 18+ default charset).
- Ledger lines are trusted to be one JSON object per line; malformed lines are skipped on read (never repaired).

## External services (URLs/ports, protocol assumptions)

- None. No network I/O. The only "protocol" is the Atom XML written to local files (well-formed by construction: entity escaping + control-char stripping).
- Feed `<link rel="self">` always points at `feed.xml`, including in per-agent feeds.

## Configuration (what opencode.json must register for it to work; whether it actually is)

- ⚠ The plugin must appear in the `plugin` array, e.g. `"./agentfeed/opencode/index.ts"` (manual) — it is registered in **neither** `opencode.json` nor `opencode.json.sample`. The plugin is currently inert in this repo.
- Options (v1 factory arg / v2 `ctx.options`): `ledgerDir`, `maxDigestEntries` (50), `liveFeeds` (true), `javaBinary` (`"java"`), `feedOutDir` (`<ledgerDir>/feeds`), `autoGit` (true), `autoFile` (true), `resourceCoalesceMs` (30000), `resourceLeaseMs` (1800000), `compactRetentionMs` (7 days), `topicGate` (true).
- The `coordinate` skill self-registers itself: v2 via `ctx.skill.transform` with absolute paths (works); v1 via the `config` hook writing `skills[<name>] = { file: <path relative to the plugin's opencode dir> }` — a shape no sibling plugin uses and a path that does not resolve from the project root.
- ⚠ The design doc's "Config" section shows only the `plugin` array entry; it does not mention that registration is missing from this repo's configs.

## Concurrency (locks, multi-instance behavior, atomicity)

- Same host: advisory lockfile (`O_EXCL` create, JSON pid+ts payload) around append and compact; stale locks (older than 60 s **and** pid dead) are stolen; waiters give up after 15 s with a thrown error.
- ⚠ A live but hung lock holder (pid alive, event loop blocked) is never stolen; all other same-host writers fail after 15 s until the process dies.
- ⚠ Lock liveness trusts pid identity (pid reuse → lock not stolen); the age check uses wall-clock `Date.now()` (NTP jumps skew it).
- Appends: read-all-then-`O_APPEND` single small write under the lock; seq is per-host (foreign-host entries do not advance it).
- ⚠ ⚠ After `coord_compact`, seq is re-derived from the rewritten live file only. If an always-live entry (an `ask`) has a lower seq than archived entries, the next append reuses an archived seq → duplicate `host:seq` ids (merge dedup, `coord_await` position resolution, and Atom `urn` ids all assume uniqueness).
- Ledger rewrite on compact: tmp+`rename` (atomic) under the lock. Archive append: raw gzip members concatenated (valid multi-member gzip). Watermark writes: tmp+`rename`. `digest.md`: plain overwrite (not atomic; shared across sessions).
- Feed regen: fire-and-forget `java` spawn per write, no timeout, no child cap, pid-suffixed temp files + `ATOMIC_MOVE` in Java; overlapping runs are tolerated (idempotent output, last finisher wins).
- Cross host: no mutual exclusion by design; safety relies on git merge of host-qualified ids via the append-only merge driver — which (per the `.gitignore` above) is not active in this repo.
- Two opencode processes in the same directory coordinate via the same lock+file. Separate worktrees = separate ledgers.
- ⚠ The merge driver unions all three sides, so entries archived by compact on one host reappear after merging with a non-compact host; compact does not propagate.

## Data & LLM behavior (formats trusted from the model; model assumptions)

- The model supplies free text for `task`, `text`, `resource` names, and `to`; it is stored verbatim (JSON-escaped) and rendered into other agents' prompts (digest) and Atom feeds (XML-escaped).
- ⚠ Ledger text is a prompt-injection surface: one agent's `coord_log`/`coord_ask` text lands verbatim in every other agent's prompt.
- ⚠ Timestamps are trusted from `Date.now()` per host; global order is derived from `ts` (string compare of ISO UTC), so host clock skew mis-orders entries and can break watermark "newer than" logic.
- ⚠ Host identity is `os.hostname()` sanitized to `[a-zA-Z0-9_.-]`; an empty hostname degrades to `"unknown"` — two such hosts share a namespace and collide on seq.
- Git-ref extraction from bash commands is a best-effort regex (`ref`): it misreads commands with tokens after the git call (e.g. `git push origin main && echo done` → ref `done`).
- Tool-call args are trusted: `bash` tool name for shell commands, `filePath`/`path` for edit/write; a renamed OpenCode tool or arg silently disables auto-recording for that tool.
- ⚠ Topic gating (shared `session-topic` classifier) decides personal vs project from regex markers (code jargon vs Romance-language personal words); misclassification silently withholds or grants the digest.
- The first user message of each session is always skipped for digest injection (session-title hygiene); `seenSessions` is in-memory, so a process restart re-skips the next first message of an existing session.
- ⚠ The digest pointer says "N new entries" but the file holds at most 50 entries, and auto "touched X" events count toward N without appearing in the file.
- Lease strings are ISO-8601 UTC and compared as strings; a malformed lease is treated as never expiring (claims/holds stay open).
