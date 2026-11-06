# graphics-toolkit — Assumptions

Registers six deterministic Java-backed tools (`svg-selfcheck`, `svg-geometry`,
`svg-motion`, `graphics-export`, `drawio-extract`, `mermaid-extract`) and two
Markdown skills (vendored `diagram-design`, owning `graphics-design-system`)
for OpenCode. The TypeScript entry spawns a short-lived JVM per tool call and
anchors every path to the plugin directory. The Python scripts under the
vendored skill are reference implementations for the agent to run directly.

## OpenCode API (hooks used, v1 vs v2, version sensitivity)
- Dual entrypoint: v2 object `{ id, setup(ctx) }` plus v1 `server(input)` factory; the shape is pinned by `shared/plugin-entrypoint.test.ts`.
- v2 hooks: `ctx.skill.transform` (one synchronous `editor.add` per `<dir>/SKILL.md`) and `ctx.tool.transform` (six tools with JSON-Schema `input`, `additionalProperties: false`).
- v1 hooks: `config` (appends `<plugin>/skills` to `config.skills.paths`) and a `tool` map built with the `tool()` helper.
- ⚠ `ctx` is untyped (`any`); the plugin targets the `@opencode-ai/plugin` 1.19.3 v2 surface and breaks silently if `skill.transform`/`tool.transform` change shape.
- Tool results are plain strings (`{ content: string }` in v2); no structured output, no error channel distinction between gate failure and crash.
- Load canary is written from both entrypoints; it is a no-op unless `LLMHP_CANARY_DIR` and `LLMHP_CANARY_NONCE` are set (canary preflight only).

## Environment (env vars, PATH binaries, OS)
- ⚠ `java` must be on PATH and be version ≥ 25 (classes compile with `--release 25`); the plugin does not probe or fall back — a missing binary surfaces as a spawn failure inside `runJava`.
- ⚠ The plugin loads under Bun (`import { $ } from "bun"`); shell-result handling depends on the Bun `ShellResult` shape (`stdout`/`stderr` are `readonly Buffer` properties, `text()` is the string accessor).
- `python3` is assumed for the vendored `scripts/self_check.py`, `drawio_extract.py`, `mermaid_extract.py` flows documented in the diagram-design skill.
- Playwright + chromium are assumed for the documented PNG export snippet; absence is expected to be handled by the agent (stop message in `export.md`), not by the plugin.
- ⚠ The onboarding flow assumes an `agent-browser` CLI (or plain fetch) exists in the agent environment.
- No OS assumption in the Java/TS code itself; the skill docs assume a POSIX shell for agent-run commands (one command uses Windows `2>NUL`).
- No environment variables are read by the Java CLIs.

## Filesystem & layout (paths, anchoring, formats, encodings)
- ⚠ All paths anchor at the entrypoint's `import.meta.url` (`moduleDir`): skills at `<plugin>/skills`, classes at `<plugin>/build/classes`. A loaded copy with a different layout, or a bundle without a `file:` URL, breaks both.
- Java classes must be pre-built by the repo `build.sh`; the plugin never compiles. A missing `build/classes` returns an explanatory string, not a failure.
- Tool input is a single model-supplied file path; there is no path sandboxing — the Java process reads anything the OS allows.
- All inputs are read as UTF-8 (`Files.readString(path, UTF_8)`); non-UTF-8 bytes surface as an error string.
- `graphics-export` writes `<basename>.svg` (or `--out`) next to the source with `Files.writeString` — non-atomic overwrite, parent directory must exist.
- `drawio-extract`: input ≤ 32 MiB, decoded XML ≤ 64 MiB; accepts raw XML and base64+deflate payloads; DTD/entity declarations are rejected (XXE guard); ⚠ it reads the model from `<diagram>` child elements or a `value` attribute — the standard compressed file stores the model as element text content.
- `mermaid-extract` has no input size limit (the Python reference caps at 4 MiB) and assumes identifier characters `[A-Za-z0-9_-]`.
- `self_check.py` locates the canonical controller at `<skill-dir>/assets/template-motion.html` relative to `__file__` — scripts/ and assets/ must stay co-located.
- Skill Markdown uses relative links (`references/`, `assets/`) resolved from the skill directory; client profiles live at `~/.diagram-design/profiles/<slug>.md` and the project marker at `<project-root>/.diagram-design` (both outside the plugin, by design).

## External services (URLs, protocol assumptions)
- ⚠ The single allowlisted remote resource is `https://fonts.googleapis.com/css2` (host exact, default port, no fragment) — enforced by `svg-selfcheck` for `<link rel=stylesheet>` and injected (XML-escaped) by `graphics-export` into exported SVGs.
- PNG rasterization is delegated to the agent's Playwright/chromium; the plugin computes `viewBox × scale` sizing only and never writes a PNG.
- Onboarding fetches user-supplied website URLs via agent-side tooling; the plugin code itself opens no network connections.
- No ports are bound; no other URLs or protocol assumptions exist in the executable code.

## Configuration (opencode.json)
- `opencode.json` must list `./graphics-toolkit/opencode` in `plugin`; the repo-root `opencode.json` does (4th entry), `opencode.json.sample` does not.
- ⚠ Registration is repo-local: a consuming project must add its own entry; without it the six tools and both skills silently absent (the canary is the only detector).
- Skills self-register from `<plugin>/skills`; no per-skill configuration keys exist.
- Design tokens live in `skills/diagram-design/references/style-guide.md` and are agent-editable; there is no config-file surface for them.

## Concurrency (locks, multi-instance, atomicity)
- No locks, daemons, or shared state: every tool call spawns a fresh JVM that exits after one file.
- ⚠ `graphics-export` overwrites its output without atomic rename; concurrent exports of the same source can interleave.
- Load canary files are nonce-scoped (`<nonce>.<pluginId>.testigo`); two probes sharing a nonce collide by design intent.
- Skill registration tolerates duplicates (the host ignores repeated ids); a failed `editor.add` for one skill never aborts the rest.

## Data & LLM behavior (trusted formats, model assumptions)
- ⚠ Tool arguments (`filePath`, optional `out`/`page`/`diagram`/`scale`) are trusted verbatim from the model; `scale` is parsed as a double, `page`/`diagram` as index-or-name.
- Extractors treat all draw.io/Mermaid source content (labels, links, directives, notes) as untrusted data and never execute or fetch it; digests are the only cross-boundary output.
- ⚠ The motion gate assumes the model copied the canonical controller verbatim, but the Java gate checks structure only (mode, counts, fallbacks) — it does not verify controller identity, while the Python `self_check.py` does a byte comparison.
- ⚠ The geometry gate enforces integer `rect` x/y/width/height as a proxy for the documented 4px grid; it does not check divisibility by 4, font sizes, or non-rect elements.
- The SVG gate assumes the model produced the accessible-SVG contract (`role="img"`, first-child `<title>`, prefixed ids, one optional script); it reports violations, never repairs them.
- Digest tables truncate at `--max-rows` (default 40) with a `… N more` marker; the skill flow assumes the model reads the digest, never the raw source.
