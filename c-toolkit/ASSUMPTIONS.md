# c-toolkit — Assumptions

Two LLM tools for C: `c-check` (`gcc -std=c11 -fsyntax-only`) and `cpp-check` (`g++ -std=c++17 -fsyntax-only`). Both check a single file, emit no output files, and return diagnostics or `Compilation succeeded: <path>`.

## OpenCode API (hooks used, v1 vs v2, version sensitivity)

- v1: `server(input, options)` factory returning a `tool` map (2 tools).
- v2: `id` + `setup(ctx)`; tools via `ctx.tool.transform` / `editor.add`, JSON Schema input (`filePath`, required), `{ content }` result.
- v1 and v2 execute paths are line-for-line equivalent. ⚠ v2 hook shape verified by author against opencode 2.0.29 only.

## Environment (env vars read, with defaults; binaries on PATH; OS/process assumptions)

- `gcc` and `g++` on PATH (present on this host via nix gcc-wrapper 15.2). ⚠ No fallback: a missing compiler exits 1 with the message on stderr, which the tool drops — the model sees an empty string.
- Bun shell API pinned: `ShellOutput.text()` is a synchronous stdout string and array/template interpolation is shell-quoted. Verified on bun 1.3.13. ⚠ Older bun versions returned an AsyncIterable from `text()`; the code would break there.
- `.nothrow().quiet()`: non-zero exit does not throw; output is buffered, not echoed.
- ⚠ No timeout on the child process: a hung compiler hangs the tool indefinitely.

## Filesystem & layout (paths read/written, where anchored — cwd / repo root / XDG; formats; encodings)

- `filePath` (string, required) resolved with `path.resolve` → ⚠ relative paths anchor at the **process CWD**, not the session `directory`/`worktree` exposed by the tool context (unused). The model must send paths relative to where opencode runs.
- No temp files, no writes: `-fsyntax-only` produces no artifacts.
- Single-file check: includes must resolve without extra `-I` flags; project include paths are not discovered.

## External services (URLs/ports, protocol assumptions)

- None.

## Configuration (what opencode.json must register for it to work; whether it actually is)

- ⚠ Registered nowhere: absent from `opencode.json` and `opencode.json.sample`. Tools are unavailable until `"./c-toolkit/opencode"` is added.
- No plugin options are read.

## Concurrency (locks, multi-instance behavior, atomicity)

- None. Each call spawns one independent compiler process; no shared state.

## Data & LLM behavior (formats trusted from the model; model assumptions)

- ⚠ **Diagnostics come from the compiler's stderr, but the tool returns stdout only** (`result.text()` / `r.stdout`). On any compile failure the tool returns an empty string (verified with gcc: errors on stderr, stdout empty). On success the hardcoded `Compilation succeeded: <path>` string is returned.
- The model is told in the description that errors/warnings are returned; that promise holds only when the compiler happens to print to stdout.
- File existence is not checked: a missing path surfaces as a (dropped) compiler error.
