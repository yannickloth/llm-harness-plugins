# Measurement methodology

Most "wins" and "regressions" in inference tuning are measurement errors. In every case below, a check like this changed a conclusion.

## Counting

- **Count tokens with the tokenizer or the server's usage stats, not streamed chunks.** With speculative decoding, engines emit several tokens per SSE chunk; counting chunks under-reported MTP decode. Use `stream_options: {include_usage: true}` or `continuous_usage_stats`, or re-tokenize the output.
- **Size prompts with the real tokenizer.** "Random word" documents were ~3.5 tokens per word, not ~1.3–1.9, so nominal "32K/128K" cells were really 58K/232K.
- **Build prompts before the clock starts.** Make them unique per run, with a random prefix, so prefix caching cannot hit, unless you are measuring cache hits deliberately.
- **Decode tok/s:** completion tokens after the first token ÷ time since the first token.
- **Prefill tok/s:** prompt tokens ÷ TTFT on a cold, unique prompt. Report cold and warm (cache-hit) separately; never publish a cache-hit prefill as prefill.
- **Concurrent throughput (cN):** total completion tokens across N streams ÷ wall time from first start to last finish. Per-stream sums overstate it when streams don't overlap. Verify the server actually ran N at once (`max_running`, state slots).

## Noise

- Expect ±5–10% run-to-run. Sources include:
  - thermals and clocks;
  - power source (a laptop on battery or a balanced profile ran 8–10% slower);
  - background CPU load (a laptop RTX 4080 went 107 → 75 tok/s under light CPU load);
  - prompt content, because acceptance depends on text type.
- Take ≥6 decode samples and use the median. Use a fixed, seeded prompt panel; random prompts moved acceptance from 2.4 to 3.7 and made c1 comparisons pure noise.
- **Interleave runs:** control, candidate, control. Compare a candidate only with its neighbours. Drift over an hour can exceed the effect you are measuring: the same config measured 53.8 and then 49.5 an hour apart.
- **When comparing engines,** run them on the same card on the same day, back to back. Accept "B is faster" only if a bootstrap 95% CI of median(B)/median(A) is above 1.0 (needs ≥20 samples per side; below that use the Mann-Whitney test).
- Discard cold first runs and the first boot after a JIT cache miss (36 vs 90 tok/s on one vLLM boot).
- Microbenchmarks need interleaved min-of-N timing; clock ramp-up made one kernel look 2.5× slower than it was.

## Acceptance statistics

The ±5–10% above is a prior, not a measurement. The actual design lives in `scripts/stats.py`
and the ground rules; the points that are easy to get wrong:

- **Size n from the effect, not a constant.** Power is set by `d = expected_gain / sigma`, with sigma measured per dimension. A 5% effect at 7.5% noise is d = 0.67, and the test sees it **13% of the time at 4+4, 18% at 6+4, 26% at 6+6**. A fixed sample size is underpowered for small effects and wasteful for large ones. `stats.py design --mad M --current C --expected E --confirm-set K` returns the n that reaches 80% **exact** power, plus the **exact** alpha.
- **Alpha is quantized at small n.** The U statistic takes C(n1+n2, n1) values, so only certain p-values are achievable: 0.0286 at 4+4, 0.0333 at 6+4, 0.0465 at 6+6, 0.0500 at 3+3. Do not report "α = 0.05" when the test can only reach 0.0286; report the alpha you actually have.
- **The normal-approximation power is a lower bound, not the number to act on.** Measured over 70+ (n, d) combinations it was never above the exact power, and the gap grows with n: +12pp at 3+3, +14pp at 4+4, +45pp at 8+8, +55pp at 12+12 (d = 1.5). `stats.py` reports both; quote the exact one, with its Monte Carlo standard error.
- **Exact power is not monotonic in n, and the dips sit at specific boundaries.** Measured at 150k sims: d = 0.3 gives 9.1% at 3+3 and **6.2%** at 4+4; d = 0.5 gives 13.0% → 9.6%; the 7→8 dip appears only at d ≤ 0.5 (21.2% → 20.9%). At d = 1.2 the dip is at **3+3 → 4+4** (32.9% → 31.1%), *not* at 7→8, where d = 1.2 is monotonic (65.2% → 68.0%). **Exact** power is monotonic in n for d ≥ 1.5 — verified over n = 3…12 at d = 1.5, 2.0, 2.5, 3.0, 3.21, 4.0 and 5.14, no dips. Do not read that as a property of the **normal approximation**: `power()` dips at 3→4 *and* at 7→8 for **every** d tested, including d = 3.0 (85.0% → 83.6%, then 89.9% → 88.8%), because it is a step function of the discrete rejection point. Say which of the two you are quoting. This never bites the `design` search: at every d where an exact dip exists, the normal-approx starting point is n₀ ≥ 9, so the search starts above the dip and walks upward through monotonic territory. It bites you if you hand-pick n by eyeballing a power table across the 3→4 boundary.
- **Screen, then confirm.** Pre-register the confirm set (top-K by *expected* effect, K fixed before any run) and confirm it at the designed n on fresh data; accept on the confirm stage alone. Screen **every** candidate lever, including the confirm set, at n=4/side as a sequencing filter. Disclose both screen costs: 15 null levers produce ≥1 false hit 35% of the time, and the screen misses 86% of real d = 0.67 effects. Neither costs validity, because a screen hit is never an acceptance — it costs runs, and a screen miss is a lever you never tested. Re-testing only the levers that looked big is selection on the tail and the family-wise error is unbounded.
- **The whole confirm set is pre-registered as one group, before any screening.** Screening results may never choose what gets confirmed. The loophole to close: screen 15 levers, take the ~5 screen hits, and confirm each as its own K = 1 test. That is not a 5% procedure — confirming M screen-selected levers each at α = 0.05 has a family-wise false-accept rate of 1 − 0.95^M (14% at M = 3, 23% at M = 5), and the screen selected them, so the selection is on the tail. Pre-register K, the list and the α in PLAN.md before the first run; a screen hit outside that list is exploratory and is reported as exploratory.
- **Holm twice: across secondary metrics, and across the confirm set.** An uncorrected k-metric regression check at α = 0.05 has a 14% family-wise false-positive rate at k = 3; 6 levers each accepted at α = 0.05 has a 26% family-wise false-accept rate. `stats.py holm` does the step-down for both.
- **Holm's tightest threshold is α/K, and it sizes the test.** The step-down's first threshold is α/K, so the Mann-Whitney must be *able* to produce a p that small — otherwise the chain stops at step 1 and the confirm set is unacceptable, every time. At n = 3+3 the smallest achievable p is 0.0500, so Holm across K = 2 (threshold 0.025) can never fire. Reachability: K = 2 needs n ≥ 4+4 (α = 0.0143), K = 3 needs n ≥ 4+4, K = 6 needs n ≥ 5+5 (α = 0.0079). `stats.py design --confirm-set K` sizes n against α/K, not against α. This is the most common way a confirm stage silently accepts nothing.
- **Holm's chain-stop means "ok" is not "tested".** The step-down stops at the first non-rejection and reports every later lever as `ok` without testing it: with p = 0.008, 0.042, 0.048 the first is rejected and the other two are `ok`, so the lever with p = 0.048 is never claimed. That is the definition of the procedure, not a bug — Holm controls FWER in the strong sense and is uniformly more powerful than Bonferroni. Read `ok` as "not claimed", never as "shown to be null".
- **Applying Holm to a discrete statistic quantizes how many levers you can accept, and the quantization is coarsest at small n.** Measured at 8+8 with K = 6: the achievable p-values are 0.0001, 0.0002, 0.0003, 0.0005, 0.0009, 0.0015, 0.0023, 0.0035, 0.0052, **0.0074**, 0.0103, 0.0141, 0.0190, 0.0249, 0.0325, 0.0415, and Holm's six thresholds are 0.0083, 0.0100, 0.0125, 0.0167, 0.0250, 0.0500. Every threshold is reachable, so the stage is not broken — but step 2's threshold (0.0100) sits in the gap between grid values 0.0074 and 0.0103, so at *that* (n, K) accepting two levers requires both on the top cell: one lever at 0.0074 with the rest at 0.0111 → accepts 1; two at 0.0074 → accepts 6. **Do not generalize that to "0, 1, or everything".** Enumerated on real grid values the intermediate counts are reachable: at 8+8/K = 6, [0.0074, 0.0074, 0.0103, 0.0249, 0.0249, 0.0249] → accepts 3, and [0.0074, 0.0074, 0.0103, 0.0141, 0.0249, 0.0524] → accepts 5; at 5+5/K = 6 (grid 0.0040, 0.0079, 0.0159, 0.0278, 0.0476) → 1, 2 and 6 are all reachable. The sharp statement that holds at every (n, K): **the chain stops at the first p exceeding its own threshold, so the accept count is decided by where the k-th smallest p lands against threshold k**, and at small n the grid is coarse enough that a lever with a real effect can sit 3% above its threshold (p = 0.0103 vs 0.0100) and stop the chain. Report the grid you are working on with your `n`, not a rule of thumb. If you need levers accepted independently, that is Bonferroni's job (test every lever at α/K, no chain) and it costs power; say which procedure you ran and report it.
- **`power_exact` standardizes on the observation unit, which is the run median — and that makes it essentially exact, not conservative.** MAD is measured across run medians, so d = gain / sigma_of_medians and the simulated observation is standardized to sd 1. To simulate the real statistic in that same unit, draw 6 raw samples with sd **1 / 0.4617 = 2.166** (the exact reciprocal of the median's sd; 2.157 from the simulated 0.4635, 1.954 from the asymptotic 0.5117) and take their median: the median then has sd 1.0 and mean shift d. Measured that way, median-of-6 power matches the single-sample model within simulation error: **+0.1pp** at 4+4/d = 1.0 (23.5% vs 23.4%), +0.5pp at 6+6/d = 1.0, **+0.1pp** at 8+8/d = 2.08, +0.2pp at 8+8/d = 1.5, −0.3pp at 4+4/d = 3.21. So `power_exact` is the right model, not a lower bound. The "+1.2 to +6.2pp lower bound" an earlier revision of this skill claimed was produced by scaling with the **asymptotic** sd (0.5117, 10.8% too big): that gives the simulated median tails heavier than a real median-of-6 has, and the extra power is an artifact of the wrong scale. And the trap is unchanged: drawing 6 samples from N(d, 1) and taking their median leaves the median with sd 0.4617 while the shift stays d, which silently multiplies the effect size by 2.166 — at 4+4/d = 1.0 it reports 72% power where the truth is 23%.
- **Below-noise floor is not "failed".** If the expected gain < 2× MAD, the experiment is
  underpowered; record it as deferred, not rejected, and re-test at the designed n if it
  becomes worth it.
- **1 × MAD is a threshold on the *difference of two medians*, and 1 × MAD is the default.** The stopping rule and the "inside noise" reading compare two run medians, so the threshold lives on `sd(difference) = sd(median of 6) × sqrt(2) = 0.4617 × 1.414 = 0.6530`, which in MAD units (MAD = 0.6745σ) is **0.968 × MAD** — the 1 × MAD rule is 3% too loose, and the probability of clearing it by chance under the null is **15.1%** (2.0% at 2 × MAD). So 1 × MAD is a *screening reading*, never an acceptance: the acceptance test is `stats.py accept`. Do not use 1.073 (the asymptotic-sd artifact, 10.8% high) and do not use the asymptotic sd for anything. SKILL.md §Stopping criterion carries the threshold table; the derivation and the exact order-statistic check are in ASSUMPTIONS.md.
- **MAD = 0.6745 × sigma.** `sigma = MAD / 0.6745`. The stability gate compares the
  MAD-derived sigma against the range-derived sigma (range / d2(n)); a ratio above 2× is
  drift, not run-to-run noise.

## Speculative decoding specifics

- Judge per-step time (ms per verify step) and accepted length separately. tok/s = a ÷ step_time.
- Higher acceptance can be slower: a 7-token draft accepted 3.26 vs MTP's 2.85, yet ran 11–14% slower.
- Acceptance counters may only update on request completion, so a short window sees a biased sample. Probe whole requests.
- Acceptance depends on content and temperature. Code and greedy decoding draft far better than sampled prose. Report the panel, temperature and thinking mode with every number.
- A greedy equivalence check (spec on vs off) can diverge because of numerics: different kernels for M=1 vs M=k rows. Compare logits at the divergence point before calling it a bug. A top-2 tie of 0.016 nats is not a bug.

## Long context

- A fixed decode window can end inside a long prefill. Use a dedicated long-context run: a cold request, then a warm same-document request.
- Retrieval needles (3 random codes at different depths, answered exactly) prove the whole context works. Speed alone doesn't.

## Output sanity

- Flag looping output (repeated shingles), failed requests, an idle GPU (<60% busy in the window), prefill inside the decode window, and KV-bound admission. A 117 tok/s "record" was a model emitting a numbered list in a loop.

## Memory

- On unified memory (Apple, Intel/AMD iGPU, GB10/Spark-class), GPU allocations bypass cgroup accounting. A MemAvailable delta showed 14 GiB where the real footprint was 29.4 GiB.
- Sum driver residency (Linux DRM: `drm-resident-*` in `/proc/<pid>/fdinfo`, deduplicated by `drm-client-id`) plus cgroup `anon`.
- Track the peak with a ~1–5 s sampler, and kill the run at the cap.

## Profiling

- Profile with graphs off to get a per-kernel breakdown, but remember that graphs change launch overhead. Time the graph replay itself for the real step time.
- Profile prefill by stage (GEMM, attention, MoE, linear attention, norms/Hadamards) before picking the next lever.
- Debug builds that remove work (e.g. skipping dequantization) change code generation, so they are not valid lower bounds.
- Read the ISA or assembly when a kernel is "at the limit". Register-region moves, spills and serialized tails hide there.

## Power and thermal

- **Thermal throttling:** on laptops and dense GPUs, sustained clocks drop 10–20% after 5–15 minutes of load. Measure clocks at the start and end of each run; void the run if the end clock is more than 5% below the start.
- **Power limits:** `nvidia-smi -q -d POWER` shows the current and default power limit. A reduced power limit (common on laptops) caps throughput. Record it with every number.
- **Power efficiency:** tok/s per watt is a useful secondary metric, especially on laptops where battery life is the real constraint. Measure with `nvidia-smi --query-gpu=power.draw --format=csv,noheader` during the decode window.
- **Battery:** a laptop on battery runs 8–10% slower (bench.py refuses to run on battery when `require_ac` is set).
- **Sustained vs peak:** a single 10-second decode sample measures peak. A 5-minute sustained run measures the thermal steady state. Report which one you measured. The ceiling formulas assume peak; the sustained ceiling is 10–20% lower on thermally constrained hardware.
