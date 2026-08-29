---
name: sdlc-plan
description: Write an implementation plan (plan.md) from an approved spec.md — the third artifact of the SDLC loop. Use after spec.md is approved, before writing code. Produces a plan naming the files that change, the order of work, risks, and proof, and commits it as plan.md. This plan enables plan/diff sync enforcement (R1).
argument-hint: <spec-path>
---

# SDLC — Implementation Plan (plan.md)

Turns an approved `spec.md` into a written plan the agent and engineer agree on
before code is written. The committed `plan.md` is what the enforcement layer
checks diffs against (R1) and what review agents verify.

## Flow

1. **Read the approved `spec.md`.** Understand the design and flagged concerns.
2. **Produce an implementation plan** that names: the files that change, the
   order of work, the tests that prove it, and the risks.
3. **Interrogate the plan**: what could it break? which step is most risky? what
   alternatives were rejected? Iterate until an engineer who never saw the
   conversation could implement from the plan alone.
4. **Write `plan.md`** using the template below. Put file paths on `-` bullets so
   the plan parser can index them for diff-sync checking.
5. **Commit** the approved plan. Mark fix-only steps with `[fix]` if the change is
   a bug fix (this enables test-protection R3).

## Template

```markdown
# Plan: <title> (from intent.md <date>)

## Files that change
- src/App.java
- src/test/AppTest.java

## Order of work
1. Add the endpoint behind existing auth.
2. Wire the UI to it.
3. Add the integration test.

## Risks
<what could break; mitigations>

## Proof
<how to verify; which tests must pass; what a correct result looks like>
```

## Guard

- Every file you intend to edit must appear in "Files that change". The plan
  parser indexes these to warn when an edit lands outside the declared scope.
- If implementation later departs from the plan, update `plan.md` in the same
  commit — keep the plan and the diff synchronized.
- A fix change (bug fix, no new behavior) should be marked so test-protection
  applies: put `[fix]` in the step or a `## Fix` section heading.

## Output

A committed `plan.md`. With one present, the plugin's `tool.execute.before` hook
reports edits outside the declared file set as `warn` (R1), and fix-scoped
sessions protect test files from weakening (R3).
