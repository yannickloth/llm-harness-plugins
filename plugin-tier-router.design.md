# Tier Router — Design Document

OpenCode plugin that intercepts user prompts, classifies reasoning complexity, reformulates with SOTA prompt engineering criteria, detects ambiguity, dispatches to the cheapest sufficient model tier, and enforces session-level budget limits. Shared Java 25 core with an OpenCode tools backend.

## Architecture

```
User Prompt
    │
    ▼
┌──────────────────────────────────────────────────────────────┐
│ Budget Circuit-Breaker (budget check)                       │
│  Pre-routing gate: checks cumulative session token spend.    │
│  If exhausted → inject EXHAUSTED directive, skip routing.    │
│  Ceiling: TIER_ROUTER_BUDGET_CEILING env (default 500K).     │
└──────────────────────────────────────────────────────────────┘
    │ (if budget OK)
    ▼
┌──────────────────────────────────────────────────────────────┐
│ Backend: OpenCode (tools)                                   │
│  → calls Java 25 RouterCli via stdin piping                  │
└──────────────────────────────────────────────────────────────┘
    │
    ▼
┌──────────────────────────────────────────────────────────────┐
│ RouterEngine — 10-step classification pipeline                   │
│  route() = classify only. routeWithRewrite() = classify + rewrite │
│  (1) ambiguity → DIRECT to sonnet with clarification Qs      │
│  (2) meta-routing → ESCALATE                                 │
│  (3) complexity signal → ESCALATE                            │
│  (4) bulk destructive → ESCALATE                             │
│  (5) file op, no path → ESCALATE                             │
│  (6) agent def edit → ESCALATE                               │
│  (7) multiple objectives → ESCALATE                          │
│  (8) creation/design → ESCALATE                              │
│  (9) keyword tier match → DIRECT (≥0.8) or sonnet verify     │
│ (10) no match → ESCALATE                                     │
│                                                              │
│  Internally: Classifier.java (escalation + keyword match)    │
│  Reformatter.java (ambiguity at step 1 and rewrite for step 9)│
│  Ambiguity runs INSIDE route(), before all escalation checks  │
└──────────────────────────────────────────────────────────────┘
    │
    ▼
┌──────────────────────────────────────────────────────────────┐
│ Post-classification: for DIRECT cases, Reformatter.rewrite() │
│ applies pre-dispatch edits + tier-specific directives.        │
│ ESCALATE and ambiguous cases pass through unmodified.        │
└──────────────────────────────────────────────────────────────┘
    │
    ▼
┌──────────────────────────────────────────────────────────────┐
│ Directive injected into LLM context                          │
│  Skill-axis fleet → Task tool with init→specialist model IDs │
│  DIRECT + tier   → Task tool spawns fable/haiku/sonnet/opus  │
│  ESCALATE        → Task tool spawns sonnet-general (router)  │
│  Ambiguous       → agent asks user clarification questions,   │
│                     re-processes after user replies            │
└──────────────────────────────────────────────────────────────┘
```

## File Structure

```
tier-router/
├── src/main/java/eu/infolead/llmhp/router/
│   ├── RouterCli.java         # CLI: classify, route, rewrite, ambiguity, budget-*
│   ├── RouterEngine.java      # 10-step classification pipeline
│   ├── Classifier.java        # 8 escalation triggers + keyword tier match
│   ├── Reformatter.java       # Prompt rewriting + ambiguity questions
│   ├── BudgetTracker.java     # Token accumulator, ceiling check, WAL-atomic save
│   ├── BudgetState.java       # record: sessionId, tokensUsed, ceiling, startTime, exhausted
│   ├── RoutingResult.java     # record: decision, tier, reason, confidence, prompt
│   ├── Decision.java          # DIRECT | ESCALATE
│   └── Tier.java              # FABLE | HAIKU | SONNET | OPUS + relativeCost()
├── agents/                     # Agent definition .md files
│   ├── fable-general.md       # Ultra-light: close brackets, add semicolons
│   ├── haiku-general.md       # Mechanical: typos, format, rename, sort
│   ├── sonnet-general.md      # Judgment: analyze, implement, refactor, review
│   └── opus-general.md        # Deep: proofs, formal verification, math
├── opencode/index.ts          # OpenCode: 3 tools
├── prompts/
│   ├── README.md              # Plugin documentation
│   └── budget-exhausted.md    # Agent behavior directive when budget exhausted
```

## Tier Agents

| Tier | Model | Relative Cost | Use When |
|------|-------|---------------|----------|
| fable-general | fable | 0.25x | Trivial: close brackets, add semicolons, append/prepend |
| haiku-general | haiku | 1x | Mechanical: fix typos, format code, rename, sort imports, lint |
| sonnet-general | sonnet | ~12x | Judgment: analyze, implement, refactor, review, coordinate |
| opus-general | opus | ~75x | Deep reasoning: prove theorems, formal verification, math |

Each agent defines responsibilities, safety protocols, and escalation rules. See `agents/*.md`.

## Model Resolution Priority

When the tier-router is active, agent-declared models may be overridden. The router selects the execution path; the active path determines which model is used.

```
Priority chain (first match wins):
1. Skill-axis fleet match → direct model IDs from skill-axis-mapping.json
   (no agent involved; tier-agent model ignored)
2. Tier keyword/LLC match  → tier agent (haiku-general etc.) → its model
3. ESCALATE                  → sonnet-general → its model
4. Router not active         → called agent → its own model
```

| Router output | Agent invoked | Model used | Source |
|---|---|---|---|
| Skill-axis `fleetModels=[init, specialist]` | *(none)* | `init` → `specialist` | `skill-axis-mapping.json` |
| `DIRECT` + `tier=FABLE` | `fable-general` | its declared model | agent `.md` → `opencode.json` |
| `DIRECT` + `tier=HAIKU` | `haiku-general` | its declared model | agent `.md` → `opencode.json` |
| `DIRECT` + `tier=SONNET` | `sonnet-general` | its declared model | agent `.md` → `opencode.json` |
| `DIRECT` + `tier=OPUS` | `opus-general` | its declared model | agent `.md` → `opencode.json` |
| `ESCALATE` | `sonnet-general` | its declared model | agent `.md` → `opencode.json` |
| No router active / direct call | (any agent) | its declared model | agent `.md` → `opencode.json` |

Tier-agent models are fallback/default paths. Fleet models in `skill-axis-mapping.json` are the preferred path when a skill axis triggers. Custom agents (e.g. `*-auditor`) are consulted only when the router is absent or inactive.

## Classification Pipeline (10 steps)

Stops at first match. Steps 1–8 escalate complex/risky/ambiguous requests; step 9 matches keywords; step 10 is the fallback escalate.

### Step 1: Ambiguity Detection

Catches vague prompts before execution. Matches: `fix the bug`, `update the config`, `make it better`, `optimize the database`, `improve the code`, `clean this up`, `refactor this`. Skips if file path or extension present.

Returns `Decision.DIRECT` with tier `SONNET` and confidence `0.3` — the low confidence signals to the directive generator that clarification is needed rather than normal execution.

Generates context-specific clarification questions for 7 patterns:
- "fix the bug" → "Which component? (login flow, auth, token refresh, permissions?)" + "What is the specific symptom or error?"
- "update the config" → "Which config file? (app.json, database.yml, nginx.conf?)" + "What change? (add field, modify value, remove setting?)"
- "make it better" → "Better in what way? (performance, UX, code quality, error handling?)"
- "optimize the database" → "What aspect? (query speed, storage size, indexes?)" + "Constraints? (can modify schema? add indexes?)"
- "improve the code" / "refactor this" → "What specific improvement? (performance, readability, architecture, test coverage?)"
- "clean this up" → "What to clean? (unused files, dead code, formatting, duplicate logic?)"
- Default: "Could you clarify the scope and specific goal?"

### Steps 2–8: Escalation Triggers

| # | Trigger | Keywords | Confidence |
|---|---------|----------|------------|
| 2 | Meta-routing | "which agent", "how should i route", "route this to", "delegate to", "what model", "which tier" | 0.9 |
| 3 | Complexity | "complex", "subtle", "nuanced", "judgment", "trade-off", "best approach", "design", "architecture", "should I", "which is better", "recommend", "decide", "strategy" | 1.0 |
| 4 | Bulk destructive | "delete"/"remove"/"drop" + "all"/"multiple"/"*"/"every" | 1.0 |
| 5 | File op, no path | "edit"/"modify"/"change"/"update"/"delete"/"remove" without explicit file path AND not followed by abstract noun ("modify the plan" → skip) | 0.9 |
| 6 | Agent def edit | ".opencode/agents" + edit/modify/change/update/delete/remove | 1.0 |
| 7 | Multiple objectives | ≥2 conjunctions: " and ", ", then ", " after ", " before ", ";" | 0.9 |
| 8 | Creation/design | "new"/"create"/"design"/"build"/"implement" — unless "new file <path>" | 0.85 |

### Step 9: Keyword Tier Match

Priority: Haiku → Opus → Sonnet → Fable.

| Tier | Keywords (regex) | Requires file path? |
|------|------------------|---------------------|
| Haiku | `fix\s+(typo\|spelling\|syntax)`, `format\s+(code\|file)`, `lint\s+`, `rename\s+\w+\s+\w*\s*to\s+\w+`, `add\s+(semicolon\|comma\|bracket\|import)`, `remove\s+(trailing\s+whitespace\|unused)`, `correct\s+(spelling\|typo)`, `sort\s+(imports\|lines)` | Yes |
| Opus | `prove`, `formalize`, `verify correctness`, `mathematical`, `theorem`, `algorithm design`, `proof` | No |
| Sonnet | `analyze`, `implement`, `refactor`, `integrate`, `review`, `optimize`, `debug`, `investigate` | No |
| Fable | `\b(add\|close)\s+(semicolon\|bracket\|paren\|brace)\b` (case-insensitive), `\b(append\|prepend)\b` | Yes |

Confidence formulas (per tier). Capped at tier-specific ceilings to avoid overconfidence from single-keyword matches:

```
fable: count(keywords) > 0 → 0.9, else 0.0
haiku: count(keywords) > 0 → min(0.9, 0.6 + count*0.1), else 0.5
sonnet: count(keywords) > 0 → min(0.95, 0.65 + count*0.1), else 0.0
opus: count(keywords) > 0 → min(0.95, 0.7 + count*0.1), else 0.0
```

Ceilings: haiku 0.9, sonnet 0.95, opus 0.95. Prevents single-keyword prompts from reaching 1.0 confidence. The sonnet base was raised to 0.65 (from the original routing_core.py's 0.5) so single-keyword matches clear the 0.7 medium-confidence threshold.

### Step 10: Fallback Escalate

No keyword match → escalate to sonnet-general for intelligent routing.

### Confidence → Action Matrix

| Confidence | Action |
|------------|--------|
| ≥ 0.8 | Direct route to matched tier agent |
| 0.7–0.8 | Route to sonnet-general for verification |
| < 0.7 | Escalate via step 10 (fallback — no tier matched with sufficient confidence) |

## Prompt Reformulation

Sourced from Anthropic's official prompt engineering documentation (clarity, context, specificity, XML structuring, conciseness directive, uncertainty permission, output format constraints).

### Reformulation Pipeline

Applied in order for all DIRECT-bound prompts:

1. **Pre-dispatch rewrites** (applied to ALL tiers): weak-opener stripping, AI-pattern cleaning
2. **Tier-specific suffixes** appended after the cleaned prompt

### Pre-Dispatch Rewrites

| Input Pattern | Rewrite |
|---------------|---------|
| "can you ..." / "could you ..." / "would you ..." | Strip opener, capitalize |
| "I want ..." / "I need ..." / "help me ..." | Strip opener, capitalize |
| "maybe ..." / "perhaps ..." / "possibly ..." | Strip opener, capitalize |
| "I'm trying to ..." / "I am trying to ..." | Strip opener, capitalize |
| "—" repeated 2+ times | `"; "` |
| " — " (single with whitespace) | `", "` |
| "the relationship:" | "Specifically," |
| "This is not X—it's Y" | "Rather than X, Y" |

### Tier-Specific Suffixes

| Tier | Appended Directives |
|------|---------------------|
| Fable | Conciseness |
| Haiku | Conciseness + Uncertainty permission |
| Sonnet | Conciseness + Output format |
| Opus | Conciseness + Output format + Uncertainty permission |

### Directives

```
CONCISENESS: "Be concise. Answer directly. Minimize output tokens.
  Do NOT use bold headers, bullet lists for exposition, excessive em-dashes,
  or dramatic section titles. Write in flowing prose. Respond only to what
  was asked — no preamble, no postamble."

OUTPUT: "REQUIRED OUTPUT: Return usable results — direct results OR file
  path OR action summary with specifics. Never complete silently."

UNCERTAINTY: "If uncertain or missing info, say so explicitly.
  Never invent facts or fabricate output."
```

## Prompt Annotation Hook

The `chat.message` hook annotates each user prompt with its routing classification, tier directives, and (optionally) fleet model. **Opt-in via env var** — off by default, so prompts pass through essentially untouched (only a trim + env check per message).

| Env var | Effect |
|---------|--------|
| (unset) | Hook is a no-op; prompt sent verbatim |
| `TIER_ROUTER_ANNOTATE=1` | Replace prompt with the annotation block (rewritten prompt + directives + classification). Single prompt — no doubling. |
| `TIER_ROUTER_ANNOTATE=1` + `TIER_ROUTER_LEAN=1` | Replace prompt with just the rewritten prompt + tier directives + fleet, no self-quote annotation block |

Annotation always **replaces** the message text (never appends), so the model sees one prompt, not a doubled one.

### Classification Cost Control

- **Prompt cache**: repeated/similar prompts are classified once (bounded LRU, 512 entries), keyed by content hash.
- **LLM skip**: prompts shorter than 40 chars or starting with an explicit mechanical verb (`fix`, `rename`, `add`, `sort`, …) bypass the spawned LLM classifier and go straight to the cheap Java keyword router.
- **Timeouts**: the LLM classifier is capped (~25s) and the Java router is capped (10s), so a hung child never blocks the chat hook.


## Backend

### OpenCode (tool-based)

`opencode/index.ts` registers 3 tools:
- `classify-prompt` — classify + rewrite a prompt string (calls `RouterCli route`, which includes rewriting)
- `rewrite-prompt` — rewrite for a specific tier without classification
- `check-ambiguity` — detect ambiguity, return clarification questions

All call Java `RouterCli` via Bun shell with stdin piping (no shell injection). The tools can be invoked manually for classification and rewriting.

## IVP Analysis

| Component | Change Driver | Artifact |
|-----------|--------------|----------|
| Classifier (escalation triggers + keywords) | Task complexity taxonomy | Model capability tiers + ai-patterns Routing pattern (ch23) |
| Reformatter | Prompt engineering best practices | Prompt engineering documentation |
| BudgetTracker + BudgetState | Token pricing + session cost policies | Vendor pricing pages, org cost policies |
| fable-general | Fable model capabilities | Model release notes |
| haiku-general | Haiku model capabilities | Model release notes |
| sonnet-general | Sonnet model capabilities | Model release notes |
| opus-general | Opus model capabilities | Model release notes |
| opencode/index.ts | OpenCode plugin SDK | @opencode-ai/plugin |

**IVP Compliance:** Changing model pricing never requires editing an agent definition. Changing model capabilities never requires editing routing rules. Changing budget policy never requires editing routing logic — only env var or session state files. Budget tracking varies independently from classification. The shared Java core varies with classification logic + budget tracking only.

## Reference Implementation

An earlier router implementation at `~/code/claude-router-system/` served as the initial reference. The tier-router improves on it by:
- Eliminating Python (Java 25 only)
- Adding SOTA prompt reformulation (not present in original)
- Adding ambiguity detection with clarification questions
- Tighter IVP boundaries (classifier/reformatter/backends separated)

## Budget Circuit-Breaker

Session-level token budget enforcement that prevents runaway agent spend. Composed of a circuit-breaker and a WAL-atomic Java backend.

### Mechanism

```
Pre-Routing budget check (runs before classification)
  → BudgetTracker.loadOrFresh(sessionId) → check isExhausted
  → exhausted: write .budget-exhausted signal file → routing skipped
  → ok: remove any existing signal file

Post-tool token accumulation (after each tool response)
  → parse token count from response usage JSON (usage.total_tokens)
  → BudgetTracker.accumulate(state, tokens) → save with WAL (temp → fsync → rename)
  → newly exhausted: write .budget-exhausted signal file
```

### Budget Configuration

| Setting | Env var | Default |
|---------|---------|---------|
| Token ceiling | `TIER_ROUTER_BUDGET_CEILING` | 500,000 tokens/session |

### Java Core

| Class | Responsibility |
|-------|---------------|
| `BudgetState` | Immutable record: `sessionId`, `tokensUsed`, `ceiling`, `startTime`, `exhausted` |
| `BudgetTracker` | Static methods: `loadOrFresh(sessionId)`, `accumulate(state, tokens)`, `isExhausted(state)`, `save(state)` with atomic write (tmp file → FileChannel.force → ATOMIC_MOVE) |

### CLI Subcommands (RouterCli)

| Command | Args | Output |
|---------|------|--------|
| `budget-check` | `<session-id> <metrics-dir>` | `{"status":"ok"\|"exhausted",...}`|
| `budget-accumulate` | `<session-id> <tokens> <metrics-dir>` | Status + `newlyExhausted` flag |
| `budget-reset` | `<session-id> <metrics-dir>` | Reset session to zero |

### Storage

State persisted as JSON files in `.tier-router/metrics/.sessions/<sessionId>.json`. WAL atomicity: write to `.sessions/.tmp/<sessionId>.<uuid>`, force flush, atomic rename to final path. (Same pattern as agentmem's `MemoryStore` and semantic-cache's `CacheStore`.)

### Signal File Protocol

When a session's budget is exhausted (cumulative token spend ≥ ceiling), a `.tier-router/metrics/.budget-exhausted` sentinel file is written. The routing layer checks for this file before every routing decision. If present, it injects a `<routing-recommendation decision=EXHAUSTED>` directive into the agent's context instead of routing normally. The directive instructs the agent to summarize, list remaining tasks, and advise a new session — all tool calls and subagent spawns are forbidden.

The post-tool accumulation also writes this file on first-time exhaustion (via the `newlyExhausted` flag from `budget-accumulate`).

## Costs

Classification runs locally (Java, zero-cost). No model is consumed for routing. Sub-millisecond latency.

Expected savings (estimate, not measured): ~55% with baseline routing if ~60% of tasks classify as mechanical (routed to Haiku instead of Sonnet). ~70% with probabilistic routing (Phase 2, not yet implemented).
