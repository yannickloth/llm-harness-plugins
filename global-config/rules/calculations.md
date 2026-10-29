<!-- Change Driver: USER_PREFERENCES -->
<!-- Changes when: calculator tooling, package availability, or numeric-work conventions change -->
<!-- Lazy-loaded reference file — load on demand before computing numbers, quoting figures in a report, or proposing a calculator install. Not injected by default. -->

# Compute Externally

The model generates text. It does not compute. ✗ Report only numbers that a
calculator computed in this session.

| Trigger — compute, do not estimate | Engine |
|---|---|
| multiply/divide/power/root/log/trig on 2+ significant digits | `qalc` |
| unit, currency, timezone, date, duration arithmetic | `qalc` (`qalc -e` gets new rates) |
| percentage, ratio, growth, mean/variance/standard deviation, sampling, combinatorics | `qalc` (`mean` `median` `var` `stdev` `stdevp`) → `python3` |
| token/byte/cost/quota arithmetic over many items | `qalc` / `bc -l` |
| algebra: solve/factor/expand, matrices | `qalc` |
| integration, limits, series, ODEs, distributions | `maxima` · `sympy` — qalc has no integration |
| science with unit checking (a unit error is a type error) | `numbat` |
| arithmetic inside a script/pipeline | `bc -l` |
| plot of computed numbers | `gnuplot` (the numbers stay computed) |

# Commands

| Engine | Invocation | Notes |
|---|---|---|
| `qalc` | `qalc -t "150 km/h to mph"` | `-t`: result only · `-m 5000`: time limit in ms · `-s "decimal_comma 0"`: dot decimal separator, so the line parses (qalc follows the system locale, and a comma locale prints `93,20567884`) · `-b 16`: base · `-p`: programmer mode · `-e`: get new rates · `-f FILE`: batch |
| `qalc` name check | `qalc --list-functions <term>` | prints matching names · prints nothing for a name that is not a function |
| `numbat` | `numbat -e "150 km/h -> mph"` | `->` conversion · static dimensions · not a computer algebra system (CAS) |
| `bc` | `echo 'scale=6; 22/7' \| bc -l` | `-l`: scale 20 + exp/ln/sin/atan · `bc` also includes `dc` |
| `python3` | `python3 -c "import statistics as s; print(s.mean([3,4,9]))"` | standard library math/stats/itertools/fractions/decimal/datetime |
| `sympy` | `uv run --with sympy python -c "from sympy import *; from sympy.parsing.sympy_parser import parse_expr; print(parse_expr('integrate(x**2*exp(x),(x,0,1))', evaluate=True))"` → `-2 + E` | sympy ≥ 1.13 defines no symbols on `import *`, so the call goes through `parse_expr` · needs `uv` · first run needs network |
| `maxima` | `maxima -q --batch-string 'printf(true, "~a", integrate(x^2,x));'` → `x^3/3` | `-q`: no start-up banner · `--batch-string`: run non-interactively · `printf(true,"~a", …)`: plain-text result on one line (Maxima's own display splits a fraction around the `(%oN)` label) · `;` terminators · Maxima exits 0 on a syntax error, and prints `'sum(…)` unevaluated when it cannot compute — both are failures, not results |

Prefer these plugin tools (general-skills) over shell quoting. `calc` returns
the engine, the expression, and the result; it limits execution time; on failure
it returns no number. `calc_probe` returns engine availability and install
proposals.

# Failure Modes (live-verified)

| Typed | What the engine does | Signal |
|---|---|---|
| `simplify(…)`, `std(…)`, `nCr(…)` in qalc | qalc reads the name as a product of units, exits with status 0, and prints output with the wrong units | units in the result that you did not ask for → the name is wrong; check the name with `--list-functions` |
| `int(…)`, `integrate(…)`, `int_0^1 … dx` in qalc | qalc returns an unevaluated fragment (`[int(x²) int(x)]`, `∫(…)`, `0 d`) | `int(` or `∫(` in the output → not a number; use maxima/sympy |
| `3.7 GB to MB` and `3.7 GiB to MiB` | 3700 MB and 3788.8 MiB | the prefix changes the answer — state the prefix |
| `integrate(x^2;` in maxima | Maxima prints `incorrect syntax: Missing )` and **exits with status 0** | the exit status proves nothing; read the output (`calc` reports `FAILED`) |
| `sum(1/k^2, k, 1, inf)` in maxima | Maxima prints the quoted noun form `'sum(1/k^2,k,1,inf)` | printed text equals the input → not a number; use `ev(sum(1/k^2,k,1,1000), numer)` |
| `150 km/h -> mph` in numbat | prints `93.2057 mph` (4 significant digits) | state the precision you need; qalc prints `93.20567884` |

# Source Information

Report a key number with the source that produced it, so a reader can run the
command again:

```
93.2 mph  (qalc "150 km/h to mph")
```

- State the engine and the expression.
- Verify each key number with a second, independent method: a second engine, an
  algebraic rearrangement, or a magnitude bound. Report the difference between
  the two results. Do not combine them into one value.
- Read transcribed numbers (line counts, file sizes, fields in tool output). Do
  not recompute them. State which numbers are transcriptions and which are
  computations.
- Use ranges, not false precision, when the inputs are estimates. State the
  input precision you have.

# Missing-Engine Protocol

1. Report the missing engine.
2. Quote the install command.
3. Ask the user which command to run.

Do not install a package silently. Do not fall back to mental arithmetic while
you wait.

| OS family | Proposal |
|---|---|
| NixOS (these hosts) | add `pkgs.<attr>` to `home.packages` in `users/common-hm.nix` (all users, all hosts), then `sudo nixos-rebuild switch --flake ./` |
| Arch / CachyOS | `sudo pacman -S <pkg>` |
| Debian family | `sudo apt-get install -y <pkg>` |
| Fedora family | `sudo dnf install -y <pkg>` |

| Need | nixpkgs | pacman | Note |
|---|---|---|---|
| `qalc` CLI | `libqalculate` | `libqalculate` | `qalculate-qt` and `qalculate-gtk` are graphical user interfaces (GUIs); they do not include `qalc` |
| science with unit checking | `numbat` | `numbat` | |
| script arithmetic | `bc` | `bc` | `bc` also includes `dc` |
| CAS | `maxima` | `maxima` | |
| exact CAS via uv | `uv` + `uv run --with sympy` | `uv` | |
| plotting | `gnuplot` | `gnuplot` | |
| statistics | `R` / `python3Packages.scipy` | `r` / `python-numpy`+`python-scipy` | large packages: propose them, do not add them automatically |

# Scope

Applies to: estimates reported as values, cost/token math, review findings that
quote quantities, paper/draft figures, config-size math, date and price
arithmetic.

Exempt: exact integers transcribed from tool output, unit counts, single-digit
facts (`2+3`), and numbers quoted verbatim with their source.
