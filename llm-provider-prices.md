# LLM Provider Prices — Kimi Code, Z.ai GLM Coding Plan, DeepSeek API

**Verified: 2026-09-17** (Europe/Brussels). Prices are snapshots from the live storefronts/docs listed in Sources; they change frequently — re-check before purchase decisions.

---

## 1. Kimi for Coding (Kimi Code — membership, not the Open Platform API)

Kimi Code is bundled with the Kimi membership. Desktop/CLI/VS Code or API key on `https://api.kimi.com/coding/v1` (OpenAI) / `https://api.kimi.com/coding/` (Anthropic). One shared credit pool across all Kimi features; Kimi Code additionally has a weekly quota + rolling 5-hour rate window. Unused quota does not roll over.

### Membership tiers — global storefront (USD)

| Tier | Monthly | Annual (per mo) | Annual total |
|---|---|---|---|
| Adagio (free) | $0 | — | — |
| Moderato | $19 | $15 | $180/yr |
| Allegretto | $39 | $31 | $372/yr |
| Allegro | $99 | $79 | $948/yr |
| Vivace | $199 | $159 | $1,908/yr |

- China (CNY) tiers: Andante ¥49, Moderato ¥99, Allegretto ¥199, Allegro ¥699 per month.
- Global page showed a "new membership plans coming soon" waitlist banner for these tiers on the check date.

### Models (model IDs) and quota cost

| Model ID | Model | Context | Availability | Quota cost |
|---|---|---|---|---|
| `k3` | K3 (2.8T) | up to 1M | Moderato+; 1M ctx on Allegretto+ | **2×** vs `k3-256k` |
| `k3-256k` | K3 256K | 256K | Moderato+ | 1× (baseline) |
| `kimi-for-coding` | K2.8 Preview | up to 1M | All members | 1× |
| `kimi-for-coding-highspeed` | K2.7 Code HighSpeed | 256K | Allegretto+ | **3×** quota, ~6× output speed |

### Credit ↔ token rate

Kimi does **not** publish an official credit↔token conversion (pool is shown as %). Community-measured estimates (Jul 2026, unofficial — expect drift):

| Tier (CN) | ~5h window | ~weekly | ~monthly |
|---|---|---|---|
| Andante ¥49 | 10M tok | 50M | ~238M |
| Moderato ¥99 | 20M | 100M | ~475M |
| Allegretto ¥199 | 40M | 200M | ~950M |
| Allegro ¥699 | 100M | 500M | ~2,375M |

→ blended ≈ **¥0.21 (~$0.03) per 1M tokens** at Allegretto (at ~94% cache hit, 14:1 in:out; API-equivalent ≈ ¥3,858/mo ≈ 19–24× the sub price).

### Extra Usage / Open Platform API fallback rates (USD per 1M tokens)

| Model | Input (cache hit) | Input (miss) | Output |
|---|---|---|---|
| kimi-k3 | $0.30 | $3.00 | $15.00 |
| kimi-k2.7-code | $0.19 | $0.95 | $4.00 |
| kimi-k2.7-code-highspeed | $0.38 | $1.90 | $8.00 |
| kimi-k2.6 | $0.16 | $0.95 | $4.00 |

CN API: K3 ¥2 / ¥20 / ¥100; K2.7 Code ¥1.30 / ¥6.50 / ¥27 (hit / miss / out).

---

## 2. Z.ai GLM Coding Plan (subscription, not the pay-as-you-go API)

Restricted to officially supported coding tools (Claude Code, OpenCode, Cline, Cursor, ZCode, …); quota shared across tools. Endpoints: Anthropic `https://api.z.ai/api/anthropic`, OpenAI `https://api.z.ai/api/coding/paas/v4`, Responses `https://api.z.ai/api/v1`.

### Tiers (Individual, monthly — live storefront 2026-09-17)

| Tier | Monthly | Promo price | Credits / 5h | Credits / week |
|---|---|---|---|---|
| Lite | $18 | $12.60 | 2,000 | 10,000 |
| Pro | $80 | $56 | 12,000 | 60,000 |
| Max | $168 | $117.60 | 28,000 | 140,000 |

- Billing discounts: quarterly −20%, yearly −30%.
- Team plan: Standard seat 15,000 / 66,000; Premium seat 35,000 / 155,000 (5h / week).

### Models

- GLM-5.3 and GLM-5.3-Flash (all tiers).
- Aliases: `glm-5.2` / `glm-5.1` → routed to GLM-5.3; `glm-4.7` → routed to GLM-5.3-Flash.

### Credit ↔ token rate (official)

`credits = (input×m + cached_input×m + output×m) / 10,000` → **1M tokens = multiplier × 100 credits**

| Per 1M tokens | GLM-5.3 | GLM-5.3-Flash |
|---|---|---|
| Uncached input (×6.9 / ×2.3) | **690 credits** | 230 |
| Cached input (×1.7 / ×0.56) | **170** | 56 |
| Output (×24 / ×8) | **2,400** | 800 |
| Off-peak (50% rate) | 345 / 85 / 1,200 | 115 / 28 / 400 |

- MCP tools (Web Search / Web Reader / Zread): 1.2 credits per call.
- **Peak: Mon–Fri 14:00–18:00 SGT (UTC+8); all other hours off-peak at 50% credit rate.**

### Effective $/1M tokens (if weekly quota fully consumed), peak / off-peak

| | Lite | Pro | Max |
|---|---|---|---|
| 5.3 output | $4.32 / $2.16 | $3.20 / $1.60 | $2.88 / $1.44 |
| 5.3 input (cache miss) | $1.24 / $0.62 | $0.92 / $0.46 | $0.83 / $0.41 |
| 5.3 input (cache hit) | $0.31 / $0.15 | $0.23 / $0.11 | $0.20 / $0.10 |
| Flash output | $1.44 / $0.72 | $1.07 / $0.53 | $0.96 / $0.48 |

Annual/promo billing (−30%) lowers these further (e.g. 5.3 output → $3.02 / $2.24 / $2.02 per 1M peak).

Official weekly token allowance @95% cache hit (min = all peak, max = all off-peak):
GLM-5.3: 48–97M (Lite), 290–580M (Pro), 676–1,352M (Max). GLM-5.3-Flash: 146–292M / 877–1,755M / 2,047–4,095M.

---

## 3. DeepSeek API (pay-as-you-go, no subscription)

Base URLs: `https://api.deepseek.com` (OpenAI format), `https://api.deepseek.com/anthropic` (Anthropic format). Context 1M, max output 384K.

### Models & pricing (USD per 1M tokens)

| Model | Cache-hit input | Cache-miss input | Output |
|---|---|---|---|
| **deepseek-flash** (V4.1-Flash) off-peak | $0.003 | $0.15 | $0.60 |
| deepseek-flash peak | $0.006 | $0.30 | $1.20 |
| **deepseek-v4-pro** (V4-Pro-0813) off-peak | $0.022 | $0.66 | $1.98 |
| deepseek-v4-pro peak | $0.044 | $1.32 | $3.96 |

- Peak hours: **01:00–04:00 and 06:00–10:00 UTC, Mon–Fri**; all other hours off-peak at 50% of peak. (At check time, 00:32 UTC Thu → off-peak.)
- Concurrency: flash 2,500; v4-pro 500.
- `deepseek-v4-pro` service confirmed to continue after 2026-09-14, billing unchanged.
- Legacy names `deepseek-v4-flash` / `deepseek-v4-flash-vision-exp` still accepted, served by V4.1-Flash at Flash pricing.
- Features (both): JSON output, tool calls, Responses API, Anthropic API, prefix completion; FIM (non-thinking only); vision on flash only.

---

## Quick strategy notes

- Bulk / mechanical work → **GLM-5.3-Flash off-peak** (~$0.48–0.72 /1M output on sub).
- Heavy agentic coding → **GLM-5.3 off-peak** (~$1.44–1.60 /1M output on sub).
- 1M-context long-horizon tasks → **Kimi `k3-256k`** (halves quota vs `k3`); avoid highspeed (3× quota) unless latency-bound.
- Cheap unthrottled API fallback → **deepseek-flash** ($0.60/1M output off-peak).

## Sources

- DeepSeek: https://api-docs.deepseek.com/quick_start/pricing
- Z.ai: https://z.ai/subscribe (live-rendered storefront), https://docs.z.ai/devpack/overview, https://docs.z.ai/devpack/teamplan
- Kimi: https://www.kimi.com/membership/pricing (live-rendered), https://www.kimi.com/code/docs/en/kimi-code/{membership,models}.html, https://www.kimi.com/en/help/membership/membership-pricing, https://platform.kimi.ai/docs/pricing/chat
- Community token estimates (Kimi): china-ai-arbitrage.xyz (2026-07-17), nothamor.com (2026-04-22) — unofficial.
