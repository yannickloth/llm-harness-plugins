import { type Plugin, tool } from "@opencode-ai/plugin"
import { $ } from "bun"
import path from "path"
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs"
import { createLogger } from "../../shared/plugin-logger"
import { moduleDir } from "../../shared/module-dir"

const pluginDir = path.join(moduleDir(import.meta.url, import.meta.dir), "..")
const classesDir = path.join(pluginDir, "build", "classes")
const mainClass = "eu.infolead.llmhp.sdlcguardrails.SdlcGuardrailsCli"

const FIX_STATE_REL = ".sdlc-guardrails/fix-scope.json"

function java(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const allArgs = ["java", "--class-path", classesDir, mainClass, ...args]
  return $`${allArgs}`.nothrow().quiet()
}

export function extractFilePath(args: Record<string, unknown>): string | null {
  if (typeof args.filePath === "string" && args.filePath) return args.filePath
  if (typeof args.file_path === "string" && args.file_path) return args.file_path
  if (typeof args.path === "string" && args.path) return args.path
  if (typeof args.file === "string" && args.file) return args.file
  return null
}

/** Sessions currently declared in fix scope (persisted so it survives JVM restarts). */
function loadFixSessions(root: string): Set<string> {
  try {
    const p = path.join(root, FIX_STATE_REL)
    if (!existsSync(p)) return new Set()
    const data = JSON.parse(readFileSync(p, "utf-8"))
    return new Set(Array.isArray(data.sessions) ? data.sessions : [])
  } catch {
    return new Set()
  }
}

function saveFixSessions(root: string, sessions: Set<string>): void {
  try {
    const dir = path.join(root, ".sdlc-guardrails")
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, "fix-scope.json"), JSON.stringify({ sessions: [...sessions] }, null, 2))
  } catch {
    // state persistence must never break plugin behavior
  }
}

export default async ({ client, directory, worktree }: Parameters<Plugin>[0]) => {
  const logger = createLogger(client, "sdlc-guardrails")
  const root = worktree ?? directory

  logger.info("plugin active — SDLC artifact contract guardrails (R1 plan-sync, R2 protected-path, R3 test-protection)")

  /** Parse the JSON verdict from the CLI. */
  async function guardCheck(toolName: string, target: string | null, sessionID: string): Promise<{ verdict: string; rule: string | null; reason: string | null } | null> {
    if (!target) return null
    const fix = loadFixSessions(root).has(sessionID)
    const res = await java(["check", root, toolName, target, String(fix), sessionID])
    try {
      return JSON.parse(res.stdout.trim())
    } catch {
      return null
    }
  }

  return {
    "tool.execute.before": async (input: { tool: string; sessionID: string }, output: { args: any }) => {
      const toolName = input.tool
      if (toolName === "bash") {
        // Gate write operations inside shell commands (cp/mv/rm/sed -i/tee/redirects)
        const command = typeof output.args?.command === "string" ? output.args.command
          : typeof output.args?.cmd === "string" ? output.args.cmd : ""
        if (!command) return

        // R6: gate git commit on fresh verification evidence (when required).
        if (/\bgit\s+commit\b/.test(command)) {
          const vres = await java(["verify", root])
          let vv: any = null
          try { vv = JSON.parse(vres.stdout.trim()) } catch { return }
          if (vv?.verdict === "block") {
            logger.error(`BLOCKED ${vv.rule} (commit gate): ${vv.reason ?? ""}`)
            throw new Error(`sdlc-guardrails ${vv.rule}: ${vv.reason}`)
          }
        }

        const fix = loadFixSessions(root).has(input.sessionID)
        const res = await java(["check-cmd", root, command, String(fix), input.sessionID])
        let v: any = null
        try { v = JSON.parse(res.stdout.trim()) } catch { return }
        if (v?.verdict === "block") {
          logger.error(`BLOCKED ${v.rule} (bash): ${command} — ${v.reason ?? ""}`)
          throw new Error(`sdlc-guardrails ${v.rule}: ${v.reason}`)
        }
        if (v?.verdict === "warn") logger.warn(`${v.rule}: ${v.reason ?? ""}`)
        return
      }
      // Only path-writing tools are gated deterministically.
      if (toolName !== "edit" && toolName !== "write") return
      const target = extractFilePath(output.args ?? {})
      if (!target) return

      const v = await guardCheck(toolName, target, input.sessionID)
      if (!v) return
      if (v.verdict === "block") {
        logger.error(`BLOCKED ${v.rule}: ${target} — ${v.reason ?? ""}`)
        // Throwing aborts the tool execution (opencode treats a hook throw as a denial).
        throw new Error(`sdlc-guardrails ${v.rule}: ${v.reason}`)
      }
      if (v.verdict === "warn") {
        logger.warn(`${v.rule}: ${target} — ${v.reason ?? ""}`)
      }
    },

    "tool.execute.after": async (input: { tool: string; sessionID: string; args: any }) => {
      // Log a write for the audit trail (non-blocking).
      if (input.tool !== "edit" && input.tool !== "write") return
      const target = extractFilePath(input.args ?? {})
      if (!target) return
      const v = await guardCheck(input.tool, target, input.sessionID)
      if (v && v.rule) {
        logger.info(`${v.rule} ${v.verdict} on ${target}`)
      }
    },

    "command.execute.before": async (input: { command: string; sessionID: string }) => {
      const cmd = input.command?.trim() ?? ""
      if (cmd === "/sdlc-fix") {
        const set = loadFixSessions(root)
        set.add(input.sessionID)
        saveFixSessions(root, set)
        logger.info(`fix scope ON for session ${input.sessionID}`)
      } else if (cmd === "/sdlc-plan") {
        const set = loadFixSessions(root)
        set.delete(input.sessionID)
        saveFixSessions(root, set)
        logger.info(`fix scope OFF for session ${input.sessionID}`)
      }
    },

    tool: {
      "sdlc-check": tool({
        description: "Run SDLC artifact-contract checks (protected paths, test protection, plan sync) on a target path. Returns a verdict: pass | warn | block.",
        args: {
          target: tool.schema.string().describe("File path to check against the repo contract"),
        },
        async execute(args) {
          const res = await guardCheck("edit", args.target, "")
          return JSON.stringify(res ?? { verdict: "pass", rule: null, reason: null })
        },
      }),

      "sdlc-status": tool({
        description: "Report the repo's SDLC contract status: which artifacts exist (intent/spec/plan), whether enforcement is active, and the audit-log size.",
        args: {},
        async execute() {
          const res = await java(["status", root])
          return res.stdout.trim()
        },
      }),

      "sdlc-audit": tool({
        description: "Tail the SDLC guardrail audit log (verdicts recorded for blocked/warned actions).",
        args: {
          limit: tool.schema.number().optional().describe("Max number of audit entries to return"),
        },
        async execute(args) {
          const limit = args.limit ?? 20
          const res = await java(["audit", root, String(limit)])
          return res.stdout.trim()
        },
      }),

      "sdlc-sync": tool({
        description: "Check a code diff against the committed plan.md (R1). Lists changed files that are in/out of the declared plan scope. Optionally pass a base ref; defaults to the branch merge-base with main/master.",
        args: {
          base: tool.schema.string().optional().describe("Base git ref to diff from (default: branch merge-base with main/master)"),
        },
        async execute(args) {
          const res = await java(["sync", root, args.base ?? "-"])
          return res.stdout.trim()
        },
      }),

      "sdlc-verify": tool({
        description: "Check verification-before-done (R6): is there fresh, all-green verification evidence (eval-loop snapshot)? Blocks git commits when requireVerification is on and evidence is missing/stale/red.",
        args: {},
        async execute() {
          const res = await java(["verify", root])
          return res.stdout.trim()
        },
      }),

      "sdlc-incident": tool({
        description: "Close the Maintain -> Plan loop: write an incident record and scaffold a new intent.md capturing the breached control band.",
        args: {
          description: tool.schema.string().describe("What happened; which control band was breached"),
        },
        async execute(args) {
          const res = await java(["incident", root, args.description ?? ""])
          return res.stdout.trim()
        },
      }),
    },

    // Fix/build scope is a per-session concern; it is toggled via the /sdlc-fix
    // and /sdlc-plan commands in command.execute.before above (tools cannot carry
    // a sessionID in their execute callback).
  }
}
