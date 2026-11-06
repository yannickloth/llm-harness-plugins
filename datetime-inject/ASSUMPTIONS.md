# datetime-inject — Assumptions

Injects context into sessions: platform + toolchain once per session (system prompt), a fresh datetime on every user message (from the second message the plugin sees, to keep session auto-titles clean). A regex topic gate (shared/session-topic) suppresses injection in personal sessions.

## OpenCode API (hooks used, v1 vs v2, version sensitivity)

- v1 hooks: `chat.message` (mutates `output.parts[].text` in place) and `experimental.chat.system.transform` (prepends to `output.system: string[]`). Shapes verified against `@opencode-ai/plugin` 1.18/1.19 d.ts.
- v2: `ctx.session.hook("prompt")` (mutates `event.prompt.text`) and `ctx.session.hook("context")` (unshifts `{type:"text",text}` onto `event.system`). ⚠ Shapes verified by author against opencode 2.0.29 only; not verifiable from this repo.
- Root anchor: v1 `input.worktree ?? input.directory` (both guaranteed by `PluginInput`); v2 `ctx.location.project.canonical ?? ctx.location.directory`. ⚠ If both v2 fields are missing, `root` is `undefined` and `path.join(root, ".envrc")` throws inside the context hook.
- Hook behavior is process-local: `seenSession` and the topic map are in-memory per plugin instance.

## Environment (env vars read, with defaults; binaries on PATH; OS/process assumptions)

- No env vars with defaults; no subprocesses; no network.
- `WAYLAND_DISPLAY` / `DISPLAY` env vars: decide the "Graphics platform" line (Wayland / X11 / omitted).
- Timezone from `Intl.DateTimeFormat().resolvedOptions().timeZone` — assumes a full-ICU runtime (true for Bun).
- Local offset is computed per instant, so DST transitions are correct at the printed moment; format is `YYYY-MM-DDThh:mm:ss±hh:mm (Zone)`.

## Filesystem & layout (paths read/written, where anchored — cwd / repo root / XDG; formats; encodings)

- Writes nothing. Reads (all best-effort, errors → empty string):
  - `/etc/os-release` or `/usr/lib/os-release` (Linux only). ⚠ On other OSes the platform line falls back to `os.platform() (os.type())` and no package-manager line appears.
  - `<root>/.envrc` (first line used as a direnv label fallback; `use flake` / `use asdf` / `use nix` detected by substring).
  - `<root>/flake.nix` (regex-extracts `pkgs.*` tokens from `buildInputs`/`nativeBuildInputs`/`packages` lists and the `description` string) and `<root>/flake.lock` (presence = "locked").
- `root` = session worktree/directory, not process CWD.
- Distro detection keys on the `ID=` field (substring match: arch/cachyos → pacman/paru, fedora → dnf, ubuntu/debian → apt, nixos → nix). ⚠ Unlisted distros get no package-manager line.

## External services (URLs/ports, protocol assumptions)

- None.

## Configuration (what opencode.json must register for it to work; whether it actually is)

- Registered in the active `opencode.json` as `"./datetime-inject/opencode"` ✓ (also in the sample).
- Options (all default on): `injectIntoUserMessage`, `injectIntoSystem`, `injectDatetimePerMessage`, `topicGate`, plus flags `datetime`/`platform`/`toolchain`. Current config passes none, so all defaults apply.
- ⚠ Config combination gap: topic classification happens only inside the message hook. With `injectIntoUserMessage: false` (system-only mode), no session is ever classified, the topic gate sees "unknown" forever, and the plugin injects nothing at all — silently.

## Concurrency (locks, multi-instance behavior, atomicity)

- No files, no timers, no child processes. No shared mutable state beyond in-memory maps.
- `seenSession` (Set) and the topic map (module-level) grow unbounded for the process lifetime (one entry per session id). Nit-level.
- Multiple plugin instances (e.g. main process + `opencode run` child each loading the plugin) keep separate maps; each classifies independently.

## Data & LLM behavior (formats trusted from the model; model assumptions)

- User message text is classified by regex (PROJECT_MARKERS / PERSONAL_MARKERS in shared/session-topic). "project" is sticky; "personal" is re-evaluated per message. ⚠ Single-letter markers `c` and `h` in the project regex can over-classify.
- Dedup markers `[current datetime`, `[platform]`, `[toolchain]` are searched in the system prompt; ⚠ user-authored text containing any marker suppresses injection for that session (no stacking, but also no injection).
- ⚠ Per-message datetime injection is not guarded by a marker: if the prompt hook re-fires for an already-mutated message, a second datetime line stacks. The system-prompt path is guarded; the message path is not.
- "First message skipped" means first message *seen by this process*. After a process restart mid-session, the next user message is also skipped (title hygiene intent applies only to the true first message).
- Only the first text part of a message receives the datetime; non-text messages are untouched.
