# Prompt: run an inference hill-climb with the `inference-optimisation` skill

Paste the block below as the task for a coding agent with shell access on the machine that serves the model. Fill in the `<…>` fields first (including `<PLUGIN_ROOT>`, the absolute path to this plugin's directory). Delete lines that don't apply.

---

You are optimising the serving speed of a local LLM on this machine. Use the `inference-optimisation` skill. If your harness doesn't load skills, read `<PLUGIN_ROOT>/skills/inference-optimisation/SKILL.md` now, and read its `references/` files when the skill points to them. Follow its ground rules exactly.

## Target

- **Model:** `<model name / repo @ revision>`, quantization `<e.g. EXL3 4bpw / GGUF Q4_K_M / AWQ / FP8 / MLX 4-bit>`
- **Engine:** `<vLLM / SGLang / llama.cpp / TabbyAPI / MLX-LM / …>`
- **Current launch:** `<command, or "the server on http://127.0.0.1:8000">`
- **Hardware:** `<GPU(s), memory, unified or discrete>`
- **Metrics to maximise, in priority order:** `<e.g. c1 decode tok/s, c4 aggregate decode, prefill tok/s at 4K/32K/256K, KV capacity, startup time, TTFT>`
- **Hard constraints:**
  - memory cap `<e.g. 46 GiB for the whole stack>`;
  - context `<e.g. 262,144 tokens>` that must stay stable;
  - concurrency `<N>` users at full context;
  - quality `<lossless only | labelled lossy trades allowed (e.g. int8 prefill)>`.
- **Stretch goal from the user:** `<e.g. "100 tok/s c1">`. Check it against the ceiling and report honestly.

## How to manage the work

1. **Set up and measure.**
   - Set up the experiment directory: `PLAN.md`, `THEORY.md`, `configs/`, `ledger.jsonl`, `best-config.json`.
   - Inventory the machine, and measure real bandwidth and matmul throughput.
   - Compute the ceilings with `scripts/ceiling.py` and write them to `THEORY.md`.
   - Measure the baseline with `scripts/bench.py` — **10 runs**, which is also the noise floor: `stats.py noise` on those 10 medians gives the MAD of every dimension, and every later threshold (1 × MAD, the 2 × MAD filter, the stop rule) is expressed in it.
   - **On thermally constrained hardware, measure the sustained ceiling:** one 20+ minute sustained load, take the clock ratio at the end of the window, record `thermal_drop_pct`. Rank the gap table against the **sustained** ceiling, never the peak, and carry the band `measured_drop ± uncertainty` — ±2–3 points on a well-cooled desktop, ±10–15 on a machine whose clocks sawtooth.
   - Write the gap table: per row the gap % (throughput rows `(sustained − current) / sustained`; latency rows, where the ceiling is a floor, `(current − floor) / current`), the closure you can claim, expected gain = gap % × closure, effort, risk, and the detectability check. Rank by expected gain ÷ effort.
2. **Loop:**
   - **Pre-register the confirm set as one group before the first run**: K, the lever list, and α. Write all three in `PLAN.md`. Every later threshold (α/K, and the n that `design` returns) follows from it, so it cannot be chosen after you see data.
   - Size every test with `stats.py design --mad M --current C --expected E --confirm-set K`. It sizes n against **α/K** — Holm's tightest threshold — and reports the exact α and exact power; log n, α and power in `PLAN.md`. If it answers "not testable", say so and take one of the three ways out it names.
   - Screen candidates at n = 4 per side as a **sequencing filter over every candidate** (including the pre-registered set); confirm the pre-registered set at its designed n. A screen hit outside the pre-registered set is exploratory: report it as such, do not claim it.
   - Make exactly one change in a new config.
   - Run it between two controls with `scripts/queue.sh ctl cand ctl`, with `--reps` ≥ 2 × panel size so the per-prompt output-length guard can see every prompt (below that the run is flagged `OUT_LEN_UNTESTED` and the length gate has not been run).
   - Accept per lever with `stats.py accept --confirm-set K`, then judge the confirm set as a group with `stats.py holm --mode confirm` on its p-values. **`accept` alone is not the verdict:** with K levers, Holm's first threshold is α/K, and a lever `accept` accepts at p = 0.049 is refused at K = 6.
   - **Check output length against the control on every accepted lever:** `stats.py outlen --ctl <control's out_tokens_by_prompt> --cand <candidate's>`. The speed test compares tok/s and the spread guard compares repeats of the same prompt, so a lever that scales every answer by the same factor has spread 0%, coverage 100%, passes the speed test, and is a shorter answer, not a faster one. `outlen` flags any prompt whose median moved more than 20% and prints the verdict; a flagged lever is a **labelled lossy trade** and needs the user's call before it enters `best-config.json`.
   - Log the numbers and the reason in `PLAN.md`, with the disposition: `accept`, `accept-lossy` (speed win confirmed, `outlen` flagged a length trade — needs the user's call before it enters `best-config.json`, and the report names the length delta), `reject`, or `not-actionable` (above noise, below the worth-testing threshold). `not-actionable` is a rejection for every operational purpose: no confirm stage, not in `best-config.json`, not in the published recipe, config rolled back.
   - Never rerun something `PLAN.md` already rejected without a new reason.
3. **Gate every new best:**
   - long-context needle retrieval at ~50%, then ~100% of the context;
   - a concurrent full-length soak if the KV pool is sized for N users;
   - a greedy equivalence check for changes claimed to be lossless.
4. **Safety, always:**
   - one GPU job at a time;
   - an AC power and performance-profile guard;
   - the memory watchdog on;
   - drain requests before stopping a server, never force-kill mid-batch;
   - detach long queues so they survive restarts.
5. **Credentials:** if a sudo password or token is needed, ask once, through your harness's secret mechanism. Store it in a mode-600 file and never print it, commit it, or put its path in anything published.
6. **Cadence:** if told "don't stop", keep looping. When three levers in a row land inside noise, write a STATUS/plateau section in `PLAN.md` and keep going at a slower cadence: profile, then try kernel-level levers. Otherwise, hand back at the plateau.
7. **Afterwards:** restore the best server on its usual port, unless the user asked for the GPU to be freed.

## How to report

Every report, whether progress or final, starts with this table:

| Metric | Baseline | Now | Ceiling | How measured |
|---|---:|---:|---:|---|
| c1 decode | | | | median of N, thinking on/off, prompt panel, temperature |
| cN decode | | | | wall-clock aggregate |
| Prefill 4K / 32K / long | | | | cold unique prompt, prompt_tokens ÷ TTFT |
| KV capacity | | | | tokens, and N × context proven by soak |
| Startup / TTFT | | | | |
| Peak memory | | | | driver residency + anon, vs cap |

Then:

- **What got the gains,** one line each, with the measured effect.
- **What limits further gains,** with evidence: profile numbers, acceptance by depth, percentage of ceiling.
- **Known limitations,** e.g. decode stalls during a long prefill.
- **System state you changed:**
  - power profile;
  - running containers;
  - uncommitted code;
  - branches that must not be deleted;
  - files to clean up.
- **What you did *not* verify.**

Rules for the report:

- Use medians, not best runs. Label single runs.
- Never mix numbers from different harnesses without saying which is which.
- If asked to publish, follow `references/publishing.md`:
  - land the code on a pinned commit;
  - build cleanly from pins;
  - run the acceptance gates;
  - prove the clean build matches the best;
  - grep for secrets;
  - open a PR from the current main.

## When the user says "take it down" or "free the GPU"

1. Abort and drain requests.
2. Stop the server.
3. Confirm no model processes remain and the GPU is idle.
4. Stop any loop.
5. Mention any power profile or setting that is still changed.
