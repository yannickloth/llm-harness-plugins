# Permission Modes — Design Doc

## Architecture

```
                  ┌────────────────────┐
                  │  tool.execute.before│
                  │  PreToolUse hook    │
                  └─────────┬──────────┘
                            │
                  ┌─────────▼──────────┐
                  │  PermissionModes    │
                  │  .checkPermission() │
                  └─────────┬──────────┘
                            │
          ┌─────────────────┼─────────────────┐
          ▼                 ▼                  ▼
   BYPASS_IMMUNE?    Category blocked?    Mode default
    (.git/, .opencode/,  (plan: bash=N,     (prompt / allow / deny)
     .claude/, .ssh/,     read=Y)
     .env*, AGENTS.md,
     opencode.json, etc.)
```

6-mode state machine with centralized `transitionPermissionMode(mode)` entry point.
All callers (CLI shift-tab, SDK `set_permission_mode`, tool carousel) route through the
same transition, which triggers `stripDangerousPermissionsForAutoMode` on entry to AUTO
and restores on exit.

## File Structure

```
permission-modes/
├── src/main/java/eu/infolead/llmhp/permissionmodes/
│   ├── PermissionModes.java          # 6-mode state machine, checkPermission(), transitions, strip/restore, JSON serde
│   └── PermissionModesCli.java       # CLI entry: check, transition, status, state, save, load, immune
├── src/test/java/eu/infolead/llmhp/permissionmodes/
│   └── PermissionModesTest.java      # 24 test methods
├── opencode/
│   ├── index.ts                      # tool.execute.before hook + 4 tools
│   └── index.test.ts                 # 6 bun:test cases
```

## Data Types

### PermissionModes.Mode (enum)

| Mode | Symbol | Behavior |
|------|--------|----------|
| `DEFAULT` | · | Ask for each tool use |
| `PLAN` | P | Read-only + plan: blocks all write categories |
| `ACCEPT_EDITS` | A | Auto-accept edit/write in CWD; prompt at boundaries |
| `BYPASS_PERMISSIONS` | ! | Skip all tool prompts (BYPASS_IMMUNE still gates) |
| `DONT_ASK` | ⊘ | Silent block on all tools |
| `AUTO` | ∞ | Full auto (dangerous tools stripped on entry) |

### PermissionResult (record)

| Field | Type | Meaning |
|-------|------|---------|
| `allowed` | boolean | Tool permitted to execute |
| `reason` | String | Human-readable decision reason |
| `promptUser` | boolean | Whether to surface a prompt before execution |

### ModeConfig (record)

| Field | Type | Meaning |
|-------|------|---------|
| `categoryBlocked` | Map\<ToolCategory, Boolean\> | Categories blocked in this mode |
| `toolAllows` | Map\<String, ToolAllow\> | Per-tool auto-approve with note |
| `toolDenys` | Map\<String, ToolDeny\> | Per-tool deny with reason + immune flag |

## Tool Categories

| Category | Tools mapped |
|----------|-------------|
| `READ` | read |
| `EDIT` | edit |
| `BASH` | bash |
| `WRITE` | write |
| `WEB_FETCH` | webfetch |
| `TASK` | task |
| `SKILL` | skill |
| `GLOB` | glob |
| `GREP` | grep |
| `QUESTION` | question |
| `TODO` | todo |
| `OTHER` | unknown/unrecognized |

## checkPermission() Gate (5-layer stack)

```
1. BYPASS_IMMUNE — write-tool targeting immune path → prompt, always
2. Deny-list match → deny (if immune=true → prompt, else silent)
3. Category block → deny (silent)
4. Allow-list match → allow (no prompt)
5. Mode default → mode-specific fallthrough
```

### BYPASS_IMMUNE patterns

```
.git/  .opencode/  .claude/  claude.md  AGENTS.md
.bashrc  .bash_profile  .zshrc  .profile
.ssh/  .env/  .env.
opencode.json  config.json  settings.json  plugin.json  hooks.json
```

Write-tools only (`edit`, `write`, `bash`, `task`, `skill`, `webfetch`). Read-tools pass through.
Case-insensitive matching (normalized to lowercase before comparison).
Segment-anchored: `.git/` matches only `.git/` directory entries, not `.github/` or `.gitignore`.
`.env/` and `.env.` match env files/dirs without false-positive on `.environment`.
Configurable via `addBypassImmunePattern()` / `removeBypassImmunePattern()`.

### Mode-default fallthrough per mode

| Mode | Unmatched tool → |
|------|-----------------|
| `DEFAULT` | Prompt |
| `PLAN` | Auto-allow (writes already blocked at category level) |
| `ACCEPT_EDITS` | Prompt |
| `BYPASS_PERMISSIONS` | Auto-allow |
| `DONT_ASK` | Silent deny |
| `AUTO` | Auto-allow |

## Mode Transitions

### transitionPermissionMode(mode)

Single entry point. Always:

1. Sets `currentMode = target`
2. If entering AUTO: calls `stripDangerousPermissionsForAutoMode()`
3. If leaving AUTO: calls `restoreDangerousPermissionsFromAutoMode()`

### stripDangerousPermissionsForAutoMode()

On entry to AUTO:
- Stashes `bash`, `write`, `edit`, `webfetch`, `task`, `skill` allows/denys on a stack
- Replaces them with bypass-immune deny entries tagged "stripped for auto-mode safety"
- Non-dangerous tools (read, glob, grep) remain auto-allowed

### restoreDangerousPermissionsFromAutoMode()

On exit from AUTO:
- Pops the stash from the stack
- Removes all "stripped for auto-mode safety" denys
- Restores original allows/denys from stash

Stack-based design handles nested AUTO → other → AUTO transitions.

## JSON Persistence

State serialized to `{projectDir}/tmp/sessions/.permission-modes/state.json`.

Strip/restore state is persisted via the `autoStripped` flag AND the restore stash
(`"stash"` array). On `loadState()`, if `currentMode=AUTO`, the stripped denys are
re-derived and the stash reconstructed — preserving auto-mode safety AND the
"restore on exit" guarantee across the fresh-JVM-per-call plugin architecture
(exit AUTO in a later process correctly restores the dangerous-tool allows).

Read/write of state is guarded by an inter-process file lock on
`{projectDir}/tmp/sessions/.permission-modes/.lock` (with a retry loop + timeout),
so concurrent tool calls / JVMs cannot corrupt or clobber the state. Writes use
`ATOMIC_MOVE` + unique temp filenames.

```json
{
  "currentMode": "plan",
  "autoStripped": false,
  "configs": {
    "plan": {
      "blockedCategories": ["edit","write","bash","webfetch","task","skill","other"],
      "allows": {},
      "denys": {}
    },
    ...
  },
      "bypassImmune": [".git/", ".opencode/", ".claude/", ...]
}
```

Loaded on construction via `loadState()`. Saved after `transitionPermissionMode()`.

## CLI Interface

```
permission-modes check <projectDir> <toolName> [filePath]  → {"allowed":T/F,"reason":"...","promptUser":T/F,"mode":"default","autoStripped":T/F}
permission-modes transition <projectDir> <mode>             → {"mode":"plan","symbol":"P"}
permission-modes status <projectDir>                        → {"mode":"...","symbol":"...","blockedCategories":[...],"allows":[...],"denys":[...],"autoStripped":T/F}
permission-modes state <projectDir>                         → full JSON state dump
permission-modes save <projectDir>                          → persist to disk
permission-modes load <projectDir>                          → restore from disk
permission-modes immune <projectDir> <toolName> <filePath>  → {"immune":T/F}
```

## Platform Integration

### OpenCode (index.ts)

| Hook/tool | Type | Purpose |
|-----------|------|---------|
| `tool.execute.before` | hook | Check permission before every tool execution |
| `permission-mode` | tool | Transition to target mode |
| `permission-status` | tool | Current mode + active config summary |
| `permission-state` | tool | Full JSON state export |
| `permission-check` | tool | Check tool against current mode |

## IVP Analysis

| Element | Change driver | Artifact |
|---------|--------------|----------|
| Mode definitions | Permission model requirements | OpenCode permission model docs §5 |
| BYPASS_IMMUNE patterns | Protected path catalog | OS security standards, git/shell conventions |
| checkPermission() gate | Tool authorization logic | OpenCode tool permission hook contracts |
| stripDangerousPermissionsForAutoMode() | Automation safety requirements | OpenCode `auto` mode spec |
| ModeConfig | Per-mode policy shape | Plugin integration API |
| CLI + JSON serde | Persistence + programmatic access | Platform hook message formats |

Mode enum + transition logic share one driver (permission model). BYPASS_IMMUNE patterns change with OS conventions → separate config unit. Strip/restore logic changes when AUTO safety scope changes → sub-unit of auto mode handling.

## Cost

No API calls. All checks are set lookups + string matching. O(1) per `checkPermission()`, sub-microsecond. JSON persistence is WAL-safe but not atomic — acceptable for non-critical state (default mode on load failure = fresh start).

## Usage Flow (single-developer)

```
Session start  → DEFAULT (prompt for everything)
Explore code   → shift-tab to PLAN (read-only)
Implement      → shift-tab to ACCEPT_EDITS (auto-edit in CWD)
Fast-follow    → shift-tab to BYPASS_PERMISSIONS (skip prompts)
Sensitive area → shift-tab to DONT_ASK (silent block)
CI automation  → SDK set_permission_mode("auto") (full automation, stripped dangerous)
```
