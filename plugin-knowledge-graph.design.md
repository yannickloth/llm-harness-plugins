# Knowledge Graph Design — Plugin Architecture

Author: Yannick Loth
Status: Design document (current as of 2026-07-29)
Projects: ivp-book-series, health-me-cfs

---

## 1. Philosophy

Source of truth = Typst files. The graph is a **build artifact**: deterministic
derivation of all parsed content. `nix build` → PDFs + `graph.json`. Zero
infrastructure, no runtime server, git-trackable, Nix-packable.

The same engine serves both projects — only the node/edge types and label
conventions differ. One parse pipeline, two schemas.

**Sync guarantee:** the graph is regenerated from `.typ` files on every build,
identical to how `typst compile` regenerates PDFs. The `.typ` files are the single
source of truth. The graph has no independent existence — it is always a
derivative of the current source. No duplication, no drift, no manual maintenance.

**Automation guarantee:** the user never invokes the graph. The plugin layer handles
all interactions: session-start context injection, per-file scoped subgraph injection,
on-demand agent queries. Same pattern as `agentmem` — the TypeScript shim is thin,
Java is the core, everything happens behind the scenes.

| Property | IVP | ME/CFS |
|----------|-----|--------|
| Input | ~6,900 `.typ` files | ~800 `.typ` files |
| Nodes | ~20,000 | ~4,000 |
| Edges | ~75,000 | ~18,000 |
| Build time | ~2 sec (pure Java, in-memory) | ~1 sec |
| Output | `graph.json` (~5 MB) | `graph.json` (~200 KB) |

---

## 2. Architecture — The Eight-Phase Pipeline

All phases run in `GraphPreprocessor.process()`. Phases 1 and 4 are
project-specific (regex patterns from config). The rest are shared.

```
.typ files
    │
    ▼
┌───────────────────────────────────────────────┐
│ Phase 1: Label Scanner (project-specific)      │
│ ─────────────────────────────────────────────  │
│ Regex patterns from project config             │
│ → Node set (dedup by ID, merge multi-location) │
│ → Records `files` property on merged labels    │
└───────────────────┬───────────────────────────┘
                    │
                    ▼
┌───────────────────────────────────────────────┐
│ Phase 1b: Reference Scanner (shared)           │
│ Scan [@<]ref[>] patterns in body text          │
│ → depends_on edges (file-level parents)        │
└───────────────────┬───────────────────────────┘
                    │
                    ▼
┌───────────────────────────────────────────────┐
│ Phase 2: Include Resolver (shared)             │
│ Resolve #include/#import to absolute paths.    │
│ Detects include cycles. Builds includeTree.    │
└───────────────────┬───────────────────────────┘
                    │
                    ▼
┌───────────────────────────────────────────────┐
│ Phase 3: Structural Context (shared)           │
│ Walk includes upward to find volume/part/      │
│ chapter/section. Creates appears_in edges.     │
│ Adds cross-volume shares_concept edges         │
│ for identical def names in different volumes.  │
└───────────────────┬───────────────────────────┘
                    │
                    ▼
┌───────────────────────────────────────────────┐
│ Phase 4: Dependency Extractor (project-sp.)    │
│ Parse body text, extract @label references.    │
│ Creates depends_on edges. Auto-creates def:    │
│ nodes for undefined references.                │
│ Adds defines edges for citation→def in scope.  │
└───────────────────┬───────────────────────────┘
                    │
                    ▼
┌───────────────────────────────────────────────┐
│ Phase 5: Named-Relation Linker (project-sp.)   │
│ Match naming conventions (e.g., proof→theorem, │
│ lemma→theorem) to infer proves/serves edges.   │
└───────────────────┬───────────────────────────┘
                    │
                    ▼
┌───────────────────────────────────────────────┐
│ Phase 6: Cross-Reference Expansion (shared)    │
│ Transitive closure of @refs through includes.  │
│ Creates cross_references edges.                │
└───────────────────┬───────────────────────────┘
                    │
                    ▼
┌───────────────────────────────────────────────┐
│ Phase 7: Entity Resolution (shared)            │
│ Canonicalizes nodes with same type+name.       │
│ Rewires edges to canonical IDs.                │
│ Removes self-loops. Deduplicates edges.        │
│ Stores merged files property on canonical.     │
└───────────────────┬───────────────────────────┘
                    │
                    ▼
┌───────────────────────────────────────────────┐
│ (Post-process) Community Detection (shared)    │
│ Leiden hierarchical clustering on depends_on   │
│ edges. Configurable resolution (γ).            │
│ Produces communities, summaries, hierarchy.    │
│ → Enables GraphRAG-style global search.       │
└───────────────────┬───────────────────────────┘
                    │
                    ▼
              graph.json
```

---

## 3. Plugin Automation Architecture

The graph is never invoked manually. Three invisible automation layers fire from
the OpenCode/Pi/Claude Code plugin system:

### 3.1 Automation Layers

| Layer | Trigger | Action | User sees? |
|--------|---------|--------|-----------|
| **session.created** / **SessionStart** | Every new agent session | Inject `agent-prompt.md` (with concrete plugin path) + graph overview | No — `client.session.prompt({ noReply: true })` |
| **file.edited** + **tool.execute.after** | Any file read/edited/written | Inject 1-hop dependency subgraph for the affected entities | No — scoped injection with deduplication |
| **Agent tool call / slash command** | Agent calls `kg-query` or `/kg-query` | Full graph traversal (topo-sort, transitive-closure, community-summary, contradictions, impact) | Only the tool result |

### 3.2 Plugin File Layout

```
llm-harness-plugins/knowledge-graph/
├── .claude-plugin/
│   └── plugin.json                    # Claude Code marketplace manifest
├── hooks/
│   └── hooks.json                     # Claude Code session-start + post-tool-use hooks
├── prompts/
│   └── agent-prompt.md                # Agent-facing usage guide (injected at session start)
├── commands/
│   └── kg-query.md                    # Claude Code slash command (/kg-query)
├── opencode/
│   └── index.ts                       # OpenCode plugin: tool registration + context injection
├── pi/
│   └── index.ts                       # Pi plugin: tool registration + context event hook
├── bin/
│   └── kg-context                     # Bash wrapper → Java CLI (used by Claude Code hooks)
├── config/
│   ├── project-config-ivp.yaml        # IVP label regexes, node/edge rules
│   └── project-config-mecfs.yaml      # ME/CFS label regexes, node/edge rules
├── src/
│   ├── main/java/eu/infolead/llmhp/graph/
│   │   ├── GraphCli.java              # Command dispatcher (parse, query, context, impact,
│   │   │                              #   subgraph, rate, overview, quality, validate)
│   │   ├── GraphPreprocessor.java     # 7-phase parser pipeline + entity resolution
│   │   ├── GraphQueryEngine.java      # JSON IO, query engine, quality metrics, validation
│   │   ├── CommunityDetector.java     # Leiden clustering (configurable γ) + summary generation
│   │   ├── GraphContextBuilder.java   # Tier-1/2 prompt context, project overview
│   │   ├── GraphRater.java            # Community relevance scoring (token overlap)
│   │   └── types/
│   │       ├── Node.java              # Node record (id, type, name, file, line, properties)
│   │       ├── Edge.java              # Edge record (source, target, type, properties)
│   │       ├── Graph.java             # Container with transitive closure (bounded), cycles (dedup),
│   │       │                          #   topological sort
│   │       └── ProjectConfig.java     # YAML config records
│   └── test/java/eu/infolead/llmhp/graph/
│       └── GraphTests.java            # 82 tests: JSON roundtrip, queries, TC depth, cycles,
│                                      #   topo-sort, entity resolution, quality, validation
└── build/classes/                     # Pre-compiled Java .class files
    └── eu/infolead/llmhp/graph/
```

### 3.3 OpenCode Plugin Shim (opencode/index.ts)

Registers `kg-query` tool, injects agent-prompt + graph overview at session start,
injects subgraph context on file reads/edits. Uses `client.session.prompt()` with
`noReply: true` for invisible injection. Substitutes `<plugin-dir>` placeholder
into the agent prompt for concrete path.

```typescript
export default async ({ client, directory, worktree }: Parameters<Plugin>[0]) => {
  const root = worktree ?? directory
  return {
    "session.created": async (input) => {
      // Read agent-prompt.md, substitute plugin dir, inject overview
      const raw = await $`cat ${path.join(pluginDir, "prompts", "agent-prompt.md")}`.nothrow().text()
      const header = raw.replace("<plugin-dir>", pluginDir)
      await injectContext(client, sessionId, header + "\n---\n" + ctxText)
    },
    "file.edited": async ({ file }) => {
      // Inject subgraph for edited file
      const result = await $`java ... ${mainClass} subgraph ${gf} ${absPath} 1`.nothrow().text()
      await injectContext(client, sessionId, "## Graph Impact (edited file)\n" + result)
    },
    "tool.execute.after": async (event) => {
      // Inject subgraph for files read by the agent
      if (!FILE_TOOLS.has(event.tool)) return
      const filePath = extractFilePathFromToolInput(event.input)
      const result = await $`java ... ${mainClass} subgraph ${gf} ${absPath} 1`.nothrow().text()
      await injectContext(client, sessionId, "## Graph Context (file read)\n" + result)
    },
    tool: {
      "kg-query": tool({
        description: "Query the knowledge graph: transitive-closure, ...",
        async execute(args, context) {
          return await $`java ... ${mainClass} query ${gf} ${args.query}`.nothrow().text()
        }
      })
    }
  }
}
```

### 3.4 Pi Plugin (pi/index.ts)

Same pattern, uses `pi.registerTool()` and `pi.on("context")` / `pi.on("tool_result")` events.
Reads `agent-prompt.md` with `readFileSync`, substitutes `<plugin-dir>`.

### 3.5 Claude Code Plugin (hooks/hooks.json)

Uses `SessionStart` + `PostToolUse` hooks to inject context:

```json
{
  "hooks": {
    "SessionStart": [{
      "matcher": "",
      "hooks": [{
        "type": "command",
        "command": "(sed \"s|<plugin-dir>|${CLAUDE_PLUGIN_ROOT}|g\" \"${CLAUDE_PLUGIN_ROOT}/prompts/agent-prompt.md\"; echo \"---\"; \"${CLAUDE_PLUGIN_ROOT}\"/bin/kg-context overview \"${CLAUDE_PROJECT_DIR}/graph.json\")"
      }]
    }],
    "PostToolUse": [{
      "matcher": "Read|Grep|Glob|Find|Ls|Edit|Write",
      "hooks": [{
        "type": "command",
        "command": "\"${CLAUDE_PLUGIN_ROOT}\"/bin/kg-context subgraph \"${CLAUDE_PROJECT_DIR}/graph.json\" \"${CLAUDE_TOOL_INPUT}\" 1"
      }]
    }]
  }
}
```

Plus a slash command in `commands/kg-query.md`:

```markdown
---
description: Query the knowledge graph — transitive-closure, topo-sort, cycles,
  community-summaries, contradictions, impact, quality, validate
argument-hint: [query]
allowed-tools: Bash(java:*)
---
Run: `java --class-path ${CLAUDE_PLUGIN_ROOT}/build/classes
  eu.infolead.llmhp.graph.GraphCli query "${CLAUDE_PROJECT_DIR}/graph.json" "$1"`
Review and report.
```

### 3.6 Registration

In `opencode.json`:

```json
{
  "plugin": [
    "../llm-harness-plugins/agentmem/opencode/index.ts",
    "../llm-harness-plugins/knowledge-graph/opencode/index.ts"
  ]
}
```

In `llm-harness-plugins/.claude-plugin/marketplace.json`:

```json
{
  "plugins": [
    "agentmem", "agentinsights", "general-skills",
    "latex-toolkit", "typst-toolkit", "knowledge-graph"
  ]
}
```

---

## 4. CLI Interface

```
GraphCli <cmd> [args...]
Commands:
  parse <project-root> <config-file> [output-file] [resolution]
  query <graph-file> <query> [scope]
  context <graph-file> <label>
  impact <graph-file> <label>
  subgraph <graph-file> <label> [depth]
  rate <graph-file> <task-description> [top-k]
  overview <graph-file>
  quality <graph-file>
  validate <graph-file>
```

| Command | Description |
|---------|-------------|
| `parse` | Parse `.typ` files → `graph.json`. Optional `resolution` (default 1.0) controls Leiden community granularity |
| `query` | Run graph queries: `transitive-closure`, `topo-sort`, `cycles`, `community-summary`, `contradictions`, `impact` |
| `context` | Build Tier-1 prompt context for a label (community, dependencies, dependents) |
| `impact` | What depends on this label, and what does this label depend on |
| `subgraph` | N-hop subgraph around a label or file path |
| `rate` | Rate communities by relevance to a task description (token-overlap scoring) |
| `overview` | Project-level overview (node/edge counts, type distributions) |
| `quality` | Graph quality metrics: entity coverage, relationship density, modularity, community distribution, summary quality |
| `validate` | Schema validation: dangling edges, blank IDs/types |

---

## 5. Agent-Prompt

Injected at session start by all three platforms. The `agent-prompt.md` file
is shared; each platform substitutes `<plugin-dir>` with its concrete path.

```markdown
# Knowledge Graph

A build-time knowledge graph at `graph.json` is available.
File-scope context auto-injected on reads/edits — no action needed.

## Querying the graph

If `kg-query` is in your tool list, call it directly with one of:
- transitive-closure <label>
- topo-sort <scope>
- cycles
- community-summary <label>
- contradictions <scope>
- impact <label>

If `kg-query` is NOT a tool, fall back to:
    java --class-path <plugin-dir>/build/classes ... query graph.json "<query> [scope]"

## Diagnostic commands (via Bash)
    java ... quality graph.json
    java ... validate graph.json
```

---

## 6. Cost Optimization — The Two-Tier LLM Pattern

GraphRAG's key insight: use a cheap LLM as a relevance filter, then an expensive
LLM only on the relevant subgraph.

| Tier | Model | When | What it does |
|------|-------|------|--------------|
| **Rater** | Haiku / GPT-4o-mini | Every agent call | Picks the right subgraph: "given the agent's task, which entities/communities are relevant?" |
| **Reasoner** | Sonnet or Opus / GPT-4o | After subgraph is extracted | Reads only the relevant subgraph (entities + relationships + summaries) and performs the actual audit/writing/review |

**Token impact per agent call:**

| Without KG | With KG (Tier 1 only) | With KG (two-tier) |
|---|---|---|
| Read all potentially-relevant files | Preloaded transitive-closure of target label | Haiku rates relevance → Sonnet/Opus reads only relevant community summaries |
| 20-50K tokens (50+ files) | 0.5-2K tokens (entity list + dependency chain) | 0.2K tokens (Haiku rating) + 2-5K tokens (focused subgraph) |
| ~$0.15-0.40/call (Sonnet) | ~$0.005-0.02/call | ~$0.002 + $0.02-0.05/call |

---

## 7. Community Detection — The GraphRAG Abstraction Layer

The `depends_on` graph is partitioned via **Leiden clustering** with configurable
resolution parameter γ. Communities are hierarchical.

| Level | Content | Use case |
|-------|---------|----------|
| L0 | Single entity (one definition/theorem/hypothesis) | Local search |
| L1 | Entity + direct neighbors (1-hop fan-out) | Agent reviewing one theorem |
| L2 | Community (e.g., all theorems in a section) | Section-level audit |
| L3 | Chapter-level cluster | Chapter review |
| L4 | Volume/paper-level cluster | Cross-chapter contradiction detection |
| L5 | Project-level cluster | Global queries |

Community summaries are structural (member lists, type counts, internal/external
edge counts) at parse time. LLM-generated thematic summaries are planned as an
optional post-processing pass.

---

## 8. Graph Quality Metrics

`quality` command computes:

| Metric | Definition |
|--------|------------|
| Entity coverage | Content entities per file (avg) |
| Relationship density | Edges per content entity |
| Community coherence | Newman-Girvan modularity (over depends_on edges) |
| Community size distribution | Bucketed histogram (1-4, 5-9, 10-14, 15-19, 20-24, 25+) |
| Summary quality | Fraction of communities with non-trivial summaries |

---

## 9. Schema Validation

`validate` command checks:
- Dangling edge references (source/target nodes that don't exist)
- Blank node IDs or types
- Reports total dangling reference count

---

## 10. Entity Resolution (Phase 7)

Handles the case where the same label appears in multiple files (e.g.,
`<ch:introduction>` in both `paper-a/ch01.typ` and `paper-b/ch01.typ`):

1. **Phase 1** (Label Scanner): When a label already exists in the node map,
   appends the new file path to the existing node's `files` property instead
   of silently dropping the duplicate.
2. **Phase 7** (Entity Resolution): Nodes with identical `type+name` are
   canonicalized. Edges are rewired to canonical IDs. Self-loops and duplicate
   edges are removed.

---

## 11. IVP Project — Node Types

### 11.1 Formal Content Nodes

| Type | Prefix | Properties | Example |
|------|--------|------------|---------|
| Definition | `def:` | name, file, line, files | `def:change-driver` |
| Theorem | `thm:` | name, hypotheses, claim, file | `thm:knowledge-theorem` |
| Proposition | `prop:` | name, hypotheses, claim | `prop:partition-optimality` |
| Corollary | `cor:` | name, parent_theorem | `cor:edge-count-case` |
| Lemma | `lem:` | name, serves_theorem | `lem:merge-split` |
| Axiom | `axm:` | name | `axm:element-knowledge` |
| Assumption | `asm:` | name | `asm:model-fidelity` |
| Proof | `proof:` | technique, parent_claim | `proof:knowledge-theorem-fwd` |
| Remark | `rem:` | type | `rem:cohesion-notation` |
| Example | `ex:` | domain_context | `ex:actor-partition` |
| KeyInsight | `ki:` | claim | `ki:artifact-boundary` |
| Counterexample | `cex:` | invalidates | `cex:srp-module` |
| Observation | `obs:` | claim | `obs:coincidence-condition` |

### 11.2 Structural Nodes

| Type | Prefix | Properties | Example |
|------|--------|------------|---------|
| Project | `prj:` | name | `prj:ivp-book-series` |
| Volume | `vol:` | number, title | `vol:1` |
| Part | `part:` | number, volume | `part:1-2` |
| Chapter | `ch:` | number, part | `ch:06` |
| Section | `sec:` | depth, chapter | `sec:dependencies` |
| Subsection | `subsec:` | section | `subsec:structural` |
| File | `file:` | path (mangled: `/`→`_`, `.`→`_`) | `file:src_main_typst_volume_1_main_typ` |
| Figure | `fig:` | type (cetz/tikz) | `fig:change-taxonomy` |
| Table | `tab:` | columns | `tab:quality` |
| Symbol | `sym:` | defines_volume | `sym:gamma` |

### 11.3 Edge Types

```
depends_on       def,thm,lem,prop,cor,proof → def,thm,lem,prop,cor,proof
                   Extracted from @label references in body text.

proves           proof → thm,lem,prop,cor
                   Derived from naming convention.

includes         file,* → file,*
                   #include/#import edges. DAG — no cycles.

serves_as_lemma  lem → thm,prop
                   Naming convention based.

cross_references  * → *
                   Transitive closure of @refs through includes.

appears_in       any_label → vol,part,ch,sec,subsec,file
                   Inferred by walking include chain upward.

shares_concept   def → def
                   Same definition name in different volumes.

defines          cit:ref → def:name
                   Citation defines a concept in its scope.

contradicts      thm,prop → thm,prop
                   Agent-populated: two claims are logically incompatible.

generalizes      thm,def,prop → thm,def,prop
                   Agent-populated: "X generalizes Y".
```

---

## 12. ME/CFS Project — Node Types

### 12.1 Biological Content Nodes

| Type | Prefix | Properties | Example |
|------|--------|------------|---------|
| Hypothesis | `hyp:` | name, confidence, testable | `hyp:hsat2-demethylation` |
| Mechanism | `mech:` | name, organ_system, involved_entities | `mech:safe-mode-activation` |
| Biomarker | `bio:` | name, measurement_method | `bio:alpha-CI` |
| Drug | `drug:` | name, class, targets | `drug:LDN` |
| Treatment | `trt:` | name, protocol | `trt:ivig-protocol` |
| Symptom | `sx:` | name, systems_affected | `sx:PEM` |
| Citation | `cit:` | doi, title, key_finding | `cit:BonnetFourel2026ProAB` |
| Definition | `def:` | name | `def:Post-exertional-malaise` |
| CausalRelationship | `causal:` | direction, evidence_strength | `causal:methylation→safe-mode` |
| Model | `model:` | type (ODE, compartment, …) | `model:67-variable-ode` |
| StateVariable | `var:` | name, range, units | `var:alpha-CI` |
| Speculation | `spec:` | name, certainty | `spec:methylation-loss-consolidation` |

### 12.2 Edge Types

```
depends_on       hyp,mech,drug,trt,bio → hyp,mech,drug,trt,bio
cites            hyp,mech,trt,spec → cit:*
causes           causal:* → mech,var,sx
targets          drug,trt → mech,var
measured_by      bio:* → var:*
contradicts      hyp,mech → hyp,mech
consistent_with  hyp,mech → hyp,mech
includes         file,* → file,*
appears_in       any_label → vol,part,ch,sec,subsec,file
```

---

## 13. Query Reference

| Query | Args | Description |
|-------|------|-------------|
| `transitive-closure` | `<label>` | All dependencies reachable from a label (bounded to configured depth in agent context, unlimited via CLI) |
| `topo-sort` | `<scope>` | Topological ordering of nodes in scope |
| `cycles` | — | Detect dependency cycles (deduplicated) |
| `community-summary` | `<label>` | Leiden community containing label + summary |
| `contradictions` | `<scope>` | Contradiction edges in scope |
| `impact` | `<label>` | Forward + backward transitive closure |

---

## 14. File Layout (as currently implemented)

```
llm-harness-plugins/knowledge-graph/
├── .claude-plugin/plugin.json          # Claude Code marketplace manifest
├── hooks/hooks.json                     # Claude Code session-start + post-tool-use hooks
├── prompts/agent-prompt.md              # Agent-facing usage guide (injected at session start)
├── commands/kg-query.md                 # Claude Code slash command
├── opencode/index.ts                    # OpenCode plugin shim (~153 LOC)
├── pi/index.ts                          # Pi plugin shim (~132 LOC)
├── bin/kg-context                       # Bash wrapper → Java CLI
├── config/
│   ├── project-config-ivp.yaml          # IVP label regexes, node/edge rules
│   └── project-config-mecfs.yaml        # ME/CFS label regexes, node/edge rules
├── src/
│   ├── main/java/eu/infolead/llmhp/graph/
│   │   ├── GraphCli.java                # Command dispatcher (~170 LOC)
│   │   ├── GraphPreprocessor.java       # 7-phase parser + entity resolution (~745 LOC)
│   │   ├── GraphQueryEngine.java        # JSON IO, queries, quality, validation (~720 LOC)
│   │   ├── CommunityDetector.java       # Leiden clustering + summaries (~200 LOC)
│   │   ├── GraphContextBuilder.java     # Tier-1/2 context, overview (~168 LOC)
│   │   ├── GraphRater.java              # Community relevance scoring (~104 LOC)
│   │   └── types/
│   │       ├── Node.java                # Record (id, type, name, file, line, properties)
│   │       ├── Edge.java                # Record (source, target, type, properties)
│   │       ├── Graph.java               # Container: TC (bounded), cycles (dedup), topo-sort
│   │       └── ProjectConfig.java       # Config records
│   └── test/java/eu/infolead/llmhp/graph/
│       └── GraphTests.java              # 82 tests (~600 LOC)
└── build/classes/eu/infolead/llmhp/graph/  # Pre-compiled .class files
```
