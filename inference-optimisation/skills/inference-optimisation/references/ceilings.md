# Computing theoretical ceilings

Measure the hardware; don't trust the spec sheet. A device-to-device copy of a large buffer gives realistic bandwidth. A large square FP16/BF16 GEMM (4096³ and 8192³) gives realistic compute; the larger one shows thermal and clock drop. Practical ceilings below assume about 100% of *measured* bandwidth and a tunable MFU (model FLOPs utilization) factor. The default MFU is 0.5, but it varies widely: well-tuned flash attention on A100/H100 reaches 0.6–0.7; quantized kernels and MoE padding cliffs drop it to 0.2–0.4. Measure your own MFU with a large GEMM and set it in the JSON.

**Peak vs sustained:** the formulas below compute peak ceilings. On thermally constrained hardware (laptops, dense GPUs), sustained clocks drop 10–20% after 5–15 minutes of load. Compute both: `sustained_ceiling = peak_ceiling × (1 − thermal_drop_pct/100)`. Compare your measurements against the sustained ceiling, not the peak, because `sustained ≤ peak` and the peak comparison **inflates the headroom you can see**. At a 15% drop, a machine at 75% of sustained is at 64% of peak: a 25% real gap reads as a 36% gap against the peak, 1.4× more headroom than exists, and you burn days chasing a gap that is thermally unreachable. The reverse is the tell: a measurement at 95% of peak is 112% of sustained — a burst number the machine cannot hold, not a near-ceiling result.

## Decode (memory bound, with compute floor)

Bytes read per target forward at short context:

```
B_target = dense_weight_bytes                    # attention / linear-attention, shared experts, router, norms
         + expert_bytes × (top_k / n_experts)    # MoE: only routed experts are read
         + lm_head_bytes                         # often 10–25% of the total on large vocabularies!
         + kv_bytes_per_token × context          # scales with context; dominates at long context
         + recurrent_state_bytes × 2 × streams   # SSM / GDN state read + write, per stream,
                                                 # O(1) in context — never multiply it by context
```

Use the checkpoint's tensor sizes, which already include quantization. Don't use parameter count × bits.

**Decode is memory-bandwidth bound on essentially every machine that runs an LLM.** The compute floor
below is kept because it is correct, not because it is usually active. The crossover is arithmetic:

```
the floor binds  ⟺  peak_flops / bandwidth  <  intensity / mfu      (intensity = flops_per_token / bytes_per_token)
```

Measured peak-to-bandwidth ratios (FLOPs per byte, FP16 tensor units over spec memory bandwidth):

| Part | peak/BW |
|---|---:|
| RTX 3090 | 38 |
| RTX 4090 | 98 |
| A100 SXM | 201 |
| H100 SXM | 295 |
| Arc B390 (the worked example) | 313 |
| server CPU, AVX-512 (EPYC 7763 / 9654) | ~20 |
| laptop CPU | ~18 |

Decode intensity is `flops_per_stream / bytes_per_step`, and it is **not a constant** — it moves with
context and with concurrency, in **opposite directions**. FLOPs per decoded stream per step are
`2 × active_params + 4 × layers × heads × head_dim × L`: the linear term plus the attention term,
which is linear in L because a decoded token attends the whole cached context. Measured on the worked
example (2.43 B active → 4860 MFLOP linear; 10 attn layers × 16 heads × 256 dim → 671 MFLOP at 4K,
42,950 MFLOP at 256K):

| Context | n | bytes/step | linear | attention | intensity w/o attn | **intensity with attn** | thr @mfu 0.5 | thr @0.2 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 4K | 1 | 1.690 GB | 4,860 | 671 | 2.88 | **3.27** | 6.5 | 16.4 |
| 32K | 1 | 1.984 GB | 4,860 | 5,369 | 2.45 | **5.16** | 10.3 | 25.8 |
| 128K | 1 | 2.990 GB | 4,860 | 21,475 | 1.63 | **8.81** | 17.6 | 44.0 |
| 256K | 1 | 4.333 GB | 4,860 | 42,950 | 1.12 | **11.04** | 22.1 | 55.2 |
| 32K | 4 | 4.421 GB | 4,860 | 5,369 | 1.10 | **2.31** | 4.6 | 11.6 |
| 32K | 16 | 12.985 GB | 4,860 | 5,369 | 0.37 | **0.79** | 1.6 | 3.9 |
| 256K | 16 | 50.566 GB | 4,860 | 42,950 | 0.10 | **0.95** | 1.9 | 4.7 |

(MFLOP columns are per stream per step; intensity is per stream, and the `accept` factor cancels from
numerator and denominator so speculation does not change it.)

**The two directions, and why they matter:**

- **Longer context raises intensity.** Attention FLOPs grow linearly in L (×8.8 on this model from 4K
  to 256K) while KV bytes grow far more slowly (×2.6). Intensity goes **up** 3.4×, so the threshold
  `intensity/mfu` goes up and the compute floor becomes **LESS inert at long context**. Round 5 of this
  skill's own review asserted the opposite ("more inert at long context"); that was computed from the
  linear term alone, which is the error this table exists to prevent.
- **Higher concurrency lowers intensity.** Weights amortize across streams (one read serves all n)
  while attention does not (each stream attends its own context), so the weight-dominated part dilutes:
  3.27 → 0.67 F/B from c1 to c16 at 4K. At long context the two effects partly cancel (0.95 at 256K c16).

Weight-only, the short-context c1 limit: **1.0 FLOPs/byte for FP16 weights, 2.0 for int8, 4.0 for 4-bit**
(2 FLOPs per parameter ÷ bytes per parameter). The worked example is a 4-bit model, so 3.27 at 4K c1 is
its weight-dominated value.

**Intensity has a ceiling, and it is a model constant.** As L → ∞ the weights and the linear FLOP term
both become negligible relative to L, so

    intensity_max = 4 × attn_layers × attn_heads × head_dim ÷ (kv_rows × kv_bytes_per_token)

(`kv_rows` = drafts + 1 when `kv_per_verify_row` is set: per-row speculation multiplies the KV bytes and
*lowers* the bound.) For the worked example: 4 × 10 × 16 × 256 ÷ 10,240 = **16.0 FLOPs/byte** (measured
14.26 at 1M context, approaching it from below).

**Expand it and the depth and head width cancel.** Write `kv_bytes_per_token = n_kv_layers × c ×
kv_heads × head_dim × bpe`, where `c` is the number of KV tensors stored per layer, `kv_heads` the KV
heads, `bpe` the bytes per stored element. Substituting:

    MHA / GQA / MQA   (c = 2, KV stores kv_heads × head_dim):
        intensity_max = 2 × (query_heads / kv_heads) / bpe  =  2g / bpe
    MLA-style latent sharing (c = 1, K and V share one stored latent):
        intensity_max = 4 × query_heads × d_compute / (latent × bpe)

So the bound is set by the **GQA group size and the KV dtype**, not by depth, not by head width, not by
the hardware. That is the version to compute in your head, and it explains the worked example: its
`kv_bytes_per_token` of 10,240 is `2 × 10 × 16 × 256 × 0.125`, i.e. **1-bit KV**, which is why its bound
is 16.0 and not 1.0.

| Attention / KV | intensity_max | Exceeds a 3090's mfu-0.5 threshold (19.0)? |
|---|---:|---|
| MHA, FP16 KV | 1.0 | no — and below every part's threshold, at any context |
| MHA, FP8 KV | 2.0 | no |
| MHA, INT4 KV | 4.0 | no |
| MHA, 1-bit KV (the worked example) | 16.0 | no (binds on EPYC 10.2 and laptop CPU 8.9) |
| GQA-4, FP16 | 4.0 | no |
| GQA-8, FP16 | 8.0 | no |
| GQA-8, FP8 | 16.0 | no (binds on CPUs) |
| GQA-8, INT4 | 32.0 | **yes** — crossover 498K tokens on a 3090 at mfu 0.5 |
| MQA, 16 query heads, FP8 | 32.0 | **yes** |
| MLA, 128 heads, FP16 | 256.0 | **yes — and above every GPU's threshold, H100 included** |
| MLA, 128 heads, FP8 | 512.0 | **yes, by 3.5× on an H100** |

Measured on a 27B MLA configuration (30 layers, 128 heads, 576-element latent, FP8 KV, 3.7B active) on
an H100 at mfu 0.5: intensity 5.4 → 34.7 → 113.7 → 185.7 F/B from 4K to 256K against a threshold of
147.6, crossover **186,369 tokens**, and the 256K cell is compute-bound at **213 tok/s** where bandwidth
alone would allow 267. `ceiling.py` prints the bound and the crossover for any config you give it.

| Part | peak/BW | mfu 0.5 threshold | Binds at mfu 0.5? (worked example, 16.0) | mfu 0.2 threshold | Binds at mfu 0.2? |
|---|---:|---:|---|---:|---|
| RTX 3090 | 38 | 19.0 | **never** (16.0 < 19.0) | 7.6 | yes, from ~128K |
| RTX 4090 | 98 | 48.8 | never | 19.5 | never |
| A100 SXM | 201 | 100.3 | never | 40.1 | never |
| H100 SXM | 295 | 147.6 | never | 59.0 | never |
| Arc B390 | 313 | 156.5 | never | 62.6 | never |
| EPYC 7763 | 20.5 | 10.2 | **yes, from ~128K** | 4.1 | yes, from ~32K |
| laptop CPU | 17.9 | 8.9 | **yes, from ~128K** | 3.6 | yes, from ~16K |

So the hardware half of the headline is right **for the worked example**: "decode stops being
bandwidth-bound at long context" is a statement about low peak-per-byte hardware — server CPUs, laptop
CPUs, most iGPUs — because 16.0 F/B is below every discrete GPU's mfu-0.5 threshold (the smallest, a
3090, needs 19.0). It binds on a 3090 only below mfu 0.42 at any context, and below 0.29 at 256K.

**The architecture half is the part that generalizes, and it is where the headline breaks.** "Decode is
bandwidth-bound" is an **MHA/GQA-with-FP16-to-FP8-KV** statement. It is false for MQA, for MLA, and for
INT4/1-bit KV on a model with GQA: halving `bpe` doubles the bound, and MLA's latent sharing puts it at
256–512 F/B, above every GPU in the table. MLA exists precisely to trade bytes for FLOPs, so an MLA
model at long context is the case where the compute floor is the interesting constraint, not the
exception. Compute `intensity_max = 2g/bpe` (or run `ceiling.py`) for the model in front of you before
repeating any version of "GPUs are never compute-bound in decode".

Checking every part in the ratio table against `peak/BW < intensity/mfu`, with attention included:

| Part | peak/BW | floor takes over below mfu at 4K | at 256K |
|---|---:|---:|---:|
| RTX 3090 | 38 | 0.086 | **0.290** |
| RTX 4090 | 98 | 0.034 | 0.113 |
| A100 SXM | 201 | 0.016 | 0.055 |
| H100 SXM | 295 | 0.011 | 0.037 |
| Arc B390 | 313 | 0.010 | 0.035 |
| EPYC 7763 | 20.5 | 0.160 | **0.538** |
| laptop CPU | 17.9 | 0.183 | **0.616** |

**What that means.** At short context and mfu ≥ 0.2 the floor is inert on every GPU *and* on server CPUs
— bandwidth binds everywhere, and that is the normal case. At long context the split is by hardware class,
not by context alone: on a 3090-class part the floor takes over below mfu 0.29 at 256K (so at a realistic
mfu of 0.4–0.5 it stays inert), while on a server CPU it is the binding constraint at 256K for any mfu
below 0.54, i.e. essentially always. Verified against the calculator at 936 GB/s / 35.58 TFLOPS on the
worked model: 256K c1 gives 216 tok/s at mfu 0.5 (bandwidth-bound, 936/4.333 = 216), 149 at mfu 0.2 and
74 at mfu 0.1 (compute-bound) — the crossover sits at mfu ≈ 0.29 exactly where `intensity = mfu × peak/BW`
predicts it.

So the floor is a **long-context statement on low peak-per-byte hardware** — server and laptop CPUs, most
iGPUs — and a **kernel-efficiency statement on GPUs**, where it only appears at low mfu. Round 2 of this
skill's review called it a "CPU story"; with the intensity bound measured (16.0 F/B on the worked model,
below every GPU's mfu-0.5 threshold and above both CPUs'), round 2 was right for long context and wrong
for short context. Round 6 of this review over-corrected it into "stops being bandwidth-bound at long
context" with no hardware qualifier, which is false on discrete GPUs at mfu ≥ 0.5. A ceiling computed at
mfu 0.05 is a statement about how badly the GEMV is optimized, not about the hardware's memory system.
Round 1 claimed the floor fixed a "2× overestimate on small dense models"; measured at short context, it
does not.

```
bandwidth_ceiling = measured_bandwidth / bytes_per_token
compute_ceiling   = mfu × measured_peak_flops / flops_per_token
decode_ceiling    = min(bandwidth_ceiling, compute_ceiling)
```

With speculative decoding (k drafts, accepted length `a` tokens per step):

```
verify_bytes ≈ dense + lm_head + expert_bytes × (1 − (1 − top_k/n_experts)^(k+1))   # union of routed experts
draft_bytes  ≈ k × (draft_layer_bytes + draft_lm_head_bytes)                         # prune the draft head!
bytes_per_emitted_token = (verify_bytes + draft_bytes) / a
c1_ceiling = measured_bandwidth / bytes_per_emitted_token
```

Note: the expert union formula assumes independent routing per draft step. In practice, MTP/MoE draft heads on the same model route deterministically, so the union is slightly tighter (the formula is slightly pessimistic). The effect is small at top-8/256.

For a concurrency of N, dense weights are read once per step for all streams; experts follow the union of all rows' routing; KV is per stream. The aggregate ceiling grows almost linearly with N until the expert union and per-stream KV dominate the bytes. On memory-constrained hardware (unified memory), KV growth at high concurrency pushes weights into page memory, reducing effective bandwidth — the linear scaling assumption breaks down.

## Prefill (compute bound)

```
flops_per_token ≈ 2 × active_linear_params
                + 4 × n_full_attn_layers × n_heads × head_dim × position   (causal: average position = L/2)
                + linear-attention / SSM terms
prefill_ceiling(L) ≈ 0.5 × measured_peak_flops / mean_flops_per_token(L)
```

Int8/FP8 tensor cores double the peak for the parts that use them. For MoE, small per-expert row counts at a given chunk size lower GEMM efficiency; that is usually the biggest gap.

## TTFT, startup, KV

- **Short-prompt TTFT floor:** one forward pass (bytes ÷ bandwidth) plus tokenize and schedule. That is typically 30–60 ms on a laptop and a few ms on datacenter GPUs.
- **Startup floor:** weight bytes ÷ disk or page-cache speed, plus allocation. That is about 10 s when kernel JIT, autotune and graph-capture caches persist.
- **KV:** `bytes/token = n_kv_layers × 2 × n_kv_heads × head_dim × bytes_per_elem` (+ the draft layer's own KV). This is the only term that scales with context.
- **Recurrent state (hybrid SSM/GDN/Mamba):** `recurrent_state_bytes = n_ssm_layers × (conv width + state width) × bytes_per_elem`, **per stream, O(1) in context**. It is a fixed per-stream cost, so it enters the capacity denominator as a constant, not multiplied by context:

```
per_stream_gb = kv_bytes_per_token × context / 1e9 + recurrent_state_bytes / 1e9
max_full_length_streams = (memory_cap − weights − runtime) / per_stream_gb
```

Scaling the state by context is a real and large error: at 262K it charges 24 GB per stream for a
0.7 GB state, a 34× overcount that halves the predicted concurrency on a hybrid model.

## Worked example: Ornith-1.5-35B-A3B (Qwen3.5-MoE hybrid), EXL3 4 bpw, Intel Arc B390 iGPU

**Hardware (measured):**
- 115 GB/s copy bandwidth on 64 GB of LPDDR5X (153.6 GB/s spec).
- 35.8 TFLOPS FP16 at 4096³, dropping to 20 at 8192³.

**Model:** 40 layers: 30 GDN linear-attention plus 10 full-attention. 256 experts, top-8.

| Component | GB / target token |
|---|---:|
| Routed experts: 16.26 GB × 8/256 | 0.508 |
| Dense: GDN 0.515 + full attention 0.137 + shared expert 0.064 + router 0.042 | 0.758 |
| LM head (6-bit, 248K vocab) | 0.382 |
| **Total** | **1.648** |

**Single-user decode ceilings (practical, at 115 GB/s):**

| Mode | GB per emitted token | Ceiling |
|---|---:|---:|
| No speculation | 1.68 | 68 tok/s |
| 1 MTP draft, full draft head, a = 1.85 | 1.38 | 83 tok/s |
| 1 draft, pruned 32K-token draft head | 1.19 | 97 tok/s |
| 2 drafts, a ≈ 2.5 | 1.11 | ~103 tok/s |

The pruned draft head, about 8× fewer head bytes, was worth more than an extra draft.

**What happened in practice:**

- **c1 decode:** it reached ~53 tok/s, about 55% of the ceiling. The model's MTP head accepted only ~14% at depth 2, so the 2-draft row was unreachable. The remaining gap was the quantized GEMV kernels, at ~76 GB/s effective in the verify graph.
- **Prefill:** about 670 tok/s practical at 256K versus 628 achieved. Long-context prefill was close to its ceiling.
- **KV cache:** FP8 KV is 10,240 B/token, so 2.7 GB per 256K stream. Four full-length streams fit in about 11 GB under a 46 GiB cap.

`scripts/ceiling.py` does this arithmetic from a small JSON of component sizes.

**Reproducing this example:** `python3 scripts/ceiling.py examples/ceiling-ornith-b390.json` gives
68 tok/s (no speculation) and 102 tok/s (2 drafts, a = 2.5) at 4K, and 684 tok/s prefill at 256K. The
decode rows match the table above; the published prefill number 670 corresponds to `mfu ≈ 0.49`
rather than the fixture's 0.5. The table records **measured** values, the calculator reproduces them
to within 2% — which is the point: a ceiling you cannot reproduce from a checked-in JSON is a number,
not a tool.

## Multi-GPU (tensor parallelism)

With tensor parallelism across N GPUs, each GPU computes 1/N of the linear layers, then an all-reduce combines the partial results. The interconnect bandwidth (NVLink, PCIe, InfiniBand) becomes a ceiling:

```
allreduce_bytes_per_layer = 2 × (N − 1) / N × hidden_dim × bytes_per_elem × batch_size
allreduce_time_per_layer  = allreduce_bytes / interconnect_bandwidth
decode_ceiling_tp         = min(bandwidth_ceiling, 1 / (forward_time + n_layers × effective_allreduce_time))
```

Two factors, and both are easy to get wrong:

- **`2`** — a ring all-reduce is reduce-scatter then all-gather, so each GPU sends its full share twice.
- **`(N − 1) / N`** — in a ring of N, each GPU forwards to N−1 neighbours, not to one. The traffic
  saturates near `2 × S` as N grows; it does **not** keep shrinking with N.

A formula using `2 / N` instead is right only at N = 2 and undercounts by 3× at N = 4 and 7× at N = 8
(hidden 8192, 2 bytes, batch 4: N=4 ring 98 KB vs 33 KB). That is a *ceiling* undercount, so it
overstates how good multi-GPU scaling can be — the direction that produces a publishable number
nobody can reproduce.

**Compute-communication overlap:** the all-reduce of layer i's output can overlap with layer i+1's compute (up-projection, MLP). Modern engines achieve 40–60% overlap. Use `effective_allreduce_time = (1 − overlap) × allreduce_time` where overlap is 0.0–0.6, tunable.

On NVLink (600 GB/s bidirectional), the all-reduce is fast and the ceiling is close to the single-GPU bandwidth ceiling. On PCIe Gen4 (32 GB/s), the all-reduce dominates at large batch sizes.

**KV cache in TP:** the KV cache is replicated per-GPU (not split across GPUs). All GPUs need full K and V for attention scoring. The per-GPU memory budget for KV is the same as single-GPU.

**Expert parallelism (MoE):** each GPU holds a subset of experts. The all-to-all bandwidth for routing becomes the ceiling. Measure the interconnect with a device-to-device copy of a large buffer, not the spec sheet.

**Pipeline parallelism:** the bubble (idle time waiting for the previous stage) is the ceiling. `bubble_fraction = (n_stages - 1) / (n_stages + n_microbatches - 1)`. Increase micro-batches to shrink the bubble.
