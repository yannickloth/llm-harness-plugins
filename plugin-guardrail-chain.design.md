# Guardrail Chain — Design Doc

## Architecture

```
                    ┌─────────────────┐
                    │  Plugin request  │
                    └────────┬────────┘
                             │
                    ┌────────▼────────┐
                    │  GuardrailPipeline│
                    │  .runInputFilter │  ← Pre-execution
                    └────────┬────────┘
                             │ pass
                    ┌────────▼────────┐
                    │  Tool executes   │
                    └────────┬────────┘
                             │
                    ┌────────▼────────┐
                    │  GuardrailPipeline│
                    │  .runOutputFilter│  ← Post-execution
                    └────────┬────────┘
                             │ pass
                    ┌────────▼────────┐
                    │  Plugin response │
                    └─────────────────┘

Pre-write pipeline (entry point: preWrite gate):
  SecretScanner → PromptGuard → PathValidator
                                            → blocked → reject write
                                            → pass    → proceed
```

## File Structure

```
guardrail-chain/
├── src/main/java/eu/infolead/llmhp/guardrails/
│   ├── GuardrailPipeline.java       # Pre/post execution filter chain
│   ├── GuardrailPipelineCli.java    # CLI entry point
│   ├── SecretScanner.java           # API key + token patterns
│   ├── PathValidator.java           # Symlink traversal, containment, name regex
│   ├── PromptGuard.java             # Injection patterns, size bounds
│   └── types/
│       ├── GuardResult.java         # Pass | Warn(source, msg) | Block(source, msg)
│       └── GuardConfig.java         # Per-plugin: which filters, severity
├── src/test/java/eu/infolead/llmhp/guardrails/
│   └── GuardrailPipelineTest.java   # 25 test cases
├── opencode/index.ts
└── prompts/agent-prompt.md
```

## Data Types

### GuardResult (sealed interface)

| Variant | Fields | Meaning |
|---------|--------|---------|
| `Pass(source)` | source: String | Filter passed, no issue |
| `Warn(source, message)` | source, message | Issue found, advisory |
| `Block(source, message)` | source, message | Issue found, must stop |

### GuardConfig (record)

| Field | Type | Meaning |
|-------|------|---------|
| `enableSecretScan` | boolean | Scan for API keys, tokens |
| `enablePathValidation` | boolean | Validate file paths |
| `enablePromptGuard` | boolean | Injection + size check |
| `enableSizeBounds` | boolean | Reject oversized content |
| `blockOnCritical` | boolean | Block (vs warn) on critical |

Factory methods: `all()`, `warnOnly()`, `none()`

### PipelineResult (record)

| Field | Type | Meaning |
|-------|------|---------|
| `results` | List\<GuardResult\> | All filter results |
| `blocked()` | boolean | Any Block in results |
| `warnings()` | boolean | Any Warn in results |
| `blocks()` | List\<Block\> | All blocking results |

## Pipeline Methods

| Method | Filters run | Use case |
|--------|------------|---------|
| `runInputFilter(prompt)` | PromptGuard, SecretScanner | Before processing user input |
| `runOutputFilter(output)` | SecretScanner, PromptGuard | After LLM response, before write |
| `runPreWrite(content, target, dir, protected)` | SecretScanner, PromptGuard, PathValidator | Before Write/Edit tool |
| `runAll(content, target, dir, protected, name)` | All filters | Generic full scan |

## CLI Interface

```
java GuardrailPipelineCli.java scan-secrets [content|-stdin]        → JSON {result, source, message}
java GuardrailPipelineCli.java check-path <target> <containment>    → JSON
java GuardrailPipelineCli.java check-name <name>                    → JSON
java GuardrailPipelineCli.java check-injection [prompt|-stdin]      → JSON
java GuardrailPipelineCli.java check-size [content|-stdin] [max]    → JSON
java GuardrailPipelineCli.java pre-write <target> <dir> <content>   → JSON {blocked, warnings, blocks[], warns[]}
java GuardrailPipelineCli.java input-filter [prompt|-stdin]         → JSON
java GuardrailPipelineCli.java output-filter [output|-stdin]        → JSON
```

## Detection Patterns

### SecretScanner (8 patterns, word-boundary anchored)
```
\bsk-[a-zA-Z0-9_-]{30,}     # OpenAI keys (30+ chars after prefix)
\bAKIA[A-Z0-9]{16}\b         # AWS access keys
\bghp_[a-zA-Z0-9]{36,}\b     # GitHub personal access (classic)
\bgithub_pat_[a-zA-Z0-9_]{22,}\b  # GitHub fine-grained PATs
\bxox[bprs]-[a-zA-Z0-9-]+\b  # Slack tokens
-----BEGIN( RSA| DSA| EC| OPENSSH)? PRIVATE KEY  # PEM headers
\bAIza[0-9A-Za-z_-]{35}\b   # Google API keys
\bya29\.[0-9A-Za-z_-]+\b    # Google OAuth tokens
```

### PromptGuard injection patterns
```
ignore (all )?(previous|prior|above) (instructions?|prompts?|directives?|rules?)
you are (now )?(DAN|jailbroken|uncensored)
pretend (you are|to be)
start every (response|answer|reply) with
system: (you must|ignore|override)
```

**Zero-width character detection**: `U+200B`, `U+200C`, `U+200D`, `U+00AD`, `U+FEFF`, `U+2060` — common injection bypass vectors.

### PromptGuard size bounds
Default: 500KB. Configurable per-call.

### PathValidator
- Symlink resolved → checked containment (including parent hierarchy walk)
- Parent directory containment check
- Protected file list (configurable)
- Name regex: `[a-zA-Z0-9_-]+` (for safe filenames)
- Zero-width character detection on all input scans

## Platform Integration

### OpenCode (index.ts)
- 3 tools: `scan-secrets`, `check-injection`, `check-path`
- `file.edited` event: output-filter on every file edit

## IVP Analysis

| Element | Change driver | Artifact |
|---------|--------------|----------|
| `SecretScanner` | Credential format changes | Vendor API key format docs |
| `PathValidator` | File system security standards | OS security guidelines |
| `PromptGuard` | Injection attack patterns | OWASP LLM Top 10, red-team findings |
| `GuardrailPipeline` | Filter composition needs | Plugin integration contracts |
| `GuardConfig` | Per-plugin security policy | Plugin manifest schemas |

SecretScanner, PathValidator, PromptGuard share one driver (security threat catalog) but have different sub-drivers → separate files in same module per IVP. GuardrailPipeline changes when any filter's interface changes → composition boundary. GuardConfig changes when plugin manifests change → separate type unit.

## Cost

No API calls. All checks are regex + path operations. O(n) on content length, sub-millisecond per check. Zero runtime cost beyond CPU.

## Integration with agentmem

agentmem's current guards (in MemoryStore.java, QualityGateRunner.java, PathValidator.java) delegate to this pipeline:

| agentmem gate | guardrail-chain equivalent |
|---------------|---------------------------|
| gate7Secrets (QualityGateRunner.java) | SecretScanner.scan() |
| PathValidator.validateName() | PathValidator.validateName() |
| PathValidator.validate(target, memDir) | PathValidator.validate(target, containment) |
| SaveInput name regex | PathValidator.validateName() |
| gate2SizeBounds | PromptGuard.checkSizeBounds() |
