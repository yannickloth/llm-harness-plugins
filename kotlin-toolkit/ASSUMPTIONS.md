# kotlin-toolkit — Assumptions

One LLM tool, `kotlin-check`: compiles a single `.kt` file with `kotlinc -d <tmpdir>` (output lands in a fresh temp dir, never the source tree) and returns diagnostics or `Compilation succeeded: <path>`.

## OpenCode API (hooks used, v1 vs v2, version sensitivity)

- v1: `server(input, options)` factory returning a `tool` map (1 tool).
- v2: `id` + `setup(ctx)`; tool via `ctx.tool.transform` / `editor.add`, JSON Schema input (`filePath`, required), `{ content }` result.
- v1 and v2 execute paths are line-for-line equivalent. ⚠ v2 hook shape verified by author against opencode 2.0.29 only.

## Environment (env vars read, with defaults; binaries on PATH; OS/process assumptions)

- `kotlinc` on PATH. ⚠ **Not present on this host** (verified: `kotlinc: command not found`). Every call exits 1 with `bun: command not found` on stderr, which the tool drops — the model sees an empty string for every invocation.
- kotlinc is a JVM launcher: first call pays a JVM startup cost (seconds); ⚠ no timeout on the child process, so a stuck kotlinc hangs the tool indefinitely.
- Temp dir from `os.tmpdir()` with `kotlin-check-` prefix, removed in `finally` (`rmSync recursive force`).
- Bun shell API pinned: `text()` synchronous stdout string; verified on bun 1.3.13. ⚠ Breaks on bun versions where `text()` returned an AsyncIterable.

## Filesystem & layout (paths read/written, where anchored — cwd / repo root / XDG; formats; encodings)

- `filePath` (string, required) resolved with `path.resolve` → ⚠ relative paths anchor at the **process CWD**, not the session `directory`/`worktree` exposed by the tool context (unused).
- Writes only under the temp dir; the source tree is never touched.
- Single-file compile: no classpath, so references to other project sources fail by design (no project discovery).

## External services (URLs/ports, protocol assumptions)

- None.

## Configuration (what opencode.json must register for it to work; whether it actually is)

- ⚠ Registered nowhere: absent from `opencode.json` and `opencode.json.sample`. Tools are unavailable until `"./kotlin-toolkit/opencode"` is added.
- No plugin options are read.

## Concurrency (locks, multi-instance behavior, atomicity)

- None. Each call creates its own unique temp dir and independent kotlinc process; no shared state.

## Data & LLM behavior (formats trusted from the model; model assumptions)

- ⚠ **Diagnostics come from kotlinc's stderr, but the tool returns stdout only** (`result.text()` / `r.stdout`). On any compile failure the tool returns an empty string (verified pattern with the other toolkits). On success the hardcoded `Compilation succeeded: <path>` string is returned.
- The description promises "diagnostics" on failure; that promise holds only for output emitted on stdout.
- File existence is not checked: a missing path surfaces as a (dropped) compiler error.
