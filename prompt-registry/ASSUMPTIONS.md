# prompt-registry — Assumptions

Version-control plugin prompts: five LLM tools (`prompt-commit`, `prompt-pull`, `prompt-list`, `prompt-diff`, `prompt-test`) wrap a Java CLI (`PromptRegistryCli`). Versions are JSON files in `<root>/.prompt-registry/registry/<name>/v<N>.json`; the active version per prompt lives in `<root>/.prompt-registry/.prompt-versions` (one `name:N` line each).

## OpenCode API (hooks used, v1 vs v2, version sensitivity)

- v1: legacy `server(input, options)` factory; returns a `tool` map (5 tools). Verified against `@opencode-ai/plugin` 1.18/1.19 d.ts.
- v2: `id` + `setup(ctx)`; tools via `ctx.tool.transform` / `editor.add` with JSON Schema input and `{ content }` result. ⚠ Shape verified by author against opencode 2.0.29 only; not verifiable from this repo.
- Root anchor: v1 uses `input.worktree ?? input.directory`; v2 uses `ctx.location.project.canonical ?? ctx.location.directory`. ⚠ If both v2 fields are missing, `path.join(undefined, ...)` throws at first tool call.
- Both paths always pass `--registry-dir` as an absolute path, so the Java process CWD is irrelevant to the registry location.

## Environment (env vars read, with defaults; binaries on PATH; OS/process assumptions)

- `java` on PATH. ⚠ Hard dependency; a missing JDK makes every tool fail.
- ⚠ JDK 25 (or later) required: the CLI `main` is a package-private **instance** method, which only runs because the JDK 25 launcher accepts it. Verified on OpenJDK 25.0.2; JDK ≤ 24 rejects it (`Main method must be defined ... as public: static void main(String[])`).
- POSIX file locking (`FileChannel.lock`, flock semantics): lock releases when the holding process dies. ⚠ Lock behavior differs on Windows and on some network filesystems.
- `System.getProperty("user.name")` supplies the default author.
- No env vars are read by the plugin or the CLI.

## Filesystem & layout (paths read/written, where anchored — cwd / repo root / XDG; formats; encodings)

- Registry anchored at the session root (worktree/directory), not at process CWD.
- `commit` reads `<from>/prompts/<name>.md` (or `./prompts/<name>.md` when `--from` is absent — CWD-relative ⚠); the plugin always sends `--from` only when the model supplies it.
- `pull` writes `<to>/prompts/<name>.md` (same CWD caveat).
- ⚠ The CLI-only `status` command compares against CWD-relative `prompts/` (no `--from` support), so its `uncommitted_changes` field is only meaningful when the CWD is the plugin root.
- Prompt names: validated on commit by `[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}` (blocks path traversal). `pull` does not re-validate the name, but a pull can only return versions that already exist in the registry, so a malicious name resolves to "no version found".
- All file I/O uses explicit UTF-8 (`Files.readString`/`writeString`).
- Version writes: temp file in `registry/.tmp` + fsync + atomic rename. Active-version writes: temp file in `.tmp` (parent dir) + fsync + atomic rename.
- ⚠ Orphan temp files survive a kill between write and move; `.tmp` dirs are never cleaned. `listNames` filters dot-directories, so this is cosmetic.
- Lock file: `<root>/.prompt-registry/.locks/.prompt-versions.lock`, deleted after each release. ⚠ Delete-after-release is a classic race: under tight interleaving two processes can hold distinct lock inodes (rare; 10-way parallel commit verified clean).
- Version numbers are positive integers in file names `v<N>.json` and in `.prompt-versions`.

## External services (URLs/ports, protocol assumptions)

- None.

## Configuration (what opencode.json must register for it to work; whether it actually is)

- Must appear in `opencode.json` as `"./prompt-registry/opencode"`.
- ⚠ Registered in `opencode.json.sample` only — **not** in the active `opencode.json`. The tools are unavailable in the current live config.
- Requires `build/classes` to exist: compiled by the repo `build.sh` (`javac --release 25`). ⚠ A fresh clone without a build gets a `Could not find or load main class` failure on stderr, which the TS layer discards (see BUG list).
- No plugin options are read; v1 `options` and v2 `ctx.options` are ignored.

## Concurrency (locks, multi-instance behavior, atomicity)

- One exclusive `flock` per commit and per active-version read/write (`.prompt-versions.lock`). Blocking, no timeout: a wedged holder blocks all other commits indefinitely.
- Commit sequence (all under the lock): read latest → write active version → write version file (atomic). ⚠ Crash between the two writes leaves `active` pointing at a missing version; `pull <name>` then reports "no version found" instead of falling back to latest.
- Reads (`list`, `getVersion`, `versions`) are lock-free and safe because version files appear atomically.
- Verified: 10 concurrent commits → v1..v10, no duplicates, active=10.

## Data & LLM behavior (formats trusted from the model; model assumptions)

- Tool arguments are trusted verbatim: `name`, `from`, `to`, `author` are passed straight to the CLI (only `name` is pattern-validated, on commit).
- Version numbers: v1 zod `number()` / v2 JSON `number` → `String()` → Java `Integer.parseInt`. ⚠ A fractional version (e.g. 2.5) produces an error on stderr, which the TS layer drops — the model sees an empty string.
- All CLI errors (missing prompt file, unknown command, missing classes dir, bad version) go to **stderr**; the TS tools return stdout only. ⚠ Every failure path returns an empty string to the model (see BUG list).
- `agent-prompt.md` (registry seed prompt) claims the registry is "Git-backed" and auto-pulls on SessionStart — neither is implemented (documentation drift).
