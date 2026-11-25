#!/usr/bin/env python3
"""Acceptance statistics for the hill-climb loop. Standard library only.

Every number here is exact where it can be. With 4-12 samples per side, the normal
approximation is not just imprecise, it is wrong about what your alpha IS, so this
computes the exact null distribution of the Mann-Whitney U statistic.

  # 1. Noise floor. Run the baseline 10x, feed the 10 c1 medians in.
  python3 stats.py noise 53.1 52.4 54.0 53.6 52.9 53.8 53.3 54.2 52.7 53.5

  # 2. Design the experiment. What n per side, and what alpha can you actually get?
  #    --confirm-set K is not optional in practice: Holm's tightest threshold over a
  #    confirm set of K levers is alpha/K, and the test must be able to reach it.
  python3 stats.py design --mad 2.6 --current 53 --expected 8 --confirm-set 6

  # 3. Judge one experiment.
  python3 stats.py accept --cand 55.1 56.0 55.4 55.8 55.2 55.9 --ctl 53.1 52.4 54.0 53.6 --confirm-set 6

  # 4. Family-wise correction. secondary: a rejection is a REGRESSION.
  #    confirm: a rejection is a REAL EFFECT on a pre-registered lever.
  python3 stats.py holm --alpha 0.05 "prefill=0.0021" "ttft=0.14" "startup=0.61"
  python3 stats.py holm --alpha 0.05 --mode confirm "graphs=0.0143" "kv=0.0429"

  # 5. Engine comparison (needs >= 20 samples per side).
  python3 stats.py bootstrap --a 1 2 3 ... --b 20 21 22 ...

  # 5b. Power table for a fixed n across a list of expected gains.
  python3 stats.py power --mad 2.6 --current 53 --gains 5 10 20

  # 6. Output length vs the control, per prompt. The speed test compares tok/s, and
  #    the per-prompt spread compares repeats of the SAME prompt - so a lever that
  #    shortens every answer by the same factor has spread 0%, coverage 100%, passes
  #    the speed test, and is a shorter answer, not a faster one. This is the gate
  #    that compares the candidate's medians against the control's.
  python3 stats.py outlen --ctl 118 96 204 71 133 88 --cand 61 49 105 37 68 45

Why the sample size is not a constant
  The test's power is set by d = expected_gain / sigma, and sigma is measured per
  dimension. A 5% gain on a 7.5%-noise metric is d = 0.67 and needs ~29 runs per
  side; a 20% gain on the same metric is d = 2.7 and needs 3 (not 2 - at 2+2 the
  U statistic cannot produce any p <= 0.05, so 2 per side is not a test). Fixing n at 6+4
  means the loop is underpowered for small effects and wasteful for large ones.
  `design` computes n from the effect you actually expect.

Why alpha is quantized
  With n1 + n2 samples the U statistic takes C(n1+n2, n1) equally likely values, so
  only certain p-values are achievable. At 6 vs 4 the smallest p <= 0.05 is 0.0333
  (U >= 21 of 24); the next one is 0.0571. Claiming "alpha = 0.05" at that sample
  size overstates your sensitivity. `design` reports the alpha you can actually get.
"""
import argparse
import itertools
import math
import random
import statistics
import sys

Z_ALPHA = {0.01: 2.326, 0.025: 1.960, 0.05: 1.645, 0.10: 1.282}
Z_POWER = {0.5: 0.0, 0.7: 0.524, 0.8: 0.842, 0.9: 1.282}
MWU_EFFICIENCY = 3 / math.pi  # ~0.955: normal-score efficiency of Mann-Whitney vs t
# Shewhart d2(n): E[range] = d2 x sigma. Two independent sigma estimates (range vs MAD)
# should agree; a >2x ratio is drift, not run-to-run noise.
D2 = {3: 1.693, 4: 2.059, 5: 2.326, 6: 2.534, 7: 2.704, 8: 2.847, 9: 2.970, 10: 3.078,
      11: 3.173, 12: 3.258, 13: 3.336, 14: 3.407, 15: 3.472, 16: 3.532, 17: 3.588,
      18: 3.640, 19: 3.689, 20: 3.735}


def mad(xs):
    """Median absolute deviation from the median. The robust noise estimate."""
    m = statistics.median(xs)
    return statistics.median([abs(x - m) for x in xs])


def sigma_from_mad(m):
    """MAD = 0.6745 x sigma for normal noise, so sigma = 1.4826 x MAD.

    Mann-Whitney is distribution-free, so this conversion is for the power estimate
    only; the test itself never assumes normality.
    """
    return m / 0.67449


def u_stat(cand, ctl):
    """U = number of (candidate, control) pairs where candidate > control. Ties = 0.5."""
    u = 0.0
    for c in cand:
        for k in ctl:
            u += 1.0 if c > k else (0.5 if c == k else 0.0)
    return u


def u_null_counts(n1, n2):
    """Exact null distribution of U, indexed by deficit d = n1*n2 - U.

    count[d] = coefficient of q^d in the Gaussian binomial [n1+n2 choose n1]_q, which
    equals the number of partitions of d into <= n1 parts, each <= n2. Verified against
    brute-force rank enumeration in the test suite below.
    """
    maxk = n1 * n2
    # A[i][j] = coeff list for [i+j choose i]_q, where A[i][j][d] = count[d].
    # Recurrence: [i+j choose i] = [i+j-1 choose i] + q^j [i+j-1 choose i-1]
    #  -> A[i][j][d] = A[i][j-1][d] + A[i-1][j][d - j].
    A = [[None] * (n2 + 1) for _ in range(n1 + 1)]
    for i in range(n1 + 1):
        A[i][0] = [0] * (maxk + 1)
        A[i][0][0] = 1
    for j in range(n2 + 1):
        A[0][j] = [0] * (maxk + 1)
        A[0][j][0] = 1
    for i in range(1, n1 + 1):
        for j in range(1, n2 + 1):
            prev_j = A[i][j - 1]
            prev_i = A[i - 1][j]
            cur = [0] * (maxk + 1)
            for d in range(maxk + 1):
                cur[d] = prev_j[d] + (prev_i[d - j] if d >= j else 0)
            A[i][j] = cur
    return A[n1][n2]


def _tail_p(counts, total, maxk, u):
    """P(U >= u) for possibly fractional u (ties). u' integer: sum_{u'>=ceil(u)} count_u."""
    need = math.ceil(u - 1e-12)
    if need > maxk:
        return 0.0
    # deficit d = maxk - u';  u' >= need  <=>  d <= maxk - need.
    return sum(counts[d] for d in range(0, maxk - need + 1)) / total


def mwu_one_sided(cand, ctl):
    """One-sided Mann-Whitney U: H1 = candidate stochastically larger. Exact p."""
    n1, n2 = len(cand), len(ctl)
    counts = u_null_counts(n1, n2)
    total = math.comb(n1 + n2, n1)
    return u_stat(cand, ctl), _tail_p(counts, total, n1 * n2, u_stat(cand, ctl)), total


def best_alpha(n1, n2, target=0.05):
    """Largest achievable one-sided p <= target, and the U needed for it."""
    counts = u_null_counts(n1, n2)
    total = math.comb(n1 + n2, n1)
    maxk = n1 * n2
    best = None
    for u in range(maxk, -1, -1):
        p = _tail_p(counts, total, maxk, u)
        if p <= target:
            best = (u, p)
        else:
            break
    return best  # (u_required, exact_alpha) or None


def power(n1, n2, d, u_required):
    """Normal-approximation power. A LOWER BOUND: measured over 70+ (n, d) combinations it was
    never above the exact power, and the gap grows with n - +12pp at 3+3, +14pp at 4+4, +45pp at
    8+8, +55pp at 12+12 (d = 1.5). Use power_exact() for the number you act on; this is only a
    starting point for the sample-size search."""
    mu = n1 * n2 / 2 + d * math.sqrt(n1 * n2 * (n1 + n2 + 1) / 12)
    sd = math.sqrt(n1 * n2 * (n1 + n2 + 1) / 12)
    return 0.5 * (1 - math.erf((u_required - mu) / (sd * math.sqrt(2))))


def power_exact(n1, n2, d, u_required, sims=40000, seed=12345):
    """Exact power at the given rejection point, by seeded Monte Carlo under a location-shift
    model (cand ~ N(d,1), ctl ~ N(0,1)). No normal approximation, so it is valid at n=3.
    Returns (power, standard error)."""
    rng = random.Random(seed)
    g = rng.gauss
    hits = 0
    for _ in range(sims):
        u = 0
        ctl = [g(0.0, 1.0) for _ in range(n2)]
        for _ in range(n1):
            c = g(d, 1.0)
            u += sum(1 for k in ctl if c > k)
        if u >= u_required:
            hits += 1
    p = hits / sims
    return p, math.sqrt(max(p * (1 - p), 1e-12) / sims)


def required_n(d, alpha=0.05, power_target=0.8):
    """Runs per side from the normal approximation: n = 2 (z_a + z_b)^2 / d^2 / MWU efficiency.

    A STARTING POINT ONLY. It uses the nominal alpha, while the real test at that n can only
    reach a smaller quantized alpha. design() re-derives n against the exact achievable alpha
    and the exact power; never quote this number on its own.
    """
    za = Z_ALPHA.get(alpha, 1.645)
    zb = Z_POWER.get(power_target, 0.842)
    n = 2 * (za + zb) ** 2 / (d * d) / MWU_EFFICIENCY
    return max(2, math.ceil(n))


def holm_bonferroni(pvals, alpha=0.05):
    """Holm step-down. pvals: list of (name, p). Returns (name, p, reject, threshold)."""
    order = sorted(pvals, key=lambda x: x[1])
    k = len(order)
    out, alive = [], True
    for i, (name, p) in enumerate(order):
        thr = alpha / (k - i)
        reject = alive and p <= thr
        alive = alive and reject
        out.append((name, p, reject, thr))
    return out


def bootstrap_ratio_ci(a, b, iters=4000, alpha=0.05, seed=0):
    """CI for median(b)/median(a). Needs >= 20 samples per side to mean anything."""
    rng = random.Random(seed)
    ratios = []
    la, lb = len(a), len(b)
    for _ in range(iters):
        ma = statistics.median([a[rng.randrange(la)] for _ in range(la)])
        mb = statistics.median([b[rng.randrange(lb)] for _ in range(lb)])
        if ma > 0:
            ratios.append(mb / ma)
    ratios.sort()
    lo = ratios[int(alpha / 2 * len(ratios))]
    hi = ratios[min(len(ratios) - 1, int((1 - alpha / 2) * len(ratios)))]
    return lo, hi, statistics.median(ratios)


def famwise(k, alpha=0.05):
    return 1 - (1 - alpha) ** k


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)

    sub.add_parser("noise", help="MAD and sigma from N baseline runs").add_argument("xs", nargs="+", type=float)

    d = sub.add_parser("design", help="choose n per side from the expected effect")
    d.add_argument("--mad", type=float, required=True, help="measured MAD, same units as the metric")
    d.add_argument("--current", type=float, required=True, help="baseline median")
    d.add_argument("--expected", type=float, required=True, help="expected gain, same units")
    d.add_argument("--alpha", type=float, default=0.05)
    d.add_argument("--power", type=float, default=0.8)
    d.add_argument("--max-n", type=int, default=12, help="beyond this the lever is not worth testing")
    d.add_argument("--sims", type=int, default=40000, help="Monte Carlo draws for the exact power")
    d.add_argument("--confirm-set", type=int, default=None,
                   help="K = levers in the pre-registered confirm set. Holm's tightest threshold is "
                        "alpha/K, and at small n the U statistic cannot reach it - K sizes the test. "
                        "Omitting it sizes n against alpha/1, which is the wrong (too small) n for any "
                        "K > 1: the Holm chain then stops at step 1 and accepts nothing.")

    a = sub.add_parser("accept", help="judge one experiment")
    a.add_argument("--cand", nargs="+", type=float, required=True)
    a.add_argument("--ctl", nargs="+", type=float, required=True)
    a.add_argument("--alpha", type=float, default=0.05)
    a.add_argument("--confirm-set", type=int, default=None,
                   help="K, the size of your pre-registered confirm set; used for the FWER advisory. "
                        "Pass it: the tool assumes 6 (the skill's typical K) when you omit it.")
    h = sub.add_parser("holm", help="Holm-Bonferroni step-down over any set of p-values "
                                    "(secondary metrics of one lever, or the primary p-values of a confirm set)")
    h.add_argument("--alpha", type=float, default=0.05)
    h.add_argument("--mode", choices=["secondary", "confirm"], default="secondary",
                   help="secondary: a rejection is a REGRESSION. confirm: a rejection is a real EFFECT.")
    h.add_argument("pairs", nargs="+", help="name=p")

    b = sub.add_parser("bootstrap", help="engine comparison CI of median(b)/median(a)")
    b.add_argument("--a", nargs="+", type=float, required=True)
    b.add_argument("--b", nargs="+", type=float, required=True)
    b.add_argument("--iters", type=int, default=4000)

    w = sub.add_parser("power", help="power table for a sample size and effect list")
    # Balanced by default: every design the skill prescribes (screen 4+4, confirm from `design`) is
    # n+n. An asymmetric default here used to print a power table for a design nobody runs.
    w.add_argument("--n1", type=int, default=6)
    w.add_argument("--n2", type=int, default=6)
    w.add_argument("--mad", type=float, required=True)
    w.add_argument("--current", type=float, required=True)
    w.add_argument("--gains", nargs="+", type=float, required=True, help="expected gains in metric units")
    w.add_argument("--sims", type=int, default=40000, help="Monte Carlo draws for the exact power")

    o = sub.add_parser("outlen", help="compare candidate output-length medians against the control, per prompt")
    o.add_argument("--ctl", nargs="+", type=float, required=True,
                   help="control out_tokens medians, one per prompt (from the ledger's out_tokens_by_prompt)")
    o.add_argument("--cand", nargs="+", type=float, required=True,
                   help="candidate out_tokens medians, same prompt order")
    o.add_argument("--threshold", type=float, default=20.0,
                   help="pct change in output length that must be labelled a trade, not a win (default 20)")
    o.add_argument("--uniform", type=float, default=5.0,
                   help="pct overall change that counts as a UNIFORM SHIFT when every prompt moved the "
                        "same way (default 5). A uniform 15% shortening is invisible to a 20% per-prompt "
                        "threshold and is exactly the mechanism the gate exists to catch.")

    sub.add_parser("selftest", help="verify the exact null distribution by enumeration")

    ns = ap.parse_args()

    if ns.cmd == "selftest":
        from itertools import combinations

        def brute(n1, n2):
            N = n1 + n2
            cnt = {}
            for S in combinations(range(1, N + 1), n2):
                sset = set(S)
                u = 0
                for c in [x for x in range(1, N + 1) if x not in sset]:
                    u += sum(1 for s in S if s < c)
                cnt[u] = cnt.get(u, 0) + 1
            return cnt

        bad = 0
        for (n1, n2) in [(2, 2), (3, 3), (2, 3), (3, 4), (4, 4), (4, 6), (6, 4), (5, 5), (6, 6), (8, 8)]:
            counts = u_null_counts(n1, n2)
            maxk, total = n1 * n2, math.comb(n1 + n2, n1)
            count_u = {maxk - d: counts[d] for d in range(maxk + 1)}
            br = brute(n1, n2)
            ok = all(count_u.get(u, 0) == br.get(u, 0) for u in range(maxk + 1)) and sum(counts) == total
            if not ok:
                bad += 1
            print(f"  n={n1}+{n2}: sum={sum(counts)}/{total} match_brute={ok}")
        print("SELFTEST", "PASS" if bad == 0 else f"FAIL ({bad} sizes disagree)")
        sys.exit(0 if bad == 0 else 1)

    if ns.cmd == "noise":
        if len(ns.xs) < 5:
            sys.exit("noise: need at least 5 baseline runs, 10 recommended")
        m = mad(ns.xs)
        s = sigma_from_mad(m)
        med = statistics.median(ns.xs)
        rng = max(ns.xs) - min(ns.xs)
        d2 = D2.get(len(ns.xs), 3.735)
        s_range = rng / d2
        ratio = s_range / s if s > 0 else float("inf")
        print(f"n = {len(ns.xs)}  median = {med:.3f}  MAD = {m:.3f} ({100 * m / med:.1f}%)")
        print(f"sigma = {s:.3f} ({100 * s / med:.1f}%)  [sigma = MAD / 0.6745]")
        print(f"2x MAD = {2 * m:.3f} ({100 * 2 * m / med:.1f}%)  <- below-noise-floor cutoff")
        print(f"range {rng:.3f} -> sigma_by_range = {s_range:.3f}; range-vs-MAD ratio {ratio:.2f}")
        ok = ratio <= 2.0
        print(f"stability gate: two independent sigma estimates agree within 2x -> "
              f"{'PASS' if ok else 'DRIFT: investigate thermal drift / background process before starting'}")

    elif ns.cmd == "design":
        s = sigma_from_mad(ns.mad)
        gain = ns.expected
        dval = gain / s
        n0 = required_n(dval, ns.alpha, ns.power)
        print(f"sigma = {s:.3f} ({100 * s / ns.current:.1f}% of current {ns.current})")
        print(f"expected gain {ns.expected} = {100 * gain / ns.current:.1f}% -> d = {dval:.2f}")
        print(f"normal-approx starting point: {n0} per side (nominal alpha {ns.alpha})")
        # Grow n until BOTH conditions hold: the quantized alpha is reachable, and the EXACT
        # power at that alpha reaches the target. The starting point assumes a nominal alpha the
        # test cannot reach at small n, so it is routinely too small.
        n, testable, pe, se, ba = n0, None, 0.0, 0.0, None
        skipped = []
        # K sizes the test: Holm's tightest threshold over the confirm set is alpha/K, and at small n
        # the U statistic cannot reach it. Sizing n against alpha alone makes the whole confirm set
        # unacceptable - the chain stops at step 1 every time.
        K = ns.confirm_set if ns.confirm_set is not None else 1
        if ns.confirm_set is None:
            print("WARNING: --confirm-set was not passed, so n is sized against alpha/K = alpha/1.")
            print("  If your pre-registered confirm set has K > 1 levers, this n is TOO SMALL: Holm's")
            print("  first threshold is alpha/K, and a test whose grid cannot reach it stops the chain")
            print("  at step 1, so the confirm stage accepts nothing, every time. Re-run with")
            print("  --confirm-set K before you fix the budget.")
        target_alpha = ns.alpha / max(1, K)
        if K > 1:
            print(f"confirm set K = {K}: Holm's tightest threshold is alpha/K = "
                  f"{target_alpha:.4f}, so the test must be able to reach that p.")
        while n <= ns.max_n:
            ba = best_alpha(n, n, target_alpha)
            if not ba:
                skipped.append(n)
                n += 1
                continue
            if testable is None:
                testable = n
            pe, se = power_exact(n, n, dval, ba[0], sims=ns.sims)
            if pe >= ns.power:
                break
            n += 1
        if skipped:
            print(f"  skipped n={skipped}: no one-sided alpha <= {target_alpha:.4f} is achievable at "
                  f"that n (the U statistic cannot produce a small enough p).")
        if pe < ns.power:
            print(f"needs > {ns.max_n} per side for {int(ns.power*100)}% exact power at d={dval:.2f}")
            print(f"with alpha/K = {target_alpha:.4f} reachable.")
            print(f"VERDICT: not testable in a config pass at K = {K}. Options: cut the")
            print("noise floor (a quieter host raises d and cuts n quadratically), shrink the")
            print("pre-registered confirm set (fewer levers -> a looser alpha/K -> smaller n),")
            print("or accept that this lever is screened, not confirmed.")
            return
        ap = power(n, n, dval, ba[0])
        print(f"runs per side for {int(ns.power * 100)}% EXACT power: {n}"
              + (f"  (raised from {n0}: the nominal-alpha formula under-sizes small-n tests)"
                 if n > n0 else ""))
        print(f"  n={n}+{n}: reject at U >= {ba[0]}/{n * n}, exact alpha = {ba[1]:.4f}"
              + (f" (<= alpha/K {target_alpha:.4f}, so Holm across K={K} can fire)"
                 if K > 1 else ""))
        print(f"  EXACT power at d={dval:.2f}: {100 * pe:.1f}% +/-{100 * se:.1f}"
              f"   (normal-approx lower bound {100 * ap:.1f}%)")
        print(f"VERDICT: run {n} candidate + {n} control runs ({2 * n} runs for this lever).")
        print(f"Log n, the exact alpha and the exact power in PLAN.md. Alpha {ba[1]:.4f} is the")
        print(f"largest this n can reach"
              + (f", and it must be <= alpha/K = {target_alpha:.4f} for Holm across K = "
                 f"{K} to fire." if K > 1 else " for this n."))

    elif ns.cmd == "accept":
        u, p, total = mwu_one_sided(ns.cand, ns.ctl)
        n1, n2 = len(ns.cand), len(ns.ctl)
        ba = best_alpha(n1, n2, ns.alpha)
        mc, mk = statistics.median(ns.cand), statistics.median(ns.ctl)
        print(f"n_cand = {n1}, n_ctl = {n2}, U = {u}/{n1 * n2}, exact p = {p:.4f}")
        print(f"median cand {mc:.3f} vs ctl {mk:.3f} -> {100 * (mc - mk) / mk:+.1f}%")
        if ba:
            print(f"largest achievable alpha <= {ns.alpha} at this n: {ba[1]:.4f} (needs U >= {ba[0]})")
        beats = all(c > mk for c in ns.cand)
        sig = p <= ns.alpha
        print(f"criteria (both required):")
        print(f"  1. exact p {p:.4f} <= alpha {ns.alpha}: {sig}")
        print(f"  2. median cand {mc:.3f} > median ctl {mk:.3f}: {mc > mk}")
        print(f"diagnostic only, NOT a criterion: every candidate sample beats the control median: "
              f"{beats}")
        print(f"  (Mann-Whitney does not require this; 'no' with a significant p is a wide candidate "
              f"spread, re-read the raw samples)")
        verdict = "ACCEPT" if (sig and mc > mk) else "REJECT"
        print(f"VERDICT: {verdict} — this lever, uncorrected, at alpha {ns.alpha}")
        print(f"  This is the per-lever gate only. It is NOT the confirm stage's verdict: with a")
        print(f"  pre-registered confirm set of K levers, Holm's first threshold is alpha/K, so a lever")
        print(f"  accepted here can still be refused by `holm --mode confirm` (at K = 6, p must be")
        print(f"  <= 0.0083 to enter the chain). Run the Holm step before you call anything accepted.")
        if verdict == "ACCEPT":
            print(f"Then: 1) Holm across the secondary metrics of THIS lever (`holm`).")
            K = ns.confirm_set if ns.confirm_set is not None else 6
            kwhat = (f"K = {K} levers" if ns.confirm_set is not None
                     else "K = 6 levers ASSUMED - you did not pass --confirm-set, so this is not your K")
            print(f"      2) Holm across the PRIMARY p-values of the whole pre-registered confirm")
            print(f"         set (`holm --mode confirm`): {100 * famwise(K, ns.alpha):.0f}%"
                  f" FWER uncorrected at {kwhat}.")
            print(f"      3) Run the stability gates. Accept only if all three pass.")

    elif ns.cmd == "holm":
        pairs = []
        for s in ns.pairs:
            k, _, v = s.partition("=")
            try:
                pv = float(v)
            except ValueError:
                sys.exit(f"holm: {k}: p-value {v!r} is not a number")
            if pv != pv or not (0.0 <= pv <= 1.0):
                why = ("a NaN kills every later comparison silently (NaN <= threshold is False, so "
                       "the chain reports every lever as ok)" if pv != pv
                       else "a negative p is not a p-value and reads as significant")
                sys.exit(f"holm: {k}: p-value must be in [0, 1], got {v!r} - {why}.")
            pairs.append((k, pv))
        label = {"secondary": "REGRESSION", "confirm": "REAL EFFECT"}[ns.mode]
        what = "secondary metrics of one lever" if ns.mode == "secondary" else "primary p-values of the confirm set"
        print(f"k = {len(pairs)} {what}, family-wise FWER at alpha {ns.alpha}"
              f" uncorrected = {100 * famwise(len(pairs), ns.alpha):.1f}%")
        for name, p, reject, thr in holm_bonferroni(pairs, ns.alpha):
            print(f"  {name:<16} p = {p:.4f}  threshold {thr:.4f}  {label if reject else 'ok'}")
        if ns.mode == "confirm":
            print("  (Holm step-down: reject the smallest p first; the first non-rejection stops the chain,")
            print("   so a lever with a larger p than a rejected neighbour is NOT accepted even if its own")
            print("   p is below 0.05.)")

    elif ns.cmd == "bootstrap":
        if len(ns.a) < 20 or len(ns.b) < 20:
            print(f"WARNING: {len(ns.a)} and {len(ns.b)} samples. A bootstrap CI of a median ratio")
            print(f"is not trustworthy below ~20 per side. Use `accept` (Mann-Whitney) instead.")
        lo, hi, med = bootstrap_ratio_ci(ns.a, ns.b, ns.iters)
        print(f"median(b)/median(a) = {med:.4f}, 95% CI [{lo:.4f}, {hi:.4f}]")
        print(f"VERDICT: {'B is faster' if lo > 1.0 else 'not proven faster'} (CI above 1.0)")

    elif ns.cmd == "outlen":
        ctl, cand = ns.ctl, ns.cand
        if len(ctl) != len(cand):
            sys.exit(f"outlen: {len(ctl)} control medians vs {len(cand)} candidate medians. Pair them by "
                     f"prompt, same panel and same order.")
        thr = ns.threshold
        print(f"  {'prompt':>7} {'ctl tok':>8} {'cand tok':>9} {'change':>9}")
        n_short = n_long = 0
        downs = ups = 0
        for i, (a, b) in enumerate(zip(ctl, cand)):
            ch = 0.0 if a == 0 else 100 * (b - a) / a
            mark = ""
            if a > 0 and abs(ch) > thr:
                mark = "  <-- SHORTENED" if ch < 0 else "  <-- LENGTHENED"
                if ch < 0:
                    n_short += 1
                else:
                    n_long += 1
            if ch < -0.5:
                downs += 1
            elif ch > 0.5:
                ups += 1
            print(f"  {i:>7} {a:>8.0f} {b:>9.0f} {ch:>+8.1f}%{mark}")
        ma, mb = statistics.median(ctl), statistics.median(cand)
        overall = 0.0 if ma == 0 else 100 * (mb - ma) / ma
        print(f"  overall median {ma:.0f} -> {mb:.0f}  ({overall:+.1f}%)")
        # Uniform-shift check: a lever that scales EVERY answer by the same factor has per-prompt spread
        # exactly 0%, and a 15% uniform shortening sits UNDER a 20% per-prompt threshold - so the direction
        # counts must be taken on their own, not from the threshold-gated flags (that was the first version
        # of this check, and it flagged nothing). Same direction on every prompt plus a small overall move
        # is the signature; the threshold for it is much tighter than the per-prompt one, because coherence
        # is the evidence, not magnitude.
        uniform = (downs == len(ctl) or ups == len(ctl)) and abs(overall) >= ns.uniform
        if uniform:
            print(f"  UNIFORM SHIFT: all {len(ctl)} prompts moved {'down' if downs == len(ctl) else 'up'}, "
                  f"overall {overall:+.1f}% (>= {ns.uniform:.0f}%)")
        if abs(overall) > thr or n_short or n_long or uniform:
            print(f"VERDICT: output length moved past the label threshold "
                  f"({n_short} shortened, {n_long} lengthened"
                  + (", uniform shift" if uniform else "") + f"). The speed delta is NOT a free win.")
            print("  Label the lever a lossy trade in the report and name the mechanism (speculative decoding")
            print("  changes accepted length as its mechanism; a quantization that makes answers blander is a")
            print("  different task, not a faster one). Get the user's call before it enters best-config.json,")
            print("  and keep it out of the published recipe unless they accept the trade.")
            print("  A per-prompt spread of 0% and coverage of 100% do NOT mean length is stable: a lever that")
            print("  scales every answer by the same factor has spread exactly 0%. This comparison is the gate.")
        else:
            print(f"VERDICT: output length held within {thr:.0f}% on every prompt and overall. Length is not"
                  f" the mechanism of the speed delta.")

    elif ns.cmd == "power":
        s = sigma_from_mad(ns.mad)
        ba = best_alpha(ns.n1, ns.n2, 0.05)
        if not ba:
            sys.exit(f"n={ns.n1}+{ns.n2} cannot reach alpha 0.05")
        print(f"n1={ns.n1} n_ctl={ns.n2}: reject at U >= {ba[0]}/{ns.n1 * ns.n2},"
              f" exact alpha = {ba[1]:.4f}; sigma = {s:.3f} ({100 * s / ns.current:.1f}%)")
        print("  gain%   d      EXACT power   approx   runs/side for 80% (exact)")
        for g in ns.gains:
            dval = (g / 100 * ns.current) / s
            pe, se = power_exact(ns.n1, ns.n2, dval, ba[0], sims=ns.sims)
            need, n = None, max(ns.n1, required_n(dval))
            while n <= 25:
                b = best_alpha(n, n, 0.05)
                if b and power_exact(n, n, dval, b[0], sims=2000)[0] >= 0.8:
                    need = n
                    break
                n += 1
            print(f"  {g:>5}%  {dval:>5.2f}  {100 * pe:>6.1f}% +/-{100 * se:.1f}"
                  f"  {100 * power(ns.n1, ns.n2, dval, ba[0]):>5.0f}%"
                  f"          {need if need else '>25 (defer)'}")


if __name__ == "__main__":
    main()
