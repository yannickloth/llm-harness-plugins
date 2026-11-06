# python-toolkit — Assumptions

One LLM tool, `python-check`: syntax-checks a single `.py` file with `python3 -m py_compile`, redirecting bytecode to a temp dir via `PYTHONPYCACHEPREFIX` so the source tree stays clean. Returns diagnostics or `Check succeeded: <path>`.

## OpenCode API (hooks used, v1 vs v2, version sensitivity)

- v1: `server(input, options)` factory returning a `tool` map (1 tool).
- v2: `id` + `setup(ctx)`; tool via `ctx.tool.transform` / `editor.add`, JSON Schema input (`filePath`, required), `{ content }` result.
- v1 and v2 execute paths are line-for-line equivalent. ⚠ v2 hook shape verified by author against opencode 2.0.29 only.

## Environment (env vars read, with defaults; binaries on PATH; OS/process assumptions)

- `python3` on PATH (present on this host: 3.12.13 via nix). ⚠ No fallback: a missing `python3` exits 1 with the message on stderr, which the tool drops — the model sees an empty string.
- `PYTHONPYCACHEPREFIX` (Python ≥ 3.8) verified: the checked file's `.pyc` lands under the temp prefix mirroring the absolute path; no `__pycache__` next to the source. Note the prefix also captures the interpreter's own stdlib bytecode during the run — wasteful but temp-dir-scoped and cleaned in `finally`.
- Temp dir from `os.tmpdir()` with `python-check-` prefix, removed in `finally` (`rmSync recursive force`).
- Bun shell API pinned: `text()` synchronous stdout string; verified on bun 1.3.13. ⚠ Breaks on bun versions where `text()` returned an AsyncIterable.
- ⚠ No timeout on the child process: a stuck interpreter hangs the tool indefinitely.

## Filesystem & layout (paths read/written, where anchored — cwd / repo root / XDG; formats; encodings)

- `filePath` (string, required) resolved with `path.resolve` → ⚠ relative paths anchor at the **process CWD**, not the session `directory`/`worktree` exposed by the tool context (unused).
- Writes only under the temp prefix (bytecode); the source tree is never touched.
- `py_compile` checks syntax only — no name resolution, no type checking; a module that imports missing packages still passes.

## External services (URLs/ports, protocol assumptions)

- None.

## Configuration (what opencode.json must register for it to work; whether it actually is)

- ⚠ Registered nowhere: absent from `opencode.json` and `opencode.json.sample`. Tools are unavailable until `"./python-toolkit/opencode"` is added.
- No plugin options are read.

## Concurrency (locks, multi-instance behavior, atomicity)

- None. Each call creates its own unique temp prefix and independent interpreter process; no shared state.

## Data & LLM behavior (formats trusted from the model; model assumptions)

- ⚠ **Diagnostics come from py_compile's stderr, but the tool returns stdout only** (`result.text()` / `r.stdout`). On a syntax error the tool returns an empty string (verified on this host: error text on stderr, stdout empty). On success the hardcoded `Check succeeded: <path>` string is returned.
- The description promises "diagnostics" on failure; that promise holds only for output emitted on stdout.
- File existence is not checked: a missing path surfaces as a (dropped) compiler error.
