# Context Editing — Design Document

An OpenCode plugin that lets the session model manage its own context: before a
request the conversation is projected into an editable **file**, the model
curates that file with its ordinary tools, and the curated version becomes its
next input. The point is not to make context *small* — it is to keep it
**relevant**, continuously, so long sessions do not rot under their own
history.

Status: **DESIGN (settled through review).** The model, the three layers, the
drop rule, the recall gate, the hooks, the wire-format contract, the
compaction policy, and the cache-aware edit policy are decided (§16).
Remaining risks are implementation-time (§15). Build is **phased** — Phase 0 is
notices-only, with no editing at all (§12).
Placement: **standalone plugin**, directory `context-editing/` (§7).
Naming: deliberately **not** `clm` — that name is taken by the Contrastive
Language Models plugin (`clm/`); the acronym collides with the source paper.

Origin: the mechanism is inspired by `facebookresearch/context-language-models`
(Context Language Models, `arXiv:2609.37725`). See §2 for what we take, what we
reject, and why we implement rather than vendor.

## 1. What it is

- The session's live context is exposed to the model as **one editable file**
  (the mirror). The model edits it with `read`/`write`/`edit` like any file.
- The edited file **is** the next request's history — OpenCode's stored session
  is left untouched.
- The file is a **view** over an append-only **trace** (event sourcing, §5).
- Edits are logged as **diffs** with provenance and can be reverted.

This is the only mechanism in the repo that controls context *size and
relevance density inside a live session*. Routing picks a cheaper model;
rewriting improves wording; the response cache avoids repeat calls — none of
them shrink the transcript or drop stale tool output (§3).

## 2. Relationship to the source work

**We vendor nothing.**

| Source | License | Why not used directly |
|---|---|---|
| `facebookresearch/context-language-models` | **CC BY-NC 4.0** | Non-commercial content license (not a software license, not OSI-approved); it is a research codebase (Harbor harness, RL, ICL, `suffix_cache_reuse` vLLM/SGLang patches), not a plugin |
| `opencode-clm` (community port) | MIT | Immature (single maintainer, source notes "Claude wrote the code, maintainer has not hand-reviewed", hosted APIs untested); carries the `clm` name; its headline savings depend on the server-side suffix-cache patch we do not have |

The **idea** (context as an edited file) is not copyrightable and is safe to
implement. We copy no text and no code from either source.

The decisive technical fact we accept from the source material: on a stock
server, an edit re-prefills everything after the first changed token
(`opencode-clm` README). The paper's `suffix_cache_reuse` exists to fix that.
We therefore design for the **stock, prefix-cached, priced API** (§9).

## 3. Does our repo already have an equivalent?

**No single one — the gap is size/relevance control in a live session.**

| Plugin | Mechanism | Why it is not this |
|---|---|---|
| `semantic-router` | message → route directive (+ tool deny) | Changes *which* directive is active; does not shrink the transcript |
| `tier-router` | complexity classify → cheapest sufficient tier; `Reformatter` rewrites the prompt | Routes and rewrites the **prompt**, not the accumulated context |
| `system-message-merge` / `prompt-registry` | coalesce/parameterize system messages | Structural, not size- or relevance-based |
| `datetime-inject` | injects per-message/session context | **Adds** tokens; does not remove stale ones |
| `semantic-cache` | response-level cache (embedding ≥0.85 on prompt→response) | Avoids a whole *call*; not a prefix cache, and does not bound growth |
| `context-toolkit/compact-context` | archives + rewrites a context **file**, no new content, converge via auditor | Durable instruction files, threshold/one-shot, whole-file; not a live session transcript |
| `premium-read-offload` | offloads bulk reads to a cheap worker | Moves reads out; does not curate the session context |
| `session-lifecycle` | edit logs, git diffing, 30-day archival | Records what happened; does not shape the next request |

Confirmed present: **prompt-rewriting** (`tier-router` Reformatter,
`semantic-router` inject, `system-message-merge`, `datetime-inject`,
`prompt-registry`) and **routing** (`semantic-router`, `tier-router`, decision
engines `laya`/`clm`/`local-decide`). What is missing is **context editing**.

## 4. Objective: relevance density, not size

The metric is not tokens; it is how much of the context still earns its place.

- Long context degrades reasoning (attention dilution, distractors) — "context
  rot" — before the window is full. Bounding growth and raising signal density
  both address it.
- Size is the **constraint** that forces triage; relevance is the **goal**.
- Rot is, precisely, the confusion of the **log** with the **view**: replaying
  raw history as if every past token still matters. Separating the layers (§5)
  is what removes it.

Two honest limits:

- Bounding is achieved by the model **choosing what to drop**, which is lossy.
  We trade "rot from length" for "lossy-edit risk" — managed by the drop rule
  (§5.3), not eliminated.
- Our models are not CLM-trained, so they will make more edit mistakes than the
  paper's models. The policy must be conservative by default.

## 5. The three layers

```
        append-only, cold                 mutable, hot            append-only, cold
   ┌────────────────────────┐      ┌────────────────────────┐   ┌────────────────┐
   │  TRACE  (trace.jsonl)   │─────▶│  MIRROR (context.md)    │──▶│  DIFFS (edits/) │
   │  full turns + tool I/O  │ view │  curated = next input   │   │  per revision   │
   │  never edited, never    │      │  budget-bound, edited   │   │  provenance     │
   │  sent to the model      │◀──── │  with ordinary tools    │   │  revertible     │
   └────────────────────────┘ recall└────────────────────────┘   └────────────────┘
            ground truth              the only thing in context        audit surface
```

| Layer | Mutability | In the prompt? | Role | ~Reviewed |
|---|---|---|---|---|
| **Trace** | immutable | never | ground truth; last-resort disambiguation | almost never (§6) |
| **Mirror** | mutable | yes | the curated view = next request | every turn (by the model) |
| **Diffs** | append-only | no | audit + revert + "what did it change" | occasionally (cheap) |

Why this split:

- The trace is **free with respect to the prompt**: never sent, so no token
  cost, no prefix-cache impact, no rot. Any retention/pruning policy is a pure
  storage question.
- Event sourcing gives **revert** and **audit** for free: the mirror is a
  materialized view; "reset" rebuilds it from the trace.
- The diff history (of the *view*) is the routine, glanceable surface; the raw
  trace is the forensic surface (§6). Conflating them is what makes people
  over-weight the log.

### 5.1 Edit classes

Editing is **not only cutting**.

| Class | Examples |
|---|---|
| **Subtractive** | drop superseded tool output; dedupe; compress verbose logs; replace a stale worked example with a one-line note |
| **Additive / transformative** | record a decision that was only implied; correct a wrong path the model wrote; merge two half-statements of one constraint; restructure so the current goal is first |

### 5.2 Edit vocabulary (injected to the model)

`KEEP` verbatim · `COMPRESS` · `DROP` · `ADD` · `FIX` · `MERGE`

Plus a **protected, append-mostly region** — goal, constraints, open questions,
unresolved errors — where edits may **add** but must not **drop** (the
`sdlc-guardrails` protected-path idea applied to a context file).

### 5.3 The drop rule — coverage, not prophecy

You cannot know at edit time what will matter later. So we do not ask the model
to predict the future; we ask a check:

> A span is safe to drop **iff** it is (a) **redundant given the retained set** —
> its information is entailed by what remains — **or** (b) cheaply
> **re-derivable from the environment** (filesystem, git, a test rerun).

- (a) is the reformulation case — *only when the source survives alongside it*.
  If the reformulation is the sole copy, it is **not** safe.
- (b) is the `premium-read-offload` premise: drop it, re-read it on demand.
- The **trace is insurance, not a routine redundancy source** (§6). "The log
  has it" does **not** loosen the bar, because reading the log is an exceptional
  event.

Asymmetry: **permissive about adding, conservative about cutting.** Adds are
cheap and recoverable; a cut can silently destroy the fact the next turn needs.
When unsure whether to cut, keep.

### 5.4 Never fabricate = a bounded objective

Not merely "no invented text". It is the difference between **budget as a
constraint** and **budget as a goal**:

- Constraint: stay under budget **if that can be done truthfully**; otherwise
  exceed it and say so. Fail-open.
- Goal: "hit the budget" → the model manufactures a summary asserting things the
  transcript never established, or marks work done to satisfy the objective.
  That is **goal-driven fabrication** (specification gaming with the budget or
  task as the spec).

Rules:

1. **Fail-open on budget** — overshoot is allowed; fabricating to fit is not.
2. **Ground every add** — an `ADD`/`FIX` must trace to something observed in the
   trace (a fact read, a decision made, an error and its fix). Never invented.
3. This is one principle, not two, shared with `compact-context`'s *"when in
   doubt, keep the original"* and `sdlc-guardrails`' verification-before-done.

### 5.5 Scope of "add/improve"

The additive license applies to the **ephemeral session context only**. Durable
context files (AGENTS.md, memory, instructions) keep the opposite contract —
`compact-context`'s **no new content / never fabricate / preserve verbatim**.
Do not conflate: a session transcript may synthesize a missing insight; an
instruction file may not.

## 6. Recall — a gated, near-never path

A retrieval index over the trace **exists**, but is **not used routinely** —
only to disambiguate *if and only if necessary*. "Necessary" needs a
falsifiable predicate, or the gate drifts into "the model calls it whenever it
feels unsure".

**Trigger = all three:**

1. A needed fact is **missing or contradictory in the mirror** (a fact the
   current decision turns on — not a nice-to-have).
2. It **plausibly exists in the trace** and is **not** cheaply re-derivable from
   the environment.
3. The step **cannot proceed** without it (no safe default, no fail-open path).

(1) alone is curiosity; without (3) it is optional, and optional creeps.

Gating:

- **Not a default tool.** Either an escalation (`recall needed: <missing fact>`)
  that surfaces to the user/gate, or a tool that **requires the justification**
  and **fails closed** on a weak one — the `premium-read-offload` hard-gate
  pattern.
- **Return a narrow span, not a dump**, with provenance; treat the result like
  an edit: appended at the tail (cache-cheap), logged, audited.
- **Deferred where possible** — fetch, then resume, so it is not in the
  per-request path.

Property worth keeping: when the gate fires, the returned span **is** the
anti-fabrication check — you read the raw trace exactly when you would want to.
The detective function rides along with disambiguation; it needs no separate
routine.

Because review is near-never, the trace does **not enforce** never-fabricate —
it only lets you **investigate** afterwards. The guarantee is **preventive at
edit time** (§5.4); the trace is **detective**. We prefer prevention.

## 7. Context is a file

Yes — deliberately a **single editable Markdown file**. That is the whole
interface: the model edits it with ordinary tools, and it is what the model is
prompted on. Proposed layout under the session's worktree:

```
.context-editing/
  <sessionID>/
    context.md        # the mirror  — mutable, in-context, budget-bound
    trace.jsonl       # the trace   — append-only, cold, ground truth
    edits/
      r0001.json      # per-revision diff + provenance (+ model id, ts)
      r0002.json
    metrics.jsonl     # telemetry (§12)
    index/            # optional retrieval index over trace.jsonl (recall gate)
```

`context.md` carries the segment layout from §9.3. `trace.jsonl` is one record
per turn/tool-IO. `edits/` is the audit + revert surface.

## 8. Hooks and lifecycle

All hooks are named from `@opencode-ai/plugin` (`dist/index.d.ts`). The mirror
projection happens in `experimental.chat.messages.transform`; everything else
observes or coordinates.

### 8.1 Hook map

| Hook | Use here |
|---|---|
| `experimental.chat.messages.transform` | **The projection.** Receives `output.messages: {info, parts}[]`; replaces it with the mirror projection (§8.2) |
| `chat.message` | Observe the incoming user turn; flush it to the trace; update the session→mirror binding |
| `experimental.chat.system.transform` | Inject the edit protocol + budget notice (Phase 0) into the system prompt |
| `chat.params` | Token accounting inputs (model window) per request |
| `tool.execute.before` / `tool.execute.after` | Optional early validation of edits to `context.md`; trace tool I/O |
| `experimental.session.compacting` | Coordinate with native compaction (§8.3) |
| `experimental.compaction.autocontinue` | Suppress the synthetic "continue" turn when we own compaction |
| `permission.ask` | Gate the recall escalation if it needs a user decision |
| events `session.created` / `session.deleted` / `session.idle` / `session.compacted` | Lifecycle: create/flush/prune/rebuild |
| event `message.updated` | Keep the trace in sync with parts the model did not route through `chat.message` |

**Wiring constraint:** `experimental.chat.messages.transform` takes input `{}` —
it carries **no `sessionID`**. The plugin must recover the session from the
first message's `info` (or a binding tracked in `chat.message`) to select the
right `.context-editing/<sessionID>/` mirror. Treat this as load-bearing, not a
detail.

### 8.2 Wire-format contract (correctness)

The mirror is Markdown for editing; the model's input is `{info, parts}[]`.
Only a **partial** mapping is lossless, so:

- **Tool-call/result pairs are atomic.** A `tool_use` and its matching
  `tool_result` (by id) must both survive or both go. Dropping one breaks
  Anthropic/OpenAI message validity and the request fails. `DROP`/`COMPRESS`
  may never split a pair.
- **Non-text parts are pinned, not editable.** Images, file attachments, and
  structured blocks do not round-trip through Markdown. They are addressed by
  stable id and **re-spliced from the trace** at projection time.
- **The projection is a merge:** edited text regions ⊕ pinned structured parts
  (from the trace). The model edits text spans; structure is reconstructed, not
  trusted from the file.
- **Consequence:** the mirror is a *partial view*. "Context is a file" is true
  for the editable text; the structured remainder lives in the trace and is
  reinstated on every request.

Projection **validates** the merge before use (§10): if an edit would orphan a
pinned pair or a protected region, the projection falls back to the last good
revision and logs the rejection.

### 8.3 Native compaction coordination

OpenCode has its own compaction (`experimental.session.compacting`,
`experimental.compaction.autocontinue`, the `session.compacted` event). Two
compressors on one transcript will fight — double compaction, or a mirror that
diverges from a compacted session.

Decide precedence **explicitly**:

- **While editing is on:** disable native auto-compaction and let the mirror own
  the bound (what `opencode-clm` does). Use `experimental.session.compacting` to
  take control and `experimental.compaction.autocontinue` to suppress the
  synthetic continue.
- **If native compaction does run** (manual `/compact`, provider fallback):
  treat `session.compacted` as a **reset boundary** — rebuild the mirror from
  the new trace head, bump the revision, and keep the pre-compaction trace.

Silent coexistence is the failure mode; pick one owner at a time.

### 8.4 Subagent / multi-agent contexts

Each `sessionID` gets its own directory (§7). `Task`-spawned subagents are
separate sessions, so they get **separate mirrors by default** — the paper's
"multiple agent contexts coexist as files" maps directly to per-session
directories.

- **Default (v1):** full isolation; a subagent's result returns to the parent
  as an ordinary tool result.
- **Optional (post-v1):** *seed* a subagent mirror from just the parent's
  **protected region** (goal + constraints), not the parent's whole context.
  *Handoff* reads a child's mirror on completion. Both are opt-in and out of the
  v1 scope; do not seed from the full parent context (that re-inflates and
  re-rots).

## 9. Cache-aware edit policy

Editing mutates the transcript mid-prefix; server prefix caching (DeepSeek
context caching, Anthropic/OpenAI cached input) bills the longest *unchanged*
prefix at a discount, so an edit forfeits the discount from the first changed
token to the end. Editing therefore **fights** the cost machinery we already
have. The policy exists to keep the fight cheap.

### 9.1 Mechanics we design around

- **Prefix cache is a token sequence** — not per file. Change token *i*, lose
  the discount for *i…end*. A **tail append** leaves the prefix intact; a
  **mid-transcript cut** invalidates the tail.
- **`semantic-cache` is response-level**, not prefix-level — it does **not**
  mitigate edit-induced re-prefill.
- **`datetime-inject` already perturbs the prefix** every message; edits must
  not compound that (§9.3 keeps volatile content at the tail).

### 9.2 Policy

1. **Threshold-gated, not continuous.** "Continuous" is the cache-hostile
   choice — every edit is another invalidation point. Edit when pressure or a
   real gap appears, not every turn. (This is closer to compaction's threshold
   model than the paper's per-request model.)
2. **Batch** — one invalidation instead of many.
3. **Tail-biased** — prefer edits late in the transcript; a tail append is
   nearly free.
4. **Only when benefit exceeds cost** — projected tokens saved × rot benefit >
   projected re-prefill cost. Fail-open: if the projection is unclear, do not
   edit.

### 9.3 Segment layout (get rot control without paying full re-prefill)

Order the mirror so edit-eligible material sits at the **tail**:

| Segment | Content | Edit policy | Cache role |
|---|---|---|---|
| **Invariant head** | system, task, constraints, protected region | append-mostly | stable prefix — **cached** |
| **Volatile tail** | scratch, tool output, working, superseded material | compress/drop | edit here → only the tail re-prefills |

Edits land at the tail and leave the head's prefix intact.

## 10. Enforcement levels

Following the `premium-read-offload` convention (level 4 = hard gate + explicit
escape). Enforcement is realized **at projection time** (the mirror is treated
as untrusted input and validated before use), with `tool.execute.before` as
optional early feedback.

| Level | Meaning | Applied to |
|---|---|---|
| L1 | Advisory — protocol text only | edit vocabulary, style guidance |
| L2 | Soft guard — notice + forced compact on breach; **fail-open** (overshoot allowed) | budget |
| L3 | Reject — projection refuses the edit, falls back to last good revision, logs | **wire-format invariant** (tool-pair split, §8.2); **protected region** drop |
| L4 | Hard gate + explicit escape | recall escalation (§6) |

Budget is L2 on purpose: the objective is bounded (§5.4), so the correct
response to an unmeetable budget is to exceed it honestly, not to block or to
fabricate. The wire-format invariant is L3 because violating it is not a policy
choice — it breaks the request.

## 11. Failure modes and recovery

| Failure | Detection | Recovery |
|---|---|---|
| Model **never edits** → budget never enforced | size stays over budget across turns | L2 **forced compact** at threshold; else native compaction owns the bound (§8.3) |
| Mirror **corrupt / unparseable** | projection validation fails | rebuild from last good revision (trace + `edits/`) |
| Edit **splits a tool pair** | L3 validation | reject; restore from last good revision; log |
| Edit **drops the protected region** | L3 validation | restore the region from the trace; log |
| Edit **drops a needed fact** (lossy) | next turn's confusion / failed recall | revert to a prior revision; the trace is the recovery source |
| **Edit churn** (edits every turn, no pressure) | edit-rate telemetry | threshold gate + cooldown; cap edits per window |

The trace is the universal backstop: every recovery path rebuilds from it.

## 12. Rollout — Phase 0 is notices-only

`opencode-clm`'s own numbers show most of the gain was *behavioural* — **"told
its budget, the model makes fewer tool calls"** — not from the edits
themselves. So do the cheap thing first and keep the unproven part behind it.

- **Phase 0 (no editing):** inject the budget notice + overflow guard only. No
  mirror, no protocol, no edits; history is raw. Measures the behavioural effect
  in isolation.
- **Phase 1 (editing):** add the mirror projection, edit vocabulary, and the
  cache-aware policy — **only if** Phase 0 does not get us there.

Telemetry decides, in `.context-editing/<sessionID>/metrics.jsonl` (mirroring
`premium-read-offload`'s `metrics.jsonl`):

- request size: **estimated** (pre-send) and **confirmed** (provider usage),
  tracked separately;
- budget and fixed overhead;
- edit events: revision, class, tokens before/after, accepted/rejected;
- provider-reported cache hits (cached input tokens);
- forced-compact count;
- task outcome (solved / not), where measurable.

Estimated vs confirmed is the same `~`/confirmed distinction the port surfaces:
before the provider reports usage the size is an estimate.

## 13. Observability divergence

The stored session is the **raw** transcript; the mirror is what the model
**actually saw**. Downstream readers of session state — `agentinsights`,
`session-lifecycle`, `semantic-cache` — therefore observe history the model
never received. Implication:

- Replay and insights are **not** the effective input; treat them as the log,
  not the view (§5).
- If a faithful "effective transcript" is ever needed, export
  mirror ⊕ pinned parts from the trace; do not assume the session store has it.

## 14. Security

The trace holds **untrusted** content (tool output, file bodies). A crafted
result could try to induce a destructive mirror edit or exfiltrate.

- Same trust class as ordinary file access — the mirror is **not** a privileged
  path.
- Damage is bounded by: projection-time validation (§10), protected-region
  restore from the trace, and full edit logging.
- Retention/redaction: tool I/O can carry secrets and grow unbounded — reuse
  `session-lifecycle` retention plus a redaction pass at trace-write.

## 15. Risks and open questions

- **Edit quality on non-CLM-trained models** — more bad edits than the paper.
  Mitigation: conservative-by-default drop rule, fail-open budget, revert.
- **Wire-format projection** (§8.2) — the biggest implementation risk; the
  parts↔Markdown mapping and pair-atomicity must be proven before Phase 1.
- **Retention and redaction** — reuse `session-lifecycle`; add redaction.
- **Cache accounting** — the benefit-vs-cost projection (§9.2.4) needs real
  numbers per provider; may need Phase-0 telemetry before it is trustworthy.
- **Recall cost** — if pulling a span costs a model turn, "re-derivable" is
  cost moved, not removed; the index must be cheap enough to be genuinely rare.
- **Scope creep into durable context** — the additive license must stay scoped
  to the session mirror (§5.5).
- **Do sessions actually approach the window?** If not, this plugin's value is
  second-order versus provider compaction — the whole reason Phase 0 exists
  (§12) is to answer this before building Phase 1.

## 16. Resolved decisions

| # | Decision | Rationale |
|---|---|---|
| D1 | Implement our own; vendor neither source | CC BY-NC license; source is research code; MIT port immature and cache-dependent (§2) |
| D2 | Named `context-editing`, not `clm` | Avoid collision with the Contrastive LM plugin (§2) |
| D3 | Three layers: trace / mirror / diffs | Event sourcing makes revert + audit free; trace is prompt-free (§5) |
| D4 | Objective is relevance density, size is the constraint | Rot is the log/view confusion (§4) |
| D5 | Drop rule = coverage (retained set) or cheap environment re-derivation | Avoids predicting the future (§5.3) |
| D6 | Asymmetric: permissive add, conservative cut | Cuts are the irreversible risk (§5.3) |
| D7 | Never-fabricate = bounded objective + fail-open budget | Prevent goal-driven fabrication (§5.4) |
| D8 | Additive license scoped to the session, not durable files | Different contract from `compact-context` (§5.5) |
| D9 | Recall is gated, three-condition, fail-closed, near-never | Prevent drift to routine use (§6) |
| D10 | Trace review is last-resort/forensic; diffs are the routine surface | (§6) |
| D11 | Cache-aware: threshold-gated, batched, tail-biased, benefit-gated | Editing fights prefix caching (§9) |
| D12 | Context is a single editable Markdown file (mirror) | That is the interface (§7) |
| D13 | Projection via `experimental.chat.messages.transform`; session recovered from message `info` (hook has no `sessionID`) | Only hook that rewrites the outgoing message array (§8.1) |
| D14 | Wire-format contract: tool pairs atomic, non-text parts pinned and re-spliced from the trace | The mirror is a partial view; the request must stay valid (§8.2) |
| D15 | One compaction owner at a time; disable native auto-compaction while editing is on | Two compressors will fight (§8.3) |
| D16 | Subagent contexts isolated by default; seeding/handoff post-v1 | Per-session dirs; avoid re-inflating children (§8.4) |
| D17 | Enforcement at projection time (mirror is untrusted); budget is L2 fail-open, wire-format is L3 reject | Blocking file writes is weaker than validating the projection (§10) |
| D18 | Recovery always rebuilds from the trace | The trace is the universal backstop (§11) |
| D19 | Phase 0 is notices-only; editing only if it earns its place | Most of the source gain was behavioural (§12) |
| D20 | Telemetry distinguishes estimated vs confirmed size | Provider usage is post-hoc (§12) |

## 17. Relationship to existing plugins (reuse, do not reinvent)

| Need | Reuse |
|---|---|
| Trace storage, retention, archival | `session-lifecycle` |
| Cheap re-derivation of offloaded content | `premium-read-offload` (worker store, provenance) |
| Gated expensive action with escapes | `premium-read-offload` gate pattern |
| Telemetry file convention | `premium-read-offload`'s `metrics.jsonl` |
| Durable memory + retrieval | `agentmem` |
| Protected region / verification gates | `sdlc-guardrails` |
| Native-compaction coordination | OpenCode `experimental.session.compacting` |
| Durable-file compaction contract | `context-toolkit/compact-context` (kept as-is) |

## 18. References

- `facebookresearch/context-language-models` — Context Language Models,
  `arXiv:2609.37725` (CC BY-NC 4.0).
- `bcmyguest/opencode-clm` — community OpenCode port (MIT); source of the
  stock-server re-prefill and behavioural-effect observations.
- `@opencode-ai/plugin` `dist/index.d.ts` — hook signatures (`messages.transform`,
  `session.compacting`, `compaction.autocontinue`).
- `plugin-read-offload.design.md` — gate-with-escapes, persistent-worker, and
  `metrics.jsonl` patterns.
- `context-toolkit/skills/compact-context/SKILL.md` — no-new-content /
  never-fabricate contract for durable files.
