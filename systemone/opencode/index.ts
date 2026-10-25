import { type Config, type Plugin, tool } from "@opencode-ai/plugin"
import { createLogger } from "../../shared/plugin-logger"
import { moduleDir } from "../../shared/module-dir"
import { registerSkillDir } from "../../shared/v2-skills"
import fs from "fs"
import os from "os"
import path from "path"
import { writeLoadCanary } from "../../shared/load-canary"

/**
 * Local System One decision serving: one skill plus six tools.
 *
 *   systemone_suffice      is the gathered material enough, or keep looking?
 *   systemone_risk         before acting: severity, data loss, irreversibility
 *   systemone_consensus    do N sources agree, and which is the outlier?
 *   systemone_novel        is this entry new, a duplicate, or a correction?
 *   systemone_constraints  does a draft honour each stated constraint?
 *   systemone_deep         escalate ONE judgment to a larger CPU checkpoint
 *
 * The five judgment tools replace prompt-and-parse: each sends a fixed set of
 * typed questions to the configured local checkpoint and normalises the answer
 * into booleans and enums, so callers reason about a decision rather than about
 * probability plumbing. Code does the aggregation (mean, argmax, thresholds);
 * the model only makes the bounded call — a 322M encoder is reliable at "does
 * this text satisfy this narrow question", unreliable at composing several of
 * those into a plan.
 *
 * Constraints that shaped this, all verified in Studio's source:
 *
 *  - Studio's MCP at /mcp/decisions exposes only `decide(state, questions)` and
 *    always uses the configured checkpoint; a per-call `model` exists on the raw
 *    HTTP route only, and only for an authenticated (non-keyless, owner) caller.
 *    Hence these tools POST HTTP with the owner key.
 *  - Swapping checkpoints EVICTS the resident model ("another checkpoint
 *    downloads into the shared cache and evicts the owner's resident model"),
 *    so `systemone_deep` is explicit and batched, never a silent retry.
 *  - `llama_cpp_only` names the backend, not a GPU requirement: with device=cpu
 *    kev-* runs on CPU, slower, beside Strata instead of competing for it.
 *  - Calibration is per-checkpoint; never compare a confidence across models.
 *  - State is right-truncated at the window, so inputs are clipped here in code
 *    rather than silently losing their tail at the server.
 */

const skillsDir = path.resolve(moduleDir(import.meta.url, import.meta.dir), "..", "skills")

/** Escalation targets. The small default checkpoints belong to the MCP path. */
const DEEP_MODELS = ["kev-0.8b", "kev-4b", "kev-9b"] as const

/** Alias that resolves to whatever checkpoint the panel has configured. */
const DEFAULT_MODEL = "default"

const ENDPOINT = process.env.SYSTEMONE_URL ?? "http://127.0.0.1:8888/v1/systemone"
const KEY_FILE =
  process.env.SYSTEMONE_KEY_FILE ?? path.join(os.homedir(), ".config", "opencode", "keys", "unsloth.key")
/** Default judgment: a healthy backend answers in ~120 ms, so a long block means it is wedged. */
const TIMEOUT_MS = Number(process.env.SYSTEMONE_TIMEOUT_MS ?? 20_000)
/** Escalation: a 9B on CPU can genuinely take minutes. */
const DEEP_TIMEOUT_MS = Number(process.env.SYSTEMONE_DEEP_TIMEOUT_MS ?? 180_000)

function ownerKey(): string {
  // trim(): the file is also interpolated into an HTTP header elsewhere, and a
  // trailing newline must never reach a bearer token.
  return fs.readFileSync(KEY_FILE, "utf8").trim()
}

function clip(text: unknown, max: number): string {
  const s = typeof text === "string" ? text : JSON.stringify(text ?? "")
  return s.length <= max ? s : `${s.slice(0, max)}\n[truncated ${s.length - max} chars]`
}

type Decision = { answers: Record<string, any>; backend: string | null; latency_ms: number }

/**
 * One decision call against the configured checkpoint. Throws on transport,
 * non-2xx, non-JSON, or a fail-closed `invalid_response` — callers turn that
 * into `{ok:false}` rather than a default verdict.
 */
async function decide(model: string, state: string, questions: Record<string, unknown>): Promise<Decision> {
  const started = Date.now()
  const key = ownerKey()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const response = await fetch(ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, state, questions }),
      signal: controller.signal,
    })
    const bodyText = await response.text()
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${bodyText.slice(0, 400)}`)
    let body: any
    try {
      body = JSON.parse(bodyText)
    } catch {
      throw new Error("decision endpoint returned a non-JSON body")
    }
    if (body?.status === "invalid_response") {
      throw new Error("invalid_response — a malformed model answer is a failed call, not a verdict")
    }
    const answers = body?.answers
    if (!answers || typeof answers !== "object") throw new Error("decision endpoint returned no answers")
    return {
      answers,
      backend: response.headers.get("x-unsloth-decision-backend"),
      latency_ms: Date.now() - started,
    }
  } catch (error: any) {
    if (error?.name === "AbortError") {
      throw new Error(`decision call exceeded ${TIMEOUT_MS} ms; try a smaller checkpoint or fewer items`)
    }
    throw error
  } finally {
    clearTimeout(timer)
  }
}

/** Probability from a `noul` answer, or null when the shape is wrong. */
function p(answer: any): number | null {
  const v = answer?.noul
  return typeof v === "number" && v >= 0 && v <= 1 ? v : null
}

function choiceOf(answer: any): string | null {
  return typeof answer?.choice === "string" ? answer.choice : null
}

function fail(error: unknown, extra: Record<string, unknown> = {}): string {
  return JSON.stringify(
    { ok: false, error: error instanceof Error ? error.message : String(error), ...extra },
    null,
    2,
  )
}

// ---------------------------------------------------------------------------
// Adoption ledger — how you find out whether the tools are actually used
// ---------------------------------------------------------------------------
//
// Append-only JSONL, one line per decision call and per "exposure" (a moment
// where a decision was expected: untrusted content fetched, a risky command
// about to run). `systemone/stats.ts` turns it into per-tool counts, failure
// rates, latencies, and a rough adoption ratio. Local only, never sent anywhere;
// observability must never break a decision, so every write swallows its errors.

const LEDGER =
  process.env.SYSTEMONE_LEDGER ?? path.join(os.homedir(), ".local", "share", "systemone", "calls.jsonl")

function ledger(entry: Record<string, unknown>): void {
  try {
    fs.mkdirSync(path.dirname(LEDGER), { recursive: true })
    fs.appendFileSync(LEDGER, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`)
  } catch {
    // deliberately silent
  }
}

/** Wrap a tool so each invocation is recorded with its own ok flag and latency. */
function observed(name: string, definition: any): any {
  const inner = definition.execute
  definition.execute = async (args: any, ctx: any) => {
    const started = Date.now()
    let out: any
    try {
      out = await inner(args, ctx)
    } catch (error) {
      ledger({
        kind: "call",
        tool: name,
        ok: false,
        error: String(error),
        latency_ms: Date.now() - started,
        session: ctx?.sessionID,
        agent: ctx?.agent,
        project: ctx?.worktree,
      })
      throw error
    }
    let ok = false
    try {
      ok = JSON.parse(out)?.ok === true
    } catch {
      // a non-JSON reply is a failure by construction
    }
    ledger({
      kind: "call",
      tool: name,
      ok,
      latency_ms: Date.now() - started,
      session: ctx?.sessionID,
      agent: ctx?.agent,
      project: ctx?.worktree,
    })
    return out
  }
  return definition
}

/** Commands where a risk judgment is expected before running them. */
const RISKY_COMMAND =
  /\b(rm\s+-[a-zA-Z]*[rf]|mkfs|dd\s+if=|shred|truncate\s+-s\s*0|git\s+reset\s+--hard|git\s+push\s+--force|git\s+clean\s+-[a-z]*f|drop\s+(table|database)|delete\s+from)\b/i

/** Tools whose output is external, untrusted-ish content that warrants screening. */
const FETCH_TOOLS = new Set(["webfetch", "fetch", "websearch", "browser_fetch"])

const OUR_TOOLS = new Set([
  "systemone_suffice",
  "systemone_risk",
  "systemone_consensus",
  "systemone_novel",
  "systemone_constraints",
  "systemone_deep",
])

// ---------------------------------------------------------------------------
// systemone_suffice — retrieval-loop termination
// ---------------------------------------------------------------------------

const suffice = tool({
  description:
    "Decide whether the material you have gathered is ENOUGH to answer the task, " +
    "or whether to keep searching / ask the user. Use at the end of a retrieval " +
    "loop, before writing an answer from partial evidence, or when you notice you " +
    "are still looking after several failed searches. Returns sufficiency, whether " +
    "a specific missing fact blocks you, and the next step.",
  args: {
    task: tool.schema.string().describe("What must be answered or decided, in one or two sentences."),
    gathered: tool.schema
      .string()
      .describe("The evidence you actually have (quotes, findings, tool output). Clipped to fit the model window."),
  },
  async execute(args) {
    try {
      const { answers, backend, latency_ms } = await decide(
        DEFAULT_MODEL,
        `TASK:\n${clip(args.task, 1500)}\n\nGATHERED:\n${clip(args.gathered, 6000)}`,
        {
          enough: {
            type: "noul",
            instructions: "Is the gathered material sufficient to complete the task without guessing?",
          },
          blocked: {
            type: "noul",
            instructions:
              "Is there a specific missing fact that must be obtained before any answer would be trustworthy?",
          },
          next: {
            type: "choice",
            instructions: "What is the next step?",
            criteria: {
              answer: "the material already suffices; answer now",
              search: "more material is needed and can be found by searching or reading",
              ask_user: "the missing input can only come from the user",
            },
          },
        },
      )
      const enough = p(answers.enough)
      const blocked = p(answers.blocked)
      const next = choiceOf(answers.next)
      if (enough === null || next === null) throw new Error("answers missing `enough` or `next`")
      const nextConfidence = typeof answers.next?.confidence === "number" ? answers.next.confidence : null
      return JSON.stringify(
        {
          ok: true,
          sufficient: enough >= 0.5,
          blocked_by_missing_fact: blocked !== null && blocked >= 0.5,
          next,
          confidence: nextConfidence,
          // A flat choice distribution is the "read the distribution" case: the
          // probability mass is spread, so `next` is a weak preference, not a
          // recommendation. Measured: "answer" at 0.67 sufficiency but 0.086
          // choice confidence.
          low_confidence: nextConfidence !== null && nextConfidence < 0.5,
          probabilities: { enough, blocked },
          backend,
          latency_ms,
        },
        null,
        2,
      )
    } catch (error) {
      return fail(error, { hint: "Check Unsloth Studio is up with the Decision API enabled." })
    }
  },
})

// ---------------------------------------------------------------------------
// systemone_risk — pre-execution gate
// ---------------------------------------------------------------------------

const risk = tool({
  description:
    "Judge the RISK of an action before taking it: running a destructive shell " +
    "command, applying a migration, force-pushing, deleting files. Returns a " +
    "severity level plus probabilities for data loss, irreversibility, and whether " +
    "a human should confirm. Use before irreversible operations; do not use it as " +
    "a substitute for reading the command.",
  args: {
    action: tool.schema.string().describe("The exact command or change, verbatim."),
    context: tool.schema
      .string()
      .optional()
      .describe("Anything that changes the risk: repo state, backup exists, blast radius, who is affected."),
  },
  async execute(args) {
    try {
      const { answers, backend, latency_ms } = await decide(
        DEFAULT_MODEL,
        `ACTION:\n${clip(args.action, 1500)}\n\nCONTEXT:\n${clip(args.context ?? "(none given)", 2500)}`,
        {
          severity: {
            type: "score",
            instructions: "How damaging is this action if it goes wrong?",
            criteria: ["no effect", "minor annoyance", "needs cleanup", "data loss or outage"],
          },
          data_loss: { type: "noul", instructions: "Could this action destroy data that is not recoverable?" },
          irreversible: { type: "noul", instructions: "Would this action be difficult or impossible to undo?" },
          needs_human: {
            type: "noul",
            instructions: "Should a human confirm before this action is taken?",
          },
        },
      )
      const severity = typeof answers.severity?.score === "number" ? answers.severity.score : null
      const dataLoss = p(answers.data_loss)
      const irreversible = p(answers.irreversible)
      const needsHuman = p(answers.needs_human)
      if (severity === null || dataLoss === null || irreversible === null || needsHuman === null) {
        throw new Error("answers missing one of severity/data_loss/irreversible/needs_human")
      }
      const labels = ["none", "minor", "moderate", "severe"]
      // One rounded value for both the label and the gate: they disagreed when
      // the raw score sat at 1.6 (label said "moderate", the gate's `>= 2` said no).
      const severityRounded = Math.round(severity)
      // Code enforces, the model advises. A destructive pattern escalates no
      // matter what the model thinks — measured case: `rm -rf <repo>` came back
      // severity 1.6 with needs_human 0.03, which is exactly the confidence a
      // 322M encoder should not be trusted with on an irreversible action.
      const destructive = RISKY_COMMAND.test(args.action)
      const escalate =
        destructive || needsHuman >= 0.5 || dataLoss >= 0.5 || irreversible >= 0.7 || severityRounded >= 2
      return JSON.stringify(
        {
          ok: true,
          severity: severityRounded,
          severity_label: labels[Math.min(labels.length - 1, severityRounded)],
          destructive_pattern: destructive,
          data_loss: dataLoss >= 0.5,
          irreversible: irreversible >= 0.5,
          needs_human: needsHuman >= 0.5,
          escalate,
          probabilities: { data_loss: dataLoss, irreversible, needs_human: needsHuman },
          backend,
          latency_ms,
        },
        null,
        2,
      )
    } catch (error) {
      return fail(error, { note: "If this fails, treat the action as risky and ask the user." })
    }
  },
})

// ---------------------------------------------------------------------------
// systemone_consensus — N sources, one question
// ---------------------------------------------------------------------------

const consensus = tool({
  description:
    "Ask N short sources the SAME yes/no question and report whether they agree, " +
    "with the outlier identified. Use for source reconciliation or checking whether " +
    "scraped pages / docs / logs actually support a claim. Not a substitute for " +
    "jev_compare when you only have two passages and want their relation.",
  args: {
    question: tool.schema.string().describe("The single yes/no proposition to test, e.g. 'is the timeout 30s?'"),
    sources: tool.schema
      .array(tool.schema.string())
      .describe("2-8 self-contained excerpts, one per source. Each is clipped; keep each under ~1200 chars."),
  },
  async execute(args) {
    const sources = (args.sources ?? []).map((s, i) => ({ id: `s${i}`, text: clip(s, 1200) }))
    if (sources.length < 2) return fail("need at least 2 sources")
    if (sources.length > 8) return fail("at most 8 sources per call; chunk deliberately")
    const questions: Record<string, unknown> = {}
    for (const s of sources) {
      questions[`answer_${s.id}`] = {
        type: "noul",
        instructions: `Judging ONLY ${s.id}, is this true: ${clip(args.question, 400)}`,
      }
    }
    try {
      const { answers, backend, latency_ms } = await decide(
        DEFAULT_MODEL,
        JSON.stringify({ question: clip(args.question, 800), sources }),
        questions,
      )
      const per = sources.map(s => ({ id: s.id, probability: p(answers[`answer_${s.id}`]) }))
      if (per.some(x => x.probability === null)) throw new Error("answers missing one of the per-source questions")
      const probs = per.map(x => x.probability as number)
      const mean = probs.reduce((a, b) => a + b, 0) / probs.length
      const majority = mean >= 0.5
      // Outlier = the source furthest from the majority reading, computed in code.
      const distances = probs.map(v => Math.abs(v - mean))
      const outlier = per[distances.indexOf(Math.max(...distances))].id
      const spread = Math.max(...probs) - Math.min(...probs)
      return JSON.stringify(
        {
          ok: true,
          majority,
          agreement: Number((1 - spread).toFixed(3)),
          outlier: spread >= 0.5 ? outlier : null,
          per_source: per,
          backend,
          latency_ms,
        },
        null,
        2,
      )
    } catch (error) {
      return fail(error)
    }
  },
})

// ---------------------------------------------------------------------------
// systemone_novel — memory hygiene
// ---------------------------------------------------------------------------

const novel = tool({
  description:
    "Decide whether a candidate memory/note adds something NEW relative to items " +
    "already stored, merely duplicates one, or corrects one. Use before writing to " +
    "memory or a knowledge base, so it does not fill with paraphrases. Returns an " +
    "action: add | skip | supersede.",
  args: {
    entry: tool.schema.string().describe("The item you are about to store."),
    existing: tool.schema
      .array(tool.schema.string())
      .describe("The most similar items already stored (retrieve candidates first). 1-8 items."),
  },
  async execute(args) {
    const existing = (args.existing ?? []).map((t, i) => ({ id: `e${i}`, text: clip(t, 800) }))
    if (existing.length < 1) return fail("need at least 1 existing item to compare against")
    if (existing.length > 8) return fail("at most 8 existing items per call")
    try {
      const { answers, backend, latency_ms } = await decide(
        DEFAULT_MODEL,
        JSON.stringify({ entry: clip(args.entry, 1500), existing }),
        {
          duplicate: {
            type: "noul",
            instructions: "Does the entry state the same fact as one of the existing items, without adding information?",
          },
          correction: {
            type: "noul",
            instructions: "Does the entry contradict or update an existing item, making that item stale?",
          },
        },
      )
      const duplicate = p(answers.duplicate)
      const correction = p(answers.correction)
      if (duplicate === null || correction === null) throw new Error("answers missing duplicate/correction")
      const action = correction >= 0.5 ? "supersede" : duplicate >= 0.5 ? "skip" : "add"
      return JSON.stringify(
        {
          ok: true,
          action,
          duplicate: duplicate >= 0.5,
          supersedes: correction >= 0.5,
          probabilities: { duplicate, correction },
          backend,
          latency_ms,
        },
        null,
        2,
      )
    } catch (error) {
      return fail(error)
    }
  },
})

// ---------------------------------------------------------------------------
// systemone_constraints — output compliance
// ---------------------------------------------------------------------------

const constraints = tool({
  description:
    "Check a draft against explicit constraints (format, length, must-include, " +
    "register, forbidden content) one at a time. Use before delivering output that " +
    "has hard requirements. Not for factual verification — that is jev_verify, " +
    "which checks claims against evidence.",
  args: {
    draft: tool.schema.string().describe("The text to check."),
    constraints: tool.schema
      .array(tool.schema.string())
      .describe("Each constraint as a single testable statement, e.g. 'ends with a summary section'. 1-12 items."),
  },
  async execute(args) {
    const list = (args.constraints ?? []).map(c => clip(c, 300))
    if (list.length < 1) return fail("need at least 1 constraint")
    if (list.length > 12) return fail("at most 12 constraints per call")
    const questions: Record<string, unknown> = {}
    list.forEach((c, i) => {
      questions[`holds_${i}`] = { type: "noul", instructions: `Does the draft satisfy this constraint? ${c}` }
    })
    try {
      const { answers, backend, latency_ms } = await decide(
        DEFAULT_MODEL,
        `DRAFT:\n${clip(args.draft, 6000)}`,
        questions,
      )
      const results = list.map((c, i) => {
        const prob = p(answers[`holds_${i}`])
        if (prob === null) throw new Error(`answers missing holds_${i}`)
        return { constraint: c, satisfied: prob >= 0.5, probability: prob }
      })
      const failed = results.filter(r => !r.satisfied)
      return JSON.stringify(
        {
          ok: true,
          all_satisfied: failed.length === 0,
          failed_count: failed.length,
          results,
          backend,
          latency_ms,
        },
        null,
        2,
      )
    } catch (error) {
      return fail(error)
    }
  },
})

// ---------------------------------------------------------------------------
// systemone_deep — explicit escalation to a larger CPU checkpoint
// ---------------------------------------------------------------------------

const deep = tool({
  description:
    "Escalate ONE bounded judgment to a larger local decision model " +
    "(kev-0.8b / kev-4b / kev-9b) running on CPU. Use sparingly: the default " +
    "checkpoint answers in ~120 ms, this takes seconds to tens of seconds, and it " +
    "evicts the resident model so the next ordinary decision must reload. Use it " +
    "when a cheaper call returned 'escalate' or a verdict you cannot accept, or " +
    "when the judgment is consequential enough to justify the wait. Never for " +
    "open-ended generation; it returns typed answers, not prose.",
  args: {
    model: tool.schema
      .string()
      .describe(
        "Which CPU decision checkpoint: 'kev-0.8b' (~812 MB, fastest escalation), " +
          "'kev-4b' (~4.5 GB), or 'kev-9b' (~9.5 GB, slowest). Anything else is rejected.",
      ),
    state: tool.schema
      .string()
      .describe("Text, or a JSON object serialised as a string. Keep the decision-relevant part first."),
    questions: tool.schema
      .record(tool.schema.string(), tool.schema.any())
      .describe(
        'Typed questions, e.g. {"urgent": {"type": "noul", "instructions": "..."}} or ' +
          '{"dept": {"type": "choice", "instructions": "...", "criteria": {"billing": "...", "tech": "..."}}}.',
      ),
  },
  async execute(args) {
    const model = String(args.model ?? "").trim()
    if (!DEEP_MODELS.includes(model as (typeof DEEP_MODELS)[number])) {
      return JSON.stringify({
        ok: false,
        error: `unsupported escalation model: ${model || "(empty)"}`,
        allowed: DEEP_MODELS,
        hint: "The ~120 ms default checkpoints are served by the `systemone` MCP, not this tool.",
      })
    }
    try {
      const { answers, backend, latency_ms } = await decide(model, args.state, args.questions)
      return JSON.stringify(
        {
          ok: true,
          model,
          backend,
          answers,
          latency_ms,
          note: "Resident checkpoint evicted; the next default decision reloads it. Batch further escalations.",
        },
        null,
        2,
      )
    } catch (error) {
      return fail(error, { model })
    }
  },
})

// ---------------------------------------------------------------------------
// Registration surface
// ---------------------------------------------------------------------------
//
// One implementation, two hosts. The logic lives in the `tool()` definitions
// below; they are wrapped ONCE here (wrapping inside the factory would nest the
// ledger wrapper if the host calls it more than once). V1 hosts take the `tool`
// map; V2 hosts have no such map — `server` is ignored when a plugin has a
// `setup`, so the same definitions are re-exposed through
// `ctx.tool.transform` with JSON Schema inputs, which is what v2 actually
// reads. Without that second path none of these tools exist at all.

const TOOLS: Record<string, any> = {
  systemone_suffice: observed("systemone_suffice", suffice),
  systemone_risk: observed("systemone_risk", risk),
  systemone_consensus: observed("systemone_consensus", consensus),
  systemone_novel: observed("systemone_novel", novel),
  systemone_constraints: observed("systemone_constraints", constraints),
  systemone_deep: observed("systemone_deep", deep),
}

const JSON_SCHEMA = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
})

const TOOL_INPUTS: Record<string, unknown> = {
  systemone_suffice: JSON_SCHEMA(
    {
      task: { type: "string", description: "What must be answered or decided, in one or two sentences." },
      gathered: { type: "string", description: "The evidence you actually have. Clipped to fit the model window." },
    },
    ["task", "gathered"],
  ),
  systemone_risk: JSON_SCHEMA(
    {
      action: { type: "string", description: "The exact command or change, verbatim." },
      context: {
        type: "string",
        description: "Anything that changes the risk: repo state, backup exists, blast radius, who is affected.",
      },
    },
    ["action"],
  ),
  systemone_consensus: JSON_SCHEMA(
    {
      question: { type: "string", description: "The single yes/no proposition to test." },
      sources: {
        type: "array",
        items: { type: "string" },
        minItems: 2,
        maxItems: 8,
        description: "2-8 self-contained excerpts, one per source, each under ~1200 chars.",
      },
    },
    ["question", "sources"],
  ),
  systemone_novel: JSON_SCHEMA(
    {
      entry: { type: "string", description: "The item you are about to store." },
      existing: {
        type: "array",
        items: { type: "string" },
        minItems: 1,
        maxItems: 8,
        description: "The most similar items already stored (retrieve candidates first).",
      },
    },
    ["entry", "existing"],
  ),
  systemone_constraints: JSON_SCHEMA(
    {
      draft: { type: "string", description: "The text to check." },
      constraints: {
        type: "array",
        items: { type: "string" },
        minItems: 1,
        maxItems: 12,
        description: "Each constraint as a single testable statement.",
      },
    },
    ["draft", "constraints"],
  ),
  systemone_deep: JSON_SCHEMA(
    {
      model: {
        type: "string",
        enum: [...DEEP_MODELS],
        description: "kev-0.8b (fastest), kev-4b, or kev-9b (slowest). All run on CPU here.",
      },
      state: { type: "string", description: "Text, or a JSON object serialised as a string." },
      questions: {
        type: "object",
        additionalProperties: true,
        description: 'Typed questions, e.g. {"urgent": {"type": "noul", "instructions": "..."}}.',
      },
    },
    ["model", "state", "questions"],
  ),
}

function skillCount(dir: string): number {
  if (!fs.existsSync(dir)) return 0
  return fs
    .readdirSync(dir)
    .filter(entry => {
      const d = path.join(dir, entry)
      return fs.statSync(d).isDirectory() && fs.existsSync(path.join(d, "SKILL.md"))
    }).length
}

// ---------------------------------------------------------------------------
// v1 entrypoint: skills paths + the tool map.
// ---------------------------------------------------------------------------
const v1Factory: Plugin = async ({ client }) => {
  writeLoadCanary("systemone")
  const logger = createLogger(client, "systemone")
  const count = skillCount(skillsDir)
  logger.info(`plugin active — ${count} skill(s) in ${skillsDir}; 6 decision tools`)

  return {
    // V1-only: on OpenCode v2 a plugin that exports `setup` does not use this
    // factory at all, and v2's plugin API exposes no tool-execution hook — only
    // session hooks (prompt/context/model request). So exposure rows are written
    // on v1 hosts and NOT on v2; measured here: five calls logged, zero
    // exposures, while a risky command ran. `stats.ts` therefore prints "—" for
    // the adoption ratios on v2, and the sampling audit in README.md is the
    // working alternative. Kept for v1 hosts and as the place a v2 hook will go.
    "tool.execute.after": async (input: any) => {
      const name = String(input?.tool ?? "")
      if (!name || OUR_TOOLS.has(name)) return
      // External decision tools (Jev) are recorded here because they do not pass
      // through our wrapper; they are the other half of the adoption picture.
      if (name.startsWith("jev_") || name === "systemone_decide") {
        ledger({ kind: "call", tool: name, session: input?.sessionID, external: true })
        return
      }
      if (FETCH_TOOLS.has(name)) {
        ledger({ kind: "exposure", trigger: "fetched_content", tool: name, session: input?.sessionID })
        return
      }
      if (name === "bash") {
        const command = String(input?.args?.command ?? "")
        if (RISKY_COMMAND.test(command)) {
          ledger({
            kind: "exposure",
            trigger: "risky_command",
            tool: name,
            session: input?.sessionID,
            command: command.slice(0, 200),
          })
        }
      }
    },
    tool: TOOLS,
    config: async (input: Config) => {
      const skills = (input as any).skills ?? {}
      const paths: string[] = Array.isArray(skills.paths) ? [...skills.paths] : []
      if (count > 0 && !paths.includes(skillsDir)) paths.push(skillsDir)
      ;(input as any).skills = { ...skills, paths }
    },
  }
}

// ---------------------------------------------------------------------------
// v2 entrypoint: skills replay. Tools from the v1 map are still surfaced by the
// host (same pattern as tier-router and agentmem in this repo).
// ---------------------------------------------------------------------------
export default {
  id: "systemone",

  async setup(ctx: any) {
    writeLoadCanary("systemone")
    await ctx.skill.transform((editor: any) => registerSkillDir(editor, skillsDir))

    // v2 tool registration. `server`'s `tool` map is ignored by a plugin that
    // exports `setup`, which is why the first v2 build exposed none of these.
    await ctx.tool.transform((editor: any) => {
      for (const [name, definition] of Object.entries(TOOLS)) {
        editor.add({
          name,
          description: definition.description,
          input: TOOL_INPUTS[name],
          async execute(input: any, context: any) {
            // The definitions return a JSON string; v2 tools return { content }.
            return { content: await definition.execute(input, context) }
          },
        })
      }
    })
  },

  async server(input: any, options?: any) {
    return v1Factory(input, options)
  },
}
