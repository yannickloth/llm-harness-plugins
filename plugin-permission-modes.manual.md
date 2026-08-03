# Permission Modes — User Manual

## Install

Add to `opencode.json` plugin array after guardrail-chain:

```json
"plugin": [
  "./guardrail-chain/opencode/index.ts",
  "./permission-modes/opencode/index.ts"
]
```

On session start: `[permission-modes] plugin active — 6-mode state machine...`

## Modes at a glance

| Mode | Symbol | Tool prompts? | Read-allowed? | Edit/Bash-allowed? | Immune gate? |
|------|--------|-------------|--------------|-------------------|-------------|
| `default` | · | Yes (all) | Prompt | Prompt | Yes |
| `plan` | P | No | Auto | Blocked | Yes |
| `acceptEdits` | A | Partial | Prompt | CWD-only auto | Yes |
| `bypassPermissions` | ! | No | Auto | Auto | Yes |
| `dontAsk` | ⊘ | No | Blocked | Blocked | Yes |
| `auto` | ∞ | No (except stripped) | Auto | Denied (stripped) | Yes |

## Commands

### `permission-mode`

Switch modes.

```
/permission-mode mode=plan
/permission-mode mode=acceptEdits
/permission-mode mode=bypassPermissions
/permission-mode mode=dontAsk
/permission-mode mode=auto
/permission-mode mode=default
```

Returns: `{"mode":"plan","symbol":"P"}`

Invalid mode → `{"error":"unknown mode: ..."}`

### `permission-status`

Inspect current mode.

```
/permission-status
```

Returns: `{"mode":"acceptEdits","symbol":"A","blockedCategories":[],"allows":[],"denys":[],"bypassImmuneCount":14,"autoStripped":false}`

### `permission-state`

Export full state (all 6 mode configs + immune patterns).

```
/permission-state
```

Returns full JSON with all mode configs, allow/deny lists, blocked categories, bypass-immune patterns.

### `permission-check`

Dry-run: test if a tool would be allowed.

```
/permission-check tool=bash filePath="rm .env.local"
/permission-check tool=edit filePath=src/main.ts
```

Returns: `{"allowed":false,"reason":"BYPASS_IMMUNE: bash targeting immune path — always prompt","promptUser":true,"mode":"default","autoStripped":false}`

## Mode deep-dive

### `default` (·) — Start here

Every tool use prompts for approval. No tools auto-approved or denied.
Use: fresh project, untrusted session, first 20-30 turns.

### `plan` (P) — Read-only

Auto-allows: read, glob, grep, question, todo.
Blocks: edit, write, bash, webfetch, task, skill, other.
No prompts — blocking is silent.

Use: architecture review, code exploration, generating plans.

### `acceptEdits` (A) — Code with guardrails

Auto-approves: edit/write targeting paths in CWD (not `..`, not absolute-outside).
Prompts for: edit/write outside CWD, bash, webfetch, task, skill.

CWD check is based on relative path structure, not filesystem existence.

Use: active implementation when you trust the agent's edits but not arbitrary commands.

### `bypassPermissions` (!) — Trusted fast-follow

Auto-allows: every tool.
BYPASS_IMMUNE still gates: `.git/`, `.claude/`, `.ssh/`, `.env`, shell configs, `claude.md`, plugin/config JSON files always prompt for write tools.

Use: known-safe refactors, scripted batch edits you've already reviewed.

### `dontAsk` (⊘) — Full lockdown

Blocks: every tool (silent, no prompt).
BYPASS_IMMUNE exception: write to protected paths still shows a prompt (one chance to veto sabotage).

Use: exploring sensitive codebases, read-only sessions where any tool execution is unwanted.

### `auto` (∞) — Automation

Auto-allows: read, glob, grep, question, todo.
Denies (prompts): bash, write, edit, webfetch, task, skill — these are stripped on entry and prompt even in auto.
Auto-mode strip is persisted: if you restart mid-auto, the strip is re-applied.

Use: CI pipelines, scheduled maintenance, ant-level agent sessions.

## BYPASS_IMMUNE — the safety net

These paths always prompt for write tools (edit/write/bash/task), even in `bypassPermissions`:

```
.git/  .claude/  claude.md
.bashrc  .bash_profile  .zshrc  .profile
.ssh/  .env  .env.local
config.json  opencode.json
settings.json  plugin.json  hooks.json
```

Matching is case-insensitive and substring-based.
Read tools (read, glob, grep) never trigger immune checks — you can read `.git/config` anytime.

## Workflow patterns

### New project, first session
```
start → default (prompt everything, build trust)
```

### Feature implementation
```
plan       → explore architecture, read files
acceptEdits → implement, agent edits in CWD auto-approved
bypassPermissions → fast-follow on reviewed changes
default    → review final diff
```

### Security-sensitive codebase
```
dontAsk → start locked, nothing executes
plan    → allow read-only exploration
acceptEdits → cautiously allow edits (CWD-scoped, prompt for bash)
```

### CI pipeline
```
auto → programmatic set_permission_mode("auto")
  - read/glob/grep auto-allowed
  - dangerous tools prompt via hook
```

## State file

Mode and configs persist to `tmp/sessions/.permission-modes/state.json` in the project root.
Deleted with `tmp/sessions/` cleanup. No sensitive data stored — only mode names and tool policy.

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| Agent says "Permission denied" on every tool | In `dontAsk` mode | `/permission-mode mode=default` |
| Edit works inside CWD but prompts outside | `acceptEdits` CWD boundary | Switch to `bypassPermissions` if trusted |
| Still prompted in bypass mode | BYPASS_IMMUNE on protected path | Confirm removal is intentional; cannot override |
| "unknown mode" error | Typo in mode name | Check exact spelling: `default`, `plan`, `acceptEdits`, `bypassPermissions`, `dontAsk`, `auto` |
| Plugin not active | Load order or missing from config | Ensure `./permission-modes/opencode/index.ts` is in `plugin` array after guardrail-chain |
