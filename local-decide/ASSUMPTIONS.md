# local-decide — Assumptions

Exposes one tool, `local_decide`: a bounded "System 1" decision backed by laya, a local non-autoregressive decision engine reached over its `laya-mcp` streamable-HTTP endpoint. The plugin sends one JSON-RPC `tools/call` (`predict`) per invocation and reports the chosen action, `confidence`, and a `confident` boolean against a threshold.

## OpenCode API (hooks used, v1 vs v2, version sensitivity)

- v1: `server(input, options)` factory returning a `tool` map with one tool.
- v2: `id` + `setup(ctx)`; tool via `ctx.tool.transform` / `editor.add`, JSON Schema input, `{ content }` result.
- v1 and v2 share one implementation (`localDecide()`); no divergence between the paths.
- ⚠ v2 hook shape verified by author against opencode 2.0.29 only.

## Environment (env vars read, with defaults; binaries on PATH; OS/process assumptions)

- `LOCAL_DECIDE_URL` — default `http://127.0.0.1:8765/mcp`.
- `LOCAL_DECIDE_TIMEOUT_MS` — default `30000`. ⚠ Parsed with bare `Number()`: a missing-numeric or empty value yields `NaN`, and `setTimeout(fn, NaN)` fires after ~1 ms (verified). Every request is then aborted with a misleading "laya request failed: … aborted" plus a hint to start laya-mcp.
- Reads env at module load (not per call): a runtime env change needs a restart.
- `laya-mcp` must be running (user service; the plugin documents `systemctl --user start laya-mcp`).
- No binaries spawned; no files touched; no network beyond the one localhost endpoint.

## Filesystem & layout (paths read/written, where anchored — cwd / repo root / XDG; formats; encodings)

- None.

## External services (URLs/ports, protocol assumptions)

- `127.0.0.1:8765/mcp` (overridable). POST, `content-type: application/json`, `accept: application/json, text/event-stream`.
- Request: JSON-RPC 2.0, `method: "tools/call"`, `params.name: "predict"`, `arguments: { state, questions: { decision: { type:"choice", instructions, criteria } } }`. ⚠ `id` is always `1` — fine while the endpoint is stateless and single-call-per-connection; it breaks if the server ever multiplexes.
- Response: SSE stream — the plugin takes the **last** `data:` line (FastMCP habit). ⚠ A late keepalive/notification frame after the result frame selects the wrong frame; plain-JSON responses are handled by parsing the whole body.
- ⚠ HTTP status is never checked; a 4xx/5xx body is parsed as if it were a JSON-RPC reply (degrades to an error, but the message can mislead).
- Payload preference: `result.structuredContent.result`, else `JSON.parse(result.content[0].text)`.
- Trusts the laya answer shape: `answers.decision.{choice, confidence, probabilities, action.act_probability}` and `routing.model`.

## Configuration (what opencode.json must register for it to work; whether it actually is)

- ⚠ Intentionally DORMANT: not registered in `opencode.json` or `opencode.json.sample`. Self-documented in the header comment: register `./local-decide/opencode` only when laya is up. The documented state matches the configs.

## Concurrency (locks, multi-instance behavior, atomicity)

- None. Each tool call is an independent HTTP request; one `AbortController` per call, timer always cleared in `finally`.

## Data & LLM behavior (formats trusted from the model; model assumptions)

- `state` (string, required) is trusted verbatim; laya truncates to its context window. An empty string is sent as-is.
- `actions` (string[], required): entries trimmed and blank entries dropped; empty after filtering → clean error. ⚠ Duplicate action strings collapse into one criteria key.
- `threshold` (number, optional, default 0.85): `confident = confidence >= threshold`.
- The model is instructed to treat `confident: false` as "decide yourself or escalate"; the tool never acts on `act_probability` (surfaced only).
- All failure modes return a JSON string `{ ok:false, error, hint? }` rather than throwing, so the LLM always sees a readable result — except the abort case above, which reports a laya failure that is actually a timeout misconfiguration.
