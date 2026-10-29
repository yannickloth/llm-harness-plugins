---
name: use-calculator
description: Compute every number with a command-line calculator instead of doing arithmetic in your head — qalc/numbat/bc/python/sympy/maxima, via the `calc` tool or the shell. Use whenever a task involves multi-digit arithmetic, unit or currency conversion, percentages, date/time spans, statistics, combinatorics, token/cost math, algebra or calculus; also when a calculator engine is missing and an install must be proposed.
compatibility: Requires bash (calculator CLIs) — qalc recommended, numbat/bc/python optional
---

# Use a Calculator

Rule: **numbers are computed, never recalled.** Model arithmetic is generated
text: it is fluent, plausible, and wrong often enough to poison a report.
Every number that reaches the user comes out of a calculator run in this
session, with the expression visible next to it.

Usage: `/use-calculator [scope]`
- Scope (optional): the file/report/section whose numbers must be re-derived.
  With a scope, the skill recomputes every load-bearing number in it and
  rewrites the ones that disagree.

## Gate first (deterministic)

Before computing anything, check the host. Either tool call:

- `calc_probe` — engine table + install proposals for every MISSING engine, or
- shell: `for c in qalc numbat bc python3 maxima; do printf '%-8s %s\n' "$c" "$(command -v "$c" || echo MISSING)"; done`

| Probe result | Action |
|---|---|
| `qalc` ready | proceed, qalc is the default engine |
| only `bc`/`python3` ready | proceed with those; propose `qalc` install for unit/symbolic work |
| nothing ready | **stop computing.** Run the missing-engine protocol below |

Never substitute a mental estimate for a missing engine, and never lower the
precision of an answer to avoid calling a tool. Both are reported as failures,
not as answers.

## Engine by job

| Job | Engine | Exact invocation |
|---|---|---|
| Default: units, currency, percentages, dates, bases, matrices, stats | `qalc` | `qalc -t "150 km/h to mph"` → `93.20567884 mph` |
| Symbolic: `diff`/`solve`/`factor`/matrix | `qalc` | `qalc -t "solve(x^2+2x-5=0)"` → `[1.449489743 −3.449489743]` |
| Definite/indefinite integrals, limits, series, ODEs — **qalc cannot integrate** | `maxima` · `sympy` | `maxima --very-quiet --batch-string "integrate(x^2*e^x,x,0,1);"` · sympy row below |
| Statistics — names verified: `mean` `median` `var` `stdev` `stdevp` `geomean` `harmmean` `meandev` | `qalc` | `qalc -t "stdev(12,17,23,29)"` → `7.365459931` |
| Combinatorics — qalc has no `nCr`; use factorials | `qalc` | `qalc -t "23!/(3!20!)"` → `1771` |
| Dimension-checked science (unit errors are type errors) | `numbat` | `numbat -e "150 km/h -> mph"` |
| Arithmetic inside a script/pipeline (POSIX, everywhere) | `bc` | `echo 'scale=6; 22/7' \| bc -l` |
| Stats/combinatorics/dates with the stdlib | `python3` | `python3 -c "import statistics as s; print(s.mean([12,17,23,29]))"` → `20.25` |
| Exact CAS in one call (needs `uv`) | `sympy` | `uv run --with sympy python -c "from sympy.parsing.sympy_parser import parse_expr; from sympy import *; print(parse_expr('integrate(x**2*exp(x), (x,0,1))', evaluate=True))"` → `-2 + E` |
| Heavy CAS: ODEs, limits, sums, series | `maxima` | `maxima --very-quiet --suppress-input-echo --batch-string "integrate(x^2,x);"` |
| Plot of computed numbers | `gnuplot` | numbers stay computed; plotting renders them |

Prefer the `calc` tool over shell calls: it handles quoting, applies the engine
defaults, caps the run time, and refuses to return a number on failure.

`-t` (terse) matters for parsing: without it qalc prints the input echo too.
`-m <ms>` bounds a hung currency/network fetch. qalc's currency rates age —
`qalc -e` refreshes them; say which rates you used.

## Three qalc traps (found in live runs)

**1. An unknown function name is read as a product of units, exits 0, and
prints plausible output with units attached.** No error is raised:

| Typed | What qalc read | Result |
|---|---|---|
| `simplify((x+1)^2-(x-1)^2)` | siemens·metre·picometre·… | `0 s·li` |
| `std(12,17,23,29)` | svedberg·… | `[1.0368 Mt·s² …]` |
| `nCr(23,3)` | nano·kelvin/… | `[6.895226534n km/μs …]` |
| `variance(12,17,23,29)` | covariance path | `−360.27 n² ZGy·m⁴` |

Gate (deterministic): `qalc --list-functions <term>` prints matches and prints
nothing for a name that is not a function. Rule: **a result that carries units
you did not ask for means the name was wrong** — re-run with a verified name;
never report the unit-laden fragment.

**2. `int` in qalc is the integer-part function, not integration.** All three
plausible spellings return an unevaluated fragment with exit 0 and look like
answers: `int(x^2, x)` → `[int(x²) int(x)]`; `integrate(x^2*e^x, x, 0, 1)` →
`∫(2.718281828^x × x^2, x, 0, 1)`; `int_0^1 x^2 e^x dx` → `0 d`. Integration,
limits and series go to **maxima** or **sympy**. A fragment containing an
unevaluated `int(`/`∫(` is never a number.

**3. Binary and decimal prefixes give different answers.** `3.7 GB to MB` →
`3700 MB`. `3.7 GiB to MiB` → `3788.8 MiB`. State the prefix; do not infer it.

Verified pairs on this host (engine vs independent path):

| Quantity | calculator | cross-check |
|---|---|---|
| mean of 12,17,23,29 | `qalc mean(…)` → `20.25` | `statistics.mean` → `20.25` |
| sample sd | `qalc stdev(…)` → `7.365459931` | `statistics.stdev` → `7.365459931328117` |
| population sd | `qalc stdevp(…)` → `6.378675411` | `statistics.pstdev` → `6.378675411086537` |
| sample variance | `qalc var(…)` → `54.25` | `statistics.variance` → `54.25` |
| 2⁶³−1 as hex | `qalc "2^63-1 to hex"` → `0x7FFFFFFFFFFFFFFF` | — |
| ∫₀¹ x²eˣ dx (exact) | sympy `parse_expr` → `-2 + E` | python Simpson n=2000 → `0.7182818284590556`; `e-2` → `0.7182818284590451` |

## Procedure

1. **Gate** — `calc_probe` (once per session).
2. **Write the expression** in the engine's own syntax. Transcribe the
   quantities from their source (file, tool output, user message); do not
   re-derive an input from memory.
3. **Run it.** One call per number chain; keep the expression.
4. **Cross-check load-bearing numbers** with an independent path: a second
   engine, unit-rearrangement, or an order-of-magnitude bound. Report the
   disagreement — never average two methods into a quiet compromise.
5. **Publish with provenance.** In the deliverable, a computed number carries
   its origin: `93.2 mph (qalc "150 km/h to mph")`. In a report file, list the
   engine and expression for each figure in a "Computation" note.
6. **Reconcile against sources.** If the calculator disagrees with a number in
   the text being edited, the calculator wins: fix the text and say so.

## Missing-engine protocol

`calc` (and `calc_probe`) return an OS-specific install proposal — the
"propose to install" contract is in code, so it cannot be forgotten:

| OS family | Proposal shape |
|---|---|
| NixOS (this fleet) | `add pkgs.<attr> to home.packages in users/common-hm.nix, then: sudo nixos-rebuild switch --flake ./` |
| Arch / CachyOS | `sudo pacman -S <pkg>` |
| Debian family | `sudo apt-get install -y <pkg>` |
| Fedora/openSUSE | `sudo dnf install -y <pkg>` |

Nixpkgs names: `libqalculate` (the CLI `qalc` — `qalculate-qt`/`qalculate-gtk`
are GUIs and do **not** ship `qalc`), `numbat`, `bc`, `python3`, `uv`
(`uv run --with sympy`), `maxima`, `gnuplot` (plotting).

Protocol: report the missing engine → quote the proposal → ask which install to
run. ✗ Never install silently (a package install changes the user's system;
the harness requires confirmation for that). ✗ Never proceed by mental math
while waiting.

## Guards

- ✗ Multi-digit arithmetic in your head, ever — including "quick" estimates
  presented as computed values.
- ✗ Reporting a number from a failed run (`FAILED engine=…`). Fix the
  expression, switch engine, or propose an install.
- ✗ One-step rounding chains done in prose (`≈ 0.00013` derived from a
  previous prose rounding) — each step comes from a tool.
- ✗ Silent unit assumptions: state the unit, convert in the expression.
- Exact integers read from tool output (line counts, file sizes, token counts
  in a JSON field) are transcriptions, not computations — do not recompute them.
- If an engine's syntax fights you twice, switch engine; do not invent a
  result while wrestling with syntax.

## Done criteria

- Every computed number in the deliverable has a provenance line naming engine
  + expression (`rg -c 'qalc|numbat|bc -l|python3|maxima|sympy' <deliverable>`
  is non-zero when the deliverable contains computed numbers).
- Every load-bearing number was cross-checked, and any disagreement is stated.
- Any engine needed and missing was reported with its install proposal, and the
  install was requested — not skipped.

## When NOT to use

| Situation | Use instead |
|---|---|
| Proof/derivation *soundness*, hidden assumptions | `math` → `math-verifier` |
| Is a paper defensible as mathematics | `mathematics-gate` |
| Plot a chart from data | `gnuplot` / `matplotlib` (numbers still computed) |
| Pure transcription (read a number, quote it) | no computation, no tool call |
| Symbolic proofs at research depth | `maxima` / `sympy`, then `math-verifier` |
