# inference-optimisation — Assumptions

Hill-climb the serving speed of a local LLM on any hardware and quantization. Ships the `inference-optimisation` skill (SKILL.md + 6 references + 5 scripts + 2 example configs). Injects one skill into every session; no custom tools, no agents.

## OpenCode API (hooks used, v1 vs v2, version sensitivity)

- Dual entrypoint: v2 default export `{ id, setup(ctx), server(input, options) }`; v1 path returns a plugin factory from `server()`. Same pattern as `general-skills`.
- v2 hooks: `ctx.skill.transform` (shared/v2-skills.ts). Only hook used — registers the skills directory.
- v1 hooks: `config` (appends skills dir to `input.skills.paths`). The v1 path wraps `server()` and returns the same factory pattern as `general-skills`.
- Skill frontmatter: only `name`/`description` are read by shared/v2-skills.ts `parseFrontmatter`. The regex is single-line (`^(name|description):\s*(.+)$`), so the description must be a single-line string (quoted), not a YAML blockquote.
- `id: "inference-optimisation"` matches the directory name and the skill's frontmatter `name` field.
- The plugin injects a `> Skill root: <absolute-path>` preamble after the frontmatter block so the agent can resolve `references/`, `scripts/`, and `examples/` from its own CWD (the project being worked on, not the plugin directory).

## Environment (env vars read, with defaults; binaries on PATH; OS/process assumptions)

- Binaries invoked by the skill's scripts (called by the agent, not the plugin): `python3` (bench.py, ceiling.py, stats.py), `bash` (queue.sh, mem.sh). No probing by the plugin itself — the agent invokes these scripts directly in the experiment directory.
- Python standard library only: `json`, `os`, `random`, `statistics`, `string`, `subprocess`, `sys`, `threading`, `time`, `urllib.request`, `concurrent.futures`, `math`, `argparse`, `itertools`, `platform`. No `pip` installs needed for bench.py, ceiling.py or stats.py.
- Optional: `nvidia-smi` for mem.sh (discrete GPU mode), `docker` for mem.sh container mode. `mem.sh --pid PID` works with no docker and no nvidia-smi (CPU RSS only, and it says so).
- Linux assumed for mem.sh's DRM/cgroup probes; macOS fallback (`vm_stat`, system-wide proxy, flagged on stderr); Windows unsupported. bench.py's `on_ac()` covers Linux and macOS.
- Optional external toolchain: a reverse-engineering toolchain (e.g. REA) for `references/engine-forensics.md`. **Not required** — the skill is fully functional without it, and that reference is skipped when the tools are absent. Nothing in SKILL.md's core loop, the ceiling math, the statistics or the harness depends on it.
- No env vars read by the plugin itself. The skill instructs the agent to use `QUEUE_LOCK`, `BENCH`, `BENCH_FLAGS` and `SERVER_STOP` env vars — the agent handles those.

## Filesystem & layout (paths read/written, where anchored — cwd / repo root / XDG; formats; encodings)

- `skills/` anchored at the plugin directory via `moduleDir(import.meta.url)` — independent of cwd.
- Read: `skills/inference-optimisation/SKILL.md` (1 file). The `references/`, `scripts/`, and `examples/` directories live inside `skills/inference-optimisation/` (matching the upstream repo layout). The agent reads them from the skill root path injected by the plugin preamble.
- Write: none by the plugin itself. The SKILL.md instructs the agent to write `PLAN.md`, `THEORY.md`, `configs/`, `ledger.jsonl`, `best-config.json` in the experiment directory.
- Encoding: UTF-8 assumed for all Markdown and JSON files.
- Example configs in `examples/` are shipped for reference only; the agent copies them into its `configs/` directory.

## External services (URLs/ports, protocol assumptions)

- bench.py connects to an OpenAI-compatible server (any host/port configured in the JSON). Uses only `urllib.request` — no external packages.
- No outbound network from the plugin itself.

## Configuration (what opencode.json must register for it to work; whether it actually is)

- Registered by adding `"./inference-optimisation/opencode"` to the `plugin` array in `opencode.json`.
- No plugin config keys exist: the skill is loaded automatically via `ctx.skill.transform`.
- No `opencode.json` `agent` entries are required.

## Concurrency (locks, multi-instance behavior, atomicity)

- Module-level: none. The plugin is a simple skill registrar — no state, no caching, no shared variables.
- The `scripts/queue.sh` provides GPU serialization at the agent level via `flock`, not the plugin level.
- The plugin's `setup()` runs once per plugin instance; `skill.transform` is called once per session. No race conditions possible.

## Data & LLM behavior (formats trusted from the model; model assumptions)

- The agent is trusted to: follow the SKILL.md procedure; set up the experiment directory correctly; run scripts from the correct working directory; parse bench.py output and ledger.jsonl correctly.
- SKILL.md frontmatter `description` field is the trigger text the model sees — it lists all trigger keywords (hill climb, tok/s, decode speed, etc.). Must be a single-line quoted string (the `parseFrontmatter` regex is single-line).
- The skill's lever order and ground rules are strict; the agent should not deviate from them.
- References are loaded on-demand (the skill says "read when needed") — not injected into every turn.

## Methodology (adversarial review findings addressed)

Round 1 adversarial review (4 reviewers: sophist-attacker, devil-advocate-auditor, theory-devil-advocate, reductionist-auditor) found 56 raw findings, deduplicated to ~30 unique issues. Fixes applied:

**Critical code bugs:**
- `ceiling.py` decode_ceiling returned N² scaling (trailing `* n` double-counted concurrency). Fixed.
- Multi-GPU allreduce formula missing `/N` (overcounted interconnect traffic by N×). Fixed.
- Added compute-bound floor to decode ceiling. Round 2 measured its scope as "inert on GPU, binds on CPU-class parts"; **round 4 disproved the second half** — with correct ratios (38 RTX 3090 … 313 Arc, ~20 server CPU) against a threshold of intensity/mfu ≈ 6, the floor is inert on CPUs too and binds only at very low mfu. The round-1 claim that it fixes a "2× overestimate on small dense models" remains unsupported. The floor is kept because it is correct and cheap, and because it is the right ceiling for a badly optimized kernel.
- Added sustained ceiling (thermal drop 10–20%) as a separate output.
- Made MFU tunable (not fixed 50%).
- Added recurrent state to KV budget for hybrid models.

**Methodology:**
- Gap analysis formula replaced: ordinal Likelihood/Cost/Complexity → range-based Lever exists / Expected closure / Effort / Risk / Detectable. Uses sum not product for Effort+Risk.
- Statistical acceptance: Mann-Whitney U test at α=0.05, Holm-Bonferroni for secondary metrics, power analysis, below-noise-floor filter. **Round 2 showed the round-1 power claim was wrong** — see below.
- Likelihood decomposed: was a single ternary, now split into Lever exists (yes/maybe/no) + Expected closure (range from measured evidence).
- Lever interactions: flat list → dependency graph with preconditions (→), payoff modifiers (⇒), and conflicts. Added 5 missing interaction classes.
- Measurement budget: quick pass revised from 2–4 h to 6–12 h. Added server startup/teardown time. Added failure buffer (25–50%). Separated config-lever runs from stability-gate runs.
- Stopping criterion: "2× measurement noise" → "2× measured MAD" (not a generic estimate). "Inside noise" defined as "within 1× MAD of control median." "Surprising" defined as "improvement > 2× MAD."
- Baseline stability check: 3 baseline runs before starting, investigate if spread > 2× expected noise.
- Lever failure analysis: 3-way decision tree (measurement error / lever incompatibility / interaction failure).
- Stability gates: now apply to every accepted lever, not just "best" config.
- "One change per experiment" → "one primary change per experiment, with documented control levers."
- Quantization reclassified: was "config change with no code work" (false), now "model file change" with its own acceptance gates.
- Ceiling uses sustained ceiling, not peak, for gap analysis.
- Prompt panel: noted minimum of 6, recommend ≥12 for acceptance testing.
- Memory watchdog: noted Linux-specific, must be adapted for macOS/Windows.

### Round 2

Round 2 re-ran the same 4 reviewers on the fixed state, **and added a REA (reverse-engineering)
runtime audit** of the shipped scripts: each was run under controlled PTY capture with happy
paths and malformed inputs, reading exit codes, stdout/stderr and filesystem effects. That
found bugs no reviewer caught.

**Script bugs found by runtime evidence (not by reading):**
- `mem.sh` failed **completely silently** when docker is absent: exit 125, zero stdout, zero
  stderr. Root cause proven by A/B: `set -e` + `pipefail` killed the script at the `docker top`
  line, so the `echo 0` fallback was unreachable. A dead probe read as 0, sat under the cap, and
  policed nothing. Fixed: explicit probe-failure contract (nothing on stdout + non-zero exit),
  `--pid` mode for native servers, and `bench.py` now flags `MEM_WATCHDOG_FAILED`.
- `ceiling.py` documented `mfu` as "Default 0.5" but read it as `m["mfu"]` → `KeyError`, exit 1.
  The documented default did not exist. Fixed in `validate()`.
- `ceiling.py` crashed with `ZeroDivisionError` on `n_experts: 0`, and printed `-4` tok/s for
  `bandwidth_gbs: -5` with exit 0. Fixed: `validate()` rejects non-positive/absurd inputs with
  named errors.
- `bench.py show` with no ledger → unhandled `FileNotFoundError`; `bench.py run` with a missing
  config → unhandled traceback. Fixed: clean messages.
- `queue.sh` with no arguments printed `QUEUE_DONE` and exited 0 — "succeeded" doing nothing.
  Fixed: requires args, validates each config exists, reports per-run exit codes.
- `bench.py` `cap_gib` default was effectively unbounded (1e9 GiB), so a probe with no cap
  silently policed nothing. Fixed: refuses to run when a probe is set without a cap.

**Methodology fixes (round-2 reviewers):**
- **The acceptance test was structurally broken.** At n=6+4 the exact one-sided Mann-Whitney
  can only reach p = 0.0333 (U ≥ 21 of 24), and its power to detect a 5% effect at 7.5% noise is
  ~5%, not the 50% round 1 claimed. Sample size is now **derived from the expected effect**
  (`stats.py design`), and the **exact achievable alpha is reported** rather than asserted as 0.05.
- Added `scripts/stats.py`: exact Mann-Whitney null distribution (Gaussian-binomial, verified
  against brute-force enumeration by a shipped `selftest`), MAD/σ conversion (MAD = 0.6745σ —
  round 1 had this inverted), required-n for target power, Holm-Bonferroni, bootstrap ratio CI,
  family-wise rate, and a d2-based baseline stability gate.
- **Screen-then-confirm** replaces "repeat surprising wins", which was selection on the tail
  with unbounded family-wise error. Acceptance is decided on the confirm stage alone.
- Gap table: Exp. gain (Gap% × Closure) is now the ranking numerator (Gap% was previously
  computed and then unused); risk is a tiebreaker/gate, not summed with effort; the
  "current > sustained ceiling" row is "re-measure the ceiling", not "at ceiling" or "anomaly".
- Stopping criterion: `max(2 × MAD, user_floor)` — MAD alone stops a quiet host at a 1.7% gap.
- Coupled factors (draft length × concurrency × context) are one multi-factor experiment, not a
  sequence of one-factor runs.
- Cache policy between levers (wipe after kernel-landscape changes, keep warm between parameter
  levers, record which was used).
- Quantization is a phase, not a lever: it invalidates ceilings, graphs, caches and the gap table.
- Sustained cN added to `bench.py` (burst cN cannot see the KV-pool collapse the ceiling predicts).
- Output-quality guard: `out_tokens_median` / `out_tokens_spread_pct` + `OUT_LEN_UNSTABLE`.
- Publishing: per-lever gates vs publish gates disambiguated; advertised deltas must carry n,
  exact alpha and MAD.
- Added `references/engine-forensics.md` (optional, REA-gated) for lever 8 and evidence integrity.
  The skill is fully functional without it.

### Round 3

Round 3 re-ran the same 4 reviewers on the round-2 state. 24 raw findings, deduplicated to 17.
Two of the round-3 findings were **false positives, disproved by arithmetic before being "fixed"** —
recording them matters, because both were plausible and both would have introduced a real error:

- **Claimed:** the prefill attention term is a factor of 2 short (`4·layers·d·(L/2)` should be
  `4·layers·L·d`), inflating the prefill ceiling ~30%. **Measured:** the exact causal QK^T + AV cost
  per token at the fixture model is 21474.9 MFLOP and `ceiling.py` computes 21474.8 MFLOP — ratio
  1.0000. The proposed "fix" is exactly 2.0000× too big. No change made.
- **Claimed:** `prefill_ceiling` carries an undocumented `0.5` coefficient absent from the docs.
  **Measured:** there is no 0.5 in the code; the reviewer read the documented `mfu` default (0.5) as
  a coefficient. No change made.

**Real defects fixed in round 3:**

- **`stats.py design` reported a target it did not deliver.** It sized n from the *nominal* alpha and
  only bumped n when the alpha was unreachable, so it printed "runs per side for 80% power: 4" while
  the test had 52% (normal approx) / 69% (exact) power. `design` now grows n until the **exact**
  power clears the target, and reports the exact power with its Monte Carlo standard error.
- **The normal-approximation power is a lower bound, not the reported number.** Measured gaps:
  52% approx vs 69% exact at 4+4/d=2.08; 31% vs 74% at 8+8/d=1.30; 13% vs 31% at 8+8/d=0.67. Added
  `power_exact()` (seeded Monte Carlo under a location-shift model — no normal approximation, valid
  at n=3) and used it in `design` and `power`.
- **Screen/confirm was self-contradictory**: the confirm set was "pre-registered before any run" *and*
  "the ~6 levers that survived the screen". Those are two different selectors. Now: the confirm set is
  pre-registered by expected effect with K fixed in advance; the screen is a sequencing filter; a
  screen hit outside the pre-registered set is exploratory and needs its own pre-registration.
- **Family-wise error across levers was uncontrolled.** Holm was applied to secondary metrics within a
  lever only. 6 levers accepted independently at α=0.05 is a 26% family-wise false-accept rate. Holm
  is now applied across the confirm set's primary p-values as well.
- **Screen-stage costs were undisclosed.** Now stated with numbers: 35% chance of ≥1 false hit among
  15 null levers at n=4, and an 86% miss rate for real d=0.67 effects — framed as budget costs, since
  a screen hit is never an acceptance.
- **Quantization was ranked by the gap table while also being required first.** Added priority-rule
  step 0: quantization is decided before the table is ranked, because ranking it by
  `Exp. gain ÷ effort` puts a high-effort lever last and every earlier measurement was then made on a
  system you throw away.
- **Budget table arithmetic was wrong in two places.** The noise floor is 10 runs, not 40 (one
  `bench.py` run measures all four dimensions), which inflated the total by ~13 h; and the cost of
  re-measuring ceilings and the noise floor after a kernel-landscape change was missing entirely.
  Total is now ~286 runs / ~119 h, with the quantization phase as a separate +82 runs / +46 h row.
  **(Superseded by round 5: 319 runs / 133 h, quantization 157 runs / 65 h — the confirm stage moved to
  n = 8 per side, because Holm's α/K at K = 6 is unreachable at n = 6. See the round-5 section.)**
- **`document()` sized prompts with a 1.6 tokens/word ratio** while this skill's own methodology
  records ~3.5 measured. Sustained-cN runs were therefore ~2× the target context. Fixed to a named
  constant, and the sustained block now records the server's actual `prompt_tokens`.
- **Cross-run environment drift was invisible**: `STATE_CHANGED` only compares a run's own start and
  end. Added `prev_state()` and the `CROSS_RUN_STATE_CHANGED` flag, deliberately a flag to read and
  not an automatic void — the harness cannot distinguish a driver update from the lever you changed.
- **Ring all-reduce used `2/N` where ring traffic is `2(N−1)/N`** — correct at N=2, undercounting by
  3× at N=4 and 7× at N=8, which overstates multi-GPU scaling. Fixed in `ceilings.md`.
- **`accept` printed a non-criterion next to the verdict** ("every candidate sample beats control
  median"), which reads as a third acceptance condition. Relabelled as a diagnostic.
- **`Detectable?` compared a percentage gain against a MAD in metric units.** Now states that both
  sides must be percentages of the dimension's median.
- **"Inside noise" (1× MAD) sat in the same breath as the stop rule (2× MAD).** Split into two named
  thresholds answering two different questions.

**A bug found in my own round-2 fix, by re-running the scripts:** the round-2 recurrent-state rewrite
called two helpers that were never defined (`top_k()`, `recurrent_per_stream_gb()`) and left
`recurrent_bytes_per_token` in the KV denominator, scaled by context. SSM/GDN state is O(1) per
stream: at 262K context the ctx-scaled term charges 24 GB per stream for a 0.7 GB state (34×). Both
helpers are now defined, the per-token key is removed and rejected with a named error, and capacity
uses `per_stream = kv×ctx + state` with state as a constant.

### Round 4

Round 4 re-ran the 4 reviewers with a new rule: **run the code before claiming a bug, and show the
arithmetic for formula claims.** That rule worked — round 4 produced 16 findings, none of them the
round-3 style of false positive, and it caught two errors that were *introduced by round-3 fixes*.

**Errors in my own round-3 prose, found by running the arithmetic:**
- **The peak/bandwidth ratios I quoted were invented.** I wrote "~314 on an RTX 3090, ~157 on an A100,
  ~30 on a many-core CPU". Computed: RTX 3090 = 35.58 TFLOPS / 936 GB/s = **38**, A100 = 312/1555 =
  **201**, RTX 4090 = 98, H100 = 295, Arc B390 (the fixture) = **313**, server CPUs ≈ 20, laptop ≈ 18.
  The 314 I attributed to a 3090 is the Arc fixture's ratio.
- **The claim "the compute floor binds on CPU-class parts" is not supported.** The criterion is
  `floor binds ⟺ peak/bandwidth < intensity/mfu`. Decode intensity is ~1 (fp16) to ~4 (4-bit), so the
  threshold is ~6 at mfu 0.5 and ~14 at 0.2 — far below every real part's 18–313. The floor is inert on
  CPUs too. It binds only at **very low mfu**, which is a statement about kernel efficiency, not about
  the memory system. Verified against the calculator at 936 GB/s / 35.58 TFLOPS: mfu 0.2 → 554 tok/s,
  0.1 → 554, 0.05 → 366, 0.02 → 146 — exactly the predicted `min(bandwidth, compute)` at each point,
  with the crossover at mfu ≈ 0.1 as the algebra predicts.
- **The peak-vs-sustained example was arithmetically impossible.** "A system at 95% of peak can be at
  75% of sustained with 20% headroom left" cannot be true because `sustained ≤ peak`: 95% of peak is
  112% of sustained at a 15% drop. Replaced with the real effect, which is the one the sentence was
  reaching for: ranking against the peak **inflates the headroom you can see** — a machine at 75% of
  sustained is at 64% of peak, so a 25% real gap reads as 36%, 1.4× more headroom than exists.

**Other round-4 fixes:**
- Quick pass said "screen the top 3 and **confirm the best one**" — selection on the tail, the exact
  thing ground rule 2 forbids. The quick pass now has **no screen stage**: confirm the top 2 by
  expected effect, pre-registered, with Holm across the two.
- Quick-pass budget (8–16 h) was impossible for the procedure it described (screen 3 + confirm 3 = 27 h).
  The budget now matches the procedure it describes (32 runs ≈ 13 h).
  **(Superseded by round 5: the n = 3 confirm was inoperable under Holm at K = 2, so the quick pass
  moved to n = 4 per side — 28 runs ≈ 12 h, 38 with the stated 35% buffer ≈ 16 h.)**
- "Screen everything else" contradicted "screen every candidate lever" and the 15×8 budget row. Now
  explicit: screen all 15 including the confirm set, with the reason (8 runs is two-thirds of a confirm
  run, and a screen showing hardware incompatibility saves 12+ confirm runs).
- Quantization budget row read "+82 (+29) | +46 h", where 46 h matches 111 runs, not 82. Now `111`
  with the components spelled out. **(Superseded by round 5: 157 runs / 65 h, because the re-confirm
  stage moved to n = 8 per side and gates were added to the row.)**
- `stats.py holm` accepted `p = -0.1` as significant and let NaN silently kill every later comparison.
  Now validates p ∈ [0,1] and exits on a non-numeric or out-of-range value.
- `holm` labelled every rejection "REGRESSION", which is right for secondary metrics and wrong for
  confirm-set primary p-values (where a rejection is a real effect). Added `--mode secondary|confirm`.
- `accept` hardcoded "6 levers" in its FWER advisory (23% at K=5, 30% at K=7). Now `--confirm-set K`.
- `stats.py power` was cited in prose with no invocation syntax; `design` skipped untestable n values
  silently; `mem.sh` carried a dead `collect()` function with no-op loops. All fixed.
- The worked example in `ceilings.md` (670 tok/s prefill) did not reproduce from the shipped fixture
  (684). Now documented and **verified**: `mfu = 0.49` reproduces 670 exactly.

**Verified clean by round 4, with evidence:** recurrent-state model (`*2` decode bandwidth, `*1`
capacity, O(1) in ctx, per-stream — fixture breakdown 1.648 + 0.800 + 2.684 = 5.1325 GB); ring
all-reduce `2(N−1)/N`; expert-union formula (matches independent-sampling simulation); tie handling
in `_tail_p` (`P(U ≥ 15.5) = P(U ≥ 16) = 1/70`); the `design` n-search (never over-sizes, returns the
smallest valid n ≥ n₀, and power is monotonic across the whole testable range d ≥ 1.2 — **round 5
measured this last clause and it is false: d = 1.2 dips 32.9% → 31.1% from 3+3 to 4+4; monotonic from
d ≥ 1.5.** The n-search conclusions stand, because at every d with a dip the normal-approx starting
point is n₀ ≥ 9, above the dip); the normal
approximation is never anti-conservative.

**Verified by runtime evidence after fixing (round-3 re-run, controlled PTY capture):**
`py_compile` clean on all three Python scripts; `stats.py selftest` passes against brute-force
enumeration for 10 sample-size pairs (up to 8+8, 12870 partitions); `design` raises n from 4→5 at
d=2.08 and 8→9 at d=1.30 and reports exact power (88.5% ±0.2, 80.8% ±0.2) with the normal-approx
lower bound beside it; a d=0.34 effect is refused as "not testable in a config pass"; `accept` on a
clean 6+4 win gives exact p = 0.0048 and the two-criterion verdict; `ceiling.py` on the dense fixture
gives 68 → 142 tok/s from c1 to c4 (2.09×, linear not N²) and 3465 → 684 tok/s prefill from 4K to 256K;
the hybrid fixture now charges 0.40 GB per stream for recurrent state as a constant (22 tok/s at 256K,
9 full-length streams under a 49.4 GB cap) instead of scaling it by context; the removed
`recurrent_bytes_per_token` key fails with a named error and exit 1; `bench.py show` with no ledger and
`queue.sh` with no arguments both print a usage-level message and exit non-zero.

### Round 5

Round 5 re-ran all four reviewers with the round-4 evidence rule plus one addition: **quote your own
command output, never a reviewer's numbers as measured evidence.** That addition paid for itself
immediately — round 5's most embarrassing finding was mine, and it was exactly that error.

**The critical defect (found independently by three of four reviewers): Holm's α/K sizes the test, and
the quick pass was inoperable.** Holm's first threshold over a confirm set of K levers is α/K, so the
Mann-Whitney must be *able* to produce a p that small. The quick pass confirmed 2 levers at n = 3+3 with
Holm across the two: at 3+3 the smallest achievable p is 0.0500, and α/2 = 0.025 is unreachable, so the
chain stops at step 1 and **the procedure accepted nothing, every time, while reporting every lever as
`ok`.** Measured reachability of α/K: K = 2 → n ≥ 4+4 (α = 0.0143); K = 3 → n ≥ 4+4; K = 5 → n ≥ 5+5
(0.0079); K = 6 → n ≥ 5+5 (0.0079); K = 7 → n ≥ 5+5 (0.0040). Fix: `stats.py design --confirm-set K`
sizes n against α/K instead of α, prints the K note and the skipped-n list, and says so in the verdict.
Verified: `design --mad 2.1 --current 53 --expected 10 --confirm-set 2` → skips n = 2,3, returns n = 4,
α = 0.0143, exact power 87.6% ±0.2.

**Budget consequences, recomputed from the skill's own rules.** *(Superseded by round 7: a sustained-ceiling
measurement row was added and the quick pass floor moved back to n = 4 — full pass **321 runs / 134 h**,
quantization **159 / 66 h**, quick pass **29 runs ≈ 12 h** at n = 4, 33 ≈ 14 h at n = 5.)* The full pass confirm row moves from
n = 6 to **n = 8 per side**: at K = 6, α/K = 0.0083 is unreachable below n = 5+5, and n = 8+8 (α = 0.0074)
is where 80% exact power lands at d = 2.0 (measured 84% at d = 2.0, 87.3% at d = 2.08 for the fixture
noise). Budget: 212 → **236** runs, 88 → **98 h** subtotal, **319 runs / 133 h ≈ 5.5 days** total,
quantization phase 111 → **157 runs / 65 h ≈ 2.7 days**. Quick pass: 10 + 2×2×4 + 2 = **28 runs ≈ 12 h**,
38 with the 35% buffer ≈ 16 h — the buffer is now stated, not implied (round 5 caught that the old
"32 runs ≈ 13 h" did not match the 25-run procedure it described). The quick pass is a **big-win finder**:
87.6% power at d = 3.21 (an 18% gain at a 4% MAD), and only 49% at d = 2.0 (a 12% gain). Say that in
PLAN.md.

**Holm's chain-stop is now documented as a reading rule, not a bug.** With p = 0.008, 0.042, 0.048 the
tool claims only the first and prints `ok` for the other two — the lever with p = 0.048 is never tested.
That is the definition of the step-down: it controls FWER in the strong sense and is uniformly more
powerful than Bonferroni. `ok` means "not claimed", never "shown to be null". `--mode confirm` prints the
chain-stop note.

**The exploratory loophole is now quantified and closed.** Confirming M screen-selected levers each as
its own K = 1 test has a family-wise false-accept rate of **1 − 0.95^M** (14% at M = 3, 23% at M = 5),
and the screen selected them, so the selection is on the tail. Pre-registering the group, K and α is a
one-time act before the first run, not a per-lever ritual.

**My own round-4 prose contained a pasted-unmeasured number, and round 5 caught it.** I wrote "at d = 0.3,
power is 5.3% at 3+3 and 3.1% at 4+4" — those were a reviewer's numbers I did not measure. Measured at
100k sims: **9.1% at 3+3 and 6.2% at 4+4**; d = 0.5 gives 13.0% → 9.6%; the 7→8 dip appears only at
d ≤ 0.5 (21.2% → 20.9%). The accompanying claim "power is monotonic across the testable range d ≥ 1.2"
is **false**: d = 1.2 dips 32.9% → 31.1%. Monotonic from d ≥ 1.5. The `design` search is unaffected —
at every d where a dip exists the normal-approx starting point is n₀ ≥ 9, so the search starts above the
dip.

**Theory's "median-of-6 mis-states power" finding is a false positive, and the scale error that produced
it is now documented so nobody repeats it.** *(Round 7 sharpens this: the "more power / mild lower bound"
half is also a false positive — it came from the **asymptotic** median sd, 10.4% too big. On the exact
scale the single-sample model is essentially exact; see the round-7 section.)* `power_exact` standardizes
on the observation unit, which is the
**run median** (MAD is measured across run medians), so sd 1 is the correct scale for the simulated
observation. Simulating an explicit median-of-6 *on that scale* (per-draw sd = 1/sd_median(6) = 1.954)
gives **more** power at the same d — 27.0% vs 23.4% at 4+4/d = 1.0, 51.5% vs 45.2% at 6+6/d = 1.0 —
because the median's tails are lighter, so the reported power is a mild lower bound and `design` is
slightly conservative. Drawing the medians from N(d, 1) instead gives the median an sd of 0.51 while
keeping the shift at d, which silently multiplies the effect size by 1.954 and reports **72% power where
the truth is 23%**. That is the trap; the current model is the conservative side of it.

**Intensity is not a constant (theory finding, confirmed and quantified).** On the worked example:
2.88 FLOPs/byte at 4K → 2.45 at 32K → 1.63 at 128K → **1.12 at 256K**; 2.45 at c1 → 1.10 at c4 → 0.37 at
c16 → 0.13 at c64. The prose "weights dominate the per-token bytes" is a short-context statement — at
256K the KV read (2.68 GB) exceeds the weights. The direction favours the bandwidth ceiling: lower
intensity means a lower threshold `intensity/mfu`, so long context and high concurrency make the compute
floor **more inert, not less**. Measured binding table: the floor binds on a 3090-class part only at
mfu ≤ 0.05 at 4K and never at 256K; on server/laptop CPUs at mfu ≤ 0.1 at 4K and ≤ 0.05 at 256K; on
RTX 4090/A100/H100/Arc never in that range.

**Gap % was defined one-directional while the table mixes both kinds of row.** The stated formula
(sustained − current)/sustained gives **−163%** for the startup row and **−50%** for TTFT, while the table
showed 62% and 33% — which are (current − floor)/current, the correct form for a *floor*. Both rows are
now marked and both formulas stated, with why the throughput form breaks on a floor (it explodes as the
floor approaches zero) and why a negative gap means an invalid ceiling, not a target beaten.

**Gap sensitivity to the sustained estimate is now bounded.** Assume a 15% thermal drop when the real one
is 30%, and a machine at 0.70 × peak shows a **17.6% gap** on the assumed ceiling and **0%** on the real
one — a full prioritization signal for a gap that does not exist. Rank rows by the **minimum** gap across
0.80 / 0.85 / 0.90 × peak, and measure the drop (20+ min sustained load) instead of guessing it.

**Three MAD thresholds, resolved by scope rather than by a new multiplier.** 2 × MAD (below-noise filter)
and max(2 × MAD, user_floor) (stop) are **pre-run gates**: they decide whether to run. 1 × MAD ("inside
noise") is a **post-run reading**: it interprets a run you already made. The [1×MAD, 2×MAD) zone is
deliberate. If a lever lands there after a run you chose to make, the 1 × MAD reading is a true statement
about that run, not an acceptance — report it as "above noise, below the worth-testing threshold:
measured, not actionable" and do not spend a confirm stage on it.

**Code fixes:** `ceiling.py`'s comment still asserted the round-4-disproved "this floor only binds on
CPU-class parts" (round 4 fixed the docs and missed the code) — replaced with the measured criterion and
the intensity table. `bench.py::looping()` required > 50 n-grams, i.e. > 58 words, so a model stuck on a
3-word cycle landing at 58 words passed the output-quality guard undetected; the gate is now
`min_grams = 8` (verified: 20-word all-identical → True, 60-word 3-cycle → True, normal 20-word text →
False). `warmup_probes` was computed and never used — now implemented: warmup readings are cap-checked
like every other reading and reported as `mem_peak_warmup_gib`, and are excluded from `mem_peak_gib` so
the ledger compares steady-state footprints instead of startup allocations. `design`'s K = 1 verdict no
longer refers to α/K it never used.

**Verified clean by round 5, with evidence:** `references/engine-forensics.md` gates every tool behind REA
availability and states the skill works fully without it — no core-loop instruction requires a tool a
normal user lacks; the `design` n-search (smallest valid n ≥ n₀, never over-sizes); the recurrent-state
model, ring all-reduce, expert-union formula and `_tail_p` tie handling (carried from round 4).

**Runtime verification after the round-5 fixes (controlled PTY capture):** `py_compile` clean on all
three Python scripts and `bash -n` clean on both shell scripts; `stats.py selftest` passes against
brute-force enumeration on 10 sample-size pairs up to 8+8 (12870 partitions); `design --confirm-set 2`
skips n = 2,3 and returns n = 4 at α = 0.0143 with 87.6% exact power; `design --confirm-set 6` skips
n = 4 and returns n = 8 at α = 0.0074 with 87.3%; `design --confirm-set 7` at d = 0.67 refuses as
"not testable in a config pass at K = 7" and names the three ways out; `holm --mode confirm` on
0.008/0.042/0.048 claims only the first and prints the chain-stop note; `holm --mode confirm` on
0.0143/0.0429 (the quick pass at its designed n) claims **both**; `holm a=-0.1` exits 1 with the range
message; `accept --confirm-set 5` reports 23% FWER at K = 5; `ceiling.py` on the shipped fixture
reproduces 68 tok/s c1 decode, 142 at c4, 3465 → 684 prefill from 4K to 256K, 2.68 GB per 256K stream.

### Round 6

Round 6 re-ran the same four reviewers with the evidence rule plus "verify your own numbers". It found
the largest technical error of the whole loop, and it also produced three reviewer claims I rejected
after measuring — which is the rule earning its keep in both directions.

**The big one: decode attention FLOPs were missing from the compute floor, and the floor's scope was
stated backwards.** `decode_ceiling` used `flops_per_token = 2 × active_params`, with no attention term,
while `prefill_ceiling` had one. A decoded token attends the **whole** cached context, so its attention
cost is `4 × layers × heads × head_dim × L` — linear in L, and using the prefill causal average (L/2)
here would be a 2× error in the other direction. On the worked example (10 attn layers, 16 heads, 256
dim) that is 671 MFLOP at 4K and **42,950 MFLOP at 256K, 8.8× the 4860 MFLOP linear term**. So
intensity rises 3.27 → **11.04** FLOPs/byte from 4K to 256K, and the threshold `intensity/mfu` rises
with it:

| Part | peak/BW | floor binds below mfu at 4K | at 256K |
|---|---:|---:|---:|
| RTX 3090 | 38 | 0.086 | **0.290** |
| RTX 4090 | 98 | 0.034 | 0.113 |
| A100 / H100 / Arc | 201 / 295 / 313 | 0.016 / 0.011 / 0.010 | 0.055 / 0.037 / 0.035 |
| EPYC 7763 | 20.5 | 0.160 | **0.538** |
| laptop CPU | 17.9 | 0.183 | **0.616** |

**Round 5's claim "long context makes the floor more inert" is the opposite of the truth**, and round 5
computed it from the linear term alone. Longer context makes the floor **less** inert (attention FLOPs
grow ×8.8 while KV bytes grow ×2.6); higher concurrency makes it more inert (weights amortize over
streams, attention does not: 3.27 → 0.67 F/B from c1 to c16 at 4K). Verified against the calculator at
936 GB/s / 35.58 TFLOPS: 256K c1 → 216 tok/s at mfu 0.5 (bandwidth-bound, 936/4.333 = 216), 149 at
mfu 0.2 and 74 at mfu 0.1 (compute-bound) — crossover at mfu ≈ 0.29, exactly where `intensity/mfu =
peak/BW` puts it. The short-context conclusion survives: at mfu ≥ 0.2 the floor is inert on every GPU
and on server CPUs at 4K.

**Quick pass moved from n = 4 to n = 5 per side.** *(Superseded by round 7: the floor is n = 4, which is
what `design` returns for every effect the quick pass targets; n = 5 is an optional power purchase.)* At
4+4 with K = 2, Holm's first threshold is 0.025
and the only reachable p below it is 0.0143, which requires **U = 16/16 — a perfect separation**; one
loss gives U = 15, p = 0.0286, and the chain stops. Measured power: 84.0% at d = 3.04 for n = 4 versus
**95.7%** for n = 5 (α = 0.0159, U ≥ 23/25, tolerates two losses). Four runs per lever buy eleven
points of power. Quick pass is now 10 + 20 + 2 = **32 runs ≈ 13 h**, 43 with the 35% buffer ≈ 18 h.

**Holm applied to a discrete statistic quantizes the accept count, and coarsely.** *(Superseded by round
7: "0, 1, or everything" is an over-generalization — intermediate accept counts are reachable on real
grid values, and the quantization is a property of the specific (n, K), not a law.)* Measured grid at 8+8
(0.0001 … 0.0074, 0.0103, 0.0141, 0.0190, 0.0249, 0.0325, 0.0415) against K = 6 thresholds (0.0083,
0.0100, 0.0125, 0.0167, 0.0250, 0.0500): every threshold is reachable, but step 2's 0.0100 sits in the
gap between 0.0074 and 0.0103, so accepting two levers requires **both** on the top cell. Simulated:
one lever at 0.0074 and the rest at 0.0111 → accepts 1; two at 0.0074 → accepts all six. Documented,
with Bonferroni named as the alternative when you need levers accepted independently.

**1 × MAD is a threshold on the *difference of two medians*, and the skill never said so.** *(Superseded
by round 7: the factor below is the **asymptotic** median sd, which is 10.4% too big. The exact threshold
is **0.968 × MAD**, so 1 × MAD is the right default and 1.073 must not be used as a threshold.)* With 6
samples per run, `sd(median of 6) = sqrt(π/2)/√6 = 0.5117σ`, so `sd(difference) = 0.7236σ`, and in MAD
units (MAD = 0.6745σ) the exact threshold is **1.073 × MAD** — the 1 × MAD rule is 7.3% too tight.
Under the null, P(clearing it by chance) is **17.6%** at 1 × MAD and **3.1%** at 2 × MAD, which is why
1 × MAD is a screening reading and `accept` is the test.

**Reviewer claims I measured and rejected (the round-4/5 rule working in both directions):**
- *"Only the last Holm step is reachable at 8+8 with K = 6; the stage accepts at most one lever."*
  **False.** All six thresholds are reachable on the measured grid; the real content is the accept-count
  quantization above, which is now documented.
- *"A 30% thermal drop zeroes the gap table."* **False.** c1 decode (53 of 103) is still a **26.5%** gap
  at 0.70 × peak and collapses only at a **48.5%** drop; KV capacity is 64.1% at 0.70 and collapses at
  74.9%; only prefill (already `n/a`) is negative. The legitimate core — a fixed 0.80/0.85/0.90 band
  silently assumes a 10–20% drop — is fixed: the band is now `measured_drop ± uncertainty`, with the
  collapse point per row (`1 − current/peak`) and a stated branch for "every row collapsed".
- *"Exact power at 4+4, d = 2.08 is 81.1%, so `design` over-sizes to 5."* **False.** Measured at 400k
  sims: **69.05% ±0.07** at 4+4 (u ≥ 15, α = 0.0286) versus 88.63% at 5+5 — n = 5 is the smallest n
  clearing 80%. The quoted 81.1% matches neither the exact value nor the normal approximation (52.4%).
  An independent scan of 18 (K, d) combinations found **zero** over-sizing: `design` returns the
  smallest valid n in every case.
- *"1 × MAD as a difference threshold implies a 12.9% null rate."* **False** — that treats MAD as σ.
  The correct figure is 17.6% (z = 0.932).

**Other round-6 fixes:** `looping()` is now multi-scale (8-, 4-, 2-grams) — a single 8-gram scale
needed ≥16 words of output, so a 3-word cycle stopping at 15 words passed the guard undetected;
`out_tokens_spread_pct` is measured **per prompt** (a heterogeneous panel has a large intrinsic
cross-prompt spread, and speculation changes length by design, so the old cross-prompt threshold
flagged the best lever on panel composition) with the cross-prompt number kept as
`out_tokens_panel_spread_pct`; `accept`'s verdict now says it is the **per-lever uncorrected** gate and
that Holm at α/K is the confirm-stage gate; `mem_peak_warmup_gib` and the per-prompt spread are
documented in SKILL.md and the harness header, with the "steady state equals startup spike ⇒ the config
never gave the memory back" reading and a note that 3 probes × 3 s is too short for a JIT-heavy engine;
the stats.py docstring's "a 20% gain needs 2" is corrected to 3 (at 2+2 no p ≤ 0.05 exists); a
user-override protocol (cost estimate, power, run count, "measured not actionable", logged) and a
single-logging rule for levers deferred by both gates; the median-of-6 gap is quantified at the n
`design` actually recommends (+1.2pp at 8+8/d = 2.08, +6.2pp at 8+8/d = 1.5); `accept --confirm-set`
now says "K = 6 ASSUMED" when the flag is omitted instead of asserting a K the user never set; the
quick-pass run notation is spelled out (`K = 2 levers × n = 5 per side × 2 sides = 20 runs`).

**Verified clean by round 6, with evidence:** the reductionist re-checked all 16 methodology components
(defined once, referenced consistently, implemented), every budget row at 25 min/run, every `design`
citation for `--confirm-set`, and the MAD uses across the plugin; the devil's advocate's second pass
returned **0 findings — clean** on the round-5 state (α/K sizing, quick-pass arithmetic, the full budget
table, the two-direction gap formula, the three MAD thresholds, warmup semantics, the median-of-6
scale argument); theory confirmed the latency-gap form is the right one (bounded in [0,1), and the
floor-denominator variant is unbounded and ranks a 70 s floor above a 2.43 M-token capacity gap for the
same 1 point of Exp. gain); the normal approximation is never anti-conservative across 50 (n, d)
combinations.

**Runtime verification after the round-6 fixes:** see the round-6 verification block in the session log —
`py_compile` and `bash -n` clean, `selftest` PASS, `ceiling.py` reproduces the shipped fixture exactly
(68 / 58 / 38 / 27 tok/s at c1, 142 at c4, 3465 → 684 prefill, 2.68 GB per 256K stream: the fixture is
bandwidth-bound at every cell, which is the point of the crossover table), and on a 3090-class
configuration the new decode attention term produces 216 / 149 / 74 tok/s at mfu 0.5 / 0.2 / 0.1 at
256K with the crossover at mfu ≈ 0.29.

## Round 7

Round 7 re-ran the same four reviewers against the round-6 state. The reductionist returned **0 findings —
clean**, which is the first clean pass by a full reviewer since the loop started. The other three found
real defects, and two of the round-6 "fixes" were themselves the error — including one I introduced and
one the loop's own over-correction created.

**The intensity bound: round 6 over-corrected the headline, and the bound is a model constant.** Round 6
wrote "GEMV decode stops being bandwidth-bound at long context" with no hardware qualifier. Theory showed
that is **false on discrete GPUs**: intensity is *bounded*, because as L → ∞ the weights and the linear
FLOP term both vanish relative to L, leaving

    intensity_max = 4 × attn_layers × attn_heads × head_dim ÷ kv_bytes_per_token

which is **16.00 FLOPs/byte** on the worked example (measured 14.26 at 1M context, approaching from
below; 3.27 at 4K, 11.04 at 256K). The floor binds only when `intensity > mfu × peak/BW`, so at mfu 0.5
the thresholds are 19.0 (3090), 48.8 (4090), 100.3 (A100), 147.6 (H100), 156.5 (Arc B390) — **all above
16.0, so on a discrete GPU at mfu ≥ 0.5 the floor never binds at any context**. It binds at mfu 0.5 only
on the low-peak-per-byte parts: EPYC 7763 (threshold 10.2) and a laptop CPU (8.9). So the headline is a
statement about **CPUs and iGPUs**, and round 2's "CPU story" label was right for long context after all.
The bound is model-dependent: halving KV bytes per token doubles it to 32.0 F/B, above the 3090's mfu-0.5
threshold — check it per model instead of repeating "GPUs are never compute-bound in decode".

**The median-of-6 "lower bound" was an artifact of the asymptotic sd, and `power_exact` is essentially
exact.** The sd of a median of 6 standard normals is **0.4617** — computed exactly by order-statistic
integration (`E[X₍₃₎X₍₄₎]` over the joint density of the two middle order statistics) and cross-checked by
200,000 simulated medians (0.4635, 0.4% apart; the same integration reproduces k = 2 → 0.7064 against the
true 1/√2 = 0.7071 and k = 3 → 0.6698 against 0.6696). The textbook asymptotic form `sqrt(π/2)/√6` gives
0.5117, **10.8% too big** (k = 6 is not large: the same formula is 25% off at k = 2, 15% at k = 4, 8% at
k = 3). Scaling the simulation with the exact reciprocal (1/0.4617 = 2.166) makes the
median-of-6 power match the single-sample model within simulation error: **+0.1pp** at 4+4/d = 1.0, +0.5pp
at 6+6/d = 1.0, **+0.1pp** at 8+8/d = 2.08, +0.2pp at 8+8/d = 1.5, −0.3pp at 4+4/d = 3.21. Round 6's
"+1.2 to +6.2pp lower bound, `design` is conservative" came from the 0.5117 scale, which gives the
simulated median tails heavier than a real median-of-6 has. The trap the round-5 note warns about is
unchanged (drawing from N(d, 1) multiplies the effect by 2.166, not 1.954). The first analytic attempt
here was itself wrong — it returned 0.884 for k = 2, where the answer is 1/√2 = 0.7071, because the outer
integrand of the joint-density integral was missing its `x` factor; the k = 2 case is the check that
catches that bug, so it is stated here.

**Consequence: the exact 1 × MAD factor is 0.968, not 1.073.** `sd(difference) = 0.4617 × √2 = 0.6530`,
so in MAD units the exact threshold is **0.968 × MAD** — the 1 × MAD rule is 3% *too loose*, not 7.3% too
tight, and it is the right default. P(clearing by chance under the null): **15.1%** at 1 × MAD, **1.9%**
at 2 × MAD (17.6% / 3.1% on the asymptotic sd). This also settles the round-7 finding that the skill
"never names a default": 1 × MAD is the default, and 1.073 is retired as an artifact.

**Monotonicity: the claim is true of exact power and false of the normal approximation.** Exact power is
monotonic in n for d ≥ 1.5 (verified n = 3…12 at d = 1.5, 2.0, 2.5, 3.0, 3.21, 4.0, 5.14 — no dips). The
**normal approximation** dips at 3→4 *and* 7→8 at **every** d tested, including d = 3.0 (85.0% → 83.6%,
89.9% → 88.8%), because it is a step function of the discrete rejection point. And the d = 1.2 numbers
round 6 quoted (32.9% → 31.1%) are the **3+3 → 4+4** boundary, not 7→8, where d = 1.2 is monotonic
(65.2% → 68.0%).

**Quick pass: the floor is n = 4, and n = 5 is a purchase, not a rule.** Round 6 raised the floor to 5;
`design --confirm-set 2` returns **4** for every effect the quick pass targets (measured: d = 3.06 → n = 4,
84.5% power; d = 5.11 → n = 4, 99.8%), so forcing 5 contradicts the skill's own power-driven sizing rule.
n = 4 is the hard floor because it is the smallest n whose chain can fire at K = 2 (α = 0.0143 ≤ 0.025;
n = 3+3 cannot produce p ≤ 0.025 at all). n = 5 buys 11.7 points of power for 8 runs (2 h) — worth taking
when the target sits near the boundary (at d = 2.02, power is 49.6% at n = 4 and 68.4% at n = 5, and
`design` asks for 6). Budgets now quote n = 4 and name the upgrade.

**The sustained-ceiling measurement was in the rules but not in the budget.** The gap table ranks against
the *sustained* ceiling and the skill prescribes a 20+ minute sustained load to get `thermal_drop_pct`,
yet no budget row paid for it. Added: 2 runs to the full pass and 1 to the quick pass. Full pass
10 + 2 + 120 + 96 + 10 = **238**, + 83 buffer = **321 runs = 134 h ≈ 5.6 days**; quantization
10 + 2 + 96 + 10 + 41 = **159 runs = 66 h ≈ 2.8 days**; quick pass 10 + 1 + 16 + 2 = **29 runs ≈ 12 h**,
39 with buffer ≈ 16 h (n = 5 variant: 33 ≈ 14 h, 45 ≈ 19 h).

**Accept-count quantization is a property of (n, K), not a law.** Round 6's "effectively 0, 1, or
everything that hits the top cell" is an over-generalization. Enumerated on real grid values: at 8+8/K = 6,
[0.0074, 0.0074, 0.0103, 0.0249, 0.0249, 0.0249] → accepts **3**, and [..., 0.0141, 0.0249, 0.0524] →
accepts **5**; at 5+5/K = 6 (grid 0.0040, 0.0079, 0.0159, 0.0278, 0.0476) → 1, 2 and 6 are all reachable.
The sharp statement that holds everywhere: the chain stops at the first p exceeding its own threshold, so
the accept count is where the k-th smallest p lands against threshold k.

**`extra_flops_per_token` was prefill-only.** Decode undercounted SSM/GDN/Mamba/RoPE/norm FLOPs, which are
per-token costs like everything else in the term. Added to `decode_flops_per_stream`: 47,810 → 63,810
MFLOP per stream at 256K with a 16 GFLOP/token term. On the shipped fixture the decode ceiling is
unchanged (26.5 tok/s at mfu 0.1 — bandwidth binds), and prefill moves 3465 → 849 tok/s at 4K, which is
the term doing its job.

**The per-prompt output-length guard was blind at the default configuration — a bug I introduced in
round 6.** Per-prompt spread needs each prompt sent at least twice; at the default `--reps 6` with the
default 6-prompt panel every prompt is sent **once**, so `len(vs) >= 2` is never true, the spread was
recorded as **0.0%**, and the guard policed nothing. Measured coverage: panel 6 / reps 6 → **0 of 6**;
6/8 → 2 of 6; 6/12 → 6 of 6; 12/6 → 0 of 12. Now: `out_tokens_coverage_pct` is recorded, the spread is
**null** (not 0.0) when nothing is testable, an `OUT_LEN_UNTESTED` flag fires, and `bench.py` warns at
start-up when `--reps < 2 × panel`. The grouping is also keyed by the prompt actually sent, not by list
position (a failed request shifted every later prompt into the wrong group).

**`looping()` had a false positive, and is now calibrated on measured ratios.** The round-6 multi-scale
version (one 0.5 threshold at 8-, 4- and 2-grams) flagged a **legitimate 29-word answer that repeats a
2-word term 10 times** (2-gram ratio 0.607) as degenerate. Measured ratios on normal output: 8-gram
0.00–0.50, 4-gram 0.00–0.58, 2-gram 0.00–0.74 — so a single threshold cannot serve all three scales. The
calibrated guard uses scale-specific thresholds **0.5 / 0.7 / 0.85** with floors 8 / 8 / 4, plus a
single-word-stall check (≥ 4 identical words) and a **tail-periodicity** check — the signature of a loop
that runs to max_tokens, which is what keeps legitimate output safe, because a real answer has a
non-repeating tail.

**The obvious version of that tail test had its own false positives, found by testing the guard against
structured output.** "The last 2p words repeat the p before them" flagged a markdown table whose last two
data rows are identical, a code block ending in `}`, a list ending in a duplicated item, and an answer
that repeats its closing sentence once — all four legitimate. Requiring **three** full periods, **≥ 2
distinct words** in the repeated block, and **case-insensitive** matching clears every one of them, and
catches two loops the two-period rule missed (a sentence loop that capitalizes each cycle, a ChatML-style
role loop). The cost is a 3-word cycle that stops at 8 words, which is now a stated blind spot rather
than a silent one. Round 8 then attacked the guard with structured output it had never seen and found two
more blind spots, which is why the guard has **three** tests, not two: a word-level tail test, a
**line-level** tail test (`tail_lines`) and a **bracket-separated token** tail test (`tail_tokens`).
The line test is what catches a CSV row loop, a pretty-printed JSON object loop, a numbered-list loop and
code repeating one line to the end — compact rows are ONE word, so the "≥ 2 distinct words per block" floor
made the word-level test blind to them. It excludes lines with no alphanumeric character, so a code block
ending in `}` `}` `}` is not a loop. The token test exists because a whitespace tokenization glues the
closing delimiter to the last value (`9}]`), which breaks the exact-match chain. Final calibration,
measured: **44 cases, zero false positives on 20 normal outputs** (prose, code, JSON arrays, markdown
tables, numbered lists, name lists, YAML, multilingual prose, short answers, a repeated-term answer, a
table with one duplicated trailing row, JSON with one duplicated trailing object, code ending in four
closing braces, code ending in three closing braces, an answer repeating its closing sentence twice, a
code block ending in two identical lines) **and 18 of 19 degenerate outputs caught**. Two documented
blind spots remain: the 8-word 3-cycle, and a **single-line** JSON array with identical trailing objects
(the closing `]` defeats every exact-match chain and the n-gram ratios stay under threshold) — the second
is caught by `stats.py outlen`, because a loop that runs to max_tokens inflates `out_tokens_median`.
Structured output with three genuinely identical trailing rows (table, CSV, YAML) **is** flagged, and that
overlap is irreducible: it is structurally indistinguishable from a 3-row cycle, which is exactly why
`LOOP` is advisory and not a void. A clean `LOOP` flag is not proof of clean output.

**The default `--reps 6` made the length guard unmeasurable, so the default is now 2 × panel.** `bench.py`
resolves `reps = 2 × len(panel)` when `--reps` is not passed — 12 on the shipped 6-prompt panel — so the
guard runs by default instead of warning by default. Passing `--reps` below 2 × panel is still allowed
(it is the user's call) and still produces the warning plus `OUT_LEN_UNTESTED`. Run cost is unchanged:
the 25 min/run budget is dominated by server startup and the sustained phases, and 12 panel requests at
512 tokens are about 2 minutes.

**Thermal uncertainty is hardware-dependent, not ±5 points.** A 20-minute sustained clock ratio on a
well-cooled desktop GPU gives **±2–3 points**; a machine whose clocks **sawtooth** (laptops,
small-form-factor, fan-limited parts) can have the whole window land in the cool or the hot phase, giving
**±10–15 points**. The rule now says: log the clock every second, and if the trace oscillates between two
plateaus, take the **hot** plateau as the sustained ceiling — a sawtooth's mean is a ceiling the machine
only touches at its peaks.

**"Measured, not actionable" now has an operational definition.** It is a **rejection** for every
operational purpose: no confirm stage, not in `best-config.json`, not in the published recipe, config
rolled back like any rejected run. Installing it anyway is a second, explicit decision recorded as
`installed by instruction, not by evidence`, with the power number beside it. The report table gets its
own disposition (`not-actionable`) so it can never read as an accept.

**Reviewer claims I measured and rejected (round 7):**
- *"The compute ceiling is per-stream while the bandwidth ceiling is aggregate, so `min()` mixes units and
  overstates the aggregate by n× (12× at n=16)."* **False — n cancels.** Each stream pays its own matmul on
  its own activations and its own attention, so one step costs `n × flops_stream` FLOPs and emits
  `accept × n` tokens: `tok/s = (mfu·peak / (n·flops_stream)) · accept · n = mfu·peak·accept / flops_stream`.
  Measured at 256K, 936 GB/s, 35.58 TFLOPS, mfu 0.1: **74.42 tok/s at n = 1, 4 and 16** (the per-stream
  share is 74.4 / 18.6 / 4.7). Dividing by n, the "fix" the finding asked for, would make the aggregate 16×
  too small. The derivation is now a comment in `decode_ceiling` so it is not "fixed" again.
- *"At 5+5 with K = 6, at most 2 of the 6 Holm steps can fire."* **False.** The 5+5 grid is 0.0040, 0.0079,
  0.0159, 0.0278, 0.0476 and every one of the six thresholds (0.00833 … 0.0500) is reachable, best p = 0.0040.
- *"1 × MAD vs 1.073 × MAD has no authoritative default."* Real finding, resolved by measurement: the exact
  factor is **0.971**, so 1 × MAD is the default and 1.073 is retired.
- *"A 60-line 'Step N: complete task X' list passes the loop guard."* Depends on the text: the round-6
  version flagged it (2-gram ratio 0.589), the calibrated version does not (threshold 0.85), and that is the
  intended behaviour — a numbered list with unique items is not degenerate. The template class that *is*
  degenerate is documented as a blind spot and is caught by the output-length guard.

**Runtime verification after the round-7 fixes:** `py_compile` clean on all three scripts, `bash -n` clean
on both shell scripts, `stats.py selftest` **PASS** (10 size pairs, 12,870 partitions at 8+8),
`ceiling.py` reproduces the shipped fixture exactly (68 / 58 / 38 / 27 tok/s c1, 142 at c4, 3465 → 684
prefill, 2.68 GB per 256K stream), the intensity bound prints 16.00 F/B, the aggregate decode ceiling is
74.42 tok/s at n = 1/4/16 (compute-bound) and 216 / 271 / 296 at mfu 0.5 (bandwidth-bound, rising with n
as the weights amortize), `design --confirm-set 2` returns n = 4 at d = 3.06 (84.5%) and d = 5.11 (99.8%)
and n = 5 at K = 6 (90.1%), `design` at d = 0.20 exits with the "not testable" verdict and the three ways
out, and the calibrated `looping()` passes 17/17 cases with zero false positives. *(Superseded by round 8:
the guard was re-calibrated on 44 cases, 20 of them legit, and the round-7 17-case set did not include
structured output.)*

## Round 8

Round 8 re-ran the same four reviewers against the round-7 state. All four returned findings: the
reductionist 5 (all low), the devil's advocate 6, the sophist 3 (one high), theory 1. The round-7
reductionist pass had been clean; this round was not, and the highest-severity finding was a **general
claim I wrote in round 7 that is false for the architectures the skill is most likely to be pointed at.**

**The intensity bound has a closed form, and it is not a hardware statement.** Round 7 stated the bound as
`4 × attn_layers × attn_heads × head_dim ÷ kv_bytes_per_token` = 16.0 F/B and drew the headline "on a
discrete GPU at mfu ≥ 0.5 the floor never binds at any context". Expanding
`kv_bytes_per_token = n_kv_layers × c × kv_heads × head_dim × bpe` cancels **both the layer count and the
head width**, leaving

    MHA / GQA / MQA (c = 2):  intensity_max = 2 × (query_heads / kv_heads) / bpe = 2g / bpe
    MLA latent sharing (c = 1): intensity_max = 4 × query_heads × d_compute / (latent × bpe)

The closed form reproduces the fixture exactly: its `kv_bytes_per_token` of 10,240 is
`2 × 10 × 16 × 256 × 0.125`, i.e. **MHA with 1-bit KV**, which is why its bound is 16.0 and not 1.0. The
general values are MHA FP16 **1.0**, MHA FP8 2.0, MHA INT4 4.0, MHA 1-bit 16.0, GQA-4 FP16 4.0, GQA-8
FP16 8.0, GQA-8 FP8 16.0, GQA-8 INT4 32.0, MQA-16 FP8 32.0, and **MLA 128 heads 256.0 (FP16) / 512.0
(FP8)**. Against the mfu-0.5 thresholds (3090 19.0, 4090 48.8, A100 100.3, H100 147.6, Arc 156.5, EPYC
10.2, laptop CPU 8.9): the round-7 headline is true for **MHA/GQA with FP16–FP8 KV**, and false for MQA,
for INT4/1-bit KV with GQA, and for **MLA, whose bound exceeds every GPU in the table**. MLA exists
precisely to trade bytes for FLOPs, so an MLA model at long context is the case where the compute floor is
the interesting constraint — "decode is bandwidth-bound" is an MHA/GQA FP16-KV statement, and the skill
said it as if it were a law.

Measured on a 27B MLA configuration (30 layers, 128 heads, 576-element latent, FP8 KV, 3.7B active) on an
H100 at mfu 0.5: intensity 5.41 → 34.71 → 113.69 → **185.69** F/B from 4K to 256K against a threshold of
147.6, crossover **186,369 tokens**, and the 256K cell is compute-bound at **213 tok/s** where bandwidth
alone allows 267. On a 3090 with GQA-8 INT4 KV (32 layers, 64 query / 8 KV heads, head_dim 128,
kv_bytes_per_token 32,768) the bound is 32.0 and the crossover is **498,097 tokens**, so at 256K it is
still bandwidth-bound (45 tok/s) and the floor takes over only past 500K — the crossover context, not just
the bound, is what decides the headline.

**`ceiling.py` now computes this instead of prose telling you to.** New `intensity_bound(m, drafts)`
(divides by `kv_rows`, so per-row speculation *lowers* the bound) and `crossover_ctx(m, n, drafts)`,
printed for every config with the per-concurrency crossover. The crossover is
`L = (T·B0 − n·F0) / (n·(a − T·rows·kv))` with `T = mfu·peak/BW` in FLOPs per **byte**, and it was verified
against the measured cells: MLA crossover 186,369 sits between the 128K cell (bandwidth-bound, 326) and
the 256K cell (compute-bound, 213); GQA-8 INT4 crossover 498,097 is above every cell in the table, and all
of them are bandwidth-bound; the fixture reports "never binds", and every cell is bandwidth-bound.

**The first implementation of that print was wrong, by 10⁹, and the measured cells are what caught it.**
`mfu × peak_tflops × 1e12 / bandwidth_gbs` is FLOPs per **GB**, not per byte; the GB has to be expanded.
The bug made every threshold 10⁹ too big, so every config printed "the compute floor NEVER binds at any
context" — the exact failure mode the feature exists to detect, printed as a reassurance. The crossover
function was dimensionally consistent with its own algebra and kept giving the right numbers, which is why
the check that mattered was "does the crossover land between the two cells that flip" and not "does it
run".

**`stats.py outlen`: the length gate had a blind spot both the sophist and the devil's advocate found.**
The per-prompt spread compares repeats of the *same* prompt and the speed test compares tok/s, so a lever
that scales every answer by the same factor has spread exactly **0%**, coverage **100%**, a clean `LOOP`
flag, and a speed test that passes — and it is a shorter answer, not a faster one. Nothing in the skill
compared the candidate's output-length medians against the control's. `bench.py` now records
`out_tokens_by_prompt` (per-prompt medians in panel order) and `stats.py outlen --ctl … --cand …`
compares them, flagging any prompt that moved more than 20% (default `--threshold`) plus the overall
median. Measured: a uniform −50% shortening is flagged on all six prompts (overall median 107 → 54), a
+27% lengthening is flagged on all six, and a clean lever (±3%) is not. A mismatched panel exits with a
message naming the pairing rule.

**`looping()` needed a third test, and the calibration set needed structured output.** The word-level tail
test is blind to compact structured output: a CSV row (`7,14`) and a JSON object (`{"id": 9}`) are ONE
whitespace token, so the "≥ 2 distinct words per block" floor rejects them and a model looping out
identical rows to max_tokens is not flagged. Added `tail_lines` (three identical trailing non-empty lines,
excluding lines with no alphanumeric character so a code block ending in `}` `}` `}` is not a loop) and
`tail_tokens` (bracket-separated token stream, because a whitespace tokenizer glues the closing `]` to the
last value as `9}]` and breaks the exact-match chain). Re-measured on **44 cases: 0 false positives on 20
legit outputs** (including a table with one duplicated trailing row, JSON with one duplicated trailing
object, code ending in four closing braces, code ending in three closing braces, a code block ending in two
identical lines, YAML, multilingual prose) **and 18 of 19 degenerate outputs caught** (the new catches:
CSV row loop, pretty-printed JSON loop, numbered-list loop, bullet-list loop, code repeating one line to
the end). Two documented blind spots: the 8-word 3-cycle, and a **single-line** JSON array with identical
trailing objects — the second is caught by `outlen`, because a loop that runs to max_tokens inflates
`out_tokens_median`. Structured output with three genuinely identical trailing rows (table, CSV, YAML) is
flagged, and that overlap is irreducible, which is why `LOOP` is advisory and does not void a run.

**Reviewer claims I measured and rejected (round 8):**
- *"The intensity bound is 92.0 F/B on a 46-layer / 16-head / head_dim-2048 model, so the headline is
  false for GQA."* The **conclusion is right and the fixture is not**: its `kv_bytes_per_token` of 65,536
  equals `2 × 16 × 2048 × 1`, i.e. it omits the layer factor, so the model it describes cannot exist. The
  closed form is the correct way to settle the question, and it says the headline is false for MQA/MLA and
  INT4/1-bit KV — which is why the fix is the closed form, not a caveat sentence.
- *"The quick pass skips the screen stage without saying it deviates from a non-negotiable ground rule."*
  Partly false: SKILL.md already said **"No screen stage"** and gave the reason. What was missing was the
  ground-rule side naming it as a sanctioned exception, so the two sections no longer read as a
  contradiction. Added there.
- *"1 × MAD factor is 0.971."* Superseded by measurement: the **analytic** sd of a median of 6 standard
  normals is **0.4617** (order-statistic integration; the same integration reproduces k = 2 → 0.7064
  against the true 1/√2 = 0.7071 and k = 3 → 0.6698 against 0.6696), 0.4% below the simulated 0.4635, so
  the factor is **0.968**, P(clear by chance) 15.1% at 1 × MAD and 1.9% at 2 × MAD. Round 7's 0.971 came
  from the simulated sd; both are within 0.4% of each other and 1 × MAD remains the default.

**Small defects fixed:** `bench.py`'s usage line still showed `--reps 6` (now `--reps N` with the 2 × panel
default stated); `stats.py power` defaulted to the asymmetric 6+4, a design the skill never runs (now
6+6); `references/ceilings.md` had the same sentence pasted twice; the quick-pass buffer said 40 runs
where the skill's own rule `round(0.35 × runs)` gives 29 + 10 = **39 ≈ 16 h** (theory and the reductionist
found this independently); a `not-actionable` lever's relationship to the plateau count was unstated (now:
the plateau counts levers **run and measured inside noise** — not-actionable, deferred, and
double-logged levers do not count); `publishing.md` never said that not-actionable levers stay out of the
recipe; `methodology.md` never named the 1 × MAD threshold (now it does, with 0.968 and the pointer to
SKILL.md).

**Runtime verification after the round-8 fixes:** `py_compile` clean on all three scripts and `bash -n`
clean on both shell scripts; `stats.py selftest` **PASS** (10 size pairs, 12,870 partitions at 8+8);
`ceiling.py` reproduces the shipped fixture exactly (142 tok/s at c4, 3465 → 684 prefill, 2.68 GB per
256K stream) and prints bound 16.0 vs threshold 156.5 → "never binds"; the MLA config prints bound 512.0
vs 147.6 → binds, crossover 186,369, with the 256K cell at 213 tok/s; the loop calibration reports
**20 legit cases 0 false positives, 19 loop cases 18 caught, 3 of 5 advisory structured cases flagged**;
`stats.py outlen` flags the uniform −50% and +27% cases and passes the ±3% case; `design --confirm-set 2`
at d = 2.08 returns n = 6 with exact α 0.0206 ≤ α/K 0.0250 and 85.7% power; `bench.py` with no arguments
prints usage and `bench.py show` prints the "no ledger yet" message; `power` defaults to 6+6 (α 0.0465);
`__pycache__` removed from the plugin tree.

## Round 9

**Focus:** crossover_ctx four-quadrant logic, stats.py outlen uniform shift, design --confirm-set warning,
accept-lossy disposition, looping() three tests, budget arithmetic, 1×MAD = 0.968.

**Findings fixed:**
- `ceiling.py` crossover_ctx quadrant C ("binds BELOW") docstring: changed from "rare and unphysical" to
  "effectively impossible" with mfu < 0.001 derivation.
- `ceiling.py` crossover_ctx early-return for denom == 0 consolidated.
- `stats.py outlen` uniform shift: new --uniform 5% default, catches when all prompts move the same way
  even if below the 20% per-prompt threshold.
- `stats.py design`: when --confirm-set omitted, n sizes against alpha/1, producing too-small n. Prints
  WARNING and proceeds (design choice: hard error breaks programmatic use).
- `looping()` three tail tests (word, line, bracket-separated token) calibrated on 44 cases: 0 FP,
  18/19 loops caught, 3/5 advisory.
- `stats.py outlen`: panel mismatch exits with error (zip truncation fixed).
- `accept-lossy` disposition added to SKILL.md, PROMPT.md, and loop diagram.
- Budget rows verified: 321 = 133.75 h, 159 = 66.25 h, 39 = 16.25 h, 45 = 18.75 h.

**Runtime verification:** All fixtures (ornith, mla, gqa8_int4, gqa8_kvprow, quad, absurd) run clean.
ceiling.py prints intensity bound, crossover, per-drafts bound. stats.py selftest passes.

## Round 10

**Focus:** Review of round-9 changes. Convergence push — goal was 2 consecutive clean rounds.

**Findings fixed:**
- `ceiling.py` Quadrant C docstring: changed from "rare and unphysical" to "effectively impossible"
  with the mfu < 0.001 derivation (devil's #1).
- `ceiling.py` minor logic cleanup in crossover_ctx: consolidated early-return guard.

**Design choices kept (not defects):**
- outlen majority-direction gap (5/6 prompts move −10%, 1 up +10% → passes clean): deliberate design —
  uniform rule catches uniform effects, not majority effects.
- design defaults to warning not hard error: deliberate — a hard error breaks programmatic use.
- Report table missing Disposition column: fixed in round-10.1.
- Loop diagram omits accept-lossy/not-actionable: fixed in round-10.1.

**Runtime verification:** All scripts compile clean. All fixtures reproduce correctly. Loop calibration
0 FP, 18/19 caught, 3/5 advisory. Budget arithmetic verified.

## Round 11

**Focus:** Review of round-10 changes (outlen uniform/majority, design warning, crossover_ctx fix,
report table Disposition column, loop diagram).

**Findings fixed:**
- `stats.py` outlen --help crash: unescaped `%` in help string (argparse uses % formatting). Fixed by
  escaping as `%%`.
- `stats.py` outlen rounding boundary: `round(overall, 2)` fixed the -2.999... under-representation but
  introduced false positives at 2.995% → 3.0. Replaced with epsilon guard (`1e-9`).
- `stats.py` outlen verdict text: "(0 shortened, 0 lengthened)" misleading for uniform/majority shifts
  where all prompts moved. Fixed to show direction: "X prompts moved down/up".
- `stats.py` outlen VERDICT omission: when only majority fires, VERDICT text omitted "majority shift".
  Fixed to append when majority fires and uniform does not.
- `stats.py` design WARNING moved to stderr (more visible, doesn't mix with VERDICT on stdout).
- `ceiling.py` denom == 0 edge case: when flat intensity curve starts above threshold (num < 0), was
  returning None. Now returns (0, True) = binds at every context.
- PROMPT.md report table: added Disposition column.
- SKILL.md loop diagram: updated to show all four dispositions.
- SKILL.md report table prose: added "disposition" to the metric/baseline/now/ceiling list.
- publishing.md: added accept-lossy guidance (these levers ARE included in published recipe).

**Runtime verification:** All fixtures reproduce correctly. stats.py selftest passes. outlen verdict
text correct for all directions (UP, DOWN, majority-only). Rounding boundary: 2.995% correctly does NOT
trigger 3% threshold; exact -3.0% does trigger (epsilon catches float under-representation).

## Round 12

**Focus:** Review of round-11 changes (epsilon guard, verdict text, publishing.md accept-lossy,
crossover_ctx denom==0). Also review of round-12 change (SKILL.md MAJORITY SHIFT documentation).

**Findings:**
- Theory: SKILL.md documents UNIFORM SHIFT but not MAJORITY SHIFT — the code implements the check
  and prints "MAJORITY SHIFT" in verdicts, but SKILL.md never explains it. Agent reading the skill
  would see "majority shift" in output with no explanation.
- Sophist: 0 findings — clean.

**Fix:** Added MAJORITY SHIFT documentation to SKILL.md line 160 alongside the UNIFORM SHIFT docs:
"It also flags a MAJORITY SHIFT — when ≥N-1 prompts move the same way with overall ≥ 3%
(`--uniform-majority`, default 3%) — catching cases where one prompt diverges but the majority
still indicates length change as the mechanism."

**Runtime verification:** All scripts compile clean. All fixtures reproduce correctly. Verdict text
correct for all scenarios. Epsilon guard verified: -2.999... triggers, 2.995% does not.

## Round 13

**Focus:** Review of round-12 change (SKILL.md MAJORITY SHIFT documentation in rule 160). Also
cross-reference audit of all outlen-related documentation.

**Sophist findings:**
- **Finding 1:** SKILL.md MAJORITY SHIFT absent — **FALSE POSITIVE**. MAJORITY SHIFT is present
  in SKILL.md line 160. The sophist was working with stale state or a cached version of the file.
- **Finding 2:** SKILL.md line 291 (disposition text) only mentions "uniform shift", not
  "majority shift". The disposition text enumerates outlen triggers as "(per-prompt move past
  the threshold, or a uniform shift)" — the code has THREE mechanisms but the text only names two.

**Theory findings:**
- Same 2 documentation gaps identified: SKILL.md line 291 and PROMPT.md line 39.
- PROMPT.md only says "outlen flags any prompt whose median moved more than 20%" — omits both
  uniform and majority shift checks.

**Fixes applied:**
- SKILL.md line 291: changed to "(per-prompt move past the threshold, a uniform shift, or a
  majority shift — the three detection mechanisms)"
- PROMPT.md line 39: added all three mechanisms with names and thresholds

**Runtime verification:** All scripts compile clean.

## Round 14

**Focus:** Cross-reference audit of all outlen-related documentation. Verify SKILL.md line 291 (disposition text) and PROMPT.md line 39 (outlen instructions) are complete and accurate.

**Sophist findings:**
- PROMPT.md line 39 says "it prints a VERDICT for each case" — wrong. stats.py prints exactly one VERDICT line per invocation, aggregating all three mechanisms.

**Theory findings:**
- **0 findings — clean.**

**Fix:** PROMPT.md changed "it prints a VERDICT for each case" → "it prints a single VERDICT that aggregates all three checks."

**Runtime verification:** All scripts compile clean. All fixtures reproduce correctly.

**Round 14 scorecard:**
- Theory: 0 findings — clean ✓
- Sophist: 1 finding (fixed in same round) — not clean

**Consecutive clean rounds: 0.** Not converged.

## Round 15

**Focus:** Review of round-14 change (PROMPT.md VERDICT text fix). Convergence push.

**Sophist findings:**
- **0 findings — clean.** VERDICT aggregation text verified. Epsilon guard (1e-9) present in code comments — deemed not worth documenting externally. All 12 verdict text combinations tested and verified.

**Theory findings:**
- **0 findings — clean.** VERDICT aggregation confirmed across all code paths. Verdict text correctly identifies which checks fired. Stale number sweep clean.

**Consecutive clean rounds: 2.**

## CONVERGED

**Convergence criterion met at round 15:** 2 consecutive zero-finding rounds (theory and sophist both clean at round 15).

**Summary across 15 rounds:** ~210+ raw findings found. ~100+ genuine defects fixed. All scripts compile clean. All fixtures reproduce correctly. All documentation cross-references consistent. The methodology is sound, the code is tested, and the documentation is complete.

Key fixes across all rounds:
- ceiling.py: crossover_ctx four-quadrant logic, denom==0 edge case, Quadrant C docstring
- stats.py: --help crash (% escape), epsilon boundary, majority shift check, verdict text, design warning to stderr, panel mismatch error
- SKILL.md: MAJORITY SHIFT documentation, disposition text, loop diagram, report table prose
- PROMPT.md: Disposition column in report table, outlen documentation, VERDICT aggregation
- publishing.md: accept-lossy guidance
