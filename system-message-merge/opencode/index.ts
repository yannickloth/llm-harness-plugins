import type { Plugin } from "@opencode-ai/plugin"
import { createLogger } from "../../shared/plugin-logger"
import { writeLoadCanary } from "../../shared/load-canary"

type MergeOptions = {
  providers?: string[]
  enabled?: boolean
}

// ---------------------------------------------------------------------------
// v1 entrypoint (legacy function form).
// ---------------------------------------------------------------------------
const v1Factory = async (
  { client }: Parameters<Plugin>[0],
  options: MergeOptions = {},
) => {
  writeLoadCanary("system-message-merge")
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

// ---------------------------------------------------------------------------
// v2 entrypoint (docs/build/plugins/migrate-v1): `id` + `setup(ctx)`, with v1
// served by `server`. v1's `experimental.chat.system.transform` (a mutable
// `string[]`) becomes `ctx.session.hook("context")`, which exposes the system
// prompt as `event.system` parts; options now arrive as `ctx.options`.
// ---------------------------------------------------------------------------
export default {
  id: "system-message-merge",

  async setup(ctx: any) {
    writeLoadCanary("system-message-merge")
    const options = (ctx.options ?? {}) as MergeOptions
    const providers = (options.providers ?? ["hetzner"]).map(p => p.toLowerCase())
    const enabled = options.enabled ?? true

    await ctx.session.hook("context", (event: any) => {
      if (!enabled) return
      const providerID: string | undefined = event?.model?.providerID ?? event?.providerID
      if (!providerID) return
      if (!providers.includes(providerID.toLowerCase())) return
      const parts: Array<{ type: string; text: string }> = Array.isArray(event.system) ? event.system : []
      if (parts.length <= 1) return
      const merged = parts.filter(p => (p.text ?? "").trim().length > 0)
      if (!Array.isArray(event.system)) return
      if (merged.length === 0) {
        event.system.splice(0, event.system.length)
        return
      }
      event.system.splice(0, event.system.length, { type: "text", text: merged.map(p => p.text).join("\n\n") })
    })
  },

  async server(input: any, options?: any) {
    return v1Factory(input, options)
  },
}
