# offpeak-nudge — Assumptions

Nudges the user about provider time-of-day pricing. For plan-bearing providers it
injects a system rule, rewrites heavy prompts during peak hours to require explicit
confirmation, shows peak/off-peak status toasts, exposes the `peak_price_status`
tool, and records per-session spend split into peak/off-peak buckets in a JSON
state file.

## OpenCode API (hooks used, v1 vs v2, version sensitivity)

- v1 (1.x, served by `server`): `tool`, `chat.message`, `experimental.chat.system.transform`, and `event` hooks; lifecycle events arrive through the `event` hook.
- v2 (2.x, served by `id` + `setup(ctx)`): `ctx.session.hook("context")`, `ctx.session.hook("prompt")` (mutates `event.prompt.text`), `ctx.event.subscribe({ signal })`, `ctx.tool.transform`, `ctx.agent.list()`.
- ⚠ The running binary is 2.2.5 and calls only `setup`; all v1 paths are dead there.
- ⚠ v2 hook payload shapes are untyped and trusted from the runtime: `event.model?.providerID ?? event?.providerID`, `event.system` as an array of `{ type, text }` parts, `event.prompt.text`, event data as `input.data ?? input.properties`.
- ⚠ `ctx.agent.list()` is not in the installed `@opencode-ai/plugin` v2 types (only `ctx.agent.transform` / `reload` are typed); if absent at runtime, agent-based plan resolution silently degrades to nothing (caught).
- ⚠ The installed types say `setup` returns `Promise<void> | void`, but the plugin returns a cleanup function (as context-editing does); cleanup runs only if the 2.2.5 runtime honors a returned function.
- ⚠ v1 boundary timer starts only on a `server.connected` event that arrives after plugin load; if it never fires, no boundary toasts.
- v1 agent resolution calls `client.app.agents({ query: { directory } })`; the response is read as `res.data ?? res` (tolerates both SDK result shapes).

## Environment (env vars, binaries, OS/process assumptions)

- `OFFPEAK_NUDGE_STATE_FILE` — state file override. Default: unset.
- `XDG_RUNTIME_DIR` — state dir. Default: unset → `os.tmpdir()`.
- ⚠ Process `TZ` determines all "local" window display (via `Date` offset of the current instant); half-hour zones (IST +5:30, NPT +5:45, MMT +6:30) are rounded to whole hours (`localOffsetHours`).
- ⚠ On DST transition days the display uses the current instant's offset for every window of the day; windows after the transition render off by one hour. Status is UTC-based and unaffected.
- No external binaries. Bun runtime for plugin load and `bun test`.
- ⚠ The 60 s boundary interval is `unref()`ed: it does not keep the process alive and does nothing useful in v2 (empty callback).

## Filesystem & layout (paths, anchoring, formats, encodings)

- State file: `$OFFPEAK_NUDGE_STATE_FILE` or `$XDG_RUNTIME_DIR/offpeak-nudge-state.json` or `<tmpdir>/offpeak-nudge-state.json`; UTF-8 JSON; whole-file rewrite on every change; no atomic rename, no lock.
- State keys: `${provider}:${sessionID}` for reminder dedup; plain `sessionID` for the spend ledger.
- ⚠ State persists across restarts and never expires: `windowIndex` is compared without the stored `ts`, so a single-peak-window provider (zai) suppresses reminders forever after the first nudge per session key.
- Prices and windows are hardcoded in `DEFAULT_PRICING_PLANS`; the plugin never reads or fetches `/home/nicky/code/llm-harness-plugins/llm-provider-prices.md`. ⚠ If a provider changes its pricing, every nudge, banner, and tool answer is silently wrong (the table says prices change frequently).
- Hardcoded plan values (verified against the table, 2026-09-17 snapshot): deepseek peak `[[1,4],[6,10]]` UTC, ratio 0.5, weekend-off-peak since 2026-08-23 in UTC+8; zai peak `[[6,10]]` UTC (= 14:00–18:00 SGT), ratio 0.5, weekdays-only in UTC+8. ⚠ The table states deepseek peak as "Mon–Fri" without a timezone; the plugin applies the UTC+8 weekend, which differs from a UTC-based Mon–Fri by up to 8 h at the boundaries. ⚠ The `since` date 2026-08-23 is not in the table and is unverifiable from it.

## External services

- None. No network access.

## Configuration (registration)

- Registered in live `opencode.json` (line 5, `./offpeak-nudge/opencode`). Not listed in `opencode.json.sample`.
- No options tuple is passed in either file, so all defaults apply: built-in plans, 60 s boundary interval, boundary timer on, not disabled, no `skillProviders`, no `heavy` overrides.
- To add providers or tune detection, opencode.json must pass `["./offpeak-nudge/opencode", { plans: [...], skillProviders: {...}, heavy: {...} }]`.
- Heavy-detection defaults: 10 built-in skill names, `stepThreshold` 2, 7 long-running keywords.
- `peak_price_status` tool defaults to provider `deepseek` when called without `provider`.

## Concurrency (locks, multi-instance, atomicity)

- ⚠ State read-modify-write is non-atomic; two opencode servers (or hook + timer) can interleave and lose updates: spend undercount, dedup suppressed.
- ⚠ `countedMessages`, `sessionProviders`, `activeProvider`, `agentNamesByProvider` are in-memory per server process; dedup is not shared across processes (the state file shares only `windowIndex`).
- ⚠ v1 `startBoundaryTimer` runs on every `server.connected` with no guard; reconnects stack intervals.
- ⚠ The v2 event stream has a single consumer with a bare `catch`: any throw in a handler (currently guaranteed on the first `session.created` by the missing `statusToastFor`) terminates the loop permanently; all later events are dropped.
- `message.updated` can fire multiple times per message; spend is counted once per `info.id`.

## Data & LLM behavior (formats trusted from the model)

- Trusts v1 `message.updated` `info`: `role === "assistant"`, numeric `cost` (assumed USD), `tokens.{ input, output, cache.read }`, `model.providerID`, stable `id` for dedup. Messages without a numeric cost are skipped (no spend recorded for them).
- Trusts `chat.message`/`prompt` payloads to carry `sessionID` and `model.providerID`; when absent, the nudge degrades to doing nothing for the primary provider (agent/skill reference matching may still apply).
- ⚠ Agent/skill reference matching is case-insensitive whole-token regex over the prompt text; any mention of a plan-provider agent name (e.g. "run the cynic-auditor") attributes that provider's plan and triggers the banner even if the agent never actually runs on it.
- ⚠ The model is expected to obey the injected system rule and the `[offpeak-confirm]` banner (ask for confirmation during peak; do not run by default). Compliance is prompt-level only; nothing enforces it.
- Provider IDs are matched case-insensitively against plan `providerID`.
- Heavy detection is a heuristic: skill-name mention, "phase/step N" or line-start numbered lists (threshold 2), or a long-running keyword.
