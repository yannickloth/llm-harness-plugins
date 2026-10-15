import { type Config, type Plugin } from "@opencode-ai/plugin"
import fs from "fs"
import path from "path"
import { createLogger } from "../../shared/plugin-logger"
import { moduleDir } from "../../shared/module-dir"
import { registerSkillDir, parseFrontmatter } from "../../shared/v2-skills"
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

function agentFiles(dir: string): { name: string; file: string }[] {
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir)
    .filter(entry => entry.endsWith(".md"))
    .map(entry => ({ name: entry.replace(/\.md$/, ""), file: path.join(dir, entry) }))
}

// ---------------------------------------------------------------------------
// v1 entrypoint. v1 appended the skills directory to `config.skills.paths` and
// registered the plugin's agents on `config.agent`.
// ---------------------------------------------------------------------------
const v1Factory: Plugin = async ({ client }) => {
  writeLoadCanary("context-toolkit")
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

// ---------------------------------------------------------------------------
// v2 entrypoint (docs/build/plugins/migrate-v1): `id` + `setup(ctx)`, with v1
// served by `server`. v2 has no config hook, so skills are replayed into
// `ctx.skill.transform` (shared/v2-skills.ts) and agents into
// `ctx.agent.transform` (each file's body becomes the agent `system`).
// ---------------------------------------------------------------------------
function agentBody(raw: string): string {
  return raw.replace(/^---[\s\S]*?\n---\s*\n?/, "")
}

export default {
  id: "context-toolkit",

  async setup(ctx: any) {
    writeLoadCanary("context-toolkit")
    const records = agentFiles(agentsDir).map(({ name, file }) => {
      const raw = fs.readFileSync(file, "utf8")
      const { description } = parseFrontmatter(raw)
      return { name, description, system: agentBody(raw) }
    })

    await ctx.skill.transform((editor: any) => registerSkillDir(editor, skillsDir))

    await ctx.agent.transform((editor: any) => {
      for (const rec of records) {
        if (editor.get(rec.name)) continue
        editor.update(rec.name, (agent: any) => {
          agent.name = rec.name
          if (rec.description) agent.description = rec.description
          agent.mode = "subagent"
          agent.system = rec.system
        })
      }
    })
  },

  async server(input: any, options?: any) {
    return v1Factory(input, options)
  },
}
