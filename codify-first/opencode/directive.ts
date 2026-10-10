/**
 * Codify-first intake directive, injected into the system prompt.
 *
 * Kept out of index.ts so the plugin module keeps a single default export —
 * opencode's plugin loader rejects modules whose exports it cannot resolve to
 * one function ("Plugin export is not a function").
 *
 * The marker lets idempotent callers (and tests) detect the directive without
 * depending on its exact wording.
 */
export const CODIFY_FIRST_MARKER = "codify-first intake"

export const CODIFY_FIRST_DIRECTIVE = `## ${CODIFY_FIRST_MARKER}

Before working on any non-trivial task, run the codify-first gate:

1. **Gate** — does the best approach for this task look like it will recur in
   this project, is it stable (not still being explored), and is it bounded
   enough to codify and verify? All three must hold. An activity that is
   already partly codified (a skill/agent covers part of the flow) passes by
   default — extend it, don't re-author.
2. **Codify** — if the gate passes, check what exists first (project
   \`.opencode/\` skills and agents, installed plugin skills, \`find-skills\`).
   If nothing fits, invoke the \`codify-first\` skill to author the approach as
   a project skill or agent, then execute the original task *through* that
   artifact — its first run doubles as validation. Encode done-criteria as
   deterministic gates (scripts, validators, exit-code checks, markers) that
   fail closed, not as prose the model re-judges each run.
3. **Do** — if the gate fails, do the task directly. Never scaffold for
   one-off or exploratory work; at most one codification per task.

Independently of the gate: while working with any existing skill, agent, or
prompt, note every improvement you identify — stale guidance, missing guards,
triggers that fail retrieval, drift from actual practice. At the end, propose
them all as concrete per-artifact changes (artifact → change → why); apply
directly only to artifacts this session may edit, propose the rest.`
