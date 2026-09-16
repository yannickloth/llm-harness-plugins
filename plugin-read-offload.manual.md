# premium-read-offload — User Manual

## Purpose

Keeps bulk file reads and boilerplate generation out of a **premium subscription
session** (Kimi K3, GLM-5.3, GLM-5.3-Flash) by delegating them to a cheap
persistent `deepseek-flash` worker. Premium quota is scarce and (for ZAI)
non-rollover; a large read that only needs *understanding* is exactly the spend
to avoid.

Three layers:

| Layer | What it does |
|-------|--------------|
| **Hard gate** | `tool.execute.before` blocks unbounded `read` (and `cat`/`head`/`tail`/`less`/`more`) on a premium session, naming the replacement tool |
| **Delegation** | `offload-read` / `code-write` run the work on a cheap worker and return a derived answer, not file bytes |
| **Escapes** | targeted `offset`/`limit` reads, or a one-shot `allow-direct-read` before an edit |

The gate is **open-loop**: it cannot see subscription quota, so it offloads on
every qualifying premium read. Only the active session's provider/model decides
whether it fires.

## Install

### 1. Register the plugin

Add to your project's `opencode.json` `plugin[]`. It is independent of other
plugins — position is irrelevant.

```json
"plugin": [
  "./llm-harness-plugins/premium-read-offload/opencode/index.ts"
]
```

### 2. Register the two worker agents

```json
"agent": {
  "bulk-reader": {
    "file": "./llm-harness-plugins/premium-read-offload/agents/bulk-reader.md",
    "model": "deepseek/deepseek-flash",
    "mode": "all",
    "permission": { "read": "allow", "edit": "deny", "bash": "deny", "glob": "allow", "grep": "allow" }
  },
  "code-writer": {
    "file": "./llm-harness-plugins/premium-read-offload/agents/code-writer.md",
    "model": "deepseek/deepseek-flash",
    "mode": "all",
    "permission": { "read": "allow", "edit": "deny", "bash": "deny", "glob": "allow", "grep": "allow" }
  }
}
```

The agent names are what `LLMHP_OFFLOAD_READER_AGENT` / `LLMHP_OFFLOAD_WRITER_AGENT`
default to. Register both, or set the matching env var to `none` to run the
worker without an agent (which also drops the citation/format prompt). Passing
`--agent` for an unregistered name makes the worker invocation fail.

### 3. Requirements

- Java 25 (`java -version`) — the deterministic core is compiled and committed; **no build step**.
- `opencode` on `PATH` — the worker is a child `opencode run`.
- A reachable `deepseek/deepseek-flash` (or your `LLMHP_OFFLOAD_WORKER_MODEL`).
- Restart OpenCode. On start the log shows `premium-read-offload plugin active — gate on premium sessions, worker=...`.

### Example — `~/code/ivp-book-series`

That project lives next to this repo, so plugin paths are `../llm-harness-plugins/…`.
Append to `plugin[]` in `~/code/ivp-book-series/opencode.json`:

```json
"../llm-harness-plugins/premium-read-offload/opencode/index.ts"
```

and add the two agents to its `agent` object (same relative path):

```json
"bulk-reader": {
  "file": "../llm-harness-plugins/premium-read-offload/agents/bulk-reader.md",
  "mode": "all",
  "model": "deepseek/deepseek-flash",
  "thinking": { "type": "disabled" }
},
"code-writer": {
  "file": "../llm-harness-plugins/premium-read-offload/agents/code-writer.md",
  "mode": "all",
  "model": "deepseek/deepseek-flash",
  "thinking": { "type": "disabled" }
}
```

> `ivp-book-series` currently runs `deepseek/*` for its main session and agents,
> so the gate stays dormant there (reads pass through — no premium pool to
> protect). It activates only when the active session's provider is `kimi`,
> `kimi-for-coding`, `zai`, or `zai-coding-plan`. That makes it safe to register now and use the moment
> a Kimi/GLM session is opened. Worker model `deepseek/deepseek-flash` matches
> the project's existing tier.

## When the gate fires

The decision uses the model recorded from the most recent `chat.message` for
that session (`tool.execute.before` carries no model info).

| Situation | Result |
|-----------|--------|
| Non-premium session (`deepseek`, …) | allow |
| Unknown model (fresh restart, no message yet) | allow (fail open) |
| Premium + `read` > threshold, no `offset`/`limit` | **block** → names `offload-read` |
| Premium + `read` with `offset`/`limit` ≤ 2000 and not the whole file | allow |
| Premium + `offset`+`limit` covering the whole file, or `limit` > 2000 | **block** |
| Nonexistent file | allow (so `read` reports the real error) |
| Direct-read permit outstanding for `(session, path)` | allow (consumed once) |
| Premium + `cat`/`head`/`tail`/`less`/`more` on a large file, no pipe/redirect | **block** |
| Piped / redirected command, `head -100`, non-read command | allow |
| Unparseable bash read | allow (fail open) |

Thresholds: **Kimi 1000 lines**, **ZAI 400 lines** (lower — preserve
non-rollover credits), targeted-read cap **2000**.

## Tools

### `offload-read(question, paths)`

The primary replacement for a gated read. Feeds the files to the persistent
worker and returns a **JSON contract** (not file bytes).

```jsonc
{
  "answer": "- parseConfig validates the schema. [cite: /abs/config.ts:41-48 \"function parseConfig...\"]",
  "files_read": ["/abs/config.ts"],
  "line_ranges": { "/abs/config.ts": { "from": 1, "to": 3000, "total": 3000 } },
  "worker_session": "ses_...",
  "cache_hit": false,
  "citations": {
    "total": 1, "verified": 1, "unverified": 0, "hasCitations": true,
    "items": [{ "path": "/abs/config.ts", "start": 41, "end": 48, "quote": "…", "status": "verified" }]
  },
  "verification": "ok"
}
```

| Field | Meaning |
|-------|---------|
| `answer` | The derived summary. Claims with unresolvable citations carry `[unverified]`. |
| `files_read` | Absolute paths handed to the worker (ordered). |
| `line_ranges` | Per file, the range actually provided (`from`/`to`) and the file's `total`. Deterministic — never a model guess. |
| `worker_session` | The worker's `opencode` session id (the corpus cache key). |
| `cache_hit` | `true` when a stored worker session for this exact corpus was resumed (near-free follow-up). |
| `citations` | Mechanical verification of the worker's `[cite: …]` annotations. |
| `verification` | `"ok"` (core ran) or `"error"` (core unreachable → answer unannotated, fail open). |

**How to use it:** read `answer`; use `line_ranges`/`files_read` to judge
coverage ("the worker saw all 3000 lines, so this is a reduction of the whole
file"); treat `[unverified]` claims as leads, not facts; use `cache_hit` to know
a follow-up was cheap.

When the offload is declined as not worth it, it returns
`{ "skipped": true, "reason": …, "hint": … }` instead.

### `allow-direct-read(path, reason)`

Grants a **one-shot, path-scoped** permission to read a large file directly.
Use only when exact bytes are genuinely needed (e.g. before an edit). Call it,
then retry the `read`. The reason is logged; the permit is consumed by the next
matching read.

### `code-write(spec, reference, target?)`

Delegates boilerplate generation (tests, config, docstrings, type stubs) to the
worker. `reference` is **required** — the file whose conventions the output must
match. Omit `target` to get the code back; pass `target` to write it to disk.
Markdown fences are stripped. In a subprocess (`LLMHP_NO_SUBSPAWN=1`) it is a
no-op.

### `offload-status()`

Reports worker model, data dir, thresholds, worker TTL, known worker session
ids, and the metrics path — useful to confirm the plugin loaded.

## Citations and verification

The `bulk-reader` prompt requires every claim to end with:

```
[cite: <path>:<start>[-<end>] "<exact quoted text>"]
```

`CitationVerifier` (Java) resolves the path against the corpus the worker was
given, checks the line range exists, and checks the quoted text appears in it
(whitespace-collapsed). Verdicts:

| Status | Meaning |
|--------|---------|
| `verified` | Range exists **and** the quote matches that range |
| `quote_mismatch` | Range exists but the quote is not there |
| `missing_lines` | Line range outside the file |
| `no_quote` | Range exists, no quote supplied |
| `unknown_path` | Path does not resolve against the corpus |
| `unreadable` | File could not be read |

Failing citations are tagged `[unverified]` inline; an answer with **no**
citations gets `[unverified: no citations found]`.

> A verified citation means "this text really is at these lines" — **not** that
> the worker's conclusion is correct. Verify exact values yourself before any
> edit; the design keeps edits on the main model.

## Escapes from the gate

1. **Targeted read** — `read` with `offset`/`limit` (`limit` ≤ 2000 and not the
   whole file) passes. Use for a known line range.
2. **`allow-direct-read`** — deliberate, auditable, one-shot, path-scoped.
3. **Kill switch** — `LLMHP_PREMIUM_OFFLOAD=0` disables the whole plugin.

Chunked-read loops are accepted as a bounded risk (the goal is to make the cheap
path the default, not to make circumvention impossible); they are visible in the
audit/metrics log.

## Configuration

All via environment variables (defaults in parentheses):

| Variable | Default | Effect |
|----------|---------|--------|
| `LLMHP_PREMIUM_OFFLOAD` | — | `0` disables the plugin entirely |
| `LLMHP_OFFLOAD_WORKER_MODEL` | `deepseek/deepseek-flash` | Worker model |
| `LLMHP_OFFLOAD_READER_AGENT` | `bulk-reader` | Read worker agent (or `none`) |
| `LLMHP_OFFLOAD_WRITER_AGENT` | `code-writer` | Generation worker agent (or `none`) |
| `LLMHP_OFFLOAD_MIN_LINES` | `1000` | Kimi bulk-read threshold |
| `LLMHP_OFFLOAD_ZAI_MIN_LINES` | `400` | ZAI bulk-read threshold |
| `LLMHP_OFFLOAD_TARGETED_MAX` | `2000` | Max `limit` still "targeted" |
| `LLMHP_OFFLOAD_MIN_WORTH_LINES` | `200` | Cold worker skipped below this corpus size |
| `LLMHP_OFFLOAD_TIMEOUT_MS` | `180000` | Worker invocation cap |
| `LLMHP_OFFLOAD_TTL_DAYS` | `14` | Worker-session record TTL |
| `LLMHP_OFFLOAD_DATA_DIR` | runtime/tmp | Worker sessions' data home |

## State, cache, and cleanup

All under `<project>/.premium-read-offload/`:

| Path | Contents |
|------|----------|
| `.sessions/<id>.json` | Last provider/model seen per session (gate input) |
| `.workers/<hash>.json` | Corpus fingerprint → worker session id (the cache) |
| `.permits/<session>__<hash>.json` | One-shot direct-read permits |
| `metrics.jsonl` | Append-only cost telemetry |

The worker cache is keyed by a `path:size:mtime` fingerprint, and the stored
fingerprint is **compared** on lookup — a changed corpus is a miss, so a stale
summary can never be resumed. Records older than the TTL are pruned on plugin
start. `metrics.jsonl` records observed counts only (cache hit, latency, corpus
and answer size, citation counts, paths, worker session) — never a fabricated
dollar or quota figure.

The worker's `opencode` sessions live in a **separate data home**
(`$LLMHP_OFFLOAD_DATA_DIR`, else `$XDG_RUNTIME_DIR/premium-read-offload`), so
they never appear in your session list. Because built-in providers read
credentials from that data home, the plugin links your real
`~/.local/share/opencode/auth.json` (and `account.json`) into it; without that
the worker's model call would 401.

## Testing

| Suite | Command | Count |
|-------|---------|-------|
| Gate + citation evals | `bash premium-read-offload/evals/run.sh` | 42 |
| Java core | `java --class-path premium-read-offload/build/classes:premium-read-offload/build/test-classes eu.infolead.llmhp.offload.OffloadTest` | 79 |
| TS shim | `bun test premium-read-offload/opencode/index.test.ts` | 18 |

All three are wired into `build.sh`.

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| Reads never blocked | Session not premium (provider not `kimi`/`kimi-for-coding`/`zai`/`zai-coding-plan`) | Expected — the gate only protects premium pools |
| Reads never blocked on a premium session | Model not recorded yet (no `chat.message`), or model not in the premium set | Send a message first; check `offload-status` / the model id |
| `offload-read` returns `skipped: true` | Trivial question or cold worker on a tiny corpus | Read directly, or use `offset`/`limit` |
| `verification: "error"` | Java core unreachable | Check `java -version` (25) and `build/classes` |
| Everything `[unverified]` | Worker ignored the citation format | Register `bulk-reader` with `mode: "all"` (a `subagent` is rejected by `opencode run --agent` and falls back to the default agent, dropping the prompt) |
| `worker produced no output`, log shows `401 Unauthorized` | Worker's isolated `XDG_DATA_HOME` has no `auth.json` | Automatic: the plugin links the real `auth.json`/`account.json` into the worker home. If it persists, check the source file exists at `~/.local/share/opencode/auth.json` |
| `worker produced no output` / timeout (other) | Worker model unavailable or slow | Check `LLMHP_OFFLOAD_WORKER_MODEL`; raise `LLMHP_OFFLOAD_TIMEOUT_MS` |
| `E2BIG: argument list too long` | Old build passed the corpus on argv | Fixed: prompts go on stdin; update the plugin |
| `offload-read` says at least one path | Empty `paths` | Pass one or more file paths |
| Want to disable | — | `LLMHP_PREMIUM_OFFLOAD=0`, restart |
