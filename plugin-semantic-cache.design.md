# Semantic Cache — Design Document

OpenCode plugin that caches agent prompt-response pairs using local embedding and cosine-distance lookup. No LLM API calls — embedding is done locally via character n-gram hashing. Reduces duplicate LLM spend by 15–30% for near-duplicate coding-agent prompts.

## Architecture

```
Prompt context (when agent runs cache-lookup tool)
    │
    ▼
┌──────────────────────────────────────────────────────────────┐
│ OpenCode tool: cache-lookup (opencode/index.ts)              │
│  Calls SemanticCacheCli lookup → if hit, returns             │
│  the cached response + staleness warning as tool output.     │
└──────────────────────────────────────────────────────────────┘
    │ (miss → normal execution)
    ▼
┌──────────────────────────────────────────────────────────────┐
│ Write/Edit outcomes (via cache-store tool)                   │
│   - cache-store: store prompt-response pair                  │
│   - cache-invalidate-files: invalidate entries referencing   │
│     the file that was written/edited                         │
└──────────────────────────────────────────────────────────────┘
    │
    ▼
┌──────────────────────────────────────────────────────────────┐
│ Java 25 Core: Embedder + CacheStore                           │
│                                                              │
│  Embedder.embed(text) → 384-dim float vector                 │
│    (character 2–4-gram hashing, deterministic, zero-cost)     │
│                                                              │
│  CacheStore.lookup(prompt) → cosine-similarity scan           │
│    → best match ≥ 0.85 threshold → hit                        │
│    → else → miss                                              │
│                                                              │
│  CacheStore.store(prompt, response) → WAL atomic write        │
│    (temp → FileChannel.force → ATOMIC_MOVE)                  │
│    → evict if entries > maxEntries (LRU by timestamp)         │
│                                                              │
│  CacheStore.invalidate(prompt) → delete by hash key           │
│  CacheStore.invalidateAll() → delete all .json files          │
│  CacheStore.stats() → hit/miss/eviction/entry count           │
└──────────────────────────────────────────────────────────────┘
    │
    ▼
┌──────────────────────────────────────────────────────────────┐
│ Storage: .agentmem/cache/                                    │
│                                                              │
│  <hash>.json  — per-entry JSON with Base64-encoded           │
│                 prompt/response for newline safety           │
│  .tmp/        — temp files for WAL atomic writes              │
└──────────────────────────────────────────────────────────────┘
    │
    ▼
┌──────────────────────────────────────────────────────────────┐
│ InvalidationEngine                                           │
│                                                              │
│  invalidateForFiles(changedFiles)                             │
│    → loads all entries, checks if prompt contains filename    │
│    → deletes matching entries                                 │
│                                                              │
│  invalidateStale(maxAgeSeconds)                              │
│    → deletes expired entries or unparseable files             │
│    → runs at session start                                    │
└──────────────────────────────────────────────────────────────┘
```

## File Structure

```
semantic-cache/
├── src/main/java/eu/infolead/llmhp/cache/
│   ├── SemanticCacheCli.java     # CLI: lookup, store, invalidate, stats (--cache-dir flag)
│   ├── CacheStore.java           # Write: embed → store; Read: embed → lookup
│   ├── Embedder.java             # Local char n-gram hashing (384-dim)
│   ├── InvalidationEngine.java   # File-change-based invalidation
│   └── types/
│       ├── CacheEntry.java       # Record: key, prompt, response, embedding, timestamp, ttl
│       ├── CacheStats.java       # Record: hits, misses, evictions, entryCount, totalSizeBytes
│       └── Embedding.java        # Record: float[] vector, dimension + cosineSimilarity
├── src/test/java/eu/infolead/llmhp/cache/
│   └── SemanticCacheTest.java    # 27 test cases across 14 test methods
├── opencode/index.ts             # OpenCode: 3 tools (cache-lookup, cache-store, cache-stats) with --cache-dir and worktree support
├── prompts/agent-prompt.md       # Agent-facing usage guide
```

## Embedding

### Mechanism

Local character n-gram hashing — no ONNX runtime, no model download, no API call. Deterministic and zero-cost.

```
Embedder.embed(text):
  1. Compute 2–4 character n-grams from input text
  2. Hash each n-gram to a bucket via deterministic PRNG
     (long seed = polynomial hash of n-gram chars)
  3. Accumulate weighted counts (1.0/n for n-gram length n)
  4. L2-normalize the 384-dim vector
```

### Design Rationale

- **Zero infrastructure:** No ONNX, no model files, no extra dependencies
- **Deterministic:** Same prompt → same embedding every time
- **Semantically meaningful:** Similar n-gram patterns → similar vectors; bag-of-n-grams captures overlap
- **O(n) time, O(1) memory:** Single pass over characters, fixed 384-float output

### Parameters

| Parameter | Value | Rationale |
|-----------|-------|-----------|
| `DIMENSION` | 384 | Balances hash collision rate vs storage size (~1.5KB per vector in serialized form) |
| `NGRAM_MIN` | 2 | Minimum n-gram length — catches "if", "re", "ed" etc. |
| `NGRAM_MAX` | 4 | Maximum — catches "read", "edit", "file" |

## CacheStore

### Core Operations

| Operation | Signature | Behavior |
|-----------|-----------|----------|
| `lookup` | `(String prompt) → LookupResult` | Embed prompt, scan all entries for best cosine match ≥ threshold, skip expired entries |
| `store` | `(String prompt, String response)` | Embed prompt, hash key, serialise entry as JSON, WAL-atomic write, evict if needed |
| `invalidate` | `(String prompt)` | Compute hash key, delete corresponding `.json` file |
| `invalidateAll` | `()` | Delete all `.json` files in cache dir |
| `stats` | `() → CacheStats` | Count entries, sum file sizes |
| `entryCount` | `() → int` | Number of valid entries |

### Configuration

| Parameter | Default | Description |
|-----------|---------|-------------|
| `threshold` | 0.85 | Minimum cosine similarity for cache hit |
| `ttlSeconds` | 86,400 (24h) | Entry TTL — checked against Instant.now() |
| `maxEntries` | 10,000 | Maximum entries before LRU eviction (by timestamp) |

### Serialization Format

Per-entry JSON files with Base64-encoded prompt/response to avoid newline-break bugs:

```json
{
  "key": "abc123",
  "prompt": "<base64-encoded UTF-8 prompt>",
  "response": "<base64-encoded UTF-8 response>",
  "embedding": "0.123,0.456,...,0.789",
  "timestamp": "2026-07-29T12:00:00Z",
  "ttlSeconds": 86400
}
```

### WAL Atomicity

Write pattern (reuses agentmem's pattern):
1. Serialize entry to temp file `.agentmem/cache/.tmp/<key>.<uuid>`
2. `FileChannel.force(true)` — flush to disk
3. `Files.move(tmp, target, ATOMIC_MOVE, REPLACE_EXISTING)` — atomic rename

### Eviction

Sorted by timestamp, oldest first, bulk-deleted in one pass:
```
excess = entries.size() - maxEntries
delete entries[0..excess]
```

Guard: `maxEntries <= 0` → skip eviction entirely (no infinite loop).

## InvalidationEngine

### Operations

| Operation | Trigger | Behavior |
|-----------|---------|----------|
| `invalidateForFiles` | Manual file-change signal | Loads all entries, checks if prompt text contains changed filename |
| `invalidateStale` | Session start | Deletes expired entries, unparseable entries, and IO-error entries |

File-change-based invalidation also runs after write/edit via `cache-invalidate-files` logic. Each file write/edit invalidates cache entries that reference the changed file by name.

### File Matching

Simple filename containment in prompt text: if cached prompt is "edit the file UserService.java to add logging" and `UserService.java` changed → invalidate. Uses `Path.getFileName().toString()` only (no full-path match to avoid false positives from short names matching substrings path components).

## CLI Interface

```
SemanticCacheCli <command> [--cache-dir <dir>] [args...]

Commands:
  lookup             Read prompt from stdin, print {"hit":true,"cached_response":"..."} or {"hit":false}
  store <prompt>     Read response from stdin, store pair
  invalidate <prompt> Delete entry by prompt hash
  invalidate-all     Delete all cache entries
  invalidate-stale [maxAge]  Remove expired entries (default: 24h TTL)
  invalidate-files <paths...>  Remove entries referencing changed files
  stats              Print CacheStats as JSON

Flag:
  --cache-dir <dir>  Override default .agentmem/cache cache location
```

## OpenCode Integration

`opencode/index.ts` registers 3 tools:
- `cache-lookup` — check prompt in cache (calls `SemanticCacheCli lookup --cache-dir`)
- `cache-store` — store a prompt-response pair (calls `SemanticCacheCli store --cache-dir`)
- `cache-stats` — get cache statistics (calls `SemanticCacheCli stats --cache-dir`)

Uses `Bun.spawn` with `.quiet()` for silent execution. Resolves cache directory from `worktree` or `directory` plugin context so cache operates in the project's `.agentmem/cache`, not CWD.

## IVP Analysis

| Component | Change Driver | Artifact |
|-----------|--------------|----------|
| Embedder | Embedding quality requirements | N-gram hashing algorithm, dimensionality trade-offs |
| CacheStore | Cache invalidation rules + freshness policy | File-change detection, TTL configuration |
| InvalidationEngine | Project file structure changes | File system watch events, git diff |
| CacheEntry / CacheStats | Data schema for cache storage | Serialization format requirements |
| opencode/index.ts | OpenCode plugin SDK | @opencode-ai/plugin |

**IVP Compliance:** Embedder varies independently from cache storage. Invalidation policy varies independently from embedding algorithm. The OpenCode backend varies independently. The shared Java core varies with caching logic only.

## Costs

Embedding: zero-cost (local computation, <1ms for typical prompts). Cache lookup: O(n) in number of entries (cosine scan), typically <10ms for 10,000 entries. Storage: ~3–10KB per entry (JSON + 384-float embedding).

Expected savings: 15–30% of coding-agent prompts are near-duplicates (same "what does this file do" questions, repeated error fix cycles).

## Reference

Book patterns: **Semantic Cache** (Pt IV, ch30). Integration targets per PLAN.md: pre-tier-router classification check, knowledge-graph subgraph caching.
