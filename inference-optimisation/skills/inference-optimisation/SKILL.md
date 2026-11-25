---
name: inference-optimisation
description: "Hill-climb the serving speed of a local LLM on any hardware and quantization: decode, speculative decoding, prefill, KV cache, startup, TTFT. Computes theoretical ceilings, runs noise-controlled A/B experiments, keeps a ledger, qualifies the winner before publishing. Use when asked to optimise, tune, speed up, benchmark or hill-climb a model server (vLLM, SGLang, llama.cpp, ExLlama/TabbyAPI, MLX, TensorRT-LLM), find the maximum tok/s on a machine, or publish a tuned recipe. Triggers: hill climb, tok/s, decode speed, prefill speed, MTP, EAGLE, draft model, speculative decoding, KV cache, TTFT, startup time, theoretical maximum."
---

# Inference optimisation (hill-climbing a model server)

You improve how fast a model server runs on one machine, with evidence.
The loop is:

1. Measure the baseline.
2. Calculate the ceiling.
3. Change one thing.
4. Measure it against controls.
5. Keep it or reject it, and write down why.
6. Repeat until the remaining gap needs work out of scope, then qualify and publish.

Detailed references, read when needed:

- `references/ceilings.md`: how to compute theoretical maxima. It includes a worked example.
- `references/methodology.md`: measurement pitfalls and statistics.
- `references/levers.md`: levers by area, ordered by typical payoff, with measured evidence.
- `references/gotchas.md`: engine- and hardware-specific traps.
- `references/publishing.md`: qualification gates, pinning, poster and report.
- `references/engine-forensics.md`: the kernel-work stage, and evidence-integrity runs. **Optional** — it assumes a reverse-engineering toolchain (e.g. REA). The skill works fully without it.
- `scripts/`: an engine-agnostic harness. It has a bench, ceiling calculator, memory watchdog, serialized queue, an exact acceptance-test suite, and a ledger.

## 0. Before touching anything

- **Write down the targets and constraints** the user gave. Ask only if one is missing and it changes what you do.
  - Metrics that matter: c1 decode, cN decode, prefill at several lengths, TTFT, startup.
  - Memory cap.
  - Context length that must stay stable.
  - Which quality changes are allowed: lossless only, or labelled lossy trades such as int8 prefill.
- **Inventory the machine:**
  - accelerator, memory type and size, and whether memory is unified;
  - driver, engine version, model, quantization, current launch command.
- **Measure, don't trust spec sheets:**
  - real memory bandwidth (device copy);
  - real matmul throughput (large GEMM);
  - clocks under load.
- **Read any existing experiment log for this machine and model.** Never rerun a rejected experiment without a new reason.
- **Create the working directory:**
  - `PLAN.md`: a timestamped log of every experiment, with numbers, verdict and reason.
  - `THEORY.md`: the ceilings.
  - `ledger.jsonl`: one line per run, from the harness.
  - `configs/`: one JSON per run.
  - `best-config.json`.

## 1. Ceilings first

Compute the theoretical maximum for each metric before optimising (`scripts/ceiling.py`, `references/ceilings.md`):

- **Decode is memory-bandwidth bound — with a compute floor.** Count the bytes read per emitted token:
  - dense weights;
  - active experts: top-k ÷ experts × expert bytes;
  - LM head;
  - KV read at the working context (plus recurrent state, read and written every step, for hybrid SSM/GDN models).
  - Divide by measured bandwidth.
  - GEMV decode is bandwidth-bound at short context on essentially every machine. **At long context the compute floor takes over — on the hardware with a low peak-FLOPs-per-byte ratio *and* on the architectures with a high intensity bound.** The floor binds when `intensity > mfu × peak / bandwidth`, where `intensity = (2 × active_params + 4 × attn_layers × attn_heads × head_dim × L + extra_flops_per_token) / bytes_per_step`. Measured peak/bandwidth is 38 (RTX 3090) to 313 (Arc B390) on GPUs and ~20 on server CPUs. Intensity **rises with context** — attention FLOPs are linear in L, so on the worked example intensity goes 3.27 → 11.04 FLOPs/byte from 4K to 256K — and **falls with concurrency** (weights amortize over streams, attention does not). It is also **bounded**, and the bound is a model constant: as L → ∞ the weights and the linear term vanish relative to L, and expanding `kv_bytes_per_token` cancels depth and head width, leaving

    `intensity_max = 2g / bpe`  (MHA/GQA/MQA: g = query heads per KV head, bpe = bytes per stored KV element)

    so the bound is set by **GQA group size and KV dtype**, not by depth: MHA FP16 1.0, GQA-8 FP16 8.0, GQA-8 FP8 16.0, GQA-8 INT4 32.0, MQA-16 FP8 32.0, and **MLA latent sharing `4 × heads × d_compute / (latent × bpe)` = 256–512** (d_compute = latent when QK^T and A·V both run in the shared latent). The worked example is MHA with **1-bit KV** (10,240 = 2×10×16×256×0.125), bound **16.0 FLOPs/byte**. **At mfu ≥ 0.5, for MHA/GQA with FP16–FP8 KV the floor never binds on any discrete GPU at any context** — the mfu condition is part of the claim, not a footnote: at mfu 0.29 a 3090's threshold is 11.0 F/B, which GQA-8 FP8 (16.0) crosses, and at mfu 0.2 it is 7.6, which GQA-8 FP16 (8.0) crosses. Against the mfu-0.5 thresholds (3090 19.0, 4090 48.8, A100 100.3, H100 147.6, EPYC 10.2, laptop CPU 8.9): **for MHA/GQA with FP16–FP8 KV the floor never binds on any discrete GPU at any context**, it binds on CPUs, and it binds on a 3090 below mfu 0.42 at any context (0.29 at 256K). It is **not** inert for MQA, MLA or INT4/1-bit KV: a 27B MLA model at 256K on an H100 at mfu 0.5 is compute-bound at 213 tok/s where bandwidth allows 267, crossover 186K tokens. `ceiling.py` prints the bound and the crossover context for any config — run it, do not assume the MHA number. Consequence per part on the worked example: 3090 binds below mfu 0.086 at 4K and below **0.29 at 256K**; EPYC 7763 below 0.160 at 4K and **0.538 at 256K**. `ceiling.py` takes the minimum of the two and includes the decode attention term. See `references/ceilings.md` for the measured crossover table and the intensity bound.
  - Speculative decoding divides the target's bytes by the accepted length. It also adds the draft's bytes, and the draft's LM head is often the biggest part — prune it.
- **Prefill is compute bound.** FLOPs per token ≈ 2 × active params, plus attention. Full attention is O(L) per token (O(L²) total across the causal mask): at 262K context the attention term dominates and a linear-in-L formula underestimates it by orders of magnitude. `ceiling.py` uses the causal-average form (`L/2`) for prefill, because a prefill token sees a growing prefix — and the **full `L`** for decode, because a decoded token sees the whole cached context. Using `L/2` in decode understates its attention cost by 2×; using `L` in prefill overstates it by the same factor. Divide by `mfu × measured_peak` where mfu is tunable (0.5 default; 0.6–0.7 for well-tuned flash attention, 0.2–0.4 for quantized kernels and MoE padding cliffs). **Report the sustained ceiling on thermally constrained hardware** — clocks drop 10–20% after minutes under load, and a peak ceiling is unreachable.
- **TTFT floor:** one forward pass plus tokenize and schedule.
- **Startup floor:** weight read from disk or page cache plus allocation, assuming JIT and graph caches persist.
- **KV:** bytes per token per layer × the layers that actually have KV (hybrid models have few), plus the per-stream recurrent state. That gives how many full-length sequences fit under the memory cap.

Report progress as a percentage of the practical ceiling. If the user's target is above the ceiling, say so early, with the arithmetic.

### Ceiling gap analysis

After computing all ceilings (peak **and** sustained), build a gap table. This is the prioritization tool: it tells you which dimension has the most headroom, and where effort pays off.

```
| Dimension   | Current | Peak ceil | Sustained ceil | Gap % | Lever? | Closure | Exp. gain | Effort | Risk | Detectable? |
|-------------|---------|-----------|----------------|-------|--------|---------|-----------|--------|------|-------------|
| startup     | 113 s   | 43 s      | 43 s           | 62%*  | yes    | 80–100% | 50–62%    | low    | low  | yes         |
| KV capacity | 264K    | 1.05M     | 1.05M          | 75%   | yes    | 60–80%  | 45–60%    | low    | med  | yes         |
| c1 decode   | 53      | 103       | 85             | 38%   | yes    | 50–70%  | 19–26%    | low    | low  | yes         |
| TTFT        | 45 ms   | 30 ms     | 30 ms          | 33%*  | maybe  | 40–60%  | 13–20%    | low    | med  | yes         |
| prefill 256K| 628     | 670       | 555            | n/a   | no     | —       | —         | high   | high | re-measure  |
```

\* startup and TTFT are **latency** rows: their "ceiling" is a floor, so Gap % = (current − floor)/current. See the formula note below — the throughput form gives −163% and −50% for these two rows.

- **Gap % depends on which way the metric points, and this table mixes both.** Getting this backwards is how a table ends up reporting a 62% gap that is arithmetically −163%:
  - **Throughput rows** (decode tok/s, prefill tok/s, KV capacity — higher is better, the ceiling is an *upper* bound): `Gap % = (sustained ceiling − current) / sustained ceiling`. The c1 decode row: 53 of 85 → 37.6% → 38%.
  - **Latency rows** (startup s, TTFT ms — lower is better, the "ceiling" is a *floor*): `Gap % = (current − floor) / current`, the share of today's time you can eliminate. The startup row: (113 − 43)/113 → 62%; TTFT: (45 − 30)/45 → 33%. Applying the throughput formula to a floor gives −163% and −50%, and dividing by the floor makes the number explode as the floor approaches zero.

  Both forms read as "fraction of headroom you can claim", and both land in [0, 1) when the ceiling is valid. A negative value in either form means the ceiling estimate is wrong, not that you are above target.
- **Rank against the sustained ceiling, never the peak**, on thermally constrained hardware. The peak comparison **inflates the headroom you can see**: at a 15% drop, `sustained = 0.85 × peak`, so a machine sitting at 75% of sustained is at 64% of peak. Ranked against the peak that is a 36% gap; ranked against the sustained ceiling it is a 25% gap — **1.4× more apparent headroom than exists**, and you spend days chasing a gap that is thermally unreachable. The other direction is the warning sign: a measurement at 95% of peak is **112% of sustained**, i.e. a burst number the machine cannot hold, not a near-ceiling result.
  - **If current exceeds the sustained ceiling** (the prefill row: 628 > 555), that is not an anomaly and not "at ceiling" — it means `thermal_drop_pct` is too high for the window you measured in. Re-measure the sustained ceiling (a long GEMM under load) before ranking that row. Do not rank a row whose ceiling you have not validated.
  - **Rank by the gap at the *pessimistic* sustained ceiling, not your point estimate.** `thermal_drop_pct` is an estimate, and the gap is very sensitive to it: assume a 15% drop (sustained = 0.85 × peak) when the real drop is 30% (0.70 × peak), and a machine sitting at 0.70 × peak shows a **17.6% gap** on the assumed ceiling and a **0% gap** on the real one — a full prioritization signal for a gap that does not exist.
    - **Build the band from the measured drop, not from a fixed 0.80/0.85/0.90 triple.** A fixed band silently assumes the drop is 10–20%; on a machine you measured at 30% it ranks against ceilings that machine has never had. Take the band as `measured_drop ± your_uncertainty`, compute the gap at each end, and rank rows by the **minimum** gap across the band. The uncertainty is hardware-dependent, and ±5 points is not a universal number: a 20-minute sustained-load clock ratio on a well-cooled desktop GPU gives **±2–3 points**, while a machine that throttles in a **sawtooth** (typical laptop, small-form-factor and fan-limited parts) can have a 20-minute window land entirely in the cool phase or entirely in the hot phase, giving **±10–15 points**. Measure the shape before you pick the width: log the clock every second for the window and look at whether the trace settles (use the narrow band) or oscillates between two plateaus (use the wide band, and take the **hot** plateau as the sustained ceiling rather than the window average — a sawtooth's mean is a ceiling the machine reaches only at the peaks). A row whose gap collapses inside your own measurement uncertainty is an estimate artifact, not a lever.
    - **A row's gap collapses at `drop = 1 − current/peak`.** On the worked rows: c1 decode (53 of 103) collapses at a 48.5% drop and is still a 26.5% gap at 30%; KV capacity (264K of 1.05M) collapses at 74.9% and is a 64.1% gap at 30%; prefill 256K (628 of 670) collapses at **6.3%**, which is why that row is `n/a` and not a lever. So a hot machine does **not** zero a table with real headroom — check the collapse point per row before you conclude the machine is out of room.
    - **If every row's gap does collapse inside the band**, that is a finding, not a dead end: report "no config lever is ranked above the sustained ceiling at a {drop}% drop", state the collapse points, and say which measurement would change the answer (a shorter measurement window, a lower concurrency, a validated `thermal_drop_pct`). Do not silently re-rank against the peak to manufacture a lever.
- **Lever?** = yes / maybe (stack-specific) / no (kernel work only). Check `references/levers.md` for measured evidence on similar hardware and stack.
- **Closure** = the fraction of the *gap* you expect to close, from measured evidence. "Decode graphs: 2× c1" on a 38% gap is 50–70% closure. Stating it as a fraction of the gap keeps it comparable across rows with very different gaps.
- **Exp. gain** = Gap% × Closure = the expected improvement **on the metric itself**. This is the number the ranking uses, and the number the user cares about. A 62% gap with 80% closure is a 50% metric gain; a 33% gap with 50% closure is 17%.
- **Effort** = low / medium / high. Low = single config flag, < 1 h. Medium = 2–4 interdependent flags + rebuild, 1–4 h. High = kernel work or a model file change, 1+ days.
- **Risk** = low / medium / high. Chance of breaking a dimension outside the target. Low = no known interactions. Medium = known interactions (KV dtype affects attention speed). High = changes the kernel landscape (quantization format) or touches dimensions not in the table.
- **Detectable?** = is Exp. gain > 2 × the **per-dimension** MAD, **with both expressed as a percentage of that dimension's median** (`stats.py noise` prints MAD in exactly that form: `MAD = 1.1 (2.1%)`). Comparing a percentage gain against a MAD in tok/s is a unit error; compare % to %. If no, skip: the test is underpowered and the runs are wasted. Log "below noise floor, deferred" in PLAN.md.

**Priority rule.** Three steps, and they do different jobs:

0. **Quantization is decided before the table is ranked, not by it.** Lever 1 changes the system under test, so it invalidates every ceiling, every kernel-dependent accepted lever and the gap table itself. Run it as a **phase**: choose the format, re-measure ceilings and noise, rebuild the table, then rank. Ranking it inside the table by `Exp. gain ÷ effort` will place a high-effort lever late, and running it late means every earlier measurement was made on a system you then threw away. If you are already deep in a config pass, budget it as a labelled restart (see §3), not as one more experiment.
1. **Sieve** (a filter, not a ranking): drop rows where Lever? = no (kernel pass), and rows where Detectable? = no.
2. **Rank** the survivors by `Exp. gain ÷ effort_ordinal` (low=1, medium=3, high=6). Risk is a **tiebreaker and a gate**, not a term in the denominator — effort is time, risk is blast radius, and summing them makes an arbitrary weight decide the order. Break a tie toward lower risk; treat Risk = high as "needs a rollback plan before you run it", not as a lower score.

This is a ranking heuristic, not a score: the inputs are approximate, the ordering is what matters. The example ranks startup (50–62% gain, low effort) above KV capacity (45–60%, low effort, medium risk) above c1 decode (19–26%) above TTFT (13–20%).

**Re-prioritize after every accepted lever.** The gap table is a living document. Write it to `THEORY.md` and update it in `PLAN.md` after each experiment: accepted levers shrink gaps and change what is detectable. When a dimension reaches >90% of its sustained ceiling, mark it "at ceiling" and stop spending time there.

**When the user's target is above the ceiling**, say so early with the arithmetic. Example: "100 tok/s c1 requires 2 useful speculative drafts at ~2.5 accepted length. This model's MTP head accepts ~14% at depth 2, so the practical target is ~88–97 tok/s. The remaining gap is GEMV kernel efficiency."

## 2. Ground rules (non-negotiable)

1. **One primary change per experiment.** Give each its own config file. Derive new configs from the current best. Document which previously-accepted levers are carried forward. When re-tuning a parameter from a previously accepted lever, run an additional control with the *old* parameter value to isolate the re-tuning effect.
   - **Structured exception:** factors known to interact (draft length × concurrency × context; KV pool × concurrency × dtype) are **one multi-factor experiment**, not a sequence of one-factor runs — see "Coupled factors are one experiment" in §3. Sweeping them one at a time against a fixed baseline finds a jointly suboptimal point and reads as a null result.
2. **Control for noise, and size the experiment to the effect you expect.** `scripts/stats.py` implements every number below; do not hand-roll the test.
   - **Measure the noise floor per dimension first.** Run the baseline 10× and pass its 10 medians to `stats.py noise`. c1 decode, prefill, TTFT and startup have very different noise floors — one MAD from c1 decode does not apply to prefill. Record the MAD per dimension. `sigma = MAD / 0.6745` (MAD = 0.6745 × sigma for normal noise); Mann-Whitney is distribution-free, so this conversion feeds the power estimate only.
   - **The stability gate is two independent sigma estimates agreeing.** `stats.py noise` compares the MAD-derived sigma against the range-derived sigma (range / d2(n)); a ratio above 2× means drift (thermal, background process, power profile), not run-to-run noise. Fix the drift before you start.
   - **Take ≥6 decode samples per run and use the median.** The median of per-run samples is the observation the test operates on.
   - **Design the experiment from the expected effect, not a fixed n.** Take the expected gain from `references/levers.md` evidence for this hardware/stack and run `stats.py design --mad M --current C --expected E --confirm-set K`. It returns the runs per side for 80% **exact** power and the **exact** alpha the test can actually reach. Three facts make n derived rather than fixed: alpha is quantized (at 4+4 the largest p ≤ 0.05 is 0.0286, at 6+4 it is 0.0333); power is set by `d = expected_gain / sigma` (a 5% effect at 7.5% noise is d = 0.67, which 4+4 detects 13% of the time); and **K enters the design**, because Holm's tightest threshold over the confirm set is α/K and the test must be able to reach it. `design` grows n until the exact power clears the target; the normal-approximation formula it starts from is a **lower bound** and routinely under-sizes small-n tests (measured: 4+4 at d = 2.08 is 52% by the approximation, 69% exactly).
   - **Below-noise-floor filter.** If the expected gain < 2 × MAD, do not spend the experiment: the test is underpowered and the gain is not worth the runs. Log it as "deferred, below noise floor" in PLAN.md.
   - **Acceptance test.** Interleave controls around each candidate (`ctl, ctl, cand, ctl, ctl`), n per side from `design`. Run `stats.py accept --cand <medians> --ctl <medians>`: a one-sided Mann-Whitney U on the exact null distribution. Accept only if the exact p ≤ the target alpha **and** the candidate median beats the control median. Both criteria, nothing else.
   - **Regression check over secondary metrics.** For each secondary metric (the other dimensions' tok/s, TTFT, startup, memory), test candidate vs control and pass the p-values to `stats.py holm`. An uncorrected k-metric check at α = 0.05 has a 14% family-wise false-positive rate at k = 3.
   - **Engine comparisons** (whole engines, not single levers): `stats.py bootstrap` for a 95% CI of median(B)/median(A), which needs ≥20 samples per side. Below that, use `accept`.
   - **Screen, then confirm — and say what each stage costs.** Two stages with two different jobs:
     - **Pre-register the whole confirm set as one group, before the first run**: the top-K levers by *expected* effect from `levers.md`, K fixed in advance (typically 5–7), the lever list and the target alpha written in PLAN.md before any measurement. Selection happens on prior evidence, never on what you observed. **Screening results may never choose what gets confirmed.**
     - **The loophole to close, quantified.** The usual way this fails: screen 15 levers, take the ~5 screen hits, and confirm each one as its own K = 1 test at α = 0.05. That is not a 5% procedure. Confirming M screen-selected levers independently gives a family-wise false-accept rate of **1 − 0.95^M** — 14% at M = 3, 23% at M = 5 — and the screen picked them, so the selection is on the tail. Pre-registering each lever "just before its own confirm run" is not pre-registration: the group, K and the α are fixed once, before the first run. A screen hit outside the registered list is **exploratory** — run it if you have budget, label it exploratory in the report, and never fold it into the accepted config as if it had the standing of a registered lever.
     - **Screen every candidate lever at n = 4 per side**, including the pre-registered confirm set, to sequence the work and catch surprises. Disclose its cost: at 4+4 the per-lever α is 0.0286, so screening 15 null levers produces at least one false hit **35% of the time**, and it misses **86% of real d = 0.67 effects**. Screening is a filter, never a verdict, so a screen false positive costs you a confirm run that then rejects — it costs budget, not validity. A screen false negative is a lost lever: that is the real price of a cheap first pass, and it is why the confirm set comes from prior evidence and not from the screen. **The quick pass is the one sanctioned exception: it runs no screen stage at all** (15 levers × 8 runs is 50 h, more than the whole quick pass) **and confirms the top 2 levers from prior evidence, not from a screen hit.** Because screening is a filter and not a verdict, skipping it costs sequencing, never validity — the quick pass pays that cost on purpose, and says so in the budget section.
     - **Accept on the confirm stage alone**, on fresh runs, with **Holm across the confirm set's primary p-values** (`stats.py holm --mode confirm`) — 6 levers tested independently at α = 0.05 is a 26% family-wise false-accept rate uncorrected.
     - **K sizes the test, so pass it to `design`.** Holm's tightest threshold is α/K, and the Mann-Whitney must be able to produce a p that small, so `stats.py design --mad M --current C --expected E --confirm-set K` sizes n against α/K, not against α. At K = 2 that needs n ≥ 4+4 (α = 0.0143); at K = 6, n ≥ 5+5 to be reachable at all and n = 8+8 for 84% exact power at d = 2.0. Design at α and then confirm with Holm across K, and the chain stops at step 1: the stage accepts nothing and reports every lever as `ok` — which is not a null result, it is an untested result.
     - A lever that screened big but was **not** in the pre-registered set is exploratory: label it as such, and it needs its own pre-registered confirm before it is accepted. Never promote a screen hit straight into the config, and never let a run of single-lever "pre-registrations" become the confirm stage — see the loophole note above.
3. **Keep the environment fixed.** Stay on AC power, on a fixed performance profile, with an idle host and no other GPU jobs.
   - Make the harness refuse to run otherwise.
   - **Baseline stability gate before any lever:** run the baseline 10×, then `stats.py noise` on the 10 medians. The two-independent-sigma check (MAD vs range/d2) passes only if the baseline is not drifting. If it fails, investigate (thermal drift, background process, power profile change) before continuing — every later comparison is biased if the baseline moves.
   - **Record state at start and end of every run.** `bench.py` records `state_start`/`state_end` (driver, kernel, GPU, CPU, python) in the ledger, flags `STATE_CHANGED` when a single run's own environment moves (that voids the run), and flags `CROSS_RUN_STATE_CHANGED` when this run's fingerprint differs from the previous ledger line. Cross-run drift is a flag to *read*, not an automatic void: the harness cannot tell a driver update from the lever you deliberately changed. Confirm the diff is exactly your lever; if it is not, the two runs do not compare. Add what `bench.py` cannot see to PLAN.md: engine version, quantization, OS version, power profile, thermal state.
   - Restore any profile you changed when you finish, and tell the user.
4. **Run one GPU job at a time.** Serialize them with a lock (`scripts/queue.sh`).
   - Never use `pkill -f`/`pgrep -f` patterns that can match your own shell.
   - Detach long queues (`setsid nohup … &`) so they survive agent restarts.
5. **Enforce the memory cap with a watchdog** that kills the run.
   - On unified memory, GPU allocations do not show in cgroup counters or MemAvailable. Measure driver residency (e.g. `drm-resident-*` in `/proc/<pid>/fdinfo`, `nvidia-smi`, or `ioreg`/`vm_stat` on Apple) plus process anonymous memory.
   - **A probe that prints nothing is a failure, not a zero.** `scripts/mem.sh` prints one integer on success and nothing plus a non-zero exit on failure; `bench.py` counts valid reads and flags `MEM_WATCHDOG_FAILED` when it never got one, so an unenforced cap is visible in the ledger instead of silent. This was a real bug: a dead probe read as 0, sat under the cap, and policed nothing.
   - **`warmup_probes` splits the memory reading in two, and both are in the ledger.** `mem_peak_gib` is the steady-state footprint; `mem_peak_warmup_gib` is the startup allocation window. Warmup readings are cap-checked exactly like every other reading (a cap is a cap, and a breach there still kills the run) — they are only excluded from the steady-state number, so a config that allocates a large buffer at startup and frees it is not charged for it all run. **Compare the two on every accepted lever:** if `mem_peak_gib` equals `mem_peak_warmup_gib`, the config never gave the memory back, and that is a capacity finding, not a warmup artifact. Set `warmup_probes` to cover your engine's JIT and graph-capture window — 3 probes at a 3 s interval covers 9 s, which is not enough for a JIT-heavy engine, so raise the interval or the count and say what you used.
   - `mem.sh CONTAINER` is for dockerised servers; use `mem.sh --pid PID` for native ones (llama.cpp, vLLM, MLX, LM Studio, Ollama). macOS has no per-process GPU accounting — it reports system-wide wired+compressed and says so; set the Apple Silicon `iogpu.wired_limit_mb` sysctl rather than trusting the probe. Windows is unsupported: write your own `nvidia-smi` probe.
   - `memory.cap_gib` is required when a probe is set; `bench.py` refuses to run without it.
6. **Stability gates.** Every accepted lever must pass a quick stability check (long-context needle at ~50% context, greedy output equivalence if the change claims to be lossless). The full stability gates apply before a config is declared "best":
   - a long-context retrieval run, with needles in a ~50% then ~100% context document, found exactly;
   - a soak with concurrent full-length requests, if the KV pool is sized for N users;
   - a greedy output equivalence check, if the change claims to be lossless.
   - A lever that passes speed gates but fails a stability gate is **not accepted** — log it as "speed win, stability fail" in PLAN.md.
7. **Never force-kill a server mid-batch.** Abort requests, wait for the drain, then stop with a timeout. A forced stop mid-prefill has caused GPU driver faults.
8. **Verify outputs, not just speed.** Flag degenerate or looping output, failed requests and an idle GPU. A suspiciously fast result is usually broken output.
   - `bench.py` records `out_tokens_median`, `out_tokens_spread_pct`, `out_tokens_coverage_pct`, `out_tokens_panel_spread_pct` and **`out_tokens_by_prompt`** (per-prompt medians in panel order), and flags `OUT_LEN_UNSTABLE` when **repeats of the same prompt** diverge by >60%. The spread is measured per prompt on purpose: a panel whose prompts intend different answer lengths has a large cross-prompt spread by construction, and speculative decoding changes accepted length as its mechanism — a cross-prompt threshold would flag the best lever on the panel's own composition. **The per-prompt guard needs each prompt sent at least twice, so `reps` must be ≥ 2 × panel size; `bench.py` now defaults to exactly that (12 reps on the 6-prompt panel).** Pass `--reps` below 2 × panel and the run is flagged `OUT_LEN_UNTESTED`, `out_tokens_spread_pct` is **null** (not 0.0), and `bench.py` warns at start-up: a clean spread on an `OUT_LEN_UNTESTED` run is the *absence of a measurement*, not evidence of stability, and must never be reported as a passed gate. **Spread alone is blind to the failure mode that matters most: a lever that scales every answer by the same factor has per-prompt spread exactly 0% and coverage 100%, and the speed test passes it because tok/s went up.** So the spread is a stability check, not a length check. **Run `stats.py outlen --ctl <control's out_tokens_by_prompt> --cand <candidate's>` on every accepted lever**: it flags any prompt whose median moved more than 20% (default `--threshold`), **and it flags a UNIFORM SHIFT — every prompt moving the same way with the overall median moving ≥ 5% (`--uniform`)**, because a 15% uniform shortening sits under the 20% per-prompt threshold and is exactly the mechanism the gate exists to catch. Measured: a uniform −50% shortening (spread 0%, coverage 100%, clean LOOP) is flagged on all six prompts, overall median 107 → 54; a uniform −15% is flagged by the uniform rule alone (overall 110 → 94); a ±3% lever and a −2% lever pass clean. **It also flags a MAJORITY SHIFT — when ≥N-1 prompts move the same way with overall ≥ 3% (`--uniform-majority`, default 3%) — catching cases where one prompt diverges but the majority still indicates length change as the mechanism.** A lever that passes `accept` and is flagged here gets disposition **`accept-lossy`**, never a bare `accept`. Needle retrieval and greedy equivalence do not catch "answers got blander or shorter" either, so a lever that moves output length is a **labelled lossy trade, not a free win** — say so, name the mechanism, and get the user's call before it enters `best-config.json`. Read the panel spread as context for the per-prompt number, not as a gate.
   - The `LOOP` flag is calibrated, not guessed: it fires on a single-word stall (≥ 4 identical words), on a cycle that runs to the **end** of the answer (the last **three** blocks of p words are identical, p ≤ 12, ≥ 2 distinct words in the block, matched case-insensitively), or on repeated n-grams past scale-specific thresholds 0.5 / 0.7 / 0.85 at 8 / 4 / 2 grams. One shared 0.5 threshold at all three scales flagged a legitimate 29-word answer that repeats a 2-word term 10 times (2-gram ratio 0.607) as degenerate; a **two**-period tail rule flagged a table with duplicate trailing rows, code ending in `}`, a list ending in a duplicated item, and an answer that repeats its closing sentence once. Measured on **44 cases: zero false positives on 20 normal outputs** (prose, code, JSON arrays, tables, numbered lists, name lists, YAML, multilingual prose, short answers, a repeated-term answer, a table with one duplicated trailing row, JSON with one duplicated trailing object, code ending in four closing braces, code ending in three closing braces, an answer repeating its closing sentence twice) **and 18 of 19 degenerate outputs caught** (word stalls from 4 words, 3- and 4-word cycles at 15–60 words, a phrase looped to the end, case-varying and ChatML-style loops, a CSV row loop, a pretty-printed JSON loop, numbered-list and bullet-list loops, code repeating one line to the end, multilingual and CJK loops). Two blind spots are documented in the function: a 3-word cycle that stops at 8 words, and a **single-line** JSON array with identical trailing objects (the closing `]` breaks every exact-match chain) — the second is caught by `stats.py outlen`, because a loop that runs to max_tokens inflates `out_tokens_median`. A clean `LOOP` flag is not proof of clean output, **and its power has a measured length floor**: the word-stall test needs ≥ 4 identical words, the 2-gram test needs ≥ 5 words, the word-level tail test needs ≥ 6 words (3 periods of ≥ 2 words), the 4-gram test ≥ 11 words and the 8-gram test ≥ 15 — so **below 4 words no test can fire at all, and below ~6 words only the stall and 2-gram tests exist.** For short answers rely on needle retrieval, greedy equivalence and `outlen`. `LOOP` is **advisory**: unlike `MEM_CAP` and `STATE_CHANGED` it does not set `ok = false` and does not void the run — it means *read the flagged text before you accept the lever*. That distinction matters because the overlap is irreducible: a table, CSV or YAML list whose last three data rows are genuinely identical is structurally indistinguishable from a model stuck on a 3-row cycle, and no n-gram or periodicity test separates them. When `LOOP` fires on structured output, inspect the flagged samples by hand and record what you saw; when it fires on prose, treat the lever as failed until proven otherwise.
   - A config is only "lossless" if it passes the greedy equivalence gate (rule 6). int8/fp8 prefill, FP8 KV, and most aggressive quantization are **labelled lossy** — record the label next to the speed number in the ledger.
9. **Log everything in `PLAN.md`,** including failures and why they failed. Negative results are the most reusable output.
10. **Secrets:** never ask twice for a credential the user already saved. Never print it, and never copy it or its path into anything published.

## 3. The loop

```
baseline + per-dimension noise floor → profile → gap table (peak + sustained) → rank by Exp.gain ÷ effort
   → screen the lever (n=4/side) → confirm the pre-registered set (n from stats.py design) → stability gates
   ↑        + outlen vs control (0 runs, reads the ledger)                              ↓
   └───── update best-config + PLAN.md + ledger + gap table ←── accept / accept-lossy / not-actionable / reject with reason ──┘
```

### Lever order

Cheapest first; see `references/levers.md` for evidence. The order is a starting point — use the dependency graph above to re-sequence when interactions require it.

1. **Quantization format** (bandwidth-bound decode): pick a format the hardware decodes natively. On Ampere, AWQ-INT4 beats FP8 (no FP8 units). On Ada/Hopper, FP8 is native. On Intel, EXL3 and INT4 are well supported. **This is a model file change, not a config flag.** It is not a lever you fold into a hill-climb: it changes the system under test, so it invalidates every ceiling (new weight bytes, new MFU), every accepted lever that depends on kernels (decode graphs must be re-captured, autotune caches are stale), and the whole gap table. Treat it as its own phase: **decide quantization first, then start the hill-climb** — or, if you are already deep in a config pass, budget it as a 2–3 day restart (re-measure ceilings, re-baseline noise, re-run every accepted lever against the new format), not as one more experiment.
2. **Persistent JIT, compile and graph caches** (startup −50–70%). Also use eager safetensors loading instead of mmap where it is slow.
3. **Decode graphs** (CUDA/XPU graphs): often 2× c1 on their own. Re-capture after any quantization change.
4. **Speculative decoding** (requires decode graphs):
   - Choose the method (built-in MTP, EAGLE, a draft model, n-gram).
   - Sweep draft length per concurrency and context; the best length differs.
   - Prune the draft LM head's vocabulary — usually the single biggest speculation win. `ceiling.py` assumes the *unpruned* head if you omit `draft_head_gb`, and says so.
   - Keep sampling on the GPU.
   - Make sure verify runs with decode-style attention.
   - Sweep draft length × concurrency × context jointly — these form a tight 3D coupling.
5. **Concurrency and KV sizing:**
   - Set max running requests and the KV pool to N × context.
   - For hybrid SSM/GDN models, size the state slots. They, not KV, often cap concurrency.
   - Explicitly enable prefix caching and confirm `cached_tokens` > 0.
   - KV cache dtype (FP8, INT8, BF16) is a labelled trade: halves memory, may halve attention throughput. Measure both.
   - KV eviction policy (LRU/LFU/SRKV) matters at high concurrency.
   - Measure cN two ways: the burst number (short outputs) and `--sustained-cN` (N streams at long context to long output). The burst number cannot see the KV-pool collapse the ceiling formula predicts.
6. **Prefill:**
   - Tune chunk size; it trades throughput against decode stalls and affects turn-2 TTFT. Re-tune after enabling speculation.
   - Use a faster attention library. Check dequantization placement (in-kernel vs outside attention) when combined with quantization.
   - Use int8/fp8 prefill GEMMs as a labelled quality trade.
   - Avoid padding cliffs in grouped MoE GEMMs.
7. **Kernel thread and tile sizes:** defaults are often tuned for a bigger card.
8. **Kernel work:** profile, read the ISA, fix the dominant kernel. Do this only after config levers plateau. If a reverse-engineering toolchain is available (e.g. REA), this is where it pays: read the CUDA/HIP fatbins, CUBIN and PTX the engine actually ships, decompile the dominant kernel, and diff two engine versions to explain a measured gap. See `references/engine-forensics.md`.

**Coupled factors are one experiment.** "One primary change per experiment" has a structured exception: factors known to interact (draft length × concurrency × context; KV pool × concurrency × dtype) must be tested as a **single multi-factor lever**, not as a sequence of one-factor runs. Use a factorial sweep (at minimum a Latin-hypercube / grid over the factor box), report it as one experiment with one accept/reject, and run controls at the *current best* point of the box, not at a single fixed corner. Sweeping them one at a time against a fixed baseline finds a point that is jointly suboptimal and looks like a null result.

**Cache policy between levers.** JIT, autotune and graph caches are state, and stale caches bias comparisons:
- After a **kernel-landscape change** (quantization format, attention library, kernel work): wipe JIT/autotune/graph caches, re-warm, and re-measure the noise floor. The old-format cache is not a valid control.
- Between **parameter levers** on the same kernel set (draft length, concurrency, chunk size): keep caches warm and measure in sustained mode, so startup noise does not enter the decode comparison.
- Say which policy you used in the ledger line. A startup lever measured cold and a decode lever measured warm are not the same experiment.

**Prompt panel:** `bench.py` ships a fixed 6-prompt panel and accepts a per-config `"prompts"` list. 6 is the floor. For acceptance testing at long context or with speculative decoding, use ≥12 spanning code, prose, structured output and multilingual text: acceptance rate varies enormously by prompt type (code drafts far better than prose), so a 6-prompt English panel can show a win that is a property of the panel, not the lever.

**Memory watchdog:** `mem.sh CONTAINER` for dockerised servers, `mem.sh --pid PID` for native ones. Linux reads DRM residency / `nvidia-smi` plus cgroup or process RSS; macOS reports system-wide wired+compressed as a proxy and says so; Windows is unsupported. A probe that prints nothing is a failure, not a zero — `bench.py` flags `MEM_WATCHDOG_FAILED` when it never gets a valid reading.

### When a lever fails

After each failed experiment, run a three-way decision tree:

1. **Measurement error?** Re-run at a larger n (`stats.py design` with a smaller expected gain raises n), with thermal state pinned and the cache policy identical to the first run. If it still fails, it is not (a).
2. **Lever incompatibility?** Check hardware/stack compatibility in `references/levers.md` and `references/gotchas.md`. Is this lever tagged `[S: stack]` and you're on a different stack? Does the hardware have the required features (FP8 units, graph capture)?
3. **Interaction failure?** Revert all previously accepted levers, test the new lever alone, then re-add levers one at a time to identify the interaction.
4. **Underpowered, not failed?** If the effect was real but the test could not see it, that is a design error, not a lever failure. Re-run `stats.py power --mad <measured MAD> --current <control median> --gains <the expected gains, in metric units>`: it prints the exact power you actually had at that n, and the runs per side that would have reached 80%. A null at 10% power is not evidence of no effect — re-run at the designed n before recording it as a rejection.

Specific failure signatures:
- **If kernel-count reductions (fusion) give nothing** under graphs, the time is inside the main kernels. Stop fusing.
- **If higher acceptance doesn't give higher tok/s,** the draft costs too much. Measure per-step time.
- **If a weird result appears,** suspect the measurement first: tokens counted per streamed chunk, prompt length not measured with the real tokenizer, cache hits, thermal state, or the battery.

### Measurement budget

A single `bench.py` run (6 decode samples + cN + 2 prefill lengths + long context) takes 15–90 minutes depending on context length and model size; a 256K-context run with c4 and 2 prefill lengths can exceed 90 minutes. Add 30–120 s per run for server startup/teardown (health check, warm-up). `--sustained-cN` adds a full-length concurrent soak to that.

Runs per lever is **2n**, where n comes from `stats.py design`, not from a constant. At 7% sigma: a 20% expected effect needs 2 per side, a 10% effect needs 7, a 5% effect needs ~26 and is not worth testing at all.

Budget the session as **screen, then confirm**:

- **Screen** (n = 4 per side, 8 runs/lever) over **every** candidate lever — including the pre-registered confirm set. Screening them is not redundant: 8 runs is two-thirds of the cost of a confirm run, and a screen that shows a lever is incompatible (no graph capture, no FP8 units) saves the 12+ runs of confirming it. Cheap, and deliberately weak: it catches 13% of real d = 0.67 effects and 38% of d = 1.37 ones, and among 15 null levers it produces at least one false hit 35% of the time. Both costs are budget costs, not validity costs, because screening is a *filter* and never an acceptance decision.
- **Confirm** the **pre-registered** set (top-K by expected effect, K fixed before any run; typically 5–7), at n from `stats.py design --confirm-set K`, on fresh runs. Accept/reject is decided on the **confirm stage alone**, with Holm across the confirm set's primary p-values (`stats.py holm --mode confirm`). Which lever "won" is a reporting fact, never a selection input.
- **Stability gates** (1–3 runs per accepted lever): needle retrieval, concurrent soak, greedy equivalence.

Worked budget, 15 candidate levers, 25 min/run average (short-to-mid context; a 256K-context run is 3–4× that, and `--sustained-cN` adds a full concurrent soak):

| Stage | Runs | Wall clock |
|---|---|---|
| Baseline noise floor — 10 runs; every dimension is measured inside one run | 10 | 4 h |
| Sustained-ceiling measurement — 2 runs of 20+ min under load, for `thermal_drop_pct` (the gap table ranks against the **sustained** ceiling, so it has to be measured, not assumed) | 2 | 1 h |
| Screen 15 levers × 8 (n = 4/side) | 120 | 50 h |
| Confirm 6 pre-registered levers × 2×8 (n = 8/side, see the note) | 96 | 40 h |
| Stability gates, 5 accepted levers × 2 | 10 | 4 h |
| Output-length comparison, `stats.py outlen` per accepted lever — **0 runs, it reads `out_tokens_by_prompt` from the ledger** | 0 | 0 h |
| Subtotal | 238 | 99 h |
| Failure buffer, 35% (watchdog trips, driver faults, re-runs) | 83 | 35 h |
| **Total, no quantization phase** | **321** | **134 h ≈ 5.6 days** |
| Quantization phase, if taken: re-measure ceilings + noise floor (10) + sustained re-measure (2) + re-confirm 6 accepted levers on the new format (96) + gates (10) + 35% buffer (41) | **159** | **66 h ≈ 2.8 days** |

The noise-floor row is 10 runs, not 40: one `bench.py` run measures c1 decode, prefill, TTFT and startup, so 10 runs yield four time series of 10 medians each.

**n = 8 in the confirm row is not a taste for bigger numbers — K sets it.** Holm's tightest threshold over a confirm set of K levers is α/K, and the Mann-Whitney must be able to produce a p that small or the chain stops at step 1 and **nothing in the confirm set can ever be accepted**. At K = 6 that is α/K = 0.0083, which needs n ≥ 5+5 (α = 0.0079) just to be reachable, and n = 8+8 (α = 0.0074) to reach 84% exact power at d = 2.0. `stats.py design --confirm-set K` sizes n against α/K for you; run it with your own K before you fix the budget. A confirm stage designed at α with n from `design` without `--confirm-set` is a stage that silently accepts nothing.

The quantization row is **not** in the base total — take it when you change format mid-pass, and say so in PLAN.md.

Budget the session:

- **Quick pass** (~12 h; 12–16 h with the failure buffer): baseline + noise floor (10 runs), ceilings, **one sustained-load run of 20+ min on thermally constrained hardware** — the gap table ranks against the *sustained* ceiling, so a quick pass with no sustained measurement ranks against a ceiling the machine cannot hold — then **confirm the top 2 levers by expected effect**: pre-registered, **K = 2 levers × n per side × 2 sides**, Holm across the two, plus stability gates on the accepted one (2 runs) and **`stats.py outlen` against the control's `out_tokens_by_prompt` (0 extra runs — it reads the ledger, so it is free and there is no excuse for skipping it)**. **At n = 4: 10 + 1 + 16 + 2 = 29 runs ≈ 12 h; 39 with the 35% failure buffer ≈ 16 h** (the buffer is `round(0.35 × runs)`, the same arithmetic as the full pass: 29 + 10 = 39, not 40). Take n from `stats.py design --confirm-set 2` using your own MAD and expected gain; **the hard floor is n = 4**, and the floor is Holm, not caution: its first threshold at K = 2 is α/2 = 0.025, and the Mann-Whitney must be able to produce a p that small. At n = 3+3 the smallest achievable p is 0.0500, so the chain stops at step 1 and the quick pass **accepts nothing, every time**. At n = 4+4 the achievable α is 0.0143 (the rejection point is U = 16/16 — a **perfect** separation, one loss and p = 0.0286 > 0.025), and exact power is 84% at d = 3.04. At n = 5+5 the rejection point is U ≥ 23/25, which tolerates two losses, α = 0.0159, and power is **95.7%** at d = 3.04 and 97.2% at d = 3.21. Four more runs per lever buys eleven points of power on the effect the quick pass targets. **`design` returns 4 for every effect the quick pass is for** (d ≥ 3.0 → n = 4; d ≈ 2.5 → 5; d ≈ 2.0 → 6), so 4 is the design number and the budget above is quoted at it — do not inflate it by taste. **Buy n = 5 when your target sits near the power boundary:** 8 extra runs for the whole quick pass (2 h) buys 11.7 points of power, the cheapest power in the plan. At a 12% gain (d = 2.02) exact power is **49.6% at n = 4** and 68.4% at n = 5, and `design` asks for 6 — a 12% target is a coin flip at n = 4, so take the n `design` gives you (33 runs ≈ 14 h at n = 5, 45 with buffer ≈ 19 h). With a 4% MAD, d = 3.04 is an **18% gain**. Write the target, the n, the power and which option you ran in PLAN.md before you start. **No screen stage** — screening 3 levers and confirming only the screen winner is selection on the tail, which is exactly what ground rule 2 forbids. Short-context decode and startup only: not prefill, not concurrency, not long-context.
- **Full pass** (4–7 days): all config levers (1–7) screened, the pre-registered set confirmed, stability gates per accepted lever.
- **Kernel pass** (1+ week): kernel-level work after config levers plateau.

Prioritize by Exp. gain ÷ effort. Skip levers needing code changes until config levers plateau. Skip levers whose expected gain is below 2× the per-dimension MAD.

### Stopping criterion

Three MAD uses, and they answer three different questions. Two of them are **gates you pass before running**; one is a **reading you take after running**. Read them in that order and there is no conflict — the conflict appears only if you treat the post-hoc reading as a licence to run.

| Threshold | Question | When it applies |
|---|---|---|
| **1 × MAD** — "inside noise" | Did *this experiment* move the metric? | **After** the run, on the medians you already have. |
| **2 × MAD** — below-noise filter | Is this lever's *expected* gain worth an experiment at all? | **Before** the run, on the expected gain from `levers.md`. |
| **max(2 × MAD, user_floor)** — stop | Is *any further* experiment worth running? | **Before** the next experiment, on the remaining gap. |

- **Per-lever verdict — "inside noise"** = the candidate's median is within **1 × MAD** of the control median.
- **Whole hill-climb — stop** = the remaining gap to the **sustained** ceiling is below **max(2 × MAD, user_floor)**. The `user_floor` is the smallest gain that changes the user's decision — default 5% of the sustained ceiling, or set it from their target.

**What "1 × MAD" is a threshold on, and why 1 × MAD is the default.** MAD is a *within-group* dispersion statistic, and this verdict compares *two medians*, so the threshold has to be expressed on the sd of the difference of two medians. With 6 samples per run, the **exact** sd of the median of 6 standard normals is **0.4617** — from order-statistic integration (`E[X₍₃₎X₍₄₎]` over the joint density of the two middle order statistics), cross-checked by 200,000 simulated medians at 0.4635. The textbook asymptotic form `sqrt(π/2)/sqrt(6)` gives 0.5117, which is **10.8% too big**: it is a large-k approximation and k = 6 is not large (the same formula is 25% off at k = 2, 8% at k = 3, 4.7% at k = 5). So `sd(difference) = 0.4617 × sqrt(2) = 0.6530`, and in MAD units (MAD = 0.6745 σ) the exact threshold is **0.968 × MAD**: the 1 × MAD rule is 3% too loose, which is inside the noise the rule exists to screen. **Use 1 × MAD, and say that you used it.** Under the null, the probability of the difference exceeding the threshold by chance is **64%** at 1 × MAD and **36%** at 2 × MAD (two-sided; the threshold catches ~36% of nulls at 1 × MAD and ~64% at 2 × MAD), so 1 × MAD is a **very weak screening reading** — nearly two-thirds of null levers appear "above noise" at this level. This is expected: MAD alone cannot distinguish signal from noise, and **the test is `stats.py accept`** (Mann-Whitney U with Holm correction). Do **not** use 1.073 as a threshold: it is the asymptotic-sd artifact, 10% above the exact value, and it is the number an earlier revision of this skill printed.

**The zone between 1 × MAD and 2 × MAD is deliberate, and it is resolved by the order, not by a tie-break.** Take MAD = 5% and user_floor = 7%, so the stop threshold is max(10%, 7%) = 10%. A lever with a 7% expected gain: the 2 × MAD filter says **defer it**, and the stop rule says **stop**. If you run it anyway (the user overrode the filter, or the expected gain came from evidence the filter has not seen) and it lands at +7%, the 1 × MAD reading says "not inside noise" — that is a *true statement about a run you chose to make*, not an acceptance. Report it as **"above noise, below the worth-testing threshold: measured, not actionable"**, and do not spend a confirm stage on it. The gate decides whether to run; the reading only interprets what ran.

**When the user overrides a gate, the gate stops being a gate and becomes a cost estimate.** They can override the 2 × MAD below-noise filter, the stop rule, or both — the skill's job is to tell them what it costs, not to refuse. Say: (a) the expected gain versus the noise floor, in the same units (`expected 7% vs 2×MAD 10%`); (b) the power at the n `design` returns, and that a power below ~50% means a real effect is more likely to be missed than found; (c) the run count the override buys and what it displaces; (d) that a below-noise result will be logged as "measured, not actionable", not as an acceptance. Record the override and your cost estimate in `PLAN.md` so the report is honest about which levers were chosen by evidence and which by instruction.

**"Measured, not actionable" is a rejection for every operational purpose.** It is not an acceptance, so it does **not** earn a confirm stage, does **not** enter `best-config.json`, does **not** appear in the published recipe, and the config is rolled back exactly as a rejected run is. The category exists to record that a measurement was made, not to smuggle an unvalidated change into the running server. If the user wants the change installed anyway, that is a **second, explicit decision** — record it as `installed by instruction, not by evidence`, with the power number next to it, and keep it out of the published recipe. In the report table, give it its own disposition value (`not-actionable`) so it never reads as an accept.

**A lever that wins on speed and loses on output length is a fourth disposition: `accept-lossy`.** The three dispositions describe the *speed* verdict; `stats.py outlen` produces a separate fact the taxonomy has to carry. A lever that passes `accept` and Holm and is then flagged by `outlen` (per-prompt move past the threshold, a uniform shift, or a majority shift — the three detection mechanisms) is **accepted on speed and labelled as a trade** — disposition `accept-lossy`, never a bare `accept`, and never `not-actionable` (it is actionable; the question is whether the user wants the trade). It enters `best-config.json` only after the user's call, the report row names the mechanism and the length delta (`+19% c1 decode, −15% output length`), and the published recipe states the trade next to the number. A bare `accept` on an `outlen`-flagged lever is the failure mode this disposition exists to prevent: the harness reports a speed win that is partly a shorter answer.

**Log a deferred lever once, under the gate that fires first.** A lever can fail the 2 × MAD below-noise filter *and* the stop rule at the same time. Check the stop rule first: if the hill-climb has stopped, log `deferred: hill-climb stopped (remaining gap X% < max(2×MAD, user_floor))` and do not also log a below-noise deferral for the same lever. If the stop rule does not fire, log `deferred: below noise floor (expected Y% < 2×MAD Z%)`. Two entries for one lever read as two levers in the ledger and distort the plateau count (three consecutive inside-noise levers).

Both terms in the stop rule are needed. MAD alone stops a quiet host at a 1.7% gap, which can still be a whole extra GPU's worth of throughput at concurrency; a noisy host at 12% MAD stops early for the same reason.

Stop the hill-climb when any of:

- The remaining gap to the sustained ceiling is below `max(2 × MAD, user_floor)`.
- All config levers (1–7) have been tried and the last three landed inside noise.
- The user's target is met.
- The measurement budget is exhausted (state the budget in hours before starting).

**"Surprising"** = the improvement exceeds 2 × MAD: it earns a second confirm run. All MAD thresholds use the measured **per-dimension** MAD from the baseline noise floor, never a generic estimate. Re-measure the MAD after any lever that changes the kernel landscape (quantization format, attention library, kernel work) — the noise floor of the new system is not the old one, and a stale MAD silently mis-sizes every later experiment.

### Rollback

After a rejected run, restore `best-config.json` as the launch command before the next experiment. Never leave the server running a rejected config. `scripts/queue.sh` does not auto-rollback — the agent must. Set `SERVER_STOP` in the queue so a crashed run's server is stopped before the next job benchmarks it.

### Plateau

Declare a plateau when three consecutive levers land inside noise. **The count is of levers you ran and measured inside noise** — a lever disposed `not-actionable` is not an inside-noise landing (it cleared 1 × MAD and is a rejection for a different reason), a lever deferred by the 2 × MAD filter was never run, and a deferred lever logged twice (stop rule *and* below-noise) is one lever. Counting any of those inflates the streak and declares a plateau the harness never measured. Write a STATUS section in `PLAN.md` with:

- best numbers vs baseline vs ceiling;
- what limits further gains, with evidence;
- a ranked list of the remaining levers and their estimated cost.

Then keep the loop alive at a slower cadence if the user said "don't stop", or hand back.

## 4. Qualify and publish

See `references/publishing.md`.

- Pin weights by revision, engine by image digest or source commit, and kernels by commit. Build the published artifact from those pins in a clean checkout, never from a dirty tree.
- Run the acceptance gates on the clean build: load, chat, reasoning, tools round-trip, a long-context needle, and speed.
- Then A/B the clean build against your best image to prove they match.
- Report which numbers come from which harness. Gate numbers (e.g. thinking on, first 30 s) and hill-climb numbers (thinking off, medians) are not comparable.

## 5. Reporting to the user

- **Start with a table:** metric, baseline, now, ceiling, disposition, how it was measured (median of N, cold or warm, which harness).
- **Then:** what got the gains, why it stops here, the known limitations, and the system state you changed (power profile, running servers, uncommitted code, branches that must not be deleted).
- **Say plainly** what was not verified.
- **When asked to free the GPU:** drain, stop the server, confirm no processes and an idle clock, and end any loop.
