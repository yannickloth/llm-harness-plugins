export const CALC_MARKER = "[calc-discipline]"

/**
 * Standing rule: numbers are computed, never recalled. Injected into every
 * session's system prompt by this plugin (v1 `experimental.chat.system.transform`,
 * v2 `ctx.session.hook("context")`), same mechanism as the STE-100 rule.
 *
 * Deliberately short — this text rides in the system prompt of every session.
 * The procedure detail lives in the `use-calculator` skill; the mechanics live
 * in the `calc` / `calc_probe` tools.
 */
export const CALC_RULE = `${CALC_MARKER}
Rule: Compute numbers with a calculator, never in your head. Your arithmetic is
generated text, not computation; fluent output is not evidence of correctness.

Compute externally — via the \`calc\` tool, or \`qalc\` in a shell — whenever a result involves:
- any multiplication, division, power, root, log, or trig on numbers with 2+ significant digits
- unit or currency conversion, timezone/date/duration arithmetic
- percentages, ratios, growth, averaging, variance, sampling, combinatorics
- token/byte/cost/count arithmetic over many items, price and quota math
- algebra, calculus, solving, series, matrices, distributions

Rules:
- ✗ Never state a specific number you have not computed in this session. ✗ Never present a mental estimate as a computed value.
- Cite provenance for load-bearing numbers: engine + expression (e.g. \`qalc "3.7 GB to MB"\`). The reader must be able to re-run it.
- Load-bearing number → cross-check with a second, independent method (different engine, or algebraic rearrangement). Report disagreement, do not average it away.
- Exact integers, unit counts, and values copied verbatim from tool output need no recomputation — read, do not re-derive.
- If the needed engine is missing: run \`calc_probe\`, then propose the install it returns and ask which to run. ✗ Do not silently fall back to mental arithmetic, and do not lower the precision of your answer to dodge the tool.
- Ranges beat false precision when inputs are estimates; state the input precision you actually have.

Available engines, pick by job: \`qalc\` (default — units, currency, stats, diff/solve/factor, dates, bases; **no integration**) · \`numbat\` (dimension-checked science) · \`bc -l\` (POSIX arithmetic in scripts) · \`python3\` (math/statistics/itertools) · \`sympy\` via uv (exact CAS) · \`maxima\` (CAS: integrate/solve/limit/sum/odes). Integration, limits and series go to maxima/sympy, never to qalc.
Call \`calc_probe\` once per session before relying on an engine; propose installs for anything MISSING.
Gate a qalc function name with \`qalc --list-functions <name>\`: an unknown name is read as a product of units, exits 0, and prints plausible unit-laden garbage — a result with units you did not ask for is a wrong name, not a number.`
