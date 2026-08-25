import type { Plugin } from "@opencode-ai/plugin"
import { $ } from "bun"
import path from "path"
import { createLogger } from "../../shared/plugin-logger"
import { moduleDir } from "../../shared/module-dir"

export default async ({ client, directory, worktree }: Parameters<Plugin>[0]) => {
  const logger = createLogger(client, "permission-modes")
  const root = worktree ?? directory
  const pluginDir = path.join(moduleDir(import.meta.url, import.meta.dir), "..")
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
    "tool.execute.before": async (input: { tool: string }, output: { args: any }) => {
      const toolName = input.tool
      const filePath = extractFilePath(output.args, toolName)

      let parsed: any
      try {
        const result = await java(["check", root, toolName, filePath])
        parsed = JSON.parse(result.stdout.trim())
      } catch (e) {
        logger.error(`check failed: ${(e as Error).message}`)
        // Check infrastructure failure must not silently allow dangerous tools:
        // fail closed on tools whose check could not be evaluated.
        throw new Error(parsed ? `permission check error: ${parsed.reason ?? "unknown"}` : "permission check error")
      }
      // Tri-state from the Java CLI: allow (allowed=true), prompt (allowed=false
      // + promptUser=true), deny (allowed=false + promptUser=false). Under the
      // current plugin API (tool.execute.before → Promise<void>, throw to block),
      // we throw only on a genuine hard deny; allow and prompt both return
      // normally so opencode's own permission gate handles the prompt.
      if (parsed.allowed === false && parsed.promptUser !== true) {
        throw new Error(parsed.reason ?? "permission denied")
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
