# natural-prose — Assumptions

Registers three subagents (`natural-prose-auditor`, `natural-prose-naturalizer`,
`natural-prose-perplexity-judge`), two skills (`/naturalize`, `/naturalize-judge`),
and one tool (`naturalize-analyzer-path`). The skills orchestrate a deterministic
Java analyzer (`ProsePatternAnalyzer.java` in sibling general-skills) plus
LLM audit / naturalisation / judging passes over prose, with domain modes
(`general`, `scientific`).

## OpenCode API (hooks used, v1 vs v2, version sensitivity)

- v1 (1.x, served by `server`): `config` hook (appends the skills dir to `config.skills.paths`, writes the agents inline into `config.agent` via `shared/agents.ts`), and a `tool` map.
- v2 (2.x, served by `id` + `setup(ctx)`): `ctx.skill.transform` (`registerSkillDir`), `ctx.agent.transform` (`registerAgentDirV2`), `ctx.tool.transform`.
- The running binary is 2.2.5 and calls only `setup`; the v1 `config`/`tool` paths are dead there.
- ⚠ v2 agent registration depends on `editor.update(id, …)` creating the agent when the id does not exist (shared/agents.ts design premise; the v2 editor has no `add`).
- ⚠ The v1 `config` hook writes `input.skills`, which the installed v1 `Config` type does not declare (installed npm types lag the 2.2.5 schema); on old 1.x clients the field may be silently dropped.
- ⚠ `shared/agents.ts` parses frontmatter with a hand-rolled subset parser, not a YAML library; unknown keys are kept as scalars, nested maps only under `permission:`.

## Environment (env vars, binaries, OS/process assumptions)

- No env vars are read.
- ⚠ `java` with single-file source launching (JDK 11+) must be on PATH when the skills/agents run the analyzer; the plugin never verifies this at load time — the tool only reports the path, and the agents must stop and report when it is missing.
- Bun runtime for plugin load.

## Filesystem & layout (paths, anchoring, formats, encodings)

- Reads `<plugin>/skills/<name>/SKILL.md` (frontmatter `name`/`description`) and `<plugin>/agents/*.md` (sorted by filename) at plugin load; UTF-8.
- Agent ids come from the frontmatter `name:` (all three match their filenames); bodies become the agent `system` prompt.
- All three agents set `model: deepseek/deepseek-v4-pro` — a full `provider/model` ref, which `shared/agents.ts` keeps (bare aliases such as `model: sonnet` would be silently dropped).
- ⚠ Analyzer path is hardcoded to the sibling plugin layout: `<repo>/general-skills/tools/ProsePatternAnalyzer.java`; if that tree moves, `naturalize-analyzer-path` returns `NOT FOUND: <path>` and the skills stop (handled, but the whole deterministic baseline is gone).
- `TypstIncludeResolver.java` is expected in the same `general-skills/tools` directory; the skill references it with a `<tools-path>` placeholder and no tool resolves that path.
- ⚠ Agent bodies reference `references/natural-prose.md`, `references/scientific-ai-prose.md`, `references/reader-guidance-phrases.md` as bare relative paths, but the files live at `<plugin>/references/`; nothing copies or symlinks them into a project, so a subagent must discover them (works by luck of the layout in this repo, fragile elsewhere).
- ⚠ Scientific mode assumes the target project provides `.agents/context/writing-style.md`, `.agents/context/terminology.md`, and (for `.typ`) `.agents/context/typst-syntax-rules.md`; the agents treat them as hard house-style input.
- `shared/module-dir` resolves the plugin dir from `import.meta.url` (robust in `opencode run` subprocess contexts where `import.meta.dir` is undefined).

## External services

- None. No network access.

## Configuration (registration)

- ⚠ NOT registered in the live `opencode.json` — only in `opencode.json.sample` (plugin line 20, plus the three agents as `{ file, mode: subagent }` entries). As deployed in this repo, the plugin's skills, agents, and tool are all inactive.
- The sample's `{ file }` agent entries and the v2 plugin's inline registration target the same ids; `registerAgentDirV2` skips ids already present (`editor.get`), so the config entries win.
- Skills self-register from `<plugin>/skills` (v1: `skills.paths`; v2: `ctx.skill.transform`); no manual skill registration is needed.
- `general-skills` is not required for the plugin to load, but is required for the skills to function (analyzer + resolver live there).

## Concurrency (locks, multi-instance, atomicity)

- Registration is read-only at setup; no runtime state, no locks, no writes.
- Setup can replay (transforms re-run); duplicate ids are skipped, so replays are idempotent.

## Data & LLM behavior (formats trusted from the model)

- Trusts `ProsePatternAnalyzer.java` output as the deterministic baseline (pattern findings + statistical layer: burstiness, structure diversity, entropy, unigram/bigram perplexity approximations) and treats its four named metrics as the reliable discriminators only.
- The perplexity judge is explicitly a subjective LLM rating, not measured perplexity; it is a cross-check and never an authorship verdict.
- ⚠ Meaning preservation of rewrites is enforced only by an LLM self-verify checklist in the naturalizer prompt — there is no deterministic gate; the only hard check after a rewrite is a Typst/Nix build (skill step 4, and only for `.typ`/`.tex` sources).
- Trusts the model to read `$ARGUMENTS` (`<scope> [domain]`), resolve the transitive include scope, strip markup before analysis, and emit the four required report sections (anthropomorphized abstractions, metaphor-bearing claims, general expressions, claim-versus-claimant framing).
- The auditor is `edit: deny` and the judge is `edit: deny`; only the naturalizer may edit files.
- Formal environments (`#definition`, `#theorem`, `#proof`, etc.) and all notation are out of scope for naturalisation in scientific mode.
