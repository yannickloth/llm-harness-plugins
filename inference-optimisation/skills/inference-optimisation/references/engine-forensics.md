# Engine forensics (optional, reverse-engineering-gated)

This reference is **optional**. It only applies if a reverse-engineering toolchain
such as REA is available in the environment. Everything in the main skill works
without it; the rest of this page is skipped when no such tool exists. An agent that
does not have these tools must not spend turns trying to call them.

It serves two jobs the standard loop does not:

1. **Lever 8 — kernel work.** The skill says "profile, read the ISA, fix the dominant
   kernel" and ships no instrument for it. This is where reading the engine's own
   shipped code pays off.
2. **Evidence integrity.** The ground rule "void the run if the environment changed"
   is only enforceable if the change is measured, not asserted.

Both are gated: use them only when the tool is present, and cite the tool's own
digest-stamped output in `PLAN.md` rather than paraphrasing it.

## 1. Reading the kernel the engine actually ships

The lever-8 claim "defaults are tuned for a bigger card" is only verifiable against
the concrete artifact on this machine.

- **GPU code objects.** vLLM, SGLang, TensorRT-LLM and flash-attention ship CUDA fatbins
  and CUBIN/PTX inside their `.so` files. `inspect_gpu_code_objects` enumerates them
  without executing: kernel names, launch configs, tile and thread sizes, the fatbin's
  per-architecture variants. This is the direct check for "is this kernel built for my
  SM count and memory width, or for a bigger card."
- **Native symbols.** `open_binary` on the engine's shared libraries, then
  `analyze_function` / `decompile_all` on the hot kernel or scheduler symbol. For
  llama.cpp and EXL3 the hot path is a single `.so`; the GEMV kernel is one function.
  Reading it confirms the tile size, vector width and whether dequantization is
  in-kernel (it interacts with the quantization format, lever 1).
- **Managed code.** `inspect_python_pyc` reads the scheduler, the config defaults and
  the cache-warming path of a Python engine (vLLM, SGLang) without executing it. This
  is how you confirm *why* a flag has its default, and whether the JIT cache is keyed
  on the quantization format (it usually is — that is why a format change invalidates
  the cache).
- **Web-UI engines.** LM Studio and Ollama expose their config surface through a
  bundled frontend. `analyze_javascript_application` recovers the config schema and
  the defaults from the shipped bundle, so the launch config is compared against the
  tool's own advertised options, not against a memory of them.

The output for this page is a short note in `PLAN.md`: which kernel is dominant, its
concrete tile/thread sizes, and whether they match this hardware's SM count and
memory width. That note is what justifies moving from "tune thread and tile sizes"
(lever 7) to "write a kernel" (lever 8).

## 2. Explaining an engine comparison

The standard loop compares two engines by a CI on the median tok/s ratio — a number
with no reason. When the tool is present, add the reason:

- `compare_functions` on the dominant kernel between the two engine builds, and
  `compare_artifacts` on their shipped GPU code objects. If engine B is 15% faster in
  decode, the static diff usually shows it: a wider vector load, a different tile,
  a fused dequant, a different attention kernel.
- `compare_application_versions` for Python engines: the config/scheduler diff that
  explains a startup or TTFT gap.

Cite the comparison output (it carries a digest) next to the measured number in the
report. "B is 15% faster (CI 95% [1.12, 1.19]) because its GEMV uses 256-bit vector
loads where A uses 128-bit" is a publishable claim; "B is 15% faster" is not.

## 3. Evidence integrity for the A/B loop

The ground rule is: record state at start and end of each run, void the run if it
changed. `bench.py` records the cheap fingerprint (driver, kernel, GPU, CPU, python)
and flags `STATE_CHANGED`. The reverse-engineering tools add the parts `bench.py`
cannot see:

- **Controlled replay.** `capture_process_scenario` runs the server launch under a
  PTY and returns a `full_scenario_sha256`, the terminal frames, the process tree
  (pids, parent pids, command lines, process-group ids) and before/after filesystem
  checkpoints with per-file SHA-256. That is the mechanical form of "the server I
  benchmarked is the one I configured, and nothing on disk changed under me."
- **Comparing the two sides.** `compare_process_captures` compares the control run and
  the candidate run across terminal, lifecycle, process and filesystem dimensions.
  A candidate that launches an extra worker process, or whose config file differs by
  one byte, is visible here and invisible to a tok/s-only ledger.
- **The watchdog as evidence.** The memory probe's own behaviour is captured the same
  way, so "the cap was unenforced" is a captured exit code and an empty stdout, not an
  inference.

Use this for the confirm stage and for the stability gates — the runs whose verdict
you publish. The screen stage does not need it; that is the cost trade that keeps the
budget honest.

## 4. Auditing the skill's own scripts

The same capture tools audit this skill's harness. Running each script under a
controlled replay and reading the exit code and the exact output catches the failure
modes that review misses:

- a probe that prints nothing on a missing dependency (reads as a silent no-op);
- a documented default that is not actually in the code (a hard key access instead of
  a defaulted one);
- an argument path that "succeeds" doing nothing;
- a division by zero that only triggers on a specific input.

The pattern: compile and run every shipped script under capture, with one happy path
and one malformed input each, and read the exit code and stdout/stderr. If a script
fails silently or returns a plausible-looking wrong number, fix the script, not the
document that describes it.

## What this page does not do

- It is **not the measurement instrument.** Token throughput comes from `bench.py`;
  these tools wrap and explain, they do not replace it.
- It is **not a statistics substitute.** Acceptance is still the exact Mann-Whitney in
  `stats.py`. A capture digest is not a p-value.
- It is **not required.** If the toolchain is absent, skip this entire page and rely
  on the profiler, the ledger and the measured ceilings.
