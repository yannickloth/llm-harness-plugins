<!-- Change Driver: DESIGN_METHODOLOGY -->
<!-- Changes when: architectural principles (IVP) evolve -->
<!-- Lazy-loaded reference file — load on demand for grouping/separation/refactor decisions. Not injected by default. -->

# Independent Variation Principle (IVP) — Operating Instructions

**Framing:** IVP operationalizes Dijkstra's Separation of Concerns. SoC says separate concerns but leaves "concern" undefined; IVP defines a concern as a change-driver set and supplies concrete, checkable rules for when elements share a concern (same driver set → group) and when they do not (differing driver sets → separate). Treat IVP as the operational form of SoC, not a competing principle.

**Scope of this definition:** the rules below are an operational restatement of IVP, intended to meta-organize the tool's own work (grouping decisions, file splits, refactors, agent design). They are NOT the canonical definition. When working on books, papers, or formal documents *about* IVP, use the formal definitions developed in those works (e.g., the IVP book series with its system tuple, four directives, and verdict taxonomy) — do not substitute or paraphrase from this section.

You apply IVP to all grouping/separation decisions for elements (functions, classes, files, modules, services, config keys, document sections, directories, or any unit within a decomposition decision).

## CORE RULE

A **change driver** is an external condition in the operating domain that, when it changes, creates a requirement for an element to be modified, via a documentable step-by-step pathway anchored in a domain artifact (statute, contract, specification, standard, migration plan, product-vision document, draft spec under active consultation, stakeholder commitment).

**Grouping rule**, applied at boundaries (class, file, module/package, service):

- **Driver sets coincide** (exactly equal) → same side of boundary.
- **Driver sets differ** (at least one driver in one but not the other) → opposite sides of a boundary appropriate to the granularity of the difference. A sub-unit boundary inside a module suffices when the differing driver is contained; a separate file/module/service is required only when the granularity warrants.
- **Partial overlap** (share some, each has unique) is the common case and is a sub-case of "differ" — separate at appropriate granularity.

Within a shared-driver group, sub-splits for size, readability, performance, cognitive load are freely available and require no IVP justification — but should be labeled as such (not as IVP-prescribed) so future reviewers can tell.

## DRIVER IDENTIFICATION PROTOCOL

For each element under analysis, before proposing any grouping:

1. **State drivers explicitly** in the form: `driver X creates a change requirement for element E because [pathway]; anchored in [artifact]`.
2. **Counterfactual test** for each driver claim: if the cited artifact were rewritten to remove the relevant condition, would the requirement to change this element disappear or shift? Yes → driver claim established. No → claim rests on convention; revise or discard.
3. **If no artifact can be cited**: do not invent one. Either (a) treat the element as having no distinct driver and consider merging with another, (b) flag that driver identification requires more domain investigation, or (c) ask the user for the relevant domain artifacts.
4. **Granularity criterion**: two distinct external authorities (different statutes, different specifications, different governing bodies) is strong evidence for two drivers, unless the authorities impose conditions through a single shared document, in which case they collapse to one driver. Use the finest level the artifacts support; do not go finer.

## HARD CONSTRAINTS

The following are violations and must not appear in your output:

| Violation | Description |
|-----------|-------------|
| **Driver ranking** | Never use "primary," "dominant," "main," "secondary," or any ranked/typed driver vocabulary. All drivers in the analysis are drivers; activation frequency and scope inform sequencing of work, not driver identity. |
| **Proxy reasoning** | Never substitute the following for actual driver analysis: co-variation (files that change together), team ownership, layer uniformity ("this layer always changes for the same reason"), component type, semantic similarity, co-location, file extension, change frequency. Each is a signal to investigate the actual driver, not a driver itself. |
| **Driver elimination by design** | Never claim that abstraction, encapsulation, or any design choice eliminates a driver. Design bounds the blast radius (which elements must change when a driver activates); the driver itself originates outside the system and disappears only when the domain changes. |
| **Existence-by-probability** | Never condition driver existence on historical frequency, predicted likelihood, or business priority. Rarity informs how much isolation infrastructure to build, not whether the driver counts. |
| **Causal reversal** | Never infer drivers from existing groupings ("X and Y are in the same module, so they must share a driver"). The direction is: shared driver → group together. Observed cohesion does not establish a driver. |
| **Fabricated artifacts** | Never invent a regulation, contract clause, or specification to anchor a driver claim. If the artifact is not cited by the user, ask or flag the gap. |
| **Domain-overreach** | IVP is empirically grounded for software. For other artifact domains (docs, configs, files), apply IVP analogically and flag the analogical step. |

## DECISION PROCEDURE

For any grouping task:

```
1. Enumerate elements.
2. For each element, identify drivers per Driver Identification Protocol.
   If artifacts are missing, ask or flag — do not invent.
3. Compute driver-set relationships pairwise (coincide / differ / partial overlap).
4. Apply Grouping Rule:
   - Coinciding sets → same side.
   - Differing sets → boundary at appropriate granularity (sub-unit inside
     module suffices when differing driver is contained).
5. Cross-check with layer/topic/convention groupings:
   - Aligned → conventional grouping is sound (REST, MVC, hexagonal,
     controller/service/repository often track driver structure).
   - Diverged → on the change-coupling axis, the driver structure indicates
     the appropriate grouping; revising the layer organization is one option,
     but other axes (security, performance, deployment, team allocation) may
     justify keeping the layered structure. Document the divergence
     symmetrically: state both the driver analysis and the other-axis
     constraint, then state which composition you propose and why.
6. Label every separation as IVP-prescribed (driver-driven) or
   readability-prescribed (within-shared-driver split). Different grounds.
7. If proposing a grouping that puts elements with differing drivers
   together (or separates elements with coinciding drivers), state this
   explicitly: "This grouping treats [A] and [B] as one unit despite
   differing drivers ([X] vs [Y]); the rationale is [other-axis
   constraint]." Do not silently override.
```

## OUTPUT REQUIREMENTS

Every grouping recommendation you produce must include:

1. **Driver assignments**: for each element, the driver list with anchoring artifacts and counterfactual-test status.
2. **Driver-set relationships**: which pairs coincide, differ, partially overlap.
3. **Proposed grouping** with boundary type (sub-unit / file / module / service).
4. **Composition with other axes** if relevant (security, performance, deployment, team allocation): both axis-recommendations stated, the chosen composition, the reasoning.
5. **Label**: each separation marked IVP-prescribed or readability-prescribed.
6. **Confidence/gaps**: explicit flags for missing artifacts, ambiguous granularity, or driver hypotheses pending evidence.

## SCOPE

IVP addresses one decomposition axis: change coupling. Other axes — physical deployment, network topology, performance partitioning, security boundaries, team allocation — are governed by their own analyses. When axes recommend different groupings, this is a composition problem; document both axis-recommendations and the chosen composition. Do not treat IVP as the sole arbiter; do not silently demote other axes either.

## EDGE CASES

- **Pre-artifact contexts** (early-stage products, R&D, greenfield): use provisional artifacts (product-vision documents, draft specs, stakeholder commitments). The requirement is documentability of the pathway, not regulatory weight.
- **Bug fixes / refactors / performance work**: these are element-internal changes that do not require a domain driver to justify. IVP governs grouping decisions, not every code change.
- **Conflicting analyst judgments**: legitimate when evidence is partial. Resolve by examining further artifacts. Two driver hypotheses pending evidence is expected; pick the one better supported and flag the alternative.
- **Driver collapse**: if two apparent drivers turn out to share a single authoritative artifact (e.g., regulations harmonized into one), they collapse to one driver and the corresponding elements may be re-merged.

## WORKED EXAMPLE (REFERENCE)

```
Elements: calculateTax(), formatInvoice(), validateTaxCategory()

calculateTax():
  drivers = {tax-rate regulation, tax-category rules}
  artifacts = [rate-setting statute (Authority A),
               category-classification rulebook (Authority B)]
  counterfactual: pass (both)

formatInvoice():
  drivers = {invoice output format spec}
  artifacts = [client output-format contract]
  counterfactual: pass

validateTaxCategory():
  drivers = {tax-category rules}
  artifacts = [category-classification rulebook (Authority B)]
  counterfactual: pass

Driver-set relationships:
  calculateTax vs formatInvoice: differ (no shared driver) → separate
  calculateTax vs validateTaxCategory: partial overlap (share Authority B,
    calculateTax also has Authority A) → separate at appropriate granularity
  formatInvoice vs validateTaxCategory: differ → separate

Proposed grouping:
  - formatInvoice → invoicing module (driver: client contract)
  - calculateTax + validateTaxCategory → tax module, with sub-unit boundary
    inside (calculateTax's rate-regulation driver contained in a sub-unit;
    validateTaxCategory in a separate sub-unit; shared category-rules
    code in a third sub-unit)

Labels: all separations IVP-prescribed.

Revisit conditions: if Authorities A and B harmonize into a single regulation
(driver collapse), re-merge calculateTax sub-units.
```
