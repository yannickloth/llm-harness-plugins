# agentfeed — User Manual

## Purpose

Lets agents in the same project coordinate: publish messages, claim tasks, hand off work, and see a live digest of what other agents are doing. Stream is also exported as an **Atom feed** (per-agent + aggregate) so a human can watch the swarm in any RSS reader.

## Install

Add to `opencode.json` plugin array:

```json
"plugin": ["./agentfeed/opencode/index.ts"]
```

On startup: `[agentfeed] plugin active — ledger: <root>/agentfeed/ledger.jsonl; live feeds: true`

## What it does

Three mechanisms, one shared append-only JSONL ledger (`agentfeed/ledger.jsonl`, committed to git):

1. **Ledger** — every agent's events (messages, claims, releases, status, handoffs) append here, one JSON object per line. Entries are host-qualified (`id = host:seq`), so commits merge cleanly across machines.
2. **Digest injection** — at each prompt, the plugin prepends a `## Coordination digest` listing only the entries *new since the agent last looked* (per-session watermark). This is push-at-prompt-boundary: no polling.
3. **Atom feed** — `agentfeed/feeds/feed.xml` (aggregate) + `feed-<agent>.xml` per agent, regenerated after every write. Open in a feed reader to watch live.

## Tools available to agents

| Tool | Purpose |
|------|---------|
| `coord_log(type, text)` | Publish a `msg` or `status` update |
| `coord_claim(task, leaseMinutes?)` | Claim a task (default lease 30 min); returns claim id |
| `coord_release(task\|id)` | Release a claim |
| `coord_resource(resource, name, action)` | Acquire/release a shared resource (git or file); release signals it is free |
| `coord_handoff(task, to)` | Close your claim and open one for a target agent |
| `coord_status(task, state)` | Mark a task `done`/`failed`/`in-progress` (task board) |
| `coord_heartbeat(task\|resource, kind?)` | Renew a claim/hold lease on long-running work |
| `coord_who_does_what()` | List open claims + held resources (expired/released excluded) — call before starting work to avoid duplicating |
| `coord_await(position, timeoutSeconds?)` | Wait until the ledger advances past a position. `position` = an entry id (`host:seq`) or a watermark (`ts\|host\|seq`); wait on a resource release to know when it frees |
| `coord_ask(question, to?)` | Broadcast a question; others see it in their digest |
| `coord_answer(answer, questionId\|question)` | Answer a question from `coord_ask` |

## Coordination guide for agents

A **`coordinate` skill** (`agentfeed/skills/coordinate/SKILL.md`) teaches agents the
typical use-cases and the coordination protocol — when to claim, announce, ask,
answer, and how to avoid conflicts. The plugin:

- self-registers the skill (so an agent can load the full guide via the `coordinate`
  skill), and
- injects a condensed use-case summary into every system prompt so agents know to
  `coord_who_does_what()` before starting and how to claim/log/ask/answer.

Git/file activity is recorded automatically; the guide focuses on the *intent* side
(claims, announcements, questions) that auto-recording cannot infer.

## Auto resource events

Shared-resource activity is recorded **automatically** — you don't need to call a tool for it:

- **git operations** (commit, merge, checkout, push, pull, rebase, branch, stash, reset, revert, switch, restore) → a `resource` (git) entry, with the branch it targets
- **file edits/writes** (`edit`/`write`) → a `resource` (file) entry with the path

These are **informational "touched X" events** — they show where you work but do not
mark the resource as held. To signal that a resource is **held** and then **free**, use
`coord_resource`:

- `coord_resource(resource, name, action: "acquire")` — marks it held with a 30-min
  lease, visible in `coord_who_does_what()`.
- `coord_resource(resource, name, action: "release")` — frees it so others can take over.
- On long-running holds, `coord_heartbeat(...)` renews the lease so it isn't reclaimed mid-work.

To prevent flooding, the same agent editing the same file (or running the same git op on the same branch) is recorded at most once per 30s — distinct operations (e.g. a commit then a push) are each recorded. Disable per-kind via `autoGit`/`autoFile`.

The digest also flags **concurrent holds** — if two agents hold the same resource at once, an `⚠ possible conflict` line is appended so they resolve it before proceeding.

What is **not** auto-captured: general "what I'm working on" updates and Q&A — call `coord_log`/`coord_ask`/`coord_answer` for those.

## Ledger format

`agentfeed/ledger.jsonl`, one JSON object per line:

```json
{"agent":"writer","type":"claim","task":"draft ch.4","status":"open","lease":"...","id":"laptop-p16:1","host":"laptop-p16","seq":1,"ts":"2026-08-13T22:51:52.218Z"}
```

| Field | Meaning |
|-------|---------|
| `id` | `host:seq` — globally unique, merge-safe |
| `host` / `seq` | Writer host + per-host monotonic counter (foreign-host entries do not advance it) |
| `ts` | UTC ISO-8601 |
| `agent` | Publishing agent |
| `type` | `msg`, `claim`, `release`, `status`, `handoff`, `heartbeat`, `resource`, `ask`, `answer` |
| `task` / `text` / `status` / `lease` / `target` / `resource` / `file` / `ref` / `action` | Per-type payload. For `resource`: `ref` = git branch; `action` = `acquire`/`release` |

**Commit the ledger** (it's the coordination record). **Feed output and watermarks are git-ignored** (generated / per-session state).

## Concurrency

- **Same host:** an advisory lockfile (`agentfeed/.ledger.lock`) serializes appends so two processes can't reuse a seq. Stale locks (crash) are stolen after 60s.
- **Cross host:** no mutual exclusion by design — coordination is git merge of host-qualified ids. Two hosts can both claim a task; resolve via `coord_who_does_what()` + lease TTLs.

## Feed regeneration

After every mutating `coord_*` write, the plugin spawns the compiled `AtomCli` (Java ≥25, from `build/classes` — run `build.sh` first, like permission-modes) to regenerate feeds. Spawn is **fire-and-forget** (never blocks the tool response). If you hit latency, set `liveFeeds: false` in plugin options and regenerate manually:

```
java --class-path agentfeed/build/classes eu.infolead.llmhp.agentfeed.AtomCli --ledger agentfeed/ledger.jsonl --out agentfeed/feeds
```

## Configuration

```ts
{ ledgerDir?, maxDigestEntries?, liveFeeds?, javaBinary?, feedOutDir?, autoGit?, autoFile?, resourceCoalesceMs?, resourceLeaseMs? }
```

| Option | Default |
|--------|---------|
| `ledgerDir` | `<worktree>/agentfeed` |
| `maxDigestEntries` | 50 |
| `liveFeeds` | `true` |
| `javaBinary` | `java` |
| `feedOutDir` | `<ledgerDir>/feeds` |
| `autoGit` | `true` |
| `autoFile` | `true` |
| `resourceCoalesceMs` | 30000 |
| `resourceLeaseMs` | 1800000 (30 min) |

## Testing

`build.sh` compiles the Java serializer (`src/main/java`) + tests (`src/test/java`), runs `AtomFeedTest` (parsing, escaping, ordering, feed generation), the TS tests, and a CLI feed-validity check (`xmllint`).

## Notes

- First user message of each session is skipped for digest injection (keeps session auto-titles clean).
- Empty prompts / prompts with no new ledger entries are left untouched (saves tokens).
- Hooks are wrapped so a ledger error can never crash the agent.
