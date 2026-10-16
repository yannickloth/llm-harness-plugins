import { type Config, type Plugin } from "@opencode-ai/plugin"
import { createLogger } from "../../shared/plugin-logger"
import { moduleDir } from "../../shared/module-dir"
import { registerSkillDir } from "../../shared/v2-skills"
import { registerAgentDirV1, registerAgentDirV2 } from "../../shared/agents"
import fs from "fs"
import path from "path"
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

function agentCount(dir: string): number {
  if (!fs.existsSync(dir)) return 0
  return fs.readdirSync(dir).filter(entry => entry.endsWith(".md")).length
}

// ---------------------------------------------------------------------------
// v1 entrypoint. v1 appended the skills directory to `config.skills.paths` and
// registered the agent files on `config.agent` (shared/agents.ts). An explicit
// entry already present in a repo's `opencode.json` is preserved — that is the
// user's override (pinned model, reasoning effort, …).
// ---------------------------------------------------------------------------
const v1Factory: Plugin = async ({ client }) => {
  writeLoadCanary("scientific-writing")
  const logger = createLogger(client, "scientific-writing")
  const count = skillCount(skillsDir)
  const agents = agentCount(agentsDir)
  logger.info(`plugin active — ${count} skill(s), ${agents} agent(s) in ${agentsDir}`)

  return {
    config: async (input: Config) => {
      const skills = (input as any).skills ?? {}
      const paths: string[] = Array.isArray(skills.paths) ? [...skills.paths] : []
      if (count > 0 && !paths.includes(skillsDir)) paths.push(skillsDir)
      ;(input as any).skills = { ...skills, paths }

      const added = registerAgentDirV1(input, agentsDir)
      if (added > 0) logger.info(`registered ${added} agent(s) on config.agent`)
    },
  }
}

// ---------------------------------------------------------------------------
// v2 entrypoint (docs/build/plugins/migrate-v1): `id` + `setup(ctx)`, with v1
// served by `server`. v2 has no config hook. Skills are replayed into
// `ctx.skill.transform` (shared/v2-skills.ts) and agents into
// `ctx.agent.transform` (shared/agents.ts), where `editor.update(id, …)`
// creates the agent when the id is absent — no symlinks, no files.
// ---------------------------------------------------------------------------
export default {
  id: "scientific-writing",

  async setup(ctx: any) {
    writeLoadCanary("scientific-writing")
    await ctx.skill.transform((editor: any) => registerSkillDir(editor, skillsDir))
    await ctx.agent.transform((editor: any) => registerAgentDirV2(editor, agentsDir))
  },

  async server(input: any, options?: any) {
    return v1Factory(input, options)
  },
}
