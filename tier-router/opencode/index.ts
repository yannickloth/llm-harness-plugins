import { type Plugin, tool } from "@opencode-ai/plugin"
import path from "path"
import { createLogger } from "../../shared/plugin-logger"
import { safeSpawn, spawnDetached, killProcessTree } from "../../shared/safe-spawn"

const pluginDir = path.join(import.meta.dir, "..")
const classesDir = path.join(pluginDir, "build", "classes")
const sharedClassesDir = path.join(pluginDir, "..", "shared", "build", "classes")
const classpath = `${classesDir}${path.delimiter}${sharedClassesDir}`
const mainClass = "eu.infolead.llmhp.router.RouterCli"
const routerEnv: Record<string, string> = {
  TIER_ROUTER_PLUGIN_ROOT: pluginDir,
}

const CLASSIFY_SYSTEM = [
  "You are a prompt classifier. Classify the user's task by reasoning complexity.",
  "Reply with ONLY one word: FABLE, HAIKU, SONNET, OPUS, or ESCALATE.",
  "FABLE: trivial single actions (close bracket, add semicolon, append text).",
  "HAIKU: mechanical edits with clear scope (fix typo, rename, format, lint).",
  "SONNET: reasoning/analysis required (analyze, implement, refactor, review, debug, explain).",
  "OPUS: deep formal reasoning (prove, formalize, math theorems, algorithm design).",
  "ESCALATE: ambiguous, unclear scope, multiple competing goals, or genuinely uncertain.",
].join("\n")

async function classifyViaOpencode(prompt: string): Promise<{ decision: string; tier: string; reason: string; confidence: number } | null> {
  // Classify in a detached, throwaway session via `opencode run --print`.
  // Never call session.prompt on the live session here: that would (a) append a
  // duplicate copy of the user's prompt and the classifier's reply into the real
  // conversation and (b) block the chat.message hook on a full LLM round-trip
  // using the session's own (possibly expensive) model. A headless run keeps the
  // live session clean and lets us pin a cheap model for this trivial task.
  const classifierPrompt = `${CLASSIFY_SYSTEM}\n\nTask to classify:\n"""\n${prompt.slice(0, 2000)}\n"""`
  let proc: ReturnType<typeof Bun.spawn> | null = null
  try {
    proc = spawnDetached(
      ["opencode", "run", "--model", process.env.TIER_ROUTER_CLASSIFY_MODEL ?? "deepseek/deepseek-v4-flash",
       "--print", "--title", "Tier classification", "--",
       "Classify the task in stdin per the system prompt. Reply with ONE word only."],
      { stdout: "pipe", stderr: "pipe" },
    )
    proc.stdin!.write(classifierPrompt)
    proc.stdin!.end()
    const kill = setTimeout(() => { try { killProcessTree(proc!) } catch {} }, 20_000)
    const out = await new Response(proc.stdout).text()
    clearTimeout(kill)
    const text = out.trim().toUpperCase()
    if (!text) return null
    if (text.includes("ESCALATE")) return { decision: "escalate", tier: "", reason: "LLM: uncertain scope", confidence: 0.7 }
    if (text.startsWith("FABLE")) return { decision: "direct", tier: "fable", reason: "LLM: trivial mechanical task", confidence: 0.9 }
    if (text.startsWith("HAIKU")) return { decision: "direct", tier: "haiku", reason: "LLM: mechanical edit with clear scope", confidence: 0.9 }
    if (text.startsWith("OPUS")) return { decision: "direct", tier: "opus", reason: "LLM: deep formal reasoning", confidence: 0.9 }
    if (text.startsWith("SONNET")) return { decision: "direct", tier: "sonnet", reason: "LLM: reasoning/analysis required", confidence: 0.9 }
    return null
  } catch (e) {
    console.warn(`[tier-router] opencode LLM classification failed: ${(e as Error).message}`)
    return null
  } finally {
    try { if (proc) killProcessTree(proc) } catch {}
  }
}

async function classifyPrompt(prompt: string): Promise<{
  decision: string
  tier: string
  fleet_models: string[]
  reason: string
  confidence: number
  rewritten_prompt: string
}> {
  const llm = await classifyViaOpencode(prompt)
  if (llm) {
    return {
      decision: llm.decision,
      tier: llm.tier,
      fleet_models: [],
      reason: llm.reason,
      confidence: llm.confidence,
      rewritten_prompt: prompt,
    }
  }

  const result = await safeSpawn(
    ["java", "--class-path", classpath, mainClass, "route"],
    { input: prompt, env: routerEnv },
  )
  const stdout = result.stdout.trim()
  try {
    const parsed = JSON.parse(stdout)
    return {
      decision: parsed.decision ?? "escalate",
      tier: parsed.tier ?? "",
      fleet_models: parsed.fleet_models ?? [],
      reason: parsed.reason ?? "keyword classification",
      confidence: parsed.confidence ?? 0.5,
      rewritten_prompt: parsed.rewritten_prompt ?? prompt,
    }
  } catch {
    return {
      decision: "escalate",
      tier: "sonnet",
      fleet_models: [],
      reason: "classification failed — defaulting to sonnet",
      confidence: 0.5,
      rewritten_prompt: prompt,
    }
  }
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

function buildPromptContext(result: {
  decision: string
  tier: string
  fleet_models: string[]
  reason: string
  confidence: number
  rewritten_prompt: string
}): string {
  const original = result.rewritten_prompt
  const problems: string[] = []

  if (/^(can you|could you|would you|i want|i need|help me|maybe|perhaps|possibly)\b/i.test(original)) {
    problems.push("weak opener — converted to a direct imperative")
  }
  if (/—{2,}/.test(original)) {
    problems.push("excessive em-dashes — replaced for clarity")
  }
  if (/\b(the relationship):/i.test(original)) {
    problems.push("template language — simplified")
  }
  if (result.confidence < 0.4) {
    problems.push(`low routing confidence (${result.confidence.toFixed(2)}) — prompt may lack specificity`)
  }

  const problemBlock = problems.length > 0
    ? `Prompt problems identified:\n${problems.map(p => `- ${p}`).join("\n")}`
    : "Prompt problems identified: none."

  const classification = `Classification: ${result.decision} (confidence ${result.confidence.toFixed(2)}). ${result.reason}.`

  return `<prompt-annotation>
The user's request below has been reformulated to the highest prompt standard. Treat the reformulated version as guidance for how to interpret and answer the user's words. Do NOT dispatch to another agent — handle the user's request directly.

${problemBlock}

${classification}

User's original request (authoritative):
"""
${original}
"""
</prompt-annotation>`
}

export default async ({ client, directory, worktree }: Parameters<Plugin>[0]) => {
  const logger = createLogger(client, "tier-router")
  logger.info("plugin active — 3 tools + auto-rewrite hook (chat.message)")

  const rewritten = new Set<string>()

  return {
    "chat.message": async (input, output) => {
      const sessionID = input.sessionID
      if (rewritten.has(sessionID)) return
      rewritten.add(sessionID)

      const textPart = output.parts.find(p => p.type === "text") as { id: string; sessionID: string; messageID: string; text: string } | undefined
      if (!textPart) return
      if (!textPart.text.trim()) return

      const result = await classifyPrompt(textPart.text)
      logger.info(`annotate ${JSON.stringify({ sessionID, tier: result.tier, confidence: result.confidence })}`)

      const annotation = buildPromptContext(result)
      textPart.text = `${textPart.text}\n\n${annotation}`
    },

    tool: {
      "classify-prompt": tool({
        description: "Classify a prompt string into a reasoning tier (fable/haiku/sonnet/opus) with rewritten prompt. Use to test routing without executing.",
        args: {
          prompt: tool.schema.string().describe("The user prompt to classify"),
        },
        async execute(args) {
          const result = await safeSpawn(
            ["java", "--class-path", classpath, mainClass, "route"],
            { input: args.prompt, env: routerEnv },
          )
          const stdout = result.stdout.trim()
          try {
            return JSON.stringify(JSON.parse(stdout), null, 2)
          } catch {
            return JSON.stringify({
              decision: "escalate",
              tier: "sonnet",
              fleet_models: [],
              reason: "classification failed — defaulting to sonnet",
              confidence: 0.5,
              rewritten_prompt: args.prompt,
            }, null, 2)
          }
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
