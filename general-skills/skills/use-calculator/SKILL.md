---
name: use-calculator
description: Compute every number with a command-line calculator. Do not do the arithmetic by estimation. Engines: qalc, numbat, bc, python3, sympy, maxima, called through the `calc` tool or in a shell. Use it when a task involves multi-digit arithmetic, unit or currency conversion, percentages, date or time spans, statistics, combinatorics, token or cost math, algebra, or calculus. Use it also when a calculator engine is missing and you must propose an install.
compatibility: Requires bash (calculator CLIs) — qalc recommended, numbat/bc/python optional
---

# Use a Calculator

Rule: **the agent computes numbers with a calculator.** Model arithmetic is
generated text. It is fluent, and it is wrong often enough to make a report
incorrect. Every number in the answer comes from a calculator run in this
session. Show the expression next to the number.

Usage: `/use-calculator [scope]`
- Scope (optional): the file, report, or section to re-derive. With a scope,
  the skill recomputes every key number in it. The skill rewrites each number
  that differs.

## Check the host first (fixed steps, no judgment)

Before you compute, check what is installed. Use one of these two calls:

- `calc_probe` — engine table, and an install proposal for every MISSING engine
- shell: `for c in qalc numbat bc python3 maxima; do printf '%-8s %s\n' "$c" "$(command -v "$c" || echo MISSING)"; done`

| Probe result | Action |
|---|---|
| `qalc` ready | Continue. qalc is the default engine. |
| only `bc`/`python3` ready | Continue with those. Propose the `qalc` install for unit and symbolic work. |
| nothing ready | Stop computing. Run the missing-engine protocol below. |

Do not replace a missing engine with an estimate. Do not reduce the precision of
an answer to avoid a tool call. Report both as failures. Do not report them as
answers.

## Engine by job

| Job | Engine | Exact invocation |
|---|---|---|
| Default: units, currency, percentages, dates, bases, matrices, statistics | `qalc` | `qalc -t "150 km/h to mph"` → `93.20567884 mph` |
| Symbolic: `diff`/`solve`/`factor`/matrix | `qalc` | `qalc -t "solve(x^2+2x-5=0)"` → `[1.449489743 −3.449489743]` |
| Integrals, limits, series, ordinary differential equations (ODEs) — qalc has no integration | `maxima` · `sympy` | `maxima -q --batch-string 'printf(true, "~a", integrate(x^2,x));'` · see the sympy row |
| Statistics — names verified: `mean` `median` `var` `stdev` `stdevp` `geomean` `harmmean` `meandev` | `qalc` | `qalc -t "stdev(12,17,23,29)"` → `7.365459931` |
| Combinatorics — qalc has no `nCr`; use factorials | `qalc` | `qalc -t "23!/(3!20!)"` → `1771` |
| Science with unit checking (a unit error is a type error) | `numbat` | `numbat -e "150 km/h -> mph"` |
| Arithmetic inside a script or pipeline (POSIX, available on all POSIX systems) | `bc` | `echo 'scale=6; 22/7' \| bc -l` |
| Statistics, combinatorics, and dates with the Python standard library | `python3` | `python3 -c "import statistics as s; print(s.mean([12,17,23,29]))"` → `20.25` |
| Exact computer algebra system (CAS) in one call (needs `uv`) | `sympy` | `uv run --with sympy python -c "from sympy import *; from sympy.parsing.sympy_parser import parse_expr; print(parse_expr('integrate(x**2*exp(x), (x,0,1))', evaluate=True))"` → `-2 + E` |
| Heavy CAS: ODEs, limits, sums, series | `maxima` | `maxima -q --batch-string 'printf(true, "~a", integrate(x^2,x));'` → `x^3/3` |
| Plot of computed numbers | `gnuplot` | The numbers stay computed. Plotting renders them. |

Prefer the `calc` tool over shell calls. The `calc` tool handles quoting and
applies the engine defaults. It limits execution time. On failure it returns
`FAILED …` and no number.

qalc needs `-t` to print only the result. Without `-t`, qalc prints the input
line it repeats. `-m <ms>` limits the time for a currency request that stops
responding. qalc follows the system locale for the decimal separator: under a
comma locale it prints `93,20567884`, which breaks parsing of the returned line,
so add `-s "decimal_comma 0"` to force a dot. The `calc` tool adds it. qalc
stores currency rates for a limited time; `qalc -e` gets new rates. State the
rates you used.

## Three qalc failure modes (found in live runs)

**1. qalc reads an unknown function name as a product of units.** It exits with
status 0. It prints output with units attached. qalc raises no error:

| Typed | What qalc reads | Result |
|---|---|---|
| `simplify((x+1)^2-(x-1)^2)` | siemens·metre·picometre·… | `0 s·li` |
| `std(12,17,23,29)` | svedberg·… | `[1.0368 Mt·s² …]` |
| `nCr(23,3)` | nano·kelvin/… | `[6.895226534n km/μs …]` |
| `variance(12,17,23,29)` | covariance path | `−360.27 n² ZGy·m⁴` |

Check the name first: `qalc --list-functions <term>` prints matching names, and
it prints nothing for a name that is not a function. Output with units you did
not ask for means the name is wrong. Run the expression again with a verified
name. Do not report output with extra units.

**2. qalc's `int` is the integer-part function. It is not integration.** Three
plausible spellings return an unevaluated fragment with exit status 0. They look
like answers:

| Typed | qalc returns |
|---|---|
| `int(x^2, x)` | `[int(x²) int(x)]` |
| `integrate(x^2*e^x, x, 0, 1)` | `∫(2.718281828^x × x^2, x, 0, 1)` |
| `int_0^1 x^2 e^x dx` | `0 d` |

Compute integration, limits, and series with **maxima** or **sympy**. Output that
contains an unevaluated `int(` or `∫(` is not a number.

**3. Binary and decimal prefixes give different answers.** `3.7 GB to MB` →
`3700 MB`. `3.7 GiB to MiB` → `3788.8 MiB`. State the prefix. Do not change the
prefix.

### Maxima failure modes (live-verified, 5.47)

| Typed | What Maxima does | Signal |
|---|---|---|
| `integrate(x^2;` | prints `incorrect syntax: Missing )` and **exits with status 0** | the exit status proves nothing; `calc` reports `FAILED … incorrect syntax …` |
| `sum(1/k^2, k, 1, inf)` | prints the quoted noun form `'sum(1/k^2,k,1,inf)` | the printed text equals the input → not a number. Use a finite sum: `ev(sum(1/k^2,k,1,1000), numer)` |
| `1/3` | prints the exact `1/3` | state the form you want: `ev(1/3, numer)` → `0.3333333333333333` |

Verified pairs on this host (engine / second method):

| Quantity | calculator | second method |
|---|---|---|
| mean of 12,17,23,29 | `qalc mean(…)` → `20.25` | `statistics.mean` → `20.25` |
| sample standard deviation | `qalc stdev(…)` → `7.365459931` | `statistics.stdev` → `7.365459931328117` |
| population standard deviation | `qalc stdevp(…)` → `6.378675411` | `statistics.pstdev` → `6.378675411086537` |
| sample variance | `qalc var(…)` → `54.25` | `statistics.variance` → `54.25` |
| 2⁶³−1 as hex | `qalc "2^63-1 to hex"` → `0x7FFFFFFFFFFFFFFF` | — |
| ∫₀¹ x²eˣ dx (exact) | sympy `parse_expr` → `-2 + E` · maxima `printf` → `(e*log(e)^2-2*e*log(e)+2*e)/log(e)^3-2/log(e)^3` | python Simpson n=2000 → `0.7182818284590556`; `e-2` → `0.7182818284590451` |
| ∑ 1/k², k=1..1000 | maxima `ev(sum(1/k^2,k,1,1000), numer)` → `1.6439345666815615` | python `sum(1/(k*k) …)` → `1.6439345666815597`; difference `1.8E−15` (qalc). The limit π²/6 → `1.6449340668482264` (python, 17 significant digits) |

qalc prints 10 significant digits. The second method prints more digits. These
are the same value. Do not read a digit-length difference as a difference in the
result.

## Procedure

1. **Check the host** — `calc_probe`, once per session.
2. **Write the expression** in the engine's own syntax. Take each quantity from
   its source (file, tool output, user message).
   2b. Do not re-derive an input from memory.
3. **Run it.** One call per computation. Keep the expression.
4. **Verify each key number with a second method:** a second engine, a unit
   rearrangement, or an order-of-magnitude bound. Report the difference. Do not
   combine the two results into one value.
5. **Publish with source information.** In the output document, a computed
   number carries its origin: `93.2 mph (qalc "150 km/h to mph")`. In a report
   file, list the engine and the expression for each figure in a "Computation"
   note.
6. **Compare with the sources.** When the calculator result differs from a
   number in the text, use the calculator result. Fix the text, and state the
   change.

## Missing-engine protocol

1. Report the missing engine.
2. Quote the install command.
3. Ask the user which command to run.

`calc` and `calc_probe` return an OS-specific install proposal. The code
contains the "propose to install" contract, so a session cannot forget it:

| OS family | Proposal shape |
|---|---|
| NixOS (these hosts) | `add pkgs.<attr> to home.packages in users/common-hm.nix, then: sudo nixos-rebuild switch --flake ./` |
| Arch / CachyOS | `sudo pacman -S <pkg>` |
| Debian family | `sudo apt-get install -y <pkg>` |
| Fedora family | `sudo dnf install -y <pkg>` |

Nixpkgs names: `libqalculate` (the command-line interface (CLI) `qalc` —
`qalculate-qt` and `qalculate-gtk` are graphical user interfaces (GUIs); they do
not include `qalc`), `numbat`, `bc`, `python3`, `uv` (`uv run --with sympy`),
`maxima`, `gnuplot` (plotting).

Do not install a package silently: an install changes the user's system, and the
harness requires confirmation for that. Do not proceed with mental arithmetic
while you wait.

## Guards

- Do not do multi-digit arithmetic by estimation. Do not present an estimate as
  a computed value.
- Do not report a number from a failed run (`FAILED engine=…`). Fix the
  expression, switch engine, or propose an install.
- Do not derive a rounding step from a rounding written in the text. Get each
  step from a tool call.
- Do not assume a unit. State the unit, and convert it in the expression.
- The agent reads exact integers from tool output (line counts, file sizes,
  token counts in a JSON field). These are transcriptions, not computations. Do
  not recompute them.
- An engine returns a syntax error two times. Switch engine. Do not report a
  result while you fix syntax errors.

## Done criteria

- Every computed number in the output document has a source line that gives the
  engine and expression. Check:
  `rg -c 'qalc|numbat|bc -l|python3|maxima|sympy' <document>` returns a count
  greater than zero when the document contains computed numbers.
- Verify every key number with a second method. State every difference.
- Report every missing engine with its install proposal. Ask the user which
  install to run. Do not skip it.

## When not to use

| Situation | Use instead |
|---|---|
| Proof and derivation soundness, hidden assumptions | `math` → `math-verifier` |
| Is a paper defensible as mathematics | `mathematics-gate` |
| Plot a chart from data | `gnuplot` / `matplotlib` (the numbers stay computed) |
| Pure transcription (read a number, quote it) | No computation, no tool call |
| Symbolic proofs at research depth | `maxima` / `sympy`, then `math-verifier` |
