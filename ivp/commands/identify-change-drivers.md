---
description: IVP steps 1-3 — enumerate elements, identify change drivers, build Γ, and write the driver registry into the codebase's doc convention
agent: driver-identifier
---
Load the skill `identify-change-drivers` and apply it. This covers steps 1–3 of
IVP: enumerate the elements at one declared grain, identify the change drivers,
and persist `Γ` in the codebase's native documentation convention (Javadoc /
docblock with `@ivpDrivers`).

Scope: $ARGUMENTS

Guards from the skill that must hold:
- one grain only, stated explicitly before any enumeration;
- drivers are **discovered from governing artifacts**, never invented. If the
  artifacts are missing, stop and ask — a guessed `Γ` produces a confident wrong
  structure;
- the registry is written beside the code, not into this plugin's tree.

End with the registry path, the driver count, and the status flag
(`PROVISIONAL`), then point at `/review-ivp-to-convergence drivers` for Gate A.

The canonical reference is `ivp-knowledge.md` in this plugin's `prompts/`
directory; your system prompt states its absolute path.
