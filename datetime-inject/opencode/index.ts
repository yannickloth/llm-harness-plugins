import type { Plugin } from "@opencode-ai/plugin"
import {
  buildSessionContext,
  buildStaticContext,
  buildPerMessageContext,
  DEFAULT_FLAGS,
  hasAnyMarker,
  type Flags,
} from "./helpers"
import { createLogger } from "../../shared/plugin-logger"
import { shouldInjectProjectContext, updateSessionTopic, getSessionTopic } from "../../shared/session-topic"
import { writeLoadCanary } from "../../shared/load-canary"

type InjectOptions = {
  flags?: Partial<Flags>
  injectIntoUserMessage?: boolean
  injectIntoSystem?: boolean
  /**
   * If true (default), a fresh datetime is prepended to each user message.
   * If false, nothing is injected per message — all context (datetime +
   * platform + toolchain) lives once in the system prompt.
   */
  injectDatetimePerMessage?: boolean
  /**
   * If true (default), only inject context into sessions classified as
   * project-related. Personal/non-coding sessions are left alone.
   */
  topicGate?: boolean
}

function resolvedFlags(opts: InjectOptions): Flags {
  return { ...DEFAULT_FLAGS, ...(opts.flags ?? {}) }
}

const v1Factory = async (
  { client, worktree, directory }: Parameters<Plugin>[0],
  options: InjectOptions = {},
) => {
  writeLoadCanary("datetime-inject")
  const logger = createLogger(client, "datetime-inject")
  const root = worktree ?? directory
  const flags = resolvedFlags(options)
  const injectIntoUserMessage = options.injectIntoUserMessage ?? true
  const injectIntoSystem = options.injectIntoSystem ?? true
  const injectDatetimePerMessage = options.injectDatetimePerMessage ?? true
  const topicGate = options.topicGate ?? true

  logger.info(`plugin active — datetime per message: ${injectDatetimePerMessage}; platform/toolchain per session; topic gate: ${topicGate}`)

  const seenSession = new Set<string>()

  return {
    "chat.message": async (
      input: { sessionID: string },
      output: { parts: Array<{ type: string; text: string }> },
    ) => {
      if (!injectIntoUserMessage || !injectDatetimePerMessage) return
      const textPart = output.parts.find(p => p.type === "text")
      if (!textPart || !textPart.text.trim()) return
      updateSessionTopic(input.sessionID, textPart.text)
      if (topicGate && !shouldInjectProjectContext(input.sessionID)) return
      // The first user message of a session determines opencode's auto-title.
      // Prepending datetime boilerplate there makes the model title the
      // session from "[current datetime: ...]" instead of the user's intent.
      if (!seenSession.has(input.sessionID)) {
        seenSession.add(input.sessionID)
        return
      }
      const ctx = buildPerMessageContext(flags)
      if (!ctx) return
      textPart.text = `${ctx}\n\n${textPart.text}`
    },

    "experimental.chat.system.transform": async (
      input: { sessionID?: string },
      output: { system: string[] },
    ) => {
      if (!injectIntoSystem) return
      const sid = (input as any).sessionID
      // System prompt runs before the first user message is classified, so we
      // only suppress it when a session is explicitly personal. Per-message
      // injection is suppressed for both personal and unknown sessions.
      if (topicGate && sid && getSessionTopic(sid) === "personal") return
      if (hasAnyMarker(output.system)) return
      const ctx = injectDatetimePerMessage
        ? buildStaticContext(root, flags)
        : buildSessionContext(root, flags)
      if (!ctx) return
      output.system = [ctx, ...output.system]
    },
  }
}

// ---------------------------------------------------------------------------
// OpenCode v2 entrypoint (docs/build/plugins/migrate-v1). Loaders differ: v1
// calls `server(input)` (the legacy factory above); v2 loads `id` + `setup(ctx)`
// and registers the same behavior through session hooks. v2 hook shapes were
// verified against opencode 2.0.29: prompt = {sessionID, prompt:{text,...}} and
// context = {sessionID, system:[{type,text}], ...}.
// ---------------------------------------------------------------------------
export default {
  id: "datetime-inject",
  async setup(ctx: any) {
    writeLoadCanary("datetime-inject")
    const root: string = ctx.location?.project?.canonical ?? ctx.location?.directory
    const options: InjectOptions = (ctx.options ?? {}) as InjectOptions
    const flags = resolvedFlags(options)
    const injectIntoUserMessage = options.injectIntoUserMessage ?? true
    const injectIntoSystem = options.injectIntoSystem ?? true
    const injectDatetimePerMessage = options.injectDatetimePerMessage ?? true
    const topicGate = options.topicGate ?? true
    const seenSession = new Set<string>()

    await ctx.session.hook("prompt", (event: any) => {
      if (!injectIntoUserMessage || !injectDatetimePerMessage) return
      const text: string | undefined = event.prompt?.text
      if (!text || !text.trim()) return
      updateSessionTopic(event.sessionID, text)
      if (topicGate && !shouldInjectProjectContext(event.sessionID)) return
      if (!seenSession.has(event.sessionID)) {
        seenSession.add(event.sessionID)
        return
      }
      const c = buildPerMessageContext(flags)
      if (!c) return
      event.prompt.text = `${c}\n\n${text}`
    })

    await ctx.session.hook("context", (event: any) => {
      if (!injectIntoSystem) return
      const sid: string | undefined = event.sessionID
      if (topicGate && sid && getSessionTopic(sid) === "personal") return
      const parts: Array<{ type: string; text: string }> = Array.isArray(event.system) ? event.system : []
      if (hasAnyMarker(parts.map(p => p.text))) return
      const c = injectDatetimePerMessage
        ? buildStaticContext(root, flags)
        : buildSessionContext(root, flags)
      if (!c) return
      event.system = [{ type: "text", text: c }, ...parts]
    })
  },
  async server(input: any) {
    return v1Factory(input)
  },
}
