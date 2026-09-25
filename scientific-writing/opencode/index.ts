import { type Config, type Plugin } from "@opencode-ai/plugin"
import { createLogger } from "../../shared/plugin-logger"
import { moduleDir } from "../../shared/module-dir"
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

export default async ({ client }: Parameters<Plugin>[0]) => {
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
