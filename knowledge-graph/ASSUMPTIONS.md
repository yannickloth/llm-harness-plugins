# knowledge-graph — Assumptions

The knowledge-graph plugin parses a project's `.typ` (Typst) files into a
dependency graph (`graph.json`) with Leiden-style community detection, then
serves that graph to OpenCode: it injects an agent prompt and project overview
at session start, injects per-file subgraph context on reads/edits, and
exposes a `kg-query` tool (plus a Java CLI for parse/query/impact/diagram/
doc-tree/overlay work). A Java backend does all graph work; the TypeScript
shim is thin.

## OpenCode API (hooks used, v1 vs v2, version sensitivity)

- Exports `{ id: "knowledge-graph", setup(ctx), server(input, options) }`; the V2 host (opencode v2.2.5) calls `setup`, legacy V1 hosts call `server`.
- ⚠ The v1 factory registers `"session.created"`, `"session.deleted"`, `"file.edited"` as top-level hooks, but the V1 `Hooks` interface (plugin 1.19.3) has no such keys — V1 delivers bus events through the `event` hook, so under a V1 host none of the auto-injection fires (only `kg-query` and skill registration work).
- ⚠ The v1 `tool.execute.after` handler reads `event.input` / `event.context.sessionID`, but the V1 signature is `(input: { tool, sessionID, callID, args }, output)` — the handler matches the V2 event shape, not V1's.
- V2 injection uses `ctx.session.synthetic({ sessionID, text })`; V1 uses `client.session.prompt({ noReply: true, parts })`.
- V2 events come from `ctx.event.subscribe`; session id is read from `properties.sessionID`, file from `properties.file` (SDK shapes verified).
- V2 skills register through `ctx.skill.transform` (per-`SKILL.md` records via shared `registerSkillDir`); V1 appends the skills dir to `config.skills.paths`. ⚠ Assumes the V1 host supports `skills.paths`.
- Project root = `ctx.location.project.canonical ?? ctx.location.directory` (V2) / `worktree ?? directory` (V1). ⚠ Assumes a non-empty project root; an empty `worktree` falls back to nothing useful.
- Tool schema parity: v1 args `{ query: string }` ↔ v2 JSON schema `{ query }` — one string, whitespace-split into CLI tokens. ⚠ A label with a space would split into two tokens.
- Hook errors are caught and logged; injection failures must not break the host session.
- Load canary writes only when `LLMHP_CANARY_DIR` + `LLMHP_CANARY_NONCE` are set (canary preflight); a no-op in normal use.

## Environment (env vars read, with defaults; binaries on PATH; OS/process assumptions)

- ⚠ `java` on PATH, runtime compatible with `--release 25` class files. Every CLI call spawns a fresh JVM; a missing or old JDK makes all Java calls fail silently (`nothrow()`), and the plugin degrades to a no-op with only stderr logs.
- `cat` on PATH (bun shell template) to read `prompts/agent-prompt.md` per session.
- No other env vars are read by this plugin (no API keys, no URLs, no ports).
- Linux path semantics assumed: `Path.toString()` uses `/`, `relativize` on relative roots. Windows separators are not handled in the `/.git/` filter or in `relPath` strings.
- CPU-bound parse runs single-threaded (one JVM thread for Leiden).

## Filesystem & layout (paths read/written, where anchored — cwd / repo root / XDG; formats; encodings)

- Plugin dir resolves from `import.meta.url` (`moduleDir`); `build/classes` must exist and be current. ⚠ `build/` is gitignored — a fresh clone loads the plugin but every Java call fails (missing classes) until `build.sh` runs locally.
- Graph store is fixed at `<project-root>/graph.json` (root from OpenCode, not process cwd).
- ⚠ `parse` walks the entire project root for `*.typ`, skipping only `/.git/`. Any stray `.typ` (build output, `node_modules`, hidden dirs, editor caches) is parsed into the graph.
- `.typ` files are read as UTF-8 (`Files.readString`); line numbers = count of `\n` before the match + 1.
- Node `file` properties are project-root-relative paths with `/` separators; `subgraph`/`diagram` resolve an absolute file arg by suffix match against those.
- ⚠ `parse`, `merge-annotations`, and `merge-overlay` write `graph.json` in place, non-atomically (no tmp+rename).
- Perspective doc-tree defaults to `<project>/.kg/perspectives/` (skills pass it; the CLI takes an explicit out-dir). `audit-tree` defaults project root to the parent dir of `graph.json`.
- Java tests use CWD-relative `build/test-tmp` and an optional `../../ivp-book-series/graph.json` (skipped when absent) — tests expect CWD = plugin dir.
- Config YAML is a hand-rolled subset parser: sections `label_rules`, `edge_rules`, `naming_conventions`, `structural_prefixes`; `edge_rules`/`structural_prefixes`/rule `defaults` are parsed but never used. ⚠ Inline values (`edge_rules: []`) are swallowed into the current rule's map; block scalars (`>-`, `|`) are dropped; an invalid regex crashes `parse` with an uncaught `PatternSyntaxException` (only `IOException` is caught).
- ⚠ The two YAML copies under `src/main/java/.../` are dead and diverged from `config/`; the ivp copy does not even parse (double-backslash regexes crash `parse` — the parser does not decode YAML double-quote escapes).

## External services (URLs/ports, protocol assumptions)

- None. No network access, no ports, no external protocols. All work is local file I/O plus local JVM subprocesses.

## Configuration (what opencode.json must register for it to work; whether it actually is)

- ⚠ Not registered in the active root `opencode.json`; registered in `opencode.json.sample` as `"./knowledge-graph/opencode"` (dormant by default).
- Registration is enough for load; graph features additionally need a project `graph.json` (built by `parse` with a project config, or `merge-overlay` with an LLM-authored `overlay.json`).
- Target projects need one of the shipped configs: `config/project-config-ivp.yaml` or `config/project-config-mecfs.yaml`. ⚠ The mecfs `label_raw` regex lacks `:` in its char class, so `#hyp:foo`-style labels collapse to bare-prefix nodes there.
- Skills `archi-scan` and `archi-diagram` self-register from `skills/` via the config hook (v1) or `ctx.skill.transform` (v2); `agent-prompt.md` names them.
- Cross-plugin: `graphrag` compiles against this plugin's classes (`eu.infolead.llmhp.graph.GraphQueryEngine`, `types.Graph`); `build.sh` orders knowledge-graph before graphrag. ⚠ Breaking these classes or the package layout breaks graphrag's build.

## Concurrency (locks, multi-instance behavior, atomicity)

- ⚠ No locking on `graph.json`: `parse`/`merge-annotations`/`merge-overlay` rewrite it in place while session-start and per-file injections read it in other processes — a torn read is possible (degrades to a skipped injection, but a torn write on crash corrupts the file).
- ⚠ One module-level `injectedSessionId` slot and one shared `injectedFiles` dedup set: with multiple concurrent sessions in the same project, edit/read injections target the last-created session and are deduplicated across sessions.
- Leiden runs with a fixed seed (42): deterministic partition for identical input order. ⚠ `findAllTypFiles` does not sort, so first-occurrence-wins node fields (file/line/type) and the iteration order feed nondeterminism across filesystems.
- Two concurrent `parse` processes: last writer wins, no atomic rename.
- `perspectives` element-dir assignment is per-run (in-memory `used` map) with ownership checked by exact dir name. ⚠ A rebuild that changes element degree order can reassign dirs and clobber author-edited `description.md` files ("reclaim" path).

## Data & LLM behavior (formats trusted from the model; model assumptions)

- `graph.json` is parsed by a hand-rolled JSON parser: trailing commas accepted; non-string scalars become raw-text strings; a malformed file throws an uncaught `RuntimeException` (stack trace, exit 1).
- `overlay.json` is LLM-authored and trusted: blank ids/endpoints/types are skipped with a warning; undeclared edge endpoints are auto-created (type = id prefix or `concept`, `auto-created: true`); `origin` provenance is stamped and preserved on merge.
- `kg-query` input is one string split on whitespace into CLI tokens; the verb grammar is `<verb> [label] [scope/depth]`.
- `rate` expects the task description as a single shell-quoted argument.
- `merge-annotations` reads frontmatter `label:`/`constraint:`/`concern:`/`todo:`/`note:`/`files:`/`contradicts:`/`generalizes:`/`consistent_with:` from agent-edited `description.md` files; values must be single-line. ⚠ The `files:` frontmatter is written by splitting the `files` node property on `,`, but the parser writes that property with `;; ` — multi-file nodes get a mangled anchor and false "missing file anchor" audit issues.
- Context injection is capped at 6000 chars per injection (`MAX_INJECT`) and 16k chars in the tier-1 builder; truncation appends a marker.
- Injection uses a synthetic user message with `noReply` — assumes the host appends it to model context without triggering a model turn. ⚠
- `agent-prompt.md` placeholders: `<plugin-dir>` is substituted with `String.replace`, which replaces only the first of the 5 occurrences — the other 4 CLI examples reach the agent as literal `<plugin-dir>`. ⚠
- The parser assumes Typst labels use the project's conventions (`#(label)`, `#label`, `<label>`, `@label`, `== headings`); any `#word` code line (e.g. `#include`) matches the `label_raw` rule and creates a phantom node, and the first such node becomes the attribution target for all references in that file. ⚠
- Heading rule `== ([\w\s-]+)`: `\s` spans newlines (multi-line capture) and the space check drops all multi-word headings — `heading:` nodes are effectively never created correctly. ⚠
