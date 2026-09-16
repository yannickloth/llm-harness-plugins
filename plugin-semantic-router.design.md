# Semantic Router — Design Document

OpenCode plugin that classifies each user message against a set of
embedding-defined **routes** and injects the winning route's directive into the
system prompt (optionally gating tools). Milliseconds, no LLM call, fully local.

Inspired by [Aurelio Semantic Router](https://docs.aurelio.ai/docs/semantic-router/)
— reimplemented in TypeScript to fit this repo's plugin runtime and hot path.

## Why this, and not something else

| Plugin | Decision it makes | How |
|--------|-------------------|-----|
| `tier-router` | Which **model tier** to use | LLM classifier (seconds, costs tokens) |
| `semantic-cache` | Whether to **reuse an answer** | Embedding similarity of the whole request |
| **`semantic-router`** | **Which instructions/behavior apply** | Embedding similarity to route utterances (ms, free) |

Semantic Router is the *intent → behavior* layer: "this message is a code
review, so add review guidelines and don't let the model edit files." It does
not pick models and does not cache answers, so it composes with both plugins.

## What it does

1. On each user message, embed the text (truncated) with any OpenAI-compatible
   `/v1/embeddings` endpoint (default: a local Unsloth/LM Studio server).
2. Compare against each route's **utterance centroid**; the best route must
   clear its `threshold` **and** lead the runner-up by its `margin`.
3. If a route wins, prepend its `inject` block to the system prompt for that
   turn; optionally nudge a `skill`, and enforce `denyTools` via the tool gate.

## Architecture

```
chat.message ──► classify(text) ──► embeddings endpoint (/v1/embeddings)
                     │                    │
                     │              cosine vs route centroids
                     │              threshold + margin
                     ▼
              activeRoutes[sessionID] = match | null
                     │
   experimental.chat.system.transform ──► prepend route.inject block
                     │
   tool.execute.before ──► throw if tool ∈ route.denyTools
```

Hook order in opencode v1.18.30 (`session/prompt.ts` → `session/llm/request.ts`):
`chat.message` runs when the message is created; `system.transform` runs while
the request is assembled — **after** `chat.message` and within the same turn, so
the route applies to the message that produced it.

## Config

Read (merged, later wins by route name) from:

1. `<root>/.semantic-router/routes.json`
2. `<root>/.opencode/semantic-router.json`
3. `~/.config/opencode/semantic-router.json`

`LLMHP_SEMANTIC_ROUTER_CONFIG` overrides with a single path. If no file exists
the plugin is inert (tools still register, nothing is injected).

```jsonc
{
  "encoder": { "baseURL": "http://127.0.0.1:8888/v1", "model": "auto", "timeoutMs": 5000 },
  "fallbackEncoders": [ { "baseURL": "http://127.0.0.1:1234/v1", "model": "auto" } ],  // tried before lexical
  "defaultThreshold": 0.5,
  "defaultMargin": 0.08,
  "lexicalThreshold": 0.25,   // fallback matcher, token-set cosine
  "lexicalMargin": 0.05,
  "routes": [
    {
      "name": "code-review",
      "utterances": ["review this code for bugs", "find bugs in this file"],
      "threshold": 0.45,
      "margin": 0.08,
      "inject": "This is a CODE REVIEW request. Report concrete findings with file:line references; do not rewrite unless asked.",
      "skill": "review",              // optional nudge
      "denyTools": ["write", "edit"], // optional tool gate
      "keywords": ["lint", "regression"] // optional extra tokens for the lexical fallback
    }
  ]
}
```

`encoder.model` may be `"auto"`, which resolves the endpoint's currently loaded model
via `GET /v1/models` — a hardcoded local model name goes stale when the server
swaps models (observed: a 503 `model_switch_failed`). See
`semantic-router/routes.example.json`.

## Matching algorithm

- **Utterance embeddings** are computed once and cached to
  `.semantic-router/embeddings.json`, keyed by a signature of encoder + exact
  utterance set. A config change invalidates the cache; unchanged configs load
  from disk with zero embedding calls.
- **Route vector** = centroid (mean) of its utterance embeddings.
- **Score** = cosine similarity of the query embedding to each centroid.
- **Decision** = top route iff `score ≥ threshold` **and**
  `score − runnerUp ≥ margin`.

### Why the margin

Chat-model embeddings (using a local chat model's `/v1/embeddings`) have a high
baseline: unrelated text often scores 0.6+. Measured on a local encoder:

| Query | Top route (centroid) | Runner-up | Margin | Verdict |
|-------|----------------------|-----------|--------|---------|
| "please review my code for bugs" | code-review 0.917 | 0.692 | 0.225 | match |
| "find sources about DDD" | research 0.743 | 0.619 | 0.125 | match |
| "summarize this document" | research 0.772 | 0.683 | 0.089 | match |
| "tell me a joke" | brainstorm 0.662 | 0.643 | **0.019** | **reject** |
| "what is the weather today" | research 0.622 | 0.581 | **0.041** | **reject** |
| "how do I cook pasta" | brainstorm 0.633 | 0.573 | **0.060** | **reject** |

Threshold alone false-positives on the last three; the margin separates them
cleanly. A dedicated embedding model (bge/nomic) lowers the baseline and makes
the margin less critical, but the plugin works with a chat-model encoder because
of it. `semantic-route` reports all candidate scores so thresholds/margins can
be tuned empirically.

## Tools

| Tool | Purpose |
|------|---------|
| `semantic-route(question)` | Classify a query; returns the winning route, score, and all candidate scores (for tuning/debugging) |
| `semantic-route-status()` | Config sources, encoder, routes, thresholds/margins, active route, cache state |
| `semantic-route-reload()` | Reload config, clear the index and query cache |

## Fallback chain (never fail-closed)

Routing degrades in three steps, so an embedding outage costs accuracy, not
function:

1. **Primary encoder** (`encoder`).
2. **Fallback encoders** (`fallbackEncoders[]`) — tried in order; the first that
   can embed (or whose cached vectors are present) wins. `auto` model resolution
   is per-encoder.
3. **Lexical fallback** — when every encoder is unreachable, match with a local
   token-set cosine over the route utterances (plus any `keywords`). No network,
   no dependency. Scored with `lexicalThreshold` / `lexicalMargin` because the
   scale differs from embedding cosine. Verified on the ivp route set: all
   intended intents still route, all noise still returns null.

Embedding failures trigger a **cooldown** (`LLMHP_SEMANTIC_ROUTER_COOLDOWN_MS`,
default 60s) before retrying; until then messages use the lexical matcher. The
`semantic-route` tool reports `mode: "embeddings" | "lexical"` so it is visible
which path served a decision. The main task is never blocked.

- Malformed config file → logged, ignored; other config files still merge.
- No config → inert.

## Env

| Var | Default | Effect |
|-----|---------|--------|
| `LLMHP_SEMANTIC_ROUTER` | — | `0` disables the plugin |
| `LLMHP_SEMANTIC_ROUTER_CONFIG` | candidates | Explicit config path |
| `LLMHP_SEMANTIC_ROUTER_BASE_URL` | config | Override encoder base URL |
| `LLMHP_SEMANTIC_ROUTER_MODEL` | config | Override encoder model |
| `LLMHP_SEMANTIC_ROUTER_API_KEY` | config | Override encoder key |
| `LLMHP_SEMANTIC_ROUTER_THRESHOLD` | config | Override default threshold |
| `LLMHP_SEMANTIC_ROUTER_MARGIN` | config | Override default margin |
| `LLMHP_SEMANTIC_ROUTER_TIMEOUT_MS` | `5000` | Embedding request timeout |
| `LLMHP_SEMANTIC_ROUTER_COOLDOWN_MS` | `60000` | Backoff after a failure |

## File structure

```
semantic-router/
├── opencode/
│   ├── index.ts          # hooks + tools + embedding client (default export only)
│   ├── helpers.ts        # pure: parse/merge, cosine, centroid, matchRoute, hashing
│   └── index.test.ts     # 19 bun tests
├── routes.example.json   # starter config
└── README.md             # usage
```

**TypeScript-only, no Java core.** The matcher runs on the `chat.message` hot
path; a JVM start per message (~150ms) would dominate the embedding call
(~10–50ms). Precedent: `datetime-inject` is also TS-only. Pure logic lives in
`helpers.ts` and is unit-tested.

## Testing

`bun test semantic-router/opencode/index.test.ts` — 19 tests: cosine/centroid,
threshold+margin matching, lexical tokenize/setCosine/matchLexical, config
parse/merge/validation, signature stability, injection text, and an integration
suite against a mock `/v1/embeddings` server (routing, tool gating, cache reuse
across instances, `auto` model resolution, encoder fallback, lexical fallback,
kill switch).
Wired into `build.sh`.

## Limitations / future work

- **Threshold/margin tuning is manual.** `semantic-route` exposes scores;
  automated optimization (semantic-router's `fit`) is not implemented.
- **Chat-model embeddings are not ideal.** A dedicated embedding model is
  recommended; the margin mitigates the high baseline.
- **Lexical fallback is coarse.** It is a graceful degradation, not a semantic
  match; expect lower recall/precision than embeddings.
- **No dynamic routes / function calls.** Routes inject text and gate tools;
  they do not generate parameters or call functions.
- **Primary-session scoping.** Routes are computed per session from user
  messages; subagent sessions get no route (no `chat.message`).
