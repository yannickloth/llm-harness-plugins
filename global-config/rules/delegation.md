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

Models are rank names (`proxy/<rank>`) on the LiteLLM rank gateway — pure abstractions over the model holding the slot; the model behind a rank can change without touching agent config. Pick the cheapest sufficient rank. Never silently escalate to a costlier rank — state the trade-off and ask.

| Task type | Rank |
|-----------|------|
| Mechanical (renames, edits, structure fixes, checkers, faithful transformation) | `proxy/sergeant` |
| Volume (agentic pipelines, code generation, fix loops, long-form, research scanning) | `proxy/warrant-officer` |
| Language quality (style, tone, translation, terminology, prose patterns) | `proxy/second-lieutenant` |
| Deep reasoning / formal proofs / adversarial / domain-critical audits | `proxy/lieutenant` |
| Reads rendered figures / images / PDFs | the rank's `-v` sibling (checker → `proxy/warrant-officer-v`, deep visual judgment → `proxy/lieutenant-v`) |

**Hard contracts:**

- **Local ranks are sequential-only.** `sergeant` and `lieutenant` sit on single-slot local backends: parallel fan-out queues and queued requests can time out. N > 1 at once → `proxy/warrant-officer` (cloud), unconditionally — even for work that would otherwise be sergeant-class.
- **Plain ranks are text-only by contract.** Vision is exposed only through the `-v` sibling ranks; no caller may expect images from a plain rank (that is what lets a rank's model be swapped freely).
- **Nothing defaults above `lieutenant`.** `major`, `lieutenant-colonel*`, and unranked paid ids are explicit per-task escalation only, never an agent default.

**Rationale:** silent escalation burns quota fast; token limits hit → all work blocked. Route before continuing.
