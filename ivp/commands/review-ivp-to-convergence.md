---
description: Run the two IVP review gates to convergence (drivers, then structure) — fixes findings until two consecutive clean rounds
agent: build
---
Load the skill `review-ivp-to-convergence` and apply it. Target: the gate named
first in the arguments, or `drivers` when none is given.

Gate A (`drivers`) audits the change-driver registry and Γ. Gate B (`refactor`)
audits the post-refactor module structure. Run only the requested gate unless the
arguments name both.

Arguments: $ARGUMENTS

Run the meta-skill's fix loop: audit, fix every finding, re-audit, and stop only
after **two consecutive rounds** report zero findings. Do not weaken a directive
or drop a finding to reach convergence — report a blocked gate instead.

The canonical reference is `ivp-knowledge.md` in this plugin's `prompts/`
directory; your system prompt states its absolute path.
