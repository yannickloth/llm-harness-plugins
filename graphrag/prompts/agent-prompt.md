# GraphRAG Semantic Index

Semantic layer over the corpus: LLM-extracted entities/relationships, community
summaries, vector search. Complements the structural `kg-query` tool.

## When to use which

| Question type | Tool |
|---------------|------|
| Structural: what depends on X, impact, cycles, topo order | `kg-query` (free, exact) |
| Semantic: themes, concepts, "what does the corpus say about X" | `graphrag` mode=local |
| Corpus-wide: "summarize the treatment of Y across volumes" | `graphrag` mode=global |
| Hybrid: follow a concept through communities | `graphrag` mode=drift |

## Usage

```
graphrag mode=local query="how does the partition theorem relate to driver analysis"
graphrag mode=global query="what are the main themes of volume 1 part 2"
graphrag mode=status
graphrag mode=index
```

Query results carry a staleness prefix. STALE or VERSION MISMATCH prefixes mean
answers may lag the source — verify against current files before relying on them.

Index builds/updates run in the background; they never block tool execution.
Auto-update fires on session idle when the dirty-set is non-empty.
