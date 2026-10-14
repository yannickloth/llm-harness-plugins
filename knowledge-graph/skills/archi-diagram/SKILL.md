---
name: archi-diagram
description: Extract a Mermaid architecture diagram for one element (node label or source file) from the knowledge graph, then optionally redraw it as a branded HTML/SVG/PNG via the diagram-design skill. USE FOR: one-off architecture or dependency diagrams, impact visualizations, Mermaid sources for graphics-toolkit. NOT FOR: full doc-tree scans (use archi-scan), non-graph diagrams, runtime sequence tracing.
compatibility: Requires the knowledge-graph plugin (its kg-query tool or compiled Java at knowledge-graph/build/classes)
---

# archi-diagram — one element → Mermaid → (optional) redraw

`<plugin-dir>` is the concrete knowledge-graph path injected into your context at
session start.

1. **Pick the target.** A node label (`thm:knowledge-theorem`) or a source file
   path. If unsure, use `kg-query overview` / `kg-query community-summary <label>`
   to find it.

2. **Extract.**
   - tool path: `kg-query` with query `diagram <label> [depth]`
   - CLI fallback:

         java --class-path <plugin-dir>/build/classes eu.infolead.llmhp.graph.GraphCli diagram graph.json <label> [depth]

   Output is a Mermaid `flowchart LR` block — the N-hop bidirectional
   neighborhood (default depth 1), capped at 40 nodes with a truncation comment.

3. **Deliver.**
   - quick look: paste the block into the reply (GitHub and mermaid.live render it)
   - file: save as `<element>.mmd`
   - branded output: hand the `.mmd` to the `diagram-design` skill
     (graphics-toolkit) to redraw as HTML/SVG/PNG — optional, skip silently if
     graphics-toolkit is not installed.
