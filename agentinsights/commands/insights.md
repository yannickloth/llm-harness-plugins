# /insights — Session Analytics Report

Run a full insights analysis over all session transcripts. Scans sessions, extracts structured metadata via LLM, aggregates statistics, and generates a self-contained HTML report.

Usage: `/insights [platform]`

Optional platform arg for feature suggestions: `opencode`, `claude`, or `generic` (default: opencode).

What it does:
1. Scan phase — discovers all session transcript files, computes per-session stats (tools, languages, lines, tokens)
2. Facet extraction — for each substantive session, sends transcript to the best available model to extract goal categories, outcomes, satisfaction, friction, etc.
3. Aggregation — rolls up all session data into global statistics
4. Insight generation — generates narrative analysis sections in parallel (project areas, what works, friction, suggestions, future opportunities)
5. Report — builds an HTML report with inline charts and opens it

Cached results are reused between runs. Only sessions modified since the last run are re-extracted.
