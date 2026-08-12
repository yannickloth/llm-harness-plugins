---
name: enforce-structure
description: Audit → fix convergence loop for Typst content structure. Runs structure-auditor, fixes violations using split-chapter (for aggregator purity) or direct edits (for naming/orphan/import violations), re-audits until zero violations or max 10 rounds. Use to bring a full project or part into compliance with the canonical content hierarchy.
---

Convergence loop: audit → fix → re-audit until COMPLIANT or max rounds reached.

## Usage

```
/enforce-structure <target-dir>
```

Target can be a chapter dir, part dir, or full `src/` tree.

## Steps

1. **Resolve build command** — read project AGENTS.md (see convention §Build Command)

2. **Initial audit** — delegate to `structure-auditor` subagent (`subagent_type=structure-auditor`) on target
   - If COMPLIANT: done, report clean
   - If violations found: proceed to fix loop

3. **Fix loop** (max 10 rounds)

   For each round, group violations by type and fix:

   | Violation | Fix |
   |-----------|-----|
   | A — Aggregator purity | Run `/split-chapter` on the offending aggregator file |
   | B — Typed subdir placement | Move file to correct subdir; update `#include` in parent aggregator |
   | C — File naming | Rename file to `{prefix}-{slug}.typ`; update `#include` in parent |
   | D — Orphan file | Add `#include` in the correct parent aggregator at correct reading position |
   | E — Missing import | Add correct `#import` line (compute relative path to `lib.typ`) |
   | F — Duplicate label | Remove label from duplicate; keep in canonical location only |

   After each fix batch:
   - Run `{build-command}` — must stay green; halt if it breaks
   - Re-run `structure-auditor` subagent
     - COMPLIANT → exit loop
     - Violations reduced → next round
     - Violations unchanged → halt, report stuck (manual review needed)

4. **Final build** — run `{build-command}`, must pass

5. **Report**

```
enforce-structure: COMPLIANT | STUCK | BUILD-FAILED

Target: {dir}
Rounds: {N}

Round 1: {N} violations → fixed {M}  (A:{a} B:{b} C:{c} D:{d} E:{e} F:{f})
Round 2: {N} violations → fixed {M}
...
Final:   0 violations  (COMPLIANT)

Build: OK | FAILED
```

## Stuck condition

If a round produces zero fixes but violations remain, report each stuck violation
with file, line, violation type, and reason. Do not loop further — manual review needed.

## Safety

- ✗ Never fix by deleting content — only by moving/restructuring
- ✗ Never declare a fix complete without re-running the build
- ✓ All 7 post-conditions from the convention apply to every fix operation
- ✓ `/split-chapter` already verifies its own post-conditions — trust its output
