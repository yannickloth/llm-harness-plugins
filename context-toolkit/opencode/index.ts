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
// registered the plugin's agents on `config.agent` (shared/agents.ts).
// ---------------------------------------------------------------------------
const v1Factory: Plugin = async ({ client }) => {
  writeLoadCanary("context-toolkit")
  const logger = createLogger(client, "context-toolkit")
  const count = skillCount(skillsDir)
  logger.info(`plugin active — ${count} skill(s)`)

  return {
    config: async (input: Config) => {
      const skills = (input as any).skills ?? {}
      const paths: string[] = Array.isArray(skills.paths) ? [...skills.paths] : []
      if (count > 0 && !paths.includes(skillsDir)) paths.push(skillsDir)
      ;(input as any).skills = { ...skills, paths }

      registerAgentDirV1(input, agentsDir)
    },
  }
}

// ---------------------------------------------------------------------------
// v2 entrypoint (docs/build/plugins/migrate-v1): `id` + `setup(ctx)`, with v1
// served by `server`. v2 has no config hook, so skills are replayed into
// `ctx.skill.transform` (shared/v2-skills.ts) and agents into
// `ctx.agent.transform` (shared/agents.ts).
// ---------------------------------------------------------------------------
export default {
  id: "context-toolkit",

  async setup(ctx: any) {
    writeLoadCanary("context-toolkit")
    await ctx.skill.transform((editor: any) => registerSkillDir(editor, skillsDir))
    await ctx.agent.transform((editor: any) => registerAgentDirV2(editor, agentsDir))
  },

  async server(input: any, options?: any) {
    return v1Factory(input, options)
  },
}
