// agentinsights — session analytics + AI insights report (2 tools).
//
// Dual-version entrypoint (the harness idiom used by datetime-inject and
// guardrail-chain): `setup(ctx)` is the OpenCode v2 path; `server(input)` is the
// v1 path. v1 requires a callable plugin and v2 requires an object default, so
// the object carries both — v1 calls `server`, v2 calls `setup`. No duplicate
// implementation and no version detection needed.
import { type Plugin, tool } from "@opencode-ai/plugin"
import path from "path"
import { createLogger } from "../../shared/plugin-logger"
import { safeSpawn } from "../../shared/safe-spawn"
import { moduleDir } from "../../shared/module-dir"
import { writeLoadCanary } from "../../shared/load-canary"

const agentinsightsDir = path.join(moduleDir(import.meta.url, import.meta.dir), "..")
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

// ---------------------------------------------------------------------------
// v1 entrypoint.
// ---------------------------------------------------------------------------
const v1Factory: Plugin = async ({ client, directory, worktree }) => {
  writeLoadCanary("agentinsights")
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

// ---------------------------------------------------------------------------
// v2 entrypoint. Differences: tools are added through `ctx.tool.transform`
// with JSON Schema inputs, `execute` returns a structured `{ content }`, and
// there is no `client` — the root comes from `ctx.location`.
// ---------------------------------------------------------------------------
const str = (description: string) => ({ type: "string", description })

export default {
  id: "agentinsights",

  async setup(ctx: any) {
    writeLoadCanary("agentinsights")
    const root: string = ctx.location?.project?.canonical ?? ctx.location?.directory
    const sessionsDir = path.join(root, ".opencode", "sessions")
    const insights = path.join(root, ".agentmem", "insights")

    await ctx.tool.transform((editor: any) => {
      editor.add({
        name: "run-insights",
        description:
          "Run session analytics and generate an AI-powered insights report from session transcripts. Scans all sessions, extracts structured facets via LLM, and builds an HTML report with narrative analysis.",
        input: {
          type: "object",
          properties: {
            platform: {
              type: "string",
              enum: ["opencode", "claude", "generic"],
              default: "opencode",
              description: "Platform name for feature suggestions",
            },
            session_path: str("Override session directory path"),
          },
          additionalProperties: false,
        },
        async execute(args: any) {
          const sessDir: string = args.session_path || sessionsDir
          const cmd = [
            "java", "--class-path", classesDir,
            mainClass, "run",
            "--session-dir", sessDir,
            "--insights-dir", insights,
            "--platform", args.platform ?? "opencode",
          ]
          const result = await safeSpawn(cmd)
          const stdout: string = result.stdout ?? ""
          const stderr: string = result.stderr ?? ""
          if (stderr.trim().length > 0) console.error(`agentinsights: ${stderr.trim()}`)

          if (stdout.startsWith("REPORT ")) {
            const reportPath = stdout.substring(7, stdout.indexOf("\n"))
            return { content: `Insights report generated: ${reportPath}\n\n${stdout.substring(stdout.indexOf("\n") + 1)}` }
          }
          return { content: stdout.trim() || "Insights report generation started." }
        },
      })

      editor.add({
        name: "insights-status",
        description: "Check insights cache status — how many sessions have been scanned and faceted.",
        input: { type: "object", properties: {}, additionalProperties: false },
        async execute() {
          const result = await safeSpawn(["java", "--class-path", classesDir, mainClass, "status", insights])
          return { content: (result.stdout ?? "").trim() }
        },
      })
    })
  },

  async server(input: any, options?: any) {
    return v1Factory(input, options)
  },
}
