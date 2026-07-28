# Tier Router — Design Document

Cross-platform plugin that intercepts user prompts, classifies reasoning complexity, reformulates with SOTA prompt engineering criteria, detects ambiguity, and dispatches to the cheapest sufficient model tier. Shared Java 25 core with three backends: Claude Code (hooks), OpenCode (tools), Pi (tools).

## Architecture

```
User Prompt
    │
    ▼
┌──────────────────────────────────────────────────────────────┐
│ Backend: Claude Code (UserPromptSubmit) / OpenCode (tools)   │
│  Pi (tools)                                                   │
│  → calls Java 25 RouterCli via stdin piping                  │
└──────────────────────────────────────────────────────────────┘
    │
    ▼
┌──────────────────────────────────────────────────────────────┐
│ RouterEngine.java (10-step pipeline)                          │
│  (1) ambiguity → classify + ask user                         │
│  (2) meta-routing → escalate                                 │
│  (3) complexity signal → escalate                            │
│  (4) bulk destructive → escalate                             │
│  (5) file op, no path → escalate                             │
│  (6) agent def edit → escalate                               │
│  (7) multiple objectives → escalate                          │
│  (8) creation/design → escalate                              │
│  (9) keyword tier match → direct (≥0.8) or sonnet verify     │
│ (10) no match → escalate                                     │
└──────────────────────────────────────────────────────────────┘
    │
    ├─ Classifier.java   — 8 escalation triggers + 4-tier keyword match
    └─ Reformatter.java  — SOTA prompt rewriting + ambiguity detection
    │
    ▼
┌──────────────────────────────────────────────────────────────┐
│ Directive injected into LLM context                          │
│  DIRECT → Task tool spawns fable/haiku/sonnet/opus-general   │
│  ESCALATE → Task tool spawns sonnet-general (router)         │
│  CLARIFY → agent asks user, re-processes                     │
└──────────────────────────────────────────────────────────────┘
```

## File Structure

```
tier-router/
├── src/main/java/eu/infolead/llmhp/router/
│   ├── RouterCli.java       # CLI: classify, route, rewrite, ambiguity
│   ├── RouterEngine.java    # 10-step classification pipeline
│   ├── Classifier.java      # 8 escalation triggers + keyword tier match
│   ├── Reformatter.java     # Prompt rewriting + ambiguity questions
│   ├── RoutingResult.java   # record: decision, tier, reason, confidence, prompt
│   ├── Decision.java        # DIRECT | ESCALATE
│   └── Tier.java            # FABLE | HAIKU | SONNET | OPUS + relativeCost()
├── agents/                   # Agent definition .md files
│   ├── fable-general.md     # Ultra-light: close brackets, add semicolons
│   ├── haiku-general.md     # Mechanical: typos, format, rename, sort
│   ├── sonnet-general.md    # Judgment: analyze, implement, refactor, review
│   └── opus-general.md      # Deep: proofs, formal verification, math
├── hooks/
│   ├── hooks.json           # Claude Code: UserPromptSubmit + lifecycle
│   └── user-prompt-submit.sh # Main interception hook
├── opencode/index.ts        # OpenCode: 3 tools
├── pi/index.ts              # Pi: 3 tools
├── prompts/README.md        # Plugin documentation
└── .claude-plugin/plugin.json
```

## Tier Agents

| Tier | Model | Relative Cost | Use When |
|------|-------|---------------|----------|
| fable-general | fable | 0.25x | Trivial: close brackets, add semicolons, append/prepend |
| haiku-general | haiku | 1x | Mechanical: fix typos, format code, rename, sort imports, lint |
| sonnet-general | sonnet | ~12x | Judgment: analyze, implement, refactor, review, coordinate |
| opus-general | opus | ~75x | Deep reasoning: prove theorems, formal verification, math |

Each agent defines responsibilities, safety protocols, and escalation rules. See `agents/*.md`.

## Classification Pipeline (10 steps)

Stops at first match. Steps 1–8 escalate complex/risky/ambiguous requests; step 9 matches keywords; step 10 is the fallback escalate.

### Step 1: Ambiguity Detection

Catches vague prompts before execution. Matches: `fix the bug`, `update the config`, `make it better`, `optimize the database`, `improve the code`, `clean this up`, `refactor this`. Skips if file path or extension present.

Generates context-specific clarification questions:
- "fix the bug" → "Which component? (login flow, auth, token refresh, permissions?)"
- "update the config" → "Which config file? (app.json, database.yml, nginx.conf?)"
- etc.

### Steps 2–8: Escalation Triggers

| # | Trigger | Keywords | Confidence |
|---|---------|----------|------------|
| 2 | Meta-routing | "which agent", "how should i route", "route this to", "delegate to", "what model", "which tier" | 0.9 |
| 3 | Complexity | "complex", "subtle", "nuanced", "judgment", "trade-off", "best approach", "design", "architecture", "should I", "which is better", "recommend", "decide", "strategy" | 1.0 |
| 4 | Bulk destructive | "delete"/"remove"/"drop" + "all"/"multiple"/"*"/"every" | 1.0 |
| 5 | File op, no path | "edit"/"modify"/"change"/"update"/"delete"/"remove" without explicit file path AND not followed by abstract noun ("modify the plan" → skip) | 0.9 |
| 6 | Agent def edit | ".claude/agents" + edit/modify/update/delete/remove | 1.0 |
| 7 | Multiple objectives | ≥2 conjunctions: " and ", ", then ", " after ", " before ", ";" | 0.9 |
| 8 | Creation/design | "new"/"create"/"design"/"build"/"implement" — unless "new file <path>" | 0.85 |

### Step 9: Keyword Tier Match

Priority: Haiku → Opus → Sonnet → Fable.

| Tier | Keywords (regex) | Requires file path? |
|------|------------------|---------------------|
| Haiku | `fix\s+(typo\|spelling\|syntax)`, `format\s+(code\|file)`, `lint\s+`, `rename\s+\w+\s+\w*\s*to\s+\w+`, `add\s+(semicolon\|comma\|bracket\|import)`, `remove\s+(trailing\s+whitespace\|unused)`, `correct\s+(spelling\|typo)`, `sort\s+(imports\|lines)` | Yes |
| Opus | `prove`, `formalize`, `verify correctness`, `mathematical`, `theorem`, `algorithm design`, `proof` | No |
| Sonnet | `analyze`, `implement`, `refactor`, `integrate`, `review`, `optimize`, `debug`, `investigate` | No |
| Fable | `\b(add\|close)\s+(semicolon\|bracket\|paren\|brace)\b`, `\b(append\|prepend)\b` | Yes |

Confidence formulas (per tier):
```
fable: count(keywords) > 0 → 0.9, else 0.0
haiku: count(keywords) > 0 → min(0.9, 0.6 + count*0.1), else 0.5
sonnet: count(keywords) > 0 → min(0.95, 0.65 + count*0.1), else 0.0
opus: count(keywords) > 0 → min(0.95, 0.7 + count*0.1), else 0.0
```

### Step 10: Fallback Escalate

No keyword match → escalate to sonnet-general for intelligent routing.

### Confidence → Action Matrix

| Confidence | Action |
|------------|--------|
| ≥ 0.8 | Direct route to matched tier agent |
| 0.7–0.8 | Route to sonnet-general for verification |
| < 0.7 | Escalate (handled by earlier triggers or step 10) |

## Prompt Reformulation

Sourced from Anthropic's official prompt engineering documentation (clarity, context, specificity, XML structuring, conciseness directive, uncertainty permission, output format constraints).

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

## Backends

### Claude Code (hook-based, full interception)

`hooks/user-prompt-submit.sh` intercepts every `UserPromptSubmit` event:

1. Calls Java `ambiguity` → if ambiguous, injects `<routing-recommendation>` with clarification directive
2. Calls Java `route` → classifies + rewrites
3. Extracts JSON fields (fallback to `escalate/sonnet` on failure)
4. Logs metrics to `.tier-router/metrics/<date>.jsonl` (atomic append with flock)
5. Injects `<routing-recommendation>` directive into Claude's context

The main agent reads the directive and must obey it (enforced by `Router System` rules in project's CLAUDE.md).

### OpenCode (tool-based)

`opencode/index.ts` registers 3 tools:
- `classify-prompt` — classify + rewrite a prompt string
- `rewrite-prompt` — rewrite for a specific tier
- `check-ambiguity` — detect ambiguity, return clarification questions

All call Java `RouterCli` via Bun shell with stdin piping (no shell injection). OpenCode does not currently expose a `UserPromptSubmit`-equivalent hook, so prompt interception via directive injection is not yet available.

### Pi (tool-based)

`pi/index.ts` registers the same 3 tools. Calls Java via `pi.exec()` with stdin piping.

## IVP Analysis

| Component | Change Driver | Artifact |
|-----------|--------------|----------|
| Classifier (escalation triggers + keywords) | Task complexity taxonomy | Observed user intent patterns |
| Reformatter | Prompt engineering best practices | Anthropic prompt engineering docs |
| fable-general | Fable model capabilities | Model release notes |
| haiku-general | Haiku model capabilities | Model release notes |
| sonnet-general | Sonnet model capabilities | Model release notes |
| opus-general | Opus model capabilities | Model release notes |
| user-prompt-submit.sh | Claude Code plugin hook API | Claude Code plugin spec |
| opencode/index.ts | OpenCode plugin SDK | @opencode-ai/plugin |
| pi/index.ts | Pi plugin SDK | @pi-ai/plugin |

**IVP Compliance:** Changing model pricing never requires editing an agent definition. Changing model capabilities never requires editing routing rules. Each backend (OpenCode/Pi/Claude Code) varies independently. The shared Java core varies with classification logic only.

## Reference Implementation

The Claude Code router at `~/code/claude-router-system/` served as the initial reference. The tier-router improves on it by:
- Eliminating Python (Java 25 only)
- Adding SOTA prompt reformulation (not present in original)
- Adding ambiguity detection with clarification questions
- Supporting three backends (not just Claude Code)
- Tighter IVP boundaries (classifier/reformatter/backends separated)

## Costs

Classification runs locally (Java, zero-cost). No model is consumed for routing unless `ROUTER_USE_LLM` is enabled (not yet implemented). Sub-millisecond latency.

Expected savings: ~55% with baseline routing (60% of tasks are mechanical and routed to Haiku instead of Sonnet). ~70% with probabilistic routing (Phase 2, not yet implemented).
