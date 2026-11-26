import { registerSkillRecords, readSkillRecords } from "../../shared/v2-skills"
import { moduleDir } from "../../shared/module-dir"
import { createLogger } from "../../shared/plugin-logger"
import { writeLoadCanary } from "../../shared/load-canary"
import path from "path"

const pluginRoot = path.resolve(moduleDir(import.meta.url, import.meta.dir), "..")
const skillsDir = path.resolve(pluginRoot, "skills")
const skillDir = path.resolve(skillsDir, "inference-optimisation")

/**
 * Prepend a path preamble after the frontmatter block so the agent can resolve
 * `references/`, `scripts/`, and `examples/` from its own CWD (the project being
 * worked on, not the plugin directory).
 */
function injectSkillRoot(content: string): string {
  const end = content.indexOf("\n---", 3)
  if (end < 0) return content
  const after = end + 4 // skip "\n---"
  const preamble =
    `\n\n> **Skill root:** \`${skillDir}\`\n` +
    `> All paths in this skill (\`references/\`, \`scripts/\`, \`examples/\`) are relative to this directory.\n`
  return content.slice(0, after) + preamble + content.slice(after)
}

// ---------------------------------------------------------------------------
// v2 entrypoint: register the skills directory so opencode loads
// `skills/inference-optimisation/SKILL.md` and its frontmatter.
// ---------------------------------------------------------------------------
export default {
  id: "inference-optimisation",

  async setup(ctx: any) {
    writeLoadCanary("inference-optimisation")
    const logger = createLogger(ctx.client ?? {}, "inference-optimisation")
    logger.info(`plugin active — skill dir registered at ${skillsDir}`)

    const records = readSkillRecords(skillsDir).map(rec => ({
      ...rec,
      content: injectSkillRoot(rec.content),
    }))
    await ctx.skill.transform((editor: any) => registerSkillRecords(editor, records))
  },

  // v1 compat — appends the skills directory so the old path works too.
  async server(input: any, options?: any) {
    writeLoadCanary("inference-optimisation")
    return async ({ client }: any) => {
      const logger = createLogger(client, "inference-optimisation")
      logger.info(`plugin active (v1 path)`)

      return {
        config: async (cfg: any) => {
          const skills = cfg.skills ?? {}
          const paths: string[] = Array.isArray(skills.paths) ? [...skills.paths] : []
          if (!paths.includes(skillsDir)) paths.push(skillsDir)
          cfg.skills = { ...skills, paths }
          return cfg
        },
      }
    }
  },
}
