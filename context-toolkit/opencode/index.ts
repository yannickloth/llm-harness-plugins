import { type Config, type Plugin } from "@opencode-ai/plugin"
import fs from "fs"
import path from "path"
import { createLogger } from "../../shared/plugin-logger"
import { moduleDir } from "../../shared/module-dir"

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

function agentFiles(dir: string): { name: string; file: string }[] {
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir)
    .filter(entry => entry.endsWith(".md"))
    .map(entry => ({ name: entry.replace(/\.md$/, ""), file: path.join(dir, entry) }))
}

export default async ({ client }: Parameters<Plugin>[0]) => {
  const logger = createLogger(client, "context-toolkit")
  const count = skillCount(skillsDir)
  const agents = agentFiles(agentsDir)
  logger.info(`plugin active — ${count} skill(s), ${agents.length} agent(s)`)

  return {
    config: async (input: Config) => {
      const skills = (input as any).skills ?? {}
      const paths: string[] = Array.isArray(skills.paths) ? [...skills.paths] : []
      if (count > 0 && !paths.includes(skillsDir)) paths.push(skillsDir)
      ;(input as any).skills = { ...skills, paths }

      const existingAgents = (input as any).agent ?? {}
      for (const a of agents) {
        if (!existingAgents[a.name]) existingAgents[a.name] = { file: a.file, mode: "subagent" }
      }
      ;(input as any).agent = existingAgents
    },
  }
}
