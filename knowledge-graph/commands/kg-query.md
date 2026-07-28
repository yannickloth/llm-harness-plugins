---
description: Query the knowledge graph — transitive-closure, topo-sort, cycles, community-summaries, contradictions, impact, quality, validate
argument-hint: [query]
allowed-tools: Bash(java:*)
---

Run: `java --class-path ${CLAUDE_PLUGIN_ROOT}/build/classes eu.infolead.llmhp.graph.GraphCli query "${CLAUDE_PROJECT_DIR}/graph.json" "$1"`
Review and report.
