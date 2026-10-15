import type { Config, Plugin } from "@opencode-ai/plugin"
import { createLogger } from "../../shared/plugin-logger"
import { moduleDir } from "../../shared/module-dir"
import { registerSkillDir } from "../../shared/v2-skills"
import fs from "fs"
import path from "path"
import { STE100_MARKER, STE100_RULE } from "./ste100-rule"
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
// v1 entrypoint. v1 appended the skills directory to `config.skills.paths` and
// prepended the STE100 rule via `experimental.chat.system.transform`.
// ---------------------------------------------------------------------------
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
    },
    "experimental.chat.system.transform": async (
      _input: unknown,
      output: { system: string[] },
    ) => {
      if (output.system.some(s => s.includes(STE100_MARKER))) return
      output.system = [STE100_RULE, ...output.system]
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

    await ctx.session.hook("context", (event: any) => {
      const parts: Array<{ type: string; text: string }> = Array.isArray(event.system) ? event.system : []
      if (parts.some(p => (p.text ?? "").includes(STE100_MARKER))) return
      if (Array.isArray(event.system)) event.system.unshift({ type: "text", text: STE100_RULE })
    })
  },

  async server(input: any, options?: any) {
    return v1Factory(input, options)
  },
}
