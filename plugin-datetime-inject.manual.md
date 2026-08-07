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

On session start: `[datetime-inject] plugin active — injects datetime, platform, toolchain into every LLM prompt`

## What it injects

Three sections, joined by blank lines, regenerated fresh per request.

### datetime — always fresh

```
[current datetime: 07 Aug 2026, 13:20:05 UTC]
```

UTC, `toLocaleString("en-GB")`, `dateStyle:medium` + `timeStyle:medium` + 24h.

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
    "injectIntoSystem": true
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

> Visibility tradeoff: `chat.message` path shows the context in the user's message text. Set `injectIntoUserMessage = false` to keep it hidden via system-only injection (system path still fresh per session build).

## Hook behavior

| Hook | What it does | Dedup |
|------|--------------|-------|
| `chat.message` | Prepends full context block to first text part of each new user message | n/a (once per message) |
| `experimental.chat.system.transform` | Prepends context block to system prompt | Skips if any stable header (`[current datetime`/`[platform]`/`[toolchain]`) already present — prevents stacking on rebuilds |

Dedup uses stable headers, NOT the timestamp — so the changing datetime never causes duplicate accumulation.

## Testing

`bun test` against `datetime-inject/opencode/index.test.ts` (29 tests, ~60 assertions). Wired into `build.sh`.

| Coverage | What it verifies |
|----------|------------------|
| datetime | header prefix, UTC marker, round-trippable format |
| platform | header, System/CPU/Memory lines, package-manager mapping by distro ID |
| toolchain | flake/direnv/lock detection, locked-vs-unlocked, package extraction (buildInputs + nativeBuildInputs), omitted-when-absent |
| flag permutations | each flag toggles only its section; all-off → empty |
| dedup (`hasAnyMarker`) | detects injected system, returns false when clean, matches on changing timestamp (stacking fix) |
| hooks | chat.message prepends / skips empty / skips no-text, system.transform injects-once-then-dedups, respects `injectIntoSystem=false`, skips when marker present |

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| No context in prompts | Not registered in `plugin[]` | Add `./datetime-inject/opencode/index.ts`; restart OpenCode |
| Context visible in message text | `injectIntoUserMessage = true` (default) | Set `false` to keep system-only |
| System datetime seems stale in long session | System prompt injected once per build | Rely on `chat.message` path (fresh per user message) |
| Wrong package manager shown | Distro ID not in `packageManagerFor` mapping | Add ID → tool mapping in `datetime-inject/opencode/index.ts` |
| Wrong/no flake info | `flake.nix`/`.envrc` absent or different layout | Only supports `use flake`/`asdf`/`nix` direnv + `pkgs.*` buildInputs |
