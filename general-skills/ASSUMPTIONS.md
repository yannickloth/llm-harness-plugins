# general-skills — Assumptions

Provides the `calc` and `calc_probe` tools, injects the `[calc-discipline]` and `[STE-100 Simplified Technical English]` rules into every session's system prompt, and self-registers 16 skills and 12 audit agents. Also ships two standalone Java helpers (`tools/`).

## OpenCode API (hooks used, v1 vs v2, version sensitivity)
- Dual entrypoint: v2 default export `{ id, setup(ctx), server(input, options) }`; v1 path returns a plugin factory from `server()`. ⚠ `id` + `setup` must match the running binary (2.2.5); a hook rename fails load silently (the load canary is the only signal).
- v2 hooks: `ctx.skill.transform` (shared/v2-skills.ts), `ctx.agent.transform` (shared/agents.ts), `ctx.session.hook("context")`, `ctx.tool.transform`. ⚠ All four names and their shapes are version-sensitive; the context hook mutates `event.system` in place (`unshift`) and expects parts shaped `{ type: "text", text }`.
- v1 hooks: `config` (appends skills dir to `input.skills.paths`, inlines agents into `input.agent`) and `experimental.chat.system.transform` (string array). ⚠ The experimental hook name must exist in `@opencode-ai/plugin` v1.19.3; both rules are injected there with no lifecycle `event` hook involved.
- Tool schema v1 (zod) vs v2 (JSON Schema): same arg surface (`expr` required, `engine` enum `auto|qalc|numbat|bc|python|sympy|maxima`). ⚠ v1 validates `engine` via `z.enum`; v2 relies on host-side enum enforcement — an invalid `engine` string reaching `calcImpl` throws (`ENGINES[bad]` is `undefined`, then `.good` access crashes).
- Agent frontmatter: ⚠ 10 of 12 agents declare `model: sonnet` (bare alias); shared/agents.ts drops bare aliases by design, so these agents run on the default model. `proof-soundness-auditor` and `translation-auditor` use `deepseek/*` refs and survive.
- Skill frontmatter: only `name`/`description` are read (shared/v2-skills.ts `parseFrontmatter`); other keys (`compatibility:`, `argument-hint:`) are ignored.

## Environment (env vars read, with defaults; binaries on PATH; OS/process assumptions)
- Binaries probed by `--version` (6 parallel spawns, cached 10 min per process): `qalc`, `numbat`, `bc`, `python3`, `uv`, `maxima`. No engine → install proposal, never a number.
- ⚠ qalc flags verified on qalc 5.10.0: `-t` (result only), `-m` is **milliseconds**, `-s "decimal_comma 0"` forces dot decimals (host runs `LC_NUMERIC=fr_BE.UTF-8`, which would otherwise print commas). Older qalculate may differ.
- ⚠ Maxima behavior pinned to 5.47 (live-verified in comments): exits 0 on syntax errors (failure detected from output, not exit code), `printf(true, "~a", …)` one-line printing, `(%iN)`/`(%oN)` label shapes parsed by `cleanMaxima`.
- ⚠ Sympy engine = `uv run --with sympy python -c …`; first run downloads sympy (network). `uv` must be on PATH.
- ⚠ Numbat 1.23 accepts both `->` and `to` conversions; code comments state `->` only.
- ⚠ qalc reads unknown function names as unit products. On qalc 5.10 `simplify(…)` exits 1 (caught), but `std(…)` exits 0 with unit output — the tool then returns it as a **success**; only the injected rule text tells the model to distrust such output.
- OS family from `/etc/os-release` (`ID=`, fallback `ID_LIKE=`), darwin from `process.platform`. ⚠ `void` is mapped to the `arch` family, so proposals read `sudo pacman -S …` (Void uses xbps — the command fails). Unknown family → generic proposal.
- NixOS proposal assumes this repo's layout: `users/common-hm.nix` + `sudo nixos-rebuild switch --flake ./`.
- No env vars read by this plugin (canary env vars belong to shared/load-canary, preflight-only).

## Filesystem & layout (paths read/written, where anchored — cwd / repo root / XDG; formats; encodings)
- `skills/` and `agents/` anchored at the plugin directory via `moduleDir(import.meta.url)` — independent of cwd.
- Read: `skills/<name>/SKILL.md` (16 dirs), `agents/*.md` (12 files), `/etc/os-release` (per calc call). UTF-8 assumed.
- Write: none, except the load canary marker (only when `LLMHP_CANARY_DIR` and `LLMHP_CANARY_NONCE` are both set — i.e., under `shared/canary_preflight.sh`; no-op otherwise).
- ⚠ `skillCount` runs `fs.statSync` on every skills-dir entry without a guard; a broken symlink there throws during `setup` and kills plugin load.
- ⚠ `tools/ProsePatternAnalyzer*.class` (3 files) are locally compiled artifacts — `*.class` is gitignored, and **no build.sh step compiles general-skills** (root `build.sh` only runs its `bun test`). Runners of `java -cp tools ProsePatternAnalyzer` must compile first. `tools/TypstIncludeResolver.java` has no `.class` at all. Neither class is stale-by-tracking; freshness is unmanaged.
- ⚠ `agents/style-auditor.md` references `general-skills/references/ai-prose-patterns.md`, `general-skills/references/corpus-analysis-framework.md`, and `general-skills/tools/ProsePatternAnalyzer.java` as repo-root-relative paths; they resolve only when the agent runs inside this repo.
- `agents/translation-auditor.md` is referenced by no skill (orphan agent; still registered and @-mentionable).

## External services (URLs/ports, protocol assumptions)
- No HTTP client in the plugin. Child processes may touch the network: qalc currency-rate fetch (bounded by `-m 5000`), `uv` PyPI fetch for sympy (bounded only by the 20 s run timeout).

## Configuration (what opencode.json must register for it to work; whether it actually is)
- Root `opencode.json` registers `./general-skills/opencode` (plugin array, line 13) — ✓ actually is.
- No plugin config keys exist: the two system-prompt rules are injected into **every** session with no opt-out or per-project switch.
- No `opencode.json` `agent` entries are required: v1 inlines agents via the config hook; v2 creates them via `ctx.agent.transform` (existing ids are skipped, so hand-written entries win).

## Concurrency (locks, multi-instance behavior, atomicity)
- Module-level `probeCache` (TTL 10 min) is shared by all concurrent tool calls in one process; a rejecting probe clears the cache so the next call retries.
- ⚠ Timeout does not kill the child: `runEngine` resolves a synthetic `exit 124` result while the real child keeps running (verified: a `sleep 300` child survived its timeout and had to be reaped by hand). A hung maxima loop leaks an orphan for the server's lifetime.
- ⚠ A rejecting spawn is not handled in the timeout race: the result waits out the full budget and is misreported as `timeout after N ms` (verified with a 3000 ms budget).
- No locks; concurrent `calc` calls are independent. `safeSpawn` spawns per call (no pool, no reuse).

## Data & LLM behavior (formats trusted from the model; model assumptions)
- ⚠ The model is trusted to: write each expression in the target engine's syntax; not report numbers from `FAILED` runs; re-verify key numbers with a second independent method; interpret qalc unit-product output (rule text only — no mechanical enforcement).
- `calc_probe` output and `calc` output are plain text the model parses; the `engine=… expr=… command: …` source-line format is a contract the injected rule relies on.
- Agent prompts (12 auditor files) are trusted instructions; permissions are read-mostly (`edit: deny` except `style-naturalizer`; `bash: allow` only for `bibliography-auditor`, `math-verifier`, `xref-checker`).
- Maxima `maximaFailure` treats "printed result identical to the input" as failure (catches unknown functions like `foobar(2)`). ⚠ This also rejects legitimate exact/symbolic results maxima prints unchanged — verified live: `calc("1/3", engine="maxima")` and `calc("x^2", engine="maxima")` both return FAILED, while the use-calculator skill's own table documents `1/3` printing the exact `1/3` as the expected result.
