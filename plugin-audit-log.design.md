# Plugin — Session Audit Log (design doc)

**Purpose**: capture a full audit trail of what happens during a session —
tools invoked, exact arguments/commands, results, and permission decisions.
Configurable and enablable. Aims to answer: "who read/wrote what, ran what,
was denied what, with what outcome."

## Scope

| Concern | Captured? |
|---------|-----------|
| File read/write access | ✅ (existing `session-lifecycle` `read`/`write` TSV) |
| Tool invoked | ✅ command arguments + tool name |
| Exact command (bash) | ✅ full command string |
| Tool result (stdout/exit) | ✅ output + title + metadata |
| Permission decision | ✅ allow / deny / prompt + reason + active mode |
| Session identity | ✅ sessionID + callID + timestamp |

## Hook wiring

opencode exposes two hook points that make the full trail possible:

```
tool.execute.before → (tool, sessionID, callID, args)      → permission decision already available via permission-modes
                                                             → log: tool, sessionID, callID, TS, args
permission check    → { allowed:true|false|undefined, reason, promptUser, mode }
tool.execute.after  → (tool, sessionID, callID, output)    → log: title, output, metadata, TS
```

| Hook | Fires | Data available | Use |
|------|-------|----------------|-----|
| `tool.execute.before` | before every tool call | `{tool, sessionID, callID}` + `args` | record tool + exact args + timestamp; pair with permission decision |
| `permission-modes.check` return | gate | `{allowed, reason, promptUser, mode}` | record allow/deny/prompt + reason + mode |
| `tool.execute.after` | after every tool call | `{tool, sessionID, callID}` + `{title, output, metadata}` | record result (stdout, exit symbol, title) |

## Log format / location

Path: `<project-root>/.llmaudit/<session_id>/audit.jsonl` — one JSON
object per line (append-only, locked).

**Not in `tmp/`, not in `.opencode/`.** An audit log is a durable record, not
throwaway scratch, and it is not opencode configuration. `.llmaudit/` is a
project-specific, low-collision name. It does not share the `session-lifecycle`
`<session_id>.tsv` (which is session scratch archived on `session.idle`); it is
written directly to its own durable dir and pruned by its own retention.

| Tool class | Sample record |
|------------|---------------|
| read / edit / write | `{"ts": "ISO8601", "sessionID": "…", "callID": "…", "tool":"read", "access":"read", "path":"/abs/path", "args":{…}}` |
| bash | `{"ts":"…","sessionID":"…","callID":"…","tool":"bash","command":"git status","exit":"0","output":"…","title":"…"}` |
| permission decision | `{"ts":"…","sessionID":"…","callID":"…","decision":"deny","reason":"…","mode":"plan"}` |
| generic tool | `{"ts":"…","sessionID":"…","callID":"…","tool":"grep","args":{…},"output":"…","metadata":…}` |

## Configuration / enablement

| Key | Type | Default | Effect |
|-----|------|---------|--------|
| `audit.enabled` | bool | `false` (opt-in) | master switch; off = zero overhead |
| `audit.logDir` | string | `<project>/.llmaudit` | durable dir, project-specific, low-collision (never under `tmp/` or `.opencode/`) |
| `audit.captureTools` | array | `["*"]` | allow-list of tool names; `["*"]` = all |
| `audit.capturePermissions` | bool | `true` | log allow/deny/prompt decisions |
| `audit.captureResults` | bool | `true` | log tool `output`/`title` |
| `audit.captureArgs` | bool | `true` | log full `args` (incl. command strings) |
| `audit.retentionDays` | int | `30` | prune like session-lifecycle archive |
| `audit.redact` | array | `["*password*","*token*","*secret*","*apiKey*"]` | redact matching arg keys/values |

**No logging by default.** The plugin must be explicitly enabled — audit logging
is sensitive (full commands, results, permission decisions). Redaction defaults
strip secrets even when enabled.

## IVP drivers

| Driver | Anchor / change trigger |
|--------|--------------------------|
| `γ_audit-policy` | what to log, redact list, retention — configuration |
| `γ_tool-protocol` | tool name/args/result schema — changes when opencode hook contract changes |
| `γ_permission-model` | allow/deny/prompt decision shape — changes with permission-modes |
| `γ_log-storage` | audit.jsonl location, format, archival |

Storage/logic separated from capture: capture (hooks) driven by `γ_tool-protocol`
+ `γ_permission-model`; filtering/redaction/storage driven by `γ_audit-policy`.
Never mix policy into capture.

## Proposed plugin shape

Two options:

**Option A — extend `session-lifecycle` (recommended).**
Add `AuditLog` Java class + `record-tool` / `record-decision` subcommands to the
existing `SessionLifecycle` wrapper; add `tool.execute.before` + `tool.execute.after`
hooks to its `opencode/index.ts`. Reuses the wrapper/hook plumbing and retention
config, but writes to its own durable dir (`audit.logDir`) — audited records
never flow through the `tmp/sessions` archive.

**Option B — new `audit-log` plugin.**
Standalone plugin with its own `AuditLog.java` + `index.ts`. Cleaner separation of
the audit driver from lifecycle; duplicates archive/retention scaffolding.

## Non-goals

- ✗ Not an LLM prompt/message logger (no conversation content) — tool activity + permissions only
- ✗ Not a performance tracker — no timing/telemetry beyond the timestamp
- ✗ Does not log `file.edited` event separately — covered by read/write tools
- ✗ No network/side-channel exfiltration — local file only

## Security notes

- Audit log contains sensitive data (commands, file paths, maybe output). Guard location:
  add `.llmaudit/` to the project `.gitignore`. Never commit audit.

## Deliverables

- `AuditLog.java` (capture/filter/redact/append, Java ≥25)
- `index.ts` hooks (`tool.execute.before` + `tool.execute.after`)
- config block parsed from plugin options / opencode config
- build wiring; archiving via existing `session.idle`
