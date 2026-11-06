# rust-toolkit — Assumptions

One LLM tool, `rust-check`: if the file sits inside a Cargo project (nearest `Cargo.toml` walking up), runs `cargo check` at that root; otherwise falls back to standalone `rustc --edition 2021 --crate-type lib -o <tmp>/out.rlib`. Returns diagnostics or a success string.

## OpenCode API (hooks used, v1 vs v2, version sensitivity)

- v1: `server(input, options)` factory returning a `tool` map (1 tool).
- v2: `id` + `setup(ctx)`; tool via `ctx.tool.transform` / `editor.add`, JSON Schema input (`filePath`, required), `{ content }` result.
- v1 and v2 execute paths are line-for-line equivalent. ⚠ v2 hook shape verified by author against opencode 2.0.29 only.

## Environment (env vars read, with defaults; binaries on PATH; OS/process assumptions)

- `cargo`/`rustc` on PATH. ⚠ **Neither is present on this host** (verified). The standalone path exits 1 with `bun: command not found` on stderr, which the tool drops — the model sees an empty string for every invocation outside a Cargo project.
- `cargo check` may hit the network for the first build (crate registry, lockfile resolution) and uses the shared `target/` dir — long, uncapped. ⚠ No timeout on the child process in either path.
- Edition pinned to 2021 in the standalone path regardless of the file's real edition; `--crate-type lib` means a file with `fn main` still compiles (unused), and a file needing `#[start]`-style entry semantics is mis-checked.
- Temp dir from `os.tmpdir()` with `rust-check-` prefix, removed in `finally` (`rmSync recursive force`) — standalone path only.
- Bun shell API pinned: `text()` synchronous stdout string; verified on bun 1.3.13. ⚠ Breaks on bun versions where `text()` returned an AsyncIterable.

## Filesystem & layout (paths read/written, where anchored — cwd / repo root / XDG; formats; encodings)

- `filePath` (string, required) resolved with `path.resolve` → ⚠ relative paths anchor at the **process CWD**, not the session `directory`/`worktree` exposed by the tool context (unused).
- Project root = nearest ancestor (walking up to the filesystem root, no depth limit) containing `Cargo.toml`. ⚠ `fs.existsSync` also matches a *directory* named `Cargo.toml`; a monorepo workspace root can be picked up for an unrelated file.
- `cargo check` writes build artifacts to the project's `target/` dir (not the temp dir) — the "not the source tree" property holds only for the standalone path.
- `cargo check` checks the whole crate, not just the named file; the success message names the file regardless.

## External services (URLs/ports, protocol assumptions)

- Potentially the crates.io index/registry during first `cargo check` resolution.

## Configuration (what opencode.json must register for it to work; whether it actually is)

- ⚠ Registered nowhere: absent from `opencode.json` and `opencode.json.sample`. Tools are unavailable until `"./rust-toolkit/opencode"` is added.
- No plugin options are read.

## Concurrency (locks, multi-instance behavior, atomicity)

- None inside the plugin. ⚠ Two concurrent `rust-check` calls on the same project share `cargo`'s `target/` lock (cargo serializes them); two standalone calls use separate temp dirs.

## Data & LLM behavior (formats trusted from the model; model assumptions)

- ⚠ **Diagnostics come from cargo/rustc's stderr, but the tool returns stdout only** (`result.text()` / `r.stdout`). On any failure the tool returns an empty string (verified pattern with the other toolkits).
- Success strings diverge from the description: the Cargo path returns `Check succeeded: <path>` (matches), the standalone path returns `Compilation succeeded: <path>` (description says `Check succeeded`).
- File existence is not checked: a missing path surfaces as a (dropped) compiler error.
