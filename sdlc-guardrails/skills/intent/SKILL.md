---
name: sdlc-intent
description: Capture a feature idea as intent.md — the first artifact of the AI-native SDLC loop. Use at the start of any new feature, change, or incident follow-up. Elicits the problem, proposed outcome, affected users/systems, constraints, and open questions from the originator, then writes intent.md.
argument-hint: <topic>
---

# SDLC — Intent (intent.md)

Captures what is wanted, why, and under which constraints, in the originator's own
terms. The next stage (spec) reads this file. Advisory — this writes the artifact
that the enforcement layer then tracks.

## Flow

1. **Brainstorm.** Interview the originator until the idea is concrete. Ask the
   questions an analyst would: scope, users, constraints, success criteria.
2. **Write intent.md** using the template below. Save to the repo's intent home
   (default: `intent/` or project root). Recommended filename `intent.md`.
3. **Hand back to the originator** to correct anything misunderstood.
4. **Commit** with author and timestamp so the artifact enters the audit trail.

## Template

```markdown
# Intent: <short title>
Author: <name> ( <role> ). Status: draft.

## Problem
<what cannot be done today; who is affected; why it matters>

## Proposed outcome
<what better looks like>

## Affected users and systems
<people, teams, components, APIs>

## Constraints
<what must NOT happen; boundaries; existing systems to preserve>

## Open questions
<decisions deferred; items needing policy owner input>
```

## Guard

- Write in the originator's words, not analyst jargon.
- If scope is unclear, ask — do not fabricate constraints.
- This artifact is advisory: it does not block anything by itself. A `plan.md`
  derived later enables the enforcement hooks.

## Output

A committed `intent.md` at the agreed intent home.
