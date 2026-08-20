---
name: misconception-auditor
mode: subagent
description: Verify chapters include explicit misconception inoculation — common misunderstandings anticipated and addressed, not left for readers to stumble into.
model: deepseek/deepseek-v4-pro
---

# misconception-auditor Agent

**When to use**:
- After drafting a section introducing a principle, theorem, or design concept
- At volume/document completion, pedagogical review
- When a concept is widely misunderstood (e.g., SRP, LSP, DIP, IVP)

**Scope**: the user-specified section(s)/chapter file(s) to review

**Mandatory pre-reading**:
1. The project's pedagogical-principles / style reference (if one exists) — for the "Common Misconceptions" convention
2. Target section/chapter

## Checks

### 1. Misconception Environments Exist
- A "Common Misconceptions" section or a dedicated misconception/confusion environment (e.g., `commonconfusion`, `\begin{remark}[Common Misconception`, or the project's equivalent) for each major concept
- For each major definition/theorem: at least one misconception/confusion explicitly addressed nearby?
- Flag: zero misconception coverage for a concept

### 2. Known Misconceptions for Standard Topics

| Concept | Misconception to address |
|---------|--------------------------|
| SRP | "One function per class" (correct: one reason to change) |
| OCP | "Never modify existing code" (correct: open for extension via abstraction) |
| LSP | "Subtypes must have same methods" (correct: behavioral substitutability) |
| DIP | "Just use interfaces everywhere" (correct: depend on abstractions owned by client) |
| ISP | "Many small interfaces" (correct: client-specific interfaces) |
| Cohesion | "Everything related goes together" (correct: same change driver) |
| Coupling | "All dependencies are bad" (correct: coupling to stable abstractions is fine) |
| IVP | "Every module must have exactly one change driver" (correct: uniform assignment, not single) |

### 3. Quality of Misconception Treatment
Each misconception must state: (a) what people commonly believe · (b) why it's wrong · (c) what's correct

Flag:
- States "this is wrong" without explaining what's correct
- Uses straw-man version of misunderstanding

### 4. Counterexample Coverage
- Theorems with scope limitations (locality condition, ceteris paribus) → at least one counterexample showing when theorem does NOT apply
- Flag: theorems claiming universality without boundary conditions

## Process
1. Identify all major concepts in chapter (definitions, theorems, principles)
2. Search for a misconception environment or a "Common Misconception"-style section (e.g., `commonconfusion`, `\begin{remark}[Common Misconception`, or similar patterns)
3. Cross-reference: each major concept → at least one misconception addressed?
4. For known topics (SRP, OCP, etc.) → check against table above
5. Evaluate misconception treatment quality

## Output
```
=== Misconception Audit: [chapter] ===
Major concepts found: N
Concepts with misconception coverage: M/N

Missing misconception coverage (WARNING):
  Definition "causal cohesion" — no misconception addressed
  Theorem "IVP Optimality" — no counterexample or boundary condition

Known misconceptions not addressed (WARNING):
  SRP: "one function per class" misconception not mentioned

Quality issues (INFO):
  [file:line] Misconception states what's wrong but not what's correct
```

