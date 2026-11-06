# scientific-writing — Assumptions

This plugin registers 25 auditor agents (`agents/*.md`) and 1 skill
(`skills/review-adversarial-generic/`) that audit Typst and LaTeX documents.
The lines below state what the plugin requires of the host OpenCode
installation and runtime. Mark fragile assumptions with ⚠.

## OpenCode API

- The entrypoint (`opencode/index.ts`) exports a v2 plugin object
  `{ id: "scientific-writing", setup(ctx) }` and serves the v1 plugin via
  `server(input)`.
- v1 path: appends the skill directory to `config.skills.paths` and registers
  agent files on `config.agent` (shared/agents.ts, `registerAgentDirV1`).
- v2 path: replays skills into `ctx.skill.transform` and agents into
  `ctx.agent.transform` (v2 has no config hook).
- ⚠ The v2 agent transform is a no-op in this repo: all 25 agent ids are
  already declared under `agent` in the repo `opencode.json`, and
  shared/agents.ts skips ids already present in the editor. OpenCode's own
  frontmatter parsing of the `file:` entries is the effective agent
  registration.
- v1 preserves an existing `opencode.json` agent entry as a user override
  (pinned model, reasoning effort).

## Environment

- ⚠ 17 agents pin `model: deepseek/deepseek-v4-pro` and 8 pin
  `deepseek/deepseek-flash`. These references resolve only when the global
  config declares a `deepseek` provider and `DEEPSEEK_API_KEY` is present in
  the runtime environment (true here via `~/.config/opencode/opencode.env`).
- `LLMHP_CANARY_DIR` and `LLMHP_CANARY_NONCE` are optional. The load canary
  is a no-op unless both are set (shared/load-canary.ts).
- The `review-adversarial-generic` skill writes its report to
  `$XDG_RUNTIME_DIR`, falling back to `$TMPDIR` when the variable is unset.

## Filesystem & layout

- Agents live in `agents/*.md`. Each frontmatter `name:` must match the
  filename; `build.sh` enforces this for this plugin only.
- Every agent file needs an `agent.<name>.file` entry in the repo-root
  `opencode.json` (25 entries, all verified to exist).
- The skill is discovered via the plugin-registered skill directory; the
  directory must contain `SKILL.md`.
- ⚠ `skillCount()` in `opencode/index.ts:19` calls `fs.statSync()` on every
  directory entry. A broken symlink under `skills/` throws at plugin load in
  v1 mode (latent; no broken symlinks present).
- The plugin reads only its own `agents/` and `skills/` directories. The
  audited document is supplied by the user at runtime.

## External services

- None. The agents call no network endpoint and no external service.

## Configuration

- Frontmatter parses with a minimal line-based parser (shared/agents.ts),
  not a full YAML parser. Nested keys and multi-line values unsupported.
- No agent declares a `permission:` block. OpenCode defaults allow all
  tools. Auditors are read-only by prompt instruction only, not by harness
  enforcement.
- The shared test suite (plugin-entrypoint contract) runs under `bun`.

## Concurrency

- The plugin is stateless across sessions. The v1 config hook and v2 `setup`
  run once per server start.
- The load canary file writes on every load with no guard against
  concurrent loads.

## Data & LLM behavior

- Agents emit structured Markdown reports. Downstream skills parse them by
  heading convention, not by schema.
- ⚠ `scenario-validity-auditor` instructs the model to re-invoke itself with
  `model: deepseek/deepseek-v4-pro`. The OpenCode task tool takes no model
  parameter, so a subagent cannot perform this escalation itself.
- Cost and style routing across the 17 pro / 8 flash pins assumes the
  `deepseek` provider serves both models at comparable quality.
