<!-- Change Driver: DESIGN_METHODOLOGY -->
<!-- Changes when: architectural principles evolve -->
<!-- Lazy-loaded reference file — load on demand when creating/modifying agents, configs, or workflows. Not injected by default. -->

# Design Principles

## Change-Driver Analysis

Before creating/modifying agents, configs, workflows:

| Step | Rule | Examples |
|------|------|----------|
| 1. Identify drivers | Independent factors causing change | Task reqs, domain knowledge, user prefs, technical deps, performance |
| 2. Separate (different drivers → different units) | Domain logic → specialized agents; general task handling → general patterns; user prefs → configuration; cost optimization → separate from task logic |  |
| 3. Unify (same driver → same unit) | All medical logic in medical agents; all LaTeX logic in LaTeX agents; all build logic in build agents |  |

## IVP Compliance

| Verdict | Pattern | Reason |
|---------|---------|--------|
| Good | Separate agents per domain | distinct domains |
| Good | Global config separate from project config | distinct scopes |
| Good | Workflows separate from agent definitions | distinct concerns |
| Good | Cost optimization separate from task execution | distinct drivers |
| Bad | Two domains' logic in one agent | different domains |
| Bad | User prefs + technical reqs in one unit | different drivers |
| Bad | Cost analysis + domain execution in one unit | different drivers |

## Application

| Element | Rule |
|---------|------|
| Agents | Single coherent change driver each |
| Configs | Global (user-wide) vs project (project-specific) |
| Workflows | Domain processes vs execution orchestration |
| Tools | Read/write/search separated by use pattern |

## Change-Driver Taxonomy

| Driver | Changes when... | Examples |
|--------|----------------|----------|
| `DOMAIN_LOGIC` | Domain understanding changes | LaTeX rules, medical protocols |
| `SECURITY_POLICY` | Security policies evolve | Protected files, destructive-op rules |
| `UX_REQUIREMENTS` | UX priorities shift | Visibility rules, output formats |
| `AGENT_INVENTORY` | Agents added/removed/modified | Agent list, capabilities |
| `IMPLEMENTATION_SPECS` | Technical infra changes | File paths, state formats |
| `DESIGN_METHODOLOGY` | Architectural principles evolve | IVP, design patterns |
| `USER_PREFERENCES` | User preferences change | Personal settings, defaults |

## Config Separation

| Scope | Location | Contains |
|-------|----------|----------|
| Global | `~/.config/opencode/` | User-wide defaults, personal prefs, cross-project guidelines, security baselines |
| Project | project root | Project overrides, domain agents, workflows, context-specific rules |

**Rule:** Project extends/overrides global; global provides safe defaults.

## Agent Single Responsibility

**Each agent requires:**
- One responsibility (what it does)
- One change driver (when it changes)
- Clear boundaries (what it does NOT do)

| Verdict | Pattern |
|---------|---------|
| Anti | "Does everything" for a domain |
| Anti | Mixes unrelated concerns |
| Anti | Multiple independent responsibilities |
| Anti | Handles both execution and cost optimization |
| Good | Specialist fixes one concern only |
| Good | Literature integration integrates citations only |

## Layered Architecture

```
L1: Decision  (what to do, how to approach)
 |
L2: Execution (doing the work)
 |
L3: Verification (validating the result)
```

Each layer = distinct change drivers. Never mix layers in one component.

## Change-Driver Comments

Tag config sections for auditability:

```markdown
<!-- Change Driver: CATEGORY_NAME -->
<!-- Changes when: [description] -->
```
