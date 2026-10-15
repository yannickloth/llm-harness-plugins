import { type Config, type Plugin } from "@opencode-ai/plugin"
import { createLogger } from "../../shared/plugin-logger"
import { moduleDir } from "../../shared/module-dir"
import { registerSkillDir } from "../../shared/v2-skills"
import fs from "fs"
import path from "path"
import { writeLoadCanary } from "../../shared/load-canary"

const skillsDir = path.resolve(moduleDir(import.meta.url, import.meta.dir), "..", "skills")

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
// v1 entrypoint. v1 appended the skills directory to `config.skills.paths`.
// ---------------------------------------------------------------------------
const v1Factory: Plugin = async ({ client }) => {
  writeLoadCanary("scientific-writing")
  const logger = createLogger(client, "scientific-writing")
  const count = skillCount(skillsDir)
  logger.info(`plugin active — skill self-registration (${count} skills in ${skillsDir})`)

  return {
    config: async (input: Config) => {
      const skills = (input as any).skills ?? {}
      const paths: string[] = Array.isArray(skills.paths) ? [...skills.paths] : []
      if (count > 0 && !paths.includes(skillsDir)) paths.push(skillsDir)
      ;(input as any).skills = { ...skills, paths }
    },
  }
}

// ---------------------------------------------------------------------------
// v2 entrypoint (docs/build/plugins/migrate-v1): `id` + `setup(ctx)`, with v1
// served by `server`. v2 has no config hook, so the skills directory is
// replayed into `ctx.skill.transform` (shared/v2-skills.ts).
// ---------------------------------------------------------------------------
export default {
  id: "scientific-writing",

  async setup(ctx: any) {
    writeLoadCanary("scientific-writing")
    await ctx.skill.transform((editor: any) => registerSkillDir(editor, skillsDir))
  },

  async server(input: any, options?: any) {
    return v1Factory(input, options)
  },
}
