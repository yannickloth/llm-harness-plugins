# plugin-session-lifecycle.design.md

## What

Session lifecycle tracking plugin — file edit log (TSV), git commit diffing, archival with 30-day retention.

## Why

Replaces project-specific `.claude/hooks/` Java files with a reusable, platform-agnostic plugin. Original 5 hooks were baked into a single project; this plugin makes them installable as a marketplace artifact across OpenCode, Claude Code, and Pi.

## How

Thin Java wrapper (`SessionLifecycle`) dispatches to the existing 5 Java hook classes. Adaptation via `CLAUDE_PROJECT_DIR` env injection only — no hook source modifications. The wrapper injects the env var via reflection (`--add-opens java.base/java.util=ALL-UNNAMED` required at runtime) and constructs stdin JSON when the calling platform doesn't provide it. For CC/Pi PostToolUse hooks, the wrapper enters stdin-passthrough mode — CC's native hook payload flows through to the hook class.

Data flow:
```
session.created  → snapshot-commits  → .commits.start
                 → check-errors      → stdout (error preview)
file.edited      → record-edit       → <session>.tsv
session.idle     → diff-commits      → .commits.end
                 → archive           → archive/<YYYY-MM>/<session>/
```

## IVP drivers

| Driver | Anchor | Change requirement |
|--------|--------|--------------------|
| γ_log-format-edits | TSV schema for file edit records | Changes to edit log output format |
| γ_commit-log-format | `.commits.start` / `.commits.end` schema | Changes to commit snapshot/diff structure |
| γ_lifecycle-event | Agent lifecycle hook protocol (session.created, file.edited, session.idle) | Changes to when hooks fire |
| γ_error-policy | Error reporting contract (always exit 0, log to hook-errors.log) | Changes to error handling strategy |

All five hook classes share the lifecycle-event and error-policy drivers. LogFileChange is additionally driven by log-format-edits. SessionStartCommits + SessionEndCommits are additionally driven by commit-log-format. SessionEndArchive jointly driven by log-format-edits and lifecycle-event. The wrapper (`SessionLifecycle`) is driven solely by lifecycle-event (as the dispatch layer).

## Architecture

```
session-lifecycle/
├── src/main/java/eu/infolead/llmhp/lifecycle/
│   ├── LogFileChange.java           ← verbatim from ivp-book-series
│   ├── SessionStartErrors.java      ← verbatim
│   ├── SessionStartCommits.java     ← verbatim
│   ├── SessionEndCommits.java       ← verbatim
│   └── SessionEndArchive.java       ← verbatim
├── bin/
│   └── SessionLifecycle.java        ← wrapper (dispatches + stdin JSON)
├── build/classes/                   ← compiled .class files (committed)
├── opencode/index.ts                ← OpenCode plugin entry
├── .claude-plugin/
│   ├── plugin.json                  ← CC plugin metadata
│   └── hooks/hooks.json             ← CC hook definitions
├── pi/plugin.yml                    ← Pi plugin config
└── build.sh                         ← Java compilation
```

## Constraints

- Java ≥ 25 only
- Runtime requires `--add-opens java.base/java.util=ALL-UNNAMED` for env var injection
- Original 5 hook files copied verbatim — no modifications
- Wrapper only adds `CLAUDE_PROJECT_DIR` injection + stdin JSON construction
- Every operation exits 0 on error (hooks must never crash the agent)
- Compiled `.class` files committed to `build/classes/`
