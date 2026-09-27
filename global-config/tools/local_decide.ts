import { tool } from "@opencode-ai/plugin"
import fs from "fs"
import os from "os"
import path from "path"

/**
 * System 1 decisional engine backed by DeepSeek's OpenAI-compatible chat API.
 *
 * Used to run on a small local model (Unsloth Studio on 127.0.0.1:8888). Local
 * models are often not running, so every call timed out; this now defaults to
 * `deepseek-flash`, which is fast, always reachable, and needs no GPU.
 *
 * Use this for BOUNDED, structured choices — routing, triage, classify,
 * escalate-or-not — when the decision is routine and the action space is
 * small. Do NOT use it for reasoning, code generation, or open-ended
 * questions: it is a single terse call, meant to be fast and shallow.
 *
 * Read `confident` in the result:
 *   confident: true  -> trust `action`; it is a routine call (System 1).
 *   confident: false -> the model is unsure, or logprobs were unavailable.
 *                       Decide it yourself, or escalate to a larger model.
 *
 * `confidence` is derived from response token logprobs, never from a number the
 * model writes about itself (that is not trustworthy).
 *
 * Env overrides: `LOCAL_DECIDE_BASE_URL`, `LOCAL_DECIDE_MODEL`,
 * `LOCAL_DECIDE_API_KEY` (else `DEEPSEEK_API_KEY`, else the opencode key file).
 */

const BASE_URL = (process.env.LOCAL_DECIDE_BASE_URL ?? "https://api.deepseek.com").replace(/\/+$/, "")
const MODEL = process.env.LOCAL_DECIDE_MODEL ?? "deepseek-flash"
const REQUEST_TIMEOUT_MS = Number(process.env.LOCAL_DECIDE_TIMEOUT_MS ?? 30_000)

function resolveApiKey(): string | null {
  const env = process.env.LOCAL_DECIDE_API_KEY ?? process.env.DEEPSEEK_API_KEY
  if (env && env.trim()) return env.trim()
  try {
    const key = fs.readFileSync(path.join(os.homedir(), ".config", "opencode", "keys", "deepseek.key"), "utf-8").trim()
    return key || null
  } catch {
    return null
  }
}

function matchAction(raw: string, actions: string[]): string | null {
  const text = raw.trim()
  if (!text) return null
  const lower = text.toLowerCase()
  for (const a of actions) if (a.toLowerCase() === lower) return a
  for (const a of actions) if (lower.includes(a.toLowerCase())) return a
  return null
}

/** Probability mass over the allowed actions from the first content token's
 * top_logprobs (mirrors the old local probe: prefix-match each candidate token
 * to an action). Returns null when the API did not return content logprobs. */
function confidenceFromLogprobs(
  actions: string[],
  chosen: string,
  choice: any,
): { confidence: number; probs: Record<string, number>; outside_enum_mass: number } | null {
  const content = choice?.logprobs?.content
  if (!Array.isArray(content) || content.length === 0) return null
  const tops = content[0]?.top_logprobs
  if (!Array.isArray(tops) || tops.length === 0) {
    const lp = content[0]?.logprob
    if (typeof lp !== "number") return null
    return { confidence: Math.exp(lp), probs: { [chosen]: Math.exp(lp) }, outside_enum_mass: 0 }
  }
  const probs: Record<string, number> = {}
  for (const a of actions) probs[a] = 0
  let outside = 0
  for (const t of tops) {
    const tok = String(t?.token ?? "").trim().toLowerCase()
    const lp = typeof t?.logprob === "number" ? t.logprob : null
    if (!tok || lp === null) continue
    let matched = false
    for (const a of actions) {
      const al = a.toLowerCase()
      // Actions tokenize into pieces ("es"+"cal"+"ate"+...), so accept a token
      // that is a prefix of the action or vice-versa, over >=2 shared chars.
      const overlap = Math.min(tok.length, al.length, 4)
      if (overlap >= 2 && tok.slice(0, overlap) === al.slice(0, overlap)) {
        probs[a] += Math.exp(lp)
        matched = true
        break
      }
    }
    if (!matched) outside += Math.exp(lp)
  }
  return { confidence: probs[chosen] ?? 0, probs, outside_enum_mass: outside }
}

export default tool({
  description:
    "Ask a fast model (DeepSeek flash; was a small LOCAL model) to make a " +
    "bounded decisional call: routing, triage, classification, or " +
    "escalate-or-not. Returns a chosen action plus a logprob-derived " +
    "`confidence` and a `confident` boolean. Use for routine bounded choices; " +
    "treat `confident: false` as a signal to decide yourself or escalate. Not " +
    "for reasoning, code, or open-ended questions.",
  args: {
    state: tool.schema
      .string()
      .describe(
        "The situation to decide on. Keep it SHORT (a sentence or two) - " +
          "latency grows with prompt length.",
      ),
    actions: tool.schema
      .array(tool.schema.string())
      .describe(
        "The allowed actions, e.g. ['escalate_human','retry_payload','ignore']. " +
          "The model is constrained to pick exactly one of these.",
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
    const apiKey = resolveApiKey()
    if (!apiKey) {
      return JSON.stringify({
        ok: false,
        error: "no API key (set LOCAL_DECIDE_API_KEY or DEEPSEEK_API_KEY, or ~/.config/opencode/keys/deepseek.key)",
      })
    }

    const prompt =
      "Choose exactly one action for the given state. Be decisive.\n" +
      `State: ${args.state}\n` +
      `Actions: ${actions.join(", ")}.\n` +
      "Reply with ONLY the exact action string, nothing else."

    const started = Date.now()
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS)
    let json: any
    try {
      const res = await fetch(`${BASE_URL}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: MODEL,
          temperature: 0.0,
          max_tokens: 16,
          logprobs: true,
          top_logprobs: 5,
          thinking: { type: "disabled" },
          messages: [{ role: "user", content: prompt }],
        }),
        signal: ctrl.signal,
      })
      if (!res.ok) {
        return JSON.stringify({ ok: false, error: `HTTP ${res.status}: ${(await res.text()).slice(0, 300)}` })
      }
      json = await res.json()
    } catch (error: any) {
      return JSON.stringify({ ok: false, error: `request failed: ${error?.message ?? error}` })
    } finally {
      clearTimeout(timer)
    }

    const choice = json?.choices?.[0]
    const raw = String(choice?.message?.content ?? "").trim()
    const action = matchAction(raw, actions)
    if (!action) {
      return JSON.stringify({ ok: false, error: `unparseable decision: ${JSON.stringify(raw).slice(0, 200)}` })
    }

    const out: Record<string, unknown> = {
      ok: true,
      action,
      model: MODEL,
      latency_ms: Date.now() - started,
      threshold,
    }
    const conf = confidenceFromLogprobs(actions, action, choice)
    if (conf) {
      out.confidence = conf.confidence
      out.probs = conf.probs
      out.outside_enum_mass = conf.outside_enum_mass
      out.confident = conf.confidence >= threshold
    } else {
      out.confident = false
      out.warning = "no content logprobs returned; confidence unavailable"
    }
    return JSON.stringify(out, null, 2)
  },
})
