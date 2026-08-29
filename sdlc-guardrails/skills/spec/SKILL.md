---
name: sdlc-spec
description: Produce a requirements and design spec (spec.md) from an accepted intent.md — the second artifact of the SDLC loop. Use after intent.md is approved, before planning or building. Applies the repo's security/UX/compliance constraints, flags areas of concern, and writes spec.md next to intent.md.
argument-hint: <intent-path>
---

# SDLC — Requirements & Design (spec.md)

Takes an accepted `intent.md` and produces the requirements and design the
engineering team plans against. Advisory — writes the artifact that downstream
enforcement references.

## Flow

1. **Read the attached `intent.md`.** Work from its stated problem, outcome,
   affected systems, and constraints.
2. **Apply the organization's constraints** (security, brand, UX, compliance)
   while writing the spec — not discovered later in review.
3. **Flag areas of concern** explicitly, especially where policies conflict or
   an open question from `intent.md` cannot be resolved.
4. **Write `spec.md`** beside `intent.md` using the template below.
5. **Hand to the product owner** for sign-off before planning. Resolve flagged
   concerns with their policy owners first.

## Template

```markdown
# Spec: <title> (from intent.md <date>)

## Requirements
<functional and non-functional requirements; acceptance criteria>

## Design
<proposed implementation approach, components, interfaces>

## Flagged concerns
<conflicting policies, unresolved open questions, risk areas>

## Open questions carried forward
<deferred decisions the engineering team must resolve in planning>
```

## Guard

- The spec must answer the open questions in `intent.md` or carry them forward
  explicitly — never silently drop them.
- Do not start planning or building in this step; produce the spec only.
- If a constraint from `intent.md` cannot be satisfied, say so under Flagged
  concerns rather than overriding it silently.

## Output

A committed `spec.md` alongside `intent.md`. The file pair records what was asked
for (intent) and what was decided (spec).
