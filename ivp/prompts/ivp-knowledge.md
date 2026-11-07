# IVP — Independent Variation Principle (reference)

**Status: restatement for application work, not the canonical text.**
For any formal claim (a definition, a theorem, a hypothesis, a scope limit), read
the canonical source and quote it. Do not cite this file as authority.

Sources, in order of precedence:

| Source | Path | Use for |
|---|---|---|
| Paper | `ivp-book-series/src/main/latex/ivp/ivp-graph-proof-2/` | `prc:ivp` (four directives, `ch02-graph-model.tex:340-372`), `thm:uniqueness` and the hypothesis ledger `tab:ledger` (`ch04-ivp.tex:98-185`), `def:change-driver`, `def:element-form`, `def:separation` |
| Shared definitions | `ivp-book-series/src/main/typst/shared/four-conditions/` | the four conditions, one file per condition |
| Change taxonomy | `ivp-book-series/src/main/typst/volume-1/part1/ch01/` | driver families and worked examples |
| Web | `https://yannickloth.github.io/independentvariation/ivp-software/` | the six-step application process, the notification worked example |
| Published | Loth, *The Independent Variation Principle*, Zenodo 2026, `10.5281/zenodo.20794332` | citable artifact for the above |

Paper title: *The Independent Variation Principle: Deriving Module Boundaries
from the Element–Change-Driver Graph*.

---

## 0 Applicability gates

Build the model before you apply the principle. If a gate fails, report
`NOT APPLICABLE` with the reason. Do not manufacture a `Γ` to satisfy a request.

| Gate | Requirement | If it fails |
|---|---|---|
| G1 Boundary and grain | A system boundary and **one** element grain can be stated | Ask for them. Never mix grains in one partition |
| G2 Anchors | Each driver candidate is anchorable in a governing artifact | Flag the unanchored drivers. Do not invent artifacts |
| G3 Enumerability | `E` and `C` are finite and listable at the stated grain | Narrow the scope |
| G4 Question | The question is *where an element belongs* | Stop: IVP decides placement only |

IVP does not decide correctness, performance, security, deployment topology, or
team allocation. Those axes may enter the analysis as *drivers*, and they keep
their own optimisation. A request to "use IVP" for one of them is a gate failure,
not a variant of the method.

---

## 1 What IVP is

IVP is a **criterion, not a recipe**. It is stated over a software system

```text
S = (F, κ_F, E, C, Γ)
```

- `F` — the functional purpose.
- `κ_F` — the relevant causal domain knowledge: the anchored domain conditions
  the system must realize.
- `E` — the finite set of elements: the artifacts inside the system boundary.
- `C` — the finite set of change drivers.
- `Γ` — the assignment `Γ : E → 2^C`: the drivers whose state change requires
  the element to be modified.

Once `Γ` is fixed, the principle determines the module structure. It does not
suggest a structure.

## 2 The statement: four directives (`prc:ivp`)

IVP **is** the conjunction of four directives. State all four. Two constrain the
elements, two constrain the modularisation.

| Directive | Name | Content |
|---|---|---|
| **IVP-1** | Element admissibility | `\|Γ(e)\| ≥ 1` for every `e ∈ E`. No element without a driver. |
| **IVP-2** | Change-driver assignment / Element Form | `γ ∈ Γ(e)` exactly when `e` realizes part of `κ_γ`; and every element with `\|Γ(e)\| > 1` has an **irreducible** assignment. |
| **IVP-3** | Unit purity (Separation) | `Γ(e₁) ≠ Γ(e₂) ⇒ M(e₁) ≠ M(e₂)`. No module holds two driver classes. |
| **IVP-4** | Unit completeness (Unification) | `Γ(e₁) = Γ(e₂) ⇒ M(e₁) = M(e₂)`. Every driver class lies in one module. |

**The biconditional is a consequence, not the statement.**
`M(e₁) = M(e₂) ⟺ Γ(e₁) = Γ(e₂)` is IVP-3 and IVP-4 jointly. Never present it as
the formulation: that reduces IVP to a partition-level criterion and drops IVP-1
and IVP-2.

The conjunction admits exactly one modularisation — the quotient
`P_Γ = E/∼_Γ`, whose modules are the Γ-equivalence classes — and it exists
whenever IVP-1 and IVP-2 hold (`prc:ivp`, consequences).

## 3 What is a theorem, not a statement

Whether a **cost-optimal** modularisation satisfies the four directives is a
**result**, not part of the principle (`ch02-graph-model.tex:375`, remark "Status
of the structural directives").

The result is `thm:uniqueness`: `P_Γ` is the unique minimiser of the counting
objective

```text
K(P) = ρ(P) + σ(P)
```

where `ρ` charges the irrelevant elements an activation reads in every module it
touches, and `σ` charges the displaced elements it touches, weighted by the
coordination surcharge `s`.

`thm:uniqueness` holds only under these hypotheses (`tab:ledger`). Quote them
whenever you claim optimality:

| ID | Kind | Hypothesis | If it fails |
|---|---|---|---|
| S1 | scope | Maintenance dominates lifecycle cost. | The optimisation is vacuous, not wrong. |
| S2 | scope | The supplied `Γ` is correct (counterfactual test). | `P_Γ` is optimal for the wrong system. |
| T1 | structural | Every element satisfies Admissibility and Element Form. | Repair the elements first. |
| T2 | structural | `Γ` is given. | Nothing to partition by. |
| T3 | structural | Every driver activates: `λ(γ) > 0`. | Splitting a class whose drivers never activate is free; uniqueness fails. |
| T4 | structural | `E`, `C`, and the activation counts are finite. | `K` is undefined. |
| M1 | idealisation | `λ` is exogenous. | The weights depend on the partition. |
| M2 | magnitude | Reading an irrelevant element costs. | Every partition whose modules are unions of whole Γ-classes ties at `K = 0`. |
| M3 | empirical | A displaced element costs more than a co-located one, `s > 0`. | Every contamination-free partition ties; uniqueness fails. |

The boundary cost `Ω` — establishing and keeping modules — is **not** a
hypothesis. It is excluded from the objective as a scope decision. If boundary
work is not negligible, the objective gains a per-module term and `P_Γ` is
optimal only under a bound on that price. Challenge that scope decision first.

**Rule: no hypothesis, no claim.** Never write "the Γ-partition is optimal"
without T1–T4 and M2–M3 in the same breath, and never present the directives as
"conditions for a cost-optimal modularisation". The directives are the
principle; optimality is the theorem.

Two consequences of that separation:

- **Compliance needs no hypothesis.** Checking IVP-1…IVP-4 against a structure
  needs only `E`, `C`, and `Γ`. It needs no cost model, no weights, and no `Ω`.
  Do not import the ledger into a compliance report; do not omit it from a cost
  claim.
- **`λ(γ)` is a cost input, not a compliance input.** Activation counts appear
  only in `K` (T3, M1). A refactor to `P_Γ` needs none. Do not invent counts, and
  do not demand them.

## 4 Change driver

A **change driver** `γ ∈ C` is an anchored condition of the operating domain
whose state change creates a requirement that governed elements be modified.
Two constitutive criteria (`def:change-driver`):

1. **Artifact anchoring.** The condition is stated in a governing artifact,
   from primary (legislation) to tertiary (demand evidence).
2. **Causal pathway.** For every candidate edge `(condition, element)` the
   pathway from the artifact's amendment to the required modification is
   step-by-step reconstructable, every link documentable.

**Verification — the counterfactual test**, run per edge: if the amendment unit
anchoring the condition were rewritten to remove it, the requirement to modify
that element would disappear. Pass → the condition is an anchored driver for
that element. Fail → mis-analysis, not a driver.

**Single-anchor convention.** Each condition is assigned to exactly one
amendment unit of exactly one governing artifact. This is a modelling
requirement, not a consequence of documentability. Two conditions co-vary iff a
single amendment unit covers both. Co-variation is an **institutional** relation
(a shared amendment unit), never measured co-movement; revision history is
evidence, not the criterion.

**Identification tests** (web, step 2):

- *Who asks for this change?* Name the artifact and the authority.
- *Independent clock:* can this source change without forcing the others to
  change?

Two distinct external authorities = two drivers, unless both impose conditions
through one shared document, in which case they collapse to one driver.

### What a change driver is NOT (proxy grounding — forbidden)

Driver identity comes from the structural identity of the exogenous forcing
condition, not from a proxy. These are **not** drivers and must not ground one:

- activation frequency / high churn
- co-variation or co-modification history
- team ownership, decisional authority, org chart
- module structure, layers, architecture
- functional or semantic similarity
- deployment or packaging units
- dependencies, data flows
- bounded contexts, use cases, security zones (as such)

If no artifact anchors a candidate, do not invent one: omit it, or flag that
driver identification needs more domain investigation.

## 5 Elements: purity is a module property

An **element** is **single-driver** (`|Γ(e)| = 1`) or **irreducibly composite**
(`def:element-form`). Note the word: single-driver, not "pure".

**Purity constrains modules, never elements** (`def:separation`). IVP-3 is the
purity directive, and it quantifies over modules. A multi-driver element is not
a defect; the module-level directives decide that. The module of an irreducibly
composite element is *necessarily* multi-driver — that is the domain's cost, not
a violation.

- **Reducibly composite** (`|Γ(e*)| = n ≥ 2`): EITHER (Case 1) a proper subset
  `A ⊊ Γ(e*)` already preserves purpose, OR (Case 2) `e*` decomposes into
  sub-elements with strictly smaller driver sets whose union is `Γ(e*)`, jointly
  preserving purpose without mutual adjustment. Decompose it, recursively.
- **Irreducibly composite**: no such decomposition preserves the element's
  contribution to `F` without mutual adjustment. Keep it whole.

A reducible composite is the signature of an over-broad `Γ`, corrected upstream.
Decomposition refines `Γ`; it does not change the optimal value.

## 6 The Γ-equivalence partition

`e₁ ∼_Γ e₂` iff `Γ(e₁) = Γ(e₂)`. This is an equivalence relation, so it
partitions `E` into classes. Distinct classes carry different driver sets; their
sets may overlap, and in general do. `P_Γ = E/∼_Γ`.

Operational reading:

- Same `Γ(e)` → same module (IVP-4, Unification). Do not scatter.
- Different `Γ(e)` → different module (IVP-3, Separation). Do not mix.
- Merge only on *exact* equality. A shared subset is not a shared module.

### The two defect charges

Each departure from `P_Γ` is priced, and by a different charge:

| Defect | Condition | Charge | Failure name |
|---|---|---|---|
| A module holds two Γ-classes | IVP-3 | `ρ` — reading elements the activation does not govern | impurity / cross-driver interference |
| A class is split across modules | IVP-4 | `σ` — coordinating displaced class-mates | scattering / shotgun surgery |

In the paper these are `lem:coarsening` (reading and purity) and `lem:splitting`
(displacement and splits). M2 is what makes `ρ` cost; M3 is what makes `σ` cost.
Without M2 and M3, both counts are free and every whole-class partition ties.

## 7 Nesting — engineering extension, not part of `prc:ivp`

`prc:ivp` partitions `E` into modules and says nothing about a containment tree.
The rule below is the harness's extension for code trees. Label it as an
extension whenever it is used.

### What nesting means here

Nesting places one **module** inside another module's **namespace**. It does not
merge element sets:

- The parent module and the child module are two distinct modules, each of them
  one Γ-class. The partition is unchanged by nesting.
- **Purity is a property of a module, not of a namespace.** A namespace that
  contains two modules of different classes is not impure — it contains two
  modules. Report an IVP-3 violation only when a single *module* holds elements
  of two classes.
- A parent's own elements all carry one assignment set; the child's elements
  carry another. Containment expresses "the child is about the parent's concern
  and more", never "the child's elements joined the parent's module".

```text
C may be nested inside P  only if  Γ(P) ⊊ Γ(C)  AND  γ(P) causally preconditions C
```

- `P` stands alone without `C`; `C` is authored inside `P`'s scope.
- Equality → same class, so the same module: not a nesting. Partial overlap or
  disjoint → siblings; there is no containment rationale.
- **Causal-existence condition (mandatory).** The strict-subset test is necessary
  and **not sufficient**. Nesting asserts that `C` exists *because* `P`'s driver
  exists: `C` extends a concern that `P`'s driver already creates, so removing
  `P`'s driver would remove `C`'s reason to exist. A subset that holds only
  because two sets happen to line up is a **coincidental subset** — the pair is
  then a **sibling**, not a loose nesting. Test per edge: *if `P`'s driver did not
  exist, would `C` still have a reason to exist?* Yes → sibling.
- Direction matters. Ask which side is the precondition. A child whose vocabulary
  is derived *from* the parent's driver nests; a child that merely *emits into*
  the parent's driver does not — the parent is its sink, not its cause.
- **Rationale guard:** nest only a child that is a reducible composite (Case 2).
  The containment asserts that the child's extra drivers are separable additions
  to the parent's concern. For a single-driver element there are no extras; for
  an irreducible composite the extras are not separable. Either way the
  containment asserts a decomposition that does not exist. Keep such a child as
  a sibling and record the rejected candidate.
- **Dependency direction:** the child may import the parent; the parent must not
  import the child's core. A parent that calls into a nested child has inverted
  the containment and re-coupled the two concerns.

Without the causal clause the subset test degenerates: any two modules sharing a
driver get bundled, and the tree accretes instead of expressing the domain. The
subset relation then means *subsetness*, not *subsumption*.

Do not present nesting as a consequence of the partition theorem, and do not
charge a namespace with a purity violation.

## 8 Six-step application process

From the web's "How to Apply IVP". Iterative, not mechanical; depth
proportionate to the system's lifetime and rate of change.

| Step | Action | Harness |
|---|---|---|
| 1 | **Identify the elements.** Choose the grain: functions, classes, methods, data structures, modules. | `/identify-change-drivers` → `driver-identifier` |
| 2 | **Identify the change drivers.** Discovery, not invention: *who asks?* and *independent clock*. | same |
| 3 | **Map drivers to elements.** Build `Γ`; record single-driver or composite per element. | same, output = registry |
| 4 | **Assess the current modularisation.** Compare the existing structure to `P_Γ`; name the violations: which modules are impure (IVP-3), which are incomplete (IVP-4). | `/assess-ivp` → `current-modularization-auditor` |
| 5 | **Refactor toward compliance.** Split mixed modules, merge scattered classes. | `/sort-into-modules` → `gamma-modularizer`, `nest-decider` |
| 6 | **Verify and iterate.** Re-check the assignment and the partition as understanding deepens. | `/review-ivp-to-convergence` → `ivp-refactor-auditor` |

`/apply-ivp` runs all six in order with the review gates between them.

## 9 Worked example — notification system

Nine methods of one class `NotificationService` (`M_notify = {e₁…e₉}`), three
drivers `C = {γ_content, γ_channel, γ_policy}`:

| Element | `Γ(e)` | Form |
|---|---|---|
| `resolveTemplate` | `{content}` | single-driver |
| `renderContent` | `{content, policy}` | irreducible composite |
| `deliverEmail` | `{channel}` | single-driver |
| `deliverSMS` | `{channel}` | single-driver |
| `deliverPush` | `{channel}` | single-driver |
| `checkPreferences` | `{policy}` | single-driver |
| `enforceRateLimit` | `{policy, channel}` | irreducible composite |
| `logDelivery` | `{policy, channel}` | irreducible composite |
| `formatForChannel` | `{content, channel}` | irreducible composite |

`P_Γ` has six classes:

| Module | Elements | `Γ(M)` |
|---|---|---|
| `M₁` | `{resolveTemplate}` | `{content}` |
| `M₂` | `{deliverEmail, deliverSMS, deliverPush}` | `{channel}` |
| `M₃` | `{checkPreferences}` | `{policy}` |
| `M₄` | `{renderContent}` | `{content, policy}` |
| `M₅` | `{formatForChannel}` | `{content, channel}` |
| `M₆` | `{enforceRateLimit, logDelivery}` | `{policy, channel}` |

Assessment of the monolithic as-is structure: IVP-1 ✓, IVP-2 ✓ (all four
composites irreducible), IVP-3 **violated** (six distinct assignment sets in one
module — the god module), IVP-4 trivially ✓ (one module cannot scatter).

Assessment of a layer-first attempt (`content`, `transport`, `logic`,
`logging`): IVP-3 **violated** in three of four modules and IVP-4 **violated** for
`γ_policy` and `γ_channel`. Technical category is not a driver.

Propagation (web, step 6): when `γ_content` activates, `e₁, e₂, e₉` must change
— 3 elements. The monolith touches 9; `P_Γ` touches 3. Composite elements make
the per-driver footprint large (`γ_channel` forces 6 elements across 3 modules),
but IVP cannot reduce the required set; it only ensures nothing outside it is
touched. Report the unnecessary touches, never the required ones.

## 10 Formal objects in code

| Formal concept | In code |
|---|---|
| Element `e ∈ E` | attribute, method/function, closure, scoped variable, class, module, config key |
| Change driver `γ ∈ C` | externality: regulation, contract, protocol, business rule, platform, UX mandate |
| Assignment `Γ(e)` | the set of external conditions whose change forces `e` to change |
| Module `M` | class, package, closure boundary, source unit |
| `P_Γ` | the module set the registry implies |
| Driver registry | the codebase's native doc convention (Javadoc / docblock) storing the driver list beside the code |

### Registry format

The registry is the single authoritative artifact. Keep it machine-readable and
identical in structure across languages:

```text
@ivpRegistry version=1 status=PROVISIONAL grain=<function|method|class|module>
@ivpDriver γ_name artifact="<governing artifact>" governs="e1, e2, ..."
...
@ivpElement e_name file=<path:line> gamma="{γ_a, γ_b}" form=<single|irreducible>
```

Rules: one `@ivpDriver` per driver, one `@ivpElement` per element, `governs`
and the element set must agree, `status` flips to `AUDITED` only after Gate A
passes, and a re-run reports a diff instead of overwriting.

| Language | Where the registry lives |
|---|---|
| Java | Javadoc on the root package, `@ivpDriver` / `@ivpElement` tags |
| Python | module docstring, `:ivp-driver:` / `:ivp-element:` fields |
| TypeScript / JavaScript | JSDoc block at the top of the module file |
| Go | package doc comment |
| Rust | `//!` module docs |
| C# | XML doc on the namespace's anchoring type |
| Other | the platform's module-level doc block |

### Boundary decisions

Files that carry no change decision — build scripts, generated code, vendored
dependencies, tooling — are **outside the system boundary**, so they are not
elements. Say so explicitly in the report. Do not force them into a class, and do
not treat their absence as an Admissibility violation.

## 11 Prohibited framings

| Framing | Why it is wrong |
|---|---|
| "Primary / dominant / main / secondary driver" | No driver ranking. All drivers in `C` are drivers. |
| Grounding a driver in a proxy (history, teams, layers, frequency, similarity) | Proxy, not driver. |
| "Design eliminates / moves / creates a driver" | Drivers are external and fixed. Design changes placement only. |
| "This driver is unlikely, so it is not a driver" | Existence is causal, not probabilistic. Rarity informs isolation depth. |
| "X and Y sit in one module, so they share a driver" | Causal reversal. Driver → grouping, never the reverse. |
| "Every element is pure" | Purity constrains modules. Elements are single-driver or irreducibly composite. |
| "The Γ-partition is optimal" (bare) | The theorem needs S1–S2, T1–T4, M2–M3, and the `Ω` exclusion. |
| "IVP prescribes four conditions for a cost-optimal modularisation" | The directives are the principle; optimality is a result. |
| IVP applied to prose, configs, directory layout without a flag | Empirical for software; elsewhere the step is analogical and must be flagged. |
