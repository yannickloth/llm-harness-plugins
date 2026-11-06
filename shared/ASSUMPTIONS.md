# shared — Assumptions

Shared TypeScript library imported by most plugins (`../../shared/...`). No
`opencode/` entry of its own: it is not a plugin, it has no hooks, and it loads
only when a plugin that imports it loads.

## OpenCode API

- Assumes OpenCode exposes `client.app.log({ body: { service, level, message, extra } })`
  as a Promise (`plugin-logger.ts`). ⚠ If the client method is missing or
  throws synchronously, logging is swallowed by design (never breaks the plugin).
  ⚠ The returned Promise is `void`ed without `.catch`: a rejected `app.log`
  becomes an unhandled rejection in the host process.
- `agents.ts` assumes V2 `ctx.agent.transform` editors have `get`/`update`, where
  `update(id, fn)` on an absent id creates a default agent, and the default agent
  object already carries a `permissions` array (the code `push`es rules into it;
  a missing array throws and the whole agent is skipped).
- `agents.ts` assumes V1 `config` hook receives a mutable config object with an
  `agent` map, and that V1's `permission` schema accepts exactly the keys in
  `V1_PERMISSION` (`edit`, `bash`, `webfetch`, `doom_loop`, `external_directory`);
  other verbs become `tools: { verb: false }` only when denied.
- `v2-skills.ts` assumes V2 `ctx.skill.transform` editors have `add({ id, name,
  description, path, content })` and that duplicate ids are ignored by the host.
- Assumes V2 transforms must run synchronously (returned Promises are ignored
  by the runtime).

## Environment

- Bun runtime: `safe-spawn.ts` uses `Bun.spawn`/`Bun.spawnSync` and Bun's
  signal-termination exit-code convention (signal number in `exitCode`).
  ⚠ The library does not work under plain Node.
- `module-dir.ts` assumes `import.meta.url` is populated (standard ESM); falls
  back to Bun's `import.meta.dir`; throws if neither exists.
- `load-canary.ts` is a no-op unless both `LLMHP_CANARY_DIR` and
  `LLMHP_CANARY_NONCE` are set (only the preflight probe sets them).
- `session-topic.ts` keeps topic state in a process-local Map. ⚠ State is lost
  on process restart; two opencode processes (parent + spawned child) classify
  independently.
- `config-settings.ts` writes backups to `~/.claude/backups` (hardcoded,
  Claude-Code-era path, created `0700`, backups `0600`, max 5, 60 s throttle).
  ⚠ On a host without `HOME` the module throws at first use.

## Filesystem & layout

- `instructions-md.ts` resolves `@include` paths relative to the including
  file's directory; `~/...` uses `$HOME`/`$USERPROFILE`; includes are confined
  to `rootDir` (realpath check) — but ⚠ the containment check is skipped for
  targets that do not exist, and ⚠ a missing include file is silently ignored
  (only circular/depth errors propagate), so a typo'd include path drops content
  without error.
- `instructions-md.ts` treats as text only the extensions in `TEXT_FILE_EXTENSIONS`
  (`.md`, source, config, etc.); everything else is rejected as binary.
  ⚠ Extensionless files and unusual extensions (e.g. `.mjs` is listed, `.r` is not)
  are blocked.
- Include depth limit 16; file size limit 2 MB; circular includes throw.
- `instructions-md.ts` substitution: the included content is spliced with
  `String.prototype.replace(marker, content)`. ⚠ `$&`, `` $` ``, `$'`, `$$` in
  included content are interpreted as replacement patterns and corrupt the
  output (verified: `$&` becomes the marker text). Known defect, not yet fixed.
- `agents.ts` / `v2-skills.ts` read `<plugin>/agents/*.md` and
  `<skills-dir>/<name>/SKILL.md` with a hand-rolled frontmatter parser:
  top-level `key: value` scalars only. ⚠ Multi-line YAML values (folded
  `>-`, lists, nested maps) are not parsed; a `description: >-` line yields no
  description and the skill falls back to an empty description.
- `agents.ts` agent id = frontmatter `name` if present, else the filename.
  ⚠ Two files with the same `name:` collide; the first (sorted) wins.

## External services

- None. No URLs, ports, or protocols.

## Configuration

- `config-settings.ts` `buildConfigCascade` assumes a two-tier JSON settings
  cascade (userSettings priority 1, localSettings priority 2) plus flag
  overrides (priority 999); `null` values delete a key on merge.
- ⚠ `wouldLoseAuthState` blocks any save that removes a key named like a
  credential (`apiKey`, `token`, `secret`, `password`, …) with a non-`${...}`
  string value, even for benign same-named keys.
- ⚠ `acquireLock` opens the lock file with `openSync("wx")` and never closes
  the fd: one leaked fd per `saveConfigAtomic` call.
- `canary_preflight.sh` assumes `python3`, `sha256sum`, GNU `sleep 0.2`,
  `mktemp -d`, and that the opencode binary supports `run --model <id>` and,
  optionally, `--standalone` (detected via `run --help`). ⚠ Plugin ids with
  spaces break its word-splitting loops.
- `canary_preflight.sh` caches OK stamps per (binary version, config sha256,
  plugin-id list) under `LLMHP_CANARY_STATE` (default `${TMPDIR:-/tmp}/llmhp-canary`).
- `canary_preflight.sh` assumes `LLMHP_CANARY_ORDER=1` (default): plugin init
  order must match config order, verified on the `performance.now()` token.

## Concurrency

- `safe-spawn.ts` `spawnDetached` sets `detached: true` (own process group) so
  `killProcessTree` can signal `-pid`. ⚠ Default `stdout: "pipe"`: a caller
  that does not drain the stream lets the child block on a full pipe buffer.
- `safe-spawn.ts` sets `LLMHP_NO_SUBSPAWN=1` on every child: child opencode
  processes that load the same plugins must honor it and refuse to spawn
  further children (recursion guard).
- `config-settings.ts` locking is a stale-after-30 s `wx` lock file; ⚠ the
  unlink-then-reopen of a stale lock is racy between processes.
- `load-canary.ts` writes are `mkdirSync` + `writeFileSync`, non-atomic
  (acceptable: markers are probe-only and best-effort).
- `session-topic.ts` is not thread-safe beyond single-threaded JS; no locks.

## Data & LLM behavior

- `safe-spawn.ts` `extractOpencodeText` / `extractOpencodeSessionId` assume
  `opencode run --format json` emits one JSON object per line, text parts as
  `{"type":"text","part":{"text":...}}`, and a top-level `sessionID` on events.
  ⚠ A format change in opencode silently yields empty extraction.
- `session-topic.ts` classification is a fixed regex list (English project
  markers including single-letter `c`, `h`, `ts`, `js`; French/German/Spanish/
  Italian personal markers). ⚠ English "work" is not a project marker; French
  "C'est" matches the single-letter `c` project marker; once a session is
  classified `project` it stays `project` for the process lifetime (sticky).
- `cache-boundary.ts` places all non-cached sections after one
  `__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__` marker; assumes the consuming
  opencode version respects this marker for prompt caching.
- `plugin-logger.ts` log levels map 1:1 to the client's `app.log` body.
