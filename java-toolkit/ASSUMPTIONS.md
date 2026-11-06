# java-toolkit — Assumptions

One LLM tool, `java-check`: compiles a single `.java` file with `javac -d <tmpdir>` (class files land in a fresh temp dir, never the source tree) and returns diagnostics or `Compilation succeeded: <path>`.

## OpenCode API (hooks used, v1 vs v2, version sensitivity)

- v1: `server(input, options)` factory returning a `tool` map (1 tool).
- v2: `id` + `setup(ctx)`; tool via `ctx.tool.transform` / `editor.add`, JSON Schema input (`filePath`, required), `{ content }` result.
- v1 and v2 execute paths are line-for-line equivalent. ⚠ v2 hook shape verified by author against opencode 2.0.29 only.

## Environment (env vars read, with defaults; binaries on PATH; OS/process assumptions)

- `javac` on PATH (present on this host: OpenJDK 25.0.2). ⚠ No fallback: a missing `javac` exits 1 with the message on stderr, which the tool drops — the model sees an empty string.
- javac uses the platform default source/target (here 25) and the platform default encoding. ⚠ No `-encoding UTF-8`: non-ASCII identifiers in a non-UTF-8 locale produce spurious warnings.
- Temp dir from `os.tmpdir()` with `java-check-` prefix, removed in `finally` (`rmSync recursive force`).
- Bun shell API pinned: `text()` synchronous stdout string; verified on bun 1.3.13. ⚠ Breaks on bun versions where `text()` returned an AsyncIterable.
- ⚠ No timeout on the child process: a hung javac hangs the tool indefinitely.

## Filesystem & layout (paths read/written, where anchored — cwd / repo root / XDG; formats; encodings)

- `filePath` (string, required) resolved with `path.resolve` → ⚠ relative paths anchor at the **process CWD**, not the session `directory`/`worktree` exposed by the tool context (unused).
- Writes only under the temp dir; the source tree is never touched.
- Single-file compile: symbols from other project sources are not on the classpath, so a file referencing sibling classes fails with "cannot find symbol" by design (no project discovery).

## External services (URLs/ports, protocol assumptions)

- None.

## Configuration (what opencode.json must register for it to work; whether it actually is)

- ⚠ Registered nowhere: absent from `opencode.json` and `opencode.json.sample`. Tools are unavailable until `"./java-toolkit/opencode"` is added.
- No plugin options are read.

## Concurrency (locks, multi-instance behavior, atomicity)

- None. Each call creates its own unique temp dir and independent javac process; no shared state.

## Data & LLM behavior (formats trusted from the model; model assumptions)

- ⚠ **Diagnostics come from javac's stderr, but the tool returns stdout only** (`result.text()` / `r.stdout`). On any compile failure the tool returns an empty string (same verified pattern as the other toolkits). On success the hardcoded `Compilation succeeded: <path>` string is returned.
- The description promises "diagnostics" on failure; that promise holds only for stderr-emitted output, which is dropped.
- File existence is not checked: a missing path surfaces as a (dropped) compiler error.
