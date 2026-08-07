import type { Plugin } from "@opencode-ai/plugin"
import { buildContext, DEFAULT_FLAGS, hasAnyMarker, type Flags } from "./helpers"

type InjectOptions = {
  flags?: Partial<Flags>
  injectIntoUserMessage?: boolean
  injectIntoSystem?: boolean
}

function resolvedFlags(opts: InjectOptions): Flags {
  return { ...DEFAULT_FLAGS, ...(opts.flags ?? {}) }
}

export default async (
  { worktree, directory }: Parameters<Plugin>[0],
  options: InjectOptions = {},
) => {
  const root = worktree ?? directory
  const flags = resolvedFlags(options)
  const injectIntoUserMessage = options.injectIntoUserMessage ?? true
  const injectIntoSystem = options.injectIntoSystem ?? true

  console.log(
    "[datetime-inject] plugin active — injects datetime, platform, toolchain into every LLM prompt",
  )

  return {
    "chat.message": async (_input: unknown, output: { parts: Array<{ type: string; text: string }> }) => {
      if (!injectIntoUserMessage) return
      const textPart = output.parts.find(p => p.type === "text")
      if (!textPart || !textPart.text.trim()) return
      const ctx = buildContext(root, flags)
      if (!ctx) return
      textPart.text = `${ctx}\n\n${textPart.text}`
    },

    "experimental.chat.system.transform": async (
      _input: unknown,
      output: { system: string[] },
    ) => {
      if (!injectIntoSystem) return
      if (hasAnyMarker(output.system)) return
      const ctx = buildContext(root, flags)
      if (!ctx) return
      output.system = [ctx, ...output.system]
    },
  }
}
