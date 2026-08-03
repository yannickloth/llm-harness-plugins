# Insights — Design Specification

Session analytics + AI-generated narrative report.
Local-only: scans session transcripts, classifies via LLM, generates HTML.

Implementation: Java ≥ 25 for all logic. TypeScript shims for platform tool definitions.

---

## 0. Design Principles

### 0.1 IVP-prescribed packaging

| Element | Change driver |
|---------|--------------|
| SessionScanner, TranscriptReader | Session storage format — how sessions are stored/read on disk |
| FacetExtractor, FacetCache | Facet extraction prompt schema — what metadata gets extracted per session |
| Aggregator, QuantStats | Aggregation rules — how per-session data rolls up to global stats |
| MultiClaudingDetector | Overlap detection heuristic — 30-min window, sliding interleaving detection |
| InsightGenerator, SectionPrompts | Insight section prompts — narrative sections and their structure |
| HtmlReporter, Charts | HTML report format + chart renderers |
| MarkdownSummarizer | Markdown summary format — what goes in chat output |

**IVP result:** each `.java` script is its own module. Filesystem is the packaging boundary.

### 0.2 Design constraints

| Constraint | Why |
|------------|-----|
| Local-only | No telemetry upload; scans `.jsonl` files on disk |
| LLM-driven classification | Facets extracted by LLM (not regex); narrative insights LLM-generated |
| Facet caching | Extract once per session; cached to disk; re-extract only when session modified |
| Parallel generation | Insight sections generated independently in parallel; At-a-Glance last (depends on others) |
| HTML output | Self-contained HTML with inline CSS + JS; openable in browser |

---

## 1. Architecture Overview

```
Phase 1 — Scan (seconds-minutes)
  Walk session storage dirs, find .jsonl files, compute SessionMeta per file.
  Skip sessions under threshold (warmup/no content).

Phase 2 — Facet extraction (minutes)
  For each substantive session, send transcript to LLM with facet extraction prompt.
  Extract: goal categories, outcome, satisfaction, helpfulness, session type, friction, success.
  Cache results to disk. Parallel extraction (respect API rate limits).

Phase 3 — Aggregation + insight generation (minutes)
  Aggregate all SessionMeta + SessionFacets → AggregatedData.
  Send AggregatedData + facet summaries to LLM for 6-8 insight sections (parallel).
  Generate "At a Glance" summary last (reads other sections).

Phase 4 — Report generation (seconds)
  Build HTML report with inline charts, narrative sections, copyable suggestions.
  Return markdown summary to chat.
```

---

## 2. Data Model

### 2.1 SessionMeta (per-session stats, regex-extractable)

```
session_id: string
project_path: string
start_time: ISO8601
duration_minutes: number
user_message_count: number
assistant_message_count: number
tool_counts: Record<string, number>
languages: Record<string, number>
git_commits: number
git_pushes: number
input_tokens: number
output_tokens: number
first_prompt: string
summary?: string (from session metadata)
user_interruptions: number
user_response_times: number[] (seconds, 2s-1hr range, gaps between assistant and next user msg)
tool_errors: number
tool_error_categories: Record<string, number>
uses_task_agent: boolean
uses_mcp: boolean
uses_web_search: boolean
uses_web_fetch: boolean
lines_added: number
lines_removed: number
files_modified: number
message_hours: number[] (0-23 hour of each user message)
user_message_timestamps: ISO8601[]
```

### 2.2 SessionFacets (per-session, LLM-extracted)

```
session_id: string
underlying_goal: string       — "What the user fundamentally wanted to achieve"
goal_categories: Record<string, number>  — debug_investigate, implement_feature, fix_bug, ...
outcome: enum                  — fully_achieved | mostly_achieved | partially_achieved | not_achieved | unclear
user_satisfaction_counts: Record<string, number>  — happy, satisfied, likely_satisfied, disappointed, frustrated
agent_helpfulness: enum       — unhelpful | slightly_helpful | moderately_helpful | very_helpful | essentialsession_type: enum             — single_task | multi_task | iterative_refinement | exploration | quick_question
friction_counts: Record<string, number>  — misunderstood_request, wrong_approach, buggy_code, ...
friction_detail: string        — one sentence or empty
primary_success: string        — fast_accurate_search, correct_code_edits, good_explanations, ...
brief_summary: string          — 1 sentence: what user wanted and whether they got it
user_instructions_to_agent?: string[]
```

### 2.3 AggregatedData (roll-up of all sessions)

```
total_sessions: number
total_sessions_scanned?: number
sessions_with_facets: number
date_range: { start: ISO; end: ISO }
total_messages: number
total_duration_hours: number
total_input_tokens: number
total_output_tokens: number
tool_counts: Record<string, number>
languages: Record<string, number>
git_commits: number
git_pushes: number
projects: Record<string, number>
goal_categories: Record<string, number>
outcomes: Record<string, number>
satisfaction: Record<string, number>
helpfulness: Record<string, number>
session_types: Record<string, number>
friction: Record<string, number>
success: Record<string, number>
session_summaries: Array<{ id, date, summary, goal? }>  — top 50
total_interruptions: number
total_tool_errors: number
tool_error_categories: Record<string, number>
user_response_times: number[]
median_response_time: number
avg_response_time: number
sessions_using_task_agent: number
sessions_using_mcp: number
sessions_using_web_search: number
sessions_using_web_fetch: number
total_lines_added: number
total_lines_removed: number
total_files_modified: number
days_active: number
messages_per_day: number
message_hours: number[]
multi_clauding: { overlap_events, sessions_involved, user_messages_during }
```

### 2.4 InsightResults (LLM-generated narrative)

```
at_a_glance: { whats_working, whats_hindering, quick_wins, ambitious_workflows }
project_areas: { areas: Array<{ name, session_count, description }> }
interaction_style: { narrative, key_pattern }
what_works: { intro, impressive_workflows: Array<{ title, description }> }
friction_analysis: { intro, categories: Array<{ category, description, examples? }> }
suggestions: {
  rules_additions: Array<{ addition, why, prompt_scaffold }>
  features_to_try: Array<{ feature, one_liner, why_for_you, example_code? }>
  usage_patterns: Array<{ title, suggestion, detail?, copyable_prompt? }>
}
on_the_horizon: { intro, opportunities: Array<{ title, whats_possible, how_to_try?, copyable_prompt? }> }
fun_ending: { headline, detail }
```

---

## 3. Scan Phase

### 3.1 Session discovery

```
Walk session storage dir (OPENCODE_SESSION_DIR).
Find all *.jsonl files.
Load each via session reader → LogOption (messages, timestamps, metadata).
```

### 3.2 Session filtering

- Skip sessions under minimum threshold: < 2 user messages OR < 1 min duration.
- Skip warmup/cache sessions (detect via pattern: minimal messages, no tool use).
- Deduplicate: same session_id with multiple branches → keep branch with most user messages.
- Only scan sessions with valid start/modified timestamps.

### 3.3 SessionMeta extraction (regex-based, no LLM)

Walk each session's messages. For each message:
- **assistant**: extract `usage` (input_tokens, output_tokens); extract tool_use blocks →
  count tools, track task-agent/MCP/web-search usage, diff Edit old/new for lines_added/removed,
  record file paths for language tracking, detect git commands.
- **user**: detect human messages (has text, not just tool_result); record timestamps
  for hour-of-day and response-time analysis; detect `[Request interrupted by user]`;
  detect tool_result `is_error` → categorize errors.
- **skip**: tool_result-only user messages (no human text).

Language detection via file extension map:
`.ts/.tsx→TypeScript`, `.py→Python`, `.rs→Rust`, `.java→Java`, `.go→Go`,
`.rb→Ruby`, `.md→Markdown`, `.json→JSON`, `.yaml/.yml→YAML`, `.sh→Shell`,
`.css→CSS`, `.html→HTML`

Error categorization from tool_result content:
| Pattern | Category |
|---------|----------|
| `exit code` | Command Failed |
| `rejected` / `doesn't want` | User Rejected |
| `string to replace not found` / `no changes` | Edit Failed |
| `modified since read` | File Changed |
| `exceeds maximum` / `too large` | File Too Large |
| `file not found` / `does not exist` | File Not Found |

---

## 4. Facet Extraction Phase

### 4.1 Cache check

Before LLM call, check `~/.agentmem/insights/facets/<sessionId>.json`.
If exists AND session mtime not changed since cache write → use cached.
Otherwise → extract fresh.

### 4.2 Transcript formatting

Format session transcript for LLM consumption:
```
Session: <id_prefix>
Date: <start_time>
Project: <path>
Duration: <N> min

[User]: <first 500 chars of each user message>
[Assistant]: <first 300 chars of each assistant text>
[Tool: <name>]
```

For transcripts > 30KB: split into chunks (25KB each), summarize each chunk via LLM
in parallel, combine summaries with session header.

### 4.3 LLM prompt

System prompt with CRITICAL GUIDELINES:
- **goal_categories**: count only what USER explicitly asked for. Never count autonomous exploration.
- **user_satisfaction_counts**: base only on explicit user signals (yay/great → happy, thanks/looks good → satisfied, etc.).
- **friction_counts**: specific categories: misunderstood_request, wrong_approach, buggy_code, user_rejected_action, excessive_changes, ...

Schema for JSON output:
```
{
  "underlying_goal": "...",
  "goal_categories": {"debug_investigate": 2, "implement_feature": 1},
  "outcome": "fully_achieved|mostly_achieved|partially_achieved|not_achieved|unclear_from_transcript",
  "user_satisfaction_counts": {"satisfied": 3},
  "agent_helpfulness": "very_helpful",
  "session_type": "single_task|multi_task|iterative_refinement|exploration|quick_question",
  "friction_counts": {"misunderstood_request": 1},
  "friction_detail": "One sentence or empty",
  "primary_success": "correct_code_edits|fast_accurate_search|good_explanations|...",
  "brief_summary": "One sentence summary"
}
```

### 4.4 Validation

Validate LLM response:
- `session_id` present, non-empty
- All required fields present
- Enum values match known sets
- Count records are numeric

Invalid → delete corrupted cache, return null (session excluded from facets).

### 4.5 Parallelism

Extract facets for all sessions in parallel (bounded by API rate limits).
Cache each result immediately after extraction.
Continue on individual extraction failure; log and skip that session.

---

## 5. Aggregation Phase

### 5.1 Roll-up

Sum all numeric fields from SessionMeta across sessions.
Merge per-session counts into global histograms (tools, languages, goals, etc.).

### 5.2 Derived stats

```
median_response_time: sort user_response_times → pick middle
avg_response_time: sum / count
days_active: count distinct date portions of start_time
messages_per_day: total_messages / days_active
```

### 5.3 Multi-clauding detection

Detect concurrent agent usage (30-min sliding window):
```
Sorted timeline of all session messages.
Window: 30 min.
Pattern: s1 → s2 → s1 within window → detected.
Tracks: overlap_events, sessions_involved, user_messages_during.
```

---

## 6. Insight Generation Phase

### 6.1 Data context for LLM

Build compact JSON context from AggregatedData + top 50 facet summaries +
top 20 friction details + top 15 user instructions.

### 6.2 Insight sections (generated in parallel)

| Section | Prompt focus |
|---------|-------------|
| `project_areas` | Cluster the user's work into named areas with descriptions |
| `interaction_style` | Narrative of how the user interacts; key pattern |
| `what_works` | Impressive workflows, what went well, intro |
| `friction_analysis` | Friction categories with descriptions and examples |
| `suggestions` | AGENTS.md additions, features to try, usage patterns (all with copyable prompts) |
| `on_the_horizon` | Future opportunities as models improve |
| `fun_ending` | Memorable qualitative moment from transcripts |

All sections: max 8192 output tokens. Return valid JSON only.

### 6.3 At a Glance (generated last)

Reads all other sections' outputs. 4-part structure:
1. **What's working** — user's unique style, impactful accomplishments.
2. **What's hindering** — the agent's fault (misunderstandings, wrong approaches) vs user-side friction.
3. **Quick wins to try** — specific features or workflow techniques.
4. **Ambitious workflows for better models** — what to prepare for in next 3-6 months.

Coaching tone. 2-3 sentences per section. No numerical stats.

---

## 7. Report Generation Phase

### 7.1 HTML report

Self-contained HTML file at `~/.agentmem/insights/report.html`.

Sections (in order):
1. **Header**: date_range, session count, duration, messages
2. **At a Glance**: 4-part summary with links to detail sections
3. **What You Work On**: project areas with session counts
4. **How You Use the Agent**: interaction narrative + key pattern
5. **Impressive Things You Did**: big wins with titles and descriptions
6. **Where Things Go Wrong**: friction categories with examples
7. **Features to Try**: AGENTS.md additions (with copy checkboxes), features, usage patterns
8. **On the Horizon**: future opportunities with copyable prompts
9. **Fun Ending**: memorable moment
10. **Stats Appendix**: bar charts for outcomes, satisfaction, goals, tools, friction, languages,
    response time histogram, time-of-day histogram, tool errors

### 7.2 Charts (inline CSS/HTML, no JS charting library)

**Bar charts** (outcomes, satisfaction, goals, tools, friction, languages):
- Fixed-order for ordinal data (satisfaction, outcomes)
- Top-6 descending for others
- Labels via LABEL_MAP (snake_case → Title Case)

**Response time histogram** (buckets):
2-10s | 10-30s | 30s-1m | 1-2m | 2-5m | 5-15m | >15m

**Time-of-day histogram** (periods):
Morning (6-12) | Afternoon (12-18) | Evening (18-24) | Night (0-6)

### 7.3 Markdown summary (displayed in chat)

Concise recap of At a Glance sections + key stats + path to HTML report.

---

## 8. Caching

| Cache | Location | TTL |
|-------|----------|-----|
| SessionMeta | `~/.agentmem/insights/session-meta/<id>.json` | Persistent; invalidate when session mtime changes |
| SessionFacets | `~/.agentmem/insights/facets/<id>.json` | Persistent; invalidate when session mtime changes |
| HTML report | `~/.agentmem/insights/report.html` | Regenerated on each `/insights` run |

Cache invalidation:
- SessionMeta: compare cached `mtime` against session file `mtime`. Re-extract if changed.
- SessionFacets: compare cached `mtime` against session file `mtime`. Re-extract if changed.
- Cache files `chmod 600` for privacy.

Validation on load: check required fields, enum values, numeric types. Delete corrupted cache.

---

## 9. Model Selection

| Phase | Model | Rationale |
|-------|-------|-----------|
| Facet extraction | Opus-equivalent (best available) | Accuracy on classification |
| Transcript summarization | Opus-equivalent | Needed for >30KB transcripts |
| Insight generation | Opus-equivalent | Narrative quality |
| At a Glance | Opus-equivalent | Synthesis of all other sections |

Configurable via env var `INSIGHTS_MODEL` (default: platform's best model).

---

## 10. Concurrency

| Concern | Approach |
|---------|----------|
| Facet extraction | Sessions extracted in parallel; bounded by API rate limits; continue on individual failure |
| Insight generation | 6-8 sections in parallel (independent); At a Glance serial (reads others) |
| Concurrent `/insights` runs | Not supported; second invocation returns "already running" or queue |
| Session file writes during scan | Scan reads mtime before processing; if mtime changes mid-scan, mark for re-extraction next run |

---

## 11. Retention / Privacy

| Rule | Detail |
|------|--------|
| No telemetry | Reports stay local; no upload to servers |
| Facet cache | `chmod 600`; contains LLM summaries of transcripts, not full transcripts |
| Session transcripts | Never leave disk; only read locally |
| Delete via `/insights clear` | Removes all caches and the HTML report |

---

## 12. File Layout

```
.agentmem/insights/
├── session-meta/
│   ├── <sessionId>.json       # SessionMeta per session (regex-extracted, cached)
│   └── ...
├── facets/
│   ├── <sessionId>.json       # SessionFacets per session (LLM-extracted, cached)
│   └── ...
└── report.html                 # HTML report (generated anew each run)
```

Implementation files:
```
agentinsights/                  # Plugin directory
├── InsightsRunner.java          # Main entry: scan → extract → aggregate → generate → report
├── SessionScanner.java          # Walk session dirs, load .jsonl, compute SessionMeta
├── FacetExtractor.java          # LLM-driven facet extraction + caching
├── Aggregator.java              # Roll up SessionMeta + Facets → AggregatedData
├── MultiClaudingDetector.java   # Sliding-window concurrent-session detection
├── InsightGenerator.java        # Parallel LLM-driven insight sections + At-a-Glance
├── HtmlReporter.java            # HTML report with inline charts + CSS
├── MarkdownSummarizer.java      # Chat-displayable markdown summary
├── CacheManager.java            # Read/write/validate session-meta + facets cache
├── types/
│   ├── SessionMeta.java         # record
│   ├── SessionFacets.java       # record
│   ├── AggregatedData.java      # record
│   └── InsightResults.java      # record (nested types)
├── opencode/
│   └── index.ts                 # Plugin entry: registers /insights command + tool
├── prompts/
│   ├── facet-extraction.md      # Facet extraction prompt + schema
│   ├── transcript-summarize.md  # Transcript chunk summarization prompt
│   ├── project-areas.md         # Section prompt
│   ├── interaction-style.md     # Section prompt
│   ├── what-works.md            # Section prompt
│   ├── friction-analysis.md     # Section prompt
│   ├── suggestions.md           # Section prompt
│   ├── on-the-horizon.md        # Section prompt
│   ├── fun-ending.md            # Section prompt
│   └── at-a-glance.md           # Synthesis prompt (runs last)
└── build/
    └── classes/                 # Compiled Java (committed)
```

---

## 13. Platform Integration

```
/insights                       # Slash command → agentinsights run
/insights report                # Open HTML report in browser
/insights clear                 # Delete all caches + report
```

Plugin registers `run-insights` tool accessible to the agent.

---

## 14. TRANSCRIPT SUMMARIZATION (reuse from agentmem)

When a session transcript exceeds 30KB, the FacetExtractor reuses the agentmem
Dreamer's transcript summarization capability to produce chunk summaries before
facet extraction. This avoids token overflow for the facet extraction LLM call.

## 15. Key Design Decisions

| Aspect | Decision |
|--------|-------------|
| Session storage | Configurable via plugin config |
| Homespace SCP | No — local only |
| Feature suggestions | Generic / configurable prompt templates |
| Team / model improvement sections | No |
| Analytics telemetry | None |
| Language | Java ≥ 25 core + TS shims |
