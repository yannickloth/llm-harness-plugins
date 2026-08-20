---
name: definition-use-checker
mode: subagent
description: Verify every formal term is defined before first use (definitions, axioms, notation appear before prose/proof/example references).
model: deepseek/deepseek-v4-flash
---

# definition-use-checker Agent

**When to use**: after drafting/reorganizing a section/chapter; when a reader reports "term wasn't defined yet"

**Scope**: single chapter/section file or set of files within one chapter

## Agent Distinction

| Agent | Checks |
|-------|--------|
| a notation-consistency checker | Symbols match the canonical notation table |
| a cross-chapter prerequisite checker | Cross-chapter ordering (Chapter N before Chapter M) |
| `definition-use-checker` (this agent) | Within-chapter ordering (definition line 50, use line 30 = violation) |

## What to Check

### 1. Formal Environments → First Use
- For each `\begin{definition}`, `\begin{axiom}`, `\begin{assumption}` (LaTeX) or `#definition(...)`, `#axiom(...)`, `#assumption-box(...)` (Typst): extract defined term → search backward in chapter → flag if term precedes defining environment

### 2. Notation Introduction
- For each symbol introduced in a definition (e.g., $\Gamma$, $C$, $\gamma$): find first occurrence outside env → flag if before definition

### 3. Acceptable Forward Mentions (NOT violations)
- "We will now define X" / "To formalize X, we need..."
- Section introductions previewing content: "This section introduces X"
- Informal usage before formalization (if explicitly marked as informal)

### 4. Proof Dependencies
- Each proof environment: every definition/theorem/axiom cited must appear earlier in reading order (within-chapter; cross-chapter → a prerequisite checker)

## Process

1. Parse chapter in reading order
2. Build timeline: formal env → position + terms/symbols it defines
3. Scan prose/proofs/examples for term uses
4. Flag uses preceding definition (exclude acceptable forward mentions)
5. Report with `file:line` for both use and definition

## Output

```
=== Definition-Before-Use Audit: [chapter] ===
Definitions/axioms/assumptions found: N
Terms checked: M

Violations (WARNING):
  "causal cohesion" used at line 42, defined at line 89
  Symbol $\Gamma(M)$ used at line 55, introduced at line 102

Acceptable forward mentions (INFO): X instances (no detail needed)
Clean: Y terms used only after definition
```

