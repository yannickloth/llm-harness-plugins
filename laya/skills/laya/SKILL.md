---
name: laya
description: Use Laya, the local non-autoregressive System 1 decision engine, for fast calibrated typed judgments via the laya_* MCP tools (laya_predict, laya_route, laya_triage, laya_email, laya_guard, laya_moderation, laya_detect_language). Returns choice/score/noul answers with probabilities and confidence in a single forward pass (~30-70 ms, offline, no API key). Use for intent/urgency classification, model routing, input guardrails, content moderation, email triage, and any bounded label-shaped decision across 100+ languages. Not for generation, code, extraction of long spans, or multi-step reasoning.
compatibility: Requires the laya-mcp systemd user service on 127.0.0.1:8765 (laptop-p16) and laya_* MCP tools visible in the session
---

# Laya (local System 1 decision engine)

Laya is a local, non-autoregressive decision model: give it a **state** (text, JSON,
or conversation turns) plus **typed questions**, and it returns typed answers with
mathematically calibrated probabilities in one forward pass. It never generates text,
so there is nothing to parse and nothing to hallucinate. It is trained with
reinforcement learning against strictly proper scoring rules (RLCD) — reporting honest
probabilities is the only way to maximise reward — so the numbers are usable for
weighting and gating, not just display.

## Access

- **MCP tools** (the primary interface): `laya_predict`, `laya_route`, `laya_triage`,
  `laya_email`, `laya_guard`, `laya_moderation`, `laya_detect_language`, served by the
  `laya-mcp` systemd user service over streamable HTTP at `127.0.0.1:8765/mcp`.
  Both checkpoints it serves (english + multilingual) are preloaded GPU-resident, so
  routing and inference cost milliseconds.
- **Python API**: the `laya` package (0.3.x) in `~/.local/share/laya/venv`
  (launcher `laya-python`). `Router` and `Agent` mirror the MCP tools for
  embedding Laya in scripts or pipelines.
- **Ops environment**: `LAYA_MCP_HOST` (default 127.0.0.1), `LAYA_MCP_PORT`
  (default 8765), `LAYA_DEVICE` (cuda | cpu | mps; auto-detect), `LAYA_MAX_LEN`
  (context-window override, tokens).

**If the `laya_*` tools are missing from your session, the server is down** — since
2026-09-27 the unit is installed but **not auto-started**; bring it up with
`systemctl --user start laya-mcp`, then check `systemctl --user status laya-mcp`
and `journalctl --user -u laya-mcp.service`.
The classic failure is another service squatting port 8765 (Serena's MCP server did
this on 2026-09-21 and held the port for ~1,900 laya restarts) — check
`ss -tlnp | grep 8765` to see who owns the port.

## Checkpoints and routing

| Checkpoint | Backbone | Params | Window | Best at |
|---|---|---|---|---|
| `english` | ModernBERT-large | 421M | 512 | English text, guardrails, email triage |
| `multilingual` | mmBERT-base | 322M | 1024 (encoder 8k-native) | 100+ languages, ~2x faster |
| `typed-decisions` | ModernBERT-large | 421M | 1024 | four fine-tuned workflows; opt-in only |

Routing precedence (full chain: Python `Router` and `laya_route`; the MCP
`laya_predict` tool exposes only the `model` pin):

- Precedence: explicit `model` > explicit `task` > workflow detection (disabled on the
  MCP server) > explicit `lang` > script/language detection > default `english`.
- Script detection is the primary signal: non-Latin script → `multilingual`;
  Latin script but not English → `multilingual`; English Latin text → `english`.
  Detection is exact Unicode-range work, <0.5 ms.
- **The English checkpoint does not degrade off English — it collapses.** Measured:
  0.000 accuracy at 0.952 confidence on Khmer; 0.100 on Hindi (random guessing is
  0.050); ECE 0.855 on Hindi. It stays confident while wrong, so confidence gating
  cannot save you from language/domain mismatch — routing does. Never pin
  `model="english"` for non-English state.
- `typed-decisions` is never selected automatically. Pass `model="typed-decisions"`
  explicitly. It is fine-tuned on four specific workflows, matched by exact question-id
  set: `agent_trace_observability` (action, needs_review, outcome, risk, urgency),
  `customer_service` (action, category, churn_risk, needs_human, urgency),
  `invoice_processing` (discrepancy_severity, disposition, duplicate, matches_order,
  urgency), `security_incidents` (credential_compromise, disposition, severity,
  true_positive, urgency).

## Question design

`laya_predict(state, questions)`:

- `state`: plain text, a JSON object, or a conversation-turn list. Objects and lists
  are JSON-serialized, so reference their fields by name in instructions.
- `questions`: map of question id → definition. All questions run in **one** forward
  pass, in parallel, blind to each other's answers.

Question shapes:

```json
{"type": "choice", "instructions": "...", "criteria": {"optA": "desc", "optB": "desc"}}
{"type": "score",  "instructions": "...", "criteria": ["level 0", "level 1", "level 2"]}
{"type": "noul",   "instructions": "..."}
```

- **choice** — one of a defined set; its distribution compares competing options.
  Include a no-match/`other` option when nothing may fit.
- **score** — a degree along a described dimension; the answer is the probability-
  weighted level index (e.g. 1.84 of 3). Levels must be ordered, concrete, and stand
  on their own.
- **noul** — probability that a condition holds. Use one per condition; never OR
  conditions together. Optional `criteria: {"true": "...", "false": "..."}` sharpens
  the definition.

Design rules:

- One narrow, coherent judgment per question. Split independently useful dimensions,
  but do not destroy the relationship being judged.
- Reference state with backticked field names in instructions (`message`, `body`,
  `prompt` — match the field names you actually put in the state).
- Option text is budgeted: each option renders at ≤48 tokens and the whole question
  head at 192 (english) / 256 (multilingual, typed-decisions) tokens. Keep labels short
  and descriptions terse.
- State is right-truncated at the window (512/1024 tokens). For long documents,
  truncate in code first (e.g. `laya.email.clean_email_body`, or take the decision-
  relevant head) so the window holds what matters. Beyond the trained window is
  rotary extrapolation — `LAYA_MAX_LEN` can raise it, but quality is unvalidated.
- **The model judges; code executes.** Keep rules, calculations, exact lookups, and
  side effects in code; ask Laya only for the semantic judgment it is calibrated on.

## Output and confidence

`laya_predict` returns `{"model", "answers", "usage", "routing"}` — `model` is the
constant `"laya-rl-agent"`; the chosen checkpoint is `routing.model`:

- `choice` → `{choice, probabilities: {opt: p}, confidence}`
- `score` → `{score, legend: {"0": "...", ...}, probabilities, confidence}`
- `noul` → `{noul: P(true), confidence}`
- every answer also carries `action: {act_probability}` — a learned act/escalate
  signal; treat it as a secondary hint, not a contract.
- `routing` records `{model, repo, reason, detection, workflow}` for the chosen
  checkpoint; `workflow` is set only on a typed-decisions id-set match.

Confidence semantics:

- choice/score: `1 − H(p)/log(k)` — distribution concentration, **not** correctness.
  Several legitimate alternatives legitimately spread probability.
- noul: `max(p, 1−p)`. A noul near 0.5 means genuinely ambiguous — and its
  confidence is low too.
- Calibrated via proper scoring rules on the benchmarks, but validate thresholds on
  your own data and consequences. A low-confidence harmless preference is fine; a
  low-confidence high-stakes call is not.
- **Escalate on low confidence**: to your own reasoning, a heavier model, or a human.
  Do not act on coin flips.

## Presets

| Tool | State field | Answers |
|---|---|---|
| `laya_triage` | `message` | intent (refund / technical_help / billing_question / information / cancellation / other), is_urgent, frustration (0–3), refund_requested, churn_risk |
| `laya_email` | `body` (plus `subject`, `from`) | category (billing/technical/sales/security/hr/other; customizable via the `categories` parameter, MCP and Python), is_spam, is_phishing, urgency (0–2), needs_reply |
| `laya_guard` | `prompt` | jailbreak, prompt_injection, sensitive_data, harm_severity (0–3), topic |
| `laya_moderation` | `post` | toxic, harassment, threat, spam, severity (0–3) |
| `laya_detect_language` | — | exact script + best-effort Latin-language guess (the router's signal) |

Python-only: `laya.presets.router_questions()` (difficulty 0–3, domain, needs_tools,
is_sensitive over a `request` field) — useful for routing your *other* models.

## When to use and not use

**Use Laya for**: bounded, label-shaped decisions; several independent judgments in
one pass; multilingual input; input guardrails and moderation; anywhere you want
offline, free, millisecond, probabilistic answers.

**Do not use Laya for**: text or code generation; extracting long spans; multi-step
reasoning; context beyond its window; anything needing tools, memory, or follow-up
state. For those, use your own reasoning, a heavier model, or a dedicated agent.

Compare with `local_decide` (grammar-constrained single action, no calibrated
multi-question) and the reasoning models (multi-step, tool-using). Laya wins on
cost, latency, privacy, and calibrated multi-dimension judgments; it loses the moment
the task stops being a bounded judgment.
