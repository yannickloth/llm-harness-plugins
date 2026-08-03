import type { PiPlugin } from "@pi-ai/plugin"
import { join } from "node:path"

function findTierRouterDir(): string {
  return join(import.meta.dir, "..")
}

function generateRoutingDirective(result: {
  decision: string
  tier: string
  fleet_models: string[]
  reason: string
  confidence: number
  rewritten_prompt: string
}): string {
  const fleetModels = result.fleet_models ?? []
  const hasFleet = fleetModels.length > 0

  if (result.decision === "escalate") {
    return `<routing-recommendation>
ROUTING DIRECTIVE — MANDATORY ACTION REQUIRED. No interpretation allowed.

Decision: ESCALATE
Target: router agent
Reason: ${result.reason}
Confidence: ${result.confidence.toFixed(2)}

ACTION INSTRUCTIONS:
- You MUST NOT handle this request directly
- You MUST use the Task tool to invoke a router agent (sonnet-general or the project router)
- You MUST NOT ask clarifying questions about routing
- Execute immediately with no hesitation

ORIGINAL PROMPT (rewritten): ${result.rewritten_prompt}
</routing-recommendation>`
  }

  if (hasFleet) {
    const [initial, specialist] = fleetModels
    const specialistLine = specialist
      ? `\n  2 [SPECIALIST]: ${specialist}\n  If ${initial} fails to converge after 2 rounds, escalate to ${specialist} — quality-specialist for this skill axis.`
      : ""

    return `<routing-recommendation>
ROUTING DIRECTIVE — MANDATORY ACTION REQUIRED. No interpretation allowed.

Decision: DIRECT
Skill Axis Match — Fleet Models (try in order):
  1 [INITIAL]:  ${initial}${specialistLine}
Reason: ${result.reason}
Confidence: ${result.confidence.toFixed(2)}

ACTION INSTRUCTIONS:
- You MUST NOT handle this request directly
- You MUST use the Task tool to invoke an agent using model: ${initial}
- You MUST pass the user's original request below
- You MUST NOT ask clarifying questions
- Execute immediately with no hesitation

ORIGINAL PROMPT: ${result.rewritten_prompt}
</routing-recommendation>`
  }

  return `<routing-recommendation>
ROUTING DIRECTIVE — MANDATORY ACTION REQUIRED. No interpretation allowed.

Decision: DIRECT
Target tier: ${result.tier}-general
Reason: ${result.reason}
Confidence: ${result.confidence.toFixed(2)}

ACTION INSTRUCTIONS:
- You MUST NOT handle this request directly
- You MUST use the Task tool to invoke the ${result.tier}-general agent
- You MUST pass the rewritten prompt below to the agent
- You MUST NOT ask clarifying questions
- Execute immediately with no hesitation

REWRITTEN PROMPT: ${result.rewritten_prompt}
</routing-recommendation>`
}

export default function (pi: PiPlugin) {
  console.log("[tier-router] Pi plugin active")

  const tierRouterDir = findTierRouterDir()
  const classpath = join(tierRouterDir, "build", "classes")

  let rewriteDone = false

  pi.on("session_start", (_event: any, _ctx: any) => {
    rewriteDone = false
  })

  pi.on("context", async (event: any, _ctx: any) => {
    if (rewriteDone) return undefined
    rewriteDone = true

    const messages: any[] = event.messages ?? []
    const lastUserIdx = messages.length - 1 - messages.slice().reverse().findIndex((m: any) => m.role === "user")
    if (lastUserIdx < 0) return undefined

    const userMsg = messages[lastUserIdx]
    const textContent = userMsg.content?.find((c: any) => c.type === "text")
    if (!textContent) return undefined

    const prompt = textContent.text
    if (!prompt?.trim()) return undefined

    try {
      const result = await pi.exec(`TIER_ROUTER_SKIP_LLM=true java --class-path ${classpath} eu.infolead.llmhp.router.RouterCli route`, undefined, prompt)
      const routing = JSON.parse(result.stdout)
      const directive = generateRoutingDirective(routing)
      console.log("[tier-router] rewrite", { tier: routing.tier, confidence: routing.confidence })

      const newContent = [{ type: "text", text: directive }]
      return { messages: [...messages.slice(0, lastUserIdx), { ...userMsg, content: newContent }, ...messages.slice(lastUserIdx + 1)] }
    } catch (e) {
      console.error("[tier-router] classification error:", (e as Error).message)
      return undefined
    }
  })

  pi.registerTool({
    name: "classify-prompt",
    description: "Classify a prompt into a reasoning tier: fable, haiku, sonnet, or opus.",
    parameters: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "The user prompt to classify" }
      },
      required: ["prompt"]
    },
    async execute({ prompt }: { prompt: string }) {
      const result = await pi.exec(`java --class-path build/classes eu.infolead.llmhp.router.RouterCli classify`, undefined, prompt)
      try {
        return JSON.parse(result.stdout)
      } catch {
        return { decision: "escalate", tier: "sonnet", reason: "classification_failed", confidence: 0.5 }
      }
    }
  })

  pi.registerTool({
    name: "rewrite-prompt",
    description: "Rewrite a prompt with SOTA prompt engineering criteria for a specific reasoning tier.",
    parameters: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "The prompt to rewrite" },
        tier: { type: "string", enum: ["fable", "haiku", "sonnet", "opus"], default: "sonnet" }
      },
      required: ["prompt"]
    },
    async execute({ prompt, tier }: { prompt: string; tier?: string }) {
      const result = await pi.exec(`java --class-path build/classes eu.infolead.llmhp.router.RouterCli rewrite ${tier || "sonnet"}`, undefined, prompt)
      return result.stdout.trim()
    }
  })

  pi.registerTool({
    name: "check-ambiguity",
    description: "Check if a prompt is ambiguous and needs user clarification.",
    parameters: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "The prompt to check" }
      },
      required: ["prompt"]
    },
    async execute({ prompt }: { prompt: string }) {
      const result = await pi.exec(`java --class-path build/classes eu.infolead.llmhp.router.RouterCli ambiguity`, undefined, prompt)
      const stdout = result.stdout.trim()
      if (stdout.startsWith("ambiguous:")) {
        return `⚠️ Ambiguous: ${stdout.substring(10)}`
      }
      return "✓ Prompt is unambiguous."
    }
  })
}
