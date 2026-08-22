<!-- Change Driver: USER_PREFERENCES -->
<!-- Changes when: operational habits, estimation conventions, or session-management preferences change -->
<!-- Lazy-loaded reference file — load on demand for estimation, efficiency, session/file handling, dead code, and review-context fixes. Not injected by default. -->

# Effort & Time Estimates

Time estimates report AI wall-clock, not human calendar time. Fix the unit, don't suppress the estimate.

| Layer | Rule |
|-------|------|
| User-facing units | ✓ AI wall-clock (min/hr), # tool calls, # review-fix rounds, # build cycles, reasoning-effort tier · ✗ person-days, person-weeks, sprints, "X-week project," "several months" |
| Internal sizing | Always assess effort before acting. ✗ Reflexive "not worth it" / "too complex" without measuring (count files, lines, rounds) |
| Variance | Same task can vary up to ~30× run-to-run — give a range or flag uncertainty; ✗ false-precision point estimates |
| Human-time exception | Allowed only when user explicitly asks for human-equivalent sizing, or when the gating step is user review (frame as "pending user review," not elapsed time) |

**Rationale:** prohibiting estimates entirely makes the agent dismiss simple tasks as too complex. Fix is unit substitution, not suppression.

# Execution Efficiency

Fastest, least expensive approach always.

| Rule | Detail |
|------|--------|
| Automate repeated actions | Script/loop, not N manual steps |
| Batch operations | Group similar actions |
| Parallel execution | Concurrent tool calls + background agents |
| Cheapest sufficient model | small=mechanical, default=judgment, capable=deep reasoning |
| Minimize round-trips | One-pass info gathering |
| Avoid redundant work | Check done before doing; don't re-read files in context |

Time + compute = costs to user. Minimize.

# Long Sessions and Context Management

| Rule | Detail |
|------|--------|
| Commit after each phase | Uncommitted work lost if context runs out |
| Announce context pressure | Say so explicitly; offer fresh session for next phase |
| Never silently truncate | State which phases completed, which remain |

# File System

| Context | Temp dir | Notes |
|---------|----------|-------|
| Inside project (ephemeral scratch) | `$XDG_RUNTIME_DIR` (or per-project subdir) | tmpfs, user-private; ✗ not a repo `tmp/` |
| Inside project (durable output) | project-named dir on disk, NOT `tmp/` | Mislabeling durable as "tmp" is the error; rename/move |
| Outside project | `$XDG_RUNTIME_DIR` | Check set; fallback: `~/.cache/tmp` · project AGENTS.md may override |
| Tool intermediates (throwaway) | `$XDG_RUNTIME_DIR` | Always — even a "pre-approved sandbox" path must not sit under `/tmp` |
| ✗ Never use | `/tmp` | Shared, persists across sessions, security risks. No exception — no tool-intermediate path may be under `/tmp` |

Rule: real temp scratch → tmpfs, always via `$XDG_RUNTIME_DIR`. Durable artifacts never in a tmp-named folder.

# Dead / Unused Code

| Rule | Detail |
|------|--------|
| ✗ No dead code | Never leave unused functions, classes, variables, imports, or any unreachable code |
| ✗ No unused code | Remove code that is defined but never referenced or invoked |
| Exception | If user explicitly permits dead/unused code for a specific case, honor that |

# Opportunistic Fix Rule (Review Contexts)

When reviewing content (chapter review, audit, quality pass, proofreading):

| Condition | Action |
|-----------|--------|
| Preexisting issue found (not introduced by current task) | Fix it inline — do not just report |
| Issue is being worked on by a parallel/other session | Skip — note it but do not touch |
| Unsure if another session owns it | Fix it; parallel sessions reconcile via git |

✗ Never leave a known fixable issue in reviewed content just because it predates the current task.
