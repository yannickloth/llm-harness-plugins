---
name: review-adversarial
description: Use this skill to run adversarial persona reviewers on specified files — each persona attacks a document from a different hostile angle. Use when stress-testing arguments, finding logical vulnerabilities, or reviewing content before publication. Reports aggregate vulnerabilities at the end.
---

# Adversarial Persona Review

Run all 5 adversarial personas sequentially on the specified scope. Each adopts a deliberately hostile but fair perspective to stress-test arguments, evidence, and framing.

## Gotchas

- Adversarial persona agents may produce findings that reflect the persona's inherent bias — weigh findings by how well they match observed evidence, not by persona severity.
- Personas are deliberately harsh; not all findings need fixing. Findings = "potential vulnerabilities", not "confirmed failures."
- Agent fails or times out → skip, note it, continue. Do not retry or block progress.
- Report output path: `$XDG_RUNTIME_DIR` → fall back to `$TMPDIR` if env var not set.

## Arguments

- `$ARGUMENTS` — file path(s) or glob (e.g., `contents/ch07.typ` or `src/**/*.tex`)

**Guard:** `$ARGUMENTS` empty/blank/literal → ask user for scope.
**Guard:** Glob resolves to zero files → report empty match; ask user to refine.

## Adversarial Personas

Run in order (cheapest/broadest → deepest):

| Step | Agent | Persona | Attacks |
|------|-------|---------|---------|
| 1 | `cynic-auditor` | Hostile Reviewer | Cherry-picking, motivated reasoning, advocacy-as-science, overconfidence |
| 2 | `sophist-auditor` | Logic Attacker | Non sequiturs, equivocation, false dichotomies, affirming consequent, unfalsifiability |
| 3 | `strawman-auditor` | Fairness Checker | Strawman arguments, missing steelman, omitted counterevidence, double standards |
| 4 | `reductionist-auditor` | Parsimony Enforcer | Unjustified integration, Occam's razor violations, complexity camouflage |
| 5 | `devil-advocate-auditor` | Counter-Argument Builder | Undefended claims, weakest links, alternative explanations, asymmetric scrutiny |

## Execution Protocol

1. **Resolve scope:** Expand glob, list files, count. Report to user.
2. **Per persona in order:**
   - Launch agent: "Review the following files from your adversarial perspective. Files: [list]. Report all findings in your standard output format. Do NOT edit any files."
   - Collect findings
   - Report: "Persona N complete: X findings"
3. **Aggregate report:**

```
====================================
ADVERSARIAL REVIEW REPORT
====================================

Scope: [files]
Date: [date]
Personas completed: [list]

FINDINGS BY PERSONA:
  1. Cynic (Hostile Reviewer):        N findings
  2. Sophist (Logic Attacker):        N findings
  3. Strawman (Fairness Checker):     N findings
  4. Reductionist (Parsimony):        N findings
  5. Devil's Advocate (Counter-Args): N findings

CROSS-PERSONA CONVERGENCE:
  [Claims flagged by 3+ personas — document's biggest vulnerabilities]

STRONGEST CLAIMS (survived all personas):
  [Claims no persona successfully attacked]

TOP VULNERABILITIES (by convergence):
  1. [claim/section] — flagged by: cynic, sophist, devil's advocate
     Attack summary: [one-line synthesis]
  2. ...

FULL DETAILS:
  [per-persona reports appended]

RECOMMENDED ACTIONS:
  1. Address cross-persona convergence points first
  2. Strengthen defense of claims attacked by devil's advocate
  3. Ensure fairness per strawman auditor findings
  4. Simplify per reductionist findings where possible
```

4. Write report → `$XDG_RUNTIME_DIR/review-adversarial-[timestamp].md` (fallback: `$TMPDIR/review-adversarial-[timestamp].md` if `$XDG_RUNTIME_DIR` not set)
5. Report location to user.

## Context Management

- Launch each persona as a subagent (own context)
- Keep only findings summary in main context, not raw output
- Context approaching 35% → generate continuation prompt with checkpoint reference

## Constraints

- All agents: **audit mode** (read-only, no edits)
- Findings reported, not fixed — user decides
- Do NOT invent findings — only report what agents detect
- Do NOT skip personas without reporting why
- Agent fails/times out → note it; continue
- Personas deliberately harsh — findings = "potential vulnerabilities", not "confirmed failures"
