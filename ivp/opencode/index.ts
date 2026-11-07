// ivp — self-registers the IVP skill pack (skills/*/SKILL.md),
// the six auditor agents (agents/*.md), and the five user-invoked
// commands (commands/*.md).
//
// Dual-version entrypoint (harness idiom): `server(input)` is the v1 path,
// `setup(ctx)` the v2 path. v1 appended the skills directory to
// `config.skills.paths` in a config hook; v2 has no config hook, so the same
// directory is replayed into `ctx.skill.transform` via shared/v2-skills.ts.
//
// The agents read `prompts/ivp-knowledge.md` on demand, and a subagent's cwd is
// the *target* codebase, not this plugin — so every agent prompt gets an
// absolute-path preamble prepended at registration. Without it the bare
// `ivp-knowledge.md` references resolve to nothing from any other project.
import type { Config, Plugin } from "@opencode-ai/plugin"
import { createLogger } from "../../shared/plugin-logger"
import { moduleDir } from "../../shared/module-dir"
import { writeLoadCanary } from "../../shared/load-canary"
import { registerSkillDir } from "../../shared/v2-skills"
import { registerCommandDirV2 } from "../../shared/v2-commands"
import { readAgentRecords, registerAgentDirV1, registerAgentDirV2 } from "../../shared/agents"
import fs from "fs"
import path from "path"

const pluginDir = path.resolve(moduleDir(import.meta.url, import.meta.dir), "..")
const skillsDir = path.join(pluginDir, "skills")
const agentsDir = path.join(pluginDir, "agents")
const commandsDir = path.join(pluginDir, "commands")
const knowledgePath = path.join(pluginDir, "prompts", "ivp-knowledge.md")

function skillCount(dir: string): number {
  if (!fs.existsSync(dir)) return 0
  return fs
    .readdirSync(dir)
    .filter(entry => {
      const d = path.join(dir, entry)
      return fs.statSync(d).isDirectory() && fs.existsSync(path.join(d, "SKILL.md"))
    }).length
}

/**
 * Absolute-path preamble for every agent system prompt.
 *
 * Agents run with the target codebase as cwd and cite `ivp-knowledge.md` by bare
 * name. Resolve it here, where the plugin's own location is known. The canonical
 * sources live in a sibling checkout (`ivp-book-series/`); when that checkout is
 * not present beside the plugins repo, say so instead of letting the agent
 * report a resolved reference that is not on disk.
 */
function knowledgePreamble(): string {
  const canonical = path.resolve(pluginDir, "..", "..", "ivp-book-series")
  const canonicalNote = fs.existsSync(canonical)
    ? `Canonical sources: ${canonical}`
    : `Canonical sources: NOT CHECKED OUT (expected at ${canonical}). Treat any claim that needs the canonical text as unverified and say so.`
  return [
    "# IVP pack — reference locations",
    "",
    `- Working restatement: ${knowledgePath}`,
    "- Read that file on demand. It is the working restatement used by this pack,",
    "  not the canonical text.",
    `- ${canonicalNote}`,
    "",
    "---",
    "",
  ].join("\n")
}

/** Agent records with the path preamble prepended to each system prompt. */
function agentRecordsWithPreamble() {
  const preamble = knowledgePreamble()
  return readAgentRecords(agentsDir).map(rec => ({ ...rec, system: preamble + rec.system }))
}

// ---------------------------------------------------------------------------
// v1 entrypoint.
// ---------------------------------------------------------------------------
const v1Factory: Plugin = async ({ client }) => {
  writeLoadCanary("ivp")
  const logger = createLogger(client, "ivp")
  const count = skillCount(skillsDir)
  const agents = agentRecordsWithPreamble()
  logger.info(
    `plugin active — IVP pack (${count} skills, ${agents.length} agents, ` +
      `${readdirSyncSafe(commandsDir).length} commands in ${pluginDir})`,
  )

  return {
    config: async (input: Config) => {
      const skills = (input as any).skills ?? {}
      const paths: string[] = Array.isArray(skills.paths) ? [...skills.paths] : []
      if (count > 0 && !paths.includes(skillsDir)) paths.push(skillsDir)
      ;(input as any).skills = { ...skills, paths }

      // v1 has no command registry hook and no agent create-by-update: replay
      // the records inline. The preamble is already applied to each prompt.
      registerAgentDirV1(input, agentsDir, { records: agents })
    },
  }
}

function readdirSyncSafe(dir: string): string[] {
  try {
    return fs.readdirSync(dir).filter(e => e.endsWith(".md"))
  } catch {
    return []
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
    await ctx.agent.transform((editor: any) => registerAgentDirV2(editor, agentsDir, { preamble: knowledgePreamble() }))
    await ctx.command.transform((editor: any) => registerCommandDirV2(editor, commandsDir))
  },

  async server(input: any, options?: any) {
    return v1Factory(input, options)
  },
}
