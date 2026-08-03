# Claude Code Architecture Patterns for Opencode

**Source:** `~/code/anthropic-leaked-source-code/` analysis
**Date:** 2026-08-03

---

## 1. Dangerous/Uncached Prompt Sections API

**Pattern:** Two-tier prompt section registration — `systemPromptSection()` (memoized, cache-safe) vs `DANGEROUS_uncachedSystemPromptSection(computeFn, reason)` (recomputed every turn, requires human-readable justification string).

**Why it works:**
- `DANGEROUS_` prefix + mandatory `reason` arg = code-review guardrail. You must explain why this section can't be cached.
- Cache-fragmentation (2^N variants) treated as first-class bug class. Every `reason` is grep-able during perf audits.
- `resolveSystemPromptSections` batches `Promise.all`; `clearSystemPromptSections()` on `/clear` or `/compact`.

**Source files:**
- `constants/systemPromptSections.ts` — memoized section registry
- `constants/prompts.ts` — `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` sentinel

**Opencode applicability:** System context composition (CLAUDE.md, git status, MCP tools, session vars). Current approach has no cache-awareness. Add `cached_section()` / `uncached_section(reason)` to context builder.

**Existing plugin overlap:** None. Neither prompt-registry (versions store opaque blobs with no cache-scope field) nor semantic-cache (response-cache, not prompt-prefix cache) touch this. Absent everywhere.

**Effort:** Low · **Risk:** Low · **Impact:** High (prompt-cache savings)

---

## 2. YOLO Classifier — AI-as-Guardrail

**Pattern:** A second LLM call classifies tool actions before execution. Two-stage:
1. **Fast** (max_tokens=64, stop_sequences, temp=0) → immediate yes/no
2. **Thinking** (max_tokens=4096 + CoT) → only on BLOCK, deeper analysis

**Key design choices:**
- **Fail-closed:** any parse failure, API error, unavailability → `shouldBlock: true`
- **Iron gate:** `tengu_iron_gate_closed` GrowthBook config (30-min refresh) selects fail-closed vs fail-open on classifier unavailability
- **Transcript hardening:** assistant text stripped from classifier input — only `user` + `tool_use` blocks. Hostile content JSON-encoded to prevent line forgery.
- **Safe-tool allowlist:** `SAFE_YOLO_ALLOWLISTED_TOOLS` (read/search/task/plan) skip classifier entirely
- **Cost telemetry:** classifier token delta vs main loop tracked; alert if p95 > 1.0 (classifier bigger than main loop)
- **Denial tracking:** max 3 consecutive / 20 total → fallback to prompting or `AbortError`

**Source files:**
- `utils/permissions/yoloClassifier.ts` (1300+ lines)
- `classifierShared.ts`, `classifierDecision.ts`, `denialTracking.ts`

**Opencode applicability:** Replace all-or-nothing `--approval-mode` with LLM-classified permission gating. Implement as plugin — classifier is a separate model call, not core runtime.

**Existing plugin overlap:**
- **guardrail-chain:** Partial — `PromptGuard` does deterministic regex injection-checking (5 patterns) at Warn level. `PathValidator` does realpath containment. BUT: no LLM, no fail-closed, no two-stage thinking, no safe-tool allowlist, no cost telemetry, no denial tracking. guardrail-chain gates *content*, not *tool actions*.
- **tier-router:** Partial — `LlmClassifier` classifies prompts into model tiers (fable/haiku/sonnet/opus) with keyword + LLM two-stage. BUT: fail-open (null → keyword pass-through), no deep-reason second stage, no blocking semantics, no iron-gate config.
- **Gap:** A tool-action security classifier with fail-closed + two-stage CoT + iron gate + cost telemetry is entirely missing. guardrail-chain (regex) + tier-router (routing classifier) provide pieces, but the full YOLO pattern requires a new plugin or substantial guardrail-chain extension.

**Effort:** High · **Risk:** Medium (API cost, latency) · **Impact:** Very High

---

## 3. Circuit Breakers on Critical Paths

**Pattern:** Explicit failure thresholds with state tracking on every critical loop.

| Breaker | Threshold | On Trigger | Rationale |
|---------|-----------|------------|-----------|
| Auto-compact | 3 consecutive failures | Stop compacting, keep original | Real telemetry: sessions with 50+ failures wasting ~250K calls/day |
| Classifier unavailability | Iron gate config | Fail-closed or fallback-to-prompt | 30-min refresh gate; no stale decisions |
| Denial limits | 3 consecutive / 20 total | Prompt user or AbortError | Prevents infinite retry loops on denied actions |
| Auto-mode gates | GrowthBook toggle | Strip dangerous permissions, disable auto | Circuit-break = transform function applied to fresh context (avoids stale-snapshot races) |

**Key pattern:** `verifyAutoModeGateAccess` returns `(ctx) => ctx` transform function — not a boolean — applied against fresh context to prevent async stale-snapshot races.

**Source files:**
- `services/compact/autoCompact.ts` — `MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3`
- `utils/permissions/denialTracking.ts`
- `utils/permissions/yoloClassifier.ts` — iron gate

**Opencode applicability:** Tool retry loops, auto-compact equivalents, permission mode transitions. Add `CircuitBreaker` utility with configurable thresholds + stale-snapshot-safe transforms.

**Existing plugin overlap:**
- **tier-router:** Partial — `BudgetTracker` implements session token budget with ceiling+exhaustion threshold (monotonic 500K). BUT: budget-based, not consecutive-failure-based; no transform-function pattern; no auto-compact, denial, or classifier-unavailability breakers.
- **session-lifecycle:** None — tracks edits/commits/archival, surfaces errors to `hook-errors.log`, but has no failure thresholds, no retry-loop protection, no compaction. Natural host for the auto-compact breaker (already knows session idle state).
- **Gap:** A general `CircuitBreaker` utility + auto-compact breaker in session-lifecycle + denial tracking + iron-gate config for classifiers is absent.

**Effort:** Medium · **Risk:** Low · **Impact:** High (reliability)

---

## 4. AI-as-Moderator for Memory (Background Distillation) — ✅ DONE + ENHANCED

**Pattern:** Two-layer memory system with background agents.

**Existing plugin:** **agentmem implements all pillars:**
- Inline conditional writes: `save-memory` + `classifyMessage` LLM pre-filter
- Background extract: `memory-keeper` sub-agent (launched at session idle)
- Nightly consolidation: `memory-dreamer` sub-agent (24h auto-run, `DREAM_INTERVAL_MS`)
- Guardrails: `QualityGateRunner` 7 gates (frontmatter, size, code-exclusion, type-consistency, duplicate, hook-quality, secrets — reusing guardrail-chain's SecretScanner)
- 4 memory types (user/feedback/project/reference) + subtypes
- MEMORY.md index cap: 200 lines / 25KB
- Recall trust: `ModelTrustTracker` (TRUSTED/SUSPICIOUS/DISTRUSTED per correction rate), `MemoryLifecycle` (confidence*model-tier decay), injection with "verify against current state" framing

**Added in ec448e0 (Aug 3):**
- **Per-session token budget:** `MemoryBudget.java` (394 loc) — 12,000 token ceiling per session, 2,000 per section. Priority-weighted allocation (user > feedback > project > reference), weighted by confidence × model-tier trust. Atomic JSON persistence to `.agentmem/.sessions/`. Exhaustion + delta reinjection modes.
- **Live file-existence verification:** `MemoryVerifier.java` (198 loc) — extracts file paths from memory content via regex, checks `Files.exists()`, generates STALE/OK tables, annotates injected memories with stale warnings.
- **`memory-verifier` subagent** (41 loc) — 3-step recall-time verification workflow.
- **New tools:** `verify-memory-files`, `verify-memory-report`, `memory-budget-status` (opencode); `agentmem-verify-files` (pi).

**Effort:** — · **Risk:** — · **Impact:** — (already built, now enhanced)

---

## 5. Centralized Permission Modes

**Pattern:** Six modes with centralized transition point:

| Mode | Symbol | Behavior |
|------|--------|----------|
| `default` | · | Ask for each tool use |
| `plan` | P | Read-only + plan-generation tools |
| `acceptEdits` | A | Auto-accept edits in CWD |
| `bypassPermissions` | ! | Skip all tool prompts (dangerous) |
| `dontAsk` | ⊘ | Silent blocking |
| `auto` | ∞ | Full auto (ant-only, feature-gated) |

**Key design:**
- `transitionPermissionMode(mode)` is the single entry point — CLI (shift-tab), SDK (`set_permission_mode`), and carousel all use it.
- `stripDangerousPermissionsForAutoMode` stashes/restores dangerous allow-rules on mode transitions.
- BYPASS_IMMUNE safety checks (`.git/`, `.claude/`, shell configs) always prompt, even in `bypassPermissions`.

**Source files:**
- `utils/permissions/permissions.ts` — `hasPermissionsToUseToolInner` (layered gate)
- `permissionSetup.ts`, `PermissionMode.ts`

**Opencode applicability:** Currently binary (approve/deny). Add mode spectrum with centralized dispatcher. Implement as plugin extending tool-permission hook.

**Existing plugin overlap:** None. guardrail-chain does content-checking (regex), not permission-mode gating. Tier-router routes prompts by model tier, not tool permissions. No existing plugin implements permission-mode transitions, BYPASS_IMMUNE checks, or mode-specific tool allow/deny lists.

**Effort:** Medium · **Risk:** Medium · **Impact:** High

---

## 6. Plugin Marketplace with Anti-Impersonation

**Pattern:** Full package distribution system with security hardening.

**Architecture:**
- `PluginIdSchema` = `name@marketplace` (resolves to source: npm/github/git/local)
- `PluginManifestSchema` (Zod v4) — declares components: `skills`, `hooks`, `commands`, `agents`, `mcpServers`, `outputStyles`, `lspServers`, `settings`
- Versioned cache: `~/.claude/plugins/cache/{marketplace}/{plugin}/{version}/`
- `userConfig` — plugins declare configurable options (string/number/boolean/directory/file), prompted at enable time, available as `${user_config.KEY}`

**Anti-impersonation:**
- `ALLOWED_OFFICIAL_MARKETPLACE_NAMES` (allowlist)
- `BLOCKED_OFFICIAL_NAME_PATTERN` (deny-pattern for lookalikes)
- Homograph detection (Unicode confusable detection)
- `OFFICIAL_GITHUB_ORG='anthropics'` with `validateOfficialNameSource()`

**Source files:**
- `types/plugin.ts` — type definitions
- `utils/plugins/schemas.ts` (1681 lines, Zod v4)
- `utils/plugins/pluginLoader.ts` (3302 lines)
- `utils/plugins/marketplaceManager.ts` (2643 lines)
- `utils/plugins/pluginBlocklist.ts`

**Opencode applicability:** Replace current filesystem-dir plugin model with marketplace system. Add Zod schema validation, versioning, anti-impersonation.

**Existing plugin overlap:** None at this architectural layer. Current plugins use `.claude-plugin/plugin.json` manifests (name/description/version/author/tags only) and are distributed as flat directories — no marketplace resolution, no versioned cache, no anti-impersonation, no `userConfig`, no `name@marketplace` ID schema. prompt-registry has versioned prompt storage (WAL, file-lock, atomic writes) — pattern-shared robustness, not marketplace overlap.

**Effort:** Very High · **Risk:** High · **Impact:** Very High (ecosystem)

---

## 7. `@include` Directive for Instruction Files — ✅ DONE

**Pattern:** Memory files (CLAUDE.md) can include external files via `@path` syntax.

**Implementation:**
- `shared/claudemd.ts` (480 loc) — hand-rolled markdown token walker, HTML comment stripping, circular-ref detection (DAG-safe: visited.delete after each branch), realpath containment (path traversal blocked), realpath extension check (symlink-extension spoofing blocked), 2MB file size limit, max depth 16
- `context-includes/opencode/index.ts` (54 loc) — plugin that reads `CLAUDE.md`/`AGENTS.md` from project root at `session.created`, resolves `@include` directives via `parseClaudeMd(file, rootDir)`, injects merged result as no-reply prompt push
- `TEXT_FILE_EXTENSIONS` — whitelisted extensions (60+ text formats), blocks binary/large file inclusion

**Security (3 adversarial review rounds converged):**
- Code fence exclusion: ``` ``` ``` and `~~~` blocks skipped; inline `` ` `` codespans skipped
- HTML comment exclusion: `<!-- -->` stripped before extraction; unclosed `<!--` treated as comment-to-EOL
- Path traversal blocked: `realpathSync` containment check on child includes only (root file may be symlinked-in)
- Symlink spoofing blocked: extension check runs on realpath target, not link name
- Circular references detected: visited set with DAG-safe delete-after-branch pattern
- Same-line `<!-- --> @path` correctly resolved (line-level stripHtmlComments before marker comparison)
- Literal `@` lines in included files preserved verbatim on not-found (no cascade abort)
- Triple-at `@@/path` syntax for repo-root-relative resolution

**Syntax examples:**
```
@./docs/style-guide.md
@~/global-rules.md
@@/shared/project-rules.md  (repo-root-relative)
```

**Usage:** Add `"./context-includes/opencode/index.ts"` to `opencode.json` plugin array. Place `CLAUDE.md` in project root with `@./path` directives.

**Effort:** Low · **Risk:** Low · **Impact:** Medium

---

## 8. 5-Tier Config Cascading Merge

**Pattern:** Layered config sources with deep-merge semantics:

```
plugin → userSettings → projectSettings → localSettings → flagSettings → policySettings
```

**Key design:**
- `lodash.mergeWith` + custom `settingsMergeCustomizer`
- Arrays **concatenated + deduplicated** (not replaced)
- `undefined` used as delete marker (not `delete` keyword)
- Managed drop-ins: `managed-settings.d/*.json` sorted alphabetically, later wins (systemd/sudoers convention)
- **Auth-loss guard:** `wouldLoseAuthState()` refuses to write defaults over existing good config
- Timestamped backups before every write (`~/.claude/backups/`), capped at 5, throttled ≥60s
- Lockfile writes (`lockfile.lockSync`) to prevent concurrent-process corruption
- Files written `mode: 0o600`, BOM-stripped on read

**Trust model:**
- `projectSettings` (committed to repo) = UNTRUSTED for dangerous settings
- `policySettings` (managed/enterprise) overrides everything — org policy always wins

**Source files:**
- `utils/settings/settings.ts` — `loadSettingsFromDisk`
- `utils/settings/constants.ts` — source hierarchy
- `utils/config.ts` — `saveConfigWithLock`, backups, auth-loss guard

**Opencode applicability:** Current config is flat JSON. Add deep-merge with source tracking + org-policy override layer. Backups + lockfiles for reliability.

**Existing plugin overlap:** None at the multi-source merge layer. prompt-registry uses lockfiles + atomic writes (pattern-shared robustness, not config-cascade). session-lifecycle uses file-lock-protected TSV writes. guardrail-chain's `GuardConfig` is a single-file JSON. No existing plugin implements layered config sources with deep-merge, source tracking, or policy-override semantics.

**Effort:** Medium · **Risk:** Low · **Impact:** Medium

---

## 9. Transcript Exclusion for Safety Classifiers

**Pattern:** When feeding conversation into a safety/security classifier (or any analysis pipeline), strip the assistant's text output — only `user` messages and `tool_use` blocks pass through.

**Why:**
- Assistant text is under the model's control → could contain prompt-injection against the classifier
- `tool_use` blocks are JSON-structured → hostile content is JSON-encoded, can't forge `{"user":"..."}` lines
- Simple pattern, big defensive win

**Additional hardening:**
- Unicode smuggling defense: `parseDeepLink.ts` strips hidden Unicode chars
- MCP/team memory path validation throws on traversal attempts
- Subprocess env scrubbing in CI: strips `ANTHROPIC_API_KEY`, `AWS_*`, `ACTIONS_ID_TOKEN_*` from child-process env

**Source files:**
- `utils/permissions/yoloClassifier.ts` — `buildTranscriptEntries`
- `utils/subprocessEnv.ts` — CI env scrubbing
- `utils/deepLink/parseDeepLink.ts` — Unicode smuggling

**Opencode applicability:** Any feature that feeds conversation to a secondary model (classifier, memory extractor, summarizer). Low-effort security hardening.

**Existing plugin overlap:** None. guardrail-chain's `check-injection` scans a single prompt string (regex-only), never feeds a classifier input from a transcript, and never separates assistant text from user/tool blocks. Grep for `transcript`/`assistant`/`tool_use` across its Java source returned nothing. agentmem's `classifyMessage` feeds single messages to an LLM gate, also without transcript-stripping. tier-router's classifier receives pre-rewritten prompt text, not full transcripts. This hardening pattern is absent everywhere.

**Effort:** Very Low · **Risk:** None · **Impact:** Medium (security)

---

## 10. Cache-Fragmentation Awareness in Prompt Construction — ✅ DONE

**Pattern:** A sentinel string (`__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__`) splits the system prompt:

| Block | Scope | Content |
|-------|-------|---------|
| **Before marker** | `cacheScope: 'global'` | Static rules, tool descriptions, tone/style, core instructions |
| **After marker** | `cacheScope: null` (uncached) | Session guidance, memory, language, output-style, MCP servers, token budget, brief mode |

**Implementation:**
- `shared/cache-boundary.ts` — `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` sentinel, `cachedSection(content)`, `uncachedSection(content, reason)`, `orgCachedSection(content)`, `buildPromptWithBoundary(sections[])`, `tagSection(content, scope)`, `isDynamicBoundary(line)`, `reportScopeBreakdown(sections[])`
- `prompt-registry/PromptVersion.cacheScope` field — `"global"`, `"org"`, or `null` (uncached), stored in version JSON, parsed on read. Backward-compatible: 5-arg constructor defaults to `"global"`.
- `knowledge-graph/opencode/index.ts` — session-start header + overview injected as `cachedSection()`, per-file subgraph injections as `uncachedSection("per-file subgraph injection on read/edit")`

**Effort:** Low · **Risk:** Low · **Impact:** Medium (prompt-cache savings)

---

## Summary Matrix

| # | Feature | Effort | Risk | Impact | Overlap Status | Action |
|---|---------|--------|------|--------|----------------|--------|
| 1  | Uncached prompt section API | Low | Low | High | **None** (absent everywhere) | **New implementation** |
| 2  | YOLO classifier | High | Medium | Very High | **Partial** (guardrail-chain regex + tier-router routing classifier) | **New plugin** — extend guardrail-chain with LLM classifier + fail-closed |
| 3  | Circuit breakers | Medium | Low | High | **Partial** (tier-router token budget; session-lifecycle idle tracking) | **New utility** — add budget/denial/compact breakers |
| 4  | AI-as-Moderator for Memory | — | — | — | **FULL + ENHANCED** (agentmem implements all pillars + budget + verifier) | **Skipped** — agentmem already ships it; enhanced with budget + verifier |
| 5  | Permission modes | Medium | Medium | High | **None** (absent everywhere) | **New plugin** |
| 6  | Plugin marketplace | Very High | High | Very High | **None** (flat dirs, no marketplace infra) | **New infrastructure** |
| 7  | `@include` directive | Low | Low | Medium | **DONE** | **Implemented** — shared/claudemd.ts (480 loc, token walker + containment) + context-includes/ plugin (session-start injector) |
| 8  | Cascading config merge | Medium | Low | Medium | **None** (single-file JSON per plugin) | **New implementation** |
| 9  | Transcript exclusion | Very Low | None | Medium | **DONE** | **Implemented** — TranscriptFilter.java (zero-dep JSON parser, 286 loc, 13 tests) + guardrail-chain opencode tool |
| 10 | Cache-fragmentation boundary | Low | Low | Medium | **DONE** | **Implemented** — shared/cache-boundary.ts + prompt-registry cacheScope + knowledge-graph static/dynamic split |

**Priority order (cost/value):**
- **Phase 1 (immediate):** 1, 7 ✅, 9 ✅, 10 ✅ — net-new, low-effort, high-security
- **Phase 2 (medium):** 3, 5, 8 — architectural additions, partial existing infrastructure
- **Phase 3 (large):** 2 (extend guardrail-chain), 6 (marketplace infra)
- **Skip:** 4 ✅ (agentmem already ships it, enhanced with budget + verifier)

## Implementation Cost Ranking (Easiest → Hardest)

Ranked by: scope of new code, dependency surface, API integration depth, verification complexity.

| Rank | # | Feature | Order-of-magnitude | What's involved |
|------|---|---------|---------------------|-----------------|
| 1 | **10** | Cache-fragmentation boundary | ✅ Done | **Done:** `shared/cache-boundary.ts` (63 loc) — sentinel, `cachedSection()`/`uncachedSection()`/`orgCachedSection()`, `buildPromptWithBoundary()`, `tagSection()`, `reportScopeBreakdown()`. **Integrated:** prompt-registry `PromptVersion.cacheScope` (null/global/org), knowledge-graph static overview cached + per-file injections uncached. |
| 2 | **9** | Transcript exclusion | ✅ Done | **Done:** `TranscriptFilter.java` (286 loc, 13 tests) — zero-dep JSON parser, escape-aware, fail-closed on malformed/non-string/missing roles. Normalizes case+whitespace. Size bounds (10MB/1K messages). **Exposed:** CLI subcommand (`transcript-filter`), guardrail-chain opencode tool, guardrail-chain pi tool. |
| 3 | **7** | `@include` directive | ✅ Done | **Done:** `shared/claudemd.ts` (480 loc) — hand-rolled markdown token walker, HTML comment stripping, DAG-safe circular-ref detection, realpath containment, realpath extension check, TEXT_FILE_EXTENSIONS allowlist, 2MB/16-depth limits. `context-includes/opencode/index.ts` (54 loc) — plugin injects resolved CLAUDE.md at session.created. 3 adversarial review rounds converged. |
| 4 | **1** | Uncached prompt section API | ~200 loc | Registry of `section(name, fn)` + `uncached(name, fn, reason)`. `resolveSections()` batch. `clearSections()` on compact. Pure internal API. *Note: cache-boundary.ts implements the boundary mechanism; the registry is the missing piece.* |
| 5 | **3** | Circuit breakers | ~400 loc | `CircuitBreaker<T>` class (threshold + transform). Wire into 4 points: tier-router classifier, session-lifecycle compact, tool denial loop, auto-mode. Moderate integration surface. |
| 6 | **8** | Cascading config merge | ~500 loc | 5-source deep merge, drop-in dir, array concatenation, `undefined`-as-delete, lockfile writes, backup rotation, auth-loss guard. Multiple file formats. |
| 7 | **5** | Permission modes | ~600 loc | 6-mode state machine, centralized `transitionMode()`, tool allow/deny lists per mode, BYPASS_IMMUNE checks, mode-strip/restore on transitions. Deep opencode runtime integration. |
| 8 | **2** | YOLO classifier | ~1000 loc | LLM call with two-stage (fast 64tok + thinking 4096tok CoT), XML parsing, fail-closed, iron gate, safe-tool allowlist, cost telemetry, denial tracking, transcript projection per tool. |
| 9 | **6** | Plugin marketplace | ~2000+ loc | Full `name@marketplace` resolution, Zod v4 manifest schema, npm/github/git installers, versioned cache dirs, anti-impersonation (homograph, allowlist, org-verify), plugin blocklist, userConfig prompting, auto-update. |

### Clusters

| Tier | Features | Time-to-ship | Dependency risk | Status |
|------|----------|--------------|-----------------|--------|
| **Done** | #10 boundary, #9 transcript, #4 agentmem enh., #7 @include | — | — | ✅ shipped |
| **Trivial** (hours) | — | 1 session | — | Phase 1 complete |
| **Light** (1–2 sessions) | #1 uncached API, #3 breakers | 1–2 sessions | Internal API design; #3 needs integration across 3-4 plugins | |
| **Medium** (3–5 sessions) | #8 config merge, #5 permission modes | 1–2 weeks | #5 depends on opencode runtime hooks; #8 is self-contained | |
| **Heavy** (2+ weeks) | #2 YOLO classifier | 2–4 weeks | LLM cost/latency tradeoffs, iron-gate config, per-tool projection schemas | |
| **Platform** (1+ month) | #6 marketplace | 4–8 weeks | Package distribution infra, security review, ecosystem migration | |

### Incremental build order (each layer enables the next)

```
Phase 0 (foundations):  #10 boundary ✅ → #1 uncached API → #8 config merge
Phase 1 (guard layer):  #9 transcript ✅ → #7 @include ✅ → #5 permission modes
Phase 2 (resilience):   #3 circuit breakers
Phase 3 (intelligence): #2 YOLO classifier
Phase 4 (ecosystem):    #6 plugin marketplace
```

### Plugin enhancement tasks (ranked by effort)

| Pri | Plugin | Task | Effort | Status |
|-----|--------|------|--------|--------|
| 1 | guardrail-chain | Add transcript-exclusion utility (#9) | Very Low (~30 loc) | ✅ Done — `TranscriptFilter.java` (286 loc, 13 tests) + tool integrations |
| 2 | prompt-registry | Add `cacheScope` field to prompt versions (#10) | Low (~40 loc) | ✅ Done — `PromptVersion.cacheScope` (null/global/org), 27 test loc |
| 3 | knowledge-graph | Classify static overview cached, dynamic injections uncached (#1/#10) | Low (~50 loc) | ✅ Done — static header+overview as cachedSection(), per-file subgraph as uncachedSection() |
| 4 | session-lifecycle | Add auto-compact breaker (#3) | Medium (~100 loc) | |
| 5 | tier-router | Circuit-breaker on classifier fallback (#3) | Medium (~120 loc) | |
| 6 | agentmem | Per-session memory token budget + optional live-verification agent (#4) | Medium (~200 loc) | ✅ Done — `MemoryBudget.java` (394 loc), `MemoryVerifier.java` (198 loc), `memory-verifier.md` (41 loc), budget + verification tools |
