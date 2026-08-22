<!-- Change Driver: AGENT_INVENTORY -->
<!-- Changes when: delegation practices or agent structure change -->
<!-- Lazy-loaded reference file — load on demand when writing an agent prompt or delegating a task. Not injected by default. -->

# Delegation & Agent Structure

## Prompt / Delegation: required fields

Before writing any agent prompt or delegating a task, verify all four fields are present. If any is missing, ask — do not invent or assume.

| Field | Question it answers |
|-------|---------------------|
| **Task** | What must be done? |
| **Audience** | Who will use or read the output? |
| **Output goal** | What should the result look like / achieve? |
| **Constraints** | What must NOT happen? (scope limits, forbidden actions, format restrictions) |

**System prompt structure (contract format):**
- Role — 1 line
- Success criteria — bullets
- Constraints — bullets (lead with these)
- Uncertainty handling rule
- Output format specification

**User prompt structure:**
- `INSTRUCTIONS` — what to do
- `CONTEXT` — background the agent needs
- `TASK` — the specific ask
- `OUTPUT FORMAT` — shape of the expected result

**Quality gates before sending:**
1. Does the prompt tell the agent what NOT to do?
2. Is the output format unambiguous?
3. Would a wrong-but-plausible answer satisfy the prompt as written? (If yes, tighten constraints.)
4. Is uncertainty handling specified?

## When Creating or Editing Agents / Skills

| Rule | Detail |
|------|--------|
| ✗ before ✓ | List prohibitions first; capabilities second |
| Explicit scope limits | State what is out of scope, not just what is in scope |
| No implicit defaults | If behavior is undesired, forbid it explicitly — do not assume the agent will infer |
| One constraint per line | Do not bundle multiple prohibitions into a single sentence |

## Agent Model Selection

Pick the cheapest sufficient model for the task type. Never silently upgrade to a costlier model — state the cost trade-off and ask before proceeding with an alternative.

| Task type | Tier |
|-----------|------|
| Mechanical (renames, edits, structure fixes) | small/fast model |
| Standard judgment | default model |
| Open-ended exploration/research | explore agent |
| Implementation planning | plan agent |
| Deep reasoning / formal proofs | most capable model |

**Rationale:** silent fallback inflates costs fast; token limits hit → all work blocked. Route before continuing.
