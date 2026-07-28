# Knowledge Graph Design — Plugin Architecture

Author: Yannick Loth
Status: Design document (unified)
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
| Nodes | ~6,700 (one per unique label) | ~4,000 |
| Edges | ~25,000 | ~18,000 |
| Build time | ~2 sec (pure Java, in-memory) | ~1 sec |
| Output | `graph.json` (~300 KB) | `graph.json` (~150 KB) |

---

## 2. Shared Architecture — The Preprocessor Pipeline

Same seven-phase pipeline for both projects. Only Phase 1 (label scanner) and
Phase 4 (dependency extractor) differ by project — the rest is identical.

```
.typ files
    │
    ▼
┌───────────────────────────────────────────────┐
│ Phase 1: Label Scanner (project-specific)      │
│ ─────────────────────────────────────────────  │
│ Regex patterns from project config             │
│ → Raw node set + raw edge set                  │
└───────────────────┬───────────────────────────┘
                    │
                    ▼
┌───────────────────────────────────────────────┐
│ Phase 2: Include Resolver (shared)             │
│ Resolve #include/#import to absolute paths.    │
│ Detects include cycles.                        │
└───────────────────┬───────────────────────────┘
                    │
                    ▼
┌───────────────────────────────────────────────┐
│ Phase 3: Structural Context (shared)           │
│ Walk includes upward to find volume/part/      │
│ chapter/section. Creates appears_in edges.     │
└───────────────────┬───────────────────────────┘
                    │
                    ▼
┌───────────────────────────────────────────────┐
│ Phase 4: Dependency Extractor (project-sp.)    │
│ Parse body text of each node, extract @label   │
│ references within the body only.               │
│ Creates depends_on / cites / invokes edges.    │
└───────────────────┬───────────────────────────┘
                    │
                    ▼
┌───────────────────────────────────────────────┐
│ Phase 5: Named-Relation Linker (project-sp.)   │
│ Match naming conventions: proof↔claim,         │
│ lemma↔theorem, mechanisms↔hypothesis, etc.     │
└───────────────────┬───────────────────────────┘
                    │
                    ▼
┌───────────────────────────────────────────────┐
│ Phase 6: Cross-Reference Expansion (shared)    │
│ Transitive closure of @refs through includes.  │
└───────────────────┬───────────────────────────┘
                    │
                    ▼
┌───────────────────────────────────────────────┐
│ Phase 7: Community Detection (shared)          │
│ Leiden hierarchical clustering on the depends  │
│ graph. Produces community hierarchy with       │
│ LLM-generated summaries at each level.         │
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
| **session.created** | Every new agent session | Inject graph index + community summaries for the scope under review (chapter/paper/volume) | No — `client.session.prompt({ noReply: true })` |
| **file.edited** + **tool.execute.after** | Any `.typ` file read/edited/written | Inject the file's 1-hop dependency subgraph + downstream dependents that need re-verification | No — scoped injection with deduplication |
| **Agent tool call** | Agent explicitly calls `kg-query "..."` | Full graph traversal (topo-sort, transitive-closure, community summaries, contradiction candidates) | Only the tool result, not the invocation |

### 3.2 Plugin File Layout

```
llm-harness-plugins/knowledge-graph/
├── .claude-plugin/
│   └── plugin.json                    # Claude Code marketplace manifest
├── hooks/
│   └── hooks.json                     # Claude Code session-start hooks → bin/kg-context
├── opencode/
│   └── index.ts                       # OpenCode plugin shim (session.created, file.edited, tool.execute.after, kg-query tool)
├── pi/
│   └── index.ts                       # Pi plugin shim (registerTool + context event hook)
├── bin/
│   └── kg-context                     # Chained Nix symlink to Java CLI
├── config/
│   └── project-config-ivp.yaml        # Label regexes, node/edge rules for IVP
│   └── project-config-mecfs.yaml      # Label regexes, node/edge rules for ME/CFS
└── build/classes/                     # Pre-compiled Java .class files
    └── eu/infolead/llmhp/graph/
        ├── GraphCli.java               # Command dispatcher (parse, query, context)
        ├── GraphPreprocessor.java      # Phases 1-6 parser pipeline
        ├── GraphQueryEngine.java       # JGraphT query methods
        ├── CommunityDetector.java      # Leiden clustering + summary generation
        ├── GraphContextBuilder.java    # Tier 1 prompt context assembler
        └── types/
            ├── Node.java               # Node record (id, type, properties)
            ├── Edge.java               # Edge record (source, target, type)
            └── Graph.java              # Container with JGraphT DirectedPseudograph
```

### 3.3 OpenCode Plugin Shim (opencode/index.ts)

Same pattern as `agentmem`:

```typescript
import type { Plugin, tool } from "@opencode-ai/plugin"
import { $ } from "bun"
import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"

export default async ({ client, directory, worktree }: Parameters<Plugin>[0]) => {
  const classesDir = join(import.meta.dir, "..", "build", "classes")
  const mainClass = "eu.infolead.llmhp.graph.GraphCli"
  const root = worktree ?? directory

  // shared helper
  const kg = (cmd: string) => $`java --class-path ${classesDir} ${mainClass} ${cmd}`.nothrow()

  return {
    "session.created": async (input) => {
      const sid = input.properties?.session?.id
      const scopeFile = guessScopeFile() // ← derived from the user's prompt / current file
      if (!scopeFile) return
      const ctx = await kg(`context ${root} ${scopeFile}`).text()
      if (!ctx.trim()) return
      await client.session.prompt({
        path: { id: sid },
        body: { noReply: true, parts: [{ type: "text", text: ctx }] },
      })
    },

    "file.edited": async ({ file }) => {
      const ctx = await kg(`impact ${root} ${file}`).text()
      if (!ctx.trim()) return
      await client.session.prompt({ ...
        body: { noReply: true, parts: [{ type: "text", text: ctx }] } })
    },

    "tool.execute.after": async (event) => {
      const FILE_TOOLS = new Set(["read", "edit", "write", "grep", "glob"])
      if (!FILE_TOOLS.has(event.tool)) return
      const fp = extractFilePath(event.input)
      if (!fp) return
      const ctx = await kg(`subgraph ${root} ${fp} --depth 1`).text()
      if (!ctx.trim()) return
      await client.session.prompt({ ...
        body: { noReply: true, parts: [{ type: "text", text: ctx }] } })
    },

    tool: {
      "kg-query": tool({
        description: "Query the knowledge graph: topo-sort, transitive-closure, cycles, community-summaries, contradiction-candidates",
        args: {
          query: tool.schema.string().describe("Query string, e.g. 'topo-sort --scope ch:06' or 'transitive-closure thm:knowledge-theorem'"),
          project: tool.schema.enum(["ivp", "mecfs"]).optional().default("ivp"),
        },
        async execute(args, ctx) {
          return await kg(`query ${ctx.directory} --project ${args.project} ${args.query}`).text()
        },
      }),
    },
  }
}
```

### 3.4 Scope Detection

The `session.created` hook needs to know what chapter/paper/volume the agent is
working on to inject the right subgraph. Strategy:

1. If the agent's task mentions a file path or chapter label → extract from prompt
2. If no explicit mention → read the most recently modified `.typ` file in git status → compute its chapter via include-walk
3. If no git changes → inject a project-level summary (L4 communities) as lightweight context

This is the same scoping pattern `agentmem` uses — the plugin reads the user's
intent from the session prompt, not manual configuration.

### 3.5 Claude Code Plugin

Uses the same Java core via `hooks.json` + `bin/` scripts:

```json
{
  "hooks": {
    "SessionStart": [{
      "matcher": "",
      "hooks": [{
        "type": "command",
        "command": "java --class-path ${CLAUDE_PLUGIN_ROOT}/build/classes eu.infolead.llmhp.graph.GraphCli context \"$CLAUDE_PROJECT_DIR\" auto"
      }]
    }],
    "PostToolUse": [{
      "matcher": "Read|Edit|Write",
      "hooks": [{
        "type": "command",
        "command": "java ... GraphCli subgraph \"$CLAUDE_PROJECT_DIR\" \"$CLAUDE_TOOL_INPUT\" --depth 1"
      }]
    }]
  }
}
```

Plus a slash command in `commands/`:

```markdown
---
description: Query the knowledge graph
argument-hint: [query]
allowed-tools: Bash(java:*)
---
Run: `java --class-path ${CLAUDE_PLUGIN_ROOT}/build/classes
eu.infolead.llmhp.graph.GraphCli query "$CLAUDE_PROJECT_DIR" "$1"`
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

## 4. Cost Optimization — The Two-Tier LLM Pattern

GraphRAG's key insight: use a cheap LLM as a relevance filter, then an expensive
LLM only on the relevant subgraph. Applied here:

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

The community hierarchy enables the two-tier pattern: cheap LLM prunes irrelevant
communities, expensive LLM gets only what matters.

---

## 5. Community Detection — The GraphRAG Abstraction Layer

The depends graph is partitioned into communities via **Leiden clustering**
(Phase 7). Communities are hierarchical: a chapter's definitions, theorems, and
proofs that depend on each other form a community; related chapters cluster
together at higher levels.

| Level | Content | Use case |
|-------|---------|----------|
| L0 | Single entity (one definition/theorem/hypothesis) | Local search — "what does thm:X depend on?" |
| L1 | Entity + direct neighbors (1-hop fan-out) | Agent reviewing one theorem — gets its lemmas, definitions, and downstream dependents |
| L2 | Community (e.g., all theorems in a section) | Section-level audit — "are all proofs in this section consistent?" |
| L3 | Chapter-level cluster | Chapter review — "does this chapter's argument chain hold?" |
| L4 | Volume/paper-level cluster | Cross-chapter contradiction detection |
| L5 | Project-level cluster | Global queries — "does any mechanism contradict any other?" |

**Community summaries** are LLM-generated at L2 and above, using a cheap model
(Haiku-tier — e.g., deepseek-v4-flash). The task is compression: read the entity
list and relationships, write a 2-4 sentence summary describing what the community
is about. No reasoning, no verification, no creativity required — just faithful
description. The prompt enforces faithfulness: "Summarize the following community.
Use only the listed entities and relationships. Do not invent." Haiku-tier is
sufficient; expensive models (Sonnet/Opus) are reserved for the downstream agent
that uses the summary as its pre-read context.

```
COMMUNITY: ch06-sec02-knowledge-theorem (L2)
  Contains: thm:knowledge-theorem, lem:element-knowledge-bridge,
            asm:element-knowledge, asm:unique-embodiment,
            asm:knowledge-coverage, proof:knowledge-theorem-fwd
  Summary: "Theorem establishes that an element's knowledge is uniquely
            determined by its change-driver set. Three assumptions cover
            element-level knowledge representation, unique embodiment, and
            knowledge coverage. Lemma bridges individual element knowledge
            to system-level knowledge. Forward direction proved."
  Transitive dependencies: def:element, def:change-driver,
            def:dependency-relation, def:system-tuple (plus 8 more)
```

When an agent is assigned to review a theorem in this community, it receives the
community summary as context instead of reading 14 files.

---

## 6. IVP Project — Node Types

### 6.1 Formal Content Nodes

| Type | Prefix | Properties | Example |
|------|--------|------------|---------|
| Definition | `def:` | name, file, line | `def:change-driver` |
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

### 6.2 Structural Nodes

| Type | Prefix | Properties | Example |
|------|--------|------------|---------|
| Project | `prj:` | name | `prj:ivp-book-series` |
| Volume | `vol:` | number, title | `vol:1` |
| Part | `part:` | number, volume | `part:1-2` |
| Chapter | `ch:` | number, part | `ch:06` |
| Section | `sec:` | depth, chapter | `sec:dependencies` |
| Subsection | `subsec:` | section | `subsec:structural` |
| File | `file:` | path | `file:a3b2...` |
| Figure | `fig:` | type (cetz/tikz) | `fig:change-taxonomy` |
| Table | `tab:` | columns | `tab:quality` |
| Symbol | `sym:` | defines_volume | `sym:gamma` |

### 6.3 Edge Types

```
depends_on       def,thm,lem,prop,cor,proof  →  def,thm,lem,prop,cor,proof
                   A is defined or proved in terms of B.
                   Extracted from @label references in body text.

proves           proof  →  thm,lem,prop,cor
                   proof-X.typ proves the parent claim.
                   Derived from naming convention in claims/ directory.

includes         file,*  →  file,*
                   Source file #include-s target file. DAG — no cycles.

serves_as_lemma  lem  →  thm,prop
                   Lemma written as stepping stone for the target.

cross_references  *  →  *
                   Transitive closure: if A includes B, A inherits B's @refs.

appears_in        any_label  →  vol,part,ch,sec,subsec,file
                   Inferred by walking the include chain upward.

generalizes       thm,def,prop  →  thm,def,prop
                   Agent-populated: "X generalizes Y".

contradicts       thm,prop  →  thm,prop
                   Agent-populated: two claims are logically incompatible.

member_of         *  →  community:*
                   Leiden cluster assignment.
```

---

## 7. ME/CFS Project — Node Types

### 7.1 Biological Content Nodes

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

### 7.2 Structural Nodes

| Type | Prefix | Properties | Example |
|------|--------|------------|---------|
| Project | `prj:` | name | `prj:health-me-cfs` |
| Volume | `vol:` | number, title | `vol:1` |
| Part | `part:` | number, title | `part:2-pathophysiology` |
| Chapter | `ch:` | number, title | `ch:55-causal-hierarchy` |
| Section | `sec:` | depth, chapter | `sec:ode-system` |
| Subsection | `subsec:` | section | `subsec:model-fitting` |
| Figure | `fig:` | type | `fig:immune-pathways` |
| Table | `tab:` | columns | `tab:drug-targets` |
| PatientData | `pat:` | patient_id | `pat:aeiuno` |
| Protocol | `prot:` | name | `prot:viral-clearance` |

### 7.3 Edge Types

```
depends_on       hyp,mech,drug,trt,bio  →  hyp,mech,drug,trt,bio
                   A is defined or reasoned in terms of B.

cites            hyp,mech,trt,spec  →  cit:*
                   The claim is supported by or references the citation.

causes           causal:*  →  mech,var,sx
                   From a formal causal relationship entity.

targets          drug,trt  →  mech,var
                   Drug or treatment targets a mechanism or variable.

measured_by      bio:*  →  var:*
                   Biomarker measures a state variable.

contradicts      hyp,mech  →  hyp,mech
                   Agent-populated: two hypotheses are incompatible.

consistent_with  hyp,mech  →  hyp,mech
                   Agent-populated: theory predicts observation.

includes         file,*  →  file,*

appears_in       any_label  →  vol,part,ch,sec,subsec,file

member_of        *  →  community:*
```

---

## 7A. Community Detection — ME/CFS Example

Leiden clustering on the ME/CFS depends graph produces hierarchies like:

```
L4: part:2-pathophysiology
  L3: ch:55-causal-hierarchy
    L2: sec:ode-system
      entities: var:alpha-CI, var:S, var:cal(T)
      mechanisms: mech:safe-mode-activation
    L2: subsec:methylation-consolidation
      entities: var:cal(M), hyp:hsat2-demethylation
      citations: cit:BonnetFourel2026ProAB
    L2: sec:contradiction-detection
      contradictions: hyp:X ↔ hyp:Y
  L3: ch:20-universal-mechanisms
    L2: community:metabolic
    L2: community:immune
```

Community summaries (L2+):

```
COMMUNITY: ch55-methylation-consolidation (L2)
  Contains: var:cal(M), hyp:hsat2-demethylation,
            spec:methylation-loss-consolidation,
            cit:BonnetFourel2026ProAB, cit:ChalderMoreau2026ptprn2
  Summary: "HSAT2 pericentromeric repeat demethylation is hypothesized
            as a consolidation mechanism in ME/CFS. Loss of methylation
            at HSAT2 is proposed to be transcription-dependent, not
            DNMT3B-redistribution driven (pers. comm. Fourel May 2026).
            PTPRN2 hypomethylation is documented as an additional
            methylation marker. The mechanism is modeled as part of the
            67-variable ODE via the cal(M) state vector."
  Confidence: spec:mecfs-methylation (speculative, needs replication)
  Contradictions: none detected at this level
```

---

## 8. Agent Integration — Cross-Project Context Builder

`GraphContextBuilder.java` takes a target label + project identifier and
emits a compact context block injected into the agent's system prompt.

**Tier 1 (preloaded, every call):**

```
GRAPH CONTEXT for thm:cost-superiority [ivp]
  Community: change-actors-sec05-cost-comparison (L2)
  Summary: "Theorem proves Γ_doc ≤ Γ_act under cost = α·edges + β·contam
            with β ≥ α. Proof decomposes R-edges into four classes and
            bounds contamination via ordered-pair counting. Corollary
            recovers edge-count result under refinement hypothesis."
  Transitive dependencies (6 shared, 4 local):
    [shared] def:gamma-quotient, def:candidate-gamma, def:cost-model
    [shared] def:contamination, def:partition-edges
    [local]  lem:merge-split, lem:split-merge
    [local]  def:actor-assignment, def:document-assignment
  Used by (2 nodes): cor:edge-count-case, prop:partition-optimality
  Proof: inlined proof (13 numbered steps)
  Centrality: #3 in change-actors dependency graph
```

**Tier 2 (agent-initiated exploration):**

```
GRAPH CONTEXT for hyp:hsat2-demethylation [mecfs]
  Community: ch55-methylation-consolidation (L2)
  Summary: [as above]
  Transitive dependencies (8):
    [ch55] var:cal(M), mech:safe-mode-activation
    [ch20] mech:immune-dysregulation
    [external] cit:BonnetFourel2026ProAB
    ...
  Used by (4 nodes):
    var:alpha-CI (via causal pathway), model:67-variable-ode
    spec:mecfs-methylation, subsec:epigenetic-findings
  Contradictions detected:
    NONE — consistent with all other hypotheses at L3
  Confidence: spec (pending validation — Fourel pers. comm. May 2026)
```

---

## 9. Query CLI — Multi-Project

```
java KnowledgeGraphQuery.java --project ivp --query transitive-closure thm:X
java KnowledgeGraphQuery.java --project me/cfs --query community-summary ch55:methylation
java KnowledgeGraphQuery.java --project ivp --query contradiction-candidates --scope vol:1
java KnowledgeGraphQuery.java --project me/cfs --query contradictions --scope part:2
java KnowledgeGraphQuery.java --project ivp --query diff graph-head.json graph-prev.json
```

All queries share the `--project` flag (default: `ivp`). New queries:

| Query | Use |
|-------|-----|
| `community-summary <label>` | Returns the L2 community summary containing the label — used by the two-tier rating pattern |
| `community-hierarchy <label>` | Returns the community chain from L0→L5 — used to decide how broad a context to load |
| `relevant-communities <query>` | Two-tier: Haiku rates community summaries for relevance, returns top-k |
| `cross-project-similarity <label>` | Naively: entities with similar centrality profiles across projects — useful for cross-domain analogy |

---

## 10. Token Cost Impact — Concrete Estimates

Based on the review-convergence audit of change-actors (17 rounds, ~120 findings fixed):

| Agent call type | Without KG | With KG (Tier 1) | Savings |
|---|---|---|---|
| Review a single theorem | Read all of sec-02 + sec-05 + claims/* (8 files, ~4,000 tokens body + ~16,000 context overhead for definitions carried by agent scanning) | Community summary + dependency closure (350 tokens) | ~95% |
| Cross-section consistency check | Read all 6 sections (11 files, ~6,000 tokens) | Full dependency graph traversal with L3 communities (2,000 tokens) | ~67% |
| New content integration (synthesis) | Read entire paper + transitive dependency chapters (30-80 files, 20-50K tokens) | Relevant community summaries from affected chapters (3,000 tokens) | ~90% |
| Per-agent call average | ~15,000 tokens | ~2,000 tokens | ~87% |

**Per-convergence-round savings (change-actors scale):**

Without KG: ~30 agent calls × 15K tokens = 450K tokens/round.  
With KG: ~30 agent calls × 2K tokens = 60K tokens/round.  
Extrapolating to an 8-round convergence: ~3.6M → 480K tokens.

**For the ME/CFS 47-chapter corpus:** agent calls that need cross-chapter reasoning
currently scale with corpus size. With community summaries at L3/L4, they scale
with the number of relevant communities (typically 1-3), not total file count.

### 10.1 Maintenance Cost

The KG has three cost drivers, all minimal:

| Cost | Frequency | What | Estimate |
|------|-----------|------|----------|
| Parse | Every `nix build` | Java regex over `.typ` files — zero API calls | ~2 sec CPU time, $0 |
| Community detection | Every `nix build` | Leiden clustering (deterministic, in-memory) | ~0.5 sec CPU time, $0 |
| Community summaries | Gated on membership changes | Haiku-tier LLM call per changed L2/L3 community (500 input + 100 output tokens) | <$0.001 per changed community |

A typical edit changes 1-3 L2 communities. At deepseek-v4-flash pricing, that's
under $0.003 per build. For comparison, one Sonnet review-agent call without the
KG burns $0.15-0.40 — two orders of magnitude more. The KG's maintenance cost is
below the noise floor of the savings it generates.

---

## 11. Nix Build Integration

```
flake.nix
│
├── ivp-graph derivation
│   └── produces: result/ivp-graph.json + community-summaries/
│
├── me/cfs-graph derivation
│   └── produces: result/mecfs-graph.json + community-summaries/
│
└── default package
    └── symlinkJoin of: all PDFs + both graph.json files
```

Community summaries are regenerated on any source change (deterministic — Leiden
clustering is seeded). The LLM-generated summaries are cached per commit hash.

---

## 12. File Layout

```
ops/graph/                              # in ivp-book-series (build pipeline)
  KnowledgeGraphPreprocessor.java       # Phases 1-6, project-configurable
  KnowledgeGraphQuery.java              # JGraphT CLI, multi-project
  GraphContextBuilder.java              # Agent prompt assembler (Tier 1)
  GraphRater.java                       # Two-tier relevance filter (Haiku)
  graph-schema-ivp.json                 # IVP node/edge schema
  graph-schema-mecfs.json               # ME/CFS node/edge schema
  project-config-ivp.yaml               # Label regexes, edge rules for IVP
  project-config-mecfs.yaml             # Label regexes, edge rules for ME/CFS
  kg-design.md                          # This file

llm-harness-plugins/knowledge-graph/    # plugin repo (agent integration)
  .claude-plugin/plugin.json            # Claude Code marketplace manifest
  hooks/hooks.json                      # Claude Code session-start hooks
  opencode/index.ts                     # OpenCode plugin shim (~150 LOC)
  pi/index.ts                           # Pi plugin shim (~100 LOC)
  bin/kg-context                        # CLI runner (Nix symlink to Java)
  config/project-config-ivp.yaml        # symlink or copy from ops/graph/
  config/project-config-mecfs.yaml      # symlink or copy from ops/graph/
  build/classes/eu/infolead/llmhp/graph/  # compiled Java (committed)
    GraphCli.java                       # Unified command dispatcher
    GraphPreprocessor.java              # Phases 1-6
    GraphQueryEngine.java               # JGraphT queries
    CommunityDetector.java              # Leiden + summaries
    GraphContextBuilder.java            # Prompt context assembly
    types/*.java                        # Node, Edge, Graph records
```

## 13. Implementation Sequence

1. Build the Java preprocessor (Phases 1-6) in `ops/graph/` — parse IVP `.typ` files, produce `graph.json`. (~600 LOC Java)
2. Build `GraphQueryEngine.java` with JGraphT — topo-sort, transitive-closure, cycles, centrality.
3. Add Leiden clustering + Haiku-level community summary generation (Phases 7-8).
4. Write the OpenCode plugin shim (`opencode/index.ts`) — `session.created`, `file.edited`, `tool.execute.after`, `kg-query` tool. Follow `agentmem` pattern exactly. (~150 LOC TypeScript)
5. Write the Pi plugin shim (`pi/index.ts`). (~100 LOC)
6. Write the Claude Code hooks + slash command (`hooks/hooks.json` + `commands/`).
7. Register all three plugin entry points in `opencode.json`, Pi config, and marketplace.
8. Measure: run one review-convergence cycle with vs. without KG context injection. Compare token counts and finding quality.
9. Port to ME/CFS — define label regexes, node/edge types via project config yaml, no code changes needed.
