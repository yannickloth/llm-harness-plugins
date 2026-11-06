# sdlc-guardrails — Assumptions

SDLC artifact-contract guardrails: a Java CLI (fresh JVM per check) enforces
R1 plan-sync (warn), R2 protected paths (block), R3 test-protection during fix
scope (block), R5 audit log, R6 verification-before-done commit gate (block,
the one fail-closed rule), wired from a TS shim on `tool.execute.before` and a
`/sdlc-fix` / `/sdlc-plan` session toggle. Fail-safe policy: a broken contract
passes.

## OpenCode API

- v1 path (`server()` export): factory `{ client, directory, worktree }`,
  `tool.execute.before/after` with `{ tool, sessionID, args }`,
  `command.execute.before` with `{ command, sessionID, arguments }`, and a
  `config` hook whose `agent` map accepts inline entries.
- ⚠ Verified against opencode 2.2.5: the module loader never invokes
  `server()` — the v1 entrypoint (including the working
  `command.execute.before` toggle) is dead in the current harness.
- ⚠ v1 toggle assumes the command name arrives as `/sdlc-fix` (with leading
  slash); the v1 event format is not verifiable from the 2.2.5 source.
- v2 path: `ctx.location.project.canonical` for the root,
  `ctx.agent.transform` editor with `get`/`update` (create-by-update),
  `ctx.tool.hook("execute.before"|"execute.after")` events
  `{ tool|name, input|args, sessionID }`, `ctx.tool.transform` with
  `editor.add({ name, description, input, execute })`.
- ⚠ Verified against 2.2.5: only `execute.before` tool hooks can block by
  throwing; `execute.after` is advisory. The shim blocks via throw in
  `execute.before` only.
- ⚠ Verified against 2.2.5 source: command execution expands the command
  template before prompting (`packages/core/src/config/plugin/command.ts`), so
  the v2 `prompt` session hook sees `"Run this: echo '…'"`, never `/sdlc-fix` —
  the v2 fix-scope toggle (`/^\/(sdlc-fix|sdlc-plan)\b/` on `event.prompt.text`)
  can never match. The R3 toggle is unreachable in the live harness.
- Agents (`test-guard-auditor.md`, `plan-auditor.md`) are registered inline via
  `shared/agents.ts`; its hand-rolled frontmatter parser reads top-level scalar
  keys only (no nested YAML), and `test-guard-auditor.md` has no `mode:` key, so
  it defaults to `subagent`.

## Environment

- Java ≥ 25 on `PATH`; one fresh JVM per check (`check`, `check-cmd`, `verify`,
  `status`, `audit`, `sync`, `incident`). No `--add-opens` needed (no env
  injection in this plugin).
- `git` on `PATH` for `GitDiff` (diff, rev-parse, merge-base).
- Bun runtime for the TS shim.
- ⚠ If `build/classes` is missing (fresh clone — `**/build/` is gitignored and
  built only by the root `build.sh`), every JVM call fails, every verdict
  parses to null, and all rules — including the fail-closed R6 commit gate —
  silently pass.

## Filesystem & layout

- Contract config: `<root>/.sdlc-guardrails/config.json`; audit log
  `<root>/.sdlc-guardrails/audit.jsonl`; incidents
  `<root>/.sdlc-guardrails/incidents/`. ⚠ None of these are gitignored; the
  plugin writes runtime state into the user's repo.
- Fix-scope state: `<root>/.sdlc-guardrails/fix-scope.json`, rewritten
  (non-atomic `writeFileSync`) on every toggle; read on every check.
- Artifacts searched in `root`, `docs/`, `artifacts/`, `.sdlc-guardrails/`,
  `intent/`, `spec/`, `plan/`, then a depth-4 `Files.walk` (skipping
  `node_modules`/`.git`/`target`/`build/classes`).
- R6 evidence: `tmp/eval-loop-score.md` by default, must be ≤ 30 min old and
  end in an all-`pass` line (eval-loop snapshot format).
- `incident` scaffolds `intent/intent.md` (created if missing, appended to if
  present).

## External services

- None. No network access in any code path.

## Configuration

- Hand-rolled JSON parser (no dependency): objects, arrays, strings, booleans,
  numbers. ⚠ `Json.bool` ignores string values (`"enabled": "true"` is
  dropped); a malformed number (`1e`, `null`) throws an uncaught
  `NumberFormatException` that escapes `catch (IOException |
  SdlcGuardrailsException)` and lands in the CLI's fail-open catch.
- No config + a discoverable `plan.md` ⇒ `enabled=true` with plan-sync only
  (R1). No plan, no config ⇒ all rules off.
- Default `testPaths`: `**/test/**`, `**/tests/**`, `**/*.test.*`,
  `**/*_test.*`.
- ⚠ Glob matching is suffix-or-full only: a bare directory pattern (`secrets`,
  `secrets/`) never matches its children; `secrets/**` is required.
- ⚠ `PlanTracker` reads file paths only from `-` bullets and strips `**` before
  matching — a glob bullet like `- **/generated/**` degrades to the literal
  path `generated` and matches nothing.
- ⚠ `PlanTracker.isFixPlan()` (the `[fix]` bullet / `## Fix` section marker) is
  computed but never read anywhere — the design's "plan marks the step as a
  fix" half of R3 is dead code.

## Concurrency

- Fresh JVM per tool call: two concurrent gated tool calls run two JVMs. The
  audit append (`Files.writeString … APPEND`) is not atomic despite the
  "Atomic appends" comment; concurrent writers can interleave lines.
- ⚠ `fix-scope.json` is read-modify-written with no lock; a concurrent check
  and toggle can race.
- `AuditLog` is unbounded (no rotation or size cap); `tail()` and `size()` read
  the whole file on every call.
- `GitDiff.run()` waits on the child before draining its stdout; outputs larger
  than the pipe buffer (~64 KB) time out spuriously at 10 s.

## Data & LLM behavior

- Plan markdown contract: `## Files that change` section, one `- path` bullet
  per file; `plan.md`/`spec.md`/`intent.md` filenames are taken as-is from
  config. R1 is warn-only (a plan that exists but declares nothing never
  warns — `declares()` returns true for an empty declaration list).
- R3 as implemented blocks *every* test-path edit in fix scope; the documented
  "unless adding coverage" exception is not implemented anywhere.
- R6 "green" means the last non-blank evidence line contains a `pass` token
  after its `fail` tokens, scanning right-to-left; any other last line blocks.
- Incident ids are epoch milliseconds (`inc-<ms>`); two incidents in the same
  millisecond write one file (overwrite).
- The CLI's fail-open catch prints `e.getMessage()` unescaped; messages with
  quotes or newlines (git error output) emit invalid JSON, which the shim
  treats as "no verdict" — a pass.
