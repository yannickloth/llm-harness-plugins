import type { Config, Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { z } from "zod"
import { createLogger } from "../../shared/plugin-logger"
import { moduleDir } from "../../shared/module-dir"
import { registerSkillDir } from "../../shared/v2-skills"
import { registerAgentDirV1, registerAgentDirV2 } from "../../shared/agents"
import { safeSpawn } from "../../shared/safe-spawn"
import fs from "fs"
import path from "path"
import { STE100_MARKER, STE100_RULE } from "./ste100-rule"
import { CALC_MARKER, CALC_RULE } from "./calc-rule"
import {
  ENGINES,
  detectOsFamily,
  formatOutcome,
  formatProbeReport,
  installPlan,
  noEngineProposal,
  pickEngine,
  probeEngines,
  runEngine,
  type Availability,
  type EngineId,
  type OsFamily,
  type SpawnFn,
} from "./calc-tool"
import { writeLoadCanary } from "../../shared/load-canary"

const skillsDir = path.resolve(moduleDir(import.meta.url, import.meta.dir), "..", "skills")
const agentsDir = path.resolve(moduleDir(import.meta.url, import.meta.dir), "..", "agents")

function skillCount(dir: string): number {
  if (!fs.existsSync(dir)) return 0
  return fs
    .readdirSync(dir)
    .filter(entry => {
      const d = path.join(dir, entry)
      return fs.statSync(d).isDirectory() && fs.existsSync(path.join(d, "SKILL.md"))
    }).length
}

// ---------------------------------------------------------------------------
// v1 entrypoint. v1 appended the skills directory to `config.skills.paths` and
// prepended the STE100 rule via `experimental.chat.system.transform`.
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// calc wiring — one implementation, shared by the v1 and v2 tool registrations.
//
// Availability is probed once per plugin instance (six `--version` spawns in
// parallel, tens of ms) and cached: engines do not appear mid-session. Every
// failure path returns a proposal, never a number — the point of the tool is
// that a result is computed, and the plugin must not become the arithmetic.
// ---------------------------------------------------------------------------

const spawnEngine: SpawnFn = (argv, input) => safeSpawn(argv, { input })

const PROBE_TTL_MS = 10 * 60 * 1000
let probeCache: { at: number; value: Promise<Availability> } | null = null

function probeEnginesCached(): Promise<Availability> {
  const now = Date.now()
  if (probeCache && now - probeCache.at < PROBE_TTL_MS) return probeCache.value
  const value = probeEngines(spawnEngine)
  probeCache = { at: now, value }
  // A failed probe must not poison later calls.
  value.catch(() => {
    if (probeCache?.value === value) probeCache = null
  })
  return value
}

function hostOsFamily(): OsFamily {
  return detectOsFamily(
    p => {
      try {
        return fs.readFileSync(p, "utf8")
      } catch {
        return null
      }
    },
    process.platform,
  )
}

const CALC_TOOL_DESCRIPTION =
  "Evaluate a math expression with a real calculator engine (qalc by default: units, currencies, " +
  "symbolic diff/solve/factor/matrix, statistics, dates, number bases). Deterministic — call this " +
  "instead of computing arithmetic yourself, and quote the returned engine + expression when you " +
  "report the number. Returns `FAILED ...` on a bad expression: never report a number from a " +
  "failed run. Integration needs CAS: use engine=maxima or sympy. For dimension-checked physics " +
  "use engine=numbat."

const CALC_PROBE_DESCRIPTION =
  "Report which calculator engines (qalc, numbat, bc, python, sympy, maxima) are installed on this " +
  "host, and for every missing one, the exact install command for this OS. Call it once per session " +
  "before relying on a calculator, and whenever `calc` reports an engine is missing: propose the " +
  "install to the user instead of computing by hand."

async function calcImpl(expr: string, engine?: string): Promise<string> {
  const trimmed = expr.trim()
  if (!trimmed) return "FAILED: empty expression. Provide an expression to evaluate."
  const avail = await probeEnginesCached()
  const family = hostOsFamily()
  const requested = engine && engine !== "auto" ? (engine as EngineId) : null
  const id = requested ?? pickEngine(trimmed, avail)
  if (!id) return noEngineProposal(family)
  if (!avail[id]) {
    const spec = ENGINES[id]
    return [
      `engine "${id}" is not installed.`,
      `install: ${installPlan(id, family).join(" ")}`,
      `capabilities: ${spec.good}`,
      `limits: ${spec.limits}`,
      "Propose this install to the user and ask which engine to run. Do not substitute a mental estimate, and do not quietly answer at a lower precision to dodge the tool.",
    ].join("\n")
  }
  const outcome = await runEngine(id, trimmed, spawnEngine)
  return formatOutcome(outcome, trimmed)
}

async function calcProbeImpl(): Promise<string> {
  const avail = await probeEnginesCached()
  return formatProbeReport(avail, hostOsFamily())
}

const ENGINE_ARG_VALUES = ["auto", ...Object.keys(ENGINES)] as unknown as [string, ...string[]]

const v1Factory: Plugin = async ({ client }) => {
  writeLoadCanary("general-skills")
  const logger = createLogger(client, "general-skills")
  const count = skillCount(skillsDir)
  logger.info(`plugin active — skill self-registration (${count} skills in ${skillsDir})`)

  return {
    config: async (input: Config) => {
      const skills = (input as any).skills ?? {}
      const paths: string[] = Array.isArray(skills.paths) ? [...skills.paths] : []
      if (count > 0 && !paths.includes(skillsDir)) paths.push(skillsDir)
      ;(input as any).skills = { ...skills, paths }

      registerAgentDirV1(input, agentsDir)
    },
    "experimental.chat.system.transform": async (
      _input: unknown,
      output: { system: string[] },
    ) => {
      if (!output.system.some(s => s.includes(STE100_MARKER))) {
        output.system = [STE100_RULE, ...output.system]
      }
      if (!output.system.some(s => s.includes(CALC_MARKER))) {
        output.system = [CALC_RULE, ...output.system]
      }
    },
    tool: {
      calc: tool({
        description: CALC_TOOL_DESCRIPTION,
        args: {
          expr: z.string().describe("expression in the engine's own syntax, e.g. '150 km/h to mph' (qalc) or '150 km/h -> mph' (numbat)"),
          engine: z.enum(ENGINE_ARG_VALUES).optional().describe("engine to use; default auto = best installed (qalc first)"),
        },
        async execute(args) {
          return await calcImpl(args.expr, args.engine)
        },
      }),
      calc_probe: tool({
        description: CALC_PROBE_DESCRIPTION,
        args: {},
        async execute() {
          return await calcProbeImpl()
        },
      }),
    },
  }
}

// ---------------------------------------------------------------------------
// v2 entrypoint (docs/build/plugins/migrate-v1): `id` + `setup(ctx)`, with v1
// served by `server`. v2 has no config hook (skills → `ctx.skill.transform`,
// shared/v2-skills.ts) and hands the system prompt to
// `ctx.session.hook("context")` as `event.system` parts.
// ---------------------------------------------------------------------------
export default {
  id: "general-skills",

  async setup(ctx: any) {
    writeLoadCanary("general-skills")
    await ctx.skill.transform((editor: any) => registerSkillDir(editor, skillsDir))
    await ctx.agent.transform((editor: any) => registerAgentDirV2(editor, agentsDir))

    await ctx.session.hook("context", (event: any) => {
      if (!Array.isArray(event.system)) return
      const parts: Array<{ type: string; text: string }> = event.system
      if (!parts.some(p => (p.text ?? "").includes(STE100_MARKER))) {
        event.system.unshift({ type: "text", text: STE100_RULE })
      }
      if (!parts.some(p => (p.text ?? "").includes(CALC_MARKER))) {
        event.system.unshift({ type: "text", text: CALC_RULE })
      }
    })

    await ctx.tool.transform((editor: any) => {
      editor.add({
        name: "calc",
        description: CALC_TOOL_DESCRIPTION,
        input: {
          type: "object",
          properties: {
            expr: { type: "string", description: "expression in the engine's own syntax, e.g. '150 km/h to mph' (qalc) or '150 km/h -> mph' (numbat)" },
            engine: { type: "string", enum: ENGINE_ARG_VALUES as string[], description: "engine to use; default auto = best installed (qalc first)" },
          },
          required: ["expr"],
          additionalProperties: false,
        },
        async execute(args: any) {
          return { content: await calcImpl(args?.expr ?? "", args?.engine) }
        },
      })
      editor.add({
        name: "calc_probe",
        description: CALC_PROBE_DESCRIPTION,
        input: { type: "object", properties: {}, additionalProperties: false },
        async execute() {
          return { content: await calcProbeImpl() }
        },
      })
    })
  },

  async server(input: any, options?: any) {
    return v1Factory(input, options)
  },
}
