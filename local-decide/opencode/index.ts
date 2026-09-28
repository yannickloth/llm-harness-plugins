import { type Plugin, tool } from "@opencode-ai/plugin"
import { createLogger } from "../../shared/plugin-logger"

/**
 * Plugin exposing the `local_decide` tool: a bounded "System 1" choice backed
 * by **laya**, the local non-autoregressive decision engine.
 *
 * laya is reached over its `laya-mcp` streamable-HTTP endpoint (default
 * 127.0.0.1:8765/mcp). The endpoint is stateless: each call is a single JSON-RPC
 * `tools/call` for the `predict` tool (opencode surfaces it as `laya_predict`),
 * with the models GPU-resident in the service — no per-call model load.
 *
 * Use for BOUNDED, structured choices — routing, triage, classify,
 * escalate-or-not — when the decision is routine and the action space is small.
 * Do NOT use it for reasoning, code generation, or open-ended questions: laya
 * never generates text, it only returns a calibrated judgement.
 *
 * This plugin is currently DORMANT: `laya-mcp` is installed but not auto-started
 * (start it with `systemctl --user start laya-mcp`), so it is intentionally not
 * registered in any opencode config. Register
 * `./local-decide/opencode/index.ts` (or the absolute path) when laya is up.
 *
 * Read `confident` in the result:
 *   confident: true  -> trust `action`; it is a routine call (System 1).
 *   confident: false -> the distribution is spread; decide yourself or escalate.
 *
 * `confidence` is laya's own distribution concentration (1 - H/log k), computed
 * in the model — not a number either we or an LLM made up.
 *
 * Env overrides: `LOCAL_DECIDE_URL` (default http://127.0.0.1:8765/mcp),
 * `LOCAL_DECIDE_TIMEOUT_MS` (default 30000).
 */

const LAYA_URL = process.env.LOCAL_DECIDE_URL ?? "http://127.0.0.1:8765/mcp"
const REQUEST_TIMEOUT_MS = Number(process.env.LOCAL_DECIDE_TIMEOUT_MS ?? 30_000)

/** One JSON-RPC `tools/call` against the laya MCP endpoint. The server replies
 * as an SSE stream (`data: {json}`), stateless — no initialize/session needed. */
async function layaPredict(state: unknown, questions: Record<string, unknown>): Promise<any> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS)
  let body: string
  try {
    const res = await fetch(LAYA_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "predict", arguments: { state, questions } },
      }),
      signal: ctrl.signal,
    })
    body = await res.text()
  } finally {
    clearTimeout(timer)
  }

  // FastMCP streamable HTTP answers as SSE; take the last `data:` frame.
  const dataLines = body.split("\n").filter((l) => l.startsWith("data:"))
  const raw = dataLines.length ? dataLines[dataLines.length - 1].slice(5).trim() : body
  let payload: any
  try {
    payload = JSON.parse(raw)
  } catch {
    throw new Error(`unparseable laya response: ${raw.slice(0, 200)}`)
  }
  if (payload?.error) throw new Error(payload.error.message ?? JSON.stringify(payload.error))
  const result = payload?.result
  if (!result) throw new Error("laya response missing result")
  if (result.isError) throw new Error(result.content?.[0]?.text ?? "laya tool error")
  // Prefer typed structuredContent; fall back to the JSON text content.
  if (result.structuredContent?.result) return result.structuredContent.result
  const text = result.content?.[0]?.text
  if (typeof text === "string") return JSON.parse(text)
  throw new Error("laya response missing answers")
}

const plugin: Plugin = async ({ client }) => {
  const logger = createLogger(client, "local-decide")
  logger.info(`plugin active — bounded decisions via laya (${LAYA_URL})`)

  return {
    tool: {
      local_decide: tool({
        description:
          "Ask laya (the local System 1 decision engine) to make a bounded " +
          "decisional call: routing, triage, classification, or escalate-or-not. " +
          "Returns the chosen action plus laya's calibrated `confidence` and a " +
          "`confident` boolean. Use for routine bounded choices; treat " +
          "`confident: false` as a signal to decide yourself or escalate. Not for " +
          "reasoning, code, or open-ended questions.",
        args: {
          state: tool.schema
            .string()
            .describe(
              "The situation to decide on. Keep it SHORT (a sentence or two) - " +
                "laya truncates to its context window.",
            ),
          actions: tool.schema
            .array(tool.schema.string())
            .describe(
              "The allowed actions, e.g. ['escalate_human','retry_payload','ignore']. " +
                "laya picks exactly one of these.",
            ),
          threshold: tool.schema
            .number()
            .optional()
            .describe("Confidence needed for `confident: true`. Default 0.85."),
        },
        async execute(args) {
          const threshold = args.threshold ?? 0.85
          const actions = args.actions.filter((a) => a.trim()).map((a) => a.trim())
          if (actions.length === 0) {
            return JSON.stringify({ ok: false, error: "no actions given" })
          }

          const criteria: Record<string, string | null> = {}
          for (const a of actions) criteria[a] = null

          const started = Date.now()
          let result: any
          try {
            result = await layaPredict(args.state, {
              decision: {
                type: "choice",
                instructions: "Which single action should be taken next?",
                criteria,
              },
            })
          } catch (error: any) {
            return JSON.stringify({
              ok: false,
              error: `laya request failed: ${error?.message ?? error}`,
              hint: "Is laya-mcp running? systemctl --user start laya-mcp",
            })
          }

          const answer = result?.answers?.decision
          const action = typeof answer?.choice === "string" ? answer.choice : null
          if (!action) {
            return JSON.stringify({ ok: false, error: "laya returned no choice" })
          }

          const confidence = typeof answer?.confidence === "number" ? answer.confidence : null
          const out: Record<string, unknown> = {
            ok: true,
            action,
            probabilities: answer?.probabilities ?? null,
            confidence,
            confident: confidence !== null ? confidence >= threshold : false,
            threshold,
            model: result?.routing?.model ?? result?.model ?? null,
            latency_ms: Date.now() - started,
          }
          // laya also returns a learned act/escalate hint; surface it, don't gate on it.
          if (answer?.action?.act_probability !== undefined) {
            out.act_probability = answer.action.act_probability
          }
          return JSON.stringify(out, null, 2)
        },
      }),
    },
  }
}

export default plugin
