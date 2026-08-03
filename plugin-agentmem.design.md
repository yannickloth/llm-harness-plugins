# OpenCode Auto Memory System — Design Specification

Informed by field research across LangGraph, Mem0, Cursor, and Windsurf.
~35 improvements beyond any surveyed system.

Implementation: Java ≥ 25 for all logic. Thin TypeScript shims for platform tool
definitions (`.opencode/tools/*.ts` for OpenCode). The platform shells out to the
same Java scripts. Java scripts via `java MyScript.java` (JEP 458). No compilation step.

### 0.0 Multi-platform: shared files, explicit paths

Default memory directories follow a four-tier hierarchy. At session start, the
plugin loads the union of all tiers. More specific tiers take precedence for
retrieval ranking (per-project beats cross-project, personal beats team).

**Startup safety check:** if any tier path matches a shared memory path, verify that two
agents could not write to the same index → warn and refuse. Load-order conflict
resolution: per-project beats cross-project for same topic; personal beats team for same tier.

**Four-tier storage:**

| Tier | Path | Example | Managed by | Portable? |
|------|------|---------|------------|-----------|
| Cross-project team | `/etc/agentmem/shared/` (or sync server) | "All services use auth-gateway" | Org admin / sync | Via sync server |
| Cross-project personal | `~/.agentmem/global/MEMORY.md` | "Terse responses, always" | User | git repo in `~/.agentmem/` |
| Per-project team | `./MEMORY.md` (project root + subfolders) | "This repo's auth is SOC2-driven" | Team (git or sync) | Committed with code |
| Per-project personal | `~/.agentmem/<project>/MEMORY.md` | "I'm learning Rust, explain things" | User | git repo in `~/.agentmem/` |

**Load order at session start:**
```
1. Cross-project team    (org-wide policies, read-only)
2. Cross-project personal (user defaults, all projects)
3. Per-project team       (team's project-specific facts)
4. Per-project personal   (user's project-specific context)
5. Scoped MEMORY.md       (subfolder-specific, cascades inward from CWD)
```

**Retrieval precedence:** when loading topic files for a task, the agent reads
from most specific to least specific. Per-project team facts override cross-project
policies for the same topic. Per-project personal memories (project-specific
preferences) override cross-project personal defaults. Scoped MEMORY.md
(nearest to CWD) takes highest precedence.

**Why this split:** matches the industry consensus (Mem0 paper, LangGraph memory-agent).
User memory is long-term and personal (preferences, corrections, expertise). Team
memory is long-term and shared (decisions, rationale, compliance). Cross-project
exists for facts that transcend individual repos. Per-project personal covers
"I'm new to this codebase" context that shouldn't bleed into other projects.

**Plugin state** (`.agentmem/` in project root) contains config, indexes, locks,
entity graphs — never memory content. Memory is always `MEMORY.md` files, state is
always `.agentmem/`. Clean separation.

Topic files carry a `scope` frontmatter field. The dreamer respects scope during
consolidation: private memories stay in `~/.agentmem/`, team memories sync to
`.agentmem/`. Scoped `MEMORY.md` files in subdirectories inherit their parent scope.

```
# Default
project/.agentmem/
├── MEMORY.md                    ← Index
├── feedback_testing.md          ← Topic file
├── .entities.json               ← Extensions
└── .consolidate-lock

```

**Scoped files:** `.memory.md` in subdirectories — starts with dot to distinguish
from topic files, the plugin discovers them by walking upward from CWD.

---

## 0. Design Principles

### 0.1 IVP-prescribed packaging

The system is analyzed through the Independent Variation Principle: elements that respond
to the same change driver are grouped; elements with differing drivers are separated.

**Change driver analysis:**

| Element | Change driver | Description |
|---------|--------------|-------------|
| MemoryStore, IndexManager, WriteProtocol | Memory storage contract | How topics + index are written/read on disk |
| EntityIndex | Retrieval mechanism | How entities are extracted and indexed |
| QualityGateRunner + 7 gates | Validation rules | What constitutes a valid memory |
| ConfidenceManager, DecayManager | Memory lifecycle model | How confidence scores and decay work |
| ConsolidationLock | Dream gating mechanism | How consolidation is scheduled |
| HistoryManager | Audit mechanism | How versions are tracked |
| GuardrailEvaluator | Guardrail matching rules | What triggers active warnings |
| ScopedMemoryLoader | Directory scoping model | How `.agentmem/` directories are resolved |
| EntityGraph | Entity-to-entity edges | How entity relationships are tracked for graph-based retrieval |
| DigestWriter | Digest synthesis format | How digests are structured |
| ModelTrustTracker | Model quality model | How model trust is computed |
| SyncClient | Team sync protocol | How remote sync works |

**IVP-3 (Separation):** elements with different change drivers must be in separate modules.

**Result:** each `.java` file is a separate script — its own module. The filesystem
is the packaging boundary. The `core/` directory is an organizational convenience,
not a module — Java scripts are independently invoked and independently changeable.

**IVP-4 (Unification):** elements with identical change drivers must be in the same module.

**Result:** MemoryStore and IndexManager share the storage driver → co-locate in `MemoryStore.java`.
The 7 quality gates share the validation driver → co-locate in `QualityGateRunner.java`.
ConfidenceManager and DecayManager share the lifecycle driver → co-locate in `MemoryLifecycle.java`.

**IVP-pragmatic over-split prevention:** 6 packages (separate npm modules) for 15
Java files would introduce coordination overhead exceeding change-isolation benefit.
One repository, one install path, internal modularization via filesystem.

### 0.2 Repo structure

```
opencode-memory/                       # One repo, one install
├── README.md
├── MemoryStore.java                   # Read/write/delete topic files + MEMORY.md index (atomic, WAL)
├── EntityIndex.java                   # .entities.json regex extraction + lookup (zero deps)
├── QualityGateRunner.java             # 7 write-time validation gates
├── MemoryLifecycle.java               # Confidence scoring + type-specific decay curves
├── ConsolidationLock.java             # PID-based dream lock, boot-ID guard
├── HistoryManager.java                # Version snapshots + orphan cleanup
├── GuardrailEvaluator.java            # Match guard triggers against file paths + tool names
├── ScopedMemoryLoader.java            # Hierarchical .agentmem/ directory resolution
├── DigestWriter.java                  # Synthesize multi-file digests + episode narratives
├── EntityGraph.java                   # Entity-to-entity edges for graph-based retrieval
├── ModelTrustTracker.java             # Model capability tiers + progressive distrust
├── ReviewGenerator.java               # Weekly review summary from recent changes
├── SyncClient.java                    # Optional: team-memory sync client (delta, ETag)
├── Bootstrap.java                     # Git history scan → seed initial memories
├── Migration.java                     # Schema upgrades, format conversions
├── PathValidator.java                 # Path traversal + symlink defense
├── types/
│   ├── MemoryType.java               # Sealed: User | Feedback | Project | Reference
│   ├── ProjectSubtype.java           # Sealed: Failure | Serendipity | Anomaly | Digest | Question
│   ├── Entry.java                    # Record: all frontmatter fields
│   ├── Confidence.java               # Enum: HIGH | MEDIUM | LOW | SPECULATIVE
│   ├── ModelTier.java                # Enum: S | A | B | C | UNKNOWN
│   └── TrustLevel.java               # Enum: TRUSTED | SUSPICIOUS | DISTRUSTED
├── tools/
│   ├── save-memory.ts                # TS shim → java MemoryStore.java save ...
│   ├── forget-memory.ts              # TS shim → java MemoryStore.java delete ...
│   ├── check-health.ts               # TS shim → java QualityGateRunner.java health ...
│   └── init-memory.ts                # TS shim → java Bootstrap.java ...
├── agents/
│   ├── memory-keeper.md               # Subagent: out-of-band per-turn extraction (steps: 5)
│   └── memory-dreamer.md              # Subagent: nightly consolidation (steps: 10)
├── prompts/
│   └── agent-prompt.md                # Injected into build agent's context
└── opencode.json.sample               # Config reference: instructions + command entries
```

### 0.3 Design constraints

| Constraint | Why |
|------------|-----|
| Plain filesystem storage | Debuggable with `cat`, diffable with `git`, portable with `rsync`, no infra dependency |
| No vector DB or embeddings | Retrieval via grep + entity index + keyword scan; no model in the retrieval path |
| Platform-neutral `core/` | Same library powers OpenCode and CI pipelines |
| ADD-only semantics | Memories accumulate; contradictions are explicit, deletions are explicit |
| Write-ahead log | Temp → fsync → rename for every file write; never corrupt on crash |
| Short instructions | Agent prompt ~80 lines; model internalizes taxonomy without full text every session |

## 1. Architecture Overview

Three tiers. Three agents. One filesystem. Hierarchical scoping.

```
project/
├── .agentmem/          # Plugin state: config, indexes, locks, entity graphs
│   ├── config.json           Plugin settings
│   ├── .entities.json        Multi-signal retrieval index
│   ├── .entities-graph.json  Entity-to-entity edges
│   ├── .history/             Versioned snapshots
│   ├── .cold/                Demoted files
│   ├── .tmp/                 Write-ahead log temp files
│   ├── .consolidate-lock     Dream scheduler state
│   ├── .model-trust.json     Model trust tracking
│   └── .sync-state.json      Team sync state (if enabled)
├── MEMORY.md                 # Project-scoped memory index (root)
├── src/
│   ├── auth/
│   │   └── MEMORY.md         # Scoped: loaded when in src/auth/
│   └── frontend/
│       ├── MEMORY.md         # Scoped: loaded when in src/frontend/
│       └── components/
│           └── MEMORY.md     # Scoped: cascades inward
```

### Deployment layout

```
~/.config/opencode/plugins/
├── memory-plugin.ts            Plugin entry: exports hooks + registers tools
├── memory-keeper-trigger.ts    Fires memory-keeper on session.idle
├── dreamer-trigger.ts          Fires dreamer on time/session/lock gates
└── guardrail-hook.ts           tool.execute.before → GuardrailEvaluator
```
```
.opencode/agents/
├── memory-keeper.md            Agent: out-of-band per-turn extraction
└── memory-dreamer.md           Agent: nightly consolidation
```

### Index vs topic files

| Property | MEMORY.md | Topic files |
|----------|-----------|-------------|
| Frontmatter | None | `name`, `description`, `type`, `subtype`, `who`, `context`, `confidence`, `modified`, `version`, `reads`, `last_read`, `guard`, `guard_trigger`, `contradicts`, `sync` |
| Fields set by save tool | — | `name`, `description`, `type`, `subtype`, `who`, `context`, `confidence`, `modified`, `contradicts`, `guard_trigger` |
| Fields set by dreamer | — | `version`, `reads`, `last_read`, `language`, `sync` |
| Fields set by user review | — | `guard` (enable/disable) |
| Loaded when | Session start | On-demand per task |
| Content | `- [Title](file.md) — one-line hook` | Structured body (type-dependent) |
| Size limit | 200 lines / 25KB | 250KB per file |
| Write | Step 2 of save protocol | Step 1 |

### Per-turn context scaling

```
Memory count:         10     100    1,000   10,000
────────────────────────────────────────────────────
MEMORY.md lines:      10     100      200      200  (capped)
MEMORY.md tokens:    ~300   ~2.5K    ~5K      ~5K   (capped)
Topic files loaded:   1-2    1-3      1-5      1-5   (selective)
Added tokens/turn:   ~500   ~800   ~1.5K    ~2K     (sublinear)
```

---

## 2. Three-Tier Processing Model

```
Tier 1 — In-band save (seconds)
  Build agent calls save-memory tool during a turn.
  → Single fact, immediate persistence, write-ahead log atomicity.

Tier 2 — Out-of-band extraction (turns/minutes)
  Memory-keeper subagent reviews current conversation.
  → Per-turn extraction, catches what the main agent missed.
  → Separate context window — never competes with coding.

Tier 3 — Dreaming (hours/days)
  Memory-dreamer subagent reviews ALL sessions since last dream.
  → Cross-session synthesis, dedup, contradiction resolution, pruning.
  → Rebuilds .entities.json, writes digests, runs weekly review.

Tier 3b — Weekly review (user-in-the-loop)
  Dreamer generates summary of new/changed memories.
  → User confirms, corrects, or removes.
  → Lightweight human-in-the-loop catch.
```

---

## 3. Memory Type Taxonomy

### 3.1 Primary types

| Type | What | When to save | Decay |
|------|------|-------------|-------|
| `user` | Role, goals, expertise, preferences | Anytime you learn about the user | Slow (90d read stale, 365d prune) |
| `feedback` | Corrections AND confirmations | User corrects OR validates non-obvious approach | Medium (60d/180d) |
| `project` | Ongoing work, deadlines, decisions + rationale | Who is doing what, why, by when | Fast (14d/60d) |
| `reference` | Pointers to external systems | When you learn about resources outside the project | Medium (30d/90d) |

### 3.2 Expectation gap subtypes (project)

These document the gap between expectation and reality — the most information-dense
events in a codebase's history.

| Subtype | Definition | Decay | Body structure |
|---------|-----------|-------|---------------|
| `failure` | Expected it to work. It didn't. | 365d | What we tried → Expected → Why it failed → Gap → Learned → Next |
| `serendipity` | Expected it to fail. It worked. | 180d | What we tried → Expected → Why it worked anyway → What this changes |
| `anomaly` | Should have worked. Failed. | 365d | What failed → Expected → Why it should have worked → What was actually wrong → Gap in mental model → Learned → Changes |

**Example — anomaly:**

```markdown
---
name: anomaly_css_deploy_outage
description: 3-line CSS change caused full-service outage during deploy
type: project
subtype: anomaly
who: Human
context: Post-incident review of incident #1351
confidence: high
---

**What failed:** Production deploy of a 3-line CSS change triggered full-service
outage (500 errors across all endpoints, 4 minutes).

**Expected:** 3-line CSS change → no backend impact. Standard deploy.

**Why it should have worked:** CSS files served by nginx, not the app server.

**What was actually wrong:** `npm ci` in the deploy script pulled in a yanked
transitive dependency. Clean install failed → build failed → deploy aborted
mid-rollout → half the pods were on broken asset pipeline.

**Gap in mental model:** "3-line CSS" ≠ "no dependency changes." Every deploy runs
`npm ci` — a yanked package bricks any deploy regardless of change size.

**What we learned:**
1. Pin all transitive dependencies.
2. Add canary deploy step before full rollout.
3. Alert on `npm ci` failures before they reach production.

**See also:** feedback_pin_deps.md, project_canary_deploy.md
```

### 3.3 Digest subtype (project)

When the dreamer finds >10 topic files referencing the same domain cluster, it writes a
digest — a synthesized summary promoted to the top of MEMORY.md as a landing page.

### 3.4 Question subtype (project)

```
---
name: question_ci_hang
type: project
subtype: question
status: open
---

**What we don't know:** CI builds occasionally hang — suspected race condition.
**Last observed:** 2026-07-22, build #4821.
**How to investigate:** Run with --workers=1 on hanging builds to isolate.
```

When resolved, the dreamer converts it to a `project` memory with a `contradicts:` link.

---

## 4. Provenance — Mandatory Body Structure

Every `project` and `feedback` memory must record:

| Field | Required | Description |
|-------|----------|-------------|
| **What** | Yes | What changed, was decided, or was discovered |
| **Why** | Yes | The reason or motivation |
| **How to apply** | Yes | When/where this guidance applies |
| **Who** | Yes | `Human` / `Agent (user-requested)` / `Agent (autonomous)` |
| **Context** | Yes | What problem was being solved, what task was in progress |
| **Git refs** | Optional | Commit hashes, branches, PR numbers |
| **Contradicts** | Optional | Prior memories or facts this supersedes |

---

## 5. What NOT to Save (Exclusion List)

```
- Code patterns, conventions, architecture, file paths — derivable from current code
- Git history, recent changes — git log/blame are authoritative
- Debugging solutions — the fix is in the code; commit msg has context
- Anything in AGENTS.md
- Ephemeral task details
```

**Hard rule:** these exclusions apply even when the user explicitly asks to save. If
they ask to save a PR list or activity summary, push back — ask what was *surprising*
or *non-obvious* about it.

---

## 6. Save Protocol (Atomic, ADD-only)

### 6.1 Two-step write

```
Step 0 — Validate name: [a-zA-Z0-9_-]+ only (path traversal defense)
Step 1 — Write topic file to .tmp/<name>.<uuid>, fsync, rename → atomic commit
Step 2 — Add pointer to MEMORY.md (also via temp → rename)
```

### 6.2 Security: path validation

```
Before any file operation:
  - Name field validated via regex [a-zA-Z0-9_-]+ (no /, ., ..)
  - Target real-path checked to be within memory directory (symlink defense)
  - .entities.json, .consolidate-lock, .sync-state.json checked before overwrite
```

The topic file is never written directly — `write → fsync → rename` ensures the
memory directory is never left in a corrupted state.

### 6.3 ADD-only semantics

The save-memory tool never deletes. Contradict a memory? Write a new file with
`contradicts:` pointing to the old one. The dreamer demotes the old file's MEMORY.md
pointer; the file itself stays in `.cold/`. Explicit deletion requires the user
to run `/forget-memory <name>`.

### 6.3 Index size enforcement

Before writing, the tool checks MEMORY.md line count and byte size. If over 200 lines
or 25KB: returns BLOCKED with a message telling the agent to consolidate first.

### 6.4 Entity extraction

After each write, the tool scans the topic file body for entities (file paths matching
`[\w/.-]+\.[a-z]{1,6}`, function names in backticks, capitalized abbreviations like
"SOC2", URLs) and appends them to `.entities.json`. This index enables multi-signal
retrieval without embeddings.

---

## 7. Concurrency & Locking

### 7.1 Single-machine: content-hash precondition

```
1. Agent reads file → SHA-256 hash included as write precondition
2. Tool re-reads file → computes SHA-256 again
3. Hash differs → file modified since agent read → return CONFLICT
4. Hash matches → write proceeds (atomic via temp → rename)
```

### 7.2 Agent-level mutual exclusion

```
Turn ends
  → Did main agent write to .agentmem/ this turn?
    → YES: skip memory-keeper
    → NO: spawn memory-keeper via opencode run --agent memory-keeper
```

### 7.3 Multi-machine: version counter (sync server mode)

Each topic file frontmatter carries `version: <int>`. On sync server push:
- Last-write-wins by version number
- If local version > remote: local wins (our change was newer)
- If remote version > local: remote wins (someone else's change is newer)
- ETag-based optimistic locking at the HTTP level: `If-Match: <checksum>`

### 7.4 Dream lock (PID file with boot-ID guard)

```
.consolidate-lock in memory directory:
  Body: "<pid>:<boot_id>"  (boot_id prevents PID reuse across reboots)
  mtime: timestamp of last consolidation
  Staleness: >60 min → reclaim (PID reuse guard)
  Boot-ID check: read /proc/sys/kernel/random/boot_id, compare with lock body
  Rollback: rewinds mtime on failure so time gate passes again
```

---

## 8. Retrieval — Multi-Signal, No LLM in Path

### 8.1 Startup

Root `.agentmem/MEMORY.md` always loaded. Scoped `.agentmem/MEMORY.md` files
in the CWD and its children loaded too. Topic files never loaded at startup.

### 8.2 Per-task pipeline (scoped)

```
User edits src/auth/middleware.ts
  → Load scoped context: root memory/ + src/auth/.agentmem/
  → Scan root MEMORY.md hooks for keyword overlap (free)
  → Scan scoped MEMORY.md hooks for keyword overlap (free, more specific matches)
  → If hooks match → grep root + scoped memory dirs (1 tool call each)
  → If grep finds candidates → check root + scoped .entities.json (2 tool calls max)
  → Read matched topic files → full content in context
  → Topic file content drops out on next turn or compaction

Scoped matches take precedence over root matches.
Scoped memories are never loaded when working in a different subtree.
```

### 8.3 Entity index

`.entities.json` maps extracted entities to the topic files that reference them:

```json
{
  "src/db/migrations": ["feedback_testing.md"],
  "ALTER TABLE": ["feedback_testing.md"],
  "grafana.internal/d/api-latency": ["reference_tools.md"],
  "SOC2": ["project_auth.md", "anomaly_css_deploy_outage.md"],
  "pgBouncer": ["failure_connection_pool.md"],
  "npm ci": ["anomaly_css_deploy_outage.md"],
  "ClickHouse": ["serendipity_data_migration.md"],
  "README.md": ["reference_tools.md", "feedback_testing.md"]
}
```

No embedding model. No vector DB. No LLM in the retrieval path. Just grep + JSON lookup.

### 8.4 Per-type confidence + staleness

| Type | Read staleness | Prune after | Reasoning |
|------|---------------|-------------|-----------|
| `user` | 90 days | 365 days | Expertise/preferences are stable |
| `feedback` | 60 days | 180 days | Rules evolve slowly |
| `project` | 14 days | 60 days | Deadlines pass, decisions change |
| `reference` | 30 days | 90 days | URLs and external names drift |
| `failure` | Never | 365 days | The gap doesn't expire |
| `serendipity` | 90 days | 180 days | Risk recalibration, code evolves |
| `anomaly` | Never | 365 days | Hidden variable may still exist |

Confidence modulates staleness: `low` confidence → caveat applies sooner; `high`
confidence → caveat delayed. The dreamer can upgrade confidence if a speculative
memory is independently confirmed by a later session.

**Decay precedence:** type-based decay is the base curve → confidence modulates it
(shorter for low/speculative) → model tier overrides in the fast direction only
(distrusted model memories decay sooner, trusted ones follow the normal curve).
A high-confidence failure memory from a trusted model: 365 days. A speculative
project memory from a distrusted model: 3 days.

### 8.5 Secrets scanning gate (pre-write)

Topic file content is scanned for common secret patterns before save. Detected
secrets → REJECTED with a warning. Patterns:
- `sk-...` (OpenAI, Anthropic keys)
- `-----BEGIN` (PEM keys)
- `AKIA...` (AWS access keys)
- `ghp_...`, `github_pat_...` (GitHub tokens)
- `xox[bprs]-...` (Slack tokens)

Secret scanning is also applied on the sync server push path — secrets never leave
the local machine. Matched patterns are identified by rule ID only (e.g., "aws-access-key"),
never the secret value itself.

---

## 9. Agent Prompts

These are shipped as `prompts/agent-prompt.md` and injected into the build agent's
context via `opencode.json` `instructions` field. The memory-keeper and dreamer
subagents receive subsets of this.

```
# auto memory

You have a persistent, file-based memory system at `.agentmem/`.
Use the `save-memory` tool to persist learnings across sessions.

## Types
user — role, expertise, preferences. Save when you learn about the user.
feedback — corrections AND confirmations. Body: What/Why/How-to-apply/Who/Context.
project — deadlines, decisions, rationale. Subtypes: failure/serendipity/anomaly.
reference — external system pointers (Linear projects, Grafana dashboards, Slack).

## What NOT to save
Derivable facts (code patterns, git history, debugging recipes), AGENTS.md content,
ephemeral task details. These exclusions apply even when user explicitly asks.

## How to save
Step 1: Write topic file with frontmatter (name, description, type, subtype, who,
        context, confidence). For project/feedback: include What/Why/How-to-apply/Who/Context.
Step 2: Add one-line pointer to MEMORY.md: "- [Title](file.md) — hook under 150 chars"
Never write content directly into MEMORY.md. Never delete — use contradicts: field.

## When to access
When memories seem relevant, or user references prior work. If user says to ignore
memory: proceed as if MEMORY.md were empty. Verify against current code before
acting on stale memories. "The memory says X exists" ≠ "X exists now."

## Persistence separation
Plans → implementation approach alignment. Tasks → current-conversation steps.
Memory → cross-session knowledge. Do not confuse them.
```

### 9.2 Memory-keeper subagent (extraction prompt)

```
You are the memory extraction subagent. Analyze the most recent conversation above
and persist any non-derivable learnings to .agentmem/.

Tool permissions: Read, Grep, Glob, Write, Edit (memory dir only), read-only Bash.
Turn budget: 5 max. Strategy: read all candidates in parallel (turn 1),
write all in parallel (turn 2).

Use the four-type taxonomy. Apply the exclusion list strictly. Include provenance
fields (Who, Context). Never delete files — use contradicts: field. Save content
directly via the Write tool with proper frontmatter.
```

### 9.3 Memory-dreamer subagent (consolidation prompt)

```
You are the dreamer — a reflective pass over all memory files. Synthesize what
you've learned recently into durable, well-organized memories.

Phase 1 — Orient: ls + read MEMORY.md + skim existing topic files.
Phase 2 — Gather signal: review recent session transcripts (grep narrowly),
  find drifted memories, extract cross-references.
Phase 3 — Consolidate: merge new signal into existing files. Convert relative
  dates to absolute. If old memory is contradicted → write new file with
  contradicts: field. Never delete. For >10 files on same topic → write digest.
Phase 4 — Prune, index, link: update MEMORY.md ≤200 lines. Demote verbose entries.
  Add See also: links. Rebuild .entities.json. Apply decay curves. Generate
  weekly review summary if ≥5 new/updated memories since last review.

## Convergence loop

After phase 4, the dreamer enters a convergence loop (max 5 rounds):

  Round 1 — Review: re-read MEMORY.md + all files touched in phases 3-4.
    Check for:
    - Dangling MEMORY.md pointers (entries pointing to non-existent files)
    - Orphaned topic files (files with no MEMORY.md pointer)
    - Drifted memories (claims about files that no longer exist or were renamed)
    - Contradictory pairs (two memories making incompatible claims)
    - Stale entity index entries (entities that no longer appear in any file)
    - Expired memories past their sunset date
    - Unresolved questions that now have answers in recent session transcripts
    - Digests with stale source references (sources modified since digest was written)
  
  Round 2 — Fix: correct each finding from round 1.
    - Dangling pointer → remove or fix the link
    - Orphaned file → add pointer or move to .cold/
    - Drifted memory → add drift note or contradictions: link
    - Contradiction → flag both with contradicted_by:, write resolution if possible
    - Stale entity → remove from .entities.json
    - Expired → add "EXPIRED" prefix to MEMORY.md pointer, flag for review
    - Resolved question → convert to project/failure memory, close question
    - Stale digest → re-read sources, update digest or mark as "needs rebuild"
  
  Round 3 — Re-review: scan for new findings introduced by round 2 fixes.
    (Fixing a contradictory pair may create a new dangling pointer.)
    If zero findings → STOP. Converged in 3 rounds.

  Round 4 — Fix remaining: resolve any second-order issues.

  Round 5 — Review: final scan. If zero findings, converge.
    If findings remain → write HEALTH.md with unresolved entries.

Wall-clock timeout: max 5 minutes per dream session. If rounds are still running
at the timeout, stop and report partial results.

Respond: "Dream converged in N rounds. [summary]."
Or: "Dream incomplete after 5 rounds. [unresolved in HEALTH.md]."
```

---

## 10. Java ≥ 25 Core + TypeScript Tool Shims

OpenCode tools must be `.ts` files in `.opencode/tools/`. The TS file is the
schema + shell-out shim; all logic lives in Java scripts invoked via `Bun.$`.

### 10.0 TypeScript tool shim pattern

```typescript
// .opencode/tools/save-memory.ts
// Required by OpenCode: tool definitions must be .ts/.js
// Logic lives in MemoryStore.java — invoked via Bun shell API
import { tool } from "@opencode-ai/plugin"
import path from "path"

export default tool({
  description: "Save a project learning to persistent memory. Two-step protocol: write topic file with frontmatter, then add index pointer to MEMORY.md.",
  args: {
    name: tool.schema.string().describe("Filename stem, [a-zA-Z0-9_-]+"),
    description: tool.schema.string().describe("One-line relevance summary"),
    type: tool.schema.enum(["user", "feedback", "project", "reference"]),
    subtype: tool.schema.string().optional().describe("failure | serendipity | anomaly (project only)"),
    who: tool.schema.string().describe("Human | Agent (user-requested) | Agent (autonomous)"),
    context: tool.schema.string(),
    confidence: tool.schema.enum(["high", "medium", "low", "speculative"]).default("medium"),
    content: tool.schema.string().describe("Body. For feedback/project: What/Why/How-to-apply/Who/Context"),
    hook: tool.schema.string().describe("One-line MEMORY.md pointer, ≤150 chars"),
    contradicts: tool.schema.string().optional(),
  },
  async execute(args, context) {
    const script = path.join(context.worktree, "MemoryStore.java")
    const result = await Bun.$
      `java ${script} save ${JSON.stringify(args)}`.text()
    return result.trim()
  },
})
```

### 10.1 Java core scripts

```java
#!/usr/bin/env -S java --source 25
import module java.base;

void main() {
    // Plugin entry: registers session.idle hook
    // Memory-keeper: fires on session idle, checks disk mtime for mutual exclusion
    // Dreamer: fires on session idle, evaluates time/session/lock gates
    // Sync server: optional, handles push/pull with ETag-based locking
}
```

### 10.2 `SaveMemoryTool.java`

```java
#!/usr/bin/env -S java --source 25
import module java.base;
import java.security.MessageDigest;

/**
 * Two-step atomic write tool for the memory system.
 *
 * Step 1: Write topic file to .tmp/<name>.<uuid> → fsync → rename
 * Step 2: Update MEMORY.md index → fsync → rename
 * Post-write: extract entities → update .entities.json
 * Pre-write checks: index size (≤200 lines / 25KB), hash precondition
 */
record MemoryEntry(
    String name,          // Validated: [a-zA-Z0-9_-]+ only
    String description,
    String type,
    Optional<String> subtype,
    String who,           // "Human" | "Agent (user-requested)" | "Agent (autonomous)"
    String context,
    String confidence,    // "high" | "medium" | "low" | "speculative"
    String content,
    String hook,          // ≤150 char one-line MEMORY.md pointer
    Optional<String> contradicts,
    Optional<String> guardTrigger
) {
    static final Pattern VALID_NAME = Pattern.compile("[a-zA-Z0-9_-]+");

    MemoryEntry {
        if (!VALID_NAME.matcher(name).matches()) {
            throw new IllegalArgumentException("name must match [a-zA-Z0-9_-]+");
        }
        if (hook.length() > 150) {
            throw new IllegalArgumentException("hook must be ≤150 characters");
        }
    }
}

static String sha256(String input) throws NoSuchAlgorithmException {
    var md = MessageDigest.getInstance("SHA-256");
    return HexFormat.of().formatHex(md.digest(input.getBytes(StandardCharsets.UTF_8)));
}

private static void checkIndexSize(Path memDir) throws IOException {
    var indexPath = memDir.resolve("MEMORY.md");
    if (!Files.exists(indexPath)) return;
    var raw = Files.readString(indexPath).trim();
    var lines = raw.split("\n").length;
    var bytes = raw.getBytes(StandardCharsets.UTF_8).length;
    if (lines > 200 || bytes > 25_000) {
        var reason = lines > 200 ? "%d lines (limit: 200)".formatted(lines)
                                 : "%d bytes (limit: 25KB)".formatted(bytes);
        throw new IOException(
            "MEMORY.md is %s. Consolidate before saving new memories.".formatted(reason));
    }
}

private static void writeTopicFileAtomic(Path memDir, MemoryEntry entry) throws IOException {
    var tmpDir = memDir.resolve(".tmp");
    Files.createDirectories(tmpDir);
    var tmpFile = tmpDir.resolve("%s.%s".formatted(entry.name(), UUID.randomUUID()));
    var target = memDir.resolve("%s.md".formatted(entry.name()));

    // Validate target is inside memDir (path traversal defense)
    // For new files, resolve parent directory and check + ensure target resolves within
    var targetParent = target.getParent();
    if (!targetParent.toRealPath().startsWith(memDir.toRealPath())) {
        throw new SecurityException("path traversal detected");
    }

    var frontmatter = """
        ---
        name: %s
        description: %s
        type: %s
        who: %s
        context: %s
        confidence: %s
        modified: %s
        ---

        %s
        """.formatted(entry.name(), entry.description(), entry.type(),
                      entry.who(), entry.context(), entry.confidence(),
                      Instant.now().toString(), entry.content());

    Files.writeString(tmpFile, frontmatter);
    // fsync via force(true) on the channel
    try (var ch = FileChannel.open(tmpFile, StandardOpenOption.WRITE)) {
        ch.force(true);
    }
    Files.move(tmpFile, target, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
}
```

### 10.3 `ConsolidationLock.java`

```java
#!/usr/bin/env -S java --source 25
import module java.base;

/**
 * PID-based consolidation lock.
 *
 * Lock file: .agentmem/.consolidate-lock
 * Body: process PID
 * mtime: last consolidation timestamp
 * Staleness: >60 minutes → reclaim (PID reuse guard)
 * Acquisition: write PID → read back to verify (race-safe)
 * Rollback: rewind mtime to pre-acquire value on failure
 */
record LockState(long mtimeMs, OptionalLong holderPid, String bootId) {}

LockState readLock(Path memDir) throws IOException {
    var lockFile = memDir.resolve(".consolidate-lock");
    var bootId = Files.readString(Path.of("/proc/sys/kernel/random/boot_id")).trim();
    try {
        var attrs = Files.readAttributes(lockFile, BasicFileAttributes.class);
        var parts = Files.readString(lockFile).trim().split(":");
        var pid = Long.parseLong(parts[0]);
        var lockBootId = parts.length > 1 ? parts[1] : "";
        return new LockState(attrs.lastModifiedTime().toMillis(), OptionalLong.of(pid), lockBootId);
    } catch (NoSuchFileException e) {
        return new LockState(0, OptionalLong.empty(), bootId);
    }
}

Optional<Long> tryAcquire(Path memDir) throws IOException {
    var state = readLock(memDir);
    var now = System.currentTimeMillis();
    var STALE_MS = 60 * 60 * 1000L;
    var bootId = Files.readString(Path.of("/proc/sys/kernel/random/boot_id")).trim();

    if (state.mtimeMs() > 0 && now - state.mtimeMs() < STALE_MS) {
        if (state.holderPid().isPresent() && state.bootId().equals(bootId)
            && ProcessHandle.of(state.holderPid().getAsLong()).isPresent()) {
            return Optional.empty(); // locked by live process on same boot
        }
    }

    var lockFile = memDir.resolve(".consolidate-lock");
    Files.writeString(lockFile, String.valueOf(ProcessHandle.current().pid()));
    var verifyPid = Long.parseLong(Files.readString(lockFile).trim());
    if (verifyPid != ProcessHandle.current().pid()) return Optional.empty(); // lost race

    return Optional.of(state.mtimeMs());
}
```

### 10.4 `EntityIndex.java`

```java
#!/usr/bin/env -S java --source 25
import module java.base;
import java.util.regex.Pattern;

/**
 * Lightweight entity index for multi-signal retrieval. Zero external dependencies.
 *
 * JSON read/write uses manual formatting — no Jackson/Fasterxml needed.
 * The .entities.json format is simple enough for this.
 */
record EntityIndex(Map<String, Set<String>> entities) {
    static final Pattern FILE_PATH = Pattern.compile("[\\w/.-]+\\.[a-z]{1,6}");
    static final Pattern BACKTICK = Pattern.compile("`([^`]+)`");
    static final Pattern ABBREV = Pattern.compile("\\b([A-Z]{2,}(?:\\d+)?)\\b");
    static final Pattern URL = Pattern.compile("https?://[\\w./-]+");

    static EntityIndex load(Path memDir) throws IOException {
        var file = memDir.resolve(".entities.json");
        if (!Files.exists(file)) return new EntityIndex(new HashMap<>());
        var raw = Files.readString(file);
        try {
            return parseJson(raw);
        } catch (Exception e) {
            // Corrupt JSON → regenerate from scratch by scanning all topic files
            return rebuild(memDir);
        }
    }

    void addFrom(String filename, String content) {
        for (var m : List.of(
            FILE_PATH.matcher(content),
            BACKTICK.matcher(content),
            ABBREV.matcher(content),
            URL.matcher(content)
        )) {
            while (m.find()) {
                var entity = m.group(1);
                entities.computeIfAbsent(entity, k -> new HashSet<>()).add(filename);
            }
        }
    }

    void save(Path memDir) throws IOException {
        var sb = new StringBuilder();
        sb.append("{\n");
        var first = true;
        for (var entry : entities.entrySet()) {
            if (!first) sb.append(",\n");
            first = false;
            sb.append("  \"%s\": [".formatted(escape(entry.getKey())));
            sb.append(entry.getValue().stream()
                .map(f -> "\"%s\"".formatted(escape(f)))
                .collect(java.util.stream.Collectors.joining(", ")));
            sb.append("]");
        }
        sb.append("\n}\n");
        Files.writeString(memDir.resolve(".entities.json"), sb.toString());
    }

    private static String escape(String s) {
        return s.replace("\\", "\\\\")
                .replace("\"", "\\\"")
                .replace("\n", "\\n")
                .replace("\r", "\\r")
                .replace("\t", "\\t");
    }

    // Walk memDir, scan all .md files, call addFrom() for each
    // Called when .entities.json is corrupt or missing
    static EntityIndex rebuild(Path memDir) throws IOException {
        var index = new EntityIndex(new HashMap<>());
        try (var files = Files.list(memDir)) {
            files.filter(Files::isRegularFile)
                 .filter(f -> f.toString().endsWith(".md"))
                 .filter(f -> !f.getFileName().toString().equals("MEMORY.md"))
                 .forEach(f -> {
                     try { index.addFrom(f.getFileName().toString(), Files.readString(f)); }
                     catch (IOException ignored) {}
                 });
        }
        return index;
    }
}
```

### 10.5 `SyncClient.java` (optional team-memory sync)

```java
#!/usr/bin/env -S java --source 25
import module java.base;
import java.net.http.*;
import java.security.MessageDigest;

/**
 * Team memory sync client — optional multi-machine layer.
 *
 * API: GET/PUT to /api/memory?repo=<owner/repo>
 * Delta: per-key SHA-256 comparison (local vs serverChecksums)
 * Locking: ETag-based optimistic (If-Match / If-None-Match)
 * Batching: 200KB PUT bodies, 250KB per-file cap
 * Security: secret scanning before upload, path traversal prevention
 *
 * State persisted to .agentmem/.sync-state.json
 */
record SyncState(
    String lastKnownChecksum,
    Map<String, String> serverChecksums,   // file → "sha256:<hex>"
    int serverMaxEntries
) {}

Map<String, String> computeDelta(SyncState state, Path memDir) throws IOException {
    var delta = new HashMap<String, String>();
    try (var files = Files.walk(memDir, 1)) {
        files.filter(Files::isRegularFile)
             .filter(f -> f.toString().endsWith(".md"))
             .filter(f -> !f.getFileName().toString().equals("MEMORY.md"))
             .forEach(f -> {
                 try {
                     var content = Files.readString(f);
                     var hash = "sha256:" + sha256(content);
                     var relPath = memDir.relativize(f).toString();
                     if (!hash.equals(state.serverChecksums().get(relPath))) {
                         delta.put(relPath, content);
                     }
                 } catch (IOException ignored) { /* skip unreadable files */ }
             });
    }
    return delta;
}
```

---

## 11. Plugin Entry & Autonomous Trigger

OpenCode plugins are TypeScript. The plugin layer shells out to compiled Java core
classes for file operations. For autonomous subagent execution, the plugin uses
`opencode run --agent <agent-name>` for multi-turn agents with configured step limits.

```typescript
// opencode-plugin/memory-keeper-trigger.ts
import type { Plugin } from "@opencode-ai/plugin"
import { $ } from "bun"

export const MemoryKeeperTrigger: Plugin = async () => {
  return {
    "session.idle": async (input, output) => {
      // Mutual exclusion: did main agent write to memory this turn?
      if (await mainAgentWroteThisTurn()) return

      // Fire memory-keeper subagent via opencode run
      const proc = Bun.spawn([
        "opencode", "run",
        "--agent", "memory-keeper",
        "--model", process.env.OPENCODE_MEMORY_MODEL ?? "auto",
        "Extract non-derivable learnings from the most recent conversation and persist them to .agentmem/."
      ], { stdout: "pipe", stderr: "pipe" })

      const timeout = setTimeout(() => proc.kill(), 120_000) // 2 min timeout
      const output = await new Response(proc.stdout).text()
      clearTimeout(timeout)
    },
  }
}
```

```typescript
// opencode-plugin/dreamer-trigger.ts
import type { Plugin } from "@opencode-ai/plugin"
import { $ } from "bun"

export const DreamerTrigger: Plugin = async () => {
  return {
    "session.idle": async (input, output) => {
      // Time gate + session gate + lock (delegated to ConsolidationLock.java)
      const result = await $`java ConsolidationLock.java check ${memDir}`.text()
      if (result.trim() !== "ACQUIRED") return

      const proc = Bun.spawn([
        "opencode", "run",
        "--agent", "memory-dreamer",
        "--model", process.env.OPENCODE_MEMORY_MODEL ?? "auto",
        buildConsolidationPrompt()
      ], { stdout: "pipe", stderr: "pipe" })

      const timeout = setTimeout(() => proc.kill(), 300_000) // 5 min timeout
      const output = await new Response(proc.stdout).text()
      clearTimeout(timeout)
    },
  }
}
```

The memory-keeper and dreamer are configured as OpenCode agents with `steps` limits:

```markdown
# .opencode/agents/memory-keeper.md
---
description: Out-of-band memory curator. Extracts non-derivable learnings from conversation.
mode: subagent
steps: 5
permission:
  edit: allow
  bash: allow
---
[Full extraction prompt from §9.2]
```

```markdown
# .opencode/agents/memory-dreamer.md
---
description: Nightly memory consolidation. Merges, deduplicates, prunes, links.
mode: subagent
steps: 10
permission:
  edit: allow
  bash: allow
---
[Full consolidation prompt from §9.3]
```

**Why `opencode run --agent` over `ProcessBuilder` spawning core Java:**
- Subagent needs multi-turn tool use (read topic files → write updates) — `core/` Java is for stateless file operations, not LLM-driven workflows
- `steps: 5` / `steps: 10` enforces the turn budget natively
- The agent inherits project CWD → `.agentmem/` is automatically accessible
- The agent has its own context window → no competition with the build agent

**Timeouts and orphan handling:**
```typescript
const proc = Bun.spawn(["opencode", "run", "--agent", "memory-keeper", ...opts], {
  stdout: "pipe",
  stderr: "pipe",
})
const timeout = setTimeout(() => { proc.kill() }, 120_000) // 2 min timeout
const output = await new Response(proc.stdout).text()
clearTimeout(timeout)
if (output.includes("Nothing new to save")) { /* quiet exit */ }
```

---

## 12. Novel Improvements (Beyond All Surveyed Systems)

### 12.1 Confidence scoring
| Grade | When | Behavior |
|-------|------|----------|
| `high` | User stated explicitly, confirmed twice | Applied aggressively; stale at 60d |
| `medium` (default) | User stated once, or clear pattern | Normal; stale at 14d |
| `low` | Single observation, inferred | Hedge language; stale at 7d |
| `speculative` | Agent hypothesizes | Never applied; surfaced as "I suspect X — confirm?" |

### 12.2 Access frequency tracking
Frontmatter: `reads: <count>`, `last_read: <ISO>`. Read frequently → top of MEMORY.md.
Never read in 90d → demote to `.cold/`. Cold files still findable via grep + entity index.

### 12.3 Expectation gap subtypes
`failure`, `serendipity`, `anomaly` — document the gap between expectation and reality.
The most information-dense moments in a codebase's history.

### 12.4 Version history
`.agentmem/.history/` snapshots every topic file change. Pruned after 90 days.
Full auditability. Negligible disk cost.

### 12.5 Weekly review loop
Dreamer generates: "I wrote/updated N memories this week. Keep / Remove X / X is wrong."
Injected as system message. User can ignore, respond, or `/skip-review`.

### 12.6 Type-specific decay curves
`failure` and `anomaly` near-permanent; `project` decays fastest. Confidence modulates staleness.

### 12.7 Bootstrap from git history
`/init-memory` scans commits for patterns: repeated fixes, reverted refactors, config breaks.
Seeds initial `project` memories.

### 12.8 Digest synthesis
Dreamer writes `digest_<topic>.md` when >10 files reference the same entity cluster.
Unified picture promoted to top of MEMORY.md.

### 12.9 Question memories
Record what we DON'T know. `status: open`. Dreamer resolves and converts when answers found.

### 12.10 Cross-project federation
`SHARED.md` index for org-wide knowledge. Managed by sync server. Read-only for local agents.
**Privacy:** `user` type memories never synced. `feedback` defaults to local-only unless
`scope: team`. `project` and `reference` default team-sync-eligible. Topic files carry
`sync: never | team` frontmatter, overridable per file.

### 12.11 Memory guardrails
`guard: true` + `guard_trigger: "glob"` on feedback memories. Tool pre-execution hook
surfaces warnings: "Memory says never mock the DB. Proceed?"

### 12.12 Write-ahead log (atomic writes)
Temp → fsync → rename for every file write. Never corrupt on crash.

### 12.13 Structural quality gates (write-time validation)

Before any memory is committed, `SaveMemoryTool.java` validates against a schema.
A failing gate returns REJECTED with a specific error — the agent must fix and retry.

**Gate 1 — Frontmatter completeness**
```
Required fields present: name, description, type, who, context, confidence.
Project/feedback subtypes: What, Why, How-to-apply sections in body.
Missing → REJECTED: "feedback_testing.md is missing required field: context"
```

**Gate 2 — Content size bounds**
```
- Hook line: ≤150 characters
- Topic file body: ≤250KB
- MEMORY.md index: ≤200 lines (pre-write check)
Exceeded → REJECTED with specific limit
```

**Gate 3 — Exclusion list scanner**
```
Body must not contain:
- File paths not in backtick/entity context (derivable code patterns)
- Git commit hashes not in git_refs section (git log is authoritative)
- Debugging recipes without Why/Context (the fix is in the code)
Matches → REJECTED: "Body appears to contain code patterns (src/auth/handler.ts:42).
  Code structure is derivable — save only non-obvious decisions or rationale."
```

**Gate 4 — Type consistency**
```
type: user → must have who: Human (user memories are always about a human)
type: feedback → must have who + Context (who gave the feedback, in what situation)
type: project → subtype must be a valid ProjectSubtype or absent
type: reference → must contain a URL or system path
Violation → REJECTED with type-specific guidance
```

**Gate 5 — Duplicate detection**
```
Before writing, scan existing topic files for:
- Same name (exact match → REJECTED: "file exists, use contradicts: to supersede")
- Same description (>80% similarity → WARNING: "near-duplicate of X.md — are you sure?")
- Same entity cluster (>3 entity overlaps → INFO: "shares entities with X, Y, Z — consider updating those instead")
WARNING gates → agent can override; REJECTED gates → must fix
```

**Gate 6 — Index hook quality**
```
MEMORY.md hook lines must:
- Be ≤150 characters
- Contain a verb or decision word ("must", "don't", "use", "prefer", "avoid", "always")
- Not contain code snippets or file paths (those go in the body)
- Be unique (no existing hook line with same content)
Violation → REJECTED with fix suggestion
```

**Gate 7 — Drift check on update**
```
When updating an existing file:
- Read old content → compare entities
- If old version referenced files/functions that the new version doesn't:
  WARNING: "Removing references to src/old_auth.ts — is this intentional deprecation,
    or should this be a new memory with contradicts:?"
- If old Who was Human and new Who is Agent (autonomous):
  REJECTED: "Cannot downgrade provenance from Human to Agent."
  (Human → Agent(user-requested) → Agent(autonomous) is a strict downgrade chain)
- If old Who was Agent(autonomous) and new Who is Human:
  ALLOWED (upgrade — human correction overrides agent judgment)
```

**Gate implementation:**

```java
// core/QualityGate.java
sealed interface GateResult permits Passed, Warning, Rejected {}
record Passed() implements GateResult {}
record Warning(String message, Set<String> affectedFiles) implements GateResult {}
record Rejected(String rule, String message) implements GateResult {}

class QualityGateRunner {
    private final List<QualityGate> gates = List.of(
        new FrontmatterGate(),
        new SizeBoundsGate(),
        new ExclusionListGate(),
        new TypeConsistencyGate(),
        new DuplicateDetector(),
        new HookQualityGate(),
        new DriftCheckGate()
    );

    List<GateResult> validate(Entry entry, Path memDir) {
        return gates.stream()
            .map(g -> g.check(entry, memDir))
            .toList();
    }
}
```

### 12.14 Memory store correctness tests

The `core/` library carries its own test suite — structural, not semantic. These can
run in CI without an LLM.

```java
// core/tests/MemoryStoreTest.java
void testAtomicWriteSurvivesCrash() {
    // Write topic file → kill process mid-write → .tmp/ has partial file
    // Memory dir has no orphaned .md files, MEMORY.md has no dangling pointer
}

void testIndexSizeEnforcement() {
    // Write 201 entries → 201st returns REJECTED
}

void testEntityIndexRebuildsCorrectly() {
    // Write 3 topic files with overlapping entities
    // Dreamer rebuilds .entities.json → every entity maps to correct files
}

void testConsolidationLockPreventsConcurrentDreams() {
    // Two processes try to acquire → only one succeeds
}

void testHistorySnapshotsOnEveryWrite() {
    // Write 5 updates to same file → .history/ has 5 timestamped snapshots
}

void testDecayCurvesAppliedCorrectly() {
    // Project memory at 15 days with 0 reads → flagged stale
    // Failure memory at 200 days with 0 reads → not flagged
}

void testConfidenceUpgradedByIndependentConfirmation() {
    // speculative memory + later session confirms → dreamer promotes to medium
}

void testDanglingPointersDetected() {
    // MEMORY.md references file.md, file.md doesn't exist → dreamer detects orphan
}

void testGuardrailMatchesFilePattern() {
    // guard_trigger: "*.test.ts" → file src/db/migration.test.ts → match
    // guard_trigger: "*.test.ts" → file src/db/migration.ts → no match
}

void testDuplicateDetection() {
    // New entry same name as existing → REJECTED
    // New entry 85% similar description → WARNING with near-duplicate filename
    // New entry with 4/5 same entities → INFO with suggested updates
}

void testExclusionListCatchesCodePatterns() {
    // Body contains "function handleAuth(req: Request)" → REJECTED (code pattern)
    // Body contains "we decided auth should use middleware pattern" → PASS
}

void testTypeConsistencyEnforced() {
    // type: user, who: Agent → REJECTED
    // type: feedback, no Context → REJECTED
    // type: reference, no URL → REJECTED
}
```

### 12.15 Adversarial memory evaluation (optional, CI-gated)

For teams that want programmatic quality assurance, an `eval/` directory with
golden datasets:

```
eval/
├── scenarios/
│   ├── simple_correction.txt     "Use pnpm, not npm"
│   ├── compliance_decision.txt   "Auth rewrite is for SOC2, not tech debt"
│   └── anomaly_deploy.txt        "3-line CSS change caused full outage"
├── expected/
│   ├── simple_correction.md      Golden: expected topic file output
│   ├── compliance_decision.md    "
│   └── anomaly_deploy.md         "
└── EvalRunner.java               Scenario → memory-keeper → compare vs golden
```

```java
// EvalRunner.java — runs in CI, requires LLM access
void testExtractionQuality() {
    var scenarios = loadScenarios("eval/scenarios/");
    for (var scenario : scenarios) {
        var extracted = runMemoryKeeper(scenario.conversation());
        var golden = Files.readString(scenario.goldenFile());
        var score = compareStructural(extracted, golden);
        // Score on: type correctness, subtype correctness, provenance present,
        // Why/How-to-apply sections present, confidence appropriate
        assert score.typeMatch() >= 0.95;
        assert score.provenancePresent() == 1.0;
        assert score.structuralCompleteness() >= 0.80;
    }
}
```

Not semantic correctness (that's the weekly review loop's job), but structural
quality: did the agent produce a well-formed memory given a known-good scenario?

### 12.16 Memory health dashboard (dreamer output)

The dreamer produces a `HEALTH.md` file alongside MEMORY.md:

```markdown
# Memory Health — 2026-07-25

## Statistics
- Topic files: 1,247
- MEMORY.md entries: 187 (93.5% capacity)
- Cold storage: 89 files
- Questions open: 12
- Weekly review pending: yes (5 new/changed since last review)

## Quality metrics
- High confidence: 312 (25%)
- Medium: 721 (58%)
- Low: 156 (12%)
- Speculative: 58 (5%)

## Decay status
- Stale project memories: 14 (flagged, not yet pruned)
- Unread in 90d: 23 (demoted to .cold/)
- Contradictions unresolved: 3 (two memories disagree, no resolution written)

## Structural issues
- 2 topic files missing required frontmatter fields
- 1 MEMORY.md pointer references non-existent file (orphan)
- 4 hook lines exceed 150 characters (demoted but not shortened)

## Attention needed
1. Resolve contradictions: feedback_use_prettier.md vs feedback_use_biome.md
2. Answer unresolved questions: 3 at status:open >60 days
3. Review speculative memories: 58 may be ready for promotion
```

This gives operators and the agent itself a single point of truth about memory quality.

### 12.17 Recall precision tracking

Frontmatter: `recalled_for: <count>`, `applied_successfully: <count>`, `applied_incorrectly: <count>`.

- When the agent reads a topic file and uses it → bump `recalled_for`
- When the user confirms the memory was helpful → bump `applied_successfully`
- When the user says "that memory is wrong/stale" → bump `applied_incorrectly`

The dreamer uses this to compute a usefulness score:
```
score = applied_successfully / (recalled_for + 1)
```
- Memories with score < 0.3 → candidate for demotion or verification
- Memories with score > 0.9 → candidate for confidence upgrade


### 12.18 Memory impact tracking (what changed because of this memory?)

Extension of provenance: the dreamer cross-references memories with git history.
When a memory says "don't mock the database" and git shows a commit 2 weeks later
adding real-DB tests, the dreamer links them:

```markdown
**Impact:** This memory led to 3 commits (see git_refs). Tests that previously
used mocks were converted to real-DB in PRs #342, #356, #389. No mock-based
regressions in the 6 months since.
```

This closes the loop: memory → action → verified outcome.

### 12.19 Memory conflict resolution protocol

When two memories disagree (detected by the dreamer during entity cross-referencing):

```
1. Dreamer flags both with a CONFLICT entry in HEALTH.md
2. Both memories get a "contradicted_by: <other-file>" frontmatter field
3. Dreamer reads the git_refs from both → presents timeline
4. If one has a higher version + more recent modified → that's the tentative winner
5. If confidence differs → higher confidence wins
6. Weekly review surfaces the conflict: "These two memories disagree. Which is right?"
7. User resolves → dreamer writes a resolution memory with contradicts: links to both
```

### 12.20 Memory migration framework

As the memory schema evolves (new frontmatter fields, renamed types, format changes),
`Migration.java` handles upgrades:

```java
sealed interface Migration permits AddField, RenameType, ChangeFormat, SplitType {}
record AddField(String field, Supplier<String> defaultValue) implements Migration {}
record RenameType(String oldType, String newType) implements Migration {}

class MigrationRunner {
    // Applied on session start. Each migration has a version number.
    // Applied idempotently — skips files already at target version.
    void migrate(Path memDir, int fromVersion, int toVersion);
}
```

This prevents the classic "old memories break when we change the schema" problem.

### 12.21 Fuzzy timestamp hardening

Relative dates are a known failure mode — "last week" becomes meaningless.
The save-memory tool hardens timestamps at write time:

```
Agent writes: "We decided this last Thursday"
Tool detects "last Thursday" → queries system clock → replaces with "2026-07-23 (Thursday)"
Agent writes: "The incident happened yesterday"
Tool detects "yesterday" → replaces with "2026-07-24"
Agent writes: "We'll refactor this next sprint"
Tool detects "next sprint" → flags WARNING: "Relative future date — add absolute date when known"
```

Dates are normalized to ISO 8601 in the body and `modified` frontmatter.

### 12.22 Memory peer review (team sync mode)

In federated mode, when a team member writes a memory on Machine A and it syncs
to Machine B, the memory appears in B's MEMORY.md with `peer_review: pending`.
The B user can `/approve-memory` or `/dispute-memory`. This is cross-machine
quality control — memories that survive peer review on ≥2 machines get
`confidence: high` automatically.

### 12.23 Anomaly-triggered recall

When the agent encounters an error or unexpected behavior, the entity index can
match against anomaly memories. If a build fails with a specific error message
that matches an entity in `.entities.json`, the memory surfaces proactively:

```
Build failure: "Cannot find module 'left-pad'"
Entity index match: "left-pad" → anomaly_css_deploy_outage.md
Agent reads memory → "This looks like the yanked-dependency pattern from incident #1351.
  Check if a transitive dep was yanked from the registry."
```

This is guardrails inverted — not "before you do X, remember Y" but "X just
happened, here's a memory about X."

### 12.24 Memory-to-code traceability

Every memory with `git_refs` is a bidirectional link. The dreamer can also
annotate code with memory references:

```
// src/auth/middleware.ts
// MEMORY: project_auth.md — Auth middleware rewritten for SOC2 compliance (2026-Q1).
// MEMORY: feedback_no_session_cache.md — Don't re-introduce token caching.
// Last verified: 2026-07-25 (dreamer read code, memory still accurate)
```

This is a `src/.memory-annotations/` directory of pointer files — the dreamer
writes them during consolidation, the agent reads them when opening a file that
has associated memories. The code itself is never modified.

### 12.25 Path-scoped memory (hierarchical `MEMORY.md` files)

A `MEMORY.md` file in any subfolder acts like a scoped `AGENTS.md` — its index
is loaded only when the agent works with files in that directory. Root memory
directory is always loaded (project-wide). Same file name everywhere — the
plugin distinguishes root from scoped by path, not by name.

```
project/                                Working in src/frontend/ → sees:
├── .agentmem/                          # Root directory (default path)
│   ├── MEMORY.md                       # Root index            ✓ loaded
│   └── feedback_testing.md             # Topic file            ✓ available
├── src/
│   ├── auth/
│   │   └── MEMORY.md                   # Auth-scoped           ✗ NOT loaded (wrong subtree)
│   └── frontend/
│       ├── MEMORY.md                   # Frontend-scoped       ✓ loaded (current subtree)
│       └── components/
│           └── MEMORY.md               # Components-scoped     ✓ loaded (child of current)
```
├── .agentmem/                     # root directory (topic files + tooling)
│   ├── MEMORY.md                  # root index               ✓ loaded (project-wide)
│   └── ...
├── src/
│   ├── auth/
│   │   └── MEMORY.md               # auth-scoped              ✗ NOT loaded (wrong subtree)
│   └── frontend/
│       ├── MEMORY.md               # frontend-scoped          ✓ loaded (current subtree)
│       └── components/
│           └── MEMORY.md           # components-scoped        ✓ loaded (child of current)
```

**Loading rules:**
- Root `MEMORY.md` — always loaded at session start
- `$CWD/MEMORY.md` — loaded when CWD is that directory or a subdirectory
- Parent `MEMORY.md` files of the current CWD are NOT loaded (cascade inward only)
- Same 200-line / 25KB limit as root

**Retrieval precedence:**
```
Per-task retrieval:
  1. Check $CWD/MEMORY.md hooks (most specific)
  2. Check parent MEMORY.md hooks up to project root (cascade outward)
  3. Check root MEMORY.md hooks (project-wide)
  4. Read matched topic files from root directory
```

**Dreamer scoping:**
- Root dreamer handles project-wide consolidation (`.agentmem/`)
- Scoped MEMORY.md files are consolidated by the root dreamer — no independent dream passes
- Scoped MEMORY.md indexes are NOT merged into root — they stay independent

**Why this matters:**
Without scoping, at 10,000 memories, the agent sees 200 index lines — most irrelevant.
With scoping, the agent sees ~20 index lines (root) + ~10 (current subtree) = 30 relevant entries.
The retrieval precision improvement is 10× at scale.

**Implementation:**

```java
// core/ScopedMemoryLoader.java
record ScopedMemoryContext(
    Path rootMemDir,           // .agentmem/
    List<Path> scopedMemDirs   // $CWD/.agentmem/, $CWD/../.agentmem/, ... → cascade outward
) {}

ScopedMemoryContext loadScopedContext(Path cwd, Path projectRoot) {
    var scoped = new ArrayList<Path>();
    var current = cwd;
    while (current.startsWith(projectRoot) && !current.equals(projectRoot)) {
        var memFile = current.resolve("MEMORY.md");
        if (Files.exists(memFile)) scoped.add(memFile);
        current = current.getParent();
    }
    return new ScopedMemoryContext(
        projectRoot,
        scoped
    );
}
```

### 12.26 Memory change impact tracking
When a memory leads to a code change, the dreamer cross-references git history to
close the loop: memory → action → verified outcome. Frontmatter: `impact_commits: [hash, ...]`,
`impact_verified: true/false`. The dreamer adds these during consolidation by correlating
memory entity references with commit diffs.

### 12.27 Memory-to-documentation sync

If a memory contradicts AGENTS.md, flag it. If AGENTS.md gets updated to include
a rule previously only in memory, the dreamer detects the now-redundant memory and
suggests demoting the MEMORY.md pointer (file stays in `.cold/`). Prevents memory
drift from project documentation.

### 12.28 Context budget allocation

The dreamer computes a per-turn budget: "You have 15K tokens for memory this turn.
MEMORY.md takes 5K. Top 3 topic files by entity match: [X, Y, Z]." Prevents the agent
from reading 20 files and blowing context. The budget is a nudge in MEMORY.md itself.

### 12.29 Memory chain / narrative reconstruction

Related memories form chains. "Incident → investigation → root cause → fix →
postmortem → new policy → policy contradicted → new policy." The dreamer reconstructs
these chains during consolidation and presents them as a timeline in digests.

### 12.30 Silence as signal

If the user NEVER corrects a type of memory → the agent's model for that type is
accurate. If the user corrects 40% of project-type memories → the agent is guessing
too much. The dreamer adjusts extraction behavior: extract less aggressively on
types with high correction rates.

### 12.31 Freshness-weighted entity ranking

`.entities.json` entries carry a `last_updated` field. Memories about `src/auth/`
from yesterday rank above ones from 2022. The dreamer adds this during rebuild.

### 12.32 Pre-session memory priming

At session start, a "situation brief" based on recent git activity: "You're resuming
work on the auth module. Here's what you need to know: [top 3 memories]." Opt-in via
`/brief` or auto-injected if working directory changed since last session.

### 12.33 Tone / urgency tagging

`tone` frontmatter: `urgent | frustrated | matter-of-fact | celebratory`.
A frustrated feedback memory means "don't just apply this — acknowledge the pain."
Helps the agent modulate its response.

### 12.34 Memory expiration with sunset review

`expires: 2026-03-05` frontmatter. After that date, dreamer flags: "Expired. Remove?"
Not auto-deletion — explicit acknowledgement required. For deadlines, sprint
boundaries, temporary workarounds.

### 12.35 Language / domain scoping

Entity index already captures file extensions (`.go`, `.tsx`). The dreamer adds
`language: go | typescript | python | ...` to topic file frontmatter during
consolidation. The agent prompt instructs: "when editing a `.go` file, prefer
topic files with matching language tags." No code needed — the agent applies
the filter when reading topic files.

### 12.36 Graph-based entity linking (Mem0)

`.entities.json` maps entities to topic files — flat. The dreamer builds entity-to-entity
edges during consolidation: if `pgBouncer` and `prepared statements` appear in the same
file, they're linked. The link persists as `.entities-graph.json`:

```json
{
  "pgBouncer": {
    "files": ["failure_connection_pool.md"],
    "related_to": {"prepared statements": 2, "connection pooling": 1, "auth middleware": 1}
  },
  "prepared statements": {
    "files": ["failure_connection_pool.md", "project_auth.md"],
    "related_to": {"pgBouncer": 2, "ORM": 1}
  }
}
```

When the agent searches for "pgBouncer," the retrieval pipeline expands to "prepared
statements" and "connection pooling" via 1-hop graph traversal. This turns keyword
matching into semantic approximation without embeddings.

### 12.37 Temporal-weighted retrieval (EM-LLM)

When multiple topic files match a query, sort by `modified` timestamp — recent
matches rank above old ones. The retrieval pipeline applies a simple decay weight:

```
score = entity_match_score * (1.0 / (1 + days_since_modified))
```

A memory about `src/auth/` from yesterday gets full weight. One from 200 days ago
gets 1/201 ≈ negligible weight. This is zero-cost temporal reasoning — no LLM
needed, no additional index, just a sort key that already exists in frontmatter.

### 12.38 Event segmentation / episodic grouping (EM-LLM)

The dreamer groups topic files into "episodes" — clusters of memories sharing
entities and close timestamps. An episode is a digest-like file that reconstructs
a narrative:

```
# .agentmem/digests/episode_incident_1247.md
---
name: episode_incident_1247
description: Full narrative: CSS deploy outage, investigation, root cause, postmortem
type: project
subtype: episode
sources: anomaly_css_deploy_outage.md, feedback_pin_deps.md, project_canary_deploy.md
timeline_start: 2026-07-15
timeline_end: 2026-07-22
---

## Episode: The 3-Line CSS Outage — Incident #1351

**Trigger:** 3-line CSS change → full service outage (2026-07-15)

**What happened:**
1. Deploy ran `npm ci` — clean install pulled a yanked transitive dependency
2. Build failed → deploy aborted mid-rollout → half pods on broken asset pipeline
3. 4 minutes of 500 errors across all endpoints

**What we learned:**
- "Trivial change" ≠ "no dependency changes" — `npm ci` runs every deploy
- Mid-rollout abort leaves service broken — need atomic roll-forward
- Pin all transitive dependencies

**What changed:**
- Added canary deploy step (2026-07-18, PR #356)
- Pinned all transitive dependencies (2026-07-20, PR #342)
- Added alert on `npm ci` failures (2026-07-22, PR #389)

**Resolution:** No mock-based regressions in 6 months since.
```

The dreamer detects episodes by clustering topic files that share ≥3 entities or
have `modified` timestamps within 7 days of each other. Episodes are promoted to
the top of MEMORY.md as landing pages for incident retrospectives, feature arcs,
or sprint summaries.

---

## 13. Model Quality Mitigation (No Gate — Progressive Distrust)

DeepSeek v4 Pro and other models below a certain quality threshold produce
lower-quality memories: wrong types, missing provenance, hallucinated facts,
overly verbose entries. These bad memories compound — future sessions read them,
apply wrong guidance, produce worse output, which generates more bad memories.

**Rejected approach: hard gate on model quality.** Would make the feature
unusable for most users.

**Chosen approach: the system knows what model it's running on and adjusts
trust progressively.** Low-quality model → memories are saved at lower confidence,
applied with stronger caveats, and flagged for faster review. If corrections
compound, the system applies memory distrust — similar to how a human reviewer
learns which sources to trust.

### 13.1 Model capability tiers

| Tier | Examples | Default confidence | Agent behavior | Dreamer treatment |
|------|----------|-------------------|----------------|-------------------|
| `S` (frontier) | Opus 4.5, Sonnet 4.x, GPT-5 | `medium` | Apply normally | Normal decay |
| `A` (strong) | Sonnet, GPT-4o, Gemini 2.5 Pro | `low` | Apply with hedge language | Faster staleness (7d) |
| `B` (capable) | Haiku, GPT-4o-mini, DeepSeek v4 Pro | `low` | Apply with explicit caveat | Faster staleness (7d) |
| `C` (light) | DeepSeek v3, local models | `speculative` | Never applied to decisions | Demoted on first correction |
| `Unknown` | No capability data | `low` | Conservative | Treat as tier B |

The tier is stored in frontmatter: `model_tier: B`, `model: deepseek/deepseek-v4-pro`.

### 13.2 Progressive distrust protocol

The system tracks correction rate per model tier. If a tier produces memories
that are consistently corrected or contradicted, the system escalates distrust.
**Minimum sample: 20 memories** before computing trust — avoids false positives
from small-sample noise.

```
Tier B (DeepSeek v4 Pro) writes 100 memories
  → 10 are corrected by user within 30 days (10% correction rate)
  → Threshold: >5% → flag tier as "suspicious" (100 ≥ 20, rate valid)
  → New memories from this tier auto-downgrade to speculative
  → Existing speculative memories from this tier get faster staleness (3d)
  → Weekly review surfaces: "10% of tier B memories were corrected. Review tier."
```

The correction rate is computed per model, not per user — it persists across
sessions in `.agentmem/.model-trust.json`:

```json
{
  "deepseek/deepseek-v4-pro": {
    "tier": "B",
    "memories_written": 342,
    "memories_corrected": 47,
    "correction_rate": 0.137,
    "distrust_level": "suspicious",
    "downgraded_at": "2026-07-20T14:30:00Z"
  },
  "anthropic/claude-sonnet-4-20250514": {
    "tier": "A",
    "memories_written": 891,
    "memories_corrected": 12,
    "correction_rate": 0.013,
    "distrust_level": "trusted"
  }
}
```

### 13.3 What changes for a distrusted model

| Aspect | Trusted model | Distrusted model |
|--------|--------------|------------------|
| Default confidence | `medium` | `speculative` |
| Agent applies memory? | Yes, with normal caveats | "A memory from a distrusted model suggests X — verify before acting" |
| Dreamer promotes confidence? | Yes, if independently confirmed | Yes, but requires 2 independent confirmations (not just 1) |
| Weekly review | Standard | Flagged: "12 new memories from a distrusted model — review all" |
| Guardrail enforcement | Normal | Guardrails still enforced (structural rules apply regardless of trust) |
| Digest inclusion | Yes | Only if confidence upgraded to medium+ |
| Entity index entry | Yes | Yes (structural correctness, not semantic) |

### 13.4 Recovery path

A distrusted model can earn trust back:

```
Tier B flagged as "suspicious" (13.7% correction rate)
  → User manually reviews 50 memories → marks 45 as "confirmed"
  → Correction rate recalculated: 47 corrections / (342 + 50 reviewed) = varies
  → If new rate < 5% over 100 new memories → flag removed
  → Tier returns to "trusted" with notes: "Reviewed 2026-07-25, 45/50 confirmed"
```

### 13.5 Context rot prevention (no hard gate)

Context rot occurs when low-quality memories accumulate faster than the dreamer
can prune them. Prevention:

```
Structural guards (always active, regardless of model tier):
  - Hook line ≤150 chars → enforced at write time
  - MEMORY.md ≤200 lines → BLOCKED at write time
  - Topic file ≤250KB → BLOCKED at write time

Semantic guards (tier-aware):
  - Tier A+: normal pruning (type-specific decay curves)
  - Tier B: dreamer removes pointers to speculative memories after 14d if unread
  - Tier C: dreamer removes pointers to ALL memories from this tier after 7d if unread
  - Distrusted models: memories never promoted to MEMORY.md top (always at bottom)

Budget guard (always active):
  - Dreamer computes total memory context tokens per session
  - If >8K tokens → surfaces warning: "Memory context is ~N tokens. Run /dream to prune?"
  - Agent prompted to run /dream to consolidate
```

The key insight: **context rot is a size problem, not a quality problem.**
Quality gates prevent bad memories from being created. Size gates prevent
any memories (good or bad) from bloating context. The two mechanisms compose:
quality → fewer bad entries; size → hard caps on good entries.

### 13.6 Implementation

```java
// core/types/ModelTier.java
enum ModelTier { S, A, B, C, UNKNOWN }

// core/types/TrustLevel.java
enum TrustLevel { TRUSTED, SUSPICIOUS, DISTRUSTED }

// core/ModelTrustTracker.java
record ModelTrust(
    String modelId,
    ModelTier tier,
    int memoriesWritten,
    int memoriesCorrected,
    double correctionRate,
    TrustLevel trustLevel,
    Instant downgradedAt
) {}

class ModelTrustTracker {
    private static final double SUSPICIOUS_THRESHOLD = 0.05;
    private static final double DISTRUSTED_THRESHOLD = 0.15;
    private static final int MIN_MEMORIES_FOR_TRUST = 20; // avoid small-sample false positives

    TrustLevel computeTrustLevel(int written, int corrected) {
        if (written < MIN_MEMORIES_FOR_TRUST) return TrustLevel.TRUSTED;
        var rate = (double) corrected / written;
        if (rate > DISTRUSTED_THRESHOLD) return TrustLevel.DISTRUSTED;
        if (rate > SUSPICIOUS_THRESHOLD) return TrustLevel.SUSPICIOUS;
        return TrustLevel.TRUSTED;
    }

    Confidence defaultConfidence(ModelTrust trust) {
        return switch (trust.trustLevel()) {
            case TRUSTED   -> switch (trust.tier()) {
                case S -> Confidence.MEDIUM;
                case A, B -> Confidence.LOW;
                case C, UNKNOWN -> Confidence.SPECULATIVE;
            };
            case SUSPICIOUS, DISTRUSTED -> Confidence.SPECULATIVE;
        };
    }

    int daysUntilStale(ModelTrust trust) {
        return switch (trust.trustLevel()) {
            case TRUSTED   -> switch (trust.tier()) {
                case S -> 14;
                case A, B -> 7;
                case C, UNKNOWN -> 3;
            };
            case SUSPICIOUS -> 3;
            case DISTRUSTED -> 1;
        };
    }
}
```

---

## 14. Session Lifecycle (with scoping)

```
SESSION START
  ├─ Root .agentmem/MEMORY.md injected (instructions)
  ├─ Scoped $CWD/.agentmem/MEMORY.md injected (cascades inward from CWD)
  ├─ Agent prompt injected (instructions)
  ├─ SHARED.md injected (if federation enabled)
  │
  ▼
TURN: user message / file opened
  ├─ Agent detects CWD → loads scoped context
  ├─ Scans root + scoped MEMORY.md hooks → grep dirs → entity indexes → read topic files
  ├─ Scoped matches take precedence over root matches
  ├─ Agent may call save-memory tool (writes to current scope by default)
  ├─ Guardrail check on tool.execute.before (guard memories: root + scoped)
  │
  ▼
TURN: assistant response (no tool calls)
  ├─ Agent may call save-memory tool
  │
  ▼
POST-TURN: plugin event handler
  ├─ Memory-keeper: mutual exclusion → spawn via opencode run --agent memory-keeper
  │   (extracts to current scope; root extractor runs at root level)
  ├─ Root dreamer: time gate (24h) → session gate (5) → lock → spawn
  ├─ Scoped dreamer: time gate (7d) → session gate (3) → lock → spawn
  │   (per .agentmem/ directory with independent lock files)
  │
  ▼
SESSION END
  ├─ MEMORY.md persists on disk (all scopes)
  ├─ Scoped memories survive independently of root
  └─ Moving a .agentmem/ directory = moving the memories with it
```

---

## 15. Files to Create

| File | Purpose | Change driver |
|------|---------|---------------|
| `.agentmem/MEMORY.md` | Index (starts empty) | — |
| `.agentmem/.entities.json` | Entity index (starts empty) | — |
| `.agentmem/.sync-state.json` | Team sync state (if enabled) | — |
| `MemoryStore.java` | Atomic topic file + MEMORY.md write/read/delete | Storage contract |
| `EntityIndex.java` | .entities.json regex extraction + lookup | Retrieval mechanism |
| `QualityGateRunner.java` | 7 structural quality gates | Validation rules |
| `MemoryLifecycle.java` | Confidence scoring + decay curves | Memory lifecycle model |
| `ConsolidationLock.java` | PID-based lock with boot-ID guard | Dream gating |
| `HistoryManager.java` | Version snapshots + orphan detection | Audit mechanism |
| `GuardrailEvaluator.java` | Match guard triggers against file paths + tool names | Guardrail rules |
| `ScopedMemoryLoader.java` | Hierarchical .agentmem/ resolution | Directory scoping |
| `DigestWriter.java` | Synthesize multi-file digests + episode narratives | Digest synthesis |
| `EntityGraph.java` | Entity-to-entity edges for graph-based retrieval | Entity graph |
| `ModelTrustTracker.java` | Model capability tiers + progressive distrust | Model quality model |
| `ReviewGenerator.java` | Weekly review summary from recent changes | Review format |
| `SyncClient.java` | Optional: team-memory sync (delta, ETag, batching) | Team sync protocol |
| `Bootstrap.java` | Git history scan → seed initial memories | Git analysis |
| `Migration.java` | Schema upgrades, format conversions | Schema migration |
| `PathValidator.java` | Path traversal + symlink defense | Security policy |
| `types/*.java` | MemoryType, ProjectSubtype, Entry, Confidence, ModelTier, TrustLevel | Shared vocabulary |
| `.opencode/tools/save-memory.ts` | TS shim → java MemoryStore.java save ... | — (platform requirement) |
| `.opencode/tools/forget-memory.ts` | TS shim → java MemoryStore.java delete ... | — (platform requirement) |
| `.opencode/tools/check-health.ts` | TS shim → java QualityGateRunner.java health ... | — (platform requirement) |
| `.opencode/tools/init-memory.ts` | TS shim → java Bootstrap.java ... | — (platform requirement) |
| `.opencode/agents/memory-keeper.md` | Out-of-band subagent (steps: 5) | Agent prompt |
| `.opencode/agents/memory-dreamer.md` | Second-order subagent (steps: 10) | Agent prompt |
| `prompts/agent-prompt.md` | System instructions for build agent | Agent prompt |

---

## 16. Sources

### Field survey (systems)
- `https://docs.mem0.ai/core-concepts/memory-types` — Mem0: four-tier hierarchy (conversation → session → user → org), validates our multi-scope model. User memory is long-term personal; org memory is shared long-lived. "Avoid storing secrets or unredacted PII."
- `https://blog.langchain.dev/launching-long-term-memory-support-in-langgraph/` — LangGraph: document store model, "no universally perfect solution", low-level > high-level
- `https://github.com/mem0ai/mem0` (README) — Mem0 v3: ADD-only, single-pass, agent-generated facts as first-class, entity linking, multi-signal retrieval, benchmarks (92.5 LoCoMo, 94.4 LongMemEval)
- `https://github.com/mem0ai/memory-benchmarks` — Evaluation suite: LOCOMO (300 questions, 4 categories), LongMemEval (500 questions, 6 types), BEAM (2,000+ questions, 10 memory ability types). Three-stage pipeline: Ingest → Search → Evaluate.
- `https://docs.cursor.com/context/rules` — Cursor: path-scoped rules
- `https://x.com/AnatoliKopadze/status/2080286550005358977` — AI DEVCON talk: "build a system that prompts itself", out-of-band memory curation

### Field survey (research papers)
- `arXiv:2504.19413` — Mem0 paper: ADD-only outperforms UPDATE/DELETE. Graph-based memory linking boosts retrieval. Multi-signal (semantic + BM25 + entity). Single-pass extraction. 91% lower p95 latency vs full-context, 90% token savings.
- `arXiv:2407.09450` (ICLR 2025) — EM-LLM: episodic memory with event segmentation via Bayesian surprise + graph boundary refinement. Two-stage retrieval (similarity + temporal). Outperforms RAG on most tasks. Event segmentation correlates with human-perceived events.
- `https://github.com/langchain-ai/memory-agent` — LangGraph memory agent: `store_memory` tool, per-user scoping via `user_id`, evaluation-first approach, memories structured as `content + context` JSON documents.

### OpenCode documentation
- `https://opencode.ai/docs/plugins/` — Plugin API, event hooks, custom tools
- `https://opencode.ai/docs/custom-tools/` — Tool definition, Zod schema, context
- `https://opencode.ai/docs/commands/` — Custom commands, `subtask: true`
- `https://opencode.ai/docs/agents/` — Primary/subagent modes, permissions
- `https://opencode.ai/docs/rules/` — `AGENTS.md`, `opencode.json` `instructions`
- `https://github.com/anomalyco/opencode` — Repository, agent types
