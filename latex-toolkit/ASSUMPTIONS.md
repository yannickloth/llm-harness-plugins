# latex-toolkit — Assumptions

OpenCode plugin for LaTeX authoring: 8 skills, 8 subagents, one `latex-check`
tool that compiles with `latexmk -pdf` into a scratch temp dir.

## OpenCode API (hooks used, v1 vs v2, version sensitivity)
- v2: `id` + `setup(ctx)`; skills via `ctx.skill.transform` (shared/v2-skills), agents via `ctx.agent.transform` (shared/agents), tool via `ctx.tool.transform` with JSON Schema input and `{ content }` results.
- v1: `server()` serves a function-form factory; `config` hook (valid per `@opencode-ai/plugin` types) appends the skills dir and registers agents inline; `tool` map registers `latex-check`.
- ⚠ All 8 agents use bare model aliases (`model: haiku` ×7, `model: sonnet` ×1) — silently dropped by shared/agents.ts (only `provider/model` survives); the "sonnet tier is intentional" note in `latex-syntax-fixer.md` therefore has no effect.
- ⚠ `tools:` frontmatter lists are intentionally ignored by shared/agents.ts — "read-only" checkers rely on prose constraints plus the default tool set.
- ⚠ An agent id already present in the host config is not overwritten by the plugin.

## Environment (env vars read, with defaults; binaries on PATH; OS/process assumptions)
- `latexmk` plus a TeX Live distribution on PATH (latexmk 4.87 / TeX Live 2025 verified on this host).
- ⚠ `latexmk -pdf` forces the pdflatex engine — documents requiring lualatex/xelatex (fontspec-based, CJK) fail or miscompile under the check; there is no engine argument.
- ⚠ No timeout on `latexmk`; a runaway macro (`\loop` without exit) hangs the tool indefinitely (bun 1.3 shell exposes no timeout method).
- ⚠ Missing `latexmk` binary: `.nothrow()` swallows the spawn failure, the "command not found" message goes to stderr, and the tool returns an empty string.
- `os.tmpdir()` must be writable (scratch dir per call).
- ⚠ Failure output is `result.text()` (stdout) only: TeX error lines do reach stdout (verified) so diagnostics survive, but latexmk's final summary lines go to stderr and are dropped, and the full multi-hundred-line run log is returned unfiltered.

## Filesystem & layout (paths read/written, where anchored — cwd / repo root / XDG; formats; encodings)
- Skills `<plugin>/skills/<name>/SKILL.md` and agents `<plugin>/agents/*.md`, anchored to the module file via `moduleDir(import.meta.url)` — not cwd-dependent.
- ⚠ `latex-check` resolves `filePath` against the opencode process cwd — relative paths depend on where the server was started (same pattern as the language toolkits).
- `latexmk` runs with `cwd` = the file's directory, so relative inputs (`.bib`, images) resolve like a normal project build; `-outdir` is an absolute `mkdtemp` dir, removed in `finally` (success or failure).
- ⚠ On success the scratch dir (containing `.aux`/`.log`/`.pdf`) is deleted — a failing compile's log cannot be inspected afterwards.
- UTF-8 assumed for all .tex/.md I/O.

## External services (URLs/ports, protocol assumptions)
- None.

## Configuration (what opencode.json must register for it to work; whether it actually is)
- ⚠ NOT registered in root `opencode.json` — inert there; `opencode.json.sample` registers `./latex-toolkit/opencode`.
- Skills and agents self-register (v1 `config` hook / v2 transforms); no manual `skills.paths` or agent entries needed once the plugin is listed.
- ⚠ All 8 skills declare `compatibility: Requires latexmk (TeX Live)`, including six grep-only audits that never invoke latexmk (over-declared; the field is not parsed by shared/v2-skills anyway).

## Concurrency (locks, multi-instance behavior, atomicity)
- Each call gets its own `mkdtemp` dir, so concurrent `latex-check` calls do not collide; cleanup is in `finally`.
- ⚠ Two concurrent checks of the same file still run full independent pdflatex passes with no lock.

## Data & LLM behavior (formats trusted from the model; model assumptions)
- Agents assume a project build command exists and is discoverable (`latexmk`, `nix build`, or a project script) — the tool itself hard-codes `latexmk -pdf`.
- xref/production agents assume literal log strings ("undefined reference", "multiply-defined labels") — grep-based, no log-format validation.
- `latex-figure-caption-auditor` conventions (caption below figures, above tables) are hard-coded editorial rules, not LaTeX facts.
