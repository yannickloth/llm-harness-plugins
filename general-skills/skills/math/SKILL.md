---
name: math
description: Verify mathematical proofs, derivations, and calculations — step-by-step correctness, hidden assumptions, logical structure. Delegates to math-verifier.
compatibility: Requires read access to content files
---
# Math Verification

Verifies mathematical content step by step. Delegates to `math-verifier`.

Usage: `/math <scope>`
- Scope: file path or glob. Required.

Agent: `math-verifier` — read-only; reports step-by-step correctness, hidden assumptions, and logical structure issues.
