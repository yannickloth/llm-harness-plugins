# agentfeed — Multi-Agent Coordination via Shared Ledger + Atom Feed

## What

Lets agents in the same project talk to each other. Each agent publishes events (messages, task claims, handoffs, status) to a shared append-only **JSONL ledger**; every prompt receives a **watermark digest** of only the *new* entries since the agent last looked (push at prompt boundary, no polling); and the stream is exposed as a human-readable **Atom feed** (per-agent + aggregate). Ledger is committed to git, so coordination state survives sessions and travels with the repo.

## Why

Today sub-agents hand off only via prompt-injection + `task_id` resume inside one conversation. There is no durable, cross-session, cross-agent coordination record and no human-visible view of "who did what when." Agentfeed provides the channel (ledger), the delivery (digest injection), and the visibility (Atom).

## How

```
   agents (opencode agents + subagents)
        │  coord_log() / coord_claim() / coord_ask() ...
        │  tool.execute.after → auto resource events (git, file)
        ▼
   JSONL ledger — committed, append-only, host-qualified ids
        │
        ├──▶ coord_* tools read/write (who_does_what, await, ask, answer)
        ├──▶ chat.message hook → watermark digest per (sessionID, agent)
        └──▶ AtomCli (Java ≥25, compiled) → per-agent + aggregate feeds
```

## Concurrency model

| Layer | Mechanism | Scope |
|-------|-----------|-------|
| Same host | `flock` on `agentfeed/.ledger.lock` around append + feed regen | exclusive |
| Cross host | **git merge + append-only merge driver** | union of appends, no conflicts |

The ledger is committed to git; each host appends to its own copy. Entries carry `host` + per-host `seq`, giving globally-unique `id = host:seq` — merges concatenate cleanly, never collide, and global order is derived (`ts, host, seq`), not stored. **Explicitly out of scope:** cross-host mutual exclusion. Two hosts can claim the same task; mitigated by lease TTLs + `coord_who_does_what()` negotiation.

A normal git 3-way merge would raise a conflict when two hosts append different lines to `agentfeed/ledger.jsonl`. To make "never collide" actually hold, the file is mapped (`.gitattributes`) to a custom **append-only merge driver** (`agentfeed/tools/AppendOnlyMergeDriver.java`, Java ≥25) that unions entries from base + ours + theirs and dedups by line (`id = host:seq`). Each host must register it once:

```
git config merge.agentfeed-ledger.driver 'java agentfeed/tools/AppendOnlyMergeDriver.java %O %A %B'
```

If the driver is not configured, git falls back to a textual merge (may conflict on concurrent appends).

## Architecture

```
agentfeed/
├── opencode/
│   ├── index.ts            # plugin entry: hooks + coord_* tools + lock wrapper
│   ├── index.test.ts
│   ├── ledger.ts           # append/read/watermark (pure, injectable fs)
│   ├── ledger.test.ts
│   ├── digest.ts           # watermark digest builder
│   ├── digest.test.ts
│   ├── activity.ts         # auto resource-event detection from tool calls
│   └── activity.test.ts
├── src/main/java/eu/infolead/llmhp/agentfeed/
│   ├── AtomFeed.java       # pure Atom serializer: parse/esc/render/generate (public API)
│   └── AtomCli.java        # CLI entry: --ledger <path> --out <dir>
├── src/test/java/eu/infolead/llmhp/agentfeed/
│   └── AtomFeedTest.java   # Java test harness (void main, run via build.sh)
├── skills/coordinate/
│   └── SKILL.md            # coordination protocol guide (self-registered skill)
├── tools/
│   └── AppendOnlyMergeDriver.java  # git merge driver for ledger.jsonl (Java ≥25)
├── feeds/                  # generated *.xml + digest.md — git-ignored
├── plugin-agentfeed.design.md
└── plugin-agentfeed.manual.md
```

(`.gitattributes` at repo root maps `agentfeed/ledger.jsonl` → `merge=agentfeed-ledger`.)

**Storage:**
- `agentfeed/ledger.jsonl` — committed (coordination record, git-diffable, hostname-keyed).
- `agentfeed/feeds/*.xml` — git-ignored (generated).
- `agentfeed/watermarks.json` — git-ignored (per-session read state).
- `agentfeed/.ledger.lock` — git-ignored (same-host lock).

## Data model

```json
{"id":"mbp-12:3","host":"mbp","seq":3,"ts":"2026-08-13T22:22:05Z","agent":"auditor","type":"claim","task":"check ch.3","status":"open","lease":"2026-08-13T22:52:05Z"}
{"id":"mbp-12:4","host":"mbp","seq":4,"ts":"2026-08-13T22:22:07Z","agent":"auditor","type":"msg","text":"handing ch.3 to writer"}
{"id":"desk-4:2","host":"desk","seq":2,"ts":"2026-08-13T22:23:01Z","agent":"writer","type":"claim","task":"draft ch.4","status":"open","lease":"2026-08-13T22:53:01Z"}
```

| Field | Meaning |
|-------|---------|
| `id` | `host:seq` — globally unique, merge-safe |
| `host` | Writer hostname (merge key) |
| `seq` | Per-host monotonic counter — only this host's own prior entries advance it |
| `ts` | UTC ISO-8601, sub-second |
| `agent` | Publishing agent |
| `type` | `msg`, `claim`, `release`, `status`, `handoff`, `heartbeat`, `resource`, `ask`, `answer` |
| `task`/`text` | Task id or free text |
| `status` | `open` / `in-progress` / `done` / `failed` |
| `lease` | Claim/hold TTL — stale claims reclaimable |
| `resource`/`file` | For `resource`: kind (`git`/`file`) + resource name (path/ref) |
| `ref` | For `resource` git: branch/ref the op targets (best-effort) |
| `action` | For `resource`: `acquire` (start using) / `release` (free) |

**Types:** `msg` broadcast · `claim` ownership with lease · `release` explicit · `status` progress · `handoff` (carries target agent + task_id hint) · `heartbeat` liveness (off by default) · `resource` shared-resource lifecycle (`acquire`/`release`, auto-acquire + explicit release) · `ask`/`answer` question and reply.

**Digest filtering:** low-signal auto "touched X" events (resource entries with no lease and no release) are **excluded** from the rendered digest so coordination content is not drowned out. They remain in the ledger for audit and hold tracking. Only holds, releases, claims, status, handoffs, heartbeats, asks/answers, and messages render.

## Watermark / injection

- **Watermark** = last-rendered global position `(ts, host, seq)` per `(sessionID, agent)`, in `watermarks.json`. New = entries sorting after it.
- **`chat.message` hook** keeps the chat window lean: it writes the full digest to `agentfeed/feeds/digest.md` (git-ignored) and prepends only a one-line pointer to the text part when new entries exist (mirrors the lazy-loaded AGENTS.md rule pattern — the model reads the file on demand):

```
## Coordination digest
3 new entries — details in `agentfeed/feeds/digest.md`.
```

- **No-op → no injection** (skip when nothing new; save tokens). First user message skipped (session-title hygiene, mirrors datetime-inject).
- **`experimental.chat.system.transform`** injects a static once-per-session note: ledger exists, use `coord_*` — including a condensed use-case summary pointing to the `coordinate` skill.
- **`config` hook** self-registers the `coordinate` skill (`agentfeed/skills/coordinate/SKILL.md`) so agents can load the full coordination protocol on demand (mirrors general-skills).

## Tools

| Tool | Purpose |
|------|---------|
| `coord_log(type, text)` | Append `msg`/`status`; triggers feed regen |
| `coord_claim(task, lease?)` | Claim with TTL (default 30 min); returns `id` |
| `coord_release(task\|id)` | Release a claim |
| `coord_resource(resource, name, action)` | Acquire/release a shared resource so others know when it is free |
| `coord_handoff(task, to)` | Close your claim, open one for the target agent |
| `coord_status(task, state)` | Report a task's `done`/`failed`/`in-progress` (board) |
| `coord_heartbeat(task\|resource, kind?)` | Renew a claim/hold lease on long-running work |
| `coord_who_does_what()` | Current open claims + held resources (expired/released excluded) |
| `coord_await(position, timeout?)` | Wait until ledger passes position (`host:seq` or `ts\|host\|seq`) |
| `coord_ask(question, to?)` | Broadcast a question; others see it in their digest |
| `coord_answer(answer, questionId\|question)` | Answer a question from `coord_ask` |

## Auto resource events

Shared-resource activity is recorded **automatically** (no explicit tool call) so agents surface where they work and resolve conflicts. The `tool.execute.after` hook inspects tool calls; `activity.ts` detects:

| Detection | Tool call → resource entry |
|-----------|---------------------------|
| git ops (commit, merge, checkout, push, pull, rebase, branch, stash, reset, revert, switch, restore) | `bash` whose command matches → `resource` kind `git`, `task` = `git <op>`, `ref` = target branch (best-effort) |
| file edit/write | `edit`/`write` → `resource` kind `file`, `file` = path |

- **Lifecycle:** auto-detected ops are **informational "touched X" events** — they are `action: "acquire"` but carry **no lease**, so they do not appear as holds in `coord_who_does_what()`. To signal that a resource is held and later freed, agents call `coord_resource(action: "acquire"/"release")`; explicit acquires carry a lease (`resourceLeaseMs`, 30 min) and are reclaimable after expiry. `coord_who_does_what()` lists only lease-held resources so others know when they free.
- **Coalescing:** same agent editing the same file (or running the same git op+ref) is written at most once per `resourceCoalesceMs` (default 30s) to avoid flooding; distinct ops (commit vs push) or branches are not coalesced.
- **Agent attribution:** resolved via a `sessionID → agent` map populated from `chat.message` (which carries `agent`).
- **Config:** `autoGit` (default true), `autoFile` (default true) disable per-kind capture; `resourceCoalesceMs` tunes the window; `resourceLeaseMs` sets the default hold TTL for explicit acquires.
- **Not auto-captured:** general "what I'm working on" and Q&A — those need the model to call `coord_*` (no reliable trigger to infer intent).

## Conflict detection

`buildDigest` scans entries in position order and tracks **lease-held** resources. It flags an `⚠ possible conflict: agents a, b hold <kind> `<name>` concurrently — coordinate before proceeding.` alert when one agent acquires a resource another still holds (release between them clears it). Auto "touched X" events (no lease) do not raise conflicts. Pure digest-side analysis — no new tools — catching the exact collision class the ledger exists to prevent.

## Feed generation

- **Serializer:** `AtomFeed.java` + `AtomCli.java` (Java ≥25, compiled to `build/classes` via `build.sh`) — the only Atom XML implementation; invoked by the plugin as `java --class-path build/classes <mainClass>` and manually.
- **Live-on-write:** after each mutating `coord_*` write, plugin invokes the compiled `AtomCli` to regenerate feeds. Cost ≈ ledger read + XML write; if profiling shows tool latency regressions, demote to batched (`build.sh` or cron) — default stays live.
- **Output:** `feeds/feed-<agent>.xml` per agent + `feeds/feed.xml` aggregate (planet-style, newest first).
- **Entry mapping:** ledger events → `<entry>`; `id` = `urn:agentfeed:<project>:<host>:<seq>`; `updated` = `ts`; `author` = `agent`; title/content derived from event type.
- **XML safety:** `AtomFeed.esc` escapes `&<>"'`, strips XML 1.0-invalid control chars (from LLM-authored text), and collapses whitespace in titles — feeds always well-formed even with hostile/garbled input.

## Hook wiring

| Hook | Behavior |
|------|----------|
| `chat.message` | Write digest to `feeds/digest.md`; prepend one-line pointer; advance watermark; record session→agent |
| `experimental.chat.system.transform` | Static coord note + condensed use-case summary, once/session |
| `config` | Self-register the `coordinate` skill |
| `tool.execute.after` | Auto-record resource events (git/file), coalesced |
| `tool` | `coord_*` via `@opencode-ai/plugin` `tool()` |
| post-`coord_*` | Regen feeds (live) |

## IVP drivers

**Element → driver (anchored in this design doc):**

| Element | Change driver | Anchor |
|---------|---------------|--------|
| `ledger.ts` | Ledger storage format (schema, atomicity, watermark) | §Data model |
| `digest.ts` | Digest/prompt-injection format | §Watermark/injection |
| `activity.ts` | Resource-event detection rules (what tool calls count) | §Auto resource events |
| `AtomFeed.java` | Atom XML output format (escaping, entry structure, per-agent/aggregate layout) | §Feed generation |
| `AtomCli.java` | CLI invocation contract (`--ledger`/`--out`, stdout) | plugin `index.ts` + `build.sh` |
| `index.ts` | Hook/tool wiring + opencode plugin contract | plugin SDK hooks |

**Driver-set relationships:**

- `ledger` vs `digest`: **differ** → separate files.
- `activity` vs `digest` vs `index.ts`: `activity` is pure detection (what tool calls count), `digest` is rendering (what the prompt shows), `index.ts` is orchestration (when hooks fire) — **differ** → separate. `index.ts` calls `activity.detectActivity` + `publish`; `activity` stays free of fs/plugin concerns.
- `AtomFeed` vs `AtomCli`: **differ** (Atom output format vs CLI contract) → separate files. `AtomCli.agentCount`/`arg` are driven solely by the CLI stdout/args contract — correctly in `AtomCli`, not `AtomFeed`.
- `AtomFeed`+`AtomCli` vs `index.ts`: **differ** (serialization vs orchestration) → separate, bridge is a subprocess.
- `index.ts` orchestration vs all logic: **differ** → separate.

**Sub-unit split inside `AtomFeed` (partial-overlap):** the JSON *syntax* parser (`readStr`/field scanner) has driver {flat-JSON syntax handling}, which differs from the render methods' driver {Atom output format}; the field-name mapping in `parse` shares {ledger↔feed coherence} with rendering. Per granularity criterion, the differing syntax driver is contained → a **sub-unit (section) boundary inside the class suffices**; no separate file (the parser is ~60 lines, single consumer, and a real JSON lib would be a drop-in for that section only). Readability-prescribed sub-split, not a file separation.

**Labels:** all file separations above are **IVP-prescribed**; the JSON-parser sub-split inside `AtomFeed` is readability-prescribed (sub-unit within a shared-driver group).

## Constraints

- Java ≥25 for the Atom serializer (`AtomFeed.java`/`AtomCli.java`, AGENTS.md scripting rule), compiled by `build.sh` to `build/classes`. Plugin shim is TS (datetime-inject pattern); feed regen invokes the compiled CLI (permission-modes pattern).
- Hooks never crash the agent — try/catch + `createLogger(client, "agentfeed")`.
- Same-host writes under `flock`; cross-host concurrency = git merge via the append-only merge driver (union of appends, no conflicts, no mutual exclusion).
- No network; local fs only.
- Fallback: disable feed generation, JSONL + injection remain.

## Test plan

- **TS (`bun test`):** ledger append/watermark/host-qualified ids (in-memory fs), digest new-since-position, activity detection (git/file/non-resource), auto-write + coalescing + autoGit=false, Q&A tools, hook wiring (inject / no-op / first-message skip / empty-text untouched), lock wrapper.
- **Java:** `AtomFeedTest.java` (src/test/java) via `build.sh` — parsing (incl. escapes/unicode/malformed lines), escaping/control-char stripping, title/body rendering, global ordering, feed generation, atomic no-temp-leftovers. Plus a CLI feed-validity check (`xmllint`) in `build.sh`.

## Config

```json
"plugin": ["./agentfeed/opencode/index.ts"]
```
