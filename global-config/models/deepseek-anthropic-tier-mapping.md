# DeepSeek V4 ↔ Anthropic Tier Mapping

Research date: 2026-08-22.

Reference doc for routing plugin agents that use Anthropic tier names (`haiku`, `sonnet`, `opus`, `fable`) against a DeepSeek-only fleet.

## Sources

| Source | Provides | Fetched |
|--------|----------|---------|
| [DeepSeek API pricing](https://api-docs.deepseek.com/quick_start/pricing) | V4 specs, pricing, peak/off-peak | 2026-08-22 |
| [DeepSeek V4-Pro HuggingFace card](https://huggingface.co/deepseek-ai/DeepSeek-V4-Pro) | V4-Pro / V4-Flash benchmark matrix vs frontier | 2026-08-22 |
| [Anthropic pricing](https://www.anthropic.com/pricing) | Tier pricing | 2026-08-22 |
| [Haiku 4.5 announcement](https://www.anthropic.com/news/claude-haiku-4-5) | Haiku 4.5 benchmarks | 2026-08-22 |
| [Sonnet 5 page](https://www.anthropic.com/claude/sonnet) | Sonnet 5 benchmarks | 2026-08-22 |
| [DeepSeek Vision guide](https://api-docs.deepseek.com/guides/vision) | Vision support, formats, limits | 2026-08-22 |
| [Anthropic models overview](https://platform.claude.com/docs/en/about-claude/models/overview) | Claude vision capabilities per tier | 2026-08-22 |

## Specs & pricing

| Anthropic tier | Model | Context | Input $/MTok | Output $/MTok | DeepSeek equivalent | Context | Input $/MTok | Output $/MTok |
|----------------|-------|---------|--------------|---------------|---------------------|---------|--------------|---------------|
| Fable | Fable 5 | 200k consumer / 500k enterprise | 10.00 | 50.00 | none | — | — | — |
| Opus | Opus 5 | 200k consumer / 500k enterprise | 5.00 | 25.00 | V4-Pro max | 1M | 0.66 | 1.98 |
| Sonnet | Sonnet 5 | 1M (product page); 200k/500k consumer/Team | 2.00 | 10.00 | V4-Flash high/max | 1M | 0.22 | 0.66 |
| Haiku | Haiku 4.5 | 200k consumer / 500k enterprise | 1.00 | 5.00 | V4-Flash non-think | 1M | 0.22 | 0.66 |

DeepSeek prices are cache-miss off-peak; peak is 2×. Cache-hit input is ~30× cheaper.

**Note:** Fable 5 is Anthropic's most expensive tier, not a cheap one. Any prior "Fable = 0.25×" figure is wrong; Fable 5 is 10× Haiku on price.

## Vision

| Anthropic tier | Model | Vision support | DeepSeek equivalent | Vision support |
|----------------|-------|----------------|---------------------|----------------|
| Fable | Fable 5 | Yes | none | — |
| Opus | Opus 5 | Yes | none | — |
| Sonnet | Sonnet 5 | Yes | `deepseek-v4-flash-vision-exp` | Yes |
| Haiku | Haiku 4.5 | Yes | `deepseek-v4-flash-vision-exp` | Yes |

Key facts:

- DeepSeek restricts image input to the `deepseek-v4-flash-vision-exp` model. The docs explicitly state that other models return a `400` error with message "This model does not support image".
- `deepseek-v4-flash-vision-exp` is priced identically to `deepseek-v4-flash` and supports both non-thinking and thinking modes.
- Anthropic's current model overview says every current Claude model supports text and image input, text output, multilingual capabilities, and vision. So Haiku 4.5, Sonnet 5, Opus 5, and Fable 5 all accept images natively.

Routing implications:

- Agents routed from Anthropic tiers to DeepSeek that need image understanding must target `deepseek-v4-flash-vision-exp`, not the base `deepseek-v4-flash` or `deepseek-v4-pro`.
- There is no DeepSeek Pro vision model, so Opus/Fable tasks that combine images with frontier reasoning have no direct equivalent in the DeepSeek fleet.
- For vision-only or vision+tool-use work at Sonnet/Haiku quality, `deepseek-v4-flash-vision-exp` (high/max thinking) is the only available substitute.

## Benchmark comparison

| Benchmark | Haiku 4.5 | Sonnet 4.5 | Sonnet 5 | Flash Max | Pro Max | Opus-4.6 Max |
|-----------|-----------|------------|----------|-----------|---------|--------------|
| SWE-bench Verified | 73.3 | 77.2 | — | 79.0 | 80.6 | 80.8 |
| SWE-bench Pro | — | — | 63.2 | — | 55.4 | 57.3 |
| Terminal-Bench | 41.0 | 50.0 | 80.4* | 56.9 | 67.9 | 65.4 |
| GPQA Diamond | 73.0 | 83.4 | — | 88.1 | 90.1 | 91.3 |
| HLE no tools | — | — | 43.2 | 34.8 | 37.7 | 40.0 |
| HLE with tools | — | — | 57.4 | 45.1 | 48.2 | 53.1 |
| MRCR 1M | — | — | — | 78.7 | 83.5 | 92.9 |
| CorpusQA 1M | — | — | — | 60.5 | 62.0 | 71.7 |
| LiveCodeBench | — | — | — | 91.6 | 93.5 | 88.8 |

\* Sonnet 5 Terminal-Bench 2.1 may differ from the version reported for Haiku/Sonnet 4.5.

## Tier mapping

| Anthropic tier | DeepSeek mapping | Confidence | Rationale |
|----------------|------------------|------------|-----------|
| Haiku | `deepseek-v4-flash` non-think | Medium | Fast and cheap. But Haiku 4.5 is a *thinking* model (128K thinking budget); flash non-think is reasoning-disabled and collapses on reasoning tasks. Use only for latency-critical mechanical work. |
| Sonnet | `deepseek-v4-flash` high/max | High | Flash high/max matches or beats Sonnet 4.5 on SWE Verified (79.0 vs 77.2) and GPQA Diamond (88.1 vs 83.4). Sonnet 5 is stronger on HLE no-tools (43.2 vs 34.8), so flash max maps to lower-Sonnet through mid-Sonnet depending on task. |
| Opus | `deepseek-v4-pro` max | High | Pro max is competitive with Opus-4.6 on SWE Verified (80.6 vs 80.8) and Terminal Bench (67.9 vs 65.4), and closes flash's long-context gap. Still below Opus on hardest long-context / frontier reasoning. |
| Fable | `deepseek-v4-pro` max (best available) | Low | No DeepSeek equivalent. Fable 5 is priced above Opus; pro max is the fleet ceiling but not a true Fable peer. |

## Task-conditional "Opus split"

Opus-level work should not map to a single DeepSeek model. Split by task profile:

| Task type | Route to | Why |
|-----------|----------|-----|
| Coding, debugging, refactoring, tool use, agentic execution | `deepseek-v4-flash` max | Flash max ≈ Opus on SWE Verified / LiveCodeBench at 1/3 the price. |
| Long-context retrieval, hardest frontier reasoning, formal planning | `deepseek-v4-pro` max | Pro closes the MRCR / CorpusQA / HLE gap that flash cannot. |

## Caveats

1. **Benchmark version drift.** Anthropic and DeepSeek report overlapping but not identical benchmark versions; numbers are approximate.
2. **Thinking mode dominates.** DeepSeek non-think → high → max is often a larger jump than Anthropic tier-to-tier. Always specify effort.
3. **Context length.** DeepSeek V4 gives 1M context on both flash and pro; Anthropic consumer tiers are mostly 200k (Sonnet 5 page claims 1M). This favors DeepSeek for long-context work.
4. **Prices change.** Mapping is dated 2026-08-22. Recheck sources before cost-sensitive routing.

## Revision history

| Date | Change |
|------|--------|
| 2026-08-22 | Initial mapping. |

## See also

- `../../tier-router/skill-axis-mapping.json` — where task axes are mapped to concrete models.
