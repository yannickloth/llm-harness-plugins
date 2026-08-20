import type { Plugin } from "@opencode-ai/plugin"
import { createLogger } from "../../shared/plugin-logger"

type MergeOptions = {
  providers?: string[]
  enabled?: boolean
}

export default async (
  { client }: Parameters<Plugin>[0],
  options: MergeOptions = {},
) => {
  const logger = createLogger(client, "system-message-merge")
  const providers = (options.providers ?? ["hetzner"]).map(p => p.toLowerCase())
  const enabled = options.enabled ?? true

  logger.info(`plugin active — coalescing system messages for providers: ${providers.join(", ")}`)

  return {
    "experimental.chat.system.transform": async (
      input: { model: { providerID: string } },
      output: { system: string[] },
    ) => {
      if (!enabled) return
      if (!input.model?.providerID) return
      if (!providers.includes(input.model.providerID.toLowerCase())) return
      if (!Array.isArray(output.system) || output.system.length <= 1) return
      const merged = output.system.filter(s => s.trim().length > 0)
      if (merged.length === 0) {
        output.system = []
        return
      }
      output.system = [merged.join("\n\n")]
      logger.debug(`coalesced ${merged.length} system messages into one for provider ${input.model.providerID}`)
    },
  }
}
