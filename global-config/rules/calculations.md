<!-- Change Driver: USER_PREFERENCES -->
<!-- Changes when: calculator tooling, package availability, or numeric-work conventions change -->
<!-- Lazy-loaded reference file — load on demand before computing numbers, quoting figures in a report, or proposing a calculator install. Not injected by default. -->

# Compute Externally

Model arithmetic is generated text, not computation. ✗ No number reaches a
deliverable that was not computed by a calculator in this session.

| Trigger — compute, never in-head | Engine |
|---|---|
| multiply/divide/power/root/log/trig on 2+ significant digits | `qalc` |
| unit, currency, timezone, date/duration arithmetic | `qalc` (`qalc -e` refreshes rates) |
| percentage, ratio, growth, mean/variance/sd, sampling, combinatorics | `qalc` (`mean` `median` `var` `stdev` `stdevp`) → `python3` |
| token/byte/cost/quota arithmetic over many items | `qalc` / `bc -l` |
| algebra: solve/factor/expand, matrices | `qalc` |
| integration, limits, series, ODEs, distributions | `maxima` · `sympy` — **qalc cannot integrate** |
| dimension-checked physics (unit errors as type errors) | `numbat` |
| arithmetic inside a script/pipeline | `bc -l` |
| plot of computed numbers | `gnuplot` (numbers still computed) |

# Commands

| Engine | Invocation | Notes |
|---|---|---|
| `qalc` | `qalc -t "150 km/h to mph"` | `-t` terse (result only), `-m 5000` ms cap, `-b 16` base, `-p` programmer mode, `-e` refresh rates, `-f FILE` batch |
| `qalc` name gate | `qalc --list-functions <term>` | prints matches; empty output = not a function |
| `numbat` | `numbat -e "150 km/h -> mph"` | `->` conversion; static dimensions; not a CAS |
| `bc` | `echo 'scale=6; 22/7' \| bc -l` | `-l`: scale 20 + exp/ln/sin/atan |
| `python3` | `python3 -c "import statistics as s; print(s.mean([3,4,9]))"` | stdlib math/stats/itertools/fractions/decimal/datetime |
| `sympy` | `uv run --with sympy python -c "from sympy import *; from sympy.parsing.sympy_parser import parse_expr; print(parse_expr('integrate(x**2*exp(x),(x,0,1))', evaluate=True))"` → `-2 + E` | sympy ≥1.13 defines no `x` on `import *` — route through `parse_expr`; needs `uv` |
| `maxima` | `maxima --very-quiet --suppress-input-echo --batch-string "integrate(x^2,x);"` | `;` terminators; `-Q` exits non-zero on error |

Plugin tools (general-skills): `calc` (engine + expression + result, bounded
time, refuses to return a number on failure) · `calc_probe` (availability +
install proposals). Prefer them over hand-built shell quoting.

# qalc Failure Modes (live-verified)

| Typed | What qalc does | Signal |
|---|---|---|
| `simplify(…)`, `std(…)`, `nCr(…)` | reads the name as a product of units, exits 0, prints unit-laden junk | units in the result that you did not ask for → name is wrong; gate with `--list-functions` |
| `int(…)`, `integrate(…)`, `int_0^1 … dx` | returns an unevaluated fragment (`[int(x²) int(x)]`, `∫(…)`, `0 d`) | `int(`/`∫(` in the output → not a number; use maxima/sympy |
| `3.7 GB to MB` vs `3.7 GiB to MiB` | 3700 MB vs 3788.8 MiB | prefixes change the answer — state the prefix |

# Provenance

Load-bearing numbers carry their origin in the deliverable:

```
93.2 mph  (qalc "150 km/h to mph")
```

- Quote engine + expression so the number is re-runnable.
- Cross-check load-bearing numbers by an independent path (second engine,
  algebraic rearrangement, magnitude bound). Report disagreement; ✗ never
  average two methods into a quiet compromise.
- Transcribed numbers (line counts, sizes, fields in tool output) are read, not
  re-derived. Say which is which.
- Ranges beat false precision when inputs are estimates; name the input precision.

# Missing Engine → Propose an Install

Report the gap, quote the command, ask which to run. ✗ Never install silently.
✗ Never fall back to mental arithmetic while waiting.

| OS family | Proposal |
|---|---|
| NixOS (this fleet) | add `pkgs.<attr>` to `home.packages` in `users/common-hm.nix` (all users, all hosts), then `sudo nixos-rebuild switch --flake ./` |
| Arch / CachyOS | `sudo pacman -S <pkg>` |
| Debian family | `sudo apt-get install -y <pkg>` |
| Fedora/openSUSE | `sudo dnf install -y <pkg>` |

| Need | nixpkgs | pacman | Named note |
|---|---|---|---|
| `qalc` CLI | `libqalculate` | `libqalculate` | `qalculate-qt`/`qalculate-gtk` are GUIs — they do **not** ship `qalc` |
| unit-checked science | `numbat` | `numbat` | |
| script arithmetic | `bc` | `bc` | ships `dc` too |
| CAS | `maxima` | `maxima` | |
| exact CAS via uv | `uv` + `uv run --with sympy` | `uv` | |
| plotting | `gnuplot` | `gnuplot` | |
| statistics | `R` / `python3Packages.scipy` | `r` / `python-numpy`+`python-scipy` | heavy: propose, do not auto-add |

# Scope

Applies to: estimates reported as values, cost/token math, review findings that
quote quantities, paper/draft figures, config-size math, date/price arithmetic.

Exempt: exact integers transcribed from tool output, unit counts, single-digit
facts (`2+3`), and numbers quoted verbatim with their source.
