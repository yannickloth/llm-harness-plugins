import type { Plugin, tool } from "@opencode-ai/plugin"
import { $ } from "bun"
import path from "path"

const pluginDir = path.join(import.meta.dir, "..")
const classesDir = path.join(pluginDir, "build", "classes")
const mainClass = "eu.infolead.llmhp.router.RouterCli"

async function classifyPrompt(prompt: string): Promise<{
  decision: string
  tier: string
  reason: string
  confidence: number
  rewritten_prompt: string
}> {
  const result = await $`java --class-path ${classesDir} ${mainClass} route`.nothrow().stdin(prompt)
  const stdout = result.stdout.toString().trim()
  try {
    return JSON.parse(stdout)
  } catch {
    return {
      decision: "escalate",
      tier: "sonnet",
      reason: "classification failed — defaulting to sonnet",
      confidence: 0.5,
      rewritten_prompt: prompt,
    }
  }
}

async function checkAmbiguity(prompt: string): Promise<string | null> {
  const result = await $`java --class-path ${classesDir} ${mainClass} ambiguity`.nothrow().stdin(prompt)
  const stdout = result.stdout.toString().trim()
  if (stdout.startsWith("ambiguous:")) {
    return stdout.substring(10)
  }
  return null
}

function generateRoutingDirective(result: {
  decision: string
  tier: string
  reason: string
  confidence: number
  rewritten_prompt: string
}): string {
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

export default async ({ client, directory, worktree }: Parameters<Plugin>[0]) => {
  const root = worktree ?? directory
  console.log("[tier-router] plugin active — 3 tools (classify-prompt, rewrite-prompt, check-ambiguity)")

  return {
    tool: {
      "classify-prompt": tool({
        description: "Classify a prompt string into a reasoning tier (fable/haiku/sonnet/opus) with rewritten prompt. Use to test routing without executing.",
        args: {
          prompt: tool.schema.string().describe("The user prompt to classify"),
        },
        async execute(args) {
          const result = await classifyPrompt(args.prompt)
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
          const result = await $`java --class-path ${classesDir} ${mainClass} rewrite ${args.tier}`.nothrow().stdin(args.prompt)
          return result.stdout.toString().trim()
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
