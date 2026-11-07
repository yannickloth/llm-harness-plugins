---
description: Report-only IVP assessment of the current codebase — drivers, Γ, and module structure, with a ranked prescription. Never edits
agent: current-modularization-auditor
subtask: true
---
Load the skill `assess-ivp` and apply it to the scope below. This is step 4 of
IVP: diagnose the existing structure against the Γ-equivalence partition. Do not
move, split, merge, rename, or re-annotate any element — report only.

Scope: $ARGUMENTS

Follow the skill exactly, including:
- the applicability gates G1–G4 (report `NOT APPLICABLE` and stop if one fails);
- the registry precondition (read an existing Γ; never invent one);
- the output block the skill specifies, ending with `VERDICT` and `NEXT`.

The canonical reference is `ivp-knowledge.md` in this plugin's `prompts/`
directory; your system prompt states its absolute path.
