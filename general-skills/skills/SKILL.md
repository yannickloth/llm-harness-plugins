---
name: general-skills
description: Generic, reusable audit and quality skills — config, redundancy, logic, math, style, cross-refs, citations, proofs, review-convergence. Invoke individual subskills by name.
argument-hint: <subskill> [<file-scope>]
---

# General Skills

Collection of domain-agnostic audit and fix skills. Invoke individual subskills by name.

## Subskills

| Subskill | Agent(s) | Description |
|----------|----------|-------------|
| `config` | config-auditor | Audit AI coding agent config for conflicts, refs, routing |
| `redundancy` | redundancy-auditor | Detect repeated statements across documents |
| `logic` | logic-auditor | Find circular reasoning, gaps, hidden assumptions |
| `math` | math-verifier | Verify proofs, derivations step-by-step |
| `style` | style-auditor + style-naturalizer | Flag AI-patterns and rewrite as natural prose |
| `xref` | xref-checker | Verify internal cross-references resolve |
| `citation` | bibliography-auditor + citation-fidelity-auditor | Bibliography integrity + citation-claim verification |
| `cite-bib` | bibliography-auditor | Bibliography-only: duplicates, broken, missing fields, retracted |
| `cite-fidelity` | citation-fidelity-auditor | Citation-claim verification only: does source back the claim? |
| `proof` | proof-soundness-auditor + math-verifier + logic-auditor | Deep adversarial proof auditing. Agents have overlapping checks; prioritize proof-soundness findings and suppress duplicate findings from math-verifier and logic-auditor |
| `review-convergence` | (metaskill) | Orchestrates review/fix rounds to convergence. Requires at least one named review skill |

**Guards**: empty subskill → list table | unknown → suggest closest match | subskill without scope → ask user (except `config` which defaults to full stack)

## Usage

```
/general-skills:config [scope]        Audit config stack
/general-skills:redundancy <scope>    Detect repeated content
/general-skills:logic <scope>         Audit logical structure
/general-skills:math <scope>          Verify mathematical proofs
/general-skills:style <scope>         Audit style + naturalize
/general-skills:xref <scope>          Verify cross-references
/general-skills:citation <scope>      Audit citations (bib + fidelity)
/general-skills:cite-bib <scope>     Bibliography audit only
/general-skills:cite-fidelity <scope> Citation-claim fidelity only
/general-skills:proof <scope>         Deep proof audit
/general-skills:review-convergence <skill> [scope]  Convergence loop
```

## Arguments

- `$ARGUMENTS` — subskill name + scope. E.g., `logic docs/chapter-1`, `citation src/manuscript/*.tex`
- **Guard:** empty → list available subskills
- **Guard:** unknown subskill → report; suggest closest match
- **Guard:** subskill specified but no scope → ask user for file scope before proceeding (all subskills except `config` require a scope)
