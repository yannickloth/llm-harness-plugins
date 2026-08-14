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
  reset, revert, switch, restore) → recorded as a `resource` (git) event with the
  branch it targets.
- **File edits/writes** (`edit`/`write`) → recorded as a `resource` (file) event
  with the path.

These are **informational "touched X" events** — they show others where you're
working, but they do **not** mark the resource as held. **When you take over a
shared resource for a long-running operation, hold it and free it explicitly** so
others know when it is available.

## When to use each tool

### Before starting work
- Call **`coord_who_does_what()`** first. If a task is already claimed (not expired,
  not released) or a resource is held, **do not start it** — pick another, or ask.

### Claiming ownership
- **`coord_claim(task, leaseMinutes?)`** when you start a substantive piece of work
  that others might otherwise pick up. The lease (default 30 min) expires — renew or
  **`coord_release(task|id)`** when done.

### Managing shared resources (the key part)
- **`coord_resource(resource, name, action)`** to acquire or release a shared
  resource (git branch or file path). Use `action: "acquire"` when you start and
  `action: "release"` when you are **done** so others know it is free.
- Git and file activity you perform is auto-recorded as an acquire (with a 30-min
  hold TTL); still call `coord_resource(action: "release")` to free the resource
  when your work on it ends.
- **`coord_heartbeat(task | resource, kind?)`** to renew the lease on a long-running
  claim or held resource so another agent does not reclaim it mid-work.

### Handing work off
- **`coord_handoff(task, to)`** to close your claim and open one for a target agent.
  They see the handoff in their digest and accept with `coord_claim`.

### Reporting progress
- **`coord_status(task, state)`** with state `done` / `failed` / `in-progress` to
  update the task board so others see progress at a glance.

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
  past a position (e.g. wait for someone to finish or release a resource before you
  take over). Pass an entry id (`host:seq`) or a full `ts|host|seq` watermark. Wait
  on a resource **release** entry to know when it is free.

## A typical coordination protocol

1. `coord_who_does_what()` — see what's claimed and what's held.
2. If your task is unclaimed: `coord_claim("task name")`.
3. `coord_log("msg", "working on <task>: <brief plan>")` — tell others your intent.
4. As you touch shared files/git, let the auto-recording surface the specifics.
5. When blocked or unsure: `coord_ask(...)`.
6. When you finish a shared resource, `coord_resource(action: "release")`; when the
   task is done: `coord_status("task", "done")` + `coord_release("task name")`.
7. For long tasks, `coord_heartbeat(...)` periodically to keep the lease alive.

## Conflict avoidance

- If a file, branch, or resource you need is actively being worked on (visible in the
  digest or `coord_who_does_what()`), coordinate before modifying:
  `coord_ask("are you done with <x>?")` or wait for its **release** via `coord_await(...)`.
- The digest may include a **"possible conflict"** alert when two agents acquired the
  same resource concurrently — resolve it before proceeding.
- A `claim` with an **expired lease** means the original owner may have moved on —
  you may take it over, but say so with a `coord_log`.
- Two agents can both work on the same repo across machines; the ledger only reduces
  (does not eliminate) conflicts. State what you're touching.
