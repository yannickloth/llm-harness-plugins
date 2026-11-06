# systemone — Assumptions

Local System One decision serving for OpenCode: 1 skill, 6 judgment tools
(5 on the configured default checkpoint, 1 explicit escalation), an
append-only adoption ledger, and `stats.ts` for the adoption report. Every
judgment call is `POST`ed to Unsloth Studio's Decision API on loopback.

## OpenCode API (hooks used, v1 vs v2, version sensitivity)
- v2: `id` + `setup(ctx)`; skill via `ctx.skill.transform`; tools via `ctx.tool.transform` (the v1 `tool` map is ignored when `setup` exists, so the six definitions are re-exposed with JSON Schema inputs); exposure scanning via `ctx.session.hook("context")`.
- v1: `server()` serves a function-form factory; `config` hook appends the skills dir; `tool` map exposes the six tools; `"tool.execute.after"` top-level hook records exposures — payload read as `{ tool, sessionID, args }`, matching the verified v1 shape.
- ⚠ The comment "v2 has no tool-execution hook" (index.ts ~746) is wrong for this repo: sibling plugins use `ctx.tool.hook("execute.after")`. The context-transcript scan instead logs exposures only at the NEXT model request — a tool call made at session end may never be recorded. Marked TEMPORARY in code.
- ⚠ The `"context"` event is assumed to carry `messages[].content[]` parts with `type: "tool-call"`, `name`, `input` (consistent with context-editing's verified usage); the whole scan body is try/caught, so a shape change fails silent.
- ⚠ v2 tool context is assumed to carry `sessionID`, `agent`, `directory` (v1: `worktree`/`directory`) for the ledger's `project` field.

## Environment (env vars read, with defaults; binaries on PATH; OS/process assumptions)
- `SYSTEMONE_URL` — default `http://127.0.0.1:8888/v1/systemone`.
- `SYSTEMONE_KEY_FILE` — default `~/.config/opencode/keys/unsloth.key`; must contain the Studio owner key; a missing file surfaces as a raw ENOENT in the tool's fail output (fail-closed).
- `SYSTEMONE_TIMEOUT_MS` — default `20000`; applied to every `decide()` call.
- ⚠ `SYSTEMONE_DEEP_TIMEOUT_MS` — default `180000`; documented in the README as the escalation ceiling but never applied in code (`decide()` always aborts at `TIMEOUT_MS`) — `systemone_deep` to slow CPU checkpoints (10–50 s+ per the skill's own numbers) always aborts at 20 s.
- ⚠ Env vars are read at module load — changing them requires restarting the opencode process.
- No binaries required on PATH (stats.ts is run manually with `bun`).
- Linux: the README cross-check uses `journalctl --user -u unsloth-studio` (systemd user unit).

## Filesystem & layout (paths read/written, where anchored — cwd / repo root / XDG; formats; encodings)
- Ledger: append-only JSONL at `~/.local/share/systemone/calls.jsonl` (override `SYSTEMONE_LEDGER`); parent dir auto-created; all write errors deliberately swallowed (observability must never break a decision).
- ⚠ No locking; concurrent appends rely on O_APPEND atomicity for small single-line writes.
- `stats.ts` reads the whole ledger into memory; unparseable lines are dropped; ISO-8601 `ts` fields are trusted.
- Skill dir anchored via `moduleDir(import.meta.url)`; `reference/laya-engine.md` is reached through a relative markdown link from `SKILL.md` (model must read the file).

## External services (URLs/ports, protocol assumptions)
- `POST /v1/systemone` (loopback, default 127.0.0.1:8888): JSON body `{ model, state, questions }`, `Authorization: Bearer <owner key>`, `Content-Type: application/json`.
- Response contract: 2xx + JSON `{ answers: { <id>: { noul | choice | score, confidence? } } }`, optional `x-unsloth-decision-backend` header; `status: "invalid_response"` and missing `answers` are fail-closed errors.
- ⚠ A 200 with other error-body shapes is not specially handled — it lands in "decision endpoint returned no answers" (fail-closed, but not distinguished).
- ⚠ Per-call `model` (`kev-0.8b`/`kev-4b`/`kev-9b`) is assumed to be accepted only for owner callers (403 otherwise) — per README, not validated here.
- MCP `/mcp/decisions` and `laya-mcp` on `127.0.0.1:8765` are external to this plugin (documented in the skill; not invoked from it).

## Configuration (what opencode.json must register for it to work; whether it actually is)
- ⚠ Registered in NEITHER `opencode.json` NOR `opencode.json.sample`, and no README/skill section documents an activation step — enabling it requires manually adding `./systemone/opencode` to the plugin list.

## Concurrency (locks, multi-instance behavior, atomicity)
- ⚠ The v2 `seenCalls` dedupe set is created once in `setup` and shared across ALL sessions; the key is `name:JSON(input).slice(0,400)` with no sessionID — an identical command in a different session is never logged as an exposure (skews the session-level adoption ratios in stats.ts).
- The set is bounded at 4000→2000 by deleting oldest keys — very old repeated commands can be logged again.
- The `observed()` ledger wrapper wraps each tool definition exactly once at module level (deliberately not inside the factory, to avoid nested wrapping).

## Data & LLM behavior (formats trusted from the model; model assumptions)
- Model answer shapes are trusted: `noul` must be a number in [0,1], `choice` a string, `score` a number; wrong shape → fail-closed error.
- ⚠ `systemone_suffice` exception: a missing `blocked` answer is silently treated as false (only `enough`/`next` are mandatory) — asymmetric with the fail-closed policy stated in the skill.
- ⚠ `systemone_consensus` `majority` is `mean(per-source probability) >= 0.5`, not a majority of sources — two sources at 0.9/0.1 report `majority: true` alongside `agreement: 0.2` (contradictory signals in one response).
- Thresholds (0.5 general, 0.7 irreversibility) are documented as unvalidated heuristics.
- `RISKY_COMMAND` is a heuristic regex with quoted spans blanked (documented); e.g. `rm --recursive` is not matched (flag cluster must end in r/f).
- ⚠ `stats.ts` counts external calls (ledger entries without an `ok` field) as failures (`!c.ok`) — they appear in "Recent failures" and as 0% in the ok% column, contradicting the README's "no latency or ok flag".
- `stats.ts --days` with a missing/invalid value falls back to 7 days for the window but prints "last NaN days".
