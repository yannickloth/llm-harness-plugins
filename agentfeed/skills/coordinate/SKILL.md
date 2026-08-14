---
name: coordinate
description: How to coordinate with other agents in the same project via the agentfeed ledger. Use when deciding who does what, announcing work, claiming tasks, asking/answering questions, or before touching shared resources (git, files) that others may also use.
argument-hint: [optional situation to plan]
---

# Coordination with Other Agents

You are part of a project where multiple agents share an append-only **coordination
ledger** (`agentfeed/ledger.jsonl`). Every agent publishes to it and receives a
**digest** of *new* entries in each prompt — so the ledger is how you tell others
what you're doing and learn what they're doing.

## What is already automatic

You do **not** need to announce these — they are recorded for you:

- **Git operations** (commit, merge, checkout, push, pull, rebase, branch, stash,
  reset, revert, switch, restore) → recorded as a `resource` (git) event.
- **File edits/writes** (`edit`/`write`) → recorded as a `resource` (file) event
  with the path.

So other agents can see where you're working and avoid conflicts without you
thinking about it. You only need to act when coordination is about **intent**, not
raw resource access.

## When to use each tool

### Before starting work
- Call **`coord_who_does_what()`** first. If a task is already claimed (not expired,
  not released), **do not start it** — pick another, or ask.

### Claiming ownership
- **`coord_claim(task, leaseMinutes?)`** when you start a substantive piece of work
  that others might otherwise pick up. The lease (default 30 min) expires — renew or
  **`coord_release(task|id)`** when done.

### Announcing intent / progress
- **`coord_log("msg", text)`** when you begin a multi-step activity that isn't
  captured by git/file events (e.g. "researching the auth refactor", "writing the
  design doc for ch.4"). This is what others will see to know *what* you're working on.
- **`coord_log("status", text)`** to post progress updates on a long task.

### Asking and answering
- **`coord_ask(question, to?)`** to ask a question others will see in their digest —
  e.g. "who owns ch.4?", "is anyone editing auth/?".
- **`coord_answer(answer, questionId|question)`** to reply. Prefer passing the
  `questionId` (the `host:seq` shown in the digest line) so the answer is linked.

### Waiting for a handoff
- **`coord_await(position, timeoutSeconds?)`** to block until the ledger advances
  past a position (e.g. wait for someone to finish before you take over). Pass an
  entry id (`host:seq`) or a full `ts|host|seq` watermark.

## A typical coordination protocol

1. `coord_who_does_what()` — see what's claimed.
2. If your task is unclaimed: `coord_claim("task name")`.
3. `coord_log("msg", "working on <task>: <brief plan>")` — tell others your intent.
4. As you touch shared files/git, let the auto-recording surface the specifics.
5. When blocked or unsure: `coord_ask(...)`.
6. When done: `coord_release("task name")`.

## Conflict avoidance

- If a file or git branch you need is actively being worked on (visible in the
  digest), coordinate before modifying: `coord_ask("are you done with <x>?")` or
  wait via `coord_await(...)`.
- A `claim` with an **expired lease** means the original owner may have moved on —
  you may take it over, but say so with a `coord_log`.
- Two agents can both work on the same repo across machines; the ledger only reduces
  (does not eliminate) conflicts. State what you're touching.
