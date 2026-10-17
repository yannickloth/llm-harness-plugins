# plugin-session-lifecycle.design.md

## What

Session lifecycle tracking plugin — file edit log (TSV), git commit diffing, archival with 30-day retention, and the per-session cost summary (root session, subagents, day, month, all-time) read from OpenCode's own session database.

## Why

Replaces project-specific hook Java files with a reusable, platform-agnostic plugin. Original 5 hooks were baked into a single project; this plugin makes them installable as a plugin artifact for OpenCode.

## How

Thin Java wrapper (`SessionLifecycle`) dispatches to the existing 5 Java hook classes. Adaptation via `OPENCODE_PROJECT_DIR` env injection only — no hook source modifications. The wrapper injects the env var via reflection (`--add-opens java.base/java.util=ALL-UNNAMED` required at runtime) and constructs stdin JSON when the calling context doesn't provide it.

Data flow:
```
session.created  → snapshot-commits  → .commits.start
                 → check-errors      → stdout (error preview)
file.edited      → record-edit       → <session>.tsv
session.idle     → diff-commits      → .commits.end
                 → archive           → archive/<YYYY-MM>/<session>/
                 → spend.report      → cost summary (toast in v1; stderr in v2)
```

Cost reporting is pure TypeScript (`opencode/spend.ts`): the plugin mirrors
`message` rows of `<data>/opencode/opencode.db` into a small WAL cache
(`spend-cache.db`) and reports on root sessions only (subagent cost is folded
into `subs`). Incremental sync is O(tail), not O(table): `message` has no index
on `time_updated`, so the rewrite scan is bounded to the last `TAIL_ROWS`
rowids (~2 ms) and the watermark is the wall clock captured *before* the
selects — never a timestamp observed in the rows, which could skip a message
finalized between the select and the fetch. Once per process, a maintenance
pass drops cache rows whose message is gone (deleted sessions would otherwise
count forever) and re-reads cached zero-cost rows (a message finalized while no
process was running). Covering indexes plus `synchronous=NORMAL` keep the idle
path at ~20 ms on a 351k-message DB. It never touches the Java sidecar and
swallows every error. Opt out with the plugin option `spend: false`.

## IVP drivers

| Driver | Anchor | Change requirement |
|--------|--------|--------------------|
| γ_log-format-edits | TSV schema for file edit records | Changes to edit log output format |
| γ_commit-log-format | `.commits.start` / `.commits.end` schema | Changes to commit snapshot/diff structure |
| γ_lifecycle-event | Agent lifecycle hook protocol (session.created, file.edited, session.idle) | Changes to when hooks fire |
| γ_error-policy | Error reporting contract (always exit 0, log to hook-errors.log) | Changes to error handling strategy |
| γ_cost-accounting | `message.data.cost` + `session.parent_id` in `opencode.db` | Changes to how per-session/subagent/day/month/all-time cost is derived (`opencode/spend.ts`) |

All five hook classes share the lifecycle-event and error-policy drivers. LogFileChange is additionally driven by log-format-edits. SessionStartCommits + SessionEndCommits are additionally driven by commit-log-format. SessionEndArchive jointly driven by log-format-edits and lifecycle-event. The wrapper (`SessionLifecycle`) is driven solely by lifecycle-event (as the dispatch layer).

## Architecture

```
session-lifecycle/
├── src/main/java/eu/infolead/llmhp/lifecycle/
│   ├── LogFileChange.java           ← verbatim from ivp-book-series
│   ├── SessionStartErrors.java      ← verbatim
│   ├── SessionStartCommits.java     ← verbatim
│   ├── SessionEndCommits.java       ← verbatim
│   ├── SessionEndArchive.java       ← verbatim
│   └── SessionLifecycle.java        ← wrapper (dispatches + stdin JSON)
├── build/classes/                   ← compiled .class files (committed)
├── opencode/
│   ├── index.ts                     ← OpenCode plugin entry
│   └── spend.ts                     ← cost accounting (pure TS, no sidecar)
└── build.sh                         ← Java compilation
```

## Constraints

- Java ≥ 25 only
- Runtime requires `--add-opens java.base/java.util=ALL-UNNAMED` for env var injection
- Original 5 hook files copied verbatim — no modifications
- Wrapper only adds `OPENCODE_PROJECT_DIR` injection + stdin JSON construction
- Every operation exits 0 on error (hooks must never crash the agent)
- Compiled `.class` files committed to `build/classes/`
