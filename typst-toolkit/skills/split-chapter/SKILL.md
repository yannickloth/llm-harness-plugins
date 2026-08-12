---
name: split-chapter
description: Split a single monolithic Typst chapter or section file into the canonical content hierarchy. Runs content-splitter agent then verifies all 7 post-conditions and build. Use when a chapter file contains prose and environment instances that should be extracted into typed subdirectory files.
---

Split one chapter/section file into canonical structure. Iso-functional — rendered book unchanged.

## Usage

```
/split-chapter <path-to-file>
```

## Steps

1. **Pre-flight** — confirm file exists and is tracked in git (recovery point)
   ```bash
   git status {file}
   ```

2. **Baseline** — record pre-split counts for post-condition verification
   ```bash
   grep -c "@[a-zA-Z]" {file}   # citations
   grep -c "<[a-zA-Z]" {file}   # labels
   grep -c "^#" {file}           # environment calls
   {build-command}    # resolve from project AGENTS.md — must pass before split
   ```

3. **Split** — delegate the split to the `content-splitter` subagent (`subagent_type=content-splitter`) with the target file. The agent reads the content-structure-convention, extracts environment instances and prose into typed subdirectory files iso-functionally, and verifies all 7 post-conditions before deleting the original.

4. **Audit** — delegate a structural audit of the new chapter directory to the `structure-auditor` subagent (`subagent_type=structure-auditor`). Must report COMPLIANT before proceeding.

5. **Build** — resolve command from project AGENTS.md (see convention §Build Command), run it
   - Must pass with no new errors

6. **Report**
   ```
   split-chapter: PASS | FAIL
   File: {original}
   New dir: {chapter-dir}/
   Environments extracted: {N}
   Build: OK | FAILED
   Audit: COMPLIANT | {N} violations
   ```

## Rollback

If any step fails:
```bash
git checkout -- {original-file}
rm -rf {new-chapter-dir}
```
