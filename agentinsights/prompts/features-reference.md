## PLATFORM FEATURES REFERENCE

1. **CLAUDE.md / AGENTS.md**: Project-level instructions that automatically apply to all sessions.
   - How to use: Create `CLAUDE.md` or `AGENTS.md` in project root with conventions and preferences.
   - Good for: coding conventions, testing requirements, architecture constraints.

2. **Custom Slash Commands**: Reusable prompts run with a single /command.
   - How to use: Define in `.opencode/commands/<name>.md`.
   - Good for: repetitive workflows like /commit, /review, /test.

3. **Hooks / Plugins**: Auto-running event handlers on session events.
   - How to use: Configure in `opencode.json` under "plugin" key.
   - Good for: auto-formatting, type checking, memory injection.

4. **Headless Mode**: Run agent non-interactively from scripts and CI/CD.
   - How to use: `opencode run --agent <name> <prompt>`
   - Good for: CI/CD integration, batch code fixes, automated reviews.

5. **Task Agents / Subagents**: Focused sub-agents for complex exploration or parallel work.
   - How to use: Agent auto-invokes when helpful, or ask "use an agent to explore X".
   - Good for: codebase exploration, understanding complex systems.

6. **MCP Tools**: External tool integrations via Model Context Protocol.
   - How to use: Configure in `opencode.json` under "mcpServers".
   - Good for: connecting to APIs, databases, external services.
