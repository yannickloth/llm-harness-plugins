# premium-read-offload — Assumptions

OpenCode plugin that keeps bulk file reads and boilerplate generation out of a
premium subscription session (Kimi K3, GLM-5.3, GLM-5.3-Flash). A hard gate in
`tool.execute.before` blocks unbounded `read` and plain `cat/head/tail/less/more`
on premium sessions, redirecting to the `offload-read` tool. `offload-read` and
`code-write` run a persistent cheap `deepseek-flash` worker via child
`opencode run` (one resumed session per corpus fingerprint, so DeepSeek's prefix
cache serves follow-ups). Worker answers are mechanically citation-verified
(Java `CitationVerifier`) and returned as a JSON provenance contract.

## OpenCode API (hooks used, v1 vs v2, version sensitivity)

- v2 entry: `id` + `setup(ctx)`; v1 served through `server(input, options)` as a function-form factory (opencode 1.x).
- v2 hooks used: `ctx.session.hook("prompt")` + `ctx.session.hook("context")` (record session model), `ctx.tool.hook("execute.before")` (gate; throw = block), `ctx.tool.transform` (4 tools), `ctx.agent.transform` (register worker agents inline).
- v1 hooks used: `chat.message` (record `input.model.{providerID,modelID}` per session), `tool.execute.before` (`input.tool`, `output.args`; throw = block), `config` (register agents inline on the `agent` map), `tool` map (4 tools).
- ✅ v2 model arming **verified empirically** (live 2.2.5 probe, 2026-11-06): the `context` hook event carries `{ sessionID, model: { id, providerID, variant }, system: [{type, text, …}], messages, options, agent, tools }` — the plugin's read (`model?.providerID`, `model?.modelID ?? model?.id`) matches (the model field is `id`, covered by the fallback). So v2 sessions DO get recorded and the gate arms.
- ⚠ The v2 `prompt` hook does **not** carry a model (probe payload: `{ sessionID, messageID, prompt: {text, files, agents, skills}, metadata, delivery }`) — the prompt-hook model read is inert; all model recording happens in the context hook.
- ⚠ v2 root anchor `ctx.location?.project?.canonical ?? ctx.location?.directory` has no null guard; both undefined → `path.resolve(root, ...)` throws in tools/hooks.
- v1 fail-open contract: any infrastructure error in the gate (java missing, CLI error) is swallowed and the read allowed; only an Error whose message starts with `PREMIUM_READ_OFFLOAD` (the deliberate block) re-throws.
- `read` tool args assumed to be `{ filePath, offset, limit }` (with `file_path` fallback); `bash` args `{ command }` (with `cmd` fallback).
- Worker agents assumed invocable via `opencode run --agent <name>`; an unregistered or `subagent`-mode agent makes opencode warn and fall back to the default agent (citation prompt dropped, all answers tagged unverified).

## Environment (env vars, PATH, OS/process)

- `java` on PATH must be JDK 25 (classes compiled with `--release 25`; committed in `build/classes`, no build step required).
- `opencode` on PATH (worker transport is a child `opencode run`).
- `jq` on PATH for `evals/run.sh` only (not needed at runtime).
- Env vars (defaults): `LLMHP_PREMIUM_OFFLOAD` (kill switch, `"0"` disables), `LLMHP_OFFLOAD_WORKER_MODEL` (`deepseek/deepseek-flash`), `LLMHP_OFFLOAD_READER_AGENT` (`bulk-reader`), `LLMHP_OFFLOAD_WRITER_AGENT` (`code-writer`), `LLMHP_OFFLOAD_MIN_LINES` (`1000`), `LLMHP_OFFLOAD_ZAI_MIN_LINES` (`400`), `LLMHP_OFFLOAD_TARGETED_MAX` (`2000`), `LLMHP_OFFLOAD_MIN_WORTH_LINES` (`200`), `LLMHP_OFFLOAD_TIMEOUT_MS` (`180000`), `LLMHP_OFFLOAD_TTL_DAYS` (`14`), `LLMHP_OFFLOAD_DATA_DIR` (else `$XDG_RUNTIME_DIR/premium-read-offload`, else `os.tmpdir()/premium-read-offload`).
- ⚠ `LLMHP_NO_SUBSPAWN`: `safeSpawn` does NOT set it on the worker child (only `spawnDetached` does), so the `code-write` subprocess guard never fires for worker children, and `offload-read` has no such guard at all — a worker session can in principle re-invoke offload tools and spawn nested `opencode run` children (bounded only by the worker model's behavior).
- `XDG_DATA_HOME`/`XDG_RUNTIME_DIR` semantics assumed (XDG-compliant platform, typically Linux).
- ⚠ Worker timeout (180 s default) only races the promise; the child `opencode run` process is not killed on timeout and keeps running (and spending) past the cap.

## Filesystem & layout (paths, anchoring, formats)

- Project state under `<root>/.premium-read-offload/` (root = `worktree ?? directory` in v1, ctx root in v2): `.sessions/<sessionId>.json` (last model per session), `.workers/<corpusHash>.json` (fingerprint → worker session id), `.permits/<session>__<hash>.json` (one-shot direct-read permits), `metrics.jsonl` (append-only telemetry).
- All writes WAL-atomic (tmp → fsync → ATOMIC_MOVE, REPLACE_EXISTING fallback); metrics append is a single non-atomic `FileChannel` append.
- Corpus fingerprint: `path:size:mtimeMillis` per path, joined; key = 64-bit polynomial hash; stored fingerprint is compared on lookup (changed corpus = miss, stale session never resumed).
- Worker session ids are opencode `ses_...` strings extracted from the first JSON event of `opencode run --format json` output (newline-delimited events, top-level `sessionID`; text parts `{"type":"text","part":{"text":...}}`).
- Corpus and worker prompts go on the child's stdin, never argv (E2BIG / `MAX_ARG_STRLEN` guard).
- Worker data home: `XDG_DATA_HOME` is repointed at the isolated worker dir; `auth.json`/`account.json` are symlinked (copy fallback) from the real `~/.local/share/opencode/` into it — without this the built-in provider 401s.
- ⚠ Worker sessions in the isolated data home are pruned by record TTL only; the underlying opencode sessions themselves are never deleted and accumulate until `$XDG_RUNTIME_DIR` is cleared.
- Encodings: UTF-8 (Java I/O explicit; TS reads/writes utf-8).
- `CitationVerifier` reads cited files with `Files.readAllLines(UTF-8)`: ⚠ non-UTF-8 corpus files make every citation of that file `unreadable` (fail-safe, all tagged unverified).

## External services

- DeepSeek API via the `deepseek/deepseek-flash` model (or `LLMHP_OFFLOAD_WORKER_MODEL`) — authenticated through the linked `auth.json`; no other network calls.
- Assumed: DeepSeek automatic prefix cache serves resumed-session follow-ups near-free (design §5, empirically verified 2026-09-13: 99.6% cache hit on turn 3).
- Assumed: premium subscriptions (Kimi Allegretto, ZAI GLM Coding Plan) gate on the provider/model pair as configured; no quota API is consulted (open-loop by design).

## Configuration (opencode.json)

- ⚠ Root `opencode.json` registers neither the plugin nor the agents. `opencode.json.sample` registers `./premium-read-offload/opencode` plus agents `bulk-reader` and `code-writer` (`mode: "all"`, `model: "deepseek/deepseek-flash"`, read-only permissions) — the plugin is inert without an equivalent config.
- If the agents are NOT pre-registered in the config, the plugin registers them inline from `agents/*.md` — and the md frontmatter says `mode: subagent`, which re-triggers the `opencode run --agent` fallback (default agent, citation prompt dropped) that design §14g fixed for the sample config only.
- Worker model must be reachable under the linked auth; a 401 surfaces as `worker produced no text output`.
- Gate provider/model list is hardcoded in Java (`kimi`, `kimi-for-coding`, `zai`, `zai-coding-plan` providers; model substring markers `k3`, `glm-5.3`): ⚠ the opencode 2.2.5 catalog contains model id `kimi-k3` (matches) but the Kimi Code subscription models `kimi-for-coding`/`kimi-for-coding-highspeed` do not contain `k3`, so the gate stays dormant for those models; the evals' assumed id `k3-256k` is not in the catalog.

## Concurrency (locks, multi-instance, atomicity)

- Each CLI call is a fresh JVM; state correctness relies on per-file atomic renames.
- One-shot permit consumption is a check-then-delete: safe across processes because `Files.delete` is the atomic consume (second caller gets false).
- ⚠ The permit is consumed by ANY read of the path (even targeted/small/non-premium reads that would be allowed anyway) — a grant can be silently eaten by a targeted read, blocking the intended full read.
- ⚠ No lock on `.premium-read-offload/` across opencode instances: two instances recording the same session or offloading the same corpus race on the same files (atomic renames prevent corruption; worker-set last-writer-wins).
- Worker child processes are not tracked after spawn (no handle kept); a timeout leaves them running.
- v1 spawns one JVM per `chat.message` for `record-model` (no dedup); v2 dedups per session+model but never cleans the dedup map (no session-deleted handling).

## Data & LLM behavior (trusted formats, model assumptions)

- Worker output format trusted: `opencode run --format json` NDJSON events with `sessionID` and `type:"text"` parts; no text → error surfaced to the agent.
- ⚠ Premium model detection is substring matching on lowercased model id (`k3`, `glm-5.3`): any future model containing those substrings is treated as premium; `glm-5.3-flash-free` (in the catalog) also matches.
- Gate thresholds are line counts: Kimi 1000, ZAI 400, targeted cap 2000 (`limit`); ⚠ offset-only reads (no `limit`) are treated as targeted and allowed — `read(offset: 1)` reads the whole file and bypasses the gate, contrary to design §7's "limit ≤ cap" definition of targeted.
- ⚠ Bash gate parses only the first plain-read command: multiple file args to `cat` are not detected as ambiguous (first file only, though the docstring promises empty for multiple files); `;`/`&&`-chained commands are not split — later `cat bigfile` segments pass.
- Bash `bounded` detection: numeric `head/tail` counts (`-100`, `-n 100`, `--lines=100`, `-c 10`) and all `less`/`more` invocations count as targeted.
- ⚠ `decide-read` fails closed when the file exists but line counting throws (blocks with `-1 lines`); `decide-bash` fails open on the same condition — inconsistent with the documented fail-open stance.
- Worth-it guard: cache hit → always offload; trivial metadata questions (regex list) → never offload; cold worker + corpus < 200 lines → skip (`{skipped:true}` returned).
- Citation contract trusted from the worker model: `[cite: <path>:<start>[-<end>] "<exact quote>"]`; verification checks the quote exists in the cited range (whitespace-collapsed) — a "verified" citation proves text presence, not claim truth. Answers without citations get `[unverified: no citations found]`.
- `code-write` trusts the reference file's conventions; generated output has markdown fences stripped (regex also strips any inner fence lines) and is written to `target` without further review machinery.
