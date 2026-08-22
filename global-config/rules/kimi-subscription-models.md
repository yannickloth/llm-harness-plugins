<!-- Change Driver: IMPLEMENTATION_SPECS -->
<!-- Changes when: Kimi model IDs, tiers, auth, or provider config change -->
<!-- Lazy-loaded reference file — load on demand when choosing/validating a Kimi model ID, debugging "Model not found", or configuring Kimi For Coding in opencode. Not injected by default. -->

# Kimi For Coding — Subscription Model IDs

## Two products — do not conflate

| Product | Billing | Base URL | Notes |
| --- | --- | --- | --- |
| **Kimi Code Platform** (what we use) | Membership subscription | OpenAI `https://api.kimi.com/coding/v1`; Anthropic `https://api.kimi.com/coding/` | For terminal/IDE agent programming. Exposed in opencode as provider **Kimi For Coding**. |
| Kimi Platform (Moonshot API) | Pay-as-you-go top-up | `https://api.moonshot.cn/v1` | Product integration / enterprise. Has `kimi-k3`, `kimi-k2.7-code`, `kimi-k2.6`, etc. |

We use the **subscription** (Kimi Code Platform), not the pay-as-you-go API.

## Subscription model IDs (used in third-party tools / opencode)

These are the raw model IDs under the **Kimi For Coding** provider. They are NOT `provider/model` — use the bare ID string as the model.

| Model ID | Description | Tier |
| --- | --- | --- |
| `k3` | Kimi K3 flagship; up to 1M context (Allegretto+); thinking effort low/high/max | Moderato+ (1M: Allegretto+) |
| `k3-256k` | Kimi K3 256K context; same results within 256k; ~half the quota of `k3`; no video input | Moderato+ |
| `kimi-for-coding` | Kimi K2.7 Code; mature stable coding model; 256K | all members (Andante+) |
| `kimi-for-coding-highspeed` | K2.7 Code HighSpeed; ~5–6× faster; 256K | Allegretto+ |

### Tier → available models

| Tier | Models | Context |
| --- | --- | --- |
| Andante | `kimi-for-coding` | 256K |
| Moderato | `k3`, `k3-256k`, `kimi-for-coding` | 256K each |
| Allegretto+ | all four | K3 up to 1M; others 256K |

### Thinking effort for `k3`

OpenCode variant → actual effort: `Default`→`high`, `low`→`low`, `high`→`high`, `max`→`max`.
Kimi K2.7 Code series (`kimi-for-coding*`) does not use the effort setting.

## Correcting a past error

- WRONG: `kimi-for-coding/kimi-k2.7-code` (treated `kimi-for-coding` as a namespace prefix).
- RIGHT: the model ID is `kimi-for-coding` by itself (that IS the model, no prefix). For the fast variant use `kimi-for-coding-highspeed`.

## API-key / auth

- Create/manage keys in Kimi Code Console: `https://www.kimi.com/code/console` (up to 5 keys; each shown once).
- In opencode: `opencode auth login` → select **Kimi For Coding** → enter API key.
- `opencode auth login` also can run as `opencode auth login` then `/models` lists the four IDs above.

## Sources

- Kimi Code docs overview (model IDs + platform comparison): `https://www.kimi.com/code/docs/en/`
- Kimi Code in OpenCode guide: `https://www.kimi.com/code/docs/en/third-party-tools/opencode.html`
- Both fetched 12 Aug 2026.
