<!-- Change Driver: SDLC_ENFORCEMENT -->
<!-- Changes when: SDLC artifact-contract enforcement rules evolve -->

# SDLC Guardrails — Design Doc

## Purpose

Deterministic enforcement layer for an **AI-native SDLC artifact contract**. The
build/implement stage of a change must track an approved plan, tests must not be
weakened during a fix, and the artifact chain (`intent.md` → `spec.md` →
`plan.md` → diff/tests → incident record) stays in sync with the code it governs.

This is the **enforcement** half of the pattern. The **advisory** half (brainstorming,
plan-writing, review skills/agents) is a separate concern that already has homes in
this repo (`general-skills`, `scientific-writing`) and in mature external skill
libraries (e.g. superpowers). This plugin does **not** re-implement the skill layer —
it makes the contract *hold* once artifacts exist.

## Scope (what this plugin does / does not do)

| Does | Does NOT |
|------|----------|
| Enforce plan/diff synchronization (R1, incl. commit-time `sync`) | Write plans, specs, intents (advisory → skills) |
| Block edits to protected/frozen paths (R2) | Do research / analysis / review (→ audit agents) |
| Gate shell write operations (bash `cp`/`mv`/`rm`/`sed -i`/`tee`/redirection) | Force TDD on teams that opt out |
| Protect test files from weakening during a fix (R3) | Replace CI or a release board |
| Close the Maintain→Plan loop via `incident` (writes incident.md + new intent.md) | Auto-fire CI / auto-merge (opencode has no PR gate) |
| Validate artifact presence/shape before build | Enforce across repos it is not configured for |
| Record contract verdicts to an audit log |  |

Opt-in, per-repo. A repo adopts the contract by writing `intent.md`/`spec.md`/
`plan.md`; the plugin's hooks react only when those artifacts exist. A repo with no
artifacts is unaffected (everything passes). This preserves the repo's
advisory-not-mandatory philosophy: enforcement scales with the artifacts the team
actually writes.

## IVP Analysis

| Element | Change driver | Anchoring artifact |
|---------|--------------|--------------------|
| Plan/diff sync check | `SDLC_ENFORCEMENT` — plan steps must match the diff | committed `plan.md`, git diff |
| Protected-path block | `SDLC_ENFORCEMENT` — frozen/generated files immutable | path allowlist config |
| Test-protection check | `SDLC_ENFORCEMENT` — a fix must not weaken its proof | test-file paths + fix scope |
| Artifact-shape validation | `SDLC_ENFORCEMENT` — artifacts must be complete/parseable | `intent.md`/`spec.md`/`plan.md` templates |
| Verdict audit log | `SDLC_ENFORCEMENT` — decisions must be attributable | `.sdlc-guardrails/audit.jsonl` |
| Skill templates (`/intent` etc.) | `AGENT_INVENTORY` — artifact authoring guidance | templates in `skills/` |

All enforcement elements share the single driver `SDLC_ENFORCEMENT` (one contract,
one config, one audit log) → one plugin. The template skills differ in driver
(`AGENT_INVENTORY`) → separated into `skills/` sub-agents, composed with (not folded
into) the enforcement core. Advisory review agents already live in
`general-skills`/`scientific-writing` — not duplicated here.

## File Structure

```
sdlc-guardrails/
├── src/main/java/eu/infolead/llmhp/sdlcguardrails/
│   ├── ContractConfig.java        # repo contract config (paths, mode on/off)
│   ├── ArtifactDetector.java      # locate intent.md/spec.md/plan.md in repo
│   ├── PlanTracker.java           # parse plan.md tasks; check step coverage
│   ├── DiffGuard.java             # diff-vs-plan sync + protected-path + test-protection
│   ├── ShellCommandAnalyzer.java  # detect write targets inside shell commands (bash gating)
│   ├── GitDiff.java               # git diff --name-only wrapper (commit-time R1 sync)
│   ├── AuditLog.java              # append-only verdict log (JSONL, atomic)
│   ├── SdlcGuardrailsCli.java     # CLI entry: check, check-cmd, sync, incident, status, audit
│   └── SdlcGuardrailsException.java
├── src/test/java/eu/infolead/llmhp/sdlcguardrails/
│   ├── DiffGuardTest.java         # R1/R2/R3 enforcement
│   └── ShellAndLoopTest.java      # bash write-detection + incident loop
├── opencode/
│   ├── index.ts                   # tool.execute.before/after hooks + tools
│   └── index.test.ts
├── skills/                        # advisory template skills (composed, not core)
│   ├── intent/
│   │   └── SKILL.md
│   ├── spec/
│   │   └── SKILL.md
│   └── plan/
│       └── SKILL.md
└── agents/
    ├── plan-auditor.md            # checks a diff against the committed plan
    └── test-guard-auditor.md      # checks a diff for weakened tests
```

## Configuration

Per-repo JSON at `{root}/.sdlc-guardrails/config.json` (optional; defaults apply):

```json
{
  "enabled": true,
  "requirePlan": true,
  "requireVerification": true,
  "verifyEvidence": "tmp/eval-loop-score.md",
  "verifyFreshnessMs": 1800000,
  "protectedPaths": ["**/generated/**", "**/schemas/*.gen.go", "legacy/v1/**"],
  "planArtifact": "plan.md",
  "specArtifact": "spec.md",
  "intentArtifact": "intent.md",
  "auditLog": ".sdlc-guardrails/audit.jsonl",
  "testPaths": ["**/test/**", "**/tests/**", "**/*.test.*", "**/*_test.*"]
}
```

Defaults are safe: `enabled:false` unless a config or a `plan.md` exists (so a repo
that simply has a plan.md gets plan-sync enforcement with zero setup; everything else
stays advisory).

## Enforcement Rules (core logic)

### R1 — Plan/diff sync (DiffGuard)

When `requirePlan` is on and a `plan.md` exists, code edits outside the files the
plan declares are **flagged** (WARN, not blocked — a change can legitimately touch
more files; this is advisory-diff help). Files the plan does *not* cover that are
edited in a commit that claims to implement the plan are reported.

### R2 — Protected-path block (hard)

Edits to paths matching `protectedPaths` are **blocked** via `tool.execute.before`
(rejecting the edit). Deterministic: a skill only *advises*; this hook *enforces*.

### R3 — Test-protection (hard, during fix tasks)

When a session is in a "fix" task (declared via `/sdlc-fix` or the plan marks the
step as a fix), edits to files matching `testPaths` are **blocked** unless the diff
*adds* test coverage. A fix must not delete or weaken its proof.

### R4 — Artifact-shape validation (advisory, on commit)

Before a `plan.md`/`spec.md`/`intent.md` is committed, validate it parses against
the expected sections. Output is a WARN listing missing required sections — never a
block (the team owns its templates).

### R5 — Verdict audit log

Every check outcome (block/warn/pass) is appended to `audit.jsonl` with session id,
tool, path, rule, verdict, timestamp. The chain of commits + this log is the audit
trail: who asked for what, what the agent produced, who approved it.

### R6 — Verification-before-done (commit gate)

When `requireVerification` is on, a `git commit` is **blocked** unless fresh, all-green
verification evidence exists. Evidence is the `eval-loop` score snapshot
(`tmp/eval-loop-score.md`): one line per gate result per round, ending in `pass`, and
no older than `verifyFreshnessMs` (default 30 min). This is the **one rule that fails
closed** — its whole purpose is to refuse an unverified "done" claim. It composes with
the existing `eval-loop` skill: that skill produces the evidence; this rule enforces
that a commit cannot ship without it. When `requireVerification` is off, it passes
unconditionally.

## CLI Interface

```
sdlc-guardrails check <root> <tool> <path> [fixScope] [session]   → {"verdict":"pass|warn|block","rule":"R1|R2|R3","reason":"..."}
sdlc-guardrails check-cmd <root> <command> <fixScope> [session]   → gate write targets inside a shell command (bash)
sdlc-guardrails diff <root> <base> <head>                        → list changed files between refs
sdlc-guardrails sync <root> [base]                               → R1 at commit-time: in/out-of-plan diff report
sdlc-guardrails verify <root>                                    → R6: check verification evidence (commit gate)
sdlc-guardrails incident <root> <description>                    → write incident.md + scaffold new intent.md (loop close)
sdlc-guardrails artifact <root> <kind> <path>                    → validate intent/spec/plan shape
sdlc-guardrails status <root>                                    → contract status (artifacts found, rules active)
sdlc-guardrails audit <root> [limit]                             → tail verdict log
```

## Platform Integration (OpenCode index.ts)

| Hook/tool | Type | Purpose |
|-----------|------|---------|
| `tool.execute.before` | hook | Block edits to protected/test paths (R2, R3), gate bash write ops, and gate `git commit` on R6 verification evidence |
| `tool.execute.after` | hook | Audit the edit verdict + run diff-sync advisory (R1) |
| `command.execute.before` | hook | Intercept `/sdlc-fix` to mark session in fix scope (R3) |
| `sdlc-check` | tool | Run R1–R4 checks manually on a path |
| `sdlc-sync` | tool | Commit-time R1: check the diff against the plan |
| `sdlc-verify` | tool | R6: check verification evidence (commit gate) |
| `sdlc-incident` | tool | Close the Maintain→Plan loop (writes incident.md + new intent.md) |
| `sdlc-status` | tool | Contract status summary |
| `sdlc-audit` | tool | Tail audit log |
| `/sdlc-fix`, `/sdlc-plan` | command | Session-scope markers for test-protection + plan tracking |

## Cost

No API calls. All checks are string/path matching + git diff parsing. Per-edit cost
is O(diff size); a fresh JVM per call (matching repo convention). The `bash` tool is
gated by best-effort write-target detection (`ShellCommandAnalyzer`) — it never
executes or parses the command with a full shell, and any ambiguous target (glob,
`$VAR`) is skipped.

## Failure Mode

Fail-safe: any parse/config error → `pass` (never block on a broken contract). A
malformed `plan.md` degrades to advisory. Blocking requires an unambiguous
protected-path or test-protection match against a repo that opted in.

## Usage Flow

```
Adopt contract   → write intent.md → spec.md → plan.md (via /intent /spec /plan skills)
Freeze generated → add protectedPaths to config
Fix a bug        → /sdlc-fix → agent edits code; test edits blocked unless adding coverage
Ship             → sdlc-status + sdlc-audit show the trail
No contract      → hooks pass everything (unaffected repo)
```
