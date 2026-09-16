# Premium-Read Offload — Design Document

Our own OpenCode implementation of the [`shunt`](https://github.com/spotify/portal-ai-plugins/tree/main/plugins/shunt)
pattern: offload bulk file reads from premium subscription sessions to a cheap
DeepSeek worker.

Status: **DESIGN COMPLETE.** Decisions settled (§10); one premise empirically
verified (cache, §5). Remaining risks are implementation-time, not design-time
(§9): worker summarization quality on real code.
Placement: **standalone plugin** (see §7). Enforcement: **level 4** (hard gate
with explicit escapes).

Revision note: this supersedes the first draft. The first draft priced only
DeepSeek pay-as-you-go and concluded the technique did not pay. Further
research (subscriptions, provider caching, offload target) **reverses that
verdict**: the technique pays when the session runs on a *premium subscription
model* (Kimi K3, GLM-5.3) and offloads to DeepSeek Flash. Details below.

## 1. What shunt is

Claude Code plugin. Three layers (source: `~/code/vendor/portal-ai-plugins/plugins/shunt`):

| Layer | Mechanism | File |
|-------|-----------|------|
| Hard gate | PreToolUse hook blocks `Read` on files > `SHUNT_MIN_LINES` (350) unless `offset`/`limit` set | `hooks/check-file-size` |
| Hard gate | PreToolUse hook blocks `cat`/`head`/`tail`/`less`/`more` on large files; allows pipes, redirects, flags | `hooks/check-bash-read` |
| Transport | `bulk-read`/`code-write` shell scripts → `aika:invoke-chat` via Portal CLI | `scripts/` |
| Soft | Skills tell Claude when/how to call the scripts | `skills/*/SKILL.md` |

Core premise: file corpora go to a **cheap external worker**, never into the
main model's context. Claimed savings 82–94% on 4K–7.4K-line reads vs. Claude
Opus.

Two architectural choices matter for us and both are **rejected** here:

1. **Ephemeral one-shot transport.** `aika:invoke-chat` stores nothing
   server-side; every call re-sends the full corpus. This forfeits worker-side
   prompt caching entirely (§5). Our design uses a **persistent worker**.
2. **No escape hatch.** The hook blocks unconditionally (offset/limit aside).
   Our design keeps a hard gate but adds an **explicit escape** (§7).

## 2. Does our repo have an equivalent?

**No.** Verified against all 20+ plugins. Closest neighbors and why they are
not it:

| Plugin | Mechanism | Why not this |
|--------|-----------|--------------|
| `graphrag` | Cheap-model entity/summary extraction | Offline **index time** over exported docs, not a live `Read` gate |
| `semantic-cache` | Pointer file + lazy read | Reader is the **same session**; saves duplicate prompts, not read tokens |
| `agentmem` | `opencode run --model deepseek-flash` child sessions | Purpose is memory maintenance, not bulk reads |
| `tier-router` | Classifies prompt → routes to cheaper **tier agent** | Routes the task; does not intercept or offload `Read`. Independent of this design (we read the same model IDs, not its state) |
| `knowledge-graph` | Deterministic zero-LLM graph | No LLM, no read delegation |
| `sdlc-guardrails` / `permission-modes` | `tool.execute.before` blockers | Policy gates on write/edit, not size-based read offload |

**Gap confirmed.** No size-based `Read`/`Bash cat` gate; no bulk-reader
delegation; no external-model read offload.

## 3. Subscriptions and roles (the corrected economic base)

The decisive difference from the first draft: the premium models are consumed
via **subscriptions**, so marginal cost is **quota**, not dollars.

| Subscription | Models | Role in this design |
|--------------|--------|---------------------|
| **Kimi Allegretto** | `k3` (1M ctx), `k3-256k`, `kimi-for-coding`, `kimi-for-coding-highspeed` | **Premium session** — quota to preserve |
| **ZAI GLM Coding Plan (Lite-Yearly)** | `GLM-5.3`, `GLM-5.3-Flash` | Both premium pool (credits, non-rollover); offload sources |
| **DeepSeek** | `deepseek-flash`, `deepseek-v4-pro` | **Cheap offload worker pool** (flash), plus capable mid model (v4-pro) |

### Quota mechanics (researched)

**Kimi Allegretto** — quota refreshes **weekly**, plus a rolling **5-hour rate
window**; shared across CLI/VS Code/API keys and Kimi web + Kimi Code. Overage
falls to **Extra Usage** credits "close to Open Platform API pricing".
Sources: `docs/en/kimi-code/membership.html`.

**GLM Coding Plan Lite** — 5-hour credits 2,000 / weekly 10,000. Credit formula:
`(in × in_mult + cached_in × cached_mult + out × out_mult) / 10,000`.

| Model | Input mult | Cached-in mult | Output mult |
|-------|-----------|----------------|-------------|
| GLM-5.3 | 6.9 | 1.7 | 24 |
| GLM-5.3-Flash | 2.3 | 0.56 | 8 |

Off-peak (outside Mon–Fri 14:00–18:00 SGT) bills at **50%**. Lite estimated
allowance at 95% cache hit: GLM-5.3 ≈ 48–97M tok/week; GLM-5.3-Flash ≈
146–292M tok/week. Sources: `docs.z.ai/devpack/overview`.

**No rollover, no fallback (verified).** The weekly quota "is refreshed and
**reset** on a 7-day cycle" — unused credits are lost. When the quota is
exhausted you wait for the next 5-hour cycle; "the system will **not** deduct
from your account balance." The Coding Plan also **cannot be used outside
supported tools**, and only `GLM-5.3` / `GLM-5.3-Flash` are callable under it —
so credits are strictly zero-sum with no pay-as-you-go escape hatch. Source:
`docs.z.ai/devpack/faq`.

Policy consequence (user decision): **preserve ZAI credits for reasoning**;
offload mechanical bulk reads off the ZAI pool to DeepSeek, accepting that some
unused weekly credits may be wasted rather than spent on reads.

**DeepSeek pay-as-you-go** — real prompt cache:

| Model | Miss in | Hit in | Out |
|-------|---------|--------|-----|
| deepseek-flash | 0.22 | 0.007 | 0.66 |
| deepseek-v4-pro | 0.66 | 0.022 | 1.98 |

(Per M tokens; off-peak. Source: `tier-router/skill-axis-mapping.json:8-9`.)

### Why premium→DeepSeek offload pays

1. **Separate quota pools.** DeepSeek usage does not cannibalize Kimi or ZAI
   quota. Offloading converts premium-quota pressure into cheap DeepSeek spend.
2. **The pain is throttling, not dollars.** Kimi's 5-hour window and ZAI's
   credit limits *stall work*. Preserving premium quota for reasoning is the
   real benefit.
3. **K3 and GLM-5.3 are genuinely expensive** at overage: K3 $3/$15 per M;
   GLM-5.3 6.9/24 credits (3× Flash). Offload targets are far cheaper.
4. **DeepSeek has a deep cache discount** (~31× input), so a persistent worker
   makes repeated reads near-free (§5).

## 4. Caching: the effect on the decision

Two distinct caches, pulling in opposite directions.

### 4a. Main-session prompt cache (shrinks the naive saving)

Cached input is far cheaper than miss:

| Model | Miss in | Hit in | Ratio |
|-------|---------|--------|-------|
| deepseek-flash | 0.22 | 0.007 | ~31× |
| deepseek-v4-pro | 0.66 | 0.022 | ~30× |
| kimi-k3 | 3.00 | 0.30 | **10×** |
| GLM-5.3 | 6.9 | 1.7 | ~4× |
| GLM-5.3-Flash | 2.3 | 0.56 | ~4× |

A file read once is a miss; re-referenced across turns it becomes a hit.
shunt's 82–94% is measured against **miss** prices, so on re-reads the true
saving is smaller. But note Kimi's discount is only **10×** versus DeepSeek's
~31× — K3 stands out as expensive even cache-hit, strengthening the case to
offload *away from K3*.

### 4b. Worker-side cache (the reason to reject shunt's ephemerality)

shunt's `invoke-chat` is one-shot and stateless: the worker **never** gets a
cache hit, and a follow-up re-sends the whole corpus as another miss. The
design deliberately trades worker cache reuse for context hygiene.

**We do the opposite.** Because everything offloads to **one** provider
(DeepSeek), a **persistent worker session** keeps the corpus at the front of
its context; DeepSeek's automatic prefix cache then serves follow-ups at
~$0.007/M. There is no cross-provider cache problem because there is only one
offload provider.

**Consequence:** the design must use a **stateful worker** (reused session),
not shunt's ephemeral call. This is the single most important deviation from
shunt.

## 5. Cache question — RESOLVED (verified empirically)

**Does opencode's prompt cache hit across successive requests from a
persistent worker session? YES — measured 2026-09-13.**

DeepSeek's cache is automatic and prefix-based. `opencode run -s <session-id>`
resumes a stored session, and a resumed worker gets real cache hits.

Probe: 6,301-line / 247 KB synthetic file attached to `deepseek/deepseek-flash`,
three `opencode run` invocations against one session.

| Turn | Action | Input (miss) | Cache read (hit) | Cost |
|------|--------|-------------|------------------|------|
| 1 | attach corpus + "ACK1" | 29,111 | 1,664 | $0.004373 |
| 2 | resume, **re-attach same corpus** + "ACK2" | 19,241 | 30,720 | $0.002980 |
| 3 | resume, **no re-attach**, follow-up question | **191** | **49,792** | **$0.000179** |

Turn 3: **99.6% cache-hit**; cost **4% of turn 1** (~24× cheaper). The corpus is
loaded once; follow-ups are near-free.

**Conclusions:**
1. A persistent worker **is expressible**: `opencode run -s <id>` resume, no
   long-lived process required.
2. The worker must be **one session per corpus/task, reused across follow-ups**.
   A fresh `opencode run` per call (shunt's model) would re-miss every time.
3. The expensive step is **loading a corpus** (~$0.004 for 6K lines);
   subsequent questions ~$0.0002 each.
4. Re-attaching the corpus each turn re-misses the new bytes (turn 2: 19k miss);
   hold the corpus in-session instead.

This strengthens the case for the design: a premium session pays K3/GLM rates
for a corpus **once**; the DeepSeek worker holds it and answers follow-ups at
~99% cache-hit.

## 6. What gets offloaded

| Input | Offload? | Why |
|-------|----------|-----|
| Bulk read of a large file on a **K3 or GLM-5.3** session | **Yes** (gate) | Premium quota saved |
| Bulk read on a **GLM-5.3-Flash** session | **Yes** (gate) | ZAI credits are zero-sum and non-rollover; preserve them for reasoning |
| Cross-file synthesis (3+ files, summary needed) | **Yes** (`offload-read`) | Corpus out of premium context |
| Boilerplate generation | **Yes** (`code-write`) | Parity with shunt; generation goes to the cheap worker, not premium output tokens |
| Read on a **deepseek-flash / v4-pro** session | **No** (allowed) | No gap — same pool; overhead only |
| Read preceding an **edit** | **Allowed via `allow-direct-read` (or `offset`/`limit`)** | Exact content must be in the main context; the agent signals edit intent explicitly |
| Targeted read (`offset`/`limit` ≤ cap), pipes, redirects | **No** (allowed) | Already cheap |
| Small file | **No** (allowed) | Overhead exceeds benefit |

Note the column distinguishes **gated** (blocked by default) from **delegated**
(the `offload-read` path the agent is pushed toward).

**Resolved:** GLM-5.3-Flash is an offload **source**, not a target. It is
3× cheaper than GLM-5.3 but still draws on finite, non-rollover ZAI credits
with no pay-as-you-go fallback (§3), whereas DeepSeek Flash is pay-as-you-go
with a ~31× cache discount. All three premium pools — Kimi K3, GLM-5.3,
GLM-5.3-Flash — offload mechanical bulk reads to DeepSeek.

## 7. Recommended design

A **standalone OpenCode plugin** (`premium-read-offload`) with a **level-4
enforcement gate**: hard-block bulk reads by default, with an explicit escape.

### Why standalone (not a tier-router feature)

The design needs exactly one datum — the active session's provider/model — and
that is available to **any** plugin via the `chat.message` hook
(`input.model.{providerID,modelID}`). It does **not** need tier-router's state,
tier mapping, or load-order. A standalone plugin therefore:

- has no load-order dependency and no coupling to tier-router internals;
- fails independently (a tier-router bug cannot break offload, and vice versa);
- is reusable with or without tier-router installed.

Cost of standalone: it duplicates the provider/model allow-list (a small static
set). That is cheaper than the coupling.

### Enforcement: level 4 (hard gate + explicit escape)

Reason: pure instructions are not reliable — the LLM may ignore them. A tool
boundary (`tool.execute.before`) is enforceable and the model cannot route
around it. We block unbounded bulk reads hard, but allow a compliant escape for
cases that genuinely need exact content.

**The gate must supply a replacement, or it is a dead end.** A blocked `read`
throws (`tool.execute.before` returns `Promise<void>`; throw = denial —
confirmed in `@opencode-ai/plugin@1.18.21` `index.d.ts:235`). If we block
without an alternative, the agent is stuck. Therefore the plugin **registers an
offload tool** the agent is directed to:

This tool drives the persistent DeepSeek worker (§5) and returns the worker's
answer to the main session. A blocked read's thrown message names this tool.
Tool signature (opencode plugin tools take a JSON args object):

```
offload-read(question: string, paths: string[]) -> string
allow-direct-read(path: string, reason: string) -> void
```

**Semantic caveat the agent must be told:** `offload-read` returns a **derived
answer/summary**, not file bytes. It is correct for *understanding*
("what does this service do?", "which methods call the DB?") and wrong for
*editing* (the agent needs exact content). The thrown block message states this
so the agent chooses deliberately between `offload-read` and a targeted
`read` with `offset`/`limit`.

| Path | Mechanism | Enforced? |
|------|-----------|-----------|
| Unbounded large `read` on a premium session | `tool.execute.before` **throws**, message directs to `offload-read` | **Yes** |
| Agent calls `offload-read` | Registered plugin tool → persistent DeepSeek worker | **Yes** |
| Agent calls `allow-direct-read` first, then `read` | Plugin tool records a one-shot permission for the next read | **Yes** (escape) |
| Agent re-runs `read` with `offset`/`limit` | Allowed through | **Yes** (escape) |
| Small file / deepseek session / pipe / redirect | Allowed through | **Yes** |
| Agent silently reasons over big context it already holds | — | **No** (no tool boundary; documented gap) |

The last row is an acknowledged limit, shared with shunt. It can be partially
mitigated by a `chat.message` notice, but not enforced.

**Why the escape is a tool, not a `read` argument.** `output.args` is free-form:
`tool.execute.before` can inspect and mutate it, but the built-in `read` tool
**ignores unknown keys** (verified: injecting `allowDirect`/`__injected` into
`output.args` let the read through unchanged). So the agent cannot express
consent *through* a `read` call. Consent must be a separate signal. Two viable
mechanisms:

1. **`allow-direct-read` tool** (recommended): the agent calls it with the path
   and a one-line reason; the plugin stores a one-shot token for that
   `(sessionID, path)`; the next `read` of that path passes. Logged.
2. **Env / kill switch only**: drop per-call consent; the only escapes are
   `offset`/`limit` reads and disabling the plugin. Simpler, but coarser.

Option 1 is preferred: it keeps the override deliberate, auditable, and
path-scoped, without trusting a string flag that the tool layer cannot see.

**Porous-escape caveat.** Because `offset`/`limit` reads pass (they are the
legitimate exact-content path), an agent determined to circumvent the gate could
read a large file in chunks, or pass a deliberately huge `limit`. This is
**accepted but bounded**:

- A targeted read is defined as `limit ≤ LLMHP_TARGETED_MAX` (default 2000).
  `offset`+`limit` that still cover the whole file (or exceed the cap) are
  treated as unbounded and gated.
- Chunked-read loops are detectable in the audit log and via a per-session
  counter (warn after N gated files are read in chunks).

The goal is to make the cheap path the *default* and the expensive path
*deliberate*, not to make circumvention impossible (which would break
legitimate editing).

**Bash gate.** The same dead-end rule applies: blocking `cat bigfile` with no
alternative is hostile, and the `offload-read` tool operates on paths, not shell
pipelines. The bash gate therefore:

- blocks only plain read commands (`cat`/`head`/`tail`/`less`/`more`) on a
  single large file with no pipe/redirect;
- allows pipelines and redirects (targeted or non-context operations);
- on block, throws a message that names `offload-read` (the file path is
  recoverable from the command), so the agent has a route.

If a command's file cannot be unambiguously extracted, the gate **allows**
(fail-open) rather than risk blocking a legitimate command.

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Owner | **Standalone plugin** | Only needs provider/model ID from `chat.message` (§7 above) |
| Gate | `tool.execute.before` on `read` (+ `bash` cat/head/tail) | Enforceable boundary; matches shunt's surface |
| Gate condition | Active session `providerID` ∈ {`kimi`, `kimi-for-coding`, `zai`, `zai-coding-plan`} and model ∈ {`k3`, `glm-5.3`, `glm-5.3-flash`} | Offload only when a premium pool is being spent. `kimi-for-coding` is a distinct built-in provider id from `kimi` and is the Kimi Code subscription (§14g) |
| Active-model source | Cache `chat.message` input `{sessionID, model:{providerID, modelID}}` per session | Not exposed in `tool.execute.before` |
| Replacement | **`offload-read` tool** registered by the plugin | A block without an alternative is a dead end |
| Default action | **Throw** on bulk read, message names `offload-read` | Level-4 hard gate |
| Escape 1 | Targeted read (`offset`/`limit`) allowed | Exact-content need |
| Escape 2 | **`allow-direct-read` tool** records a one-shot, path-scoped permission | Deliberate, auditable override; a `read` arg cannot carry consent (verified) |
| ZAI bias | **Aggressive**: lower threshold than Kimi | Maximize credit preservation (§3) |
| Worker | **Persistent `deepseek-flash` session** | Preserves DeepSeek prefix cache — **verified** 99.6% hit on follow-ups (§5) |
| Worker session mgmt | **One session id per corpus/task, resumed via `opencode run -s <id>`** | Cache hits require session continuity; fresh runs re-miss |
| Transport | `opencode run --model deepseek/deepseek-flash`, corpus on **stdin** | Avoids ARG_MAX; reuses `shared/safe-spawn.ts` + `NO_SUBSPAWN_ENV` |
| Worker prompt | Corpus via stdin, XML `<file path="...">` boundaries; structured bullets; verify-before-edit caveat | Mirrors shunt's bulk-reader instructions |
| Exclusions | Editing paths; small files | Preserve correctness and avoid overhead |
| Threshold | Default 1000 lines; **lower for ZAI sessions** (e.g. 400) | ZAI credit preservation; Kimi keeps the higher bar |
| Quota telemetry | **Open-loop** — always offload on ZAI/Kimi premium sessions | No Coding Plan quota API exists (checked `docs.z.ai/llms.txt`; usage is web-console only) |
| Kill switch | Env `LLMHP_PREMIUM_OFFLOAD=0` | Reversibility |

**Not recommended:** porting the Portal CLI / AiKA transport (Spotify-internal);
the ephemeral one-shot model; the argv payload approach.

### Plugin structure

Follows repo conventions (TS shim + Java ≥ 25 core + committed classes):

```
premium-read-offload/
├── opencode/
│   ├── index.ts              # shim: hooks + offload-read tool
│   └── index.test.ts         # hook/tool unit tests
├── src/main/java/eu/infolead/llmhp/offload/
│   ├── OffloadCli.java       # CLI: decide, worker-session, record
│   ├── GateDecider.java      # provider/model + size decision (pure)
│   └── WorkerStore.java      # session-id ↔ corpus mapping, WAL-atomic
├── agents/
│   └── bulk-reader.md        # worker system prompt (our version of shunt's mode)
└── build/classes/            # committed compiled Java
```

### State and session lifecycle

The plugin keeps two pieces of per-session state:

| State | Where | Why |
|-------|-------|-----|
| Active session's provider/modelID | In-memory Map keyed by `sessionID`, populated from `chat.message` | `tool.execute.before` has no model info; lost on plugin restart → **fail open** (allow the read) until the next `chat.message` re-populates |
| Corpus → worker session id | `.<plugin>/.workers/<hash>.json`, WAL-atomic (tmp → fsync → rename), same pattern as `tier-router`/`agentmem` | Worker session must survive plugin restarts to preserve cache; enables follow-up reuse |

**Fail-open on unknown state.** If the active model is unknown (fresh restart, no
`chat.message` yet), the gate **allows** the read. Offloading on an unknown model
could waste DeepSeek spend on a session that is already cheap. Correctness of
the main task outranks savings.

**Worker session reuse key.** The corpus content hash (paths + mtimes + sizes)
maps to a stored `opencode run` session id. Same corpus → same worker session →
cache hit. Changed content → new session (avoids stale summaries).

**Cleanup.** Worker sessions are opencode sessions in the DeepSeek data home;
the plugin records their ids and can prune them (`worker-prune` command) rather
than leaking throwaway sessions, mirroring `agentmem`'s `deleteMaintenanceSession`.

## 8. Verdict

- The capability **does not exist** in our repo — the gap is real.
- The first draft's "do not build" was based on DeepSeek-only pricing. With
  **premium subscription sessions** (K3, GLM-5.3, GLM-5.3-Flash) offloading to
  **DeepSeek Flash**, the economics are favorable: separate quota pools, a
  **13.6× (K3 input) / 22.7× (K3 output)** gap against DeepSeek's metered rates,
  and — for ZAI — non-rollover credits better spent on reasoning (§3), plus a
  cacheable persistent worker.
- **Build it as a standalone plugin** (`premium-read-offload`), level-4 gate,
  with a persistent DeepSeek worker — not as a shunt port, and not as a
  tier-router feature.
- **Prerequisite:** §5 cache probe **passed** (99.6% hit) — not a blocker.
  Design decisions resolved; implementation is unblocked. Validate the two
  implementation-time risk (worker summary quality)
  during the build (§9).

## 9. Latency and correctness caveats

- **Latency.** A child `opencode run` costs seconds; an in-session read is
  near-instant. **Accepted for reads** (user decision) — no batching
  requirement. Loading a corpus is the one slow step (~seconds); cached
  follow-ups are fast.
- **Lossy summaries.** A worker summary used as the basis for a deterministic
  change is a correctness risk. Keep edits on the main model; expose the
  "verify exact values before editing" caveat.
- **False positives.** A large `read` is not always an offload case — the agent
  may genuinely need full content (e.g. reading a whole module to then rewrite
  it). The gate cannot distinguish "understands" from "will edit" by file alone.
  The resolution is explicit, not inferred: the `offset`/`limit` and
  `allow-direct-read` escapes. The agent knows whether it is editing, so it
  signals that deliberately rather than the gate guessing from prose. Expect
  some friction; measure it.
- **Worker quality.** `deepseek-flash` summarization may be less reliable than
  K3/GLM-5.3 on nuanced code. If quality is inadequate for a class of read, the
  honest fallback is `allow-direct-read`, not a worse summary. This argues
  against making the gate unconditionally hard for all premium sessions without
  a trial period.
- **Payload.** Unlike shunt, do **not** pass the corpus on argv (128 KiB/arg on
  Linux). Use stdin or a file path.

## 10. Resolved decisions

All previously-open questions are settled:

1. **Offload sources** — `k3`, `GLM-5.3`, **and** `GLM-5.3-Flash` (§6).
2. **ZAI policy** — maximize credit preservation; aggressive offload, lower
   threshold (§7). Credits are non-rollover and unbuyable (§3).
3. **Cache** — probe **passed**; persistent worker gives 99.6% cache-hit on
   follow-ups; worker = resumed `opencode run -s <id>` session (§5).
4. **Quota telemetry** — none available; gate is open-loop (§7).
5. **Latency** — **accepted for reads** (user decision, 2026-09-13). No
   interactive/batched distinction; any qualifying read may be offloaded.
6. **Placement** — standalone plugin, not a tier-router feature (§7).
7. **Enforcement** — level 4: hard gate, with `offload-read` as the replacement
   and two escapes (`offset`/`limit`; `allow-direct-read`) (§7).
8. **API facts verified** — `read` args are `{filePath, offset, limit}`;
   `tool.execute.before` blocks by throwing; `output.args` is free-form but
   `read` ignores unknown keys (§7).

No open design questions remain. One implementation-time risk to validate
during build (§9): `deepseek-flash` summarization quality on real code.

## 11. Parity with shunt

Feature-by-feature comparison. "Not applicable" rows are transport differences
we deliberately reject; everything exploitable is implemented.

| # | shunt feature | Status |
|---|---------------|--------|
| 1 | Read hook blocks large files > threshold | ✅ `tool.execute.before` on `read`, level-4 |
| 2 | Read hook allows targeted `offset`/`limit` | ✅ plus a `TARGETED_MAX` cap shunt lacks |
| 3 | Read hook allows nonexistent files | ✅ `decide-read` → `file_not_found` → allow |
| 4 | Bash hook blocks `cat`/`head`/`tail`/`less`/`more` | ✅ `decide-bash` |
| 5 | Bash hook allows pipes | ✅ `extractBashReadPath` returns empty |
| 6 | Bash hook allows redirects | ✅ same |
| 7 | Bash hook strips flags; bounded reads allowed | ✅ `bashRead().bounded()` (head -100, tail -n, less, more) |
| 8 | `bulk-read` delegation (question + paths) | ✅ `offload-read` tool |
| 9 | XML `<file path="...">` boundaries | ✅ `buildMessage` |
| 10 | Validates paths exist before sending | ✅ `readCorpus` throws |
| 11 | `code-write` (boilerplate, `--target`) | ✅ `code-write` tool (spec/reference/target) |
| 12 | Fence stripping on generated code | ✅ regex strip in `code-write` |
| 13 | `--reference` required | ✅ rejected before invocation |
| 14 | Skills telling the agent when/how | ✅ block messages + tool descriptions + worker agents |
| 15 | Token-usage note to stderr | ➖ worker usage captured in JSON events; not echoed |
| 16 | Ephemeral one-shot transport | ❌ **deliberately rejected** → persistent session (§5) |
| 17 | Env config (threshold, timeout, payload cap) | ✅ `LLMHP_OFFLOAD_*` env vars |
| 18 | Evals (hooks, transport, e2e) | ✅ `evals/run.sh` (27 cases) + Java (48) + TS (10) |
| 19 | Benchmarks | ➖ cache probe in §5 documents the real cost model |
| 20 | Portal / AiKA transport, mode resolution, `--instance` | ➖ Spotify-internal, not portable |
| 21 | Cost telemetry for offloads | ✅ `metrics.jsonl` (§14a) — counts observed, not estimated |
| 22 | Worth-it guard (skip trivial/small delegations) | ✅ `worthOffload` (§14b) — beyond shunt |
| 23 | Stale-summary invalidation + worker pruning | ✅ fingerprint verification + TTL (§14c) |
| 24 | Structured return contract (provenance) | ✅ `{answer, files_read, line_ranges, worker_session, cache_hit}` (§14d) |
| 25 | Mechanically verified citations | ✅ `CitationVerifier` + `[unverified]` tagging (§14e) — beyond shunt |

**Deliberate divergences (all improvements):**
1. **Persistent worker** instead of ephemeral — 99.6% cache-hit on follow-ups (§5).
2. **Escape hatch** (`allow-direct-read`) — shunt blocks unconditionally.
3. **`TARGETED_MAX` cap** — shunt's `offset`/`limit` escape can't be abused to read the whole file.
4. **Bounded bash reads** (`head -100`) allowed — shunt blocks any large-file `head`/`tail`.
5. **Fail-open on unknown state** — shunt has no model-awareness.

## 12. Implementation (built)

```
premium-read-offload/
├── opencode/index.ts          # hooks (chat.message, tool.execute.before) + 4 tools (default export only)
├── opencode/contract.ts       # pure provenance/citation helpers (kept out of the entry file — opencode treats every function export as a plugin)
├── opencode/index.test.ts     # 18 bun tests
├── src/main/java/eu/infolead/llmhp/offload/
│   ├── GateDecider.java       # premium detection, read/bash decisions, bash parser, worth-it guard
│   ├── WorkerStore.java       # session-model cache, worker sessions, permits, metrics, WAL-atomic
│   ├── CitationVerifier.java  # mechanical verification of worker [cite: ...] annotations
│   └── OffloadCli.java        # CLI: decide-read, decide-bash, record-model, verify-answer, ...
├── src/test/java/.../OffloadTest.java   # 79 assertions
├── agents/bulk-reader.md      # worker prompt (read, cited)
├── agents/code-writer.md      # worker prompt (generation)
├── evals/run.sh               # 42 gate-decision + citation eval cases
└── build/classes/             # committed compiled Java
```

**Tools:** `offload-read(question, paths)` (returns the structured contract, §14d),
`allow-direct-read(path, reason)`, `code-write(spec, reference, target?)`,
`offload-status()`.

**Env:** `LLMHP_PREMIUM_OFFLOAD=0` (kill switch),
`LLMHP_OFFLOAD_MIN_LINES` (1000), `LLMHP_OFFLOAD_ZAI_MIN_LINES` (400),
`LLMHP_OFFLOAD_TARGETED_MAX` (2000), `LLMHP_OFFLOAD_MIN_WORTH_LINES` (200),
`LLMHP_OFFLOAD_TTL_DAYS` (14), `LLMHP_OFFLOAD_WORKER_MODEL`
(`deepseek/deepseek-flash`), `LLMHP_OFFLOAD_READER_AGENT` (`bulk-reader`),
`LLMHP_OFFLOAD_WRITER_AGENT` (`code-writer`), `LLMHP_OFFLOAD_TIMEOUT_MS` (180000),
`LLMHP_OFFLOAD_DATA_DIR` (worker session home).

**Verification:** `bash premium-read-offload/evals/run.sh` (42/42),
`java ... OffloadTest` (79/79), `bun test .../index.test.ts` (18/18).

## 14. Post-build improvements (telemetry, guard, pruning)

Three additions, each addressing a weakness in the built version.

### 14a. Cost telemetry — `metrics.jsonl`

Every `offload-read` and `code-write` invocation appends one JSON object to
`.premium-read-offload/metrics.jsonl` (via `record-metric`; append-only,
best-effort — telemetry never breaks an offload). Fields:

| Field | Meaning |
|-------|---------|
| `ts`, `plugin` | ISO timestamp, `premium-read-offload` |
| `op` | `offload-read` \| `code-write` |
| `outcome` | `done` \| `skipped-not-worth` \| `error` |
| `cacheHit` | worker session resumed (read op) |
| `corpusLines`, `answerChars` | corpus size in, answer size out (read op) |
| `latencyMs` | wall time of the worker invocation |
| `workerSession`, `citationsVerified`, `citationsUnverified` | worker session id and citation-verification counts (read op, §14e) |
| `paths` / `reference` / `target` | corpus or generation inputs |

This answers "is this saving quota?" with observed counts. **No dollar or quota
figure is recorded or inferred** — token usage is not measured here and the
Coding Plan has no quota API (§7), so a currency number would be fabricated.
The log lets a human join the counts to pricing separately.

### 14b. "Did the worker earn its keep?" guard

`GateDecider.worthOffload(question, corpusLines, cacheHit)`:

- **Cache hit → always offload.** Corpus is already in the worker's context;
  the turn is near-free and keeps premium context clean.
- **Trivial question → never offload.** `isTrivialQuestion` matches questions
  answerable from metadata (`how many lines/words/chars`, `what file/language`,
  `which files`, `line count`, …). These need no model; the caller answers
  in-session or uses a bounded read.
- **Cold worker + corpus < `MIN_WORTH_LINES` (200) → skip.** Child startup
  (~seconds) dwarfs the saving.

On skip, `offload-read` returns `{skipped:true, reason, hint}` and records the
`skipped-not-worth` outcome — the failure mode ("paying a round-trip for a
trivial question") is now impossible and visible.

### 14c. Stale-summary invalidation, TTL, pruning

- **Root-cause fix.** The worker record now stores the corpus **fingerprint**
  string; `workerSession` compares it on read. A changed corpus is a miss even
  if two corpora hash to the same key — a stale session can never be resumed.
  (Previously the key was the bare hash with no verification.)
- **TTL.** Records carry a `ts`; `worker-prune` deletes records older than
  `LLMHP_OFFLOAD_TTL_DAYS` (14). The plugin runs it best-effort on start.
- **Pruning is TTL-only by design.** Because staleness is caught by fingerprint
  comparison at read time, an eager sweep is unnecessary for correctness; a
  changed corpus's old record simply ages out. This avoids the risk of an
  over-eager prune deleting a live cache entry.

### 14d. Structured return contract (provenance)

`offload-read` no longer returns free text; it returns a JSON envelope:

```json
{
  "answer": "<worker summary, failing citations tagged [unverified]>",
  "files_read": ["/abs/a.ts", "/abs/b.ts"],
  "line_ranges": {"/abs/a.ts": {"from": 1, "to": 3000, "total": 3000}},
  "worker_session": "ses_...",
  "cache_hit": false,
  "citations": {"total": 4, "verified": 3, "unverified": 1, "hasCitations": true, "items": [...]},
  "verification": "ok"
}
```

**Why.** The main agent could not tell what a lossy summary omitted. Now it can
see the corpus scale the worker saw (`files_read` + `line_ranges`), the worker
session and whether it was a cheap resumed turn (`worker_session` +
`cache_hit`), and which claims survived mechanical verification (`citations`).
`line_ranges` is **deterministic**: it reports the range actually handed to the
worker (today always the full file, `1..N`), never a model-reported guess.
`verification:"error"` means the Java core was unreachable and the answer passed
through unannotated (fail open — verification never breaks an offload).

### 14e. Verifiable citations (the lossy-summary attack)

The `bulk-reader` prompt now requires every claim to end with a citation of the
form `[cite: <path>:<start>[-<end>] "<exact quote>"]`. `CitationVerifier`
(Java) resolves the cited path against the corpus the worker was actually given,
checks the line range exists, and checks the quoted text appears in that range
(whitespace-collapsed). Statuses: `verified`, `quote_mismatch`, `missing_lines`,
`no_quote`, `unknown_path`, `unreadable`. Failing citations are tagged
`[unverified]` inline in `answer`; an answer with no citations at all is tagged
`[unverified: no citations found]`.

This is mechanical and deterministic: a verified citation means "this text
really is at these lines", **not** that the claim is true. It converts the
design's acknowledged #1 risk (lossy summaries used as the basis for edits)
from a prose warning into machinery — the agent can discount unverified claims
and verify exact values itself before editing.

### 14f. E2BIG fix — worker prompts on stdin

The worker message (question + the whole `<file>` corpus) was passed as an
**argv argument**. A 2974-line chapter exceeded Linux's 128 KiB per-argument
limit (`MAX_ARG_STRLEN`) and the spawn failed with `E2BIG`, so `offload-read`
errored out and the agent fell back to `allow-direct-read`. The fix matches
§9's original intent: the message is written to the child's **stdin**
(`opencode run` reads piped stdin when it is not a TTY), and the redundant
`-f <paths>` attachments are dropped — they carried only basenames (bad for the
citation contract) and re-sent the corpus a second time. Same fix applied to
`code-write`.

### 14g. Worker auth + agent mode fixes

Two follow-on failures surfaced once E2BIG was gone:

- **401 Unauthorized.** The worker runs with `XDG_DATA_HOME` pointed at an
  isolated data home (so its sessions stay out of the user's list). Built-in
  providers (deepseek, kimi-for-coding) authenticate from `auth.json` *in that
  data home* — an empty one made the model call 401 and `offload-read` fail with
  "worker produced no text output". `workerDataDir()` now links the real
  `auth.json` (and `account.json`) into the worker home, falling back to a copy.
- **Agent fallback.** `opencode run --agent bulk-reader` warned "is a subagent,
  not a primary agent" and fell back to the default agent, silently dropping the
  citation prompt. The agents must be `mode: "all"` (valid as primary or
  subagent) for `--agent` to apply. Updated in `opencode.json.sample` and the
  host config.

## 13. References

- shunt source (cloned): `~/code/vendor/portal-ai-plugins/plugins/shunt/`
- Kimi membership/limits: `https://www.kimi.com/code/docs/en/kimi-code/membership.html`
- Kimi model IDs + pricing: `https://platform.kimi.ai/docs/pricing`
- ZAI GLM Coding Plan credits/multipliers: `https://docs.z.ai/devpack/overview`
- ZAI non-rollover + no-pay-as-you-go fallback: `https://docs.z.ai/devpack/faq`
- `shared/safe-spawn.ts` — subprocess primitives
- `tier-router/skill-axis-mapping.json` — DeepSeek pricing + fleet
- `plugin-tier-router.design.md` — tier definitions and escalation
- Cache-probe artifacts: `/tmp/opencode/cache-probe/{turn1,turn2,turn3}.jsonl`
  (session `ses_f6633ccc1ffefQ6Owf9FtXlQ2O`; result = 99.6% hit on turn 3)
- Implementation: `premium-read-offload/` (this repo)
