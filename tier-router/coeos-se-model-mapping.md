# CoeOS SE TMB Skill-Axis → Available Fleet Mapping

Source: TMB Settings (2026-07-22), 18 skill axes, 30+ models benchmarked across 5 bench suites.
Benchmarks: https://themonoclebear.com/en/blog/coeos-divide-and-route/ | https://github.com/Odyssai-eu/coeos-SE/tree/main/coeos_se
Fleet: deepseek-v4-pro, deepseek-v4-flash, kimi-k3, kimi-k2.7-code, kimi-k2.6.

| Axis | TMB king (score) | Your best in fleet | Notes |
|---|---|---|---|
| creative | kimi-k3 (97.8) | kimi-k3 | Direct match |
| redac_pro | deepseek-v4-pro (100.0) | deepseek-v4-pro | Direct match |
| legal_rgpd | kimi-k3 (100.0) | kimi-k3 | Direct match |
| legal_complex | ring2.6 (99.0) | kimi-k3 | No ring2.6; best available |
| reasoning | deepseek-v4-pro (100.0) | deepseek-v4-pro | Direct match |
| calc | deepseek-v4-pro (100.0) | deepseek-v4-pro | Direct match |
| python | kimi-k3 (97.8) | kimi-k3 | k2.7-code is coding-specialized; K3 owns Python |
| code_general | kimi-k3 (97.9) | kimi-k3 | ditto |
| debug | deepseek-v4-pro (100.0) | deepseek-v4-pro | Direct match |
| react | deepseek-v4-pro (98.0) | deepseek-v4-pro | Direct match |
| swift | kimi-k3 (99.0) | kimi-k3 | Direct match |
| refactoring | minimax3 (100.0) | deepseek-v4-pro | No refactoring specialist in fleet |
| plan_decompo | kimi-k2.7-code (100.0) | kimi-k2.7-code | Direct match |
| plan_spec | o3 (100.0) | deepseek-v4-pro | No o3-equivalent in fleet |
| plan_judgment | kimi-k3 (100.0) | kimi-k3 | Direct match |
| fast_tools | mercury-2 (unverified) | deepseek-v4-flash | mercury-2 unverified; flash for speed |
| agent_exec | kimi-k2.6 (100.0) | kimi-k2.6 | Direct match |
| agent_safety | mistral-l3 (100.0) | deepseek-v4-pro | No safety specialist in fleet |

## Coverage

- 12/18 axes: direct top-scorer in fleet
- 6/18 axes: best-available generalist serves
- Gaps: legal_complex (ring2.6), refactoring (minimax3), plan_spec (o3), agent_safety (mistral-l3)
