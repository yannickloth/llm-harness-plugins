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

export default async (
  { client, worktree, directory }: Parameters<Plugin>[0],
  options: InjectOptions = {},
) => {
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
