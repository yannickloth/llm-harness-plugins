import { type Plugin, tool } from "@opencode-ai/plugin"
import { $ } from "bun"
import path from "path"
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs"
import { createLogger } from "../../shared/plugin-logger"
import { moduleDir } from "../../shared/module-dir"
import { extractFilePath } from "./helpers"
import { writeLoadCanary } from "../../shared/load-canary"

const pluginDir = path.join(moduleDir(import.meta.url, import.meta.dir), "..")
const classesDir = path.join(pluginDir, "build", "classes")
const mainClass = "eu.infolead.llmhp.sdlcguardrails.SdlcGuardrailsCli"

const FIX_STATE_REL = ".sdlc-guardrails/fix-scope.json"

function java(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const allArgs = ["java", "--class-path", classesDir, mainClass, ...args]
  return $`${allArgs}`.nothrow().quiet()
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

// ---------------------------------------------------------------------------
// v1 entrypoint (legacy function form).
// ---------------------------------------------------------------------------
const v1Factory: Plugin = async ({ client, directory, worktree }) => {
  writeLoadCanary("sdlc-guardrails")
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

// ---------------------------------------------------------------------------
// v2 entrypoint (docs/build/plugins/migrate-v1): `id` + `setup(ctx)`, with v1
// served by `server`. v2 differences: no `client` (root from `ctx.location`,
// logging to stderr); `tool.execute.before/after` → `ctx.tool.hook(...)`; the
// tool map → `ctx.tool.transform` with JSON Schema inputs; `command.execute.before`
// has no v2 equivalent, so the /sdlc-fix and /sdlc-plan toggles are detected on
// the `prompt` hook (best-effort — a missed toggle only changes the fix-scope
// default, never blocks a tool).
// ---------------------------------------------------------------------------
function consoleLogger(service: string) {
  return {
    debug: (_m: string) => {},
    info: (m: string) => console.error(`[${service}] ${m}`),
    warn: (m: string) => console.error(`[${service}] WARN ${m}`),
    error: (m: string) => console.error(`[${service}] ERROR ${m}`),
  }
}

export default {
  id: "sdlc-guardrails",

  async setup(ctx: any) {
    writeLoadCanary("sdlc-guardrails")
    const logger = consoleLogger("sdlc-guardrails")
    const root: string = ctx.location?.project?.canonical ?? ctx.location?.directory

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

    await ctx.tool.hook("execute.before", async (event: any) => {
      const toolName: string = event?.tool ?? event?.name
      const args = event?.input ?? event?.args ?? {}
      const sessionID: string | undefined = event?.sessionID ?? event?.session?.id

      if (toolName === "bash" || toolName === "shell") {
        // Gate write operations inside shell commands (cp/mv/rm/sed -i/tee/redirects)
        const command = typeof args.command === "string" ? args.command
          : typeof args.cmd === "string" ? args.cmd : ""
        if (!command) return

        if (/\bgit\s+commit\b/.test(command)) {
          const vres = await java(["verify", root])
          let vv: any = null
          try { vv = JSON.parse(vres.stdout.trim()) } catch { return }
          if (vv?.verdict === "block") {
            logger.error(`BLOCKED ${vv.rule} (commit gate): ${vv.reason ?? ""}`)
            throw new Error(`sdlc-guardrails ${vv.rule}: ${vv.reason}`)
          }
        }

        const fix = loadFixSessions(root).has(sessionID ?? "")
        const res = await java(["check-cmd", root, command, String(fix), sessionID ?? ""])
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
      const target = extractFilePath(args)
      if (!target) return

      const v = await guardCheck(toolName, target, sessionID ?? "")
      if (!v) return
      if (v.verdict === "block") {
        logger.error(`BLOCKED ${v.rule}: ${target} — ${v.reason ?? ""}`)
        throw new Error(`sdlc-guardrails ${v.rule}: ${v.reason}`)
      }
      if (v.verdict === "warn") {
        logger.warn(`${v.rule}: ${target} — ${v.reason ?? ""}`)
      }
    })

    await ctx.tool.hook("execute.after", async (event: any) => {
      const toolName: string = event?.tool ?? event?.name
      if (toolName !== "edit" && toolName !== "write") return
      const target = extractFilePath(event?.input ?? event?.args ?? {})
      if (!target) return
      const sessionID: string | undefined = event?.sessionID ?? event?.session?.id
      const v = await guardCheck(toolName, target, sessionID ?? "")
      if (v && v.rule) {
        logger.info(`${v.rule} ${v.verdict} on ${target}`)
      }
    })

    // v1 used command.execute.before; v2 has no equivalent global hook, so the
    // toggle is detected on the submitted prompt text (best-effort).
    await ctx.session.hook("prompt", (event: any) => {
      const text: string = event?.prompt?.text ?? ""
      const sessionID: string | undefined = event?.sessionID
      if (!sessionID) return
      const m = text.trim().match(/^\/(sdlc-fix|sdlc-plan)\b/)
      if (!m) return
      const set = loadFixSessions(root)
      if (m[1] === "sdlc-fix") {
        set.add(sessionID)
        saveFixSessions(root, set)
        logger.info(`fix scope ON for session ${sessionID}`)
      } else {
        set.delete(sessionID)
        saveFixSessions(root, set)
        logger.info(`fix scope OFF for session ${sessionID}`)
      }
    })

    const emptyInput = { type: "object", properties: {}, additionalProperties: false } as const

    await ctx.tool.transform((editor: any) => {
      editor.add({
        name: "sdlc-check",
        description:
          "Run SDLC artifact-contract checks (protected paths, test protection, plan sync) on a target path. Returns a verdict: pass | warn | block.",
        input: {
          type: "object",
          properties: { target: { type: "string", description: "File path to check against the repo contract" } },
          required: ["target"],
          additionalProperties: false,
        },
        async execute(args: any) {
          const res = await guardCheck("edit", args.target, "")
          return { content: JSON.stringify(res ?? { verdict: "pass", rule: null, reason: null }) }
        },
      })

      editor.add({
        name: "sdlc-status",
        description:
          "Report the repo's SDLC contract status: which artifacts exist (intent/spec/plan), whether enforcement is active, and the audit-log size.",
        input: emptyInput,
        async execute() {
          const res = await java(["status", root])
          return { content: res.stdout.trim() }
        },
      })

      editor.add({
        name: "sdlc-audit",
        description: "Tail the SDLC guardrail audit log (verdicts recorded for blocked/warned actions).",
        input: {
          type: "object",
          properties: { limit: { type: "number", description: "Max number of audit entries to return" } },
          additionalProperties: false,
        },
        async execute(args: any) {
          const limit = args.limit ?? 20
          const res = await java(["audit", root, String(limit)])
          return { content: res.stdout.trim() }
        },
      })

      editor.add({
        name: "sdlc-sync",
        description:
          "Check a code diff against the committed plan.md (R1). Lists changed files that are in/out of the declared plan scope. Optionally pass a base ref; defaults to the branch merge-base with main/master.",
        input: {
          type: "object",
          properties: { base: { type: "string", description: "Base git ref to diff from (default: branch merge-base with main/master)" } },
          additionalProperties: false,
        },
        async execute(args: any) {
          const res = await java(["sync", root, args.base ?? "-"])
          return { content: res.stdout.trim() }
        },
      })

      editor.add({
        name: "sdlc-verify",
        description:
          "Check verification-before-done (R6): is there fresh, all-green verification evidence (eval-loop snapshot)? Blocks git commits when requireVerification is on and evidence is missing/stale/red.",
        input: emptyInput,
        async execute() {
          const res = await java(["verify", root])
          return { content: res.stdout.trim() }
        },
      })

      editor.add({
        name: "sdlc-incident",
        description:
          "Close the Maintain -> Plan loop: write an incident record and scaffold a new intent.md capturing the breached control band.",
        input: {
          type: "object",
          properties: { description: { type: "string", description: "What happened; which control band was breached" } },
          required: ["description"],
          additionalProperties: false,
        },
        async execute(args: any) {
          const res = await java(["incident", root, args.description ?? ""])
          return { content: res.stdout.trim() }
        },
      })
    })
  },

  async server(input: any, options?: any) {
    return v1Factory(input, options)
  },
}
