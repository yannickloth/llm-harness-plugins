import { type Config, type Plugin } from "@opencode-ai/plugin"
import fs from "fs"
import path from "path"
import { createLogger } from "../../shared/plugin-logger"
import { moduleDir } from "../../shared/module-dir"
import { registerSkillDir } from "../../shared/v2-skills"
import { registerAgentDirV1, registerAgentDirV2 } from "../../shared/agents"
import { writeLoadCanary } from "../../shared/load-canary"

const skillsDir = path.resolve(moduleDir(import.meta.url, import.meta.dir), "..", "skills")
const agentsDir = path.resolve(moduleDir(import.meta.url, import.meta.dir), "..", "agents")

// The deterministic prose analyzer lives in the sibling general-skills plugin.
// Resolve its absolute path once at plugin load (import.meta.dir = <root>/natural-prose/opencode).
const analyzerDir = path.join(moduleDir(import.meta.url, import.meta.dir), "..", "..", "general-skills", "tools")
const analyzerPath = () => path.join(analyzerDir, "ProsePatternAnalyzer.java")

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
// v1 entrypoint.
// ---------------------------------------------------------------------------
const v1Factory: Plugin = async ({ client }) => {
  writeLoadCanary("natural-prose")
  const logger = createLogger(client, "natural-prose")
  const count = skillCount(skillsDir)
  logger.info(`plugin active — natural prose skill self-registration (${count} skills in ${skillsDir})`)

  return {
    config: async (input: Config) => {
      const skills = (input as any).skills ?? {}
      const paths: string[] = Array.isArray(skills.paths) ? [...skills.paths] : []
      if (count > 0 && !paths.includes(skillsDir)) paths.push(skillsDir)
      ;(input as any).skills = { ...skills, paths }

      registerAgentDirV1(input, agentsDir)
    },
    tool: {
      "naturalize-analyzer-path": {
        description: "Resolve the absolute path to the deterministic prose analyzer (ProsePatternAnalyzer.java). Returns 'NOT FOUND: <path>' if the file is missing. Use this instead of hardcoding or searching for the analyzer path.",
        args: {},
        async execute() {
          const p = analyzerPath()
          if (fs.existsSync(p)) {
            return p
          }
          return `NOT FOUND: ${p}`
        },
      },
    },
  }
}

// ---------------------------------------------------------------------------
// v2 entrypoint (docs/build/plugins/migrate-v1): `id` + `setup(ctx)`, with v1
// served by `server`. v2 has no config hook (skills → `ctx.skill.transform`)
// and the tool map becomes `ctx.tool.transform` with a JSON Schema input.
// ---------------------------------------------------------------------------
export default {
  id: "natural-prose",

  async setup(ctx: any) {
    writeLoadCanary("natural-prose")
    await ctx.skill.transform((editor: any) => registerSkillDir(editor, skillsDir))
    await ctx.agent.transform((editor: any) => registerAgentDirV2(editor, agentsDir))

    await ctx.tool.transform((editor: any) => {
      editor.add({
        name: "naturalize-analyzer-path",
        description:
          "Resolve the absolute path to the deterministic prose analyzer (ProsePatternAnalyzer.java). Returns 'NOT FOUND: <path>' if the file is missing. Use this instead of hardcoding or searching for the analyzer path.",
        input: { type: "object", properties: {}, additionalProperties: false },
        async execute() {
          const p = analyzerPath()
          if (fs.existsSync(p)) return { content: p }
          return { content: `NOT FOUND: ${p}` }
        },
      })
    })
  },

  async server(input: any, options?: any) {
    return v1Factory(input, options)
  },
}
