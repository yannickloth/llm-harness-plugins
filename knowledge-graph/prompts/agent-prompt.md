# Knowledge Graph

A build-time knowledge graph at `graph.json` is available.
File-scope context auto-injected on reads/edits — no action needed.

## Querying the graph

If `kg-query` is in your tool list, call it directly with one of:
- `transitive-closure <label>` — all dependencies reachable from a label
- `topo-sort <scope>` — topological ordering of nodes in scope
- `cycles` — detect dependency cycles
- `community-summary <label>` — Leiden community containing the label + summary
- `contradictions <scope>` — explicit contradiction edges in scope
- `impact <label>` — what depends on this, and what does this depend on

If `kg-query` is NOT a tool, fall back to:

    java --class-path <plugin-dir>/build/classes eu.infolead.llmhp.graph.GraphCli query graph.json "<query> [scope]"

## Diagnostic commands (via Bash)

    java --class-path <plugin-dir>/build/classes eu.infolead.llmhp.graph.GraphCli quality graph.json
    java --class-path <plugin-dir>/build/classes eu.infolead.llmhp.graph.GraphCli validate graph.json
