---
name: typst-write
description: Write or edit Typst (.typ) files with guaranteed syntax correctness. Uses pre-read discipline: reads syntax rules first, verifies against checklist, then writes content.
---

# Typst Write — Syntax-Correct Typst Content

Write or edit Typst (.typ) files with guaranteed syntax correctness.

## Usage

```
/typst-write <path-to-file>
/typst-write edit <path-to-file>
```

## Process

### 1. Pre-read Syntax Rules
Read the project's Typst syntax rules. Locate them at `.agents/context/typst-syntax-rules.md` when present; otherwise use the canonical rules at `src/main/typst/lib/typst-syntax-rules.md` or the checklist below as the fallback reference.

### 2. Verify Against Checklist
Check all syntax patterns before writing:
- [ ] Citations use `@label` format only
- [ ] Labels use `<label>` format, placed after closing bracket
- [ ] Math variables use `$...$`, literal dollars escaped as `\$`
- [ ] Environment names in parentheses: `#begin(itemize)` not `#begin itemize`
- [ ] Brackets balanced: count `]` matches `[`
- [ ] No Markdown backticks: use `#raw.code` or `#raw.codeblock`
- [ ] Heading hierarchy: `=` `==` `===` `====`
- [ ] Import paths include `.typ` extension
- [ ] Text formatting: `_emphasis_`, `*strong*`, not `**text**`

### 3. Verify Against Existing Code
```bash
# Check citation patterns
grep -r "#principle(" src/main/typst/ | head -3

# Check citation usage
grep -r "@[a-zA-Z]" src/main/typst/isp-is-dip/ | head -5

# Check environment syntax
grep -A5 "#principle(" src/main/typst/isp-is-dip/ch02-formulations/ | head -15
```

### 4. Write/Edit Content
After verification passes, write or edit the .typ file following:
- One sentence per line (better diffs)
- No trailing whitespace
- Empty lines between paragraphs
- Correct environment syntax
- Proper citation and label format

### 5. Build Verification
```bash
nix build .#typst-volume-N  # or appropriate volume
```

## Output

```
typst-write: PASS | FAIL
File: {target-file}
Syntax verification: OK | FAILED
Build: OK | FAILED
Errors: {list if any}
```

## Critical Syntax Rules

### Citations
✓ `@label` only
✗ `@label@`, `[@label]`, `@label.` (period attached)

### Math
✓ `$variable$` for math mode
✓ `\$100` for literal dollar signs
✗ Unescaped `$` in prose

### Environments
✓ `#principle(name: [Title])[ content ] <label>`
✓ `#begin(itemize)` ... `#end(itemize)`
✗ `#begin itemize` (missing parentheses)
✗ `#principle(name: [Title][ content ]` (extra bracket)

### Code blocks
✓ `#raw.code[...]` or `#raw.codeblock[...]`
✗ ```typst ... ``` (Markdown backticks)

### Text formatting
✓ `_emphasis_`, `*strong*`
✗ `**bold**`, `__underline__`

## Error Recovery

If build fails or syntax verification fails:
1. Review error message
2. Identify syntax violation
3. Check against the project's Typst syntax rules (`.agents/context/typst-syntax-rules.md` when present)
4. Fix and retry verification
5. Rebuild
