# ivp — Assumptions

This plugin registers 5 skills
(`skills/{identify-change-drivers,apply-ivp,assess-ivp,sort-into-modules,review-ivp-to-convergence}/`),
6 IVP agents (`agents/*.md`), and 5 commands (`commands/*.md`, one per skill)
that apply the Independent Variation Principle to a target codebase.
`prompts/ivp-knowledge.md` holds the working restatement the agents read on
demand. Mark fragile assumptions with ⚠.

## OpenCode API

- The entrypoint (`opencode/index.ts`) exports a v2 plugin object
  `{ id: "ivp", setup(ctx) }` and serves the v1 plugin via `server(input)`.
- v1 path: appends the skill directory to `config.skills.paths`, registers
  agents on `config.agent` (`registerAgentRecordsV1`), and has no command
  registry hook — commands are a v2-only channel.
- v2 path: `ctx.skill.transform` (5 skills), `ctx.agent.transform` (6 agents,
  create-by-`update`), `ctx.command.transform` (5 commands, `add`).
- ⚠ The two v2 editors have **different** shapes: the agent editor creates by
  `update(id, fn)` and has no `add`; the command editor has `add` only and no
  `update`/`get`. Verified against the running server. Writing the command
  registry with `update` silently registers nothing (it fails inside a `try`
  and the transform reports success).
- ⚠ `GET /api/command` returns `{ name, description }` only. The `template`,
  `agent`, `model`, and `subtask` fields are stored by the registry but are not
  re-readable through the API, so a live check can confirm *presence* of a
  command but not its payload.
- ⚠ The npm `@opencode-ai/plugin` + `@opencode-ai/sdk` types (1.19.3) lag the
  running server (v2.2.5): the types describe `SkillV2Source`/`CommandV2Info`
  while the server implements the `Skill.Info`/`Command.Info` editors this
  entrypoint uses. Trust the live probe, not the installed d.ts, when they
  disagree.
- ⚠ `node_modules` can drift from the lockfile. `package.json` pins
  `@opencode-ai/plugin` 1.19.3; an install without a sync leaves 1.18.18 on
  disk with different types. Run `bun install` before reading those types.

## Environment

- All 6 agents pin `model: deepseek/deepseek-v4-pro` in frontmatter — an explicit
  `provider/model` reference. A bare alias (`sonnet`, `haiku`) resolves through
  the host's alias map instead, so a remap there would change the model without
  a diff here; the pack test requires the explicit form. `opencode debug agents`
  caches agent definitions — reload after editing frontmatter before trusting it.
- `gamma-modularizer` declares `bash: allow`, because its prompt requires it to
  verify the tree builds. The four read-only auditors keep `bash: deny`.
- The skills delegate to `logic-auditor` and `proof-soundness-auditor`
  (agents) and `review-convergence` (skill), all provided by the
  `general-skills` plugin. That plugin must stay loaded (it is, in this
  repo's `opencode.json`). The pack test asserts all three exist.
- `LLMHP_CANARY_DIR` and `LLMHP_CANARY_NONCE` are optional. The load canary
  is a no-op unless both are set (shared/load-canary.ts).

## Filesystem & layout

- ⚠ The pack is consumed **by reference**: sibling projects put
  `../llm-harness-plugins/ivp/opencode/index.ts` in their `plugin` array and
  `{file:../llm-harness-plugins/ivp/agents/<name>.md}` as agent prompts. The
  directory must keep its path and file names; `ivp/opencode/index.test.ts`
  scans sibling `opencode.json` files and fails on a dangling reference. The
  harness itself does not load the pack.
- The driver registry writes into the target codebase's native doc
  convention (Javadoc / docblock with `@ivpRegistry`), not into this plugin
  tree. The registry is the single authoritative driver list.
- Scope: when the scope argument is empty, the target repository root is the
  current working directory of the session.
- ⚠ `ivp-knowledge.md` references are bare (`ivp-knowledge.md` §N) in the agent
  and skill files. Subagents run with the target codebase as cwd, so the bare
  path does not resolve from there. The entrypoint fixes this at registration:
  every agent system prompt gets a preamble with the **absolute** path of
  `prompts/ivp-knowledge.md` and the canonical checkout, computed from the
  plugin's own location (`knowledgePreamble()` in `opencode/index.ts`). Skills
  and commands carry the same note in prose, and each carries its load-bearing
  rules inline (gates, proxy prohibitions, directive checks), so no step depends
  on resolving the file. Section titles are quoted beside the numbers to survive
  renumbering. A moved `prompts/` directory therefore breaks no reference — the
  preamble is computed, not written down.
- `review-ivp-to-convergence` writes its checkpoint to
  `tmp/review-ivp-checkpoint.md`, resolved against the target codebase cwd,
  not this plugin tree.
- The plugin reads only its own `agents/`, `skills/`, `commands/`, and
  `prompts/` directories. It writes nothing into its own tree.

## External services

- ⚠ Canonical references (`prc:ivp`, `thm:uniqueness`, `tab:ledger`,
  `def:change-driver`, `def:element-form`, `def:separation`) point into a
  sibling checkout `ivp-book-series/src/main/latex/ivp/ivp-graph-proof-2/`
  and `…/typst/shared/four-conditions/`. That checkout must exist at the
  documented relative position, or the references resolve to nothing.
- The six-step process restates
  `https://yannickloth.github.io/independentvariation/ivp-software/`.
  Divergence between site and `ivp-knowledge.md` is detected only by manual
  comparison.

## Configuration

- Agent permission blocks (`read/glob/grep/edit: allow`, `bash: deny`,
  `task: deny`) parse under OpenCode's own frontmatter parser, which maps
  `bash` → shell and `task` → subagent permissions.
- Command frontmatter (`description`, `agent`, `model`, `subtask`) is read by
  `shared/v2-commands.ts` and carried on the `add` record. `subtask: true` makes
  the invocation run in a child session with its own context budget.
- ⚠ A command's `agent:` must name an agent the host resolves. The pack pins
  `assess-ivp` to `current-modularization-auditor` (report-only) and
  `sort-into-modules` to `gamma-modularizer`; if a plugin agent is renamed, the
  command silently falls back to the session agent. `shared/v2-commands.test.ts`
  pins the mapping.
- ⚠ `build.sh` verifies agent registration for `scientific-writing` and `ivp`
  (name/filename match, and every agent file declared in `opencode.json`). Other
  plugins' agent dirs are still unchecked; a rename there breaks silently.

## Concurrency

- The plugin is stateless. The only persistent artifact is the driver
  registry inside the target repository.
- The gate loops (`review-ivp-to-convergence`) re-invoke auditors serially
  in one session and stop after two consecutive clean rounds.

## Data & LLM behavior

- Registry entries carry a confidence flag. `Γ` is PROVISIONAL until
  `driver-assignment-auditor` marks it AUDITED. Downstream steps must honor
  the flag.
- Step 2 assumes the S1–S2 discovery hypotheses (drivers are discovered from
  domain artifacts, not invented) and the §3 hypothesis ledger (`tab:ledger`)
  apply to the target system. The `Ω` exclusion limits the theory's scope.
- IVP-3 and IVP-4 constraints apply to modules, never to elements. Composite
  elements (IVP-2) are not violations.
