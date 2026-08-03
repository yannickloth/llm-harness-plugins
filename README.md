# LLM Harness Plugins

Marketplace of plugins for AI coding agents. Each plugin is a self-contained directory
with platform backends for OpenCode, Claude Code, and Pi.

---

## Plugins

| Plugin | Description |
|--------|-------------|
| [`session-lifecycle`](./session-lifecycle) | Session lifecycle tracking — edit logs, git commit diffing, archival with 30-day retention |
| [`guardrail-chain`](./guardrail-chain) | Shared guardrail pipeline — pre/post execution filters across plugins |
| [`agentmem`](./agentmem) | Persistent file-based memory system — ADD-only, multi-signal retrieval, hierarchical scoping |
| [`agentinsights`](./agentinsights) | Session analytics + AI-generated narrative reports — scan transcripts, extract facets via LLM, generate HTML insights |

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

Add to your project's `opencode.json`. **Order matters** — plugins are loaded sequentially and some depend on earlier plugins:

```json
{
  "plugin": [
    "./llm-harness-plugins/guardrail-chain/opencode/index.ts",
    "./llm-harness-plugins/session-lifecycle/opencode/index.ts",
    "./llm-harness-plugins/agentmem/opencode/index.ts",
    "./llm-harness-plugins/semantic-cache/opencode/index.ts",
    "./llm-harness-plugins/tier-router/opencode/index.ts",
    "./llm-harness-plugins/agentinsights/opencode/index.ts",
    "./llm-harness-plugins/knowledge-graph/opencode/index.ts",
    "./llm-harness-plugins/prompt-registry/opencode/index.ts",
    "./llm-harness-plugins/typst-toolkit/opencode/index.ts",
    "./llm-harness-plugins/latex-toolkit/opencode/index.ts",
    "./llm-harness-plugins/general-skills/opencode/index.ts"
  ]
}
```

| # | Plugin | Must load before... | Reason |
|---|--------|--------------------|--------|
| 1 | `guardrail-chain` | `session-lifecycle`, `agentmem` | `agentmem` imports `GuardrailPipeline`; early hooks avoid race conditions |
| 2 | `session-lifecycle` | `agentmem` | Lifecycle hooks should register before tool/context plugins |
| 3 | `agentmem` | `semantic-cache`, `agentinsights` | Creates `.agentmem/` root dir; `tier-router` reads its `MEMORY.md` |
| 4 | `semantic-cache` | — | Writes to `.agentmem/cache/`; planned cache for `tier-router` |
| 5 | `tier-router` | — | Reads `agentmem`'s `MEMORY.md` for routing signals |
| 6 | `agentinsights` | — | Writes reports to `.agentmem/insights/` |
| 7 | `knowledge-graph` | — | Typst-derived graph; conceptually downstream of `typst-toolkit` |
| 8 | `prompt-registry` | — | Manages prompt templates across all plugins |
| 9 | `typst-toolkit` | — | Format-bound skills |
| 10 | `latex-toolkit` | — | Format-bound skills |
| 11 | `general-skills` | — | Generic audit agents, load last |

Hard dependency: `guardrail-chain` → `agentmem`. Rest is soft layering.

Restart OpenCode. Plugins load and register their hooks/tools/events.

> **Note:** As of opencode v1.x, the docs only document npm packages in `plugin[]`. However, the source
> code (`packages/opencode/src/config/plugin.ts`, `resolvePluginSpec`) explicitly supports relative
> and absolute paths — resolved relative to the config file’s directory. This is confirmed working.

### Plugin agents

Some plugins ship subagents in their `agents/` directory. OpenCode's plugin system does **not** auto-discover agent `.md` files from plugin directories. To activate a plugin agent, define it in `opencode.json` under the `agent` key with the model, mode, permissions, and a `prompt` field pointing to the plugin's `.md` file.

The `.md` file frontmatter is **not** parsed when loaded via `{file:...}` — it's there for Claude Code compatibility. All config (model, mode, steps, description, permissions) must be restated in the `opencode.json` agent block. Only the markdown body becomes the system prompt.

```json
{
  "agent": {
    "memory-keeper": {
      "model": "deepseek/deepseek-v4-flash",
      "mode": "subagent",
      "steps": 5,
      "description": "Extracts non-derivable learnings from conversation to persistent memory",
      "permission": { "edit": "allow", "bash": "allow" },
      "prompt": "{file:./llm-harness-plugins/agentmem/agents/memory-keeper.md}"
    }
  }
}
```

### Plugin agents inventory

Plugins that ship agents:

| Plugin | Agents | Notes |
|--------|--------|-------|
| `agentmem` | `memory-keeper`, `memory-dreamer` | Both work with `{file:...}` prompt |
| `tier-router` | `fable-general`, `haiku-general`, `sonnet-general`, `opus-general` | Generic tier agents; `haiku-general` etc. typically overridden globally |
| `general-skills` | `proof-soundness-auditor`, `xref-checker`, `style-naturalizer`, `style-auditor`, `citation-fidelity-auditor`, `bibliography-auditor`, `math-verifier`, `logic-auditor`, `redundancy-auditor`, `config-auditor` | Most have existing entries in ivp-book-series `opencode.json` (without `prompt` field) |
| `latex-toolkit` | `latex-xref-checker`, `latex-syntax-fixer`, `latex-figure-caption-auditor`, `latex-production-readiness-checker`, `latex-notation-consistency-checker`, `latex-index-auditor`, `latex-citation-checker`, `latex-formatting-fixer` | None currently in ivp-book-series `opencode.json` |
| `typst-toolkit` | `typst-diagram-checker`, `typst-syntax-fixer`, `typst-citation-checker`, `typst-xref-checker`, `typst-production-readiness-checker`, `typst-formatting-fixer` | Most have existing entries in ivp-book-series `opencode.json` (without `prompt` field) |

Plugins without agents: `guardrail-chain`, `semantic-cache`, `agentinsights`, `knowledge-graph`, `prompt-registry`, `session-lifecycle` (tools/hooks only).

### Adding a plugin agent to your project

```json
{
  "agent": {
    "typst-diagram-checker": {
      "model": "kimi-for-coding/k3",
      "mode": "subagent",
      "prompt": "{file:./llm-harness-plugins/typst-toolkit/agents/typst-diagram-checker.md}",
      "permission": {
        "read": "allow",
        "edit": "deny",
        "bash": "allow",
        "glob": "allow",
        "grep": "allow"
      }
    }
  }
}
```

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
│   ├── ...                    ← 16 core modules
├── agentinsights/             ← plugin
│   ├── .claude-plugin/
│   │   └── plugin.json
│   ├── bin/
│   │   └── insights           ← compiled CLI
│   ├── hooks/
│   │   └── hooks.json
│   ├── opencode/
│   │   └── index.ts           ← OpenCode plugin entry
│   ├── commands/
│   │   └── insights.md        ← /insights command
│   ├── prompts/               ← LLM prompt templates
│   ├── build/classes/         ← compiled Java (committed)
│   └── src/main/java/eu/infolead/llmhp/insights/
│       ├── types/             ← SessionMeta, SessionFacets, AggregatedData, InsightResults
│       └── ...                ← 8 core modules
├── build.sh
├── opencode.json.sample
├── insights.md                ← Design document for the insights feature
└── README.md
```
