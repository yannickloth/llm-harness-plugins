# IVP — Independent Variation Principle (canonical reference)

Source: `ivp-book-series` — the graph-theoretic proof (volume-0/part3/ch20),
the four-conditions definitions (shared/four-conditions), change taxonomy
(volume-1/ch01), and the `def:variation-dependence` / `def:driver-scope`
definitions. Preprint: Loth, DOI `10.5281/zenodo.20794332`.

## Core claim

Given an element set `E`, a set of change drivers `C`, and an assignment
`Γ(e)` (drivers governing element `e`), the unique cost-minimizing module
partition groups elements by **identical driver sets** — the *Γ-equality
partition*.

Elements with identical `Γ(e)` belong in the same module.
Elements with different `Γ(e)` belong in different modules.

This partition uniquely minimizes the touched-module count (span) under any
positive weighting of driver activations. Deviation pays strictly more, either
by *scattering* same-driver elements (shotgun surgery) or by *mixing*
different-driver elements (impurity/cross-driver interference).

## Change driver (defined)

A **change driver** `γ ∈ C` is an *external* condition of the operating domain
whose change creates a requirement that governed elements be modified. It must
be anchored in a domain artifact: a statute, a contract, a protocol
specification, a business rule, a stakeholder commitment, a migration plan, a
draft spec under consultation.

Example categories (from the change taxonomy):
- Business rule changes (tax brackets, overtime policy, benefit types)
- Regulatory changes (GDPR, LGPD, PIPL, sector regulators)
- Platform / infrastructure changes (DB migration, provider API evolution, SAML→OIDC)
- User-experience / interface requirement changes
- Externally mandated quality targets (encryption-at-rest deadline, SLA)

### What a change driver is NOT (proxy grounding — forbidden)

Driver identity must be established from the structural identity of the
exogenous forcing condition, NOT by proxy. The following are NOT change drivers
and must not be used as evidence of driver existence/identity:

- Activation frequency (high churn ≠ a driver)
- Co-variation / co-modification history (files that changed together)
- Team ownership / decisional authority / org chart
- Module structure, layers, architecture
- Functional / semantic similarity
- Deployment or packaging units
- Dependencies or data flows
- Bounded contexts, use cases, security zones (as such)

If no domain artifact can be cited for a candidate driver, do not invent one:
omit it, or flag that driver identification needs more domain investigation.

### Identification protocol per candidate driver

```text
driver X creates a change requirement for element E because [pathway]
anchored in [artifact]
```

**Counterfactual test:** if the cited artifact were rewritten to remove the
relevant condition, would the requirement to change E disappear or shift?
- Yes → driver claim established.
- No → the claim rests on convention/proxy; revise or discard.

Two distinct external authorities (regulations, specs, governing bodies) = two
drivers, unless they impose conditions through a single shared document, in
which case they collapse to one driver.

## The four conditions for a cost-optimal modularization

1. **Admissibility** — every element has at least one driver: `|Γ(e)| ≥ 1`.
   `Γ(e) = ∅` means the element embodies no system knowledge; exclude it.
2. **Element Form** — every element is *pure* (`|Γ(e)| = 1`) or *irreducibly
   composite*. Reducible composites are split (see below).
3. **Separation** — different driver assignments → different modules.
   `Γ(e₁) ≠ Γ(e₂) ⇒ M(e₁) ≠ M(e₂)`. (*No mixing.*)
4. **Unification** — same driver assignment → same module.
   `Γ(e₁) = Γ(e₂) ⇒ M(e₁) = M(e₂)`. (*No scattering.*)

Only intra-module same-Γ coupling between two pure elements can be pushed to a
finer grain without breaking a condition. Coupling involving an irreducibly
composite element stays inside its parent module (it is proper to the module).

## Composite elements and decomposition

- **Irreducibly composite** (`|Γ(e*)| = n ≥ 2`): no proper subset of `Γ(e*)`
  preserves the element's purpose, and no decomposition into sub-elements with
  smaller assignments preserves it. Its multi-driver cost is forced by the
  domain. Keep it whole.
- **Reducibly composite** (`|Γ(e*)| = n ≥ 2`): EITHER (Case 1) a proper subset
  `A ⊊ Γ(e*)` already preserves purpose (drop the extra drivers), OR (Case 2)
  `e*` decomposes into sub-elements `e*_j` with `Γ(e*) = ∪ Γ(e*_j)` and
  `|Γ(e*_j)| < n`, jointly preserving purpose. Split it.

## Nesting (parent ⊂ child drivers)

Two elements/modules are candidates for a **parent/child (composed)**
relationship iff the parent's driver set is a strict subset of the child's:

```text
Γ(P) ⊊ Γ(C)
```

- `P` may exist alone; `C` only makes sense within `P`'s scope.
- The child inherits the parent's drivers PLUS its own additional drivers.
- Only apply nesting where the child's decomposition is a valid **reducible
  composite** (Case 2) — the extra drivers are genuinely separable while
  preserving purpose.
- Do NOT force-split a *pure* element or an *irreducible* composite into a
  parent/child pair, even if a subset relation could be manufactured. Doing so
  creates a Separation or Unification violation, or destroys purpose.
- Non-subset pairs are **siblings** (or top-level): driver sets partially
  overlap, differ, or are disjoint.

Procedure: first compute the flat Γ-equality classes (siblings by
construction); then, within a class or across classes, apply the strict-subset
test with the reducibility guard; nest only where both hold.

## Span and the two lemmas (why the partition is optimal)

- **Lemma 1 (anti-scatter):** splitting a Γ-class strictly increases the
  touched-module count for every shared driver. → Unification.
- **Lemma 2 (coarsening) + contamination premise:** merging distinct Γ-classes
  reduces pure span for shared drivers but introduces contamination (verify
  irrelevant co-located elements) for distinguishing drivers. Under the
  contamination premise, contamination dominates → Separation.

The contamination premise is the one empirical (non-definitional) assumption:
within-module verification of an element irrelevant to a driver imposes
non-zero effort.

## Worked example (checkout system)

`E = {pricing, tax, payment}`,
`Γ(pricing) = Γ(tax) = {tax}`,
`Γ(payment) = {tax, payment}`.

Γ-equality partition: `{{pricing, tax}, {payment}}` — pricing & tax share the
tax driver; payment is separate (adds the payment driver).
- Splitting `{pricing, tax}` raises tax-span from 2 to 3 (Lemma 1 violation).
- Merging all three lowers pure tax-span but contaminates the `{payment}`
  partial — a payment change would force verifying pricing/tax are unaffected.

## Applying IVP to a codebase — reading the formal objects

| Formal concept | In code |
|---|---|
| Element `e ∈ E` | attribute, method/function, closure, local (scoped) variable, class, module, config key |
| Change driver `γ ∈ C` | externality: regulation, contract, protocol, business rule, platform, UX mandate |
| Assignment `Γ(e)` | the set of external conditions whose change forces `e` to change |
| Module | class, package, closure boundary, source unit |
| Driver registry | the codebase's native doc convention (Javadoc / docblock / doc comment) storing the driver list beside the code |
