# Session Budget Exhausted

The cumulative token spend for this session has reached the configured ceiling
(TIER_ROUTER_BUDGET_CEILING, default 500K tokens). No further tool calls or
subagent invocations are permitted.

## Agent Behavior When Budget Is Exhausted

When you receive a `<routing-recommendation>` with `Decision: EXHAUSTED`:

- **MUST NOT** execute any tool calls (no Read, Edit, Write, Bash, Glob, Grep, Task)
- **MUST NOT** spawn subagents
- **MUST** summarize what was accomplished in this session
- **MUST** list any remaining tasks NOT yet completed
- **MUST** advise the user to start a new session to continue
- **MUST NOT** ask clarifying questions

## User Guidance

To continue work, start a new session. The budget resets per session.
To adjust the ceiling, set `TIER_ROUTER_BUDGET_CEILING` env var before starting
the session (e.g., `export TIER_ROUTER_BUDGET_CEILING=1000000` for 1M tokens).
