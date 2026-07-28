---
name: tier-router
description: Prompt-intercepting multi-tier router that classifies user requests by reasoning complexity, reformulates prompts with SOTA prompt engineering criteria, and dispatches to the cheapest sufficient model tier.

## How It Works

1. **Intercept**: `UserPromptSubmit` hook captures every user prompt before the LLM sees it
2. **Classify**: 8-trigger mechanical escalation checklist + keyword tier matching → determines which tier (fable/haiku/sonnet/opus) is needed
3. **Reformulate**: Rewrites the prompt with SOTA criteria:
   - Conciseness directive (critical for Opus 5+)
   - Output format constraint ("Return usable results")
   - Uncertainty permission ("If unsure, say so")
   - Action directive ("Implement, don't just suggest")
   - Strips AI-style anti-patterns (em-dash abuse, weak openers, template language)
4. **Ambiguity check**: Detects vague requests ("fix the bug", "update the config") and asks clarification before routing
5. **Dispatch**: Injects `<routing-recommendation>` directive into context → main agent spawns correct tier agent

## Tier Agents

| Tier | Model | Cost | Use When |
|------|-------|------|----------|
| fable-general | fable | 0.25x | Trivial completions: add semicolons, close brackets |
| haiku-general | haiku | 1x | Mechanical: typos, format, rename, sort |
| sonnet-general | sonnet | 12x | Judgment: analyze, implement, refactor, review |
| opus-general | opus | 75x | Deep reasoning: proofs, formal verification |

## Escalation Triggers

| # | Condition | Action |
|---|-----------|--------|
| 1 | Ambiguity: vague prompt, missing scope | Ask user to clarify |
| 2 | Complexity signal: "design", "architecture", "best approach", etc. | Escalate to sonnet-level routing |
| 3 | Bulk destructive: "delete all", "remove *" | Escalate |
| 4 | File op without path: "fix the bug" | Escalate |
| 5 | Agent definition edit: ".claude/agents" + edit | Escalate |
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
    "fable-general": { "mode": "subagent", "model": "anthropic/claude-fable-5" },
    "haiku-general": { "mode": "subagent", "model": "anthropic/claude-haiku-4.5" },
    "sonnet-general": { "mode": "subagent", "model": "anthropic/claude-sonnet-5" },
    "opus-general": { "mode": "subagent", "model": "anthropic/claude-opus-5" }
  }
}
```

For Claude Code: install via marketplace and add routing directives to `.claude/CLAUDE.md`.
