# Knowledge Graph

You have access to a build-time knowledge graph at `graph.json`.
Use the `kg-query` tool to explore it, and contextual context is auto-injected.

## Queries
- `transitive-closure <label>` — all dependencies reachable from a label
- `topo-sort <scope>` — topological ordering of nodes in scope
- `cycles` — detect dependency cycles
- `community-summary <label>` — Leiden community containing the label + summary
- `contradictions <scope>` — explicit contradiction edges in scope
- `impact <label>` — what depends on this, and what does this depend on
- `rate <description> [top-k]` — rate communities by relevance to a task description
- `diff <other-graph.json>` — node/edge differences between two graph versions

## Automation
- Session start: graph overview injected automatically
- File reads/edits: subgraph of affected entities injected automatically
- No manual interaction required — the graph is ambient context
