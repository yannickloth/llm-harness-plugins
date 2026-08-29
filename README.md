# LLM Harness Plugins

OpenCode plugins for AI coding agents. Each plugin is a self-contained directory
with a Java backend and OpenCode TypeScript shim.

---

## Plugins

| Plugin | Description |
|--------|-------------|
| [`session-lifecycle`](./session-lifecycle) | Session lifecycle tracking — edit logs, git commit diffing, archival with 30-day retention |
| [`guardrail-chain`](./guardrail-chain) | Shared guardrail pipeline — pre/post execution filters across plugins |
| [`agentmem`](./agentmem) | Persistent file-based memory system — ADD-only, multi-signal retrieval, hierarchical scoping |
| [`agentinsights`](./agentinsights) | Session analytics + AI-generated narrative reports — scan transcripts, extract facets via LLM, generate HTML insights |
| [`graphrag`](./graphrag) | MS GraphRAG semantic layer — LLM-extracted entities/relationships, community summaries, vector-backed local/global/drift search |
| [`datetime-inject`](./datetime-inject) | Injects current datetime, platform, and repo toolchain context into every LLM prompt |
| [`sdlc-guardrails`](./sdlc-guardrails) | SDLC artifact-contract enforcement — plan/diff sync (R1), protected-path blocks (R2), test-protection during fixes (R3), bash write gating, verification-before-done commit gate (R6), incident→intent loop, audit log |

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
    "./llm-harness-plugins/datetime-inject/opencode/index.ts",
    "./llm-harness-plugins/agentinsights/opencode/index.ts",
    "./llm-harness-plugins/knowledge-graph/opencode/index.ts",
    "./llm-harness-plugins/graphrag/opencode/index.ts",
    "./llm-harness-plugins/prompt-registry/opencode/index.ts",
    "./llm-harness-plugins/typst-toolkit/opencode/index.ts",
    "./llm-harness-plugins/latex-toolkit/opencode/index.ts",
    "./llm-harness-plugins/general-skills/opencode/index.ts",
    "./llm-harness-plugins/sdlc-guardrails/opencode/index.ts"
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
| 5b | `datetime-inject` | — | Adds datetime/platform/toolchain context to every prompt; loads with the other chat-message consumers |
| 6 | `agentinsights` | — | Writes reports to `.agentmem/insights/` |
| 7 | `knowledge-graph` | — | Typst-derived graph; conceptually downstream of `typst-toolkit` |
| 7b | `graphrag` | — | Semantic index; conceptually downstream of `knowledge-graph` (classpath reuse) |
| 8 | `prompt-registry` | — | Manages prompt templates across all plugins |
| 9 | `typst-toolkit` | — | Format-bound skills |
| 10 | `latex-toolkit` | — | Format-bound skills |
| 11 | `general-skills` | — | Generic audit agents, load last |
| 12 | `sdlc-guardrails` | — | Enforcement layer; reads plan.md/spec.md/intent.md, load after skills |

Hard dependency: `guardrail-chain` → `agentmem`. Rest is soft layering.

Restart OpenCode. Plugins load and register their hooks/tools/events.

> **Note:** As of opencode v1.x, the docs only document npm packages in `plugin[]`. However, the source
> code (`packages/opencode/src/config/plugin.ts`, `resolvePluginSpec`) explicitly supports relative
> and absolute paths — resolved relative to the config file's directory. This is confirmed working.

### Topic gate (context injection)

`datetime-inject`, `agentfeed`, `semantic-cache`, `offpeak-nudge`, and `agentmem`
inject project context into prompts (datetime, coordination digests, cached
answers, pricing nudges, persistent memory). This is useful for coding sessions
but intrusive in personal, non-coding conversations.

Each of these plugins therefore supports a `topicGate` option (default `true`).
When enabled, the plugin only injects context into sessions it classifies as
**project-related**, based on a lightweight classifier in
`shared/session-topic.ts`:

- **project** if the message mentions code, tooling, git, build/test, repo,
  file paths, plugin/coordination jargon, or known project skills.
- **personal** if it matches common personal vocabulary in French, German,
  Spanish, or Italian.
- **unknown** otherwise — treated as non-project (no injection).

A session that becomes project-related later starts injecting on subsequent
messages. To force the old always-inject behavior for a code-only project, pass
`topicGate: false` to the plugin.

```json
{
  "plugin": [
    "./llm-harness-plugins/agentmem/opencode/index.ts",
    "./llm-harness-plugins/datetime-inject/opencode/index.ts"
  ]
}
```


### Plugin agents

Some plugins ship subagents in their `agents/` directory. To activate a plugin agent, define it in `opencode.json` under the `agent` key with the model, mode, permissions, and a `prompt` field pointing to the plugin's `.md` file.

The `.md` file frontmatter is for metadata. All config (model, mode, steps, description, permissions) must be restated in the `opencode.json` agent block. Only the markdown body becomes the system prompt.

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
| `tier-router` | `fable-general`, `haiku-general`, `sonnet-general`, `opus-general` | Generic tier agents; typically overridden globally |
| `general-skills` | `proof-soundness-auditor`, `xref-checker`, `style-naturalizer`, `style-auditor`, `citation-fidelity-auditor`, `bibliography-auditor`, `math-verifier`, `logic-auditor`, `redundancy-auditor`, `config-auditor`, `ste-100-auditor` | Use `{file:...}` prompt |
| `sdlc-guardrails` | `plan-auditor`, `test-guard-auditor` | Verify diff vs plan / weakened tests |
| `latex-toolkit` | `latex-xref-checker`, `latex-syntax-fixer`, `latex-figure-caption-auditor`, `latex-production-readiness-checker`, `latex-notation-consistency-checker`, `latex-index-auditor`, `latex-citation-checker`, `latex-formatting-fixer` | Use `{file:...}` prompt |
| `typst-toolkit` | `typst-diagram-checker`, `typst-syntax-fixer`, `typst-citation-checker`, `typst-xref-checker`, `typst-production-readiness-checker`, `typst-formatting-fixer` | Use `{file:...}` prompt |

Plugins without agents: `guardrail-chain`, `semantic-cache`, `agentinsights`, `knowledge-graph`, `graphrag`, `prompt-registry`, `session-lifecycle` (tools/hooks only).

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

## Building from source

```bash
./build.sh   # compiles Java to build/classes/
```

Requires Java >= 25. Pre-built artifacts are committed — building is only needed
when modifying the Java source.

---

## Repo structure

```
llm-harness-plugins/
├── agentmem/                  ← plugin
│   ├── opencode/
│   │   └── index.ts           ← OpenCode plugin entry
│   ├── agents/                ← agent prompt .md files
│   ├── builds/classes/        ← compiled Java (committed)
│   └── src/main/java/eu/infolead/llmhp/memory/
│       └── ...                ← Java core
├── build.sh
├── opencode.json.sample
└── README.md
```
