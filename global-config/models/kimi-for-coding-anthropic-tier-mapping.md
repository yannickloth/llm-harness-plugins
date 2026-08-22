# Kimi For Coding ↔ Anthropic Tier Mapping

Research date: 2026-08-22.

Reference doc for routing plugin agents that use Anthropic tier names (`haiku`, `sonnet`, `opus`, `fable`) against a Kimi For Coding subscription fleet.

## Sources

| Source | Provides | Fetched |
|--------|----------|---------|
| [Kimi For Coding — Subscription Model IDs](global-config/rules/kimi-subscription-models.md) | Model IDs, tier gating, context limits | 2026-08-22 |
| [Kimi membership pricing (intl)](https://www.kimi.ai/help/membership/membership-pricing) | Moderato/Allegretto/Allegro/Vivace pricing and credits | 2026-08-22 |
| [Kimi K3 blog](https://www.kimi.com/en/blog/kimi-k3) | K3 specs, capabilities, benchmark footnotes | 2026-08-22 |
| [Kimi K3 quickstart](https://platform.kimi.ai/docs/guide/kimi-k3-quickstart) | API context, reasoning effort, vision input | 2026-08-22 |
| [Kimi K2.7 Code quickstart](https://platform.kimi.ai/docs/guide/kimi-k2-7-code-quickstart) | K2.7 Code specs, vision, high-speed variant | 2026-08-22 |
| [Kimi K3 pricing](https://platform.kimi.ai/docs/pricing/chat-k3) | K3 token pricing | 2026-08-22 |
| [Kimi K2.7 Code pricing](https://platform.kimi.ai/docs/pricing/chat-k27-code) | K2.7 Code token pricing | 2026-08-22 |
| [Anthropic models overview](https://platform.claude.com/docs/en/about-claude/models/overview) | Anthropic tier context/pricing/vision | 2026-08-22 |
| [Emergent.sh K3 benchmarks](https://emergent.sh/learn/kimi-k3-benchmark) | Independent and vendor-reported K3 scores | 2026-08-22 |
| [evals.report K3](https://evals.report/models/moonshot-kimi-k3) | Verified K3 benchmark scores | 2026-08-22 |

## Specs & pricing

| Anthropic tier | Model | Context | Input $/MTok | Output $/MTok | Kimi For Coding equivalent | Subscription tier | Context | Input $/MTok | Output $/MTok |
|----------------|-------|---------|--------------|---------------|----------------------------|-------------------|---------|--------------|---------------|
| Fable | Fable 5 | 1M | 10.00 | 50.00 | none / `k3` max best available | Allegretto+ (1M) | 1M | 3.00 | 15.00 |
| Opus | Opus 5 | 1M | 5.00 | 25.00 | `k3` max | Moderato+ (Allegretto+ for 1M) | 1M | 3.00 | 15.00 |
| Sonnet | Sonnet 5 | 1M | 2.00 | 10.00 | `k3` high / `kimi-for-coding` | Moderato+ / all members | 256K–1M | 0.95–3.00 | 4.00–15.00 |
| Haiku | Haiku 4.5 | 200k | 1.00 | 5.00 | `kimi-for-coding` (K2.7 Code) | all members (Andante+ in China) | 256K | 0.95 | 4.00 |

Kimi input prices are cache-miss; cache-hit input is ~30× cheaper for K3 and ~5× cheaper for K2.7 Code. The subscription itself bills a flat monthly fee plus a shared credit pool, not per token; the token prices above are the API-equivalent pay-as-you-go rates for capability comparison.

**Note:** International membership starts at Moderato ($19/mo). The Chinese domestic site also lists an Andante tier (¥49/mo) with only `kimi-for-coding`.

## Subscription tier quick reference

| Tier | Monthly (intl) | Models unlocked | K3 context | Agent credits (approx) | Concurrent tasks | Notable extras |
|------|----------------|-----------------|------------|------------------------|------------------|----------------|
| Moderato | $19 | `k3`, `k3-256k`, `kimi-for-coding` | 256K | 60 | 2 | — |
| Allegretto | $39 | all four | up to 1M | 150 | 2 | K3 1M, highspeed, Goal Mode, Kimi Claw |
| Allegro | $99 | all four | up to 1M | 360 | 4 | more Swarm, projects, storage |
| Vivace | $199 | all four | up to 1M | 720 | 4 | highest credits |

## Benchmark comparison

| Benchmark | Haiku 4.5 | Sonnet 5 | Opus 5 | Fable 5 | K3 (max) | Notes |
|-----------|-----------|----------|--------|---------|----------|-------|
| SWE-bench Verified | 73.3 | — | — | — | — | Anthropic simple scaffold; K3 not reported on this version |
| SWE-bench Pro | — | 63.2 | — | — | — | |
| Terminal-Bench 2.1 | 41.0 | 80.4* | 65.4 | — | 88.3 | K3 via Kimi Code harness; Anthropic via Terminus 2 / Opus-4.6 Max |
| GPQA Diamond | 73.0 | — | — | — | 94.0 | K3 independent (Artificial Analysis) |
| HLE no tools | — | 43.2 | — | — | 43.5 | K3 slightly ahead of Sonnet 5; Fable 5 higher |
| HLE with tools | — | 57.4 | — | — | 56.0 | |
| FrontierSWE | — | — | — | — | 81.2 | K3 vendor-reported |
| DeepSWE | — | — | — | — | 67.5 | K3 verified |
| SWE Marathon | — | — | — | — | 42.0 | K3 via Claude Code harness |
| BrowseComp | — | — | — | — | 91.2 | K3 context compaction at 300K |
| AA-Briefcase Elo | — | 1,388 | 1,354 | 1,583 | 1,548 | K3 second only to Fable 5 |
| AA-LCR (long context) | — | — | — | — | 74.7 | K3 leads independent long-context eval |

\* Sonnet 5 Terminal-Bench 2.1 may differ from the version reported for Haiku/Sonnet 4.5.

## Tier mapping

| Anthropic tier | Kimi For Coding mapping | Confidence | Rationale |
|----------------|-------------------------|------------|-----------|
| Haiku | `kimi-for-coding` (K2.7 Code) | Medium | Cheapest model in the fleet; near-frontier coding speed. Always reasons; thinking cannot be disabled. Use for latency-sensitive mechanical coding and sub-agent work. |
| Sonnet | `k3` high / `kimi-for-coding` | Medium-High | For general agentic/coding work, `k3` high matches Sonnet-class capability at lower cost. For high-volume, narrow coding loops, `kimi-for-coding` is faster and cheaper. |
| Opus | `k3` max | High | K3 max is competitive with Opus 5 on FrontierSWE, Terminal-Bench, and AA-Briefcase, and costs 40% less per token. It trails Fable 5 on the hardest frontier reasoning. |
| Fable | `k3` max (best available) | Low | No Kimi For Coding equivalent. K3 is the fleet ceiling; it beats Fable on some coding/agentic benchmarks but is behind overall. |

## Task-conditional routing

Sonnet/Opus-level work should not always map to a single Kimi model:

| Task type | Route to | Why |
|-----------|----------|-----|
| Long-horizon coding, debugging, multi-file refactor, agentic execution | `k3` max | Matches Opus-class solve rates on FrontierSWE / Terminal-Bench. |
| High-volume coding, quick fixes, inline completion, fast agent loops | `kimi-for-coding` or `kimi-for-coding-highspeed` | Cheaper and faster than K3; dedicated coding optimization. |
| Long-context retrieval, 1M-token analysis | `k3` max (Allegretto+) | Only K3 supports the full 1M context; K3 max closes the gap vs Opus/Fable on AA-LCR. |
| Vision + code (frontend, game dev, CAD) | `k3` max | K3 has native vision and strong vision-in-the-loop coding. K2.7 Code also accepts images/video. |

## Vision

| Anthropic tier | Model | Vision support | Kimi For Coding equivalent | Vision support |
|----------------|-------|----------------|----------------------------|----------------|
| Fable | Fable 5 | Yes | none / `k3` max best available | Yes |
| Opus | Opus 5 | Yes | `k3` max | Yes |
| Sonnet | Sonnet 5 | Yes | `k3` high / `kimi-for-coding` | Yes |
| Haiku | Haiku 4.5 | Yes | `kimi-for-coding` | Yes |

Key facts:

- All current Claude models support image input and vision (Anthropic models overview).
- `k3` and `k3-256k` support image and video input via base64-encoded content or `ms://<file-id>` references; public image URLs are not supported.
- `kimi-for-coding` (K2.7 Code) and `kimi-for-coding-highspeed` support image and video input; same base64/file-id constraint, no public URLs.
- `k3-256k` does not support video input (only `k3` does among K3 variants, per subscription model docs).

Routing implications:

- Any Anthropic-tier agent that needs image understanding can be mapped to a Kimi For Coding vision-capable model.
- For Opus/Fable vision tasks, `k3` max is the only substitute; there is no separate higher-tier vision model.
- For Sonnet/Haiku vision tasks, `kimi-for-coding` is the cost-efficient option; escalate to `k3` when reasoning quality matters more.

## Caveats

1. **Subscription vs. API pricing.** Kimi For Coding is a membership product with a shared credit pool and a 5-hour/week Kimi Code limit; the per-token prices above are the API-equivalent rates, not what a subscriber pays at checkout.
2. **Tier gating.** `k3` requires Moderato+; 1M-token K3 context requires Allegretto+. `kimi-for-coding-highspeed` requires Allegretto+. If routing ignores tier limits, requests will fail.
3. **Benchmark harness drift.** K3 coding scores are often reported with the Kimi Code harness; Anthropic scores use Terminus 2 or Claude Code. Cross-model numbers are approximate.
4. **K3 always thinks.** `k3` cannot disable reasoning; `reasoning_effort` can be set to `low`/`high`/`max` (default `max`). K2.7 Code also always thinks.
5. **Context length.** K3 gives up to 1M context on Allegretto+; Sonnet 5 and Opus 5 also advertise 1M. Haiku 4.5 is 200k.
6. **Prices and tiers change.** Mapping is dated 2026-08-22. Recheck Kimi help center before cost-sensitive routing.

## Revision history

| Date | Change |
|------|--------|
| 2026-08-22 | Initial mapping. |

## See also

- `global-config/rules/kimi-subscription-models.md` — authoritative model IDs and tier gating.
- `global-config/models/deepseek-anthropic-tier-mapping.md` — analogous mapping for DeepSeek.
- `tier-router/skill-axis-mapping.json` — where task axes are mapped to concrete models.
