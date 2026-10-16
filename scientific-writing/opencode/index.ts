import { type Config, type Plugin } from "@opencode-ai/plugin"
import { createLogger } from "../../shared/plugin-logger"
import { moduleDir } from "../../shared/module-dir"
import { registerSkillDir } from "../../shared/v2-skills"
import {
  agentConfigEntries,
  agentTransformRecords,
  ensureAgentLinks,
  globalAgentDir,
} from "../../shared/agent-links"
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

/** Agent auto-linking is on by default; set this to opt out. */
const linksDisabled = () => process.env.SCIENTIFIC_WRITING_NO_AGENT_LINKS === "1"

// ---------------------------------------------------------------------------
// v1 entrypoint. v1 appended the skills directory to `config.skills.paths`.
// Agent files are additionally injected onto `config.agent`: OpenCode drops an
// agent file's `description` frontmatter when the agent is wired through a
// `{file:}` prompt reference, and an agent with no description is not
// enumerable as a subagent, so the description is supplied explicitly here.
// An explicit entry already present in a repo's `opencode.json` is preserved —
// that is the user's override (pinned model, reasoning effort, …).
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

      const existingAgents = (input as any).agent ?? {}
      let added = 0
      for (const [name, entry] of Object.entries(agentConfigEntries(agentsDir))) {
        if (existingAgents[name]) continue
        existingAgents[name] = entry
        added++
      }
      ;(input as any).agent = existingAgents
      if (added > 0) logger.info(`registered ${added} agent(s) on config.agent`)
    },
  }
}

// ---------------------------------------------------------------------------
// v2 entrypoint (docs/build/plugins/migrate-v1): `id` + `setup(ctx)`, with v1
// served by `server`. v2 has no config hook. Skills are replayed into
// `ctx.skill.transform` (shared/v2-skills.ts). Agents are handled in two steps,
// because v2 exposes no `add` on the agent context (only `update`/`remove`):
//
//   1. `ctx.agent.transform` + `editor.update` — the native attempt. On a host
//      where `update` upserts this is sufficient; on one where it does not, the
//      callback is inert.
//   2. `ensureAgentLinks` — the route the repo README documents as discovered by
//      every version in use: each `agents/<name>.md` is symlinked into the
//      global agent directory. Idempotent, never overwrites a real file, prunes
//      only links back into this plugin. Disable with
//      SCIENTIFIC_WRITING_NO_AGENT_LINKS=1.
// ---------------------------------------------------------------------------
export default {
  id: "scientific-writing",

  async setup(ctx: any) {
    writeLoadCanary("scientific-writing")
    await ctx.skill.transform((editor: any) => registerSkillDir(editor, skillsDir))

    await ctx.agent.transform((editor: any) => {
      for (const rec of agentTransformRecords(agentsDir)) {
        if (editor.get(rec.name)) continue
        editor.update(rec.name, (agent: any) => {
          agent.name = rec.name
          if (rec.description) agent.description = rec.description
          agent.mode = "subagent"
          agent.system = rec.system
        })
      }
    })

    if (!linksDisabled()) {
      const result = ensureAgentLinks(agentsDir, globalAgentDir())
      if (result.created.length || result.removed.length) {
        console.log(
          `[scientific-writing] agent links: +${result.created.length} created, ` +
            `-${result.removed.length} pruned, ${result.kept.length} kept in ${result.destDir}`,
        )
      }
    }
  },

  async server(input: any, options?: any) {
    return v1Factory(input, options)
  },
}
