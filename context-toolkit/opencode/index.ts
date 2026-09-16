import { type Config, type Plugin } from "@opencode-ai/plugin"
import fs from "fs"
import path from "path"
import { createLogger } from "../../shared/plugin-logger"
import { moduleDir } from "../../shared/module-dir"

const skillsDir = path.join(moduleDir(import.meta.url, import.meta.dir), "..", "skills")
const agentsDir = path.join(moduleDir(import.meta.url, import.meta.dir), "..", "agents")

function extractName(file: string, dirName: string): string {
  const content = fs.readFileSync(file, "utf-8")
  if (!content.startsWith("---")) return dirName
  const endIdx = content.indexOf("---", 3)
  if (endIdx === -1) return dirName
  const fm = content.slice(3, endIdx)
  const m = fm.match(/^name:\s*(.+)$/m)
  return m ? m[1].trim() : dirName
}

function entries(dir: string): Record<string, { file: string }> {
  const result: Record<string, { file: string }> = {}
  if (!fs.existsSync(dir)) return result
  for (const entry of fs.readdirSync(dir)) {
    const d = path.join(dir, entry)
    if (!fs.statSync(d).isDirectory()) continue
    const md = path.join(d, "SKILL.md")
    if (!fs.existsSync(md)) continue
    try {
      const name = extractName(md, entry)
      result[name] = { file: path.relative(path.join(dir, "../.."), md) }
    } catch {}
  }
  return result
}

function agentEntries(dir: string): Record<string, { file: string }> {
  const result: Record<string, { file: string }> = {}
  if (!fs.existsSync(dir)) return result
  for (const entry of fs.readdirSync(dir)) {
    if (!entry.endsWith(".md")) continue
    const p = path.join(dir, entry)
    try {
      const name = extractName(p, entry.replace(/\.md$/, ""))
      result[name] = { file: path.relative(path.join(dir, "../.."), p) }
    } catch {}
  }
  return result
}

export default async ({ client }: Parameters<Plugin>[0]) => {
  const logger = createLogger(client, "context-toolkit")
  const skills = entries(skillsDir)
  const agents = agentEntries(agentsDir)
  logger.info(`plugin active — ${Object.keys(skills).length} skill(s), ${Object.keys(agents).length} agent(s)`)

  return {
    config: async (input: Config) => {
      const existingSkills = (input as any).skills ?? {}
      const existingAgents = (input as any).agents ?? {}
      ;(input as any).skills = { ...existingSkills, ...skills }
      ;(input as any).agents = { ...existingAgents, ...agents }
    },
  }
}
