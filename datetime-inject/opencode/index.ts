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

  logger.info(`plugin active — datetime per message: ${injectDatetimePerMessage}; platform/toolchain per session`)

  return {
    "chat.message": async (
      _input: unknown,
      output: { parts: Array<{ type: string; text: string }> },
    ) => {
      if (!injectIntoUserMessage || !injectDatetimePerMessage) return
      const textPart = output.parts.find(p => p.type === "text")
      if (!textPart || !textPart.text.trim()) return
      const ctx = buildPerMessageContext(flags)
      if (!ctx) return
      textPart.text = `${ctx}\n\n${textPart.text}`
    },

    "experimental.chat.system.transform": async (
      _input: unknown,
      output: { system: string[] },
    ) => {
      if (!injectIntoSystem) return
      if (hasAnyMarker(output.system)) return
      const ctx = injectDatetimePerMessage
        ? buildStaticContext(root, flags)
        : buildSessionContext(root, flags)
      if (!ctx) return
      output.system = [ctx, ...output.system]
    },
  }
}
