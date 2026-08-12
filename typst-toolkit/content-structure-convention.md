# Content Structure Convention
# Single global convention for all Typst book projects.
# Agents read this file, then scan the target project to discover which
# environments are actually present. Only present environments are acted on.

---

## Hierarchy

```
part{N}-{slug}/
  ch{NN}-{slug}/
    ch{NN}-{slug}.typ              ← chapter aggregator (#include only, no prose)
    sec-{NN}-{slug}/
      sec-{NN}-{slug}.typ          ← section aggregator (#include only, no prose)
      subsec-{NN}-{slug}/
        subsec-{NN}-{slug}.typ     ← subsection aggregator (#include only, no prose)
        {subdir}/
          {prefix}-{slug}.typ      ← one environment instance per file
```

Levels used per project:
- IVP book, ME/CFS: part → chapter → section → subsection
- ai-patterns: part → chapter (pattern-sections replace sec/subsec)

---

## Aggregator Rule

Aggregator files (`ch*.typ`, `sec-*.typ`, `subsec-*.typ`) MUST contain:
- `#import` lines at top
- `#include` statements for all child content in reading order
- NO prose, NO environment instances, NO headings (headings live in content files)

Violation: any aggregator containing prose or environment calls.

---

## Environment Map

All known environment types across all projects. Agent ignores entries not
found in the target project's source.

### Formal / Mathematical

| Environment | Prefix | Subdir |
|-------------|--------|--------|
| `theorem` | `thm` | `theorems` |
| `lemma` | `lem` | `theorems` |
| `corollary` | `cor` | `theorems` |
| `proposition` | `prop` | `theorems` |
| `conjecture` | `conj` | `theorems` |
| `proof` | `prf` | `proofs` |
| `derivation` | `der` | `proofs` |
| `calculation` | `calc` | `proofs` |
| `solution` | `sol` | `proofs` |
| `definition` | `def` | `definitions` |
| `axiom` | `ax` | `definitions` |
| `principle` | `princ` | `definitions` |
| `correspondence` | `corr` | `definitions` |
| `assumption` | `asmp` | `definitions` |
| `guideline` | `guide` | `definitions` |

### Scientific Claim (ME/CFS)

| Environment | Prefix | Subdir |
|-------------|--------|--------|
| `hypothesis` | `hyp` | `hypotheses` |
| `fhypothesis` | `fhyp` | `hypotheses` |
| `speculation` | `spec` | `hypotheses` |
| `achievement` | `ach` | `achievements` |
| `prediction` | `pred` | `achievements` |
| `postdiction` | `postd` | `achievements` |
| `clinical-finding` | `cf` | `findings` |
| `observation` | `obs` | `findings` |
| `recommendation` | `rec` | `recommendations` |
| `protocol` | `proto` | `recommendations` |
| `requirement` | `req` | `recommendations` |
| `open-question` | `oq` | `open-questions` |
| `consistency-check` | `cc` | `open-questions` |

### Epistemic / Warning

| Environment | Prefix | Subdir |
|-------------|--------|--------|
| `warning-env` | `warn` | `warnings` |
| `practical-warning` | `pwarn` | `warnings` |
| `limitation` | `lim` | `warnings` |
| `model-insight` | `mi` | `key-insights` |

### Discussion / Informal

| Environment | Prefix | Subdir |
|-------------|--------|--------|
| `remark` | `rem` | `remarks` |
| `example` | `xmpl` | `examples` |
| `counterexample` | `cex` | `examples` |
| `exercise` | `ex` | `exercises` |
| `conclusion` | `concl` | `remarks` |
| `consequence` | `cons` | `remarks` |
| `note` | `note` | `remarks` |
| `heuristic` | `heur` | `remarks` |

### Insight / Navigation Boxes

| Environment | Prefix | Subdir |
|-------------|--------|--------|
| `key-insight` | `ki` | `key-insights` |
| `key-point` | `ki` | `key-insights` |
| `common-confusion` | `cc` | `key-insights` |
| `plain-language` | `pl` | `key-insights` |
| `direction` | `dir` | `key-insights` |
| `roadmap` | `road` | `key-insights` |

### Figures / Tables / Code

| Environment | Prefix | Subdir |
|-------------|--------|--------|
| figure / image | `fig` | `images` |
| table | `tbl` | `tables` |
| algorithm | `alg` | `algorithms` |
| code listing | `lst` | `listings` |

---

## File Naming

```
{prefix}-{slug}.typ
```

- `slug`: lowercase, hyphens, derived from environment title or content summary
- unique within its subdir
- examples: `hyp-metabolic-trap.typ`, `def-change-driver.typ`, `ki-activation-vs-coordination.typ`

---

## Post-Conditions (MANDATORY — enforced after every split)

These must ALL hold after any structural operation:

1. **Content completeness** — every environment instance present before the operation
   is present after, verbatim, in exactly one file under the new hierarchy.
   Verification: `grep -r '#hypothesis\|#remark\|...' before/ | wc -l` equals after count.

2. **Build passes** — project build command succeeds without new errors or warnings.
   See §Build Command below for how agents resolve the command.

3. **Aggregator coverage** — every new content file is reachable from the chapter
   aggregator via an unbroken `#include` chain. No orphan files.

4. **No duplication** — each environment instance appears in exactly one leaf file.
   Original monolithic file must be deleted (or replaced by aggregator) after split.

5. **Label preservation** — every `<label>` defined before the split is defined in
   exactly one file after. Count must match.

6. **Cross-reference integrity** — every `@reference` that resolved before still
   resolves after. Verified by successful build with no unresolved reference warnings.

7. **Import chain intact** — every new file has the correct `#import` path to reach
   the project's `lib.typ` (relative path adjusted for new depth).

---

## Build Command

Agents resolve the build command at runtime — it is never hardcoded here.

Resolution order:
1. Read project `AGENTS.md` — use the build command documented there
2. If multiple targets (multi-volume): agent asks which target to verify, or runs all
3. Fallback if no AGENTS.md build section: `typst compile {main.typ}` where `main.typ`
   is the root entry point found by scanning for the file that is not `#include`d by any other

The build command is **project-specific** and **not overridden here**.

---

## Iso-Functional Guarantee

A split is iso-functional when all 7 post-conditions hold.
If any post-condition fails, the split must be rolled back via `git checkout`.
Never declare a split complete without verifying all 7.
