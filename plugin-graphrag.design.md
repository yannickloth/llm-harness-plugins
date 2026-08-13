# GraphRAG Plugin Design — MS GraphRAG Semantic Layer

Author: Yannick Loth
Status: Design document (current as of 2026-08-06)
Projects: ivp-book-series (first), health-me-cfs (later)
GraphRAG version pinned: 2.7.0 (via nixpkgs rev 68d8aa3d, flake.lock authority)

---

## 1. Philosophy

The knowledge-graph plugin builds a **deterministic structural graph**: labels,
references, includes, communities — all derivable from source by regex and graph
algorithms in ~2 seconds. It cannot do what requires semantic understanding:
extracting entities and relationships the author never labeled, summarizing
thematic communities, answering free-form questions over the whole corpus.

This plugin adds that layer. Microsoft GraphRAG (v2.7.0) is the indexing and
query engine. The plugin contributes what GraphRAG cannot do itself: turning a
Typst/LaTeX corpus into semantically-split input documents, wiring index
lifecycle into opencode sessions, and keeping the index fresh without user
intervention.

| Property | knowledge-graph | graphrag (this plugin) |
|----------|-----------------|------------------------|
| Change driver | Typst source structure, label conventions | GraphRAG upstream releases, LLM model availability/pricing |
| Derivation | Deterministic, build-time | LLM-extracted, stochastic |
| Latency | ~2 sec full parse | Minutes per index run (LLM-bound) |
| Update | Every build | Batched to session.idle, incremental |
| Cost | Zero | LLM tokens (cheap model) + local embeddings |
| Output | `graph.json` | `graph-index/` (parquet artifacts, gitignored) |

Two plugins, not one: different change-driver sets (IVP — separate units).
Composition, not merger: the exporter reuses knowledge-graph's parse pipeline
via classpath dependency. knowledge-graph source is never modified.

**Typst = authoritative. LaTeX = legacy.** Every exported document carries
`lang` + `authority` tags. Content present in both formats is exported once —
the `authority: primary` (Typst) version wins.

---

## 2. Architecture — Data Flow

```
.typ / .tex source files
    │
    ▼
┌─────────────────────────────────────────────────────┐
│ ExportCli (Java, deterministic, ~seconds)            │
│ ───────────────────────────────────────────────────  │
│ 1. Parse via knowledge-graph GraphPreprocessor       │
│    (classpath reuse: label inventory, include tree,  │
│     reference edges, structural context)             │
│ 2. Split into semantic blocks                        │
│    (section / theorem-environment granularity —      │
│     never blind fixed-size chunks)                   │
│ 3. Encode deterministic relations into text          │
│    ([PROOF cites: def:x, lem:y] markers)             │
│ 4. Deduplicate LaTeX blocks whose \label{X}          │
│    exists as <X> in Typst                            │
│ 5. Emit Markdown + YAML frontmatter                  │
└───────────────────┬─────────────────────────────────┘
                    │
                    ▼
        graph-index/input/*.md   (one doc per semantic block)
                    │
                    ▼
┌─────────────────────────────────────────────────────┐
│ graphrag index / update  (MS GraphRAG 2.7.0)         │
│ ───────────────────────────────────────────────────  │
│ extract_graph (cheap LLM, custom prompt)             │
│ summarize_descriptions (cheap LLM)                   │
│ cluster_graph (Leiden)                               │
│ community_reports (cheap LLM)                        │
│ extract_claims = covariates (cheap LLM)              │
│ embed_text (local embedding model)                   │
└───────────────────┬─────────────────────────────────┘
                    │
                    ▼
        graph-index/output/  (parquet artifacts, lancedb vectors)
                    │
                    ▼
┌─────────────────────────────────────────────────────┐
│ Plugin shim (opencode/index.ts)                      │
│ ───────────────────────────────────────────────────  │
│ tool `graphrag` mode=local|global|drift|status|index │
│ hooks: session.created / file.edited /               │
│        file.watcher.updated / session.idle           │
└─────────────────────────────────────────────────────┘
```

Index root: `<consumer-project>/graph-index/`. Gitignored. Never committed.

---

## 3. Environment Wiring — Version Authority

GraphRAG comes from nix. **flake.lock is the version-pinning authority** — it
commits the exact GraphRAG version next to the index it built.

| Layer | Role |
|-------|------|
| Consumer flake.nix devShell | Provides `graphrag` + `pandoc` (ivp-book-series: `pkgs.python312Packages.graphrag`) |
| Consumer .envrc | `use flake`; direnv activates on cd; `.envrc` committed (project policy) |
| Harness flake.nix + .envrc | Same nixpkgs rev as consumer → same graphrag version for plugin dev/test |
| home-manager install | Optional fallback for sessions outside any project dir. **Never the pinning authority.** direnv prepends devShell bin to PATH → project pin wins automatically when both exist |
| manifest.json | Records `graphrag_binary` (resolved path) + `graphrag_version` at index time |

**Version check:** at status/query time the shim compares current binary version
against manifest version. Match → proceed. Mismatch (flake.lock upgraded) →
warn + require explicit reindex. Never query an index built by a different
version silently.

**Binary resolution:** `graphrag_binary` in config (default `graphrag`) resolved
via PATH at session.created. Resolved path + version logged (one line). Absent →
inject one line: `graphrag not on PATH — start opencode from the project terminal
so direnv loads, or set graphrag_binary in config.`

**Pinning note:** nixpkgs rev 68d8aa3d ships graphrag 2.7.0 for python3.12. The
python3.13 attribute is broken at this rev (`future-1.0.0 not supported for
interpreter python3.13`) — both flakes use `python312Packages.graphrag`.

**Packaging workaround (recorded):** at rev 68d8aa3d, `python312Packages.pot`
fails its own test suite (5 failures — scipy removed `sokalmichener` etc. from
`scipy.spatial.distance`; pot 0.9.6 tests still call them). pot is a transitive
dep via graspologic. Both flakes carry a one-line overlay:
`pot.overridePythonAttrs (_: { doCheck = false; })`. Remove once the pinned
nixpkgs carries a fixed pot.

---

## 4. Exporter (Phase 1)

`ExportCli` — Java ≥ 25, compact source files, records, sealed types.

```
ExportCli <cmd> [args...]
Commands:
  export <project-root> <config-yaml> <out-dir> [--files <comma-separated-paths>]
  list-duplicates <project-root> <config-yaml>
```

`--files` restricts export to a dirty set (incremental re-export). Without it:
full corpus.

### 4.1 Splitting

| Source | Strategy |
|--------|----------|
| Typst | One document per environment call (`#theorem(...)[...]`, `#definition[...]`, `#proof[...]`, …) and per section heading prose block. Bracket-matching scanner over source; knowledge-graph parse supplies label inventory + line anchors |
| LaTeX | pandoc `.tex` → markdown, then split on `\section` and theorem-like environments (`\begin{theorem}…\end{theorem}` etc.) |

Never blind fixed-size chunks of raw source. GraphRAG's chunker is then set large
(`chunks.size: 16000`) so semantic blocks stay intact.

### 4.2 Relation Encoding

Deterministic relations from the structural graph are written into the text so
GraphRAG extraction recovers them as entities/relationships:

```
[THEOREM label=thm:partition]
[PROOF proves: thm:partition]                    (naming-convention inference: thm-X-proof.typ → thm:X)
[THEOREM cites: def:driver, lem:merge-split]     (@refs found in body)
[SECTION appears_in: vol:volume-1, ch:ch04]
```

### 4.3 Frontmatter

```yaml
---
id: vol1-ch04-thm-partition
doc: volume-1
lang: typst          # typst | latex
authority: primary   # primary | legacy
env: theorem         # theorem | proof | definition | prose | abstract | ...
labels: [thm:partition]
refs: [def:driver, def:gamma]
file: src/main/typst/volume-1/part2/ch04/sec-partition.typ
line: 42
---
```

GraphRAG's text loader reads the whole file (frontmatter included) as `text`,
sets `title` = filename, `id` = sha512(content). Frontmatter is visible to the
extractor — acceptable duplication of the relation markers, keeps metadata
queryable in artifacts.

### 4.4 Filenames — Incremental Update Contract

```
<doc-id>--<sha8-of-content>.md
```

Verified GraphRAG 2.7.0 incremental semantics (source: `incremental_index.py`,
`get_delta_docs`): delta detection compares **titles only** — and for text input,
title = filename. Content changes under a stable filename are **not** detected.

Consequence: dirty re-export deletes `<doc-id>--<old-hash>.md` and writes
`<doc-id>--<new-hash>.md`. GraphRAG `update` then sees one deleted document and
one new document, reprocesses only those, and merges into the existing index.
(To be confirmed empirically in the two-document experiment — §10.3.)

### 4.5 Deduplication

Typst label set `L = { all <label> attachments in .typ corpus }`. A LaTeX block
with `\label{X}` where `X ∈ L` is skipped — the Typst version is exported as
`authority: primary`. Remaining LaTeX-only blocks export as `authority: legacy`.
`list-duplicates` reports the skipped set for inspection.

### 4.6 Math

Theorem statements kept verbatim. Macro noise stripped (`\index{...}`,
`\label{...}`, comments, formatting directives). No linearization of complex math.

### 4.7 knowledge-graph Reuse

Classpath dependency on `knowledge-graph/build/classes`. Reuse = parse **artifact**
+ public IO API, not live re-parse:

| Capability | Use in exporter |
|------------|-----------------|
| `GraphQueryEngine.load(graph.json)` | Structural context per file via `appears_in` edges (volume/part/chapter/section) → `appears_in` markers |
| Node/Edge types | Classpath records from knowledge-graph |
| Label inventory + per-block refs | Exporter's own regex scans (finer granularity than graph.json's file-level edges) |

**Why not `GraphPreprocessor.process()` directly:** observed pathological runtime
on the grown corpus (8,878 .typ files — run aborted after >90 s; suspect
O(n²)-class phases: `phase5NamedRelations` pairwise scan, `addDefinesEdges`
unmemoized include-closure recursion). Loading the committed `graph.json`
(29 MB, 20,029 nodes) takes ~1 s. knowledge-graph source untouched.
If `graph.json` is absent, structure falls back to path-derived context.

---

## 5. Index/Update Runner (Phase 2)

`IndexCli` — Java, same package. Chosen over shell-free-in-shim: lockfile,
manifest, and promotion logic need atomic file operations and testability.

```
IndexCli <cmd> [args...]
Commands:
  init <project-root> <config-yaml>      # export → settings.yaml → graphrag index
  update <project-root> <config-yaml>    # dirty re-export → graphrag update → promote
  status <project-root>                  # manifest state report
```

### 5.1 init

1. Run exporter (full corpus) → `graph-index/input/`.
2. Generate `graph-index/settings.yaml` (§5.4) + copy custom prompts.
3. `graphrag index --root graph-index/ --config graph-index/settings.yaml`.
4. Write manifest.

### 5.2 update

1. Read dirty-set from manifest.
2. Re-export only dirty documents (delete old hash-named files, write new).
3. `graphrag update --root graph-index/ --config graph-index/settings.yaml`
   (verified: `update` is a separate command in 2.7.0, not `index --update`;
   merged output lands in `update_output/`).
4. Promote `update_output/` → `output/` (query reads `output/`).
5. Rewrite manifest (new commit, timestamp, empty dirty-set).

### 5.3 Manifest + Lockfile

`graph-index/manifest.json`:

```json
{
  "commit": "abc123…",
  "timestamp": "2026-08-06T00:30:00Z",
  "graphrag_version": "2.7.0",
  "graphrag_binary": "/nix/store/…-python3.12-graphrag-2.7.0/bin/graphrag",
  "dirty": ["src/main/typst/volume-1/part2/ch04/sec-partition.typ"]
}
```

Lockfile `graph-index/.lock` (O_EXCL create; stale-lock detection by age + pid).
Prevents parallel index/update runs. All index jobs background-only — tool
execution never blocks on them.

### 5.4 settings.yaml Generation

Generated by IndexCli from plugin config — models never hardcoded. Custom
prompts live in `graphrag/prompts/` and are copied into `graph-index/prompts/`.

Verified schema fields (GraphRAG 2.7.0, `init_content.py` + config models):

```yaml
models:
  default_chat_model:          # extraction, summarization, claims, community reports
    type: chat
    model_provider: openai     # LiteLLM prefix — openrouter/<model> naming works
    auth_type: api_key
    api_key: ${OPENROUTER_API_KEY}
    model: openrouter/deepseek/deepseek-v4-flash
    model_supports_json: true
  default_embedding_model:     # see §9 — embedding question
    type: embedding
    model_provider: ollama
    auth_type: api_key
    api_key: ${GRAPHRAG_API_KEY}
    model: nomic-embed-text
    api_base: http://localhost:11434

input:
  storage: { type: file, base_dir: input }
  file_type: text
  file_pattern: ".*\\.md$"

chunks: { size: 16000, overlap: 100, group_by_columns: [id] }

extract_graph:
  model_id: default_chat_model
  prompt: prompts/extract_graph.txt
  entity_types: [theorem, definition, lemma, axiom, principle, concept,
                 notation, paper, author, pattern, verdict]
summarize_descriptions: { model_id: default_chat_model, prompt: prompts/summarize_descriptions.txt }
cluster_graph: { max_cluster_size: 10 }
community_reports:
  model_id: default_chat_model
  graph_prompt: prompts/community_report_graph.txt
  text_prompt: prompts/community_report_text.txt
extract_claims:                # covariates
  enabled: true
  model_id: default_chat_model
  prompt: prompts/extract_claims.txt
  description: "Rule-violation claims: driver-ranking language, 'subsume' usage, IVP violations."
embed_text: { model_id: default_embedding_model, vector_store_id: default_vector_store }
vector_store:
  default_vector_store: { type: lancedb, db_uri: lancedb, container_name: default }
output: { type: file, base_dir: output }
update_index_output: { type: file, base_dir: update_output }
cache: { type: file, base_dir: cache }
reporting: { type: file, base_dir: logs }
```

Custom prompt content:

| Prompt | Customization |
|--------|---------------|
| extract_graph.txt | Entity types above; relationship types: proves, uses, defines, extends, formalizes, contradicts, cites, diagnoses; instruction to preserve `[THEOREM label=…]` / `[PROOF cites: …]` markers as relationships |
| extract_claims.txt | Covariate focus: rule-violation claims (driver-ranking language, "subsume" usage, IVP rule violations) |
| community_report_*.txt | Summaries enabled; emphasize theorem-dependency structure and verdicts |

### 5.5 Verified CLI Surface (GraphRAG 2.7.0)

Verified against source tag v2.7.0 (not documentation memory); to be re-verified
against the installed binary in step 0:

```
graphrag init    [--root/-r DIR] [--force/-f]
graphrag index   [--config/-c F] [--root/-r DIR] [--method/-m standard|fast]
                 [--verbose] [--dry-run] [--cache/--no-cache]
                 [--skip-validation] [--output/-o DIR]
graphrag update  [--config/-c F] [--root/-r DIR] [--method/-m standard-update|fast-update]
                 [--verbose] [--cache/--no-cache] [--skip-validation] [--output/-o DIR]
graphrag query   --method/-m local|global|drift|basic --query/-q TEXT
                 [--config/-c F] [--data/-d DIR] [--root/-r DIR]
                 [--community-level N] [--response-type TEXT]
                 [--streaming/--no-streaming] [--dynamic-community-selection]
graphrag prompt-tune ...
```

`graphrag init` writes settings.yaml + .env + 14 prompt templates. IndexCli does
not use `init` — it generates settings.yaml itself and ships its own prompts.

---

## 6. Plugin Shim (Phase 3)

`graphrag/opencode/index.ts` — thin, same pattern as knowledge-graph shim.

### 6.1 Tool Surface

One tool, mode argument — keeps context cost minimal:

```
graphrag mode=local|global|drift|status|index query="..."
```

| Mode | Action |
|------|--------|
| local | `graphrag query --method local` — entity-focused retrieval |
| global | `graphrag query --method global` — community-report map-reduce |
| drift | `graphrag query --method drift` — hybrid local+global |
| status | Manifest state: commit, age, dirty count, graphrag version, version-match verdict |
| index | Trigger init or update in background (non-blocking); returns "started" |

Query results prefixed with staleness state from manifest:
`[graphrag index: fresh @ abc1234, 2h ago]` or `[graphrag index: STALE, 3 files changed since abc1234]`.

Version check before every query: binary version ≠ manifest version → refuse
with reindex instruction.

### 6.2 Hooks

| Hook | Behavior |
|------|----------|
| session.created | Resolve binary (path + version, one log line). Read manifest. Stale/missing → inject one line: `GraphRAG index stale: N files changed since <commit>`. Binary absent → inject the §3 guidance line. Nothing more — no overview dump |
| file.edited | Add changed `.typ`/`.tex` path to dirty-set (manifest). Exclude: `result/`, `.git/`, `graph-index/`, `tmp/`, build artifacts — otherwise updates retrigger the watcher |
| file.watcher.updated | Same as file.edited |
| session.idle | If auto-update enabled + dirty-set non-empty + debounce elapsed → launch `IndexCli update` detached (background, non-blocking), guarded by lockfile |

### 6.3 Config

`graphrag/config/graphrag.yaml`:

```yaml
auto_update: true
debounce_seconds: 300
graphrag_binary: graphrag      # override for frozen pins / non-direnv setups
index_root: graph-index
models:
  chat_model: openrouter/deepseek/deepseek-v4-flash
  chat_api_key_env: OPENROUTER_API_KEY
  embedding_provider: ollama
  embedding_model: nomic-embed-text
  embedding_api_base: http://localhost:11434
projects:
  - root: /home/nicky/code/ivp-book-series
    knowledge_graph_config: <harness>/knowledge-graph/config/project-config-ivp.yaml
    typst_authority: primary
```

---

## 7. Update Model — Two Speeds

| Speed | Trigger | What | Cost |
|-------|---------|------|------|
| Structural | Every change (existing knowledge-graph behavior) | Deterministic reparse → graph.json | ~2 sec, zero tokens |
| Semantic | session.idle, batched, dirty-files only | Exporter re-export of dirty docs → `graphrag update` → promote | LLM tokens for changed blocks only |

Dirty-set accumulates in manifest during the session. Idle update fires once per
idle window (debounce). Lockfile prevents overlap with manual `index` mode.

---

## 8. Cost Model

Extraction, summarization, claims/covariates, community reports: cheap model
(deepseek-v4-flash or a free OpenRouter model). Calibration gate (§11) before
full indexing.

| Operation | Model | Estimated cost |
|-----------|-------|----------------|
| Full index (~20K semantic blocks) | cheap chat | Calibration sample extrapolates; gate decides |
| Incremental update (1 edited file, ~1–5 blocks) | cheap chat | Negligible (LLM cache enabled for unchanged content) |
| Embeddings | local (ollama) | Zero API cost |
| local/drift query | embedding + cheap chat reduce | ~cents |
| global query | cheap chat map-reduce over community reports | ~cents |

Credentials from environment variables only. Never in config files, never committed.

---

## 9. Embedding Model — Resolved (2026-08-06)

GraphRAG requires embeddings. **OpenRouter serves no embedding models** — it
routes chat completions only.

**Resolution:** llmster (LM Studio headless daemon, `lm-studio.service` user
service) already runs on this machine at `http://localhost:1234/v1` with an
OpenAI-compatible `/v1/embeddings` endpoint. Verified: nomic-embed-text-v1.5
returns 768-dim vectors. Zero cost, no keys, already present.

Settings: `model_provider: openai`, `api_base: http://localhost:1234/v1`,
`model: text-embedding-nomic-embed-text-v1.5`, api_key = any non-empty env var
(LM Studio accepts anything). LiteLLM passes api_base through — verified in
GraphRAG 2.7.0 source (`litellm/embedding_model.py`).

Available locally (fallbacks): mxbai-embed-large (1024-dim), snowflake-arctic-
embed-m-v1.5, embeddinggemma-300m. Cloud fallback if quality disappoints:
OpenAI text-embedding-3-small (~$0.40 per full-corpus index).

**Runtime dependency:** llmster must be running for index/query. Shim reports
embedding-endpoint failure in index logs; `status` mode does not check it
(keep cheap). Ollama uninstalled on this machine — do not reintroduce.

---

## 10. Verified GraphRAG 2.7.0 Behavior

All items verified against source tag v2.7.0. Items marked ⚠ re-verified against
the installed binary in step 0.

### 10.1 CLI

See §5.5. Key facts: `update` is a separate command (not `index --update`).
Update methods: `standard-update`, `fast-update`. Update output lands in
`update_output/` (config: `update_index_output.base_dir`).

### 10.2 Input Format

Text loader: whole file content → `text` column (frontmatter included).
`title` = filename. `id` = sha512(content). `file_pattern` = regex over
filenames. Missing `file_pattern` default matches all files.

### 10.3 Incremental Semantics ⚠ (empirical confirmation folded into calibration)

`get_delta_docs` diffs **titles only**:

- New document = input filename absent from previous `final_documents.title`.
- Deleted document = previous title absent from current input dir.
- **Modified content under unchanged filename = NOT detected.**

Design consequence: hash-suffixed filenames (§4.4). Empirical confirmation runs
as part of the calibration sample index (§11): index sample → modify one
document under a new filename → `graphrag update` → inspect whether old entities
are pruned and new ones added. Result recorded here.

### 10.4 Config/Env

`.env` at index root auto-loaded. `${VAR}` expansion in settings.yaml via
`string.Template.substitute(os.environ)` — **consequence:** any literal `$` in
settings.yaml must be doubled (`$$`). Affects `file_pattern` regex anchors
(`".*\\.md$$"`). Verified in `load_config.py:67`. LiteLLM provider layer: chat
+ embedding calls carry api_base/api_key through.

**No `--version` flag** in 2.7.0 CLI. Version probe:
`python3 -c "from importlib.metadata import version; print(version('graphrag'))"`
with store-path regex fallback (`graphrag-(\d+\.\d+\.\d+)`).

**NumPy 2.0 incompatibility** in graphrag 2.7.0: `np.float_` in
`prompt_tune/loader/input.py` (imported at CLI startup). Patched via flake
overlay (`sed np.float_ → np.float64`). Recorded in §3.

---

## 11. Calibration (Phase 4)

Procedure:

1. Export full corpus (cheap, deterministic) — validates exporter at scale.
   **Done 2026-08-06:** 36,121 documents (28,165 typst/primary, 7,956
   latex/legacy), 2,730 duplicate LaTeX chunks skipped, 2 m 26 s runtime.
   Env distribution: 18,044 section, 8,282 prose, 1,917 definition, 1,586
   proof, 1,570 solution, 969 key-insight, 933 remark, 788 theorem, 730
   example, 361 observation, 275 corollary, 257 proposition.
2. Index a sample: 2–3 papers only, with the candidate cheap model.
3. Inspect GraphRAG artifacts: entity quality (types, names, descriptions),
   relationship plausibility, community summary coherence, covariate hits.
4. Verdict recorded in §11.1: accepted → full index; rejected → next candidate.

**No full-corpus index during development. Sample only.**

### 11.1 Sample Selection

Coherent theorem unit from volume-1 ch05 (variation dependence):

```
src/main/typst/volume-1/part1/ch05/sec-01-dependencies-structural-and-variation/subsec-03-variation-dependence-revisited/claims/thm-variation-equivalence.typ
src/main/typst/volume-1/part1/ch05/sec-01-dependencies-structural-and-variation/subsec-03-variation-dependence-revisited/claims/thm-variation-equivalence-proof.typ
src/main/typst/volume-1/part1/ch05/sec-01-dependencies-structural-and-variation/subsec-03-variation-dependence-revisited/definitions/def-variation-dependence.typ   (if present; else sibling def file)
```

### 11.2 Runbook

```bash
# 0. enter direnv shell (graphrag + pandoc on PATH), from harness repo
cd llm-harness-plugins && direnv allow   # once

# 1. export sample into scratch index root
export OPENROUTER_API_KEY=<from opencode auth store — env only, never to file>
java --class-path graphrag/build/classes:knowledge-graph/build/classes \
  eu.infolead.llmhp.graphrag.ExportCli export \
  /home/nicky/code/ivp-book-series graphrag/config/graphrag.yaml \
  tmp/calibration-index --files "<comma-separated sample files>"

# 2. settings + prompts
java --class-path graphrag/build/classes:knowledge-graph/build/classes \
  eu.infolead.llmhp.graphrag.IndexCli init-sample \
  /home/nicky/code/ivp-book-series graphrag/config/graphrag.yaml \
  tmp/calibration-index graphrag

# 3. index (sample only)
graphrag index --root tmp/calibration-index --config tmp/calibration-index/settings.yaml

# 4. inspect artifacts
ls tmp/calibration-index/output/
# entities/relationships/community_reports parquet → spot-check

# 5. queries (after embedding backend resolved — §9)
graphrag query --method local  --query "what does the variation equivalence theorem state" \
  --root tmp/calibration-index --config tmp/calibration-index/settings.yaml
graphrag query --method global --query "what are the central concepts of variation dependence" \
  --root tmp/calibration-index --config tmp/calibration-index/settings.yaml

# 6. incremental experiment (§10.3): edit one sample .typ file, re-export
#    (new hash filename), graphrag update, inspect delta handling
```

### 11.3 Calibration Verdict

_(pending — recorded after sample index)_

---

## 12. Composition with knowledge-graph

| Concern | knowledge-graph | graphrag |
|---------|-----------------|----------|
| Session-start injection | Graph overview + agent prompt | One-line staleness state only |
| Per-file injection | 1-hop subgraph on read/edit | None (no per-file LLM cost) |
| Query | `kg-query` (structural) | `graphrag` (semantic) |
| Parse reuse | — | Classpath consumer of GraphPreprocessor |
| Load order | Before graphrag (no hard dependency; conceptual) | After knowledge-graph |

Agent workflow: structural questions → kg-query (free, exact). Thematic/semantic
questions → graphrag local/global/drift (LLM, probabilistic). Staleness prefix
tells the agent when semantic answers may lag the source.

---

## 13. IVP Notes

| Element | Change driver | Artifact |
|---------|--------------|----------|
| Exporter | Corpus format (Typst env syntax, LaTeX conventions) | ivp-book-series lib.typ, legacy .tex sources |
| settings.yaml generator | GraphRAG upstream schema releases | microsoft/graphrag CHANGELOG |
| Prompts | Entity/relationship taxonomy of the book series | IVP domain vocabulary |
| Shim hooks | opencode hook API | opencode plugin docs |
| Manifest/version check | GraphRAG index-format compatibility policy | GraphRAG release notes |
| Environment wiring | nixpkgs graphrag packaging | flake.lock |

Exporter ↔ knowledge-graph: partial driver overlap (both track Typst source
structure) but distinct responsibilities (deterministic graph vs LLM input
preparation) → classpath reuse, no source coupling.

---

## 14. File Layout

```
llm-harness-plugins/graphrag/
├── opencode/index.ts                    # Shim: tool + hooks
├── config/graphrag.yaml                 # Auto-update, models, projects
├── prompts/
│   ├── extract_graph.txt                # Custom entity/relationship types
│   ├── summarize_descriptions.txt
│   ├── extract_claims.txt               # Covariates: rule-violation claims
│   ├── community_report_graph.txt
│   └── community_report_text.txt
├── src/
│   ├── main/java/eu/infolead/llmhp/graphrag/
│   │   ├── ExportCli.java               # Corpus → GraphRAG input documents
│   │   ├── TypstBlockSplitter.java      # Environment/section block scanner
│   │   ├── LatexExporter.java           # pandoc conversion + split
│   │   ├── DocumentWriter.java          # Frontmatter + hash-named files
│   │   ├── DeduplicationIndex.java      # Typst label set vs LaTeX \label
│   │   ├── IndexCli.java                # init/update/status, manifest, lockfile
│   │   └── types/
│   │       ├── ExportConfig.java        # Config records
│   │       ├── SemanticBlock.java       # Block record (env, labels, refs, text)
│   │       └── Manifest.java            # Manifest record
│   └── test/java/eu/infolead/llmhp/graphrag/
│       └── ExportTests.java             # Splitting, metadata, dedup, LaTeX path
└── build/classes/                       # Compiled (committed per harness convention)
```

Consumer project:

```
ivp-book-series/
└── graph-index/                         # gitignored
    ├── input/                           # Exported semantic-block documents
    ├── settings.yaml                    # Generated
    ├── prompts/                         # Copied from plugin
    ├── output/                          # Active index (parquet + lancedb)
    ├── update_output/                   # Transient, promoted after update
    ├── cache/                           # LLM cache
    ├── logs/
    ├── manifest.json
    └── .lock
```

---

## 15. Prohibitions

- ✗ Modify knowledge-graph/ source (classpath reuse only)
- ✗ MCP server (plugin custom tools replace that layer)
- ✗ Commit graph-index/, API keys, model credentials
- ✗ Full-corpus indexing in development (sample ≤ 3 papers)
- ✗ Block tool execution on index jobs (background only)
- ✗ Assume GraphRAG CLI flags (verify installed version)
- ✗ Index .typ/.tex raw source directly (always through exporter)
- ✗ Treat home-manager graphrag as version authority (flake.lock + manifest are)
- ✗ Assume opencode inherits direnv environment (verify at runtime, explicit error)
- ✗ Query an index whose manifest version differs from current binary version
