import type { Plugin, tool } from "@opencode-ai/plugin"
import { $ } from "bun"
import path from "path"

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

export default async ({ client, $: bunDollar, directory, worktree }: Parameters<Plugin>[0]) => {
  const root = worktree ?? directory
  console.log("[agentinsights] plugin active — 2 tools")

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
          const result = await $`${cmd}`.nothrow()
          const stdout = result.stdout.toString()
          const stderr = result.stderr.toString()
          if (stderr && stderr.trim().length > 0) console.error(stderr)

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
          const result = await $`java --class-path ${classesDir} ${mainClass} status ${insDir}`.nothrow().text()
          return result.trim()
        },
      }),
    },
  }
}
