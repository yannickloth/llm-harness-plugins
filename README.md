# LLM Harness Plugins

Marketplace of plugins for AI coding agents. Each plugin is a self-contained directory
with platform backends for OpenCode, Claude Code, and Pi.

---

## Plugins

| Plugin | Description |
|--------|-------------|
| [`agentmem`](./agentmem) | Persistent file-based memory system — ADD-only, multi-signal retrieval, hierarchical scoping |

---

## Using with Claude Code

**One-step install — no build required:**

```
/plugin marketplace add infolead/llm-harness-plugins
/plugin install agentmem@llm-harness-plugins
```

Claude Code's built-in auto-memory must be disabled:

```bash
export CLAUDE_CODE_DISABLE_AUTO_MEMORY=1
```

Plugin components:
- **hooks**: `SessionStart` runs schema migration; `PostToolUse` writes a last-write stamp
- **bin/memorysystem**: CLI tool for all memory operations, added to Bash tool `PATH`
- Memory files stored at `.agentmem/` in the project root

Commands available to the agent: `/agentmem:save-memory`, `/agentmem:dream`, etc.
Or invoke directly: `${CLAUDE_PLUGIN_ROOT}/bin/memorysystem save ...`

---

## Using with OpenCode

No build step — compiled Java is committed. Two install options:

### Submodule + config (recommended)

```bash
git submodule add https://github.com/infolead/llm-harness-plugins.git
```

Add to your project's `opencode.json`:

```json
{
  "plugin": ["./llm-harness-plugins/agentmem/opencode/index.ts"]
}
```

Restart OpenCode. The plugin loads and registers four tools.

### Direct copy

```bash
cp llm-harness-plugins/agentmem/opencode/index.ts .opencode/plugins/agentmem.ts
```

Auto-loaded on startup — no `opencode.json` change needed.

See [`opencode.json.sample`](./opencode.json.sample) for full config with agents and commands.
Tools registered: `save-memory`, `forget-memory`, `check-memory-health`, `init-memory`.

---

## Using with Pi

```yaml
tools:
  - name: save-memory
    command: agentmem/bin/memorysystem save
```

---

## Building from source

```bash
./build.sh   # compiles Java to agentmem/build/classes/, creates bin/memorysystem
```

Requires Java >= 25. Pre-built artifacts are committed — building is only needed
when modifying the Java source.

---

## Repo structure

```
llm-harness-plugins/           ← marketplace root
├── .claude-plugin/
│   └── marketplace.json       ← registers all plugins
├── agentmem/                  ← plugin
│   ├── .claude-plugin/
│   │   └── plugin.json        ← Claude Code manifest
│   ├── bin/
│   │   └── memorysystem       ← compiled CLI (added to PATH)
│   ├── hooks/
│   │   └── hooks.json         ← SessionStart migration, PostToolUse stamp
│   ├── MemorySystem.java      ← CLI dispatcher
│   ├── opencode/
│   │   └── index.ts           ← OpenCode plugin entry
│   ├── prompts/
│   │   └── agent-prompt.md    ← Agent system prompt
│   ├── build/classes/         ← compiled Java (committed)
│   └── src/main/java/eu/infolead/llmhp/memory/
│       ├── types/             ← MemoryType, Entry, Confidence, etc.
│       └── ...                ← 16 core modules
├── build.sh
├── opencode.json.sample
└── README.md
```
