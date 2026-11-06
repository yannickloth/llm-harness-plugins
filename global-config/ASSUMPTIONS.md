# global-config — Assumptions

Markdown-only shared ruleset (no code, no hooks): `AGENTS.md` (always-on global instructions) plus 8 lazy-load rule files under `rules/` and 2 model tier-mapping reference docs under `models/`. It shapes agent behavior wherever its `AGENTS.md` content is injected.

## OpenCode API (hooks used, v1 vs v2, version sensitivity)

- Not a plugin: no `opencode/` entrypoint, nothing to register. It acts through AGENTS.md injection (global `~/.config/opencode/AGENTS.md` or a project `AGENTS.md`), which OpenCode appends to the system prompt before any plugin runs.
- ⚠ The repo file `global-config/AGENTS.md` is a **source document**. The live user-global file `~/.config/opencode/AGENTS.md` currently carries only curated excerpts (zvec-grep, Nix Builds, Calculation Discipline) and points at this repo with absolute paths. Sync between the two is manual; drift is possible.

## Environment (env vars read, with defaults; binaries on PATH; OS/process assumptions)

- No env vars, no subprocesses, no network at runtime.
- Java ≥ 25 host assumed: the "Scripting Language" rule mandates Java scripts (single-file `java File.java`, compact source, JEP 458/511/512). Verified on OpenJDK 25.0.2.
- ⚠ The documented "single-file shebang" pattern (no `.java` extension + `#!/usr/bin/env java`) does **not** work on the host JDK: `java file` without `.java` treats the argument as a class name, and the launcher does not strip shebang lines (`#!` is a compile error). See BUG list.
- Calculator engines assumed available or installable: `qalc`, `numbat`, `bc`, `python3`, `sympy` (via `uv`), `maxima`, `gnuplot` — all present on this host (verified).
- Install paths reference an external home-config repo (`users/common-hm.nix`, nix) and `pacman` (Arch/CachyOS). ⚠ Neither repo is part of this repository.

## Filesystem & layout (paths read/written, where anchored — cwd / repo root / XDG; formats; encodings)

- Reads: the 8 lazy-load files under `global-config/rules/` on demand; paths in `AGENTS.md` are repo-root-relative (`` `rules/ivp.md` ``, etc.) — ⚠ resolvable only when the agent's CWD or workspace is this repo. Copied verbatim into another project, the relative paths break.
- `models/*.md` cross-references: `tier-router/skill-axis-mapping.json` (exists ✓), plus the external IVP book series (`ivp-book-series/src/main/latex/...`, `src/main/typst/shared/four-conditions/` — not in this repo).
- ⚠ The two model docs anchor "See also" paths on different bases: the DeepSeek doc uses file-relative `../../tier-router/...`; the Kimi doc uses repo-root-based `tier-router/...` and `global-config/rules/...`. Each file is right under one convention; the pair is not mutually consistent.
- Writes: none.

## External services (URLs/ports, protocol assumptions)

- None at runtime. The docs cite external URLs (Kimi/Moonshot, DeepSeek, Anthropic, HuggingFace, emergent.sh, evals.report) as research sources with fetch dates; ⚠ all quoted prices, benchmarks, model IDs, and tier gates are point-in-time facts (2026-08-12 / 2026-08-22) and go stale by design.

## Configuration (what opencode.json must register for it to work; whether it actually is)

- Nothing to register: absent from `opencode.json` and `opencode.json.sample` plugin arrays, as expected for an md-only ruleset.
- The `calc` / `calc_probe` tools that the Computed-Numbers rules rely on come from the `general-skills` plugin — registered in the active `opencode.json` ✓.
- The `use-calculator` skill referenced by the Calculation Discipline section exists ✓.
- ⚠ The `models/` docs are not referenced by any `AGENTS.md` lazy-load table; they are discoverable only by direct reference (e.g. from tier-router work).

## Concurrency (locks, multi-instance behavior, atomicity)

- None: static text, no state, no writers.

## Data & LLM behavior (formats trusted from the model; model assumptions)

- Assumes the model will lazy-load rule files on demand instead of preloading (explicit instruction in `AGENTS.md`).
- Tier-mapping docs are consumed by routing agents that use Anthropic tier names (`haiku`/`sonnet`/`opus`/`fable`) against DeepSeek or Kimi fleets.
- ⚠ Cross-file contradiction: Fable 5 and Opus 5 context is "200k consumer / 500k enterprise" in `models/deepseek-anthropic-tier-mapping.md` but "1M" in `models/kimi-for-coding-anthropic-tier-mapping.md` (both fetched 2026-08-22).
- ⚠ Cross-file tension: `AGENTS.md` forbids shell scripts ("Never shell scripts, Python"), while `rules/calculations.md` prescribes `bc -l` inside shell pipelines for in-script arithmetic.
- ⚠ `rules/operations.md` bans `/tmp` categorically ("No exception"); the current host environment instead pre-approves `/tmp/opencode` as the preferred scratch path. The rule is out of sync with the environment.
- Verified-true claims: `qalc -t` locale behavior (comma decimal on this host), `numbat` 4-significant-digit output, sympy ≥ 1.13 not defining symbols on `import *` (checked on sympy 1.14.0), JEP 458/511/512 single- and multi-file launch.
