# systemone

Local System One decision serving for this harness: one skill, six tools, and a
ledger that records whether the tools are actually used.

```
systemone/
  opencode/index.ts                     plugin: skills + 6 tools + adoption ledger
  skills/systemone/SKILL.md             when to spend a judgment; policy; routing
  skills/systemone/reference/jev-tools.md    per-tool schemas for Jev's 12 composed tools
  skills/systemone/reference/laya-engine.md  checkpoints, routing, calibration, question design
  stats.ts                              adoption report over the ledger
```

The backend is Unsloth Studio's Decision API — `POST /v1/systemone`, plus its
MCP mount at `/mcp/decisions`. The model is a setting (`laya-multilingual` is the
~120 ms CPU default); nothing here is named after one checkpoint.

## "Are my LLMs actually using it, or reasoning for themselves?"

You cannot verify intent, and you cannot prove an absence of reasoning. What you
can do is measure calls, and — for the cases that matter — make the call a
precondition. Three levels, in increasing strength:

### 1. Observe: did a call happen at all?

Server side, the endpoint is the ground truth:

```sh
journalctl --user -u unsloth-studio --since today | grep -c 'POST.*"/v1/systemone"'
journalctl --user -u unsloth-studio --since today | grep -c 'POST.*"/mcp/decisions"'
```

Client side, the plugin appends one JSON line per call and per *exposure* (a
moment where a decision was expected) to `~/.local/share/systemone/calls.jsonl`:

```sh
bun systemone/stats.ts          # last 7 days
bun systemone/stats.ts --days 30
```

```
Calls
  tool                          n    ok%    p50      p95
  systemone_risk                 14  100%    124ms    131ms
  systemone_suffice              31   94%    117ms    126ms

Exposures (moments a decision was expected)
  risky_command        9
  fetched_content      22

Session-level adoption (rough)
  risky command  → systemone_risk :  67%  (6/9 sessions)
  fetched content → jev_screen     :  45%  (10/22 sessions)
```

The adoption rows are **proxies**: they count sessions where both the exposure
and the call appeared — not whether that call was the right one for that moment.

### 2. Measure: was the call expected here?

The honest metric needs a judgement about the moment, so sample it. Once a week,
take ten sessions and label each decision point as *should have called* / *did
call*, then compute recall. The triggers worth checking, from the skill:

| moment | expected call |
|---|---|
| untrusted text is about to enter context | `jev_screen` |
| a destructive command is about to run | `systemone_risk` |
| a retrieval loop has stalled twice | `systemone_suffice` |
| before writing a memory entry | `systemone_novel` |
| before delivering hard-format output | `systemone_constraints` |
| a verdict came back `review` / `escalate` | `systemone_deep`, or leave System One |

Watch the failure rate in `stats.ts` too. A tool that errors gets abandoned by
the model within a session or two — a rising `ok: false` count is the leading
indicator of a decision path going quiet, and it looks identical to the model
"choosing" to reason by itself.

### 3. Enforce: make it a precondition, not an instruction

For the two cases where being skipped has consequences, the only reliable
mechanism is a hook. OpenCode exposes `tool.execute.before`, which sees the tool
name, session, and args, and can refuse:

```ts
// sketch — not enabled by default
"tool.execute.before": async (input, output) => {
  if (input.tool !== "bash") return
  const cmd = String(output.args?.command ?? "")
  if (!RISKY_COMMAND.test(cmd)) return
  if (recentRiskCall(input.sessionID, 10 * 60_000)) return   // a recent judgment exists
  throw new Error("run systemone_risk on this command first")
}
```

Read `~/.local/share/systemone/calls.jsonl` for `recentRiskCall`. Design notes
before you turn this on:

- It converts a soft policy into a hard block, so a false positive stops work.
  Start with commands you would never want run unreviewed (`rm -rf`, `mkfs`,
  `git reset --hard`) and widen from observed misses.
- Blocks create retry loops. Always allow an explicit escape (the agent calling
  the judgment, or the user approving), never a silent bypass.
- It enforces *that* a judgment happened, not that it was any good. A confident
  wrong `systemone_risk: ok` answer still passes the gate — which is why the
  thresholds are documented as heuristics needing validation.

A blunter alternative that needs no plugin work: OpenCode permission rules. Deny
`bash` entirely for the agent that runs destructive things, and route through a
subagent that has the tool. That enforces the pattern structurally rather than
semantically.

## Ledger format and environment

One JSON object per line:

```json
{"ts":"2026-10-25T15:56:09.000Z","kind":"call","tool":"systemone_risk","ok":true,"latency_ms":122,"session":"ses_…","agent":"build","project":"/home/nicky/code/…"}
{"ts":"2026-10-25T15:56:20.000Z","kind":"exposure","trigger":"risky_command","tool":"bash","session":"ses_…","command":"rm -rf build"}
```

| variable | default | purpose |
|---|---|---|
| `SYSTEMONE_URL` | `http://127.0.0.1:8888/v1/systemone` | Decision API endpoint |
| `SYSTEMONE_KEY_FILE` | `~/.config/opencode/keys/unsloth.key` | owner key; escalation and per-call `model` require an authenticated caller |
| `SYSTEMONE_DEEP_TIMEOUT_MS` | `180000` | ceiling for a call (a 9B on CPU can genuinely take that long) |
| `SYSTEMONE_LEDGER` | `~/.local/share/systemone/calls.jsonl` | ledger path; point `stats.ts` at the same value |

External decision tools (`jev_*`, `systemone_decide`) are recorded as
`"external": true` — they bypass the plugin, so they have no latency or ok flag.

## What this deliberately does not do

- No silent escalation: the five judgment tools stay on the ~120 ms default
  checkpoint; `systemone_deep` is the only path to a larger one, and it evicts
  the resident model.
- No cross-model threshold: calibration is per-checkpoint, so a `kev-*`
  confidence is not comparable with a `laya-*` one.
- No verdict from a failed call: every tool returns `ok: false` rather than a
  comfortable default, and `systemone_risk` says "treat as risky" when it cannot
  answer.
