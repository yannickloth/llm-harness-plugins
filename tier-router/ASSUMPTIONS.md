# tier-router — Assumptions

Intercepts user prompts, classifies reasoning complexity (keyword rules + optional LLM classifier + skill-axis rank match), reformulates the prompt, and annotates the message (opt-in) with tier directives and a rank/agent recommendation. A Java 25 CLI (`RouterCli`) does the keyword/rank/budget logic; the OpenCode plugin (TS) spawns it and a headless `opencode run` for LLM classification.

Tier labels are the rank hierarchy itself, ascending: **sergeant < warrant-officer < lieutenant**. Each label doubles as the agent name and the proxy model name (`proxy/<label>`); there is no band without a rank behind it.

## OpenCode API (hooks used, v1 vs v2, version sensitivity)

- One module serves both: v2 object entry (`id`, `setup(ctx)`) and legacy v1 via `server(input)`. ⚠ The two paths must be kept in sync by hand.
- v1 hooks: `config` (agent map mutation), `chat.message` (mutates `output.parts[].text` in place). ⚠ Relies on the host persisting the mutated part and awaiting the hook (same contract as datetime-inject v1).
- v2 hooks: `ctx.session.hook("prompt")` (replaces `event.prompt.text` by assignment), `ctx.agent.transform`, `ctx.tool.transform` (`editor.add` with JSON Schema, `{ content }` results). ⚠ Shapes follow the datetime-inject v2 port, verified against opencode 2.x.
- The v2 prompt hook is async (awaits classification). If the host does not await prompt hooks, the message passes through unannotated. ⚠
- Plugin API `@opencode-ai/plugin` 1.19.3 (`tool`, `Plugin` types).
- Agents are registered by the plugin itself (`shared/agents.ts`): `tools:` and `permissionMode:` frontmatter are ignored; a bare `model:` alias (no `provider/` prefix) is dropped. All four tier agents pin `proxy/<rank>` refs (`sergeant`, `warrant-officer`, `lieutenant`, `lieutenant-colonel`), which register as-is.

## Environment (env vars, binaries, OS/process)

- `java` on PATH, JDK 25+. ⚠ `RouterCli` uses a package-private instance `void main(String[])` — accepted only by the JEP 512 launcher (final in JDK 25); JDK ≤ 24 rejects it.
- `opencode` binary on PATH for the headless LLM classifier. ⚠
- `TIER_ROUTER_ANNOTATE` — unset: prompt hook is a no-op (default); `1`: annotation replaces the message text.
- `TIER_ROUTER_DISPATCH` — with annotate: unset/`1` (default) tells the model to delegate the task to the tier agent (`<tier>-general`) via the Task tool; `0` keeps the annotation advisory and handles the request directly.
- `TIER_ROUTER_LEAN` — `1` (with annotate): send rewritten prompt + directives only.
- `TIER_ROUTER_CLASSIFY_MODEL` — default `proxy/sergeant` (rank gateway) for the `opencode run` classifier. ⚠
- `TIER_ROUTER_CLASSIFY_DATA_DIR` — explicit classify data home; else `$XDG_RUNTIME_DIR/tier-router-classify`; else `os.tmpdir()/tier-router-classify`.
- `LLMHP_NO_SUBSPAWN=1` — child opencode processes refuse to re-classify (recursion guard).
- `TIER_ROUTER_PLUGIN_ROOT` — set by the plugin on spawned JVMs (locates `iron-gate.json`, `skill-axis-mapping.json`). ⚠ Manual JVM invocations without it fall back to cwd lookups.
- `TIER_ROUTER_METRICS_DIR` — never set by the plugin. ⚠ Breaker dir then defaults to the JVM's cwd (`<project>/.breakers`), which the JVM creates on every invocation.
- `TIER_ROUTER_IRON_GATE_CONFIG`, `TIER_ROUTER_SKILL_AXIS_CONFIG` — optional path overrides.
- `TIER_ROUTER_BUDGET_CEILING` — default 500000; read only by the `budget-*` CLI subcommands, which the plugin never calls.
- `TIER_ROUTER_LLM_BASE_URL` (default `http://server-nike.bee-blues.ts.net:4000/v1` — the LiteLLM rank gateway), `TIER_ROUTER_LLM_MODEL` (default `sergeant`), `TIER_ROUTER_SKIP_LLM` (`true` disables).
- API key resolution: `TIER_ROUTER_LLM_API_KEY` → `~/.config/opencode/keys/litellm-proxy.key`. ⚠ No key: Java LLM classifier disabled (null → gate check → keyword fallback or hard escalate).
- JVM default locale affects JSON output (`%.2f`). ⚠ Comma-decimal locales (de_DE etc.) emit invalid JSON; the TS falls back to "classification failed".
- POSIX process-group kill for timeout reaping (detached children, negative PID).

## Filesystem & layout (paths, anchors, formats, encodings)

- All plugin paths anchor to the module file (`import.meta.url`), not cwd: `<plugin>/build/classes`, `<repo>/shared/build/classes`, `<plugin>/agents`. ⚠ Requires the background build to have produced both class dirs.
- Java classpath = `<plugin>/build/classes:<repo>/shared/build/classes` (needs `eu.infolead.llmhp.shared`). ⚠
- Iron-gate config: `$TIER_ROUTER_IRON_GATE_CONFIG` → `<pluginRoot>/iron-gate.json` → none. ⚠ The file is gitignored (local only); absent → gate defaults to CLOSED, which skips the keyword fallback on LLM failure.
- Skill-axis config: env override → `<pluginRoot>/skill-axis-mapping.json` → `./tier-router/...` → `./...`. JSON parsed by hand-rolled string splitting.
- Classify data dir is created (with a README) at load; it is the isolated `XDG_DATA_HOME` for headless classifier runs so they stay out of the real session log. ⚠ If it cannot be created, LLM classification is disabled (never falls back to the real log).
- Budget session state: `<metrics-dir>/.sessions/<id>.json`, written tmp → fsync → atomic rename.
- Breaker state: `<metrics-dir|cwd>/.breakers/*.json`.
- All text I/O is UTF-8 (Java 18+ default charset; TS `utf-8`).
- Prompt length: the Java router rejects > 10000 chars (throws); the opencode-run classifier truncates to 2000 chars. ⚠

## External services (URLs/ports, protocol)

- LiteLLM rank gateway (or `TIER_ROUTER_LLM_BASE_URL`) `POST /chat/completions`: OpenAI-compatible; 5 s connect / 10 s request timeout. Model behaviour parameters are owned by the proxy — the request body carries none. ⚠
- JSON body is built by string escaping; raw control characters (tab) in a prompt produce invalid JSON → 400 → keyword fallback.
- `opencode run` classification uses the user's provider auth from `XDG_CONFIG_HOME`; output parsed as newline-delimited JSON events (`{type:"text",part:{text}}`). ⚠

## Configuration (opencode.json registration)

- The plugin must be listed in `opencode.json` (`./tier-router/opencode`). The repo's root `opencode.json` does NOT register it; `opencode.json.sample` does. ⚠
- Annotation is opt-in (`TIER_ROUTER_ANNOTATE=1`); default-off.
- Tier agents `sergeant` / `warrant-officer` / `lieutenant` register via the v1 `config` hook or v2 `agent.transform`. Their `model:` values are full `proxy/<rank>` refs and register as-is (no `opencode.json` model chain for them).
- The 3 tools (`classify-prompt`, `rewrite-prompt`, `check-ambiguity`) register in both v1 and v2.

## Concurrency (locks, multi-instance, atomicity)

- No locks. Each JVM CLI call is a fresh process. ⚠
- Circuit-breaker "state" loads from disk at startup but `recordFailure()`/`recordDenial()` never persist; the `breaker-*` subcommands therefore cannot accumulate state across invocations, and the in-process failure recording dies with the JVM. ⚠ The breakers are a dead mechanism in the current wiring.
- Budget state files use tmp + `FileChannel.force` + `ATOMIC_MOVE` (safe across processes).
- Classification cache (512) and annotation dedup (10 000) are in-memory, per process.
- Child timeouts: opencode-run classifier 20 s kill / 25 s cap; Java router 10 s cap (includes JVM startup + any LLM HTTP call). ⚠ A failure result is cached for that prompt for the process lifetime.
- Failed/timeout classifications yield `failed: true` → the hook leaves the message untouched (no fabricated annotation).

## Data & LLM behavior (trusted formats, model assumptions)

- LLM classifier reply is trusted as one token: `SERGEANT|WARRANT-OFFICER|LIEUTENANT|ESCALATE` (punctuation/spaces stripped). Anything else → keyword fallback. ⚠
- Java LLM reply is parsed by string-scanning for the first `"content":"` after `"message"`; the unescape drops backslash escapes (harmless for one-word replies).
- Ambiguity = fixed 7-phrase substring list, skipped when a path/extension is present.
- Skill-axis match = ≥ 2 substring keyword hits in one axis; substring matching causes over-hits (e.g. "finance" ⊃ "nan", "summary" ⊃ "sum").
- Tier keywords are regex/substring heuristics; escalation triggers use `contains` (e.g. "install" ⊃ "all").
- The plugin cannot switch the session model: the annotation hook mutates prompt text only. With `TIER_ROUTER_DISPATCH` (default) it instructs the model to delegate to the tier agent, which is the only path from classification to a different rank; the plugin itself still dispatches nothing.
- `fleet_models` are rank names (or an explicit served id where the rank is not deployed); they appear in the annotation as the suggested rank list.
- An already-annotated prompt (`<prompt-annotation>` / `<tier-router:`) is never annotated again, so a tier subagent's delegated prompt does not bounce back to itself.
