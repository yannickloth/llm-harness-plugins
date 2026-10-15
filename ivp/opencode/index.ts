// ivp — self-registers the IVP skill pack (skills/*/SKILL.md).
//
// Dual-version entrypoint (harness idiom): `server(input)` is the v1 path,
// `setup(ctx)` the v2 path. v1 appended the skills directory to
// `config.skills.paths` in a config hook; v2 has no config hook, so the same
// directory is replayed into `ctx.skill.transform` via shared/v2-skills.ts.
import type { Config, Plugin } from "@opencode-ai/plugin"
import { createLogger } from "../../shared/plugin-logger"
import { moduleDir } from "../../shared/module-dir"
import { writeLoadCanary } from "../../shared/load-canary"
import { registerSkillDir } from "../../shared/v2-skills"
import fs from "fs"
import path from "path"

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
// v1 entrypoint.
// ---------------------------------------------------------------------------
const v1Factory: Plugin = async ({ client }) => {
  writeLoadCanary("ivp")
  const logger = createLogger(client, "ivp")
  const count = skillCount(skillsDir)
  logger.info(`plugin active — IVP skill self-registration (${count} skills in ${skillsDir})`)

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
// v2 entrypoint.
// ---------------------------------------------------------------------------
export default {
  id: "ivp",

  async setup(ctx: any) {
    writeLoadCanary("ivp")
    await ctx.skill.transform((editor: any) => registerSkillDir(editor, skillsDir))
  },

  async server(input: any, options?: any) {
    return v1Factory(input, options)
  },
}
