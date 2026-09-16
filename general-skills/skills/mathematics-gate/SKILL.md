---
name: mathematics-gate
description: Pre-submission gate that answers whether a formal/theoretical paper qualifies as mathematics, and locates its empirical boundary. Layered: (Layer 1) mechanically checks exact primitives + proof presence via flash/pro auditors; (Layer 2) on papers passing Layer 1, runs a deep verdict on derivation completeness and clean empirical/definitional separation. Reuses existing auditors; delegates the verdict to proof-soundness-auditor (deepest). Use before submitting any paper to a formal-methods, SE-theory, or survey venue — the "is this defensible as mathematics to a reviewer" bar.
compatibility: Requires read access to content files
---

# Mathematics Gate (Layered)

Assesses a paper against three criteria and returns a verdict usable before submission:
1. **Exact primitives** — are the core objects defined with exact identity conditions, domain-sourced and free of smuggled judgment?
2. **Complete derivations** — are the proofs real derivations, not sketches?
3. **Clean empirical boundary** — is the empirical/definitional separation explicit, and exactly where does the empirical begin?

Usage: `/mathematics-gate <scope>` — scope: file path or glob (paper manuscript `.typ`/`.tex`, or a set of chapter/proof files). Required.

## Why this gate exists

No mainstream journal is dedicated to theoretical software design; a paper of this kind faces reviewers who conflate "the primitives are domain-sourced" with "the theory is unrigorous." This gate produces the evidence to answer that conflation before it is raised. The three criteria are deliberately generic — they apply to any formal paper, not to one series.

## Layered procedure

The gate is two layers because most failures are caught cheaply and only papers that pass the mechanical layer merit the expensive deep verdict.

### Layer 1 — Mechanical rule pass (cheap)

Run on every paper. Mechanical, rule-based; catches the common failures and produces the "Skipped agents" log per `.agents/context/agent-applicability.md` pre-scan discipline.

**Agent availability.** `proof-soundness-auditor` and `claim-substance-auditor` are plugin agents (general-skills / scientific-writing). All other auditors named below are project agents (defined in the consuming project, e.g. ivp-book `.opencode/agents/`). Before running, check availability; any unavailable auditor goes into the "Skipped agents" log with its criterion — a Layer-2 criterion whose deep auditor is unavailable cannot reach a verdict and must be reported as `MATHEMATICS-CONDITIONAL` at best, never as a silent pass.

Pre-scan `$ARGUMENTS` for content signals (proofs, definitions, formal claims, driver/Γ/C mentions, quantifiers, math notation, empirical/cost language) and run only the auditors whose preconditions are met:

| Criterion checked | Auditors (preconditions) |
|---|---|
| **1. Exact primitives / no smuggled judgment** | `statement-environment-auditor` (definitions present, correctly placed); `type-hygiene-auditor` (objects typed correctly); `driver-ontology-auditor` (drivers domain-anchored, not ranked/created by design, *only if* driver/Γ content); `ontological-level-auditor` (no judgment treated as causal fact, *only if* formal claims) |
| **2. Proof presence (not yet soundness)** | `statement-environment-auditor` (every theorem/lemma/proposition has a proof environment or file; hypotheses inline, not detached) |
| **3. Empirical/definitional markers** | `modality-auditor` (possibility vs actuality — the empirical bridge warning); `normative-descriptive-auditor` (prescriptive vs descriptive mode shifts, *only if* cost/design guidance) |

Each auditor returns rule-level findings (pass / fail / conditional) with file:line locations.

**Layer 1 outcome:**
- If any criterion fails at the *mechanical* level (e.g., a theorem with no proof, a definition with vague conditions, drivers treated as created by design) → **gate FAILS here**. Report findings. Do not spend deep tokens. The paper is not submission-ready as mathematics.
- If all pass → proceed to Layer 2.

### Layer 2 — Deep verdict (expensive; only on Layer-1 pass)

Runs the deep-reasoning auditors that judge *substance*, not presence. Delegation to the deepest agent for the load-bearing judgment.

| Criterion checked | Auditor (tier) |
|---|---|
| **2. Derivation completeness (substance)** | `proof-soundness-auditor` (deepest: step-by-step walkthrough, gap detection, adversarial counter-construction) — *the* load-bearing check; plus `claim-substance-auditor` (pro) if the paper makes formal claims |
| **1. Primitive exactness (substance)** | `quantifier-rigor-auditor` (pro) — quantifier order/scope; `ontological-level-auditor` (pro) if formal claims |
| **3. Empirical boundary (substance)** | `hypothesis-scope-auditor` (pro) — are results cited only within hypothesis scope; is the empirical boundary correctly located |

**Layer 2 verdict synthesis.** The orchestrator (not an agent) assembles the three criterion verdicts and, critically, **locates the empirical boundary**: it names the exact step/sentence where the paper moves from "necessarily true given the axioms" (mathematics) to "a contingent claim about real systems" (empirical). This location is the artefact the paper needs to answer a hostile reviewer who conflates domain-sourced primitives with unrigorous theory.

## Output

`tmp/mathematics-gate-<scope-slug>-<YYYY-MM-DD>.md` — never `.opencode/`, never `.agents/`, never auto-committed. Content:

1. **Layer 1 results** — per-auditor rule findings; "Skipped agents" section proving the pre-scan ran.
2. **Layer 2 verdict** — per-criterion verdict (satisfied / satisfied-with-condition / failed) with the deep auditors' step walkthroughs for criterion 2.
3. **Empirical boundary location** — the exact sentence/step where the empirical begins, so the author can mark it explicitly.
4. **Overall verdict**: `MATHEMATICS` (all three criteria satisfied) / `MATHEMATICS-CONDITIONAL` (satisfied with a stated boundary or shared-driver caveat) / `NOT-YET-MATHEMATICS` (a criterion failed).

## When NOT to use this skill

| Situation | Use instead |
|---|---|
| Proof soundness alone | `proof` (plugin) |
| Step-by-step math verification | `math` (plugin) |
| Soundness + gaps + circularity only | `proof`/`proof-soundness-auditor` |
| Math hygiene sweep (notation, environment placement, many concerns) | `review-formalism` (project) |
| Full publication-readiness (citations, prose, figures, structure) | `review-paper-publication` / `review-typst` (project) |
| Proof *presence* only (every theorem has some proof) | `proof-completeness-auditor` |
| Series-specific IVP correctness | `ivp-consistency-checker` (project) |
