# js-toolkit — Assumptions

Two LLM tools for JS/TS: `tsc-check` (type-checks the project owning the file via `npx tsc --noEmit --project <root>`) and `node-check` (syntax-checks a JS file via `node --check`).

## OpenCode API (hooks used, v1 vs v2, version sensitivity)

- v1: `server(input, options)` factory returning a `tool` map (2 tools).
- v2: `id` + `setup(ctx)`; tools via `ctx.tool.transform` / `editor.add`, JSON Schema input (`filePath`, required), `{ content }` result.
- v1 and v2 execute paths are line-for-line equivalent. ⚠ v2 hook shape verified by author against opencode 2.0.29 only.

## Environment (env vars read, with defaults; binaries on PATH; OS/process assumptions)

- `node` and `npx` on PATH (present on this host). ⚠ `tsc` is resolved by `npx`: if the project's `node_modules` lacks `typescript`, npx may attempt an interactive install prompt or a network fetch — behavior varies by npx version and TTY presence.
- `npx tsc` runs with the project root as CWD (`.cwd(root)`), so local tsc/node resolution uses the project tree.
- Bun shell API pinned: `text()` synchronous stdout string; verified on bun 1.3.13. ⚠ Breaks on bun versions where `text()` returned an AsyncIterable.
- ⚠ No timeout on the child process: a hung tsc (e.g. network stall in npx) hangs the tool indefinitely.

## Filesystem & layout (paths read/written, where anchored — cwd / repo root / XDG; formats; encodings)

- `filePath` (string, required) resolved with `path.resolve` → ⚠ relative paths anchor at the **process CWD**, not the session `directory`/`worktree` exposed by the tool context (unused).
- Project root = nearest ancestor (walking up to the filesystem root, no depth limit) containing `tsconfig.json`. ⚠ `fs.existsSync` also matches a *directory* named `tsconfig.json`; a monorepo ancestor tsconfig can be picked up for an unrelated file.
- `node --check` infers module type from the extension (`.mjs`/`.cjs`) or the nearest `package.json` `type` field.
- No writes: both checks are read-only.

## External services (URLs/ports, protocol assumptions)

- None, except the potential npx registry fetch noted above.

## Configuration (what opencode.json must register for it to work; whether it actually is)

- ⚠ Registered nowhere: absent from `opencode.json` and `opencode.json.sample`. Tools are unavailable until `"./js-toolkit/opencode"` is added.
- No plugin options are read.

## Concurrency (locks, multi-instance behavior, atomicity)

- None. Each call spawns one independent process; no shared state. `node --check` may write nothing; tsc `--noEmit` writes no files.

## Data & LLM behavior (formats trusted from the model; model assumptions)

- ⚠ **Mixed diagnostic streams.** tsc writes its errors to **stdout** (so `tsc-check` failures do return text), but `node --check` writes errors to **stderr** — which the tool drops. A `node-check` failure returns an empty string even though the description promises errors (verified pattern for the stderr case).
- On success the hardcoded `Type-check succeeded: <path>` / `Syntax OK: <path>` strings are returned.
- `tsc-check` checks the whole project, not just the named file; the success message names the file regardless.
- File existence is not checked: a missing path surfaces as a compiler error (stdout for tsc, dropped stderr for node).
