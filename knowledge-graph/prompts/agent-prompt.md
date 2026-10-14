# Knowledge Graph

The knowledge-graph plugin is active. When a build-time graph exists at
`graph.json`, file-scope context is auto-injected on reads/edits and the project
overview is injected at session start. When there is no `graph.json` yet, create
one first: a deterministic `parse`, or an LLM-authored `overlay.json` (see below).

## Querying the graph

If `kg-query` is in your tool list, call it directly with one of:
- `transitive-closure <label>` — all dependencies reachable from a label
- `topo-sort <scope>` — topological ordering of nodes in scope
- `cycles` — detect dependency cycles
- `community-summary <label>` — Leiden community containing the label + summary
- `contradictions <scope>` — explicit contradiction edges in scope
- `impact <label>` — what depends on this, and what does this depend on
- `diagram <label> [depth]` — Mermaid flowchart of the N-hop neighborhood

If `kg-query` is NOT a tool, fall back to the CLI (one token per argument):

    java --class-path <plugin-dir>/build/classes eu.infolead.llmhp.graph.GraphCli query graph.json <query> [scope]
    # e.g.  ... query graph.json topo-sort ch:06

## Architecture doc-tree (archi-scan / archi-diagram skills)

- `archi-scan` — build/enrich/audit a `.kg/perspectives/` doc-tree and persist your
  annotations (constraint/concern/todo/note, contradicts/generalizes/consistent_with)
  into graph.json. Use for architecture docs and impact maps.
- `archi-diagram` — extract a Mermaid diagram for one element, optionally redraw via
  the diagram-design skill (graphics-toolkit).

CLI commands these wrap: `perspectives <graph> <out-dir>`, `merge-annotations <graph> <tree-dir>`,
`audit-tree <graph> <tree-dir>`, `diagram <graph> <label> [depth]`.

## LLM-authored graph overlay

When no deterministic parser covers the sources (e.g. a code repo with no parse
config), you may extract the graph yourself as `overlay.json` — a JSON file with
`nodes` and `edges` (same shape as graph.json, optional top-level `origin`,
default `llm`):

    java --class-path <plugin-dir>/build/classes eu.infolead.llmhp.graph.GraphCli validate-overlay overlay.json
    java --class-path <plugin-dir>/build/classes eu.infolead.llmhp.graph.GraphCli merge-overlay graph.json overlay.json

`merge-overlay` merges the overlay over the base graph (both optional; a missing
base starts empty), stamps `origin` provenance, and auto-creates nodes for
relation endpoints that were not declared. Re-run after a deterministic `parse`
if the base changed.

## Diagnostic commands (via Bash)

    java --class-path <plugin-dir>/build/classes eu.infolead.llmhp.graph.GraphCli quality graph.json
    java --class-path <plugin-dir>/build/classes eu.infolead.llmhp.graph.GraphCli validate graph.json
