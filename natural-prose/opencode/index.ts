import { type Config, type Plugin } from "@opencode-ai/plugin"
import fs from "fs"
import path from "path"
import { createLogger } from "../../shared/plugin-logger"
import { moduleDir } from "../../shared/module-dir"

const skillsDir = path.resolve(moduleDir(import.meta.url, import.meta.dir), "..", "skills")

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

export default async ({ client }: Parameters<Plugin>[0]) => {
  const logger = createLogger(client, "natural-prose")
  const count = skillCount(skillsDir)
  logger.info(`plugin active — natural prose skill self-registration (${count} skills in ${skillsDir})`)

  return {
    config: async (input: Config) => {
      const skills = (input as any).skills ?? {}
      const paths: string[] = Array.isArray(skills.paths) ? [...skills.paths] : []
      if (count > 0 && !paths.includes(skillsDir)) paths.push(skillsDir)
      ;(input as any).skills = { ...skills, paths }
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
