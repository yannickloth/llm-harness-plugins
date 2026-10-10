---
name: codify-first
description: Meta-skill — run the codify-first gate for a task, and when it passes, check existing skills/agents, author or extend the artifact (project skill or subagent) that codifies the best approach, then execute the original task through it. Use when the codify-first intake directive flags a task, when the user asks to turn a recurring procedure into a skill or agent, when an existing skill/agent only partly covers an activity and the gap should be codified, or when about to start any non-trivial task that looks repeatable.
argument-hint: <task-description>
---

# Codify First

Meta-skill. Turns a task's best approach into a reusable artifact **before**
doing the task, then does the task *through* that artifact. The artifact is
the deliverable's scaffolding, not a substitute for it — the task still gets
done in this session.

## Input

`$ARGUMENTS` = the task to perform (free text). If missing, ask what task to
run the gate for — never guess.

## Gate

Answer three questions about the task's best approach. Any **no** → do not
codify; do the task directly and stop (optionally note the task as a
codification candidate in one line).

1. **Recurrence** — will this task shape plausibly recur in this project?
   Signals: the user asks for a variant of something already done here, the
   repo has conventions the procedure must follow every time, or the task is
   a process (review, scaffold, check, migrate) rather than a one-off fix.
2. **Stability** — is the best approach already clear? Tasks still being
   explored (unknown requirements, design undecided, first contact with an
   unfamiliar subsystem) are not codifiable yet.
3. **Leverage** — is the procedure bounded and verifiable enough that a
   written artifact saves more than it costs? Good: numbered procedures whose
   done-criteria a deterministic gate can check (exit codes, validators,
   markers, scripts). Bad: open-ended judgment calls with no success criteria.
   A check a script can run beats a check the model must remember to run.

**Partial codification is the strongest signal.** When the activity is
already partly codified — a skill or agent covers part of the flow, or the
project's `AGENTS.md` documents the convention — questions 1 and 3 are
answered by evidence rather than prediction: the codification exists, is
actually reused, and can clearly be extended further. The gate passes; the
task becomes codifying the remaining gap (steps 1–2: extend, don't
duplicate).

**Cap:** at most one codification per task. If several artifacts look
worthwhile, pick the one with the clearest recurrence and mention the rest.

## Flow

1. **Check what exists** — before authoring anything:
   - Project-local: `.opencode/skill/` and `.opencode/agent/` in the current
     project, plus project `AGENTS.md` conventions.
   - Installed plugin skills and agents (the available-skills list).
   - The `find-skills` skill for installable skills.
   Then classify the fit:
   - **Fully covered** — run the task through the existing artifact and stop.
   - **Partly covered** — extend it: add the missing steps, cases, or guards
     to the existing artifact, or compose a thin skill that orchestrates
     existing ones. Codifying the gap beats authoring a near-duplicate.
   - **Not covered** — author a new artifact (step 2).

2. **Choose the artifact** (only on the *not covered* path):
   - **Skill** — the main agent should follow the procedure itself, in the
     current context. Default for processes, conventions, checklists.
   - **Subagent** — the work needs isolated context, its own permissions or
     model, or is a reviewer/auditor over produced output. Default for
     verification roles and bulk workers.
   When unsure, prefer a skill: it is cheaper, and a skill that outgrows its
   context can become an agent later.

3. **Author** — follow the built-in `customize-opencode` skill for authoring
   and registration conventions. Requirements regardless of artifact type:
   - **Project-first target**: write into the consuming project's `.opencode/`
     directory (skills: `.opencode/skill/<name>/SKILL.md`; agents:
     `.opencode/agent/<name>.md`). Only propose the plugin repo
     (`llm-harness-plugins`) when the procedure clearly generalizes beyond
     this project — and ask before writing there.
   - Frontmatter `name` (kebab-case, verb-first: `review-x`, `scaffold-y`,
     `check-z`) and a `description` written for retrieval: what it does **and
     when to use it**, in the voice a skill matcher will query with.
   - Body: numbered flow with explicit inputs, guards (what halts the skill),
     and verifiable done-criteria — same style as this file.
   - **Deterministic gates wherever possible**: express done-criteria as
     commands with exit codes, validators, canaries, or markers that fail
     closed — not as prose the model re-judges each run. Judgment is for what
     cannot be mechanized; everything mechanizable must be mechanized.
   - Agents also need an `opencode.json` agent block (model, mode,
     permissions, `{file:...}` prompt path) — say so in the report if the
     user must add it manually.

4. **Execute through the artifact** — run the original task via the newly
   created skill or agent:
   - Skill: follow it step by step for this task; do not paraphrase it away.
   - Subagent: dispatch the task to it as the first real workload.
   This first run is the validation run. Where the artifact is wrong,
   ambiguous, or missing a guard, **fix the artifact** (not an ad-hoc
   workaround) and continue — the artifact leaves the session exercised.

5. **Harvest & propose improvements** — throughout steps 1–4, whenever an
   artifact you read or ran (skill, agent `.md`, system prompt, `AGENTS.md`)
   shows a systematic weakness, record it. Signals: guidance that no longer
   matches practice, guards missing where this run tripped, descriptions that
   fail retrieval, bloat that hurts compliance, steps that were silently
   skipped, checks left as model judgment where a deterministic gate
   (validator, script, regex, marker) could replace them. Then propose
   **all** of them for integration:
   - Project artifacts this session created or extended → fix directly
     (step 4 already mandates this).
   - Everything else — plugin-repo skills/agents, built-ins, `AGENTS.md` —
     → propose only, never edit without explicit approval. One line per
     improvement: `artifact → concrete change → why it matters`.

6. **Report** — one short block: gate verdict, artifact path(s) created,
   extended, or reused, what the first run changed in the artifact,
   improvement proposals from step 5, and task outcome.

## Guards

- Gate fails → no artifact; task done directly.
- Existing artifact fully covers the task → reuse it; partly covers → extend
  it; never author a near-duplicate.
- Codification must never displace the task: if the session is running low on
  budget or the task is urgent, do the task first and note the candidate.
- If mid-execution the approach proves unstable (gate question 2 was wrong),
  stop codifying, finish the task directly, and say the artifact needs a
  follow-up pass.
- Never write into the plugin repo without asking.
- Improvement proposals are always collected, gate passed or not — the gate
  decides codification, not feedback.
