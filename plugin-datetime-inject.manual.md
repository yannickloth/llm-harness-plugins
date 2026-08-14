# datetime-inject — User Manual

## Purpose

Injects current datetime + condensed platform + repo toolchain context into every prompt sent to the LLM. Makes the model time-aware (caches know real dates) and platform-aware (correct package manager, shell). Per-request fresh datetime.

## Install

Add to `opencode.json` plugin array (this repo: already present, after tier-router):

```json
"plugin": [
  "./tier-router/opencode/index.ts",
  "./datetime-inject/opencode/index.ts"
]
```

Requires no build step — TypeScript shim only, no Java core. Position relative to other `chat.message` consumers is irrelevant (appends framing, does not rewrite).

On session start: `[datetime-inject] plugin active — datetime per message, platform/toolchain per session`

## What it injects

Three sections, joined by blank lines, regenerated fresh per request.

### datetime — always fresh, compact ISO 8601 with local timezone + offset

```
[current datetime: 2026-08-14T11:07:45+02:00 (Europe/Brussels)]
```

Local time in `YYYY-MM-DDTHH:mm:ss±HH:MM` ISO 8601, the IANA timezone name from `Intl.DateTimeFormat().resolvedOptions().timeZone`, and the numeric UTC offset — one compact token carrying local clock, zone, and offset.

### platform — condensed (not full hardware dump)

```
[platform]
System: CachyOS Linux
CPU: 24 cores (x64)
Memory: 128 GiB
Package manager: pacman / paru
Graphics platform: Wayland
```

Sources: `/etc/os-release`/`/usr/lib/os-release` (PRETTY_NAME + ID), Node `os` (arch/cores/totalmem), `WAYLAND_DISPLAY`/`DISPLAY` env. Package manager derived from distro ID (CachyOS/Arch→pacman/paru, Fedora→dnf, Ubuntu/Debian→apt, NixOS→nix).

Deliberately omits: GPU names, laptop model, per-core detail, RAM exact bytes — noise for coding behavior.

### toolchain — from `flake.nix` + `.envrc` + `flake.lock`

```
[toolchain]
direnv: flake-based (use flake)
nix flake: locked — Dev shell for llm-harness-plugins — graphrag plugin development/testing
flake packages: python312Packages.graphrag, pandoc
```

| Signal | Source | Meaning |
|--------|--------|---------|
| `direnv:` | `.envrc` | `use flake` / `use asdf` / `use nix` / first line |
| `nix flake:` | `flake.nix` + `flake.lock` presence | `locked` vs `unlocked (no flake.lock)`; appends `description` |
| `flake packages:` | `pkgs.*` tokens in buildInputs/nativeBuildInputs/packages | pinned toolchain (tells model Nix-managed, don't assume pip/apt) |

Absent files → section omitted. Auto-adapts per project (no flake → no toolchain lines).

## Configuration

Two ways to toggle sections/behavior. Defaults live in `datetime-inject/opencode/helpers.ts` (`DEFAULT_FLAGS`); the plugin shim reads them. To change defaults without code edits, pass options via the `plugin` entry:

```json
"plugin": [
  ["../llm-harness-plugins/datetime-inject/opencode/index.ts", {
    "flags": { "datetime": true, "platform": true, "toolchain": true },
    "injectIntoUserMessage": true,
    "injectIntoSystem": true,
    "injectDatetimePerMessage": true
  }]
]
```

Or edit module defaults:

| Const | Default | Effect |
|-------|---------|--------|
| `flags.datetime` | `true` | Toggle datetime section |
| `flags.platform` | `true` | Toggle platform section |
| `flags.toolchain` | `true` | Toggle toolchain section |
| `injectIntoUserMessage` | `true` | Prepend to each new user message (visible in transcript) |
| `injectIntoSystem` | `true` | Add to system prompt (invisible in transcript) |
| `injectDatetimePerMessage` | `true` | If `false`, **nothing** is sent per message — all context (datetime + platform + toolchain) lives once in the system prompt |

> Visibility tradeoff: `chat.message` path shows the context in the user's message text. Set `injectIntoUserMessage = false` or `injectDatetimePerMessage = false` to keep everything hidden inside the system prompt (nothing per-message).

## Hook behavior — cadence split

Two modes, selected by `injectDatetimePerMessage`:

| Mode | Per message (`chat.message`) | Per session (`system.transform`) |
|------|-------------------------------|----------------------------------|
| **Default** (`injectDatetimePerMessage: true`) | datetime only (fresh) | platform + toolchain (once) |
| **System-only** (`injectDatetimePerMessage: false`) | nothing | datetime + platform + toolchain (once) |

The **whole platform/toolchain block is never sent per prompt** — it lives in the system prompt once per session. Per-message traffic is at most the tiny datetime line, and zero in system-only mode.

- `chat.message` (default): prepends **datetime only** to each new user message's first text part — the only thing that changes between turns. In system-only mode it injects nothing.
- `experimental.chat.system.transform`: prepends the session block once. Skips if any stable header (`[platform]`/`[toolchain]`) already present — prevents stacking on rebuilds.

Datetime is at least present per session (system-only) and fresh per message (default). Dedup uses stable headers, NOT the timestamp — so the changing datetime never causes duplicate accumulation.

## Testing

`bun test` against `datetime-inject/opencode/index.test.ts` (38 tests, ~84 assertions). Wired into `build.sh`.

| Coverage | What it verifies |
|----------|------------------|
| datetime | header prefix, ISO offset, timezone name, round-trippable format |
| platform | header, System/CPU/Memory lines, package-manager mapping by distro ID |
| toolchain | flake/direnv/lock detection, locked-vs-unlocked, package extraction (buildInputs + nativeBuildInputs), omitted-when-absent |
| flag permutations | each flag toggles only its section; all-off → empty |
| cadence split | `buildStaticContext` = platform+toolchain (no datetime); `buildSessionContext` = all three; `buildPerMessageContext` = datetime-only; static omits platform when flagged off |
| dedup (`hasAnyMarker`) | detects injected system, returns false when clean, matches on changing timestamp (stacking fix) |
| hooks | chat.message prepends datetime-only / skips empty / skips no-text / never repeats static; system.transform injects platform+toolchain once then dedups, respects `injectIntoSystem=false`, skips when marker present; system-only mode (`injectDatetimePerMessage=false`) injects nothing per message and datetime into system |

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| No context in prompts | Not registered in `plugin[]` | Add `./datetime-inject/opencode/index.ts`; restart OpenCode |
| Context visible in message text | `injectIntoUserMessage = true` (default) | Set `false` to keep system-only (datetime then only in system — static/cadence still works) |
| Wrong package manager shown | Distro ID not in `packageManagerFor` mapping | Add ID → tool mapping in `datetime-inject/opencode/index.ts` |
| Wrong/no flake info | `flake.nix`/`.envrc` absent or different layout | Only supports `use flake`/`asdf`/`nix` direnv + `pkgs.*` buildInputs |
