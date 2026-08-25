import { type Plugin, tool } from "@opencode-ai/plugin"
import path from "path"
import { createLogger } from "../../shared/plugin-logger"
import fs from "fs"
import os from "os"
import { safeSpawn, spawnDetached, killProcessTree, NO_SUBSPAWN_ENV, extractOpencodeText } from "../../shared/safe-spawn"
import { moduleDir } from "../../shared/module-dir"

const pluginDir = path.join(moduleDir(import.meta.url, import.meta.dir), "..")
const classesDir = path.join(pluginDir, "build", "classes")
const sharedClassesDir = path.join(pluginDir, "..", "shared", "build", "classes")
const classpath = `${classesDir}${path.delimiter}${sharedClassesDir}`
const mainClass = "eu.infolead.llmhp.router.RouterCli"
const routerEnv: Record<string, string> = {
  TIER_ROUTER_PLUGIN_ROOT: pluginDir,
}

/** When set to "1", rewrite the user's message to the annotated form (replacing
 * the original, not appending) so the model sees a single prompt, not a doubled
 * one. When unset, the message passes through untouched — no annotation, no
 * self-quote, no duplication. */
const ANNOTATE_ENV = "TIER_ROUTER_ANNOTATE"

/** When TIER_ROUTER_ANNOTATE=1 AND this is "1", send only the rewritten prompt
 * plus the tier directives — no self-quote annotation block. Leaner than the
 * full annotation: still single-prompt, but minimal. */
const LEAN_ENV = "TIER_ROUTER_LEAN"

/** Bounded cache of prompt → classification result, keyed by a content hash.
 * Prevents re-running the (expensive) classifier on repeated/similar prompts.
 * LRU-style eviction via a simple insertion-order Map capped at CACHE_MAX. */
const CACHE_MAX = 512

/** Result of prompt classification, used by the annotation builders and cache. */
type ClassificationResult = {
  decision: string
  tier: string
  fleet_models: string[]
  reason: string
  confidence: number
  rewritten_prompt: string
  failed?: boolean
}

/** Classification subprocess timeouts. The LLM classifier and the Java keyword
 * router both race against a hard cap; the earlier kill timer reaps the child
 * so a hung process is not orphaned (mirrors the cap in classifyViaOpencode). */
const LLM_CLASSIFY_CAP_MS = 25_000
const LLM_CLASSIFY_KILL_MS = 20_000
const JAVA_ROUTE_CAP_MS = 10_000

const classifyCache = new Map<string, ClassificationResult>()

function cacheKey(prompt: string): string {
  let h = 0
  for (let i = 0; i < prompt.length; i++) {
    h = (h * 31 + prompt.charCodeAt(i)) | 0
  }
  return `${prompt.length}:${h}`
}

function cacheGet(prompt: string) {
  const k = cacheKey(prompt)
  const hit = classifyCache.get(k)
  if (hit) {
    // Refresh recency (LRU).
    classifyCache.delete(k)
    classifyCache.set(k, hit)
  }
  return hit
}

function cacheSet(prompt: string, value: ClassificationResult): void {
  const k = cacheKey(prompt)
  classifyCache.set(k, value)
  if (classifyCache.size > CACHE_MAX) {
    const oldest = classifyCache.keys().next().value
    if (oldest !== undefined) classifyCache.delete(oldest)
  }
}

const CLASSIFY_DIR_DEFAULT = path.join(os.tmpdir(), "tier-router-classify")

/** Resolve the throwaway data home for headless classification runs.
 * Order: TIER_ROUTER_CLASSIFY_DATA_DIR override, else $XDG_RUNTIME_DIR (tmpfs,
 * self-cleaning on logout/reboot), else os.tmpdir().
 */
function resolveClassifyDataDir(): string {
  const override = process.env.TIER_ROUTER_CLASSIFY_DATA_DIR
  if (override) return override
  const runtime = process.env.XDG_RUNTIME_DIR
  if (runtime) return path.join(runtime, "tier-router-classify")
  return CLASSIFY_DIR_DEFAULT
}

/** Create the isolated data dir and drop the role/retention README into it.
 * Returns the dir on success, or null if it could not be prepared (unwritable
 * override, etc.). Never throws. A null result tells callers to skip LLM
 * classification rather than pollute the real session log.
 */
function prepareClassifyDataDir(logger: { warn: (m: string, e?: Record<string, unknown>) => void }): string | null {
  const dataDir = resolveClassifyDataDir()
  try {
    fs.mkdirSync(dataDir, { recursive: true })
    const readmePath = path.join(dataDir, "README.md")
    if (!fs.existsSync(readmePath)) fs.writeFileSync(readmePath, CLASSIFY_README)
    return dataDir
  } catch (e) {
    logger.warn(`[tier-router] cannot prepare classification data dir ${dataDir}: ${(e as Error).message}; LLM classification disabled`)
    return null
  }
}

const CLASSIFY_README = `# tier-router classification data dir

Role:
  This directory is the isolated data home (XDG_DATA_HOME) for the headless
  \`opencode run\` processes the tier-router plugin spawns to classify each
  user prompt. Pointing opencode's data dir here keeps every classification
  session OUT of the real session log/database (~/.local/share/opencode/).

Retention:
  NONE. This is purely throwaway classification scratch. It can be deleted at
  any time with no loss — the plugin recreates it (and this README) on the next
  plugin load / classified prompt. If it lives under \$XDG_RUNTIME_DIR it is
  tmpfs and self-cleaning: wiped automatically on logout or reboot.

Resolved from (first match wins):
  1. TIER_ROUTER_CLASSIFY_DATA_DIR  explicit override (useful for debugging:
     point it at a persistent dir to inspect accumulated classification runs)
  2. \$XDG_RUNTIME_DIR/tier-router-classify
  3. <os.tmpdir()>/tier-router-classify
`

const CLASSIFY_SYSTEM = [
  "You are a prompt classifier. Classify the user's task by reasoning complexity.",
  "Reply with ONLY one word: FABLE, HAIKU, SONNET, OPUS, or ESCALATE.",
  "FABLE: trivial single actions (close bracket, add semicolon, append text).",
  "HAIKU: mechanical edits with clear scope (fix typo, rename, format, lint).",
  "SONNET: reasoning/analysis required (analyze, implement, refactor, review, debug, explain).",
  "OPUS: deep formal reasoning (prove, formalize, math theorems, algorithm design).",
  "ESCALATE: ambiguous, unclear scope, multiple competing goals, or genuinely uncertain.",
].join("\n")

async function classifyViaOpencode(dataDir: string | null, prompt: string): Promise<{ decision: string; tier: string; reason: string; confidence: number } | null> {
  // Classify in a detached, throwaway session via `opencode run --format json`.
  // Never call session.prompt on the live session here: that would (a) append a
  // duplicate copy of the user's prompt and the classifier's reply into the real
  // conversation and (b) block the chat.message hook on a full LLM round-trip
  // using the session's own (possibly expensive) model. A headless run keeps the
  // live session clean and lets us pin a cheap model for this trivial task.
  //
  // Each headless run would otherwise persist a session entry into the real
  // session log, so we give it an isolated data home (XDG_DATA_HOME) — its own
  // DB + session storage — that never touches the user's sessions. Config/auth
  // live under XDG_CONFIG_HOME (separate), so the classifier still reaches the
  // model. If the isolated dir could not be prepared (null), we skip LLM
  // classification rather than pollute the real session log.
  if (dataDir == null) return null

  const classifierPrompt = `${CLASSIFY_SYSTEM}\n\nTask to classify:\n"""\n${prompt.slice(0, 2000)}\n"""`
  let proc: Bun.Subprocess<"pipe", "pipe", "ignore"> | null = null
  try {
    proc = spawnDetached(
      ["opencode", "run", "--model", process.env.TIER_ROUTER_CLASSIFY_MODEL ?? "deepseek/deepseek-v4-flash",
       "--format", "json", "--title", "Tier classification", "--",
       "Classify the task in stdin per the system prompt. Reply with ONE word only."],
      { stdin: "pipe", stdout: "pipe", stderr: "ignore", env: { ...routerEnv, XDG_DATA_HOME: dataDir } },
    )
    proc.stdin!.write(classifierPrompt)
    proc.stdin!.end()
    // Bound the wait: if the child is killed on timeout but stdout does not
    // close (orphaned survivor), `.text()` would hang the chat.message hook
    // forever. Racing a hard cap guarantees resolution; a null result simply
    // falls through to the keyword router.
    const kill = setTimeout(() => { try { killProcessTree(proc!) } catch {} }, LLM_CLASSIFY_KILL_MS)
    const out = await Promise.race([
      new Response(proc.stdout).text(),
      new Promise<string | null>(resolve => setTimeout(() => resolve(null), LLM_CLASSIFY_CAP_MS)),
    ])
    clearTimeout(kill)
    if (out == null) return null
    const text = extractOpencodeText(out).toUpperCase()
    if (!text) return null
    // Take the first token and strip trailing punctuation so the common
    // "FABLE.", "HAIKU!", "OPUS," outputs still match. Exact-token equality
    // (not startsWith) still rejects truncated/concatenated tokens like
    // "FABLESTUFF", so partial output falls through to the keyword router.
    const token = text.split(/\s+/)[0].replace(/[.,!?;:)]+$/g, "")
    if (token === "ESCALATE") return { decision: "escalate", tier: "", reason: "LLM: uncertain scope", confidence: 0.7 }
    if (token === "FABLE") return { decision: "direct", tier: "fable", reason: "LLM: trivial mechanical task", confidence: 0.9 }
    if (token === "HAIKU") return { decision: "direct", tier: "haiku", reason: "LLM: mechanical edit with clear scope", confidence: 0.9 }
    if (token === "OPUS") return { decision: "direct", tier: "opus", reason: "LLM: deep formal reasoning", confidence: 0.9 }
    if (token === "SONNET") return { decision: "direct", tier: "sonnet", reason: "LLM: reasoning/analysis required", confidence: 0.9 }
    return null
  } catch (e) {
    console.warn(`[tier-router] opencode LLM classification failed: ${(e as Error).message}`)
    return null
  } finally {
    try { if (proc) killProcessTree(proc) } catch {}
  }
}

async function classifyPrompt(dataDir: string | null, prompt: string): Promise<ClassificationResult> {
  const cached = cacheGet(prompt)
  if (cached) return cached

  // Skip the expensive LLM classifier for prompts that cannot benefit from it:
  // trivial short/mechanical prompts go straight to the cheap Java keyword
  // router. The LLM round-trip (a spawned `opencode run`, ~seconds) is reserved
  // for prompts that need genuine reasoning classification.
  const llmWorthwhile = shouldUseLlm(prompt)
  const llm = llmWorthwhile ? await classifyViaOpencode(dataDir, prompt) : null
  if (llm) {
    const result = {
      decision: llm.decision,
      tier: llm.tier,
      fleet_models: [],
      reason: llm.reason,
      confidence: llm.confidence,
      rewritten_prompt: prompt,
    }
    cacheSet(prompt, result)
    return result
  }

  // Cap the Java keyword router so a hung CLI never blocks the chat hook
  // forever. Unlike a bare Promise.race, the spawned process is killed on
  // timeout so a hung JVM is not leaked as an orphan holding its stdio pipes.
  let javaOut: string
  let javaProc: Bun.Subprocess<"pipe", "pipe", "ignore"> | null = null
  try {
    javaProc = spawnDetached(
      ["java", "--class-path", classpath, mainClass, "route"],
      { stdin: "pipe", stdout: "pipe", stderr: "ignore", env: routerEnv },
    )
    javaProc.stdin!.write(prompt)
    javaProc.stdin!.end()
    const kill = setTimeout(() => { try { killProcessTree(javaProc!) } catch {} }, JAVA_ROUTE_CAP_MS)
    javaOut = await Promise.race([
      new Response(javaProc.stdout).text().then(t => t.trim()),
      new Promise<string>(resolve => setTimeout(() => resolve(""), JAVA_ROUTE_CAP_MS)),
    ])
    clearTimeout(kill)
  } catch {
    javaOut = ""
  } finally {
    try { if (javaProc) killProcessTree(javaProc) } catch {}
  }
  if (!javaOut) {
    const fallback = {
      decision: "escalate",
      tier: "sonnet",
      fleet_models: [],
      reason: "classification failed — defaulting to sonnet",
      confidence: 0.5,
      rewritten_prompt: prompt,
      failed: true,
    }
    cacheSet(prompt, fallback)
    return fallback
  }
  try {
    const parsed = JSON.parse(javaOut)
    const result = {
      decision: parsed.decision ?? "escalate",
      tier: parsed.tier ?? "",
      fleet_models: parsed.fleet_models ?? [],
      reason: parsed.reason ?? "keyword classification",
      confidence: parsed.confidence ?? 0.5,
      rewritten_prompt: parsed.rewritten_prompt ?? prompt,
    }
    cacheSet(prompt, result)
    return result
  } catch {
    const fallback = {
      decision: "escalate",
      tier: "sonnet",
      fleet_models: [],
      reason: "classification failed — defaulting to sonnet",
      confidence: 0.5,
      rewritten_prompt: prompt,
      failed: true,
    }
    cacheSet(prompt, fallback)
    return fallback
  }
}

/**
 * Whether the expensive LLM classifier is worth running for a prompt. Cheap,
 * deterministic gate: short prompts and prompts that are clearly single,
 * mechanical actions (the FABLE/HAIKU band) skip the LLM round-trip and go
 * straight to the Java keyword router. Keeps the common trivial prompt path
 * sub-second instead of a multi-second spawned `opencode run`.
 */
function shouldUseLlm(prompt: string): boolean {
  const p = prompt.trim()
  if (p.length === 0) return false
  if (p.length < 40) return false
  // Explicitly mechanical, single-scope actions never need LLM reasoning.
  if (/^(fix|rename|add|remove|delete|close|sort|format|lint|convert|insert|change|update|append|run|set|reset|revert)\b/i.test(p)) return false
  return true
}

async function checkAmbiguity(prompt: string): Promise<string | null> {
  const result = await safeSpawn(
    ["java", "--class-path", classpath, mainClass, "ambiguity"],
    { input: prompt, env: routerEnv },
  )
  const stdout = result.stdout.trim()
  if (stdout.startsWith("ambiguous:")) {
    return stdout.substring(10)
  }
  return null
}

const TIER_DIRECTIVES: Record<string, string[]> = {
  fable: ["Be concise. Answer directly. Minimize output tokens."],
  haiku: [
    "Be concise. Answer directly. Minimize output tokens.",
    "If uncertain or missing info, say so explicitly. Never invent facts or fabricate output.",
  ],
  sonnet: [
    "Be concise. Answer directly. Minimize output tokens.",
    "REQUIRED OUTPUT: Return usable results — direct results OR file path OR action summary with specifics. Never complete silently.",
  ],
  opus: [
    "Be concise. Answer directly. Minimize output tokens.",
    "REQUIRED OUTPUT: Return usable results — direct results OR file path OR action summary with specifics. Never complete silently.",
    "If uncertain or missing info, say so explicitly. Never invent facts or fabricate output.",
  ],
}

function buildPromptContext(result: {
  decision: string
  tier: string
  fleet_models: string[]
  reason: string
  confidence: number
  rewritten_prompt: string
}): string {
  const rewritten = result.rewritten_prompt
  const problems: string[] = []

  if (/^(can you|could you|would you|i want|i need|help me|maybe|perhaps|possibly)\b/i.test(rewritten)) {
    problems.push("weak opener — converted to a direct imperative")
  }
  if (/—{2,}/.test(rewritten)) {
    problems.push("excessive em-dashes — replaced for clarity")
  }
  if (/\b(the relationship):/i.test(rewritten)) {
    problems.push("template language — simplified")
  }
  if (result.confidence < 0.4) {
    problems.push(`low routing confidence (${result.confidence.toFixed(2)}) — prompt may lack specificity`)
  }

  const problemBlock = problems.length > 0
    ? `Prompt problems identified:\n${problems.map(p => `- ${p}`).join("\n")}`
    : "Prompt problems identified: none."

  const tierDirectives = TIER_DIRECTIVES[result.tier] ?? TIER_DIRECTIVES.sonnet
  const directiveBlock = `Prompt standards to apply:\n${tierDirectives.map(d => `- ${d}`).join("\n")}`

  const classification = `Classification: ${result.decision} (confidence ${result.confidence.toFixed(2)}). ${result.reason}.`
  const fleet = result.fleet_models.length
    ? `\nFleet model(s): ${result.fleet_models.join(", ")}`
    : ""

  return `<prompt-annotation>
The user's request below is annotated to the highest prompt standard. Apply the standards and problem fixes below when answering. Do NOT dispatch to another agent — handle the user's request directly.

${problemBlock}

${directiveBlock}

${classification}${fleet}

User's request (authoritative):
"""
${rewritten}
"""
</prompt-annotation>`
}

/** Lean mode: just the rewritten prompt plus the tier's directives, with no
 * self-quote annotation block. Keeps the message single-prompt and minimal. */
function buildLeanRewrite(result: {
  decision: string
  tier: string
  fleet_models: string[]
  reason: string
  confidence: number
  rewritten_prompt: string
}): string {
  const tierDirectives = TIER_DIRECTIVES[result.tier] ?? TIER_DIRECTIVES.sonnet
  const lines = [
    `<tier-router:${result.tier} conf=${result.confidence.toFixed(2)}>`,
    ...tierDirectives.map(d => `- ${d}`),
  ]
  if (result.fleet_models.length) lines.push(`- fleet: ${result.fleet_models.join(", ")}`)
  lines.push("", result.rewritten_prompt)
  return lines.join("\n")
}

export default async ({ client, directory, worktree }: Parameters<Plugin>[0]) => {
  const logger = createLogger(client, "tier-router")
  logger.info("plugin active — 3 tools + prompt-annotation hook (chat.message)")
  // Prepare the isolated classification data home once at load (mkdir + README).
  // Null means LLM classification is disabled (dir could not be created); we
  // must never fall back to the real session log.
  const classifyDataDir = prepareClassifyDataDir(logger)

  // Dedup set of already-annotated message IDs. A Map (insertion-ordered) lets
  // us evict oldest in O(1) via keys().next(), avoiding a parallel array.
  const rewritten = new Map<string, true>()
  const REWRITTEN_MAX = 10_000

  /** Record a message as handled, evicting the oldest entry once bounded. */
  function markRewritten(messageID: string): void {
    if (rewritten.has(messageID)) return
    rewritten.set(messageID, true)
    if (rewritten.size > REWRITTEN_MAX) {
      const oldest = rewritten.keys().next().value
      if (oldest !== undefined) rewritten.delete(oldest)
    }
  }

  return {
    "chat.message": async (input, output) => {
      // A plugin-loaded child opencode process (launched headlessly for
      // classification below) must never re-launch its own classifier — that
      // would spawn an unbounded recursion storm. Guards mirror agentmem.
      if (process.env[NO_SUBSPAWN_ENV] === "1") return

      const textPart = output.parts.find(p => p.type === "text") as { id: string; sessionID: string; messageID: string; text: string } | undefined
      if (!textPart) return
      if (!textPart.text.trim()) return

      // Annotation (and the rewrite) is opt-in via TIER_ROUTER_ANNOTATE=1.
      // When unset, leave the user's message byte-for-byte untouched — the hook
      // is a no-op and costs nothing beyond this check.
      if (process.env[ANNOTATE_ENV] !== "1") return

      // Dedup per message, not per session: a session carries multiple user
      // turns, each of which should be annotated at most once. The set only
      // tracks actually-annotated messages, so default (off) runs stay empty.
      const messageID = textPart.messageID || textPart.id
      if (rewritten.has(messageID)) return

      const result = await classifyPrompt(classifyDataDir, textPart.text)
      // Never inject a fabricated classification into the user's real message
      // when classification failed entirely — leave the message untouched.
      if (result.failed) return
      markRewritten(messageID)
      logger.info(`annotate ${JSON.stringify({ sessionID: textPart.sessionID, messageID, tier: result.tier, confidence: result.confidence })}`)

      // TIER_ROUTER_LEAN=1: send only the rewritten prompt + tier directives,
      // without the self-quote annotation block. Even leaner than replace.
      const annotation = process.env[LEAN_ENV] === "1"
        ? buildLeanRewrite(result)
        : buildPromptContext(result)
      // Replace, do not append: the annotation/rewrite is the message, so
      // substituting avoids a doubled prompt.
      textPart.text = annotation
    },

    tool: {
      "classify-prompt": tool({
        description: "Classify a prompt string into a reasoning tier (fable/haiku/sonnet/opus) with rewritten prompt. Use to test routing without executing.",
        args: {
          prompt: tool.schema.string().describe("The user prompt to classify"),
        },
        async execute(args) {
          // A plugin-loaded child opencode process must never re-launch the
          // classifier — that would re-enter the recursive spawn storm.
          if (process.env[NO_SUBSPAWN_ENV] === "1") return "Classification disabled in subprocess."
          const result = await classifyPrompt(classifyDataDir, args.prompt)
          return JSON.stringify(result, null, 2)
        },
      }),

      "rewrite-prompt": tool({
        description: "Rewrite a prompt for a specific tier with SOTA prompt engineering criteria (conciseness, clarity, uncertainty permission, output format).",
        args: {
          prompt: tool.schema.string().describe("The prompt to rewrite"),
          tier: tool.schema.enum(["fable", "haiku", "sonnet", "opus"])
            .default("sonnet")
            .describe("Target reasoning tier"),
        },
        async execute(args) {
          if (process.env[NO_SUBSPAWN_ENV] === "1") return "Rewrite disabled in subprocess."
          const result = await safeSpawn(
            ["java", "--class-path", classpath, mainClass, "rewrite", args.tier],
            { input: args.prompt, env: routerEnv },
          )
          return result.stdout.trim()
        },
      }),

      "check-ambiguity": tool({
        description: "Check if a prompt is ambiguous and needs user clarification. Returns clarification questions if so.",
        args: {
          prompt: tool.schema.string().describe("The user prompt to check"),
        },
        async execute(args) {
          if (process.env[NO_SUBSPAWN_ENV] === "1") return "Ambiguity check disabled in subprocess."
          const questions = await checkAmbiguity(args.prompt)
          if (questions) {
            return `⚠️ Ambiguous request detected. Clarification needed:\n\n${questions}`
          }
          return "✓ Prompt is unambiguous."
        },
      }),
    },
  }
}
