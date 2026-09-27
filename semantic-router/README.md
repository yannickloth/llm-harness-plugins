# semantic-router

Fast, local, config-driven intent routing for OpenCode. Each user message is
embedded and matched against your routes; the winning route's directive is added
to the system prompt (and its tool restrictions enforced). No LLM call, no
per-message token cost. See `../plugin-semantic-router.design.md` for the full
design.

## Install

Add to your project's `opencode.json`:

```json
{
  "plugin": ["./llm-harness-plugins/semantic-router/opencode/index.ts"]
}
```

Requires a reachable OpenAI-compatible `/v1/embeddings` endpoint, or omit `encoder` to run lexical-only. No build step.

## Configure

Copy `routes.example.json` to `<project>/.semantic-router/routes.json` and edit:

```jsonc
{
  // Optional: omit `encoder` (and fallbacks) to route with the local lexical
  // matcher only — no model, no endpoint, no timeout.
  "encoder": { "baseURL": "http://127.0.0.1:8888/v1", "model": "auto" },
  "fallbackEncoders": [ { "baseURL": "http://127.0.0.1:1234/v1", "model": "auto" } ],
  "defaultThreshold": 0.5,
  "defaultMargin": 0.08,
  "lexicalThreshold": 0.25,
  "lexicalMargin": 0.05,
  "routes": [
    {
      "name": "code-review",
      "utterances": ["review this code for bugs", "find bugs in this file"],
      "threshold": 0.45,              // per-route override of defaultThreshold
      "margin": 0.1,                  // per-route override of defaultMargin
      "inject": "CODE REVIEW mode: report concrete findings with file:line; do not edit.",
      "skill": "review",             // optional: nudge this skill when matched
      "denyTools": ["write", "edit"],// optional: block these tools while active
      "keywords": ["lint", "regression"] // optional: extra tokens for the lexical fallback
    }
  ]
}
```

**Config fields**

| Field | Default | Meaning |
|-------|---------|---------|
| `encoder` | no | OpenAI-compatible `/v1/embeddings` endpoint (`baseURL`, `model`, optional `apiKey`, `timeoutMs`). `model: "auto"` resolves the endpoint's currently loaded model via `/v1/models`. **Omit it to run lexical-only** (no model needed). |
| `fallbackEncoders` | `[]` | Encoders tried in order when the primary fails, before the lexical fallback |
| `defaultThreshold` | `0.5` | Cosine cutoff a route must clear |
| `defaultMargin` | `0.08` | Required lead over the runner-up route |
| `lexicalThreshold` | `0.25` | Threshold for the lexical fallback matcher |
| `lexicalMargin` | `0.05` | Margin for the lexical fallback matcher |

**Route fields**

| Field | Required | Meaning |
|-------|----------|---------|
| `name` | yes | Route id (also the winner reported) |
| `utterances` | yes | Example messages defining the route's meaning |
| `threshold` / `margin` | no | Per-route overrides (both embedding and lexical modes) |
| `inject` | no | Instruction block added to the system prompt when matched |
| `skill` | no | Nudges the model toward this skill when matched |
| `denyTools` | no | Tool names blocked while the route is active |
| `keywords` | no | Extra tokens for the lexical fallback (rare terms, synonyms) |

A route matches only if its similarity clears `threshold` **and** leads the
runner-up by `margin`. Chat-model embeddings have a high baseline, so the margin
is what suppresses false positives; tune both with the `semantic-route` tool,
which reports every candidate's score.

Config is merged from `.semantic-router/routes.json`,
`.opencode/semantic-router.json`, and `~/.config/opencode/semantic-router.json`
(later wins by route name). With no config the plugin is inert.

## Tools

- `semantic-route(question)` — classify a query, show all scores.
- `semantic-route-status()` — config, encoder, routes, active route.
- `semantic-route-reload()` — reload config and clear caches.

## Fallback

If the encoder is unreachable, the plugin tries `fallbackEncoders[]`, then
degrades to a local **lexical** matcher (token-set cosine) so routing keeps
working with no network. `semantic-route` reports which `mode` served the
decision. Tune the fallback with `lexicalThreshold` / `lexicalMargin`.

## Env

`LLMHP_SEMANTIC_ROUTER=0` disables it. Encoder/threshold overrides:
`LLMHP_SEMANTIC_ROUTER_{CONFIG,BASE_URL,MODEL,API_KEY,THRESHOLD,MARGIN,TIMEOUT_MS,COOLDOWN_MS}`.

## Test

```bash
bun test semantic-router/opencode/index.test.ts
```
