# agentinsights — Assumptions

Session analytics + AI-generated narrative report. The plugin registers two tools
(`run-insights`, `insights-status`). Each tool spawns a Java CLI
(`eu.infolead.llmhp.insights.InsightsCli`) that scans session transcript files,
extracts per-session stats by regex/parse, extracts LLM-classified facets,
aggregates global stats, generates 7 LLM-written narrative sections plus an
At-a-Glance synthesis, and writes a self-contained HTML report plus a Markdown
summary returned to chat. All logic runs in a local `java` subprocess; the LLM
is called directly over HTTP from Java.

## OpenCode API (hooks used, v1 vs v2, version sensitivity)
- Dual default export `{ id, setup, server }`: v2 (opencode ≥ 2.x) calls `setup(ctx)`, v1 (1.x) calls `server(input, options)`.
- v2 tools are added via `ctx.tool.transform(editor => editor.add({...}))` with hand-written JSON Schema inputs; `execute` returns `{ content }`.
- ⚠ v2 root anchor is `ctx.location?.project?.canonical ?? ctx.location?.directory` with no null guard: if `ctx.location` is missing, `setup()` throws (`path.join(undefined, ...)`), the plugin fails to load, and the tools disappear silently (verified by test harness).
- ⚠ `ctx.location` and `ctx.tool.transform` are not documented in the installed `@opencode-ai/plugin` 1.18.x type definitions; the shapes follow the repo-wide convention (same as graphrag) and may break on a host that does not expose them.
- v1 registers only a `tool` map (no `event` hooks, no `chat.*` hooks); v1 context supplies `directory` and `worktree`.
- No API version detection: the same object serves both majors; behavior differs only in where the root directory comes from.

## Environment (env vars read, with defaults; binaries on PATH; OS/process assumptions)
- `java` must be on PATH and must be JDK ≥ 25 (classes compiled with `--release 25`; `Executors.newVirtualThreadPerTaskExecutor()` requires 21+).
- ⚠ `ANTHROPIC_API_KEY` and/or `OPENAI_API_KEY` are inherited from the opencode process environment (`safeSpawn` merges `process.env`). With neither set, every LLM call returns the literal `"{}"` and only a `WARNING` line reaches stderr; the run still "succeeds" with an empty narrative.
- `INSIGHTS_MODEL` (default: empty → provider default model, no `model` field sent).
- `INSIGHTS_API_URL` (default: `https://api.anthropic.com/v1/messages` or `https://api.openai.com/v1/chat/completions`).
- Provider selection: OpenAI is used only when `OPENAI_API_KEY` is set AND `ANTHROPIC_API_KEY` is blank; otherwise Anthropic (even if both are set).
- LLM HTTP: 30 s connect timeout, 300 s request timeout, no retries, no rate limiting, no concurrency cap on the 7 parallel section calls.
- Anthropic calls use header `anthropic-version: 2023-06-01` (fixed).
- `LLMHP_CANARY_DIR` / `LLMHP_CANARY_NONCE` (shared load-canary; no-op in normal use).
- Process model: one JVM per tool call, launched detached from no process group (`safeSpawn`, not `spawnDetached`); stdout/stderr drained fully before the tool returns.

## Filesystem & layout (paths read/written, where anchored — cwd / repo root / XDG; formats; encodings)
- Session input: all `*.jsonl` under `--session-dir`, `Files.walk` depth 3, one JSON message object per line, UTF-8.
- ⚠ Session line format is the Claude Code transcript shape: top-level `type` (`user`/`assistant`), top-level ISO-8601 `timestamp`, `message.content` as string or block array (`text` / `tool_use` with `name`+`input` / `tool_result` with `is_error`), assistant `message.usage.{input_tokens,output_tokens}`.
- ⚠ opencode v2 does not store sessions this way: sessions live in SQLite (`~/.local/share/opencode/opencode.db`), and `opencode session export` emits a single JSON object (top-level `text` for user text, `content[].type: "tool"`, epoch-ms `time.created`) that the scanner parses to zero sessions (verified by running the CLI on converted export data).
- ⚠ The v2 tools and the sample `/insights` command point at `<root>/.opencode/sessions` — a directory nothing in opencode v2 creates (verified: no such dir in this repo; this repo's cached run produced a 0-session report).
- Root anchoring: v2 uses `ctx.location?.project?.canonical ?? ctx.location?.directory`; v1 uses `worktree ?? directory`. The sample command uses cwd-relative paths (`agentinsights/build/classes`, `.opencode/sessions`), so it works only when bash cwd is the repo root.
- Output (all anchored at the same root): `<root>/.agentmem/insights/session-meta/<sessionId>.json`, `<root>/.agentmem/insights/facets/<sessionId>.json`, `<root>/.agentmem/insights/report.html`.
- Session ID = filename minus `.jsonl`. IDs containing `/` produce nested cache paths that cannot be written (session fails every run); `resolveSessionFile` sanitizes the transcript path but `CacheManager` does not.
- All file I/O is UTF-8 (JDK 18+ defaults: `Files.lines`, `Files.readString`, `Files.writeString`, `HttpRequest.BodyPublishers.ofString`).
- Cache privacy: `chmod 600` intended; achieved on Linux OpenJDK via a `setReadable(false,false) → setReadable(true) → setWritable(true)` sequence (verified to end at 600 on this JDK); on Windows the sequence is a no-op with a stderr WARN.
- ⚠ Plain-text user messages must be encoded as `message.content` = array of `text` blocks to be counted. `message.content` as a bare string (the dominant Claude Code encoding) is not recognized as human text anywhere (scanner, transcript formatter, instruction extractor — verified: 8 of 10 real human messages counted in a 27 MB Claude session).
- Cache invalidation: session-meta compares cached `session_mtime` against file mtime (works; verified). ⚠ Facets cache has no invalidation at all — no mtime comparison — so a growing session keeps stale facets forever (design §8 requires mtime invalidation).
- ⚠ A corrupted session-meta cache file is never deleted and the session is silently excluded from every run (no per-session log line; verified).
- Duration = last human user-message timestamp minus first message timestamp (assistant tail time excluded; single-message sessions measure 0 min).
- `project_path` is a dead field: never populated (the `cwd` field present in Claude lines is never read).

## External services (URLs/ports, protocol assumptions)
- `https://api.anthropic.com/v1/messages` (POST, `x-api-key`, `anthropic-version: 2023-06-01`, body `{system?, messages:[{role:user,content}], max_tokens, model?}`).
- `https://api.openai.com/v1/chat/completions` (POST, `Authorization: Bearer`, body `{messages:[{role:system?|user,content}], max_tokens, model?}`).
- Both overridable by `INSIGHTS_API_URL` (single URL for the chosen provider).
- Response parsing: Anthropic `content[]` first `type:"text"` block; OpenAI `choices[0].message.content`. Any parse failure falls back to the raw response text, which then fails downstream JSON extraction and degrades to an empty section.
- Non-2xx / network errors are swallowed into the `"{}"` fallback (stderr log only); no retries.

## Configuration (what opencode.json must register for it to work; whether it actually is)
- `opencode.json` must list `./agentinsights/opencode` under `"plugin"` — `opencode.json.sample` does (line 13).
- `agentinsights/build/classes` must exist (Java compiled, `--release 25`); there is no build-on-demand path — a fresh clone without the built classes fails every tool call with a Java classpath error.
- The sample `/insights` command template invokes the CLI directly (bash) with cwd-relative paths; the `run-insights` tool is the cwd-independent path.
- ⚠ Nothing in the repo or in opencode produces the `.opencode/sessions/*.jsonl` input the command expects; the feature only works when the user populates that directory with Claude-Code-format transcripts (or passes `session_path` elsewhere).

## Concurrency (locks, multi-instance behavior, atomicity)
- No lock file: concurrent `/insights` runs race on the same cache files and `report.html` (design §10 says unsupported; the code does not detect or prevent it).
- Facet cache writes are atomic (tmp file + `ATOMIC_MOVE`); session-meta writes and `report.html` are non-atomic direct writes.
- Stale `.tmp.*` files in the facets dir are cleaned at startup only.
- Insight sections: 7 LLM calls in parallel on virtual threads; At-a-Glance runs serially after all sections complete.
- ⚠ `sectionFailures` is a plain `ArrayList` mutated from up to 7 virtual threads (unsynchronized; lost updates / corruption possible).
- Facet extraction is strictly sequential per session (each call up to 300 s), with no overall wall-clock bound; `safeSpawn` imposes no timeout, so one slow/broken endpoint can hold the tool call for hours.

## Data & LLM behavior (formats trusted from the model; model assumptions)
- The LLM must answer with a single JSON object; extraction takes the first `{` to the last `}` of the response (markdown fences tolerated, multiple objects not).
- ⚠ Facet validation (`SessionFacets.isValid`) requires a `session_id` key that the facet prompt never asks the model to return — fresh extractions are rejected 100% of the time; only cache files written by `facetsToMap` (which include `session_id`) pass (verified). The LLM pipeline for facets is effectively dead.
- Enum fields (`outcome`, `claude_helpfulness`, `session_type`) must match fixed value sets or the whole facet is rejected; missing fields pass validation and fall back to defaults (lenient where the design says "all required fields present").
- Facet/section JSON field names are trusted as-is from the model (`str`/`safeIntMap` accessors silently drop wrong-typed values).
- Transcript content (user text, tool output, LLM summaries) is interpolated verbatim into later LLM prompts — prompt-injection from one's own transcript is possible by design.
- ⚠ LLM prompt bodies are built with `ManualJson.escape`, which does not escape raw control characters U+0000–U+001F (only `"` `\` `\n` `\r` `\t`): any transcript fragment containing terminal control sequences (e.g. BEL, ESC) yields an invalid-JSON request body that provider APIs reject (verified against a strict JSON parser).
- Models are assumed to honor "respond with only valid JSON" with max_tokens 4096 (facets) / 8192 (sections); violations degrade to empty sections, not errors.
- HTML report escapes all LLM-derived text (`& < > "`); Markdown summary does not escape (rendered as Markdown by the host).
