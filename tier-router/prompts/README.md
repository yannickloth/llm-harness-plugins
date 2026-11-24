---
name: tier-router
description: Prompt-intercepting tier router that classifies a request by reasoning complexity, reformulates it with SOTA prompt criteria, and recommends (optionally dispatches to) the cheapest sufficient tier agent.
---

## How It Works

1. **Intercept**: the `chat.message` (v1) / `session.hook("prompt")` (v2) hook sees each user prompt before the model does.
2. **Classify**: LLM classifier for substantial prompts; otherwise the Java `RouterCli` (ambiguity, skill-axis rank match, keyword bands). Tier labels are the rank hierarchy: **sergeant < warrant-officer < lieutenant**.
3. **Reformulate**: rewrites the prompt with SOTA criteria:
   - Conciseness directive
   - Output format constraint ("Return usable results")
   - Uncertainty permission ("If unsure, say so")
   - Strips AI-style anti-patterns (em-dash abuse, weak openers, template language)
4. **Ambiguity check**: detects vague requests ("fix the bug", "update the config") and asks for clarification before routing.
5. **Dispatch**: the annotation names the recommended rank and agent. With `TIER_ROUTER_DISPATCH` (default), it instructs the model to delegate to the tier's rank agent (the tier label doubles as the agent name) via the Task tool; with `TIER_ROUTER_DISPATCH=0` it stays advisory. Annotation itself is opt-in via `TIER_ROUTER_ANNOTATE=1`.

## Tier Agents

| Tier | Agent | Rank | Relative cost | Use When |
|------|-------|------|---------------|----------|
| sergeant | `sergeant` | `proxy/sergeant` | 0.25x | Mechanical: typos, format, rename, sort |
| warrant-officer | `warrant-officer` | `proxy/warrant-officer` | 1x | Judgment: analyze, implement, refactor, review |
| lieutenant | `lieutenant` | `proxy/lieutenant` | 12x | Deep reasoning: proofs, formal verification |

Lieutenant is the top band; there is no rank above it in this plugin.

## Escalation Triggers

| # | Condition | Action |
|---|-----------|--------|
| 1 | Ambiguity: vague prompt, missing scope | Ask user to clarify |
| 2 | Complexity signal: "design", "architecture", "best approach", etc. | Escalate to warrant-officer-level routing |
| 3 | Bulk destructive: "delete all", "remove *" | Escalate |
| 4 | File op without path: "fix the bug" | Escalate |
| 5 | Agent definition edit: ".opencode/agents" + edit | Escalate |
| 6 | Multiple objectives (≥2) | Escalate |
| 7 | Creation/design tasks | Escalate |
| 8 | No clear keyword match | Escalate |
| 9 | Meta-routing: "router", "routing" questions | Escalate |

## Usage

Add to `opencode.json`:
```json
{
  "plugin": ["./tier-router/opencode/index.ts"],
  "agent": {
    "sergeant": { "mode": "subagent", "model": "proxy/sergeant" },
    "warrant-officer": { "mode": "subagent", "model": "proxy/warrant-officer" },
    "lieutenant": { "mode": "subagent", "model": "proxy/lieutenant" }
  }
}
```
