# typst-toolkit — Assumptions

OpenCode plugin for Typst authoring: 8 skills, 8 subagents, one `typst-check`
compile tool, plus `content-structure-convention.md` as the single source of
truth for the structure/split agents.

## OpenCode API (hooks used, v1 vs v2, version sensitivity)
- v2: `id` + `setup(ctx)`; skills via `ctx.skill.transform` (shared/v2-skills), agents via `ctx.agent.transform` (shared/agents), tool via `ctx.tool.transform` with JSON Schema input and `{ content }` results.
- v1: `server()` serves a function-form factory; `config` hook (valid per `@opencode-ai/plugin` types) appends the skills dir and registers agents inline; `tool` map registers `typst-check`.
- ⚠ Bare model aliases in agent frontmatter (`model: sonnet`, `model: haiku` on 6 of 8 agents) are silently dropped by shared/agents.ts (only `provider/model` survives) — the intended model pin never applies.
- ⚠ `tools:` frontmatter lists are intentionally ignored by shared/agents.ts — "read-only" checkers rely on prose constraints plus the `permission:` map only.
- ⚠ An agent id already present in the host config (e.g. defined in opencode.json) is not overwritten by the plugin.
- ⚠ `typst-writer.md` pins `deepseek/deepseek-flash` — assumes that provider/model exists in the opencode config.

## Environment (env vars read, with defaults; binaries on PATH; OS/process assumptions)
- `typst` binary on PATH (typst 0.14.2 verified on this host).
- `TYPST_FONT_PATHS` read at call time (backed by typst's `--font-path`).
- ⚠ Gate: if `TYPST_FONT_PATHS` is unset and any `flake.nix` exists at or above the file's directory, the tool refuses to compile and prints a dev-shell hint — applies to every file under any nix tree (including this repo, which has `flake.nix` at root).
- ⚠ If no `flake.nix` is found and `TYPST_FONT_PATHS` is unset, compilation proceeds with no font paths — custom fonts silently fall back.
- Linux: compile output is written to `/dev/null`.
- ⚠ No timeout on `typst compile` (bun 1.3 shell exposes no timeout method); a runaway `.typ` program (infinite loop) hangs the tool indefinitely.
- ⚠ Missing `typst` binary: `.nothrow()` swallows the spawn failure, the "command not found" message goes to stderr, and the tool returns an empty string.

## Filesystem & layout (paths read/written, where anchored — cwd / repo root / XDG; formats; encodings)
- Skills `<plugin>/skills/<name>/SKILL.md` and agents `<plugin>/agents/*.md`, anchored to the module file via `moduleDir(import.meta.url)` — not cwd-dependent.
- ⚠ `typst-check` resolves `filePath` against the opencode process cwd — relative paths depend on where the server was started (same pattern as the language toolkits).
- `typst compile --root <file's dir>`: includes resolve relative to the importing file; `--root` only affects absolute-path resolution.
- ⚠ Agents run `cat typst-toolkit/content-structure-convention.md` — cwd-relative; resolves only when cwd is the llm-harness-plugins root (agents are told to "locate it relative to the llm-harness-plugins repository").
- Agent prose assumes a project layout: `src/main/typst/` source root, `lib.typ`, `references.bib`, `.agents/context/typst-syntax-rules.md` — none guaranteed.
- UTF-8 assumed for all .typ/.md I/O.

## External services (URLs/ports, protocol assumptions)
- None.

## Configuration (what opencode.json must register for it to work; whether it actually is)
- ⚠ NOT registered in root `opencode.json` — inert there; `opencode.json.sample` registers `./typst-toolkit/opencode`.
- Skills and agents self-register (v1 `config` hook / v2 transforms); no manual `skills.paths` or agent entries needed once the plugin is listed.

## Concurrency (locks, multi-instance behavior, atomicity)
- ⚠ No lock around compilation; concurrent `typst-check` calls on the same file run independent `typst compile` processes (output to `/dev/null`, so no artifact collision).

## Data & LLM behavior (formats trusted from the model; model assumptions)
- ⚠ `structure-auditor.md` (Checks A/B) and `content-splitter.md` (Step 1) hard-code grep lists covering only ~27 of the 43 environment types in `content-structure-convention.md` (missing e.g. `derivation`, `calculation`, `solution`, `proposition`, `correspondence`, `assumption`, `guideline`, `postdiction`, `protocol`, `requirement`, `consistency-check`, `practical-warning`, `counterexample`, `exercise`, `conclusion`, `plain-language`) — the auditor can report COMPLIANT while an aggregator holds a listed-type environment the convention forbids.
- ⚠ `split-chapter/SKILL.md` baseline `grep -c "^#"` is labeled "environment calls" but counts every `#`-prefixed line (imports, `#set`, `#show`).
- `typst-citation-checker.md` quotes the error `key "name" does not exist in the bibliography`; typst 0.14.2 actually reports `label "<key>" does not exist in the document` for unknown citation keys.
- Structure checks (grep/find/comm pipelines) are executed and interpreted by the model; outputs are not machine-validated.
