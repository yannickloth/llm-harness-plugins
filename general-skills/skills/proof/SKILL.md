---
name: proof
description: Deep adversarial proof auditing — logical soundness, hidden assumptions, gap detection, circularity, mathematical correctness. Delegates to proof-soundness-auditor, math-verifier, and logic-auditor. Prioritize proof-soundness findings; suppress duplicate findings from math-verifier and logic-auditor.
compatibility: Requires read access to content files
---
# Proof Audit (Deep)

Multi-agent adversarial proof audit. Delegates to `proof-soundness-auditor`, `math-verifier`, `logic-auditor`.

Usage: `/proof <scope>`
- Scope: file path or glob. Required.

Agents (overlapping checks — prioritize `proof-soundness-auditor` findings):
- `proof-soundness-auditor` — adversarial deep review of formal proofs
- `math-verifier` — step-by-step mathematical verification
- `logic-auditor` — circular reasoning, gaps, hidden assumptions

Suppress duplicate findings from math-verifier and logic-auditor when already covered by proof-soundness-auditor.
