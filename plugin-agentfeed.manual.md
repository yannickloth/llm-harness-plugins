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
| `coord.log(type, text)` | Publish a `msg` or `status` update |
| `coord.claim(task, leaseMinutes?)` | Claim a task (default lease 30 min); returns claim id |
| `coord.release(task\|id)` | Release a claim |
| `coord.who_does_what()` | List current open claims (expired leases + released tasks excluded) — call before starting work to avoid duplicating |
| `coord.await(position, timeoutSeconds?)` | Wait until the ledger advances past a position. `position` = an entry id (`host:seq`) or a watermark (`ts\|host\|seq`) |
| `coord.ask(question, to?)` | Broadcast a question; others see it in their digest |
| `coord.answer(answer, questionId\|question)` | Answer a question from `coord.ask` |

## Auto resource events

Shared-resource activity is recorded **automatically** — you don't need to call a tool for it:

- **git operations** (commit, merge, checkout, push, pull, rebase, branch, stash, reset, revert, switch, restore) → a `resource` (git) entry
- **file edits/writes** (`edit`/`write`) → a `resource` (file) entry with the path

These let other agents see where you're working and avoid conflicts. To prevent flooding, the same agent editing the same file (or running the same git operation) is recorded at most once per 30s — distinct operations (e.g. a commit then a push) are each recorded. Disable per-kind via `autoGit`/`autoFile`.

What is **not** auto-captured: general "what I'm working on" updates and Q&A — call `coord.log`/`coord.ask`/`coord.answer` for those.

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
| `task` / `text` / `status` / `lease` / `target` / `resource` / `file` | Per-type payload |

**Commit the ledger** (it's the coordination record). **Feed output and watermarks are git-ignored** (generated / per-session state).

## Concurrency

- **Same host:** an advisory lockfile (`agentfeed/.ledger.lock`) serializes appends so two processes can't reuse a seq. Stale locks (crash) are stolen after 60s.
- **Cross host:** no mutual exclusion by design — coordination is git merge of host-qualified ids. Two hosts can both claim a task; resolve via `coord.who_does_what()` + lease TTLs.

## Feed regeneration

After every mutating `coord.*` write, the plugin spawns the compiled `AtomCli` (Java ≥25, from `build/classes` — run `build.sh` first, like permission-modes) to regenerate feeds. Spawn is **fire-and-forget** (never blocks the tool response). If you hit latency, set `liveFeeds: false` in plugin options and regenerate manually:

```
java --class-path agentfeed/build/classes eu.infolead.llmhp.agentfeed.AtomCli --ledger agentfeed/ledger.jsonl --out agentfeed/feeds
```

## Configuration

```ts
{ ledgerDir?, maxDigestEntries?, liveFeeds?, javaBinary?, feedOutDir?, autoGit?, autoFile?, resourceCoalesceMs? }
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

## Testing

`build.sh` compiles the Java serializer (`src/main/java`) + tests (`src/test/java`), runs `AtomFeedTest` (parsing, escaping, ordering, feed generation), the TS tests, and a CLI feed-validity check (`xmllint`).

## Notes

- First user message of each session is skipped for digest injection (keeps session auto-titles clean).
- Empty prompts / prompts with no new ledger entries are left untouched (saves tokens).
- Hooks are wrapped so a ledger error can never crash the agent.
