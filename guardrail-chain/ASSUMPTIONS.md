# guardrail-chain — Assumptions

Plugin exposes 4 model-callable guardrail tools (scan-secrets, check-injection,
check-path, transcript-filter) backed by a Java CLI, and is supposed to scan
files after write/edit for leaked secrets (report-only logging). No hard
gating of tool execution happens in this plugin.

## OpenCode API (hooks used, v1 vs v2, version sensitivity)

- v1 entry served via `server(input, options)` (repo idiom); v2 entry: `id` + `setup(ctx)`.
- v1: 4 tools in the `tool` map + a `file.edited` event hook (report-only scan of edited files).
- v2: tools via `ctx.tool.transform` (JSON Schema inputs); post-edit scan moved to `ctx.tool.hook("execute.after")` filtered to `write`/`edit`.
- ⚠ `file.edited` is NOT declared in the @opencode-ai/plugin v1.19.3 `Hooks` interface (no index signature). It relies on the OpenCode runtime dispatching arbitrary event names as hooks — same convention as knowledge-graph, agentmem, graphrag. If a runtime version stops dispatching it, the v1 scan silently never runs.
- ⚠ v2 `execute.after` event shape is guessed defensively (`event.tool ?? event.name`, `event.input.filePath ?? event.input.file_path ?? event.args.filePath`); not verifiable against a local v2 spec.
- ⚠ Root `opencode.json` does NOT register this plugin; `opencode.json.sample` registers `./guardrail-chain/opencode` (directory form). Inactive under the current repo config.

## Environment (env vars, binaries, OS/process assumptions)

- ⚠ `java` on PATH (classes built with `--release 25`).
- No environment variables are read.
- No timeout on the java subprocess.
- ⚠ The post-edit scan runs `output-filter --`, i.e. stdin mode, but never pipes the file content to the child: the child inherits the parent's stdin. With stdin = /dev/null (headless) it scans an empty string and passes; with an open TTY/pipe (interactive session) it blocks until EOF — the hook hangs and the JVM is orphaned (both verified empirically). The `readFileSync` content is only used for a length check and is otherwise dead.
- Bun `$` shell semantics assumed: interpolated strings are single argv entries (no word splitting, no shell injection), arrays are spliced, and very large argv (≥ 4 MB) is accepted (all verified; node's E2BIG limit does not apply under bun).

## Filesystem & layout (paths, anchoring, formats, encodings)

- Classpath anchored at `<plugin>/build/classes` resolved via `moduleDir(import.meta.url, …)` — requires the background build to have compiled the plugin. ⚠
- ⚠ `check-path` resolves relative `target`/`containment` against the opencode server process CWD, not the project root; the tool description does not state this.
- Post-edit hook reads the edited file from disk (UTF-8, ≤ 100 000 chars) after `path.resolve(root, file)` when relative; skips silently when the file is absent or oversized.
- TOCTOU: existsSync → statSync → readFileSync can throw on concurrent deletion (uncaught in the async hook).
- No state is written by this plugin.

## External services

- None. No URLs or ports.

## Configuration

- Must appear in opencode.json `plugin` array (sample does; root does not). ⚠
- `GuardConfig.blockOnCritical` is never consulted by the pipeline: `all()` and `warnOnly()` behave identically; injection and size findings are always Warn in pipeline commands, only secrets and path violations Block. ⚠
- Pipeline commands always use `GuardConfig.all()`; per-plugin config is only reachable from in-process Java callers (e.g. agentmem).
- Design doc says `runOutputFilter` runs "SecretScanner, PromptGuard"; code runs SecretScanner + size bounds only (no injection scan on output). ⚠ Doc/code divergence.
- `prompts/agent-prompt.md` is referenced by no config or code (orphaned) and instructs running a `gcl` CLI that does not exist anywhere in the repo. ⚠ If ever injected, the agent is told to run a nonexistent command.

## Concurrency (locks, multi-instance, atomicity)

- Stateless per call; no locks, no shared files. Concurrent invocations are safe.
- PathValidator has a write side effect (see below), which is not synchronized with the subsequent write.

## Data & LLM behavior (formats trusted from model, model assumptions)

- Tool inputs (content, prompt, target, containment, transcript) are model-supplied strings; passed to the JVM as single argv entries.
- ⚠ Transcript input must be a top-level JSON array of objects. Assistant-role messages are stripped; messages whose `role` is missing or non-string are DROPPED (fail-closed). A truncated array (missing `]`) is silently accepted as success with a partial message list (verified). > 1000 messages errors with a misleading "trailing content" message (the "too many messages" branch is dead).
- ⚠ SecretScanner patterns are heuristic; `-----BEGIN ENCRYPTED PRIVATE KEY-----` is NOT matched (verified).
- PromptGuard injection and zero-width findings are Warn-only (advisory); they never block a pipeline run.
- PathValidator: containment is checked via `toRealPath` (symlinks resolved) when the target or its parent exists; `validate()` creates the parent directory of a nonexistent target as a side effect before the containment check. ⚠
- `validateProtectedFiles` compares only the target's filename, so a symlink named like an allowed file that points at a protected file passes the protected-file check (the containment check may still catch escapes).
