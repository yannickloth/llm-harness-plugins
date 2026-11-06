# permission-modes — Assumptions

Plugin gates every tool call through a 6-mode permission state machine
(default, plan, acceptEdits, bypassPermissions, dontAsk, auto). A BYPASS_IMMUNE
path list forces prompts for write tools touching protected paths. State
persists per project and is shared across fresh JVMs via JSON + file lock.

## OpenCode API (hooks used, v1 vs v2, version sensitivity)

- v1 entry served via `server(input, options)`, returns the v1 factory result (repo idiom, all 28 plugins).
- v1 hooks: `tool.execute.before` (`input.tool`, `output.args`) + 4 tools (`permission-mode`, `permission-status`, `permission-state`, `permission-check`).
- v2 entry: `id` + `setup(ctx)`; `ctx.tool.hook("execute.before", …)`; tools via `ctx.tool.transform` with JSON Schema inputs.
- ⚠ v2 event shape is guessed defensively (`event.tool ?? event.name`, `event.input ?? event.args`); not verifiable against a local v2 API spec.
- Hook contract: throw = hard deny; prompt and allow both return normally so opencode's own permission gate handles prompting. ⚠ If opencode's gate is configured permissive, "prompt" decisions degenerate to allow.
- Tool names matched case-insensitively; unknown tools map to category `other`.
- ⚠ Root `opencode.json` does NOT register this plugin; `opencode.json.sample` registers `./permission-modes/opencode` (directory form). In the current repo config the plugin is inactive.

## Environment (env vars, binaries, OS/process assumptions)

- ⚠ `java` must be on PATH (classes built with `--release 25`). Missing java / JVM crash / classpath error → every check is ALLOWED (fail open, logged as warn).
- No environment variables are read.
- One JVM spawn per `tool.execute.before`; no timeout on the subprocess.
- Lock wait: 5 s deadline, 10 ms retry (Java side).
- ⚠ On Java spawn failure, non-zero exit, or unparseable stdout the tool is allowed — documented as intentional in index.ts, but dontAsk/plan silent blocks and auto-strip are silently lost (see Concurrency/Security note).

## Filesystem & layout (paths, anchoring, formats, encodings)

- State: `{projectDir}/tmp/sessions/.permission-modes/state.json`; lock: `.lock` alongside. UTF-8, hand-rolled JSON serde.
- `projectDir` = v1: `worktree ?? directory`; v2: `ctx.location.project.canonical ?? ctx.location.directory`. ⚠ If `ctx.location` is absent in v2, `root` is `undefined`, bun stringifies it to `"undefined"`, and state silently lives under `<server cwd>/undefined/…` with a fresh DEFAULT mode forever (verified: bun interpolates undefined as "undefined").
- acceptEdits CWD check is lexical: relative paths must not normalize to `..`; absolute paths must prefix the project dir. Symlinks are NOT resolved. ⚠ Lexical-only containment.
- For `bash`, the "path" is the full command string; immune matching is segment/substring heuristic over it.
- ⚠ `matchesSegment` inspects only the FIRST occurrence of a pattern in a bash command (`String.indexOf`); a protected path mentioned only in a later command segment is not flagged (verified: `echo xopencode.json && cat opencode.json` → immune=false).
- ⚠ `extractFilePath` returns "" for `webfetch`, `skill`, `task` (no arg is read), so the BYPASS_IMMUNE gate is unreachable for those tools despite `IMMUNE_WRITE_TOOLS` and the manual listing them.
- Save: temp file + `ATOMIC_MOVE` + `REPLACE_EXISTING`.
- ⚠ Hand-rolled JSON parser (`splitTopLevel`/`splitFirst`) mis-tracks string state on an escaped backslash directly before a closing quote (`\\`): a deny/allow/immune entry whose text ends in a backslash is silently dropped on load (verified via CLI).

## External services

- None. No URLs or ports.

## Configuration

- Must appear in opencode.json `plugin` array to be active (manual: after guardrail-chain). Not present in root `opencode.json`; present in `opencode.json.sample`. ⚠
- Manual shows `./permission-modes/opencode/index.ts`; sample registers the directory `./permission-modes/opencode` (repo convention).
- Mode names validated case-insensitively; invalid mode → JSON error object, exit 0.

## Concurrency (locks, multi-instance, atomicity)

- Cross-process file lock (FileChannel.tryLock + fcntl on Linux) on `.lock`; per-JVM, released on process exit.
- ⚠ The lock does NOT span load → transition → save: `loadState` and `saveState` each lock separately; concurrent transition JVMs on the same project can lose an update (last writer wins). Design doc's "cannot clobber" claim holds only for single file I/O.
- Check is read-only; stale reads possible if a concurrent transition saves between two checks.
- Atomic move prevents torn state files; a crash between temp-write and move leaves a stale `state.json.tmp.*` (harmless).

## Data & LLM behavior (formats trusted from model, model assumptions)

- Tool args trusted as strings: edit/write → `filePath`|`path`|`file`; bash → `command`; read/task → `file_path`|`filePath`. ⚠ If opencode renames an arg, the immune/CWD check silently sees no path and skips gating.
- Model-supplied mode name for `permission-mode` is untrusted input; validated against the enum (case-insensitive).
- state.json on disk is trusted but parsed leniently: unknown modes → DEFAULT; non-`{…}` content → ignored (DEFAULT). Corrupted-but-braced JSON can drop entries silently (see Filesystem bullet).
- ⚠ dontAsk mode also blocks the plugin's own `permission-mode` tool — the agent cannot self-exit dontAsk via tools; recovery is a user slash command or SDK call.
- Tests pin the tri-state contract: prompt must not throw, only hard deny throws (index.test.ts:81-129).
