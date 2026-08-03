# LLM Harness Plugins — Plan

Patterns → plugins crosswalk + new plugin candidates + changes for existing plugins.
Analysis date: 2026-07-29. Last updated: 2026-07-29.
Source: _GenAI Design Patterns_ catalog (6 parts, ~30 patterns, 7 candidates) × 7 plugins.

**Status**: 8/19 done (42%) — ✅ `budget-circuit-breaker` + `semantic-cache` + `tier-router:session-budget` + `tier-router:user-memory→routing` + `agentmem:extract-guardrail-pipeline` + `guardrail-chain` + `prompt-registry` + `permission-modes`
| New plugins: 5/8 ✅  |  Existing changes: 3/25 ✅  |  Total: 8/33

---

## 1. Current Plugin ↔ Pattern Map

| Plugin | Book pattern | How |
|--------|-------------|-----|
| `agentmem` | **Memory Hierarchy** (Pt II, ch16) + **Dual-Tier Memory** (ch25) | Three-tier ADD-only memory (in-band → out-of-band extraction → nightly consolidation), hot/cold storage, decay curves, hierarchical scoping |
| `knowledge-graph` | **GraphRAG** (Pt II, ch24) + **Hybrid Search** (ch18) | Build-time `.typ` → `graph.json` with Leiden community detection, community summaries, two-tier LLM (Haiku rater → Sonnet/Opus reasoner) |
| `tier-router` | **Routing** (Pt IV, ch23) + **LLM Cascade** (ch25) | 10-step classification pipeline: intent → cheapest sufficient model tier; keyword match → escalate on low confidence |
| `agentinsights` | **Observability** (Pt IV, ch27) | Session scan → LLM facet extraction → aggregation → HTML narrative report |
| `general-skills` | **LLM-as-a-Judge** (Pt VI, ch33) + **LLM Supervisor** (Pt I, ch14) | 10 audit agents (logic, math, proof, style, citations, etc.); `review-convergence` meta-skill orchestrates review/fix rounds |
| `latex-toolkit` | **Structured Output** (Pt VI, ch31) + **Explainability** (ch32) | Format-specific syntax verification, cross-ref/citation auditing, production-readiness scan |
| `typst-toolkit` | Same as latex-toolkit, for Typst | Syntax, format, xref, citation, production, diagram audit |

---

## 2. New Plugin Candidates

### ✅ 2.1 semantic-cache — Semantic Cache (Pt IV, ch30) — **DONE** (2026-07-29)

| Property | Detail |
|----------|--------|
| Priority | **1** (highest) |
| Effort | Low |
| Benefit | High — direct cost savings. 15–30% of coding-agent prompts are near-duplicates (same error message, same "what does this file do"). |
| Mechanism | Embed user prompt locally (no LLM at query time). Store in `.agentmem/cache/` with embedding-distance threshold. Return cached response on hit; tag with staleness if source files changed. Reuse agentmem's WAL atomicity (temp → fsync → rename). |
| Integration | Pre-tier-router check: if cached → skip classification. Post-tool-use: auto-populate cache on Write/Edit responses. |
| Edge cases | Embedding model drift, embedding-model cold-start (first cache miss is full cost), invalidation when project files change, large response bodies |

**File layout** — `semantic-cache/`:
```
src/main/java/eu/infolead/llmhp/cache/
├── SemanticCacheCli.java     # CLI: store, lookup, invalidate, stats
├── CacheStore.java           # Write: embed → store; Read: embed → lookup
├── Embedder.java             # Local embedding (ONNX runtime, no API call)
├── InvalidationEngine.java   # File-change-based invalidation
└── types/
    ├── CacheEntry.java       # Record: prompt, response, embedding, timestamp, ttl
    └── CacheStats.java       # Hit rate, miss rate, size, evictions
opencode/index.ts             # Plugin: register cache-check tool, hook into tool.execute
hooks/hooks.json              # PostToolUse → store; PreToolUse → check
prompts/agent-prompt.md       # "Responses may be cached — verify against current state"
```

### ✅ 2.2 budget-circuit-breaker — Budget Circuit-Breaker (Pt IV, ch26) — **DONE** (2026-07-29, inside tier-router)

| Property | Detail |
|----------|--------|
| Priority | **2** |
| Effort | Low (extend tier-router's existing metrics) |
| Benefit | High — prevents runaway agent spend. tier-router optimizes per-request; no session-level budget enforcement exists. |
| Mechanism | `PostToolUse` hook reads token counts from LLM responses, accumulates per-session. When cumulative spend crosses pre-declared ceiling → halt, inject budget-exhausted directive. Integration: tier-router's metrics log (`.tier-router/metrics/<date>.jsonl`) already tracks subagent duration and which agent spawned — add token-count tracking. |
| Integration | tier-router's `user-prompt-submit.sh` checks budget before routing; on exhausted → inject "session budget exhausted, summarize and exit" directive. |
| Session ceiling | Configurable: `TIER_ROUTER_BUDGET_CEILING` env var (default: 500K tokens/session). |

**File layout** — extends `tier-router/`:
```
src/main/java/eu/infolead/llmhp/router/
├── BudgetTracker.java        # Token accumulator, ceiling check, session reset
types/
├── BudgetState.java          # Record: sessionId, tokensUsed, ceiling, startTime
```

### ✅ 2.3 prompt-registry — Prompt Registry (Pt IV, ch29) — **DONE** (2026-07-29)

| Property | Detail |
|----------|--------|
| Priority | **3** |
| Effort | Medium |
| Benefit | Medium — every plugin uses custom prompts (agentmem's agent prompts, insights' section prompts, knowledge-graph's `agent-prompt.md`, tier-router's agent definitions). Currently flat files with no versioning, no A/B testing, no rollback. |
| Mechanism | Git-backed: `<plugin>/prompts/` directory is the registry. `prompt pull <name>@<version>` pulls the specific version. At session start, the plugin reads its prompt version from a `.prompt-versions` file. A/B testing: `prompt test <name> <variant-a> <variant-b>` spawns two subagents, compares outputs. |
| Integration | Every plugin's session-start hook reads from registry instead of raw file. Plugin developer workflow: edit prompt → `prompt commit <name>` → version bumps. |
| Scope | Version prompt templates, not agent system prompts (those belong in agent definitions). |

**File layout** — `prompt-registry/`:
```
src/main/java/eu/infolead/llmhp/prompts/
├── PromptRegistryCli.java    # CLI: pull, commit, diff, test, list
├── RegistryStore.java        # Read/write versioned prompts, .prompt-versions file
└── types/
    ├── PromptVersion.java    # Record: name, version, content, author, timestamp
    └── ABTestResult.java    # Pairwise comparison output
opencode/index.ts             # Plugin: register prompt-pull, prompt-test tools
hooks/hooks.json              # SessionStart → pull current versions
```

### ✅ 2.4 guardrail-chain — Guardrail Chain (Pt V, ch29) + Guardrail-First (ch31) — **DONE** (2026-07-29)

| Property | Detail |
|----------|--------|
| Priority | **4** |
| Effort | Medium (extract from agentmem, generalize) |
| Benefit | Medium — agentmem already has guardrail evaluation (secrets scanning, path traversal, guard_trigger) but it's embedded in `SaveMemoryTool`. No unified pre/post-filter chain across plugins. |
| Mechanism | Shared `GuardrailPipeline.java`: (1) input filter — path traversal check, prompt injection patterns, ambiguity gate; (2) output filter — secret leak scan (before any file write), schema validation. Every plugin's tool execution runs through the pipeline. Configurable per-plugin: which filters apply. |
| Agentmem current guards | Secrets scanning (pre-write), path validation (symlink defense), name regex (`[a-zA-Z0-9_-]+`). These become pipeline stages. |
| New guards | Prompt injection detection (obvious patterns: "ignore previous instructions," "you are now DAN"), output size bounds, forbidden-pattern match (hardcoded credentials in generated code). |

**File layout** — `guardrail-chain/`:
```
src/main/java/eu/infolead/llmhp/guardrails/
├── GuardrailPipeline.java    # Pre-execution → post-execution filter chain
├── SecretScanner.java        # sk-..., -----BEGIN, AKIA..., ghp_..., xox[...]-
├── PathValidator.java        # Symlink traversal, path containment check
├── PromptGuard.java          # Injection patterns, size bounds
└── types/
    ├── GuardConfig.java      # Per-plugin: which filters, severity (warn/block)
    └── GuardResult.java      # Pass | Warn(reason) | Block(reason)
```

### ✅ 2.5 permission-modes — Permission Mode State Machine — **DONE** (2026-08-03)

| Property | Detail |
|----------|--------|
| Priority | **5** |
| Effort | Medium (~600 loc) |
| Benefit | High — replaces binary approve/deny with 6-mode spectrum. Centralized `transitionPermissionMode()` with BYPASS_IMMUNE safety net, tool allow/deny lists per mode, auto-mode strip/restore on transitions. |
| Mechanism | `PermissionModes.java`: 6-mode enum (DEFAULT/PLAN/ACCEPT_EDITS/BYPASS_PERMISSIONS/DONT_ASK/AUTO). `checkPermission(tool, filePath)` 7-layer gate: BYPASS_IMMUNE → deny-list → category-block → allow-list → mode-default fallthrough. `transitionPermissionMode()` triggers `stripDangerousPermissionsForAutoMode()` on AUTO entry, restores on exit via deque stash. |

**File layout** — `permission-modes/`:
```
src/main/java/eu/infolead/llmhp/permissionmodes/
├── PermissionModes.java       # 6-mode state machine, checkPermission(), transitions, JSON serde
└── PermissionModesCli.java    # CLI: check, transition, status, state, save, load, immune
opencode/index.ts              # tool.execute.before hook + 4 tools (permission-mode, permission-status, etc.)
.claude-plugin/hooks/hooks.json # PreToolUse hook
```

### ❌ 2.6 eval-harness — LLM-as-a-Judge (Pt VI, ch33) + Candidate B.7 Blind Evaluation

| Property | Detail |
|----------|--------|
| Priority | **5** (depends on general-skills integration + B.7 maturing) |
| Effort | High |
| Benefit | High — structured eval pipeline for agent outputs. Currently audit agents are invoked ad-hoc; no standardized task → output → evaluation → score pipeline. |
| Mechanism | `run-eval` tool: (1) task prompt + rubric, (2) agent produces output, (3) evaluator receives output ONLY (blinded per B.7 — no prompt, no trace, no model identity), (4) evaluator scores against rubric, (5) results stored in eval dataset for trending. Composes with general-skills agents as evaluators. |
| Blinding per B.7 | Evaluator gets artifact + rubric only. System prompt is fresh (not inherited from generator). Stronger variant: evaluator runs on different model family. |
| Dataset | Eval results stored as structured JSON in `.agentmem/evals/`. `eval-trend` command shows scores over time. |

**File layout** — `eval-harness/`:
```
src/main/java/eu/infolead/llmhp/eval/
├── EvalHarnessCli.java       # CLI: run, trend, compare
├── EvalRunner.java           # Task → agent → evaluator → score pipeline
├── BlindingEvaluator.java    # Strips context, fresh system prompt, optional cross-family
└── types/
    ├── EvalTask.java         # Record: prompt, rubric, expected-behavior
    ├── EvalResult.java       # Record: task, output, score, rationale, evaluator-model
    └── EvalDataset.java      # Aggregate: tasks[], results[], trend
opencode/index.ts             # Plugin: register run-eval tool
commands/eval.md              # /eval slash command
```

### ❌ 2.6 cross-family-second-opinion — Candidate B.1 Cross-Family Ensemble (extends tier-router)

| Property | Detail |
|----------|--------|
| Priority | **6** (depends on B.1 maturing + multi-provider infrastructure) |
| Effort | High (multi-provider dispatch) |
| Benefit | Speculative. For high-stakes operations, get a second opinion from a non-Anthropic model before routing. |
| Mechanism | Extend tier-router's escalation pipeline: at step 4 (bulk destructive) and step 6 (agent def edit), before routing to the Anthropic tier agent, send the prompt to a second provider's model. On disagreement → escalate to human (inject clarification directive). On agreement → proceed with Anthropic tier agent. |
| Configuration | `TIER_ROUTER_SECOND_OPINION_PROVIDER` env var (e.g., `openai/gpt-4.1`). Default: disabled (no second opinion). |
| Integration | tier-router's `Reformatter.java` gains a `getSecondOpinion()` method. Disagreement threshold: configurable (any difference, substantive difference only, confidence-weighted). |

**File layout** — extends `tier-router/`:
```
src/main/java/eu/infolead/llmhp/router/
├── CrossFamilyChecker.java   # Parallel dispatch → compare → escalation decision
```

### ❌ 2.7 null-branch-reporter — Candidate B.6 Null-Branch Reporting (extends agentinsights + agentmem)

| Property | Detail |
|----------|--------|
| Priority | **7** (depends on B.6 maturing) |
| Effort | Medium (prompt engineering + memory subtype) |
| Benefit | Speculative. Surface rejected branches to the user so they can calibrate confidence in the chosen path. |
| Mechanism | agentmem: new `rejected_approach` memory subtype. Memory-keeper prompt updated to extract "tried X, reverted, tried Y" patterns. agentinsights: new insight section "Paths Not Taken" that aggregates rejected-branch memories and shows patterns ("you keep trying X and rejecting it"). |
| Detection | Transcript patterns: edit-then-revert sequences, "let me try another approach," "that didn't work," `git reset` / `git checkout` commands. Memory-keeper tags these. |
| Integration | agentinsights reads rejected_approach memories during facet extraction → new insight section. |

---

## 3. Changes to Existing Plugins

### 3.1 agentmem

| # | Change | Priority | Effort | Book pattern | Status |
|---|--------|----------|--------|-------------|--------|
| 1 | **Extract guardrail logic to shared pipeline** | High | Medium | Guardrail Chain (Pt V) | ✅ |
| | `MemoryStore.save()` calls `GuardrailPipeline.runPreWrite()` before write. `PathValidator.java` delegates to guardrail-chain. `QualityGateRunner.gate7Secrets` delegates to `SecretScanner`. agentmem keeps its own quality gates (7 structural gates) but delegates security gates. | | | | |
| 2 | **Add `rejected_approach` memory subtype** | Medium | Low | B.6 Null-Branch Reporting | ❌ |
| | New subtype under `project` type. Body structure: What was tried → Why it was rejected → What was tried instead. Memory-keeper prompt updated. Dreamer aggregates: "3 sessions rejected approach X." | | | | |
| 3 | **Cross-project contradiction detection** | Medium | Low | B.3 Comparison-Adjusted Acceptance | ❌ |
| | Dreamer currently detects contradictions within a project. Extend to cross-project (shared MEMORY.md tier): "fact X is true in project A, false in project B." Flag in dream summary. | | | | |
| 4 | **User memory → tier-router signal** | Medium | Low | Routing (Pt IV) | ✅ |
| | If user memories say "I'm learning Rust," tier-router reads this at session start and escalates Rust-related prompts. Single-file dependency: tier-router's `RouterEngine.java` reads `MEMORY.md` on session start. | | | | |
| 5 | **Bootstrap from agentinsights facets** | Low | Medium | Observability (Pt IV) → Memory | ❌ |
| | agentinsights extracts session facets (goals, friction, satisfaction). Memory-keeper consumes these as seed signals: "you were frustrated by tool errors in sessions X, Y, Z" → `feedback` memory. | | | | |

### 3.2 agentinsights

| # | Change | Priority | Effort | Book pattern | Status |
|---|--------|----------|--------|-------------|--------|
| 1 | **Rejected-branch analysis insight section** | Medium | Medium | B.6 Null-Branch Reporting | ❌ |
| | New section "Paths Not Taken": reads agentmem's `rejected_approach` memories. Aggregates: which approaches are repeatedly rejected, which files cause the most reversion. Requires agentmem change #2. | | | | |
| 2 | **Pre-announced goal vs actual outcome drift** | Medium | Medium | B.2 Pre-Committed Plan | ❌ |
| | Compare `first_prompt` (stated goal) vs `underlying_goal` (facet-extracted) vs `outcome`. Surface: "30% of sessions start with goal X and drift to Y." Insight section "Goal Drift." | | | | |
| 3 | **Cross-family quality comparison** | Low | High | B.1 Cross-Family Ensemble | ❌ |
| | If user switches between coding agents (OpenCode vs Claude Code vs Pi), the multi-clauding detector already catches concurrent usage. Extend to compare quality: "outcomes better on Claude than OpenCode for Python tasks." Depends on having enough data across families. | | | | |
| 4 | **Friction → automatic guardrail suggestion** | Low | Medium | Guardrail Chain (Pt V) | ❌ |
| | If friction categories show "buggy_code" repeatedly for the same file, auto-suggest: "This file has high bug rate — add a guardrail in this directory." Output in suggestions section. | | | | |

### 3.3 knowledge-graph

| # | Change | Priority | Effort | Book pattern | Status |
|---|--------|----------|--------|-------------|--------|
| 1 | **Subgraph query caching** | Medium | Low | Semantic Cache (ch30) | ❌ |
| | Subgraph injection fires on every file.read/edit. If the graph hasn't changed since the last query for label X at depth D, return cached result. Simple mtime check on graph.json. | | | | |
| 2 | **Graph-informed routing signal** | Medium | Low | Routing (Pt IV) | ❌ |
| | File with high in-degree (many dependents) → task is likely complex → signal tier-router to escalate. Integrate via tier-router reading graph.json on session start. | | | | |
| 3 | **Contradiction heuristic detector** | Medium | Medium | Exploit existing `contradicts` edge type | ❌ |
| | Schema has `contradicts` edges but they're agent-populated (manual). Add heuristic: "two theorems with overlapping hypotheses but contradictory claims" → flag. Simple NLP: extract hypothesis sets, check for logical negation patterns. | | | | |
| 4 | **Graph health trending** | Low | Medium | Observability (Pt IV) | ❌ |
| | Run `quality` after every build, log to time series. agentinsights report gains "Knowledge Graph Health" section: modularity over time, entity coverage trend, community drift. | | | | |

### 3.4 tier-router

| # | Change | Priority | Effort | Book pattern | Status |
|---|--------|----------|--------|-------------|--------|
| 1 | **Session-level budget enforcement** | High | Low | Budget Circuit-Breaker (ch26) | ✅ |
| | Add `BudgetTracker.java` to tier-router. `user-prompt-submit.sh` checks cumulative token spend before routing; on exhausted → inject session-budget-exhausted directive. Configurable ceiling: `TIER_ROUTER_BUDGET_CEILING` (default 500K tokens). | | | | |
| 2 | **Model fallback on agent failure** | Medium | Medium | Model Fallback (ch24) | ❌ |
| | Currently: if routed agent fails (tool error, no output), no fallback. Add: if haiku fails → retry with sonnet. Configurable retry budget: max 1 fallback per prompt. Log fallback events to metrics. | | | | |
| 3 | **Semantic cache check before classification** | Medium | Medium | Semantic Cache (ch30) | ❌ |
| | Before 10-step classification pipeline, check if semantically similar prompt was already routed. Avoid re-classifying near-duplicates. Depends on `semantic-cache` plugin (2.1). | | | | |
| 4 | **Agent performance → routing weight adjustment** | Low | High | Observability (Pt IV) → Routing | ❌ |
| | Use agentinsights' friction/satisfaction data to adjust routing weights: "haiku has high friction on Python tasks → route Python prompts to sonnet." Depends on agentinsights → tier-router integration. | | | | |
| 5 | **User memory → routing hint** | Medium | Low | Routing + Memory | ✅ |
| | Read user's `MEMORY.md` at session start. Preferences ("terse responses"), expertise ("learning Rust") → adjust routing (expertise mismatch → escalate). Counterpart to agentmem change #4. | | | | |

### 3.5 general-skills

| # | Change | Priority | Effort | Book pattern | Status |
|---|--------|----------|--------|-------------|--------|
| 1 | **Blinded audit mode** | High | Medium | B.7 Prompt-Isolation Blinding | ❌ |
| | When auditing agent output (code review, logic audit, proof audit), strip prompt and context from evaluator. Evaluator sees only artifact + rubric. Fresh system prompt. Configurable: optional cross-family evaluator for critical audits. | | | | |
| 2 | **Eval harness integration** | Medium | Medium | LLM-as-a-Judge (Pt VI) | ❌ |
| | Wrap audit agents in structured eval interface: task → output → verdict → score → dataset. Enables trending ("audit quality over time"). Depends on `eval-harness` plugin (2.5). | | | | |
| 3 | **Dead-end detector audit** | Low | Medium | B.6 Null-Branch Reporting | ❌ |
| | New audit agent: scans transcripts for "tried X, reverted" patterns. Flags repeated dead ends as "process friction." Feeds into agentinsights' rejected-branch analysis. | | | | |

---

## 4. Cross-Plugin Integration Map

```
┌─────────────────────────────────────────────────────────────────────┐
│                        PLUGIN INTEGRATION GRAPH                      │
│                                                                     │
│  tier-router ──────── reads ──────────► agentmem (user preferences) │
│       │                                    │                         │
│       │ reads                              │ seeds                   │
│       ▼                                    ▼                         │
│  knowledge-graph ◄─── health trend ─── agentinsights                │
│       │                                    │                         │
│       │ complexity signal                  │ friction signal         │
│       ▼                                    ▼                         │
│  tier-router ◄── routing weights ─── agentinsights                  │
│                                                                     │
│  guardrail-chain ── used by ──► agentmem (pre-write filters)        │
│  guardrail-chain ── used by ──► ALL plugins (pre-post execution)    │
│                                                                     │
│  semantic-cache ── queried by ──► tier-router (before classify)     │
│  semantic-cache ── queried by ──► knowledge-graph (subgraph cache)  │
│                                                                     │
│  budget-circuit-breaker ── gates ──► tier-router (before route)     │
│                                                                     │
│  prompt-registry ── pulled by ──► ALL plugins (session start)       │
│                                                                     │
│  eval-harness ── uses ──► general-skills (blinded evaluators)       │
│  eval-harness ── feeds ──► agentinsights (eval trending)            │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 5. Priority-Ranked Implementation Order

```
Rank  Plugin/Change                         Effort  Benefit  Depends on                  Status
────  ────────────────────────────────────  ──────  ───────  ──────────                  ──────
  1   budget-circuit-breaker (new)           Low     High     tier-router metrics log      ✅
  2   semantic-cache (new)                   Low     High     .agentmem/ WAL pattern       ✅
  3   tier-router: session budget (#3.4.1)   Low     High     budget-circuit-breaker       ✅
   4   tier-router: user memory → routing     Low     Med      agentmem                     ✅
  5   agentmem: extract guardrail pipeline   Med     Med      guardrail-chain              ✅
  6   guardrail-chain (new)                  Med     Med      agentmem guards              ✅
   7   prompt-registry (new)                  Med     Med      none                         ✅
   8   permission-modes (new)                   Med     High     opencode hook system          ✅
   9   agentmem: rejected_approach subtype      Low     Med      none                         ❌
  10   agentinsights: rejected-branch sec.    Med     Med      agentmem #9                  ❌
  11   knowledge-graph: subgraph caching      Low     Low      semantic-cache               ❌
  12   knowledge-graph: contradiction detect  Med     Med      none                         ❌
  13   tier-router: model fallback            Med     Med      none                         ❌
  14   general-skills: blinded audit mode     Med     Med      none                         ❌
  15   agentmem: cross-project contradiction  Low     Low      none                         ❌
  16   agentmem: bootstrap from insights      Med     Low      agentinsights                ❌
  17   eval-harness (new)                     High    High     general-skills, B.7          ❌
  18   cross-family-second-opinion            High    Spec.    B.1, multi-provider          ❌
  19   null-branch-reporter                   Med     Spec.    B.6, agentmem, insights      ❌
```

---

## 6. IVP Notes

Change drivers for each element. Grouping decisions should respect these boundaries:

| Element | Change driver | Artifact |
|---------|--------------|----------|
| `semantic-cache` | Embedding model + cache invalidation rules | embedding-model release notes, file-change detection |
| `budget-circuit-breaker` | Token pricing + session policies | vendor pricing pages, org cost policies |
| `prompt-registry` | Prompt engineering best practices | Anthropic prompt docs, general-skills agents |
| `guardrail-chain` | Security threat catalog | OWASP LLM Top 10, red-team findings |
| `permission-modes` | Permission model + tool authorization | opencode/Claude Code tool permission hooks, BYPASS_IMMUNE catalog |
| `eval-harness` | Evaluation framework specs + rubric design | benchmark protocols, B.7 blinding mechanism |
| `cross-family-second-opinion` | Multi-provider API surfaces | vendor SDKs, B.1 family-diversity rationale |
| `null-branch-reporter` | Transcript format + memory taxonomy | agentmem subtypes, agentinsights facet schema |

Each new plugin has a distinct driver from existing plugins → separate directory, separate build target, separate OpenCode/Claude Code/Pi shims. Budget-circuit-breaker and cross-family-second-opinion are tier-router extensions (same driver as router: routing logic), so they live inside `tier-router/src/`.

---

## 7. Shared Utilities

### 7.1 config-settings — Cascading Config Merge (shared/config-settings.ts)

| Property | Detail |
|----------|--------|
| Status | ✅ |
| Tiers | userSettings → localSettings → flagSettings |
| Merge | deep-merge, `null` = delete marker |
| Safety | lockfile writes (O_EXCL), timestamped backups (capped 5, ≥60s throttle), auth-loss guard |
| Per-key tracking | `perKey` map → query which source set each value |
| Exports | `buildConfigCascade`, `loadSettingsFromDisk`, `mergeWithFlags`, `saveConfigAtomic`, `wouldLoseAuthState`, `getSourceForKey` |
| Tests | `shared/config-settings.test.ts` (37 tests) |

### 7.2 Pre-Flight Checklist Per New Plugin

Every new plugin must satisfy:
- [ ] Java ≥25 core + TypeScript shims (3 platforms: OpenCode, Claude Code, Pi)
- [ ] Design doc (`plugin-<name>.design.md`) with IVP analysis
- [ ] Compiled classes committed to `build/classes/`
- [ ] Tests (≥10 test cases for core logic)
- [ ] `.claude-plugin/plugin.json` marketplace manifest
- [ ] `hooks/hooks.json` for Claude Code hooks
- [ ] `opencode/index.ts` for OpenCode plugin entry
- [ ] `pi/index.ts` for Pi plugin entry
- [ ] `prompts/agent-prompt.md` for agent-facing usage guide
- [ ] Registered in `.claude-plugin/marketplace.json`
- [ ] Added to `build.sh` compile targets
