# OpenCode Router System — Design Document

## 1. Overview

**Problem:** Every LLM prompt in a coding assistant consumes tokens at the same model tier. Simple mechanical tasks (typo fixes, rename, format) burn Sonnet/Opus quota. Complex reasoning tasks fail on cheap models. Without a routing layer, we either overspend or underdeliver.

**Solution:** A router plugin that intercepts every user prompt before it reaches the LLM, classifies it by complexity/risk/domain, optionally reformulates it, and dispatches it to the appropriate model tier — `haiku-general` (mechanical), `sonnet-general` (judgment), `opus-general` (deep reasoning), or `fable-general` (future lightweight tier).

**Scope:** OpenCode only. Claude Code already has `infolead-claude-subscription-router` at `~/code/claude-router-system/`. This document designs the OpenCode equivalent.

## 2. Architecture

```
User Prompt
    │
    ▼
┌─────────────────────────────────────────────┐
│ OpenCode Plugin: Hook on UserPromptSubmit    │
│  1. Intercept raw prompt                     │
│  2. Classify: mechanical / judgment / deep   │
│  3. Reformulate prompt (style enforcement)   │
│  4. Inject routing directive into context    │
│  5. Main agent reads directive → Task tool   │
│     spawns correct tier agent                │
└─────────────────────────────────────────────┘
    │
    ▼
┌──────────────────────────────────────────────┐
│ Routing Engine (Java ≥ 25, no Python)        │
│  - Keyword + pattern classification          │
│  - Optional LLM-based semantic match         │
│  - Returns: tier + confidence + reason       │
└──────────────────────────────────────────────┘
    │
    ▼
┌──────────────────────────────────────────────┐
│ Prompt Reformatter                           │
│  - Strips AI-style patterns (bold headers,   │
│    excessive lists, em-dash abuse)            │
│  - Applies project-specific writing style    │
│  - Injects: conciseness, no preamble, etc.   │
└──────────────────────────────────────────────┘
    │
    ▼
┌──────────────────────────────────────────────┐
│ Dispatcher → Task tool spawns tier agent     │
│  haiku-general  ── mechanical (1x cost)      │
│  sonnet-general ── judgment (10x cost)       │
│  opus-general   ── deep logic (75x cost)     │
│  fable-general  ── future ultra-light        │
└──────────────────────────────────────────────┘
```

## 3. Tier Agent Definitions

Four general agents, one per reasoning tier. Each is a standalone agent definition file in `.claude/agents/` (or the OpenCode equivalent agents directory) with responsibilities, tools, safety protocols, and escalation rules.

### 3.1 `haiku-general` — Mechanical Tier

```yaml
model: haiku
tools: Read, Edit, Write, Bash, Glob, Grep, Task
cost: 1x
```

**Responsibilities:**
- Simple find-replace
- Pattern matching and basic transforms
- File operations with explicit paths
- Straightforward code modifications
- No judgment calls

**Safety protocols:**
- Verify file path is explicit before modification
- Read file before modifying
- Confirm change is mechanical and unambiguous
- Never delete files based on patterns
- Never interpret vague instructions

**Escalation:** "This task requires judgment. Please re-route to sonnet-general."

### 3.2 `sonnet-general` — Judgment Tier

```yaml
model: sonnet
tools: Read, Edit, Write, Bash, Glob, Grep, Task
cost: ~10x
```

**Responsibilities:**
- Multi-step tasks requiring planning
- Analysis and interpretation
- Cross-referencing multiple sources
- Coordination between components
- Judgment and trade-off evaluation
- Default for most general-purpose work
- Destructive operations (verify intent, assess scope, check value)

**Escalation:** Delegate to opus-general for deep logical analysis, proofs, high-stakes decisions. Delegate to project agents for specialized tasks.

### 3.3 `opus-general` — Deep Reasoning Tier

```yaml
model: opus
tools: Read, Edit, Write, Bash, Glob, Grep, Task
cost: ~75x
```

**Responsibilities:**
- Mathematical proofs and derivations
- Complex logical analysis
- Detecting circular reasoning or subtle flaws
- Multi-factor decision analysis
- High-stakes operations with significant consequences

**Cost awareness:** ~75x more expensive than Haiku. Optimize for efficiency. Delegate simpler sub-tasks to cheaper models.

### 3.4 `fable-general` — Ultra-Light Tier (Future)

```yaml
model: fable  # not yet available; speculative
tools: Read, Edit, Write, Bash, Glob, Grep
cost: ~0.25x  # targeted
```

**Responsibilities:**
- Trivial completions (close bracket, add semicolon)
- Exact string matches where no context needed
- Grep/Glob result formatting
- Single-line edits with explicit content

**Rationale:** Haiku is overkill for tasks needing sub-Haiku reasoning. When a suitably cheap+fast model emerges, fable-general provides the floor tier.

## 4. Classification Engine

### 4.1 Two-Pass Architecture

| Pass | Engine | Cost | Purpose |
|------|--------|------|---------|
| **Pre-router** | Keyword/regex patterns | ~zero | 60-70% of requests — mechanical classification |
| **Full router** | LLM (haiku model) | ~$0.0003/req | When pre-router confidence < 0.8 — semantic understanding |

### 4.2 Pre-Router: Mechanical Escalation Checklist

Eight pattern-based triggers. ANY match → escalate to sonnet-tier routing. Adapted from `routing_core.py` (`~/code/claude-router-system/plugins/.../implementation/routing_core.py`).

| # | Trigger | Keywords / Patterns | Confidence |
|---|---------|---------------------|------------|
| 1 | Complexity signals | "complex", "best", "should I", "recommend", "design", "architecture", "strategy", "trade-off", "judgment" | 1.0 |
| 2 | Bulk destructive | "delete"/"remove"/"drop" + "all"/"multiple"/"*"/"every" | 1.0 |
| 3 | File op, no path | "edit"/"modify"/"change"/"update" without explicit file path | 0.9 |
| 4 | Agent definition edit | ".claude/agents" + edit/modify/update | 1.0 |
| 5 | Multiple objectives | ≥2 conjunctions: "and"/", then"/"after"/"before"/";" | 0.9 |
| 6 | Creation/design | "new"/"create"/"design"/"build"/"implement" — unless "new file <explicit_path>" | 0.85 |
| 7 | No agent match | Agent keyword matching confidence < 0.8 | 1.0 |
| 8 | Meta-routing | "router", "routing", "agent", "delegate" | 0.9 |

### 4.3 Keyword-Based Agent Matching

Fallback when LLM routing disabled. Tiered priority:

**Haiku keywords (high confidence, explicit file required):**
- `fix typo/spelling/syntax`, `format code/file`, `lint`, `rename X to Y`, `add semicolon/comma/bracket/import`, `remove trailing whitespace/unused`, `correct spelling/typo`, `sort imports/lines`

**Sonnet keywords (reasoning required):**
- `analyze`, `implement`, `refactor`, `integrate`, `review`, `optimize`, `debug`, `investigate`

**Opus keywords (complex reasoning):**
- `prove`, `formalize`, `verify correctness`, `mathematical`, `theorem`, `algorithm design`

### 4.4 LLM-Based Semantic Matching

When `ROUTER_USE_LLM=1`: sends request to haiku model with agent descriptions, returns `{agent, confidence}` JSON. Falls back to keyword matching on failure, timeout (10s), or bad JSON.

### 4.5 Confidence → Action Matrix

| Confidence | Action |
|------------|--------|
| ≥ 0.8 | Direct route to matched agent |
| 0.5–0.8 | Route to sonnet-general for verification |
| < 0.5 | Escalate to full router |

## 5. Prompt Reformulation

Every prompt passing through the router gets reformulated before reaching the executing agent. This ensures output quality and prevents AI-style prose patterns.

### 5.1 Enforced Concision Prefix

Prepended to every prompt:

```
Be concise. Answer directly. Minimize output tokens.
Do NOT use bold headers, bullet lists for exposition, excessive
em-dashes, or dramatic section titles. Write in flowing prose.
```

### 5.2 AI-Style Pattern Stripping

From `~/code/health-me-cfs/.claude/writing-style.md`. The reformatter flags and rewrites:

| Anti-pattern | Rewrite to |
|-------------|------------|
| Itemized lists with bold headers | Flowing prose paragraphs |
| Bold paragraph headers: `**Header.** Content` | Integrate topic into natural paragraph flow |
| `\begin{enumerate}` for exposition | Reserve for sequential steps only |
| Colon + list: "The relationship:" then items | Integrate examples into prose |
| Dramatic section titles | Descriptive, complete phrases |
| Excessive em-dashes | Semicolons, periods, commas |
| Repetitive sentence openings | Vary structure |
| Short punchy declaratives in sequence | Vary sentence length |
| "This is not X—it is Y" | Rephrase naturally |

### 5.3 Style Enforcement by Agent Tier

| Tier | Style Rule Override |
|------|---------------------|
| Haiku | Max concision; output in ≤ 3 lines; no preamble |
| Sonnet | Standard style guide; use transition phrases |
| Opus | Full style guide; rigorous reasoning chains; executive summaries for complex output |

### 5.4 Per-Project Style Overrides

Projects provide `.claude/writing-style.md` for domain-specific rules (e.g., academic/LaTeX, medical writing, API docs). THe reformatter checks for project-specific style and merges with defaults.

## 6. Probabilistic Router (Phase 2)

From `~/code/claude-router-system/.../agents/probabilistic-router.md`. Optimistically routes HIGH-confidence requests to Haiku, validates results, and auto-escalates on failure. Enables 35-40% additional quota savings.

### 6.1 Confidence Classification

| Level | Threshold | Action |
|-------|-----------|--------|
| HIGH | > 90% | Try Haiku first; automated validation |
| MEDIUM | 70-90% | Try Haiku; automated + user-approval validation |
| LOW | < 70% | Route directly to Sonnet |

### 6.2 HIGH Confidence Signals

`trailing whitespace`, `format`, `indent`, `fix typo`, `sort imports`, `remove unused`, `add missing`, `find all`, `grep`, `count occurrences`, `add semicolon`, `close bracket`

### 6.3 MEDIUM Confidence Signals

`rename`, `extract`, `add type hint`, `add docstring`, `move function`, `copy file`, `create simple`

### 6.4 LOW Confidence Signals (Force Sonnet)

`design`, `architect`, `refactor`, `improve`, `optimize`, `fix bug`, `help me choose`, `which approach`, `best practice`, `complex`

### 6.5 Validation Strategy

| Confidence | Automated Checks | Manual Check |
|------------|-----------------|--------------|
| HIGH | Syntax, build, diff | None |
| MEDIUM | Syntax, build, diff | Show diff to user |
| LOW | N/A (skip Haiku) | N/A |

**Validation checks:**
1. Syntax: run language linter on modified files
2. Build: run build command
3. Test: run affected tests
4. Diff: verify changes match request scope

**Escalation on failure:** Haiku → Sonnet, including failure details.

## 7. Cost Models

### 7.1 Model Pricing (Claude)

| Model | Input ($/MTok) | Output ($/MTok) | Relative Cost |
|-------|---------------|-----------------|---------------|
| Fable (future) | ~0.06 | ~0.30 | ~0.25x |
| Haiku | 0.25 | 1.25 | 1x |
| Sonnet | 3.00 | 15.00 | ~10-12x |
| Opus | 15.00 | 75.00 | ~60-75x |

### 7.2 Propose-Review Break-Even

| Pattern | Break-Even |
|---------|------------|
| Haiku propose → Sonnet review | Haiku success rate > 60% |
| Sonnet propose → Opus review | Sonnet success rate > 67% |

### 7.3 Expected Savings

| Scenario | Without Router | With Router | Savings |
|----------|---------------|-------------|---------|
| 60% mechanical tasks | All Sonnet | Haiku for mechanical 60% | ~55% |
| + probabilistic routing | — | Additional 35-40% on remaining | ~70% total |

## 8. Strategy Advisor (Phase 2)

From `~/code/claude-router-system/.../agents/strategy-advisor.md`. After router selects agent, strategy-advisor determines execution pattern by analyzing: volume, mechanical score, verifiability, and context homogeneity.

### 8.1 Execution Strategies

| Strategy | When |
|----------|------|
| `direct-haiku` | Read-only, no changes possible |
| `direct-sonnet` | Judgment required |
| `direct-opus` | Deep reasoning, no cheaper alternative |
| `propose-review` | Haiku proposes → Sonnet reviews (saves money if haiku success > 60%) |
| `draft-then-evaluate` | Haiku batch-drafts N items → Sonnet evaluates in 1 message |
| `draft-then-evaluate-partitioned` | Above, partitioned by context boundaries |

### 8.2 Mechanical Score

0.0 (pure judgment) to 1.0 (fully mechanical):

| Task | Score |
|------|-------|
| Exact pattern replacement | 1.0 |
| Syntax fixes (compiler-verified) | 0.9 |
| Reference/label updates | 0.8 |
| Formatting, organization | 0.5 |
| Style improvements | 0.3 |
| Pure judgment | 0.1 |

### 8.3 Verifiability

**Easy (cheap review):** compiler verification, pattern matching, automated tests, diff review.
**Hard (expensive review):** requires re-reading all content, judgment calls, deep logical analysis.

### 8.4 Context Homogeneity

Tasks sharing context → batch-evaluate efficiently. Homogeneous → `draft-then-evaluate`. Heterogeneous → partition or direct execute.

## 9. Implementation Plan

### 9.1 Phase 1: Core Router Plugin (1-2 weeks)

| Task | Description |
|------|-------------|
| 1. Plugin scaffold | OpenCode plugin with `UserPromptSubmit` hook, TypeScript |
| 2. Routing engine | Java 25 port of `routing_core.py` — keyword patterns + escalation triggers |
| 3. Agent definitions | `haiku-general`, `sonnet-general`, `opus-general`, `fable-general` `.md` files |
| 4. opencode.json config | `agent` section mapping tier names to models |
| 5. Routing directive injection | `<routing-recommendation>` block injected into context |
| 6. Basic reformatter | Concision prefix + list → prose conversion |

### 9.2 Phase 2: Smart Routing (1-2 weeks)

| Task | Description |
|------|-------------|
| 7. LLM-based matching | When `ROUTER_USE_LLM=1`, use haiku for semantic agent matching |
| 8. Probabilistic router | Optimistic Haiku with validation + auto-escalation |
| 9. Strategy advisor | Cost-aware execution strategy selection |
| 10. Domain configs | Per-project `.yaml` domain definitions (software-dev, latex-research, etc.) |

### 9.3 Phase 3: Optimization (ongoing)

| Task | Description |
|------|-------------|
| 11. Metrics tracking | Route decisions, success rates, costs saved → `.jsonl` log |
| 12. Adaptive thresholds | Tune confidence thresholds from metrics |
| 13. Fable tier | When ultra-cheap model available, add fable-general |
| 14. Prompt reformatter v2 | AI-style pattern detection with stripper agent |

## 10. Configuration Example

### `opencode.json` agent section

```json
{
  "agent": {
    "haiku-general": {
      "model": "anthropic/claude-haiku-4",
      "description": "Mechanical tasks: fix typos, format code, rename, simple edits. No judgment.",
      "mode": "subagent"
    },
    "sonnet-general": {
      "model": "anthropic/claude-sonnet-4",
      "description": "Judgment tasks: analyze, implement, refactor, review, debug. Default tier.",
      "mode": "subagent"
    },
    "opus-general": {
      "model": "anthropic/claude-opus-4",
      "description": "Deep reasoning: proofs, formal verification, architecture decisions, math.",
      "mode": "subagent"
    },
    "fable-general": {
      "model": "anthropic/claude-fable-4",
      "description": "Ultra-light: trivial completions, exact matches, single-line edits.",
      "mode": "subagent"
    }
  }
}
```

## 11. IVP Analysis

| Component | Change Driver | Artifact |
|-----------|--------------|----------|
| Router (tier classification) | Task complexity taxonomy | User intent patterns observed in practice |
| Reformatter | Writing style conventions | `.claude/writing-style.md` |
| haiku-general | Haiku model capabilities | Model provider release notes |
| sonnet-general | Sonnet model capabilities | Model provider release notes |
| opus-general | Opus model capabilities | Model provider release notes |
| Strategy advisor | API pricing models, cost optimization | Provider pricing page |
| Probabilistic router | Validation methodology, model reliability | Success rate metrics |

Router logic and agent capabilities are IVP-separated: changing model pricing never requires editing an agent definition; changing model capabilities never requires editing routing rules.

## 12. Reference Implementation

The Claude Code router system at `~/code/claude-router-system/` serves as the reference. Key files:

| File | Purpose |
|------|---------|
| `.../hooks/user-prompt-submit.sh` | Shell hook that calls `routing_core.py`, injects `<routing-recommendation>` |
| `.../implementation/routing_core.py` | Pre-router: 8 mechanical escalation triggers + keyword/LLM agent matching |
| `.../implementation/probabilistic_router.py` | Optimistic Haiku execution with validation + auto-escalation |
| `.../agents/router.md` | Sonnet-tier intelligent router: domain classification, risk assessment, delegation |
| `.../agents/haiku-pre-router.md` | Haiku-tier cost-optimized first-pass router |
| `.../agents/probabilistic-router.md` | Confidence classification + validation-based optimistic routing |
| `.../agents/strategy-advisor.md` | Cost-aware execution strategy selection |
| `.../agents/haiku-general.md` | Mechanical tier agent definition |
| `.../agents/sonnet-general.md` | Judgment tier agent definition |
| `.../agents/opus-general.md` | Deep reasoning tier agent definition |
| `.../config/domains/latex-research.yaml` | Domain-specific routing config example |
| `.../adaptive-orchestration.yaml.example` | Threshold + pattern customization |

The existing codebase at `~/code/ivp-book-series/` and `~/code/health-me-cfs/` demonstrates the agent tier system in production with 180+ specialized agents, description-based delegation, and model escalation rules — but no prompt interception or reformulation layer. The `~/code/health-me-cfs/.claude/writing-style.md` and `~/code/health-me-cfs/.claude/prompts/research-ai-prose-patterns.md` provide the prompt rewriting reference.
