import type { Plugin, tool } from "@opencode-ai/plugin"
import path from "path"
import { createLogger } from "../../shared/plugin-logger"
import { safeSpawn } from "../../shared/safe-spawn"

const agentinsightsDir = path.join(import.meta.dir, "..")
const classesDir = path.join(agentinsightsDir, "build", "classes")
const mainClass = "eu.infolead.llmhp.insights.InsightsCli"

function sessionDir(context: { worktree?: string; directory: string }): string {
  return context.worktree
    ? path.join(context.worktree, ".opencode", "sessions")
    : path.join(context.directory, ".opencode", "sessions")
}

function insightsDir(context: { worktree?: string; directory: string }): string {
  const root = context.worktree ?? context.directory
  return path.join(root, ".agentmem", "insights")
}

export default async ({ client, directory, worktree }: Parameters<Plugin>[0]) => {
  const logger = createLogger(client, "agentinsights")
  logger.info("plugin active — 2 tools")

  return {
    tool: {
      "run-insights": tool({
        description: "Run session analytics and generate an AI-powered insights report from session transcripts. Scans all sessions, extracts structured facets via LLM, and builds an HTML report with narrative analysis.",
        args: {
          platform: tool.schema.enum(["opencode", "claude", "generic"]).default("opencode")
            .describe("Platform name for feature suggestions"),
          session_path: tool.schema.string().optional()
            .describe("Override session directory path"),
        },
        async execute(args, context) {
          const sessDir = args.session_path || sessionDir(context)
          const insDir = insightsDir(context)

          const cmd = [
            "java", "--class-path", classesDir,
            mainClass, "run",
            "--session-dir", sessDir,
            "--insights-dir", insDir,
            "--platform", args.platform
          ]
          const result = await safeSpawn(cmd)
          const stdout = result.stdout
          const stderr = result.stderr
          if (stderr && stderr.trim().length > 0) logger.error(stderr.trim())

          if (stdout.startsWith("REPORT ")) {
            const reportPath = stdout.substring(7, stdout.indexOf("\n"))
            return `Insights report generated: ${reportPath}\n\n${stdout.substring(stdout.indexOf("\n") + 1)}`
          }
          return stdout.trim() || "Insights report generation started."
        },
      }),

      "insights-status": tool({
        description: "Check insights cache status — how many sessions have been scanned and faceted.",
        args: {},
        async execute(_args, context) {
          const insDir = insightsDir(context)
          const result = await safeSpawn(
            ["java", "--class-path", classesDir, mainClass, "status", insDir],
          )
          return result.stdout.trim()
        },
      }),
    },
  }
}
