import type { PiPlugin } from "@pi-ai/plugin"

export default function (pi: PiPlugin) {
  console.log("[tier-router] Pi plugin active")

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
