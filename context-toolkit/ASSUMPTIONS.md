# context-toolkit — Assumptions

Registers the plugin's own skills (`<plugin>/skills/<name>/SKILL.md`) and
agents (`<plugin>/agents/<name>.md`) with OpenCode. v1 writes them into the
`config` hook output; v2 replays them through the `ctx.skill.transform`
and `ctx.agent.transform` editors. No per-event hooks.

## OpenCode API (hooks used, v1 vs v2, version sensitivity)

- v1 hook: `config` — valid v1 hook name per `@opencode-ai/plugin` 1.19.3.
- ⚠ v1 writes `(input as any).skills.paths`; the v1 `Config` type has no
  `skills` key (verified in `@opencode-ai/sdk` 1.19.3). The `any` cast
  hides the mismatch, so under opencode 1.x the skills directory is never
  registered (agents are, via `config.agent`).
- v1 agents: `registerAgentDirV1` writes `config.agent` entries with
  fields that match v1 `AgentConfig` (`prompt`, `mode`, `maxSteps`,
  `model`, `description`, `color`, `disable`, `permission`, `tools`).
- v2: `ctx.skill.transform((editor) => …)` and
  `ctx.agent.transform((editor) => …)` — verified against
  `@opencode/plugin` 2.0.29 and the opencode 2.2.5 binary. The skill
  editor takes fully-formed records; the agent editor has no `add`, so
  creation is `update(id, …)` on an absent id.
- ⚠ v2 agent editor is assumed to expose `get(id)`, `update(id, cb)` and a
  mutable `agent.permissions` array (rules are pushed). The 2.2.5 binary's
  builtin agents build `name` / `description` with a branded `.make`
  constructor, while this code assigns plain strings — a strict host may
  reject or ignore the assignment, and the surrounding `try/catch`
  swallows any failure silently.
- ⚠ v2 skill record shape `{ id, name, description, path, content }` is
  asserted by a code comment to match `ctx.skill.list()`; not
  independently verified against the binary.
- ⚠ The v2 API is untyped in the declared dependency (`ctx: any`);
  `@opencode-ai/plugin` 1.19.3 types none of the v2 surface.
- Version sensitivity: v1 path only runs under opencode 1.x (`server`);
  v2 under 2.x (`setup`).

## Environment (env vars, binaries, OS/process)

- `LLMHP_CANARY_DIR` + `LLMHP_CANARY_NONCE` — load canary marker written
  in both entrypoints (shared/load-canary); no-op otherwise.
- Module directory resolution uses `import.meta.url`
  (`import.meta.dir` only as fallback, shared/module-dir); no env vars
  required.
- Synchronous Node/Bun `fs` API.
- No external binaries.

## Filesystem & layout

- Skills at `<plugin>/skills/<name>/SKILL.md`, agents at
  `<plugin>/agents/<name>.md`, both resolved relative to the plugin
  module directory. Currently one skill (`compact-context`) and one agent
  (`context-fidelity-auditor`).
- A missing `skills/` or `agents/` directory is tolerated (count 0 /
  empty list).
- ⚠ A broken symlink inside `skills/` or `agents/` makes `fs.statSync`
  throw during plugin load (`skillCount` / `readAgentRecords`) and fails
  the whole load.
- Skill frontmatter: minimal YAML reader for top-level `name:` /
  `description:` scalars only; nested or multi-line values are ignored;
  name falls back to the directory name, description to `""`.
- Agent frontmatter: deliberate subset (`name`, `description`, `mode`,
  `steps`, `model`, `color`, `hidden`, nested `permission:` map); Claude
  Code artifacts (`tools:`, `permissionMode:`) are intentionally ignored.
- Agent `model` must be `provider/model[#variant]`; bare aliases are
  dropped. Permission verbs outside the v1 closed set map to v2 actions
  (`bash`→`shell`, `write`/`patch`→`edit`, …) with resource `"*"`.
- Skill id deduplication and rejection are delegated to the host (a
  throwing `editor.add` skips that entry only).

## External services

- None. No network I/O.

## Configuration

- Registered in the repo `opencode.json` (`./context-toolkit/opencode`);
  not in `opencode.json.sample`.
- No configuration surface: no options, config block, or env vars; the
  skill/agent directories are fixed relative to the module.
- ⚠ Under v1 the load log line reports the skill count and the `config`
  hook appends the path, but the write has no effect (no `skills` key in
  v1) — the log overstates what v1 does.

## Concurrency

- All work is synchronous at setup/load time; no event subscriptions and
  no session state, so a process restart loses nothing.
- ⚠ v2 transforms replay on every load; agent registration is guarded by
  `editor.get(id)` and skill registration by the host's duplicate
  handling — assumes the editor's state persists across replays within
  one host process.

## Data & LLM behavior

- Skill `content` is registered verbatim; discovery and surfacing to the
  model are the host's responsibility.
- Agent `system` prompt is the agent file's markdown body (frontmatter
  stripped); agent `mode` defaults to `subagent` when absent or invalid.
- No other LLM-behavior dependency.
