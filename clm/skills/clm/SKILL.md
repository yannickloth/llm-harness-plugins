---
name: clm
description: Use CLM (Contrastive Language Models), the local System 1 decision engine served by clm-serve, for fast typed judgments — noul/choice/score answers with calibrated probabilities via POST /v1/systemone, and best-of-N candidate ranking via POST /v1/rank. Runs a contrastive state-action head (75 MB) over Qwen3-8B embeddings with an LRU vector cache, answering in ~30 ms server-side. Use for typed decisions, tool/action routing, retrieval shortlisting, and best-of-N verification over a closed candidate set. Not for open-ended generation, extraction of long spans, or multi-step reasoning.
compatibility: Requires the clm-serve and clm-encoder systemd user services on 127.0.0.1:8700/:8090 (laptop-p16) and loopback HTTP access; the type-safe-ai skill documents the same wire format
---

# CLM (local System 1 decision engine via clm-serve)

CLM is a contrastive language model: it embeds a **state** and each candidate
**action** with a frozen Qwen3-8B encoder, projects both through trained heads,
and scores actions by dot-product alignment. A typed question is just a state
plus a closed set of candidate actions, so a softmax over the scores *is* the
answer distribution — no text generation, no parsing, nothing to hallucinate.
The reference head is 75 MB and runs on CPU; the heavy part (embeddings) is a
GPU-resident vLLM pooling server whose vectors are cached, so revisited
states/actions answer in ~0.6-2 ms.

## Access

- **HTTP API** (the primary interface): `clm-serve` on `http://127.0.0.1:8700`:
  - `POST /v1/systemone` — typed questions about a state (below)
  - `POST /v1/rank` — plain best-of-N ranking: `{"context", "question", "answers": [...]}`
  - `GET /v1/models` — served heads (`clm-latest` reference, `clm-raw` ablation)
  - `GET /health` — liveness, vector-cache occupancy and hit rate
  - `GET /` — the playground UI; `?` shareable links; `clm-serve --no-ui` disables
- **Python client**: `~/.local/share/clm/venv` (launcher `clm-python`):
  `from clm import CLMClient, Engine, Choice, Noul, Score`.
  `CLMClient().system_one(state, questions)` and `CLMClient().rank(...)` are
  the client forms; `Engine(emb_url=...)` runs in-process without the server.
- **CLI wrappers** (from the nixos-config `packages/clm`): `clm-setup` (build
  the venv; multi-GB torch/vLLM/CUDA download), `clm-encode` (vLLM Qwen3-8B
  pooling encoder), `clm-serve`, `clm-download` (reference head into
  `~/.cache/clm/`), `clm-demo` (end-to-end typed-questions example).

## POST /v1/systemone

```bash
curl -s http://127.0.0.1:8700/v1/systemone -H 'Content-Type: application/json' -d '{
  "state": "Customer: my invoice was charged twice and nobody answers the phone!",
  "questions": {
    "department": {"type": "choice", "instructions": "Which team should handle this?",
                   "criteria": {"billing": "Charges, invoices, refunds",
                                 "technical": "Bugs and outages"}},
    "urgency": {"type": "score", "instructions": "How urgent is this?",
                "criteria": ["calm", "frustrated", "very angry"]},
    "churn": {"type": "noul", "instructions": "Does the user threaten to leave?"}
  }
}'
```

Answers: `{"noul": p_true}` for noul; `{"choice", "confidence", "probabilities"}`
for choice; `{"score", "confidence", "legend", "probabilities"}` for score, where
`score` is the expected level index over the ordered criteria. `confidence` is
top-probability minus the mean of the others. Options are embedded from their
**description** text (or the key when empty), so write descriptions that
distinguish the candidates. States may be strings, objects (rendered as
`key: value` prose) or arrays (`- item` lines) — never raw JSON, the heads were
trained on prose. Optional `"model"` picks a head; `"temperature"` (0,100]
sharpens/flattens the softmax.

Use `/v1/rank` for free-form candidates (best-of-N answers, tool names, next
moves); it returns `{"ranked": [{"rank", "candidate", "prob"}, ...]}`, best first.

## When to use

- Bounded, label-shaped judgments: intent/urgency/risk triage, routing a request
  to one of N known tools or teams, shortlisting a retrieval pool, picking the
  best of N candidate solutions (verifier role — SOTA on agentic coding
  benchmarks after lightweight fine-tuning).
- Repeated decisions over a mostly fixed action set: the vector cache makes
  revisits nearly free.
- Not for: open-ended text generation, summarization, long-span extraction, or
  anything needing tool calls or multi-step reasoning — use a generative model.
  The candidate set must be closed; CLM scores, it never invents options.

## Ops and troubleshooting

- Services (systemd user units, laptop-p16): `clm-encoder.service` (vLLM
  Qwen3-8B pooling on :8090) and `clm-serve.service` (:8700, wants the
  encoder). They are installed but **not auto-started** — bring them up with
  `systemctl --user start clm-encoder clm-serve` and check
  `systemctl --user status clm-serve clm-encoder`,
  `journalctl --user -u clm-encoder.service`.
- First run downloads: venv via `clm-setup` (several GB), the 75 MB reference
  head into `~/.cache/clm/`, and the ~16 GB Qwen3-8B backbone into the HF
  cache. The encoder then takes minutes to load; until it is up, `clm-serve`
  answers `502 embedder unreachable` — that is warm-up, not a fault.
- `502` persisting after the encoder is up: check `curl -s
  http://127.0.0.1:8090/health` and that `CLM_EMB_MODEL` on both services
  matches (default `qwen3-8b`).
- Port squatting is the classic failure (as with laya on 8765): `ss -tlnp |
  grep -E '8700|8090'` to see who owns the ports.
- GPU memory: the encoder wants ~17 GB VRAM (bf16) plus the action cache
  (2% of device by default, `--action-cache 0` to disable). If VRAM is tight
  next to laya/unsloth, stop the encoder and point `clm-serve` at a remote one
  via `CLM_EMB_URL`.
- Checkpoints hot-reload when the file changes; serve your own head with
  `--ckpt PATH` or a directory with `--ckpt-dir DIR`.
