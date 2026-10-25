# LLM Harness Plugins

OpenCode plugins for AI coding agents. Each plugin is a self-contained directory
with a Java backend and OpenCode TypeScript shim.

---

## Plugins

| Plugin | Description |
|--------|-------------|
| [`session-lifecycle`](./session-lifecycle) | Session lifecycle tracking — edit logs, git commit diffing, archival with 30-day retention, and the per-session cost summary (root + subagent + day/month/all-time) read from OpenCode's session database |
| [`guardrail-chain`](./guardrail-chain) | Shared guardrail pipeline — pre/post execution filters across plugins |
| [`agentmem`](./agentmem) | Persistent file-based memory system — ADD-only, multi-signal retrieval, hierarchical scoping |
| [`agentinsights`](./agentinsights) | Session analytics + AI-generated narrative reports — scan transcripts, extract facets via LLM, generate HTML insights |
| [`graphrag`](./graphrag) | MS GraphRAG semantic layer — LLM-extracted entities/relationships, community summaries, vector-backed local/global/drift search |
| [`knowledge-graph`](./knowledge-graph) | Build-artifact knowledge graph over parsed sources — auto-injected file-scope subgraph context, `kg-query` tool, and the `archi-scan`/`archi-diagram` skills for an omm-style architecture doc-tree with Mermaid export; deterministic `parse` plus an LLM-authored `overlay.json` merge path |
| [`datetime-inject`](./datetime-inject) | Injects current datetime, platform, and repo toolchain context into every LLM prompt |
| [`sdlc-guardrails`](./sdlc-guardrails) | SDLC artifact-contract enforcement — plan/diff sync (R1), protected-path blocks (R2), test-protection during fixes (R3), bash write gating, verification-before-done commit gate (R6), incident→intent loop, audit log |
| [`premium-read-offload`](./premium-read-offload) | Offload bulk file reads and boilerplate generation from premium subscription sessions (Kimi K3, GLM-5.3) to a cheap persistent DeepSeek worker — hard gate with escapes, cache-aware worker sessions |
| [`semantic-router`](./semantic-router) | Fast local intent routing — embeds each message, matches config-defined routes, injects the route's directive into the system prompt and optionally gates tools. No LLM call |
| [`systemone`](./systemone) | Skill + six tools: when a local System 1 judgment is worth a call, which family to use (Studio's raw `systemone_decide`, Laya's presets when `laya-mcp` runs), plus packaged judgments (`systemone_suffice`, `_risk`, `_consensus`, `_novel`, `_constraints`) and `systemone_deep` to escalate to a larger CPU checkpoint (`kev-0.8b/4b/9b`) at the cost of seconds and an eviction of the resident model. Model detail in `reference/laya-engine.md` |
| [`local-decide`](./local-decide) | Plugin exposing the `local_decide` tool: a bounded System 1 choice (routing/triage/escalate-or-not) via **laya**, the local decision engine, returning the action plus laya's calibrated `confidence`/`confident`. **Dormant** until `laya-mcp` is enabled |
| [`context-editing`](./context-editing) | Model-managed context — projects the conversation into an editable `context.md` (mirror) over an append-only trace, so long sessions stay relevant instead of rotting. Cache-aware, wire-format-safe, fail-open budget. Phase 0 (`notices-only`) by default |
| [`codify-first`](./codify-first) | Meta-prompt plugin — injects a short intake directive (recurrence/stability/leverage gate) into the system prompt and ships the `codify-first` skill: check existing skills/agents, author the missing artifact into the project's `.opencode/`, then execute the task through it |

`local-decide` is currently dormant: its backend is laya, whose `laya-mcp` service is installed but
not auto-started, so the plugin is registered nowhere. Register `local-decide/opencode`
(or its absolute path) once `systemctl --user start laya-mcp` is running. The rest of the plugins are
opt-in per project.

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
    "./llm-harness-plugins/guardrail-chain/opencode",
    "./llm-harness-plugins/session-lifecycle/opencode",
    "./llm-harness-plugins/agentmem/opencode",
    "./llm-harness-plugins/semantic-cache/opencode",
    "./llm-harness-plugins/tier-router/opencode",
    "./llm-harness-plugins/datetime-inject/opencode",
    "./llm-harness-plugins/agentinsights/opencode",
    "./llm-harness-plugins/knowledge-graph/opencode",
    "./llm-harness-plugins/graphrag/opencode",
    "./llm-harness-plugins/prompt-registry/opencode",
    "./llm-harness-plugins/typst-toolkit/opencode",
    "./llm-harness-plugins/latex-toolkit/opencode",
    "./llm-harness-plugins/general-skills/opencode",
    "./llm-harness-plugins/systemone/opencode",
    "./llm-harness-plugins/context-editing/opencode",
    "./llm-harness-plugins/premium-read-offload/opencode",
    "./llm-harness-plugins/sdlc-guardrails/opencode"
  ]
}
```

> **Plugin paths are directories, not entry files.** OpenCode V2 rejects a file
> path here (`configured plugin path must be a directory`); a directory loads
> its `index.ts` and is accepted by V1 and V2 alike. Every plugin in this repo
> keeps a single `opencode/index.ts` that exports `{ id, setup, server }`:
> V2 calls `setup(ctx)`, V1 calls `server(input)`, so one file serves both.

### Register plugin agents

Agent files under `<plugin>/agents/` are **not** auto-discovered — the plugin
directory is not a location OpenCode scans for agents, so a plugin that spawns
`opencode run --agent <name>` (agentmem's `memory-keeper`/`memory-dreamer`, for
example) fails with `Session.AgentNotFoundError` until the name resolves.

Plugins register their own agents from `shared/agents.ts` — no symlinks, no
copies, nothing written outside the plugin:

```ts
// v1 (config hook)                          // v2 (setup)
config: async (input) => {                   await ctx.agent.transform((editor) =>
  registerAgentDirV1(input, agentsDir)         registerAgentDirV2(editor, agentsDir))
}                                            )
```

- **V2** — `ctx.agent.transform`'s editor has no `add`, but `update(id, fn)`
  **creates** the agent when `id` is absent (it inserts a default and then runs
  `fn`), so creation is spelled `update`. Each record is built inline:
  frontmatter body → `system`, `mode`, `steps`, `color`, `model`
  (`provider/model[#variant]`), and `permission:` verbs mapped to ordered rules
  (`bash`→`shell`, `write`/`patch`→`edit`, `task`→`subagent`, `todowrite`→`todo`).
  Rules are **appended**, so the runtime defaults — including the
  `read *.env → ask` guards — survive.
- **V1** — the `config` hook's `agent` map is filled inline (`prompt`, `mode`,
  `maxSteps`, `permission`, `tools`); `{file:}` is avoided because V1 parses and
  validates that file's frontmatter. Verbs V1's schema does not model become
  `tools: { <verb>: false }` when denied.

Reading the files ourselves also keeps their frontmatter out of a client's config
validator — the failure that forced the old symlink script to keep an allowlist
(a legacy `tools:` file made JetBrains' bundled opencode 1.18.25 refuse to start
with `Configuration is invalid at ~/.config/opencode/agent/typst-syntax-fixer.md`).

An explicit `agent` entry in a repo's `opencode.json` always wins: both paths
skip a name that is already declared, so per-repo overrides (pinned model,
reasoning effort) are preserved.

Eleven plugins ship agents and self-register: `agentmem`, `scientific-writing`,
`general-skills`, `typst-toolkit`, `latex-toolkit`, `ivp`, `tier-router`,
`natural-prose`, `sdlc-guardrails`, `premium-read-offload`, `context-toolkit`.

`bun test shared/agents.test.ts` covers the parsing and both registration paths.

| # | Plugin | Must load before... | Reason |
|---|--------|--------------------|--------|
| 1 | `guardrail-chain` | `session-lifecycle`, `agentmem` | `agentmem` imports `GuardrailPipeline`; early hooks avoid race conditions |
| 2 | `session-lifecycle` | `agentmem` | Lifecycle hooks should register before tool/context plugins |
| 3 | `agentmem` | `semantic-cache`, `agentinsights` | Creates `.agentmem/` root dir; `tier-router` reads its `MEMORY.md` |
| 4 | `semantic-cache` | — | Writes to `.agentmem/cache/`; planned cache for `tier-router` |
| 5 | `tier-router` | — | Reads `agentmem`'s `MEMORY.md` for routing signals |
| 5b | `datetime-inject` | — | Adds datetime/platform/toolchain context to every prompt; loads with the other chat-message consumers |
| 6 | `agentinsights` | — | Writes reports to `.agentmem/insights/` |
| 7 | `knowledge-graph` | — | Typst-derived graph; conceptually downstream of `typst-toolkit`; self-registers `archi-scan`/`archi-diagram` skills |
| 7b | `graphrag` | — | Semantic index; conceptually downstream of `knowledge-graph` (classpath reuse) |
| 8 | `prompt-registry` | — | Manages prompt templates across all plugins |
| 9 | `typst-toolkit` | — | Format-bound skills |
| 10 | `latex-toolkit` | — | Format-bound skills |
| 11 | `general-skills` | — | Generic audit agents, load last |
| 11d | `systemone` | — | Skill + `systemone_deep` (escalation to a larger CPU decision checkpoint); independent of other plugins |
| 11g | `context-editing` | `session-lifecycle`, `datetime-inject` | Context management; reuses `session-lifecycle` for trace retention; edits the message array after `datetime-inject` has added its per-message context |
| 11b | `premium-read-offload` | — | Premium-session read/generation offload; independent of other plugins |
| 11c | `semantic-router` | — | Local intent→directive routing; independent of other plugins (TS-only) |
| 11f | `codify-first` | `system-message-merge` | Intake directive + `codify-first` skill self-registration; load before the merge coalesces system messages |
| 12 | `sdlc-guardrails` | — | Enforcement layer; reads plan.md/spec.md/intent.md, load after skills |

Hard dependency: `guardrail-chain` → `agentmem`. Rest is soft layering.

Restart OpenCode. Plugins load and register their hooks/tools/events.

### Load canary — fail closed when a plugin silently drops

A plugin that fails to load (typo'd path, TS import error, opencode plugin-API
change) disappears **silently**: the session runs without its guardrails and
nothing fails. Every plugin therefore writes a load marker at init
(`shared/load-canary.ts`, a no-op unless probe env is set), and
`shared/canary_preflight.sh` verifies the markers in a free headless probe —
plugins load before any model call, so the probe uses an unresolvable model id
and costs nothing:

```bash
# exit 0 = every plugin in opencode.json loaded; exit 1 = fail closed — do NOT run
./shared/canary_preflight.sh opencode ./opencode.json
```

Call it in a pipeline or CI before real runs. The preflight also verifies that
plugins **initialized in config order** (sub-millisecond monotonic markers,
ties allowed) — that sequential loading is what makes the load-order table
above enforceable. Results are cached per (binary version + config content).
Under OpenCode V2 the probe auto-adds `--standalone` (a private server, so plugin
init is hermetic); V1 does not advertise the flag, so it is left out there.
Env: `LLMHP_CANARY_WAIT` (def. 60s), `LLMHP_CANARY_STATE` (stamp cache dir),
`LLMHP_CANARY_ORDER=0` (skip the order check), `LLMHP_CANARY_OFF=1` (skip).
`shared/canary_preflight.test.sh` pins the behavior with a fake `opencode`, including
the negative paths: opencode silently skips a broken plugin path, and an
init-order violation fails closed.

> **Note:** As of opencode v1.x, the docs only document npm packages in `plugin[]`. However, the source
> code (`packages/opencode/src/config/plugin.ts`, `resolvePluginSpec`) explicitly supports relative
> and absolute paths — resolved relative to the config file's directory. This is confirmed working.

### Topic gate (context injection)

`datetime-inject`, `agentfeed`, `semantic-cache`, `offpeak-nudge`, `agentmem`,
and `codify-first`
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
    "./llm-harness-plugins/agentmem/opencode",
    "./llm-harness-plugins/datetime-inject/opencode"
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
      "model": "deepseek/deepseek-flash",
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
| `premium-read-offload` | `bulk-reader`, `code-writer` | Worker prompts for the offload gate; run on `deepseek/deepseek-flash` |

Plugins without agents: `guardrail-chain`, `semantic-cache`, `semantic-router`, `agentinsights`, `knowledge-graph`, `graphrag`, `prompt-registry`, `session-lifecycle` (tools/hooks only).
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
cp llm-harness-plugins/agentmem/opencode .opencode/plugins/agentmem.ts
```

Auto-loaded on startup — no `opencode.json` change needed.

Plugins that import `../../shared/*` (most of them) break under a single-file
copy: OpenCode resolves a plugin module's relative imports against the path it
loaded, so an `index.ts` dropped one level shallower cannot find `shared/`.
Copy the repo (or use the directory form above) instead, or drop a re-export
shim in the plugins dir:

```ts
export { default } from "/abs/path/to/llm-harness-plugins/<plugin>/opencode/index.ts"
```

A **symlink** to the repo file does not work for the same reason — the loader
resolves against the link path, not the target.

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
│   ├── agents/                ← agent prompt .md files (self-registered in setup)
│   ├── builds/classes/        ← compiled Java (committed)
│   └── src/main/java/eu/infolead/llmhp/memory/
│       └── ...                ← Java core
├── build.sh
├── opencode.json.sample
└── README.md
```
