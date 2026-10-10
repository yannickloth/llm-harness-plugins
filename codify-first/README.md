# codify-first

Meta-prompt plugin: injects a short always-on **intake directive** into the
system prompt and ships the matching **`codify-first` skill** that carries the
full procedure.

Before working on a non-trivial task, the agent runs the codify-first gate:

| Criterion  | Question                                                        |
|------------|-----------------------------------------------------------------|
| Recurrence | Will this task shape plausibly recur in this project?           |
| Stability  | Is the best approach already clear (not still being explored)?  |
| Leverage   | Is the procedure bounded and verifiable enough to codify?       |

All three must hold — but an activity that is **already partly codified**
passes by default: an existing skill/agent covering part of the flow is proof
of recurrence and reuse, and the work becomes extending that artifact rather
than authoring a new one. Then: check existing skills/agents first (project
`.opencode/`, installed plugins, `find-skills`). The artifact is written
**into the consuming project** (`.opencode/skill/` or `.opencode/agent/`),
and the original task is executed *through* it, so its first run doubles as
validation. Gate fails → task is done directly, no scaffolding.

A second, gate-independent behavior: while working with any existing skill,
agent, or prompt, the agent collects every improvement it identifies (stale
guidance, missing guards, retrieval-hostile descriptions, drift) and proposes
them all at the end as concrete per-artifact changes — applied in place only
where the session may edit, proposed otherwise.

Artifacts authored or extended under this skill must prefer **deterministic
gates**: done-criteria as scripts, validators, exit-code checks, or markers
that fail closed — never as prose the model re-judges each run. (Same
philosophy as the repo's load canary and preflight.)

## Config

```jsonc
{
  "plugin": ["./llm-harness-plugins/codify-first/opencode/index.ts"],
  // optional:
  // "codify_first": { "enabled": true, "topicGate": true }
}
```

- `enabled` (default `true`) — master switch for the system-prompt directive.
- `topicGate` (default `true`) — suppress the directive in sessions classified
  as personal/non-coding (shared `session-topic` classifier). The skill stays
  discoverable either way.

Skill-only fallback: the skill self-registers via `skills.paths` (same
mechanism as `laya`/`clm`), so the directive and the skill load together from
the single plugin entry.
