# ivp — Assumptions

This plugin registers 6 IVP agents (`agents/*.md`) and 5 skills
(`skills/{identify-change-drivers,apply-ivp,assess-ivp,sort-into-modules,review-ivp-to-convergence}/`)
that apply the Independent Variation Principle to a target codebase.
`prompts/ivp-knowledge.md` holds the working restatement the agents read on
demand. Mark fragile assumptions with ⚠.

## OpenCode API

- The entrypoint (`opencode/index.ts`) exports a v2 plugin object
  `{ id: "ivp", setup(ctx) }` and serves the v1 plugin via `server(input)`.
- v1 path: appends the skill directory to `config.skills.paths` and registers
  agent files on `config.agent` (shared/agents.ts, `registerAgentDirV1`).
- ⚠ The v2 agent transform is a no-op in this repo: all 6 agent ids are
  declared under `agent` in the repo `opencode.json` with
  `mode: subagent`, and shared/agents.ts skips ids already present.
  OpenCode's own frontmatter parsing of the `file:` entries is the effective
  agent registration.

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

- The driver registry writes into the target codebase's native doc
  convention (Javadoc / docblock with `@ivpDrivers`), not into this plugin
  tree. The registry is the single authoritative driver list.
- Scope: when the scope argument is empty, the target repository root is the
  current working directory of the session.
- ⚠ Every `ivp-knowledge.md` reference is relative (`ivp-knowledge.md` §N, or
  repo-root-relative `ivp/prompts/ivp-knowledge.md`). Subagents run with the
  target codebase as cwd, so the path does not resolve from there; the README
  states where the pack lives. Each skill carries its load-bearing rules inline
  (gates, proxy prohibitions, directive checks), so no step depends on resolving
  the file. Section titles are quoted beside the numbers to survive renumbering.
- `review-ivp-to-convergence` writes its checkpoint to
  `tmp/review-ivp-checkpoint.md`, resolved against the target codebase cwd,
  not this plugin tree.
- The plugin reads only its own `agents/`, `skills/`, and `prompts/`
  directories. It writes nothing into its own tree.

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
