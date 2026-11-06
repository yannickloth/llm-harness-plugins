# semantic-router — Assumptions

Classifies each user message by embedding similarity against configured routes; the winning route's directive is prepended to the system prompt and its `denyTools` are enforced via the tool gate. Pure TypeScript (no Java); degrades to a local lexical matcher when no encoder is reachable.

## OpenCode API (hooks used, v1 vs v2, version sensitivity)

- One module serves both: v2 object entry (`id`, `setup(ctx)`) and legacy v1 via `server(input)`. ⚠ The two paths must be kept in sync by hand.
- v1 hooks: `chat.message` (async), `experimental.chat.system.transform` (prepends to `output.system: string[]`), `tool.execute.before` (throw blocks the tool call), plus the `tool` map. ⚠ Same contract as datetime-inject / premium-read-offload v1.
- v2 hooks: `ctx.session.hook("prompt")` (async, reads `event.prompt.text`), `ctx.session.hook("context")` (prepends `{type:"text"}` to `event.system`), `ctx.tool.hook("execute.before")` (throw blocks; reads `event.tool ?? event.name` and `event.sessionID`), `ctx.tool.transform` (`editor.add`, JSON Schema, `{ content }` results). ⚠ Shapes follow datetime-inject / premium-read-offload v2 ports.
- v2 root comes from `ctx.location?.project?.canonical ?? ctx.location?.directory`. ⚠ If `ctx.location` is absent, `setup()` throws and the whole plugin fails to load (not inert).
- v1 root = `worktree ?? directory`.
- The prompt hook is async (awaits the embedding call). The route is stored in `activeRoutes[sessionID]` and read by the context/tool hooks in the same turn. ⚠ This is only correct if the host awaits the prompt hook before assembling the request; otherwise the route lags by one message.

## Environment (env vars, binaries, OS)

- `LLMHP_SEMANTIC_ROUTER` — exactly `0` disables the plugin (any other value, including `false`, keeps it on). ⚠
- `LLMHP_SEMANTIC_ROUTER_CONFIG` — explicit single config path (relative resolves against root).
- `LLMHP_SEMANTIC_ROUTER_BASE_URL` / `_MODEL` / `_API_KEY` — override the primary encoder. ⚠ Partial overrides (e.g. only one of baseURL/model) are silently ignored when the config has no encoder.
- `LLMHP_SEMANTIC_ROUTER_THRESHOLD` / `_MARGIN` — no numeric validation. ⚠ A non-numeric value yields NaN, which makes threshold AND margin checks pass: every message then matches the top route.
- `LLMHP_SEMANTIC_ROUTER_TIMEOUT_MS` — default 5000; no numeric validation. ⚠ A non-numeric value yields NaN → `setTimeout(…, NaN)` aborts every request immediately → permanent lexical fallback.
- `LLMHP_SEMANTIC_ROUTER_COOLDOWN_MS` — default 60000; read once at module load. ⚠ Changing it requires a process restart.
- No external binaries; relies on the runtime's global `fetch` (Bun/Node 18+).

## Filesystem & layout (paths, anchors, formats, encodings)

- Config merged in order, later file wins per route name: `<root>/.semantic-router/routes.json`, `<root>/.opencode/semantic-router.json`, then the same two under `directory` (v1), then `~/.config/opencode/semantic-router.json`. ⚠ `parseConfig` normalizes missing defaults, so `mergeConfigs` cannot tell an explicit value from a default — a later file without `defaultThreshold` overwrites an earlier file's explicit one (observed).
- Malformed config file → logged once (only the last error is kept), other files still merge.
- Embedding cache: `<root>/.semantic-router/embeddings.json`, keyed by a signature of encoder (baseURL+model) and exact utterance set. ⚠ Written with a non-atomic `writeFileSync` into the user's project; a `.gitignore` is auto-created if absent.
- No config → inert (no injection; tools still register).
- All I/O is UTF-8 JSON.

## External services (URLs/ports, protocol)

- OpenAI-compatible `POST {baseURL}/embeddings` with `{model, input}`; expects `data[].embedding` arrays, in input order. ⚠ Batch response order is assumed to match the request (the `index` field is ignored).
- `GET {baseURL}/models` when `model: "auto"`. ⚠ This fetch has no timeout: a hung endpoint hangs the message hook indefinitely (the failure cooldown only covers the `/embeddings` calls).
- `model: "auto"` picks `data.find(m => m.loaded) ?? data[0]`. ⚠ `loaded` is not part of the OpenAI spec; standard endpoints return no such field, so the first listed model is used silently.
- `fallbackEncoders[]` are tried in order after the primary, before the lexical matcher.
- Per-request timeout = encoder `timeoutMs` (default 5000). After any failure, encoders are skipped for the cooldown window (lexical mode).
- Default example endpoint: `http://127.0.0.1:8888/v1` (local Unsloth/LM Studio).

## Configuration (opencode.json registration)

- The plugin must be listed in `opencode.json` (`./semantic-router/opencode`). The repo's root `opencode.json` does NOT register it; `opencode.json.sample` does. ⚠
- Routes need `name` + non-empty `utterances[]`; `threshold`/`margin` are optional per-route overrides.
- `denyTools` are exact tool-name matches. ⚠ A tool rename silently disables the gate.

## Concurrency (locks, multi-instance, atomicity)

- No locks; all state is in-memory per process (`activeRoutes`, `queryCache` capped 256, `autoModels`).
- `ensureIndex` is not guarded against concurrent calls: two parallel sessions can both embed the route index and both write the cache file. ⚠ Content is deterministic, so the overwrite is harmless but wasteful.
- `activeRoutes` persists per session across turns. ⚠ A stale route from the previous message applies until the next message reclassifies (by design: "route stays active").
- Query embeddings are cached by encoder-signature + text hash; long messages are truncated to 2000 chars before hashing (identical prefixes collide by construction).

## Data & LLM behavior (trusted formats, model assumptions)

- Embedding vectors are trusted as `number[]`; a dimension mismatch is silently truncated by `cosine` (min length), not rejected. ⚠ If the route index was built with one encoder and queries are embedded with another (fallback), scores are meaningless but look plausible — no guard ties query and index to one encoder.
- Decision rule: top route wins iff `score ≥ threshold` AND `score − runnerUp ≥ margin` (per-route overrides in BOTH modes). ⚠ Per-route thresholds tuned for embedding cosine are also applied in lexical mode, where the score scale differs.
- Lexical fallback: lowercase a-z0-9 tokens, small stopword list, crude trailing-`s` stem; Jaccard-like set cosine with `lexicalThreshold` (0.25) / `lexicalMargin` (0.05).
- The injected block is plain text prepended to the system prompt; the model is assumed to follow it.
- The `semantic-route` tool reports `mode: "embeddings" | "lexical"` and all candidate scores for tuning.
- Subagent sessions also fire `chat.message`, so they are classified and gated like main sessions. ⚠ (The design doc claims subagents get no route; that statement is not true for the code.)
