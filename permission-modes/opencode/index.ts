import type { Plugin } from "@opencode-ai/plugin"
import { $ } from "bun"
import path from "path"
import { createLogger } from "../../shared/plugin-logger"

export default async ({ client, directory, worktree }: Parameters<Plugin>[0]) => {
  const logger = createLogger(client, "permission-modes")
  const root = worktree ?? directory
  const pluginDir = path.join(import.meta.dir, "..")
  const classesDir = path.join(pluginDir, "build", "classes")
  const mainClass = "eu.infolead.llmhp.permissionmodes.PermissionModesCli"

  logger.info("plugin active — 6-mode state machine with centralized transitionPermissionMode")

  function java(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return $`java --class-path ${classesDir} ${mainClass} ${args}`.nothrow().quiet()
      .then(r => ({ stdout: r.stdout.toString(), stderr: r.stderr.toString(), exitCode: r.exitCode }))
  }

  function extractFilePath(args: Record<string, unknown> | undefined, toolName: string): string {
    if (!args) return ""
    if (toolName === "edit" || toolName === "write") {
      return (args.filePath as string) || (args.path as string) || (args.file as string) || ""
    }
    if (toolName === "bash") {
      return (args.command as string) || ""
    }
    if (toolName === "read" || toolName === "task") {
      return (args.file_path as string) || (args.filePath as string) || ""
    }
    return ""
  }

  return {
    "tool.execute.before": async (event: { tool: string; args: Record<string, unknown> }) => {
      const toolName = event.tool
      const filePath = extractFilePath(event.args, toolName)

      try {
        const result = await java(["check", root, toolName, filePath])
        const parsed = JSON.parse(result.stdout.trim())

        if (parsed.allowed === true) {
          return { allowed: true, reason: parsed.reason, promptUser: false, mode: parsed.mode }
        }
        if (parsed.promptUser === true) {
          return {
            allowed: undefined,
            reason: parsed.reason,
            promptUser: true,
            mode: parsed.mode,
          }
        }
        return { allowed: false, reason: parsed.reason, promptUser: false, mode: parsed.mode }
      } catch (e) {
        logger.error(`check failed: ${(e as Error).message}`)
        return { allowed: false, reason: "permission check error", promptUser: true, mode: "error" }
      }
    },

    tool: {
      "permission-mode": {
        description: "Transition to a permission mode (default, plan, acceptEdits, bypassPermissions, dontAsk, auto). Centralized mode-switch with BYPASS_IMMUNE safety checks and auto-mode strip/restore.",
        args: {
          mode: {
            type: "string",
            description: "Target permission mode. One of: default, plan, acceptEdits, bypassPermissions, dontAsk, auto",
          },
        },
        async execute({ mode }: { mode: string }) {
          try {
            const result = await java(["transition", root, mode])
            return result.stdout.trim()
          } catch (e) {
            return JSON.stringify({ error: "transition failed", detail: String(e) })
          }
        },
      },

      "permission-status": {
        description: "Get current permission mode status — active mode, symbol, blocked categories, allow/deny lists.",
        args: {},
        async execute() {
          try {
            const result = await java(["status", root])
            return result.stdout.trim()
          } catch (e) {
            return JSON.stringify({ error: "status check failed", detail: String(e) })
          }
        },
      },

      "permission-state": {
        description: "Export full permission mode state as JSON (all 6 mode configs, bypass-immune patterns, current mode).",
        args: {},
        async execute() {
          try {
            const result = await java(["state", root])
            return result.stdout.trim()
          } catch (e) {
            return JSON.stringify({ error: "state export failed", detail: String(e) })
          }
        },
      },

      "permission-check": {
        description: "Check whether a tool is allowed in the current permission mode.",
        args: {
          tool: {
            type: "string",
            description: "Tool name (read, edit, bash, write, webfetch, task, skill, glob, grep, question, todo)",
          },
          filePath: {
            type: "string",
            description: "Optional file path to check for BYPASS_IMMUNE and CWD-scoping",
          },
        },
        async execute({ tool, filePath }: { tool: string; filePath?: string }) {
          try {
            const result = await java(["check", root, tool, filePath || ""])
            return result.stdout.trim()
          } catch (e) {
            return JSON.stringify({ error: "check failed", detail: String(e) })
          }
        },
      },
    },
  }
}
