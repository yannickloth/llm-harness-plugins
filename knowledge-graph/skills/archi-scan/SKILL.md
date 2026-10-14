---
name: archi-scan
description: Analyze the current knowledge-graph project into a navigable architecture doc-tree (.kg/perspectives/ with an overall-architecture perspective plus per-element folders carrying description, diagram.mmd, context), then persist your annotations (constraint/concern/todo/note, contradicts/generalizes/consistent_with edges) back into graph.json. omm-style doc conventions, native to the knowledge-graph plugin. USE FOR: architecture documentation, onboarding docs, dependency/impact maps, staleness audits after refactors or graph rebuilds. NOT FOR: one-off diagrams (use archi-diagram), runtime tracing, semantic vector search (use graphrag).
compatibility: Requires the knowledge-graph plugin (its kg-query tool or compiled Java at knowledge-graph/build/classes)
---

# archi-scan — architecture doc-tree

Turn the knowledge graph into a maintained architecture doc-tree. The tree under
`.kg/perspectives/` is the durable, git-trackable source of human- and
agent-authored annotations; `graph.json` stays a build artifact. `<plugin-dir>`
below is the concrete knowledge-graph path injected into your context at session
start.

## Workflow

1. **Ensure a graph.** If `graph.json` is missing in the project root and the
   project has a parser config (Typst label conventions), build it:

       java --class-path <plugin-dir>/build/classes eu.infolead.llmhp.graph.GraphCli parse . <plugin-dir>/config/project-config-<project>.yaml

   If no parser applies, stop and tell the user archi-scan needs a parse config for
   this project.

2. **Get the lay of the land.** `kg-query overview`, and `kg-query rate <task>`
   when the user gave a focus area.

3. **Export the skeleton:**

       java --class-path <plugin-dir>/build/classes eu.infolead.llmhp.graph.GraphCli perspectives graph.json .kg/perspectives [max-elements]

   Writes `overall-architecture/` (description.md, diagram.mmd, context.md) and
   `elements/<label>/` (description.md with frontmatter, diagram.mmd, context.md).
   Elements are the highest-degree nodes; raise max-elements for wider coverage.

4. **Enrich.** For each element dir: read its `context.md`, `diagram.mmd`, and
   the anchored source files (frontmatter `files:`), then fill `description.md`:
   - body: what it does, why it exists, its invariants
   - frontmatter: `constraint:` / `concern:` / `todo:` / `note:` (single-line)
   - relation lines: `contradicts:` / `generalizes:` / `consistent_with:` —
     comma-separated labels; both endpoints must exist in the graph
   Nesting is allowed: add your own sub-perspectives or hand-author new element
   dirs for nodes the export skipped. Any dir whose description.md has a
   `label:` frontmatter is an element; the merge walks the tree recursively.

5. **Persist annotations into the graph:**

       java --class-path <plugin-dir>/build/classes eu.infolead.llmhp.graph.GraphCli merge-annotations graph.json .kg/perspectives

   Writes node properties and `contradicts`/`generalizes`/`consistent_with`
   edges (origin `archi-scan`) into graph.json in place. Warnings list stale
   labels and dangling relation targets — fix or delete those dirs.
   Re-running `parse` regenerates graph.json WITHOUT annotations; re-run
   merge-annotations after every rebuild. The tree is the durable source.

6. **Audit staleness** (after refactors or graph rebuilds):

       java --class-path <plugin-dir>/build/classes eu.infolead.llmhp.graph.GraphCli audit-tree graph.json .kg/perspectives

   Reports stale labels (node vanished from the graph), missing file anchors,
   and dangling relation targets.

7. **Optional polish.** Hand `overall-architecture/diagram.mmd` and element
   diagrams to the `diagram-design` skill (graphics-toolkit) for branded
   HTML/SVG/PNG. Strictly optional — skip if graphics-toolkit is not installed.

## Prefer tools over shell

If `kg-query` is a registered tool, use verbs (`overview` via injected context,
`diagram <label> [depth]`, `community-summary <label>`, `impact <label>`)
instead of Bash. The Java commands above are the CLI fallback.
