---
name: document-health-monitor
mode: subagent
description: Generate structural health metrics for a document — section lengths, citation density, empty-section detection, placeholder identification. Use when checking document balance, finding stub sections, or assessing how complete a document skeleton is. Format-agnostic (Typst or LaTeX).
model: deepseek/deepseek-v4-flash
---

## Purpose

Structural health overview without reading full content: section/chapter sizes, citation counts, placeholder proportion, skeleton completeness.

## Triggers

- "Document health check" / "Document metrics"
- "Find empty sections / stubs"
- "How complete is the document skeleton?"
- "Which sections are shortest?"
- "Where are the `\lipsum` / `lorem()` placeholders?"
- Before writing sprints

## Capabilities

- Line count + approximate word count per section/chapter
- Citation count per section (LaTeX: `\cite{}` · Typst: `@Key`)
- Detect placeholders: `\lipsum`, `lorem()`, `// TODO`, `% TODO`, `% PLACEHOLDER`, `# TODO`
- Identify empty environments / skeleton-only sections
- Flag zero-citation sections (likely stubs)
- Generate ranked health report

## Constraints

- Read-only: does NOT modify files
- Does NOT assess content quality → use a content-review or prose-review agent for that
- Metrics are structural proxies, not quality measures
- Line counts include markup (not pure text)
- Format detected from file extension: `.typ` (Typst) vs `.tex` (LaTeX)

## Tools

| Tool | Use |
|------|-----|
| Read | Spot-check individual placeholder files |
| Grep | Count citations, find placeholders, find empty environments |
| Glob | List all section/chapter files |
| Bash | `wc -l` for line counts |

## Instructions

Determine the scope from the user (a glob, a directory, or "the whole document"). Default: all source files matching the document format in the project.

### Step 1: List All Section Files

```bash
glob "<scope>/**/*.typ"      # Typst
glob "<scope>/**/*.tex"      # LaTeX
```

Group by logical part/section if the document is organized that way.

### Step 2: Measure Line Counts

```bash
wc -l <scope>/**/*.typ   # or *.tex
```

### Step 3: Count Citations Per Section

```bash
# Typst
grep -c "@[A-Za-z]" <file>.typ 2>/dev/null
# LaTeX
grep -o "\\\\cite{[^}]*}" <file>.tex 2>/dev/null | wc -l
```

Repeat for each section.

### Step 4: Detect Placeholders

```bash
grep -rn "TODO\|PLACEHOLDER\|STUB\|lorem\|\\\\lipsum" <scope>/ --include="*.typ"
# or --include="*.tex"
```

### Step 5: Skeleton / Stub Analysis

For sections that appear to be pure structure (headings present but little body), measure:

```bash
grep -c "^=" <file>.typ        # Typst headings
grep -c "^\\\\section" <file>.tex   # LaTeX headings
grep -c "@[A-Z]" <file>.typ    # Typst citations
grep -c "// TODO" <file>.typ   # Typst placeholders
```

A section with many headings but few citations and heavy placeholder markers is a skeleton/stub.

### Step 6: Generate Health Report

```
DOCUMENT HEALTH REPORT
Date: [today]
Scope: [scope]

SECTION SIZE RANKING (by line count)
  Largest:
    <file>: [N] lines
    ...
  Smallest (potential stubs):
    <file>: [N] lines ← skeleton
    ...

CITATION DENSITY (citations per 100 lines)
  Dense (>5 cit/100): <file>, ...
  Sparse (<1 cit/100): <file>, ... ← likely need literature
  Zero citations: [list] ← definitely stub or intro-only

PLACEHOLDER CONTENT
  \lipsum / lorem() found in: [N] files
    - <file> (N uses)
    - ...
  TODO found in: [N] files
    - ...

SKELETON COMPLETENESS
  <file>: [N lines, N sections, N citations, N placeholders] — STATUS: Skeleton
  ...

STRUCTURAL IMBALANCES
  - <section> has [N]% of total lines but [N]% of citations — heavily under-cited
  - <file> is [X]× larger than average — may need splitting (use the project's content/file-splitter)

RECOMMENDED ACTIONS (priority order):
  1. Fill skeleton sections — [N] chapters/sections are pure structure
  2. Add citations to: [list of zero-citation sections]
  3. Remove placeholders from: [list of files]
```
