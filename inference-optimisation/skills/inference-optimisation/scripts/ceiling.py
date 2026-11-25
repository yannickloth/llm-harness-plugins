#!/usr/bin/env python3
"""Theoretical ceilings for decode / prefill / KV from a small JSON of measured hardware and model sizes.

  python3 ceiling.py model.json

Example model.json (Ornith-1.5-35B-A3B EXL3 4bpw on an Arc B390 iGPU; sizes in GB from the checkpoint):
{
  "bandwidth_gbs": 115, "peak_tflops": 36, "mfu": 0.5,
  "dense_gb": 0.758, "experts_gb": 16.26, "top_k": 8, "n_experts": 256, "lm_head_gb": 0.382,
  "active_params_b": 2.43, "attn_layers": 10, "attn_heads": 16, "head_dim": 256,
  "kv_bytes_per_token": 10240, "draft_layer_gb": 0.03, "draft_head_gb": 0.05,
  "spec": [{"drafts": 0, "accept": 1.0}, {"drafts": 1, "accept": 1.74}, {"drafts": 2, "accept": 2.5}],
  "contexts": [4096, 32768, 131072, 262144], "concurrency": [1, 4]
}

Units — every size is GB (10^9 bytes), every rate is per second. Use `memory_cap_gb`, not GiB;
mixing GiB into a GB calculation is a silent 7% error.

Keys
  bandwidth_gbs, peak_tflops   measured, not spec-sheet. Device-to-device copy; large square GEMM.
  mfu                          model FLOPs utilization, 0 < mfu <= 1. Default 0.5. Well-tuned flash
                               attention on A100/H100 reaches 0.6-0.7; quantized kernels and MoE
                               padding cliffs drop it to 0.2-0.4. Measure it on your hardware.
  thermal_drop_pct             sustained clock drop, 0-50. Peak ceilings are unreachable on
                               thermally constrained hardware; compare measurements to the sustained
                               ceiling, not the peak.
  dense_gb, experts_gb, top_k, n_experts, lm_head_gb   from the checkpoint's tensor sizes, which
                               already include quantization. Dense models: experts_gb 0.
  active_params_b              active parameters per token, in billions.
  attn_layers, attn_heads, head_dim   full-attention layers only. Linear-attention / GDN / SSM
                               layers are O(L) in context; account for them in extra_flops_per_token.
  extra_flops_per_token        extra FLOPs per token from linear-attention, SSM, Mamba, RoPE, norms.
                               Omit for a standard transformer.
  kv_bytes_per_token           n_kv_layers x 2 x n_kv_heads x bytes_per_elem x (head_dim for MHA/GQA/
                               MQA; the stored latent for MLA). Grows with context: the only term scaled
                               by ctx. For MLA-style latent sharing, set head_dim to the SAME latent
                               dimension used here (d_compute = latent when QK^T and A*V both run in the
                               shared latent): head_dim = 576 with a 512+64 latent, not 128. Setting the
                               per-head width instead understates the intensity bound (227.6 vs 256.0
                               F/B on a 30-layer 128-head MLA at FP16).
  recurrent_state_gb           hybrid SSM/GDN models only: the recurrent state **per stream**, in GB.
                               O(1) in context - read and written every step, never scaled by ctx.
                               n_ssm_layers x (conv width + state width) x bytes_per_elem. This one
                               key is the whole recurrent footprint; there is no per-token recurrent
                               term, and no second key to keep consistent with it.
  draft_layer_gb, draft_head_gb  speculative decoding. draft_head_gb is the *pruned* draft LM head.
                               Omit it and the script assumes the full unpruned head, which is the
                               pessimistic case, and says so.
  kv_per_verify_row            1 when each draft row carries its own KV (EAGLE-style draft models).
                               0 (default) for MTP: the draft shares the target's KV positionally,
                               so the verify step reads n rows of KV, not n x (drafts + 1).
  memory_cap_gib               accepted for backward compatibility and converted to GB; prefer
                               memory_cap_gb.
  runtime_overhead_gb          engine + CUDA/graph + allocator overhead. Default 2.
"""
import json
import sys

GIB = 2**30
GB = 1e9


def validate(m):
    """Fail loudly. A ceiling computed from a bad unit is worse than no ceiling."""
    def need(k):
        if k not in m:
            sys.exit(f"model.json: missing required key {k!r}")
    for k in ("bandwidth_gbs", "peak_tflops"):
        need(k)
        if not isinstance(m[k], (int, float)) or m[k] <= 0:
            sys.exit(f"model.json: {k} must be a positive number, got {m[k]!r}")
    m.setdefault("mfu", 0.5)
    if not 0 < m["mfu"] <= 1:
        sys.exit(f"model.json: mfu must be in (0, 1], got {m['mfu']!r}")
    if m.get("experts_gb"):
        for k in ("top_k", "n_experts"):
            need(k)
            if not isinstance(m[k], (int, float)) or m[k] <= 0:
                sys.exit(f"model.json: {k} must be positive when experts_gb is set, got {m[k]!r}")
        if m["top_k"] > m["n_experts"]:
            sys.exit(f"model.json: top_k {m['top_k']} > n_experts {m['n_experts']}")
    if m.get("thermal_drop_pct", 0) < 0 or m.get("thermal_drop_pct", 0) >= 50:
        sys.exit(f"model.json: thermal_drop_pct must be in [0, 50), got {m.get('thermal_drop_pct')!r}")
    for k in ("dense_gb", "lm_head_gb", "active_params_b"):
        if m.get(k, 0) < 0:
            sys.exit(f"model.json: {k} must be non-negative, got {m[k]!r}")
    if "recurrent_bytes_per_token" in m:
        sys.exit("model.json: 'recurrent_bytes_per_token' is not a key. The recurrent state is O(1)\n"
                 "  per stream and does not scale with context; use 'recurrent_state_gb' (GB per\n"
                 "  stream). Scaling it by ctx overstates hybrid decode by up to 10^5x at 256K.")
    if m.get("recurrent_state_gb", 0) < 0:
        sys.exit(f"model.json: recurrent_state_gb must be non-negative, got {m['recurrent_state_gb']!r}")
    for k in ("concurrency", "contexts", "spec"):
        if k in m and not m[k]:
            sys.exit(f"model.json: {k} must be a non-empty list")
    for n in m.get("concurrency", [1]):
        if n < 1:
            sys.exit(f"model.json: concurrency must be >= 1, got {n!r}")
    for s in m.get("spec", [{"drafts": 0, "accept": 1.0}]):
        if s.get("drafts", 0) < 0 or s.get("accept", 1) < 1:
            sys.exit(f"model.json: spec entry needs drafts >= 0 and accept >= 1, got {s!r}")
    return m


def memory_cap_gb(m):
    """Accept memory_cap_gb; convert memory_cap_gib. Never mix the two silently."""
    if "memory_cap_gb" in m:
        return m["memory_cap_gb"]
    if "memory_cap_gib" in m:
        return m["memory_cap_gib"] * GIB / GB
    return None


def recurrent_per_stream_gb(m):
    """Hybrid SSM/GDN recurrent state in GB, PER STREAM. O(1) in context, never scaled by ctx.

    Bandwidth reads it twice per step (read + write); capacity stores it once.
    """
    return m.get("recurrent_state_gb", 0)


def per_token_bytes(m, ctx, drafts, n):
    """Bytes read per step for N concurrent streams at context length ctx."""
    union = 1 - (1 - m["top_k"] / m["n_experts"]) ** ((drafts + 1) * n) if m.get("experts_gb") else 0
    verify = m.get("dense_gb", 0) + m.get("lm_head_gb", 0) + m.get("experts_gb", 0) * union
    # SSM/GDN state is O(1) per stream: read and written every step, and it does NOT grow with
    # context. Multiplying it by ctx (as if it were KV) overstates hybrid decode by orders of
    # magnitude at long context.
    verify += n * recurrent_per_stream_gb(m) * 2
    # KV is per stream and does grow with context. MTP shares the target's KV (n rows);
    # EAGLE-style drafts carry their own.
    kv_rows = drafts + 1 if m.get("kv_per_verify_row") else 1
    verify += n * m.get("kv_bytes_per_token", 0) * ctx / GB * kv_rows
    draft = drafts * n * (m.get("draft_layer_gb", 0) + m.get("draft_head_gb", m.get("lm_head_gb", 0)))
    return verify + draft


def decode_flops_per_stream(m, ctx):
    """FLOPs for ONE stream for ONE decode step: linear + attention + any extra per-token term.

    The attention term is not optional at long context. A decoded token attends the whole cached
    context, so its cost is linear in L: 4 * layers * heads * head_dim * L FLOPs (QK^T and A*V,
    2 FLOPs per MAC each). On the worked example that is 671 MFLOP at 4K and 42,950 MFLOP at 256K -
    8.8x the 4860 MFLOP linear term. Prefill uses the causal AVERAGE (L/2) because its tokens see a
    growing prefix; decode sees the full L every step, so it must use L, not L/2.

    GQA/MQA does not reduce this: every query head still attends all L positions, GQA only shrinks
    the KV bytes. A hybrid model must set attn_layers to the count of FULL-ATTENTION layers only.
    `extra_flops_per_token` (SSM/GDN/Mamba/RoPE/norms) applies to decode as well as to prefill -
    it is a per-token cost, not a prefill-only one, and leaving it out of decode understates the
    compute floor on hybrid models.
    """
    return (2 * m.get("active_params_b", 0) * GB
            + 4 * m.get("attn_layers", 0) * m.get("attn_heads", 0) * m.get("head_dim", 0) * ctx
            + m.get("extra_flops_per_token", 0))


def decode_ceiling(m, drafts, accept, ctx=0, n=1):
    """Decode ceiling, aggregate tok/s for N concurrent streams. min(bandwidth, compute)."""
    bytes_step = per_token_bytes(m, ctx, drafts, n)
    bw = m["bandwidth_gbs"] / (bytes_step / (accept * n)) if bytes_step > 0 else float("inf")
    flops_stream = decode_flops_per_stream(m, ctx)
    if flops_stream > 0:
        # The compute term is n-INDEPENDENT, and that is not a bug. Each stream pays its own linear
        # matmul on its own activations and its own attention over its own context, so one step costs
        # n * flops_stream FLOPs and emits accept * n tokens:
        #     tok/s = (mfu*peak / (n*flops_stream)) * accept * n = mfu*peak*accept / flops_stream
        # n cancels. Dividing this by n (a tempting "fix") gives the PER-STREAM ceiling, not the
        # aggregate; at n=16 that is 16x too small. Worked at 256K, mfu 0.1, 35.58 TFLOPS: step FLOPs
        # 47.8 / 191.2 / 765.0 GFLOP at n=1/4/16 -> 74.4 / 18.6 / 4.7 steps/s -> 74.4 tok/s aggregate
        # at every n.
        #
        # The crossover is arithmetic, not folklore: the floor binds when intensity > mfu * peak/BW,
        # with intensity = step FLOPs / step bytes. Intensity RISES with context (attention FLOPs grow
        # with L, KV bytes grow far slower) and FALLS with concurrency (weights amortize over streams,
        # attention does not). Crucially it is BOUNDED: as L -> infinity the linear term and the weights
        # both vanish relative to L, leaving a model constant - see intensity_bound() and
        # crossover_ctx(), which compute it and the context where the floor takes over. The closed form
        # is 2g/bpe for MHA/GQA/MQA (g = query heads per KV head, bpe = bytes per KV element), so the
        # bound depends on GQA group size and KV dtype, NOT on depth or head width:
        #     MHA FP16 1.0 | GQA-8 FP16 8.0 | GQA-8 FP8 16.0 | GQA-8 INT4 32.0 | MQA-16 FP8 32.0
        #     MLA 128 heads FP16 256.0 | MLA 128 heads FP8 512.0
        # On the worked example (1-bit KV, MHA) the bound is 16.0 F/B, so on a 3090 (peak/BW 38) the
        # floor binds only below mfu 0.42 at any context, and below mfu 0.29 at 256K; on an H100 (295)
        # only below mfu 0.054. At mfu >= 0.5 that model's floor is inert on every discrete GPU at every
        # context, and binds on low peak/BW parts (EPYC 7763: threshold 10.2 F/B < 16.0). It is NOT
        # inert for MQA/MLA or INT4/1-bit KV: a 27B MLA model at 256K on an H100 at mfu 0.5 is
        # compute-bound at 213 tok/s (bandwidth would allow 267). "Decode is bandwidth-bound" is a
        # statement about MHA/GQA with FP16-FP8 KV. See references/ceilings.md.
        compute = m["mfu"] * m["peak_tflops"] * 1e12 / flops_stream * accept
        return min(bw, compute)
    return bw


def intensity_bound(m, drafts=0):
    """Asymptotic ceiling of decode compute intensity (FLOPs per byte), as context -> infinity.

    Decode intensity is  (linear + a*L) / (weights + kv_rows*kv*L),  with a = 4*attn_layers*attn_heads*
    head_dim. As L -> infinity the weights and the linear term vanish relative to L and what is left is
    a model constant:

        intensity_max = 4 * attn_layers * attn_heads * head_dim / (kv_rows * kv_bytes_per_token)

    Expanding kv_bytes_per_token = n_kv_layers * c * kv_heads * head_dim * bpe (c = KV tensors stored
    per layer, bpe = bytes per stored element) cancels the layer count AND the head dimension:

        MHA / GQA / MQA   (c = 2):  intensity_max = 2 * (q_heads / kv_heads) / bpe = 2g / bpe
        MLA-style latent  (c = 1):  intensity_max = 4 * q_heads * d_compute / (latent * bpe)

    So the bound is set by the GQA group size and the KV dtype, NOT by depth or head width. Worked
    values at the mfu-0.5 thresholds (3090 19.0, 4090 48.8, A100 100.3, H100 147.6 F/B):

        MHA FP16 1.0 | MHA FP8 2.0 | MHA INT4 4.0 | MHA 1-bit 16.0
        GQA-8 FP16 8.0 | GQA-8 FP8 16.0 | GQA-8 INT4 32.0 | MQA-16 FP8 32.0
        MLA 128 heads FP16 256.0 | MLA 128 heads FP8 512.0

    MHA/GQA with FP16-FP8 KV stays under every discrete-GPU threshold at any context. MQA, MLA and
    INT4/1-bit KV do not: a 27B MLA model at 256K on an H100 at mfu 0.5 is COMPUTE-bound (measured
    213 tok/s against a 267 tok/s bandwidth ceiling, intensity 512 vs threshold 147.6). "Decode is
    bandwidth-bound" is an MHA/GQA FP16-KV statement.
    """
    kv = m.get("kv_bytes_per_token", 0)
    if not kv:
        return None
    a = 4 * m.get("attn_layers", 0) * m.get("attn_heads", 0) * m.get("head_dim", 0)
    return a / (kv * (drafts + 1 if m.get("kv_per_verify_row") else 1))


def crossover_ctx(m, n=1, drafts=0):
    """Where the compute floor binds, as (context_tokens, binds_above). None if it never binds.

    Binds when intensity > mfu * peak / BW. With step FLOPs n*(F0 + a*L) and step bytes B0 +
    kv_rows*n*kv*L/GB, the crossing is

        L = (T*B0 - n*F0) / (n*(a - T*kv_rows*kv)),   T = mfu*peak/BW in FLOPs per byte

    Four cases, and the second one is the reason this function returns a direction and not just a
    number. Intensity is monotonic in L, and its slope sign is the sign of (a - T*kv_rows*kv):

        denom > 0, num > 0   ->  intensity rises through the threshold: binds ABOVE L.
        denom > 0, num <= 0  ->  already above it at L = 0: binds at EVERY context (returns 0).
        denom < 0, num < 0   ->  intensity starts above and FALLS through it: binds BELOW L.
        denom < 0, num > 0   ->  starts below and falls further: never binds (returns None).

    The "binds BELOW" case requires f0/b0 > T, i.e. intensity at ctx=0 exceeds the hardware
    threshold. Since f0/b0 ≤ 2 for any real model and T ≥ 8 for any real hardware (minimum on a
    slow CPU), this requires mfu < 2/T < 0.001 — a meaningless operating point. For any real
    configuration this case is effectively impossible.
    """
    kv = m.get("kv_bytes_per_token", 0)
    if not kv:
        return None
    t = m["mfu"] * m["peak_tflops"] * 1e12 / (m["bandwidth_gbs"] * GB)   # FLOPs per byte
    a = 4 * m.get("attn_layers", 0) * m.get("attn_heads", 0) * m.get("head_dim", 0)
    rows = drafts + 1 if m.get("kv_per_verify_row") else 1
    f0 = 2 * m.get("active_params_b", 0) * GB + m.get("extra_flops_per_token", 0)
    b0 = per_token_bytes(m, 0, drafts, n) * GB          # bytes/step at ctx 0 (weights, drafts, state)
    # Binds when  n*(f0 + a*L)  >  t * (b0 + rows*n*kv*L)
    denom = n * (a - t * rows * kv)
    num = t * b0 - n * f0
    # Intensity curve: I(L) = (f0 + a*L) / (b0 + rows*n*kv*L). Its slope sign is (a - T*rows*n*kv)
    # which is denom/n. When denom == 0, intensity is flat. When denom != 0, I(L) is monotonic.
    if denom == 0:
        # Flat curve: never crosses the threshold. Binds everywhere if already above, nowhere if below.
        return (0, True) if num < 0 else None     # num < 0 → starts above → binds at every context
    if denom > 0:
        return (0, True) if num <= 0 else (num / denom, True)
    if num >= 0:
        return None                      # starts at/below threshold and falls further below
    return (num / denom, False)          # starts above it and falls through at L


def prefill_ceiling(m, L):
    """Prefill ceiling, tok/s, practical. Causal attention is O(L) per token, O(L^2) total."""
    linear = 2 * m.get("active_params_b", 0) * GB
    attn = 4 * m.get("attn_layers", 0) * m.get("attn_heads", 0) * m.get("head_dim", 0) * (L / 2)
    return m["mfu"] * m["peak_tflops"] * 1e12 / (linear + attn + m.get("extra_flops_per_token", 0))


def sustained(peak, pct):
    return peak * (1 - pct / 100)


def main(path):
    with open(path) as f:
        m = validate(json.load(f))
    thermal = m.get("thermal_drop_pct", 0)
    print(f"bandwidth {m['bandwidth_gbs']} GB/s, peak {m['peak_tflops']} TFLOPS, MFU {m['mfu']}")
    if thermal:
        print(f"thermal drop {thermal}% -> sustained = peak x {1 - thermal / 100:.2f}")
    if "memory_cap_gib" in m and "memory_cap_gb" not in m:
        print(f"note: memory_cap_gib {m['memory_cap_gib']} converted to {memory_cap_gb(m):.1f} GB")
    if m.get("spec") and any(s["drafts"] for s in m["spec"]) and "draft_head_gb" not in m:
        print("warning: draft_head_gb unset, assuming the FULL unpruned LM head per draft step.")
        print("         Pruning the draft head is usually the single biggest speculation win.")

    for n in m.get("concurrency", [1]):
        print(f"\nDecode ceiling, concurrency {n} (aggregate tok/s):")
        print("  drafts accept" + "".join(f"{c // 1024:>8}K" for c in m.get("contexts", [0])))
        for s in m.get("spec", [{"drafts": 0, "accept": 1.0}]):
            row = "".join(f"{decode_ceiling(m, s['drafts'], s['accept'], c, n):9.0f}"
                          for c in m.get("contexts", [0]))
            print(f"  {s['drafts']:>6} {s['accept']:>6}{row}")
        if thermal:
            print("  sustained:")
            for s in m.get("spec", [{"drafts": 0, "accept": 1.0}]):
                row = "".join(f"{sustained(decode_ceiling(m, s['drafts'], s['accept'], c, n), thermal):9.0f}"
                              for c in m.get("contexts", [0]))
                print(f"  {s['drafts']:>6} {s['accept']:>6}{row}")

    kv = m.get("kv_bytes_per_token", 0)
    if kv:
        # mfu*peak FLOP/s divided by bandwidth in BYTES/s is FLOPs per byte. bandwidth_gbs is in GB/s,
        # so the GB must be expanded: leaving it out makes the threshold 1e9 times too big and the
        # bound never crosses it, which is exactly the bug this line is here to make impossible.
        t = m["mfu"] * m["peak_tflops"] * 1e12 / (m["bandwidth_gbs"] * GB)
        b = intensity_bound(m)
        print(f"\nDecode compute-intensity bound: {b:.1f} FLOPs/byte (asymptotic, ctx -> infinity)")
        print(f"  hardware threshold at mfu {m['mfu']}: {t:.1f} F/B  (mfu x peak / bandwidth, in FLOPs per byte)")
        if b <= t:
            print("  asymptotic bound <= threshold: the floor does NOT bind at long context on this")
            print("  hardware. That says nothing about short context - a model can start above the")
            print("  threshold and fall through it. The crossover line below decides, per concurrency.")
        else:
            print(f"  bound > threshold: the compute floor BINDS at long context. Closed form is")
            print(f"  2g/bpe for MHA/GQA/MQA (g = query heads per KV head, bpe = bytes per KV element),")
            print(f"  4*heads*d_compute/(latent*bpe) for MLA latent sharing. Halving bpe doubles the bound.")
        if m.get("kv_per_verify_row"):
            for dd in sorted({s.get("drafts", 0) for s in m.get("spec", [{"drafts": 0}])}):
                print(f"  drafts={dd} with kv_per_verify_row: bound {intensity_bound(m, dd):.1f} F/B "
                      f"(per-row KV divides the bound by {dd + 1})")
        max_ctx = max(m.get("contexts", [262144]))
        for n in m.get("concurrency", [1]):
            x = crossover_ctx(m, n)
            if x is None:
                line = "never binds at any context"
            else:
                L, above = x
                if L == 0:
                    line = "binds at EVERY context"
                elif L > 10 * max_ctx:
                    # A tiny positive denominator puts the crossing at 1e9+ tokens. Correct arithmetic,
                    # useless as guidance: say it is out of range instead of printing a quadrillion.
                    line = (f"crosses at {L:,.0f} tokens - {L / max_ctx:.0f}x the longest context here, "
                            f"so treat it as never binding in practice")
                elif above:
                    line = f"compute floor takes over ABOVE {L:,.0f} tokens"
                else:
                    line = (f"compute floor binds BELOW {L:,.0f} tokens (intensity falls through the "
                            f"threshold as context grows)")
            print(f"  concurrency {n}: {line}")

    print("\nPrefill ceiling (tok/s, practical):")
    for L in m.get("contexts", [4096]):
        c = prefill_ceiling(m, L)
        line = f"  {L // 1024:>4}K {c:8.0f}"
        if thermal:
            line += f"  sustained {sustained(c, thermal):8.0f}"
        print(line)

    kv_pt = m.get("kv_bytes_per_token", 0)
    state_ps = recurrent_per_stream_gb(m)
    if kv_pt or state_ps:
        ctx = max(m.get("contexts", [262144]))
        kv_gb = kv_pt * ctx / GB
        per_stream = kv_gb + state_ps
        label = "KV" if not state_ps else ("KV + recurrent state" if kv_pt else "recurrent state")
        print(f"\n{label}: {per_stream:.2f} GB per {ctx // 1024}K-token stream")
        if kv_pt and state_ps:
            print(f"  KV {kv_gb:.2f} GB (scales with ctx) + recurrent state {state_ps:.2f} GB "
                  f"per stream (does NOT scale with ctx)")
        cap = memory_cap_gb(m)
        if cap:
            weights = m.get("dense_gb", 0) + m.get("experts_gb", 0) + m.get("lm_head_gb", 0)
            runtime = m.get("runtime_overhead_gb", 2)
            avail = cap - weights - runtime
            streams = int(avail / per_stream) if per_stream > 0 and avail > 0 else 0
            print(f"  Max full-length streams under {cap:.1f} GB: {streams}")
            print(f"  (weights {weights:.1f} + runtime {runtime:.1f} = {weights + runtime:.1f} GB used,"
                  f" {avail:.1f} GB free, {per_stream:.2f} GB per stream)")
            if streams == 0:
                print("  The cap does not fit one full-length stream. Shorten the context, shrink")
                print("  the quantization, or lower the KV dtype before chasing concurrency.")


if __name__ == "__main__":
    main(sys.argv[1]) if len(sys.argv) > 1 else sys.exit(__doc__)
