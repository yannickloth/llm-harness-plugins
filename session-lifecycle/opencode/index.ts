import type { Plugin } from "@opencode-ai/plugin"
import { $ } from "bun"
import path from "path"
import { createLogger } from "../../shared/plugin-logger"

export default async ({ client, directory, worktree }: Parameters<Plugin>[0]) => {
  const logger = createLogger(client, "session-lifecycle")
  const root = worktree ?? directory
  const pluginDir = path.join(import.meta.dir, "..")
  const classesDir = path.join(pluginDir, "build", "classes")
  const mainClass = "SessionLifecycle"
  const jvmOpts = "--add-opens java.base/java.util=ALL-UNNAMED"

  logger.info("plugin active — lifecycle + file-access logging")

  const ACCESS_TOOLS: ReadonlySet<string> = new Set(["read", "edit", "write"])

  function accessTypeFor(tool: string): string | null {
    if (tool === "read") return "read"
    if (tool === "edit" || tool === "write") return "write"
    return null
  }

  function extractFilePath(args: Record<string, unknown>): string | null {
    if (typeof args.filePath === "string" && args.filePath) return args.filePath
    if (typeof args.file_path === "string" && args.file_path) return args.file_path
    if (typeof args.path === "string" && args.path) return args.path
    if (typeof args.file === "string" && args.file) return args.file
    return null
  }

  return {
    event: async ({ event }) => {
      switch (event.type) {
        case "session.created": {
          const sessionId = event.properties?.sessionID
          if (!sessionId) return
          await $`java ${jvmOpts} --class-path ${classesDir} ${mainClass} snapshot-commits ${root} ${sessionId}`.nothrow().quiet()
          await $`java ${jvmOpts} --class-path ${classesDir} ${mainClass} check-errors ${root}`.nothrow().quiet()
          break
        }
        case "session.idle": {
          const sessionId = event.properties?.sessionID
          if (!sessionId) return
          await $`java ${jvmOpts} --class-path ${classesDir} ${mainClass} diff-commits ${root} ${sessionId}`.nothrow().quiet()
          await $`java ${jvmOpts} --class-path ${classesDir} ${mainClass} archive ${root} ${sessionId}`.nothrow().quiet()
          break
        }
      }
    },

    "tool.execute.after": async (input: { tool: string; sessionID: string; args: any }, _output) => {
      const tool = input.tool
      const accessType = accessTypeFor(tool)
      if (!accessType) return
      const filePath = extractFilePath(input.args ?? {})
      if (!filePath) return
      await $`java ${jvmOpts} --class-path ${classesDir} ${mainClass} record-access ${root} ${input.sessionID} ${accessType} ${filePath}`.nothrow().quiet()
    },
  }
}
