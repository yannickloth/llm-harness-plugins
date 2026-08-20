---
name: ste-100
description: Enforce ASD-STE100 Simplified Technical English when producing or auditing technical or scientific prose, reports, documentation, API/doc text, user guides, and inline docs. Apply approved STE vocabulary, one-meaning-per-word, short active-voice sentences, plain present tense, full approved terms, and structured writing. Delegates to ste-100-auditor for verification.
compatibility: Requires read access to content files when auditing
---
# STE-100 Simplified Technical English

Enforce ASD-STE100 Simplified Technical English for technical/scientific writing.

This rule applies automatically to any technical or scientific deliverable:
prose, explanations, API/docs text, user guides, inline documentation, reports.
It does NOT apply to conversational chat, casual responses, or non-technical
prose unless the user requests it.

## Requirements

| # | Rule | Detail |
|---|------|--------|
| 1 | Approved vocabulary | Use only approved STE words from the ASD-STE100 dictionary; prefer them over synonyms |
| 2 | One meaning per word | Use each approved word with its prescribed meaning only; never a colloquial or secondary sense |
| 3 | Short sentences | Keep sentences short; one idea per sentence; split long or compound sentences |
| 4 | Active voice | Use active voice; name the actor/agent explicitly |
| 5 | Simple grammar | Use present tense for general statements; avoid conditional and future where plain tense suffices |
| 6 | Avoid abbreviations | Use the full approved term unless the abbreviation itself is the approved STE word |
| 7 | Clarity over style | Prioritize unambiguous meaning over elegance; no metaphor, idiom, or literary flourish |
| 8 | Structured writing | Use consistent terminology throughout; define any unavoidable technical term at first use |
| 9 | Sequencing | Number steps in procedures; describe actions in the order they must be performed |
| 10 | Negative commands | State a warning/instruction as "Do not X" rather than "X must not be done" when instructing action |

## Writing

- Telegraphic where appropriate; no padding or filler words
- Prefer tables/lists/symbols over long paragraphs
- Each approved word carries its single prescribed meaning only

## Verification

To audit existing technical/scientific content against STE-100, delegate to the
`ste-100-auditor` agent (read-only). For new writing, apply the requirements
above inline; no delegation needed.

## Scope notes

- Apply unconditionally to technical/scientific content
- Exempt: conversational chat, casual responses, non-technical prose
- When in doubt, prefer STE-compliance for any content a reader relies on for
  correctness (manuals, specs, procedures, API text)
