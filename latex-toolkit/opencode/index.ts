import { type Config, type Plugin, tool } from "@opencode-ai/plugin"
import { createLogger } from "../../shared/plugin-logger"
import { moduleDir } from "../../shared/module-dir"
import { registerSkillDir } from "../../shared/v2-skills"
import { registerAgentDirV1, registerAgentDirV2 } from "../../shared/agents"
import { $ } from "bun"
import fs from "fs"
import os from "os"
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

// ---------------------------------------------------------------------------
// v1 entrypoint.
// ---------------------------------------------------------------------------
const v1Factory: Plugin = async ({ client }) => {
  writeLoadCanary("latex-toolkit")
  const logger = createLogger(client, "latex-toolkit")
  const count = skillCount(skillsDir)
  logger.info(`plugin active — skill self-registration (${count} skills in ${skillsDir})`)

  return {
    config: async (input: Config) => {
      const skills = (input as any).skills ?? {}
      const paths: string[] = Array.isArray(skills.paths) ? [...skills.paths] : []
      if (count > 0 && !paths.includes(skillsDir)) paths.push(skillsDir)
      ;(input as any).skills = { ...skills, paths }

      registerAgentDirV1(input, agentsDir)
    },
    tool: {
      "latex-check": tool({
        description: "Compile a .tex file with latexmk to check for errors/warnings. Build artifacts go to a temp dir, not the source tree. Returns diagnostics or 'Compilation succeeded: <path>'.",
        args: {
          filePath: tool.schema.string().describe("Path to the .tex file to compile"),
        },
        async execute(args) {
          const absPath = path.resolve(args.filePath)
          const dir = path.dirname(absPath)
          const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "latex-check-"))
          try {
            const result = await $`latexmk -pdf -interaction=nonstopmode -outdir=${tmp} ${absPath}`.cwd(dir).nothrow().quiet()
            if (result.exitCode === 0) {
              return `Compilation succeeded: ${absPath}`
            }
            return result.text()
          } finally {
            fs.rmSync(tmp, { recursive: true, force: true })
          }
        },
      }),
    },
  }
}

// ---------------------------------------------------------------------------
// v2 entrypoint (docs/build/plugins/migrate-v1): `id` + `setup(ctx)`, with v1
// served by `server`. v2 has no config hook (skills → `ctx.skill.transform`)
// and the tool map becomes `ctx.tool.transform` with a JSON Schema input.
// ---------------------------------------------------------------------------
const str = (description: string) => ({ type: "string", description })

export default {
  id: "latex-toolkit",

  async setup(ctx: any) {
    writeLoadCanary("latex-toolkit")
    await ctx.skill.transform((editor: any) => registerSkillDir(editor, skillsDir))
    await ctx.agent.transform((editor: any) => registerAgentDirV2(editor, agentsDir))

    await ctx.tool.transform((editor: any) => {
      editor.add({
        name: "latex-check",
        description:
          "Compile a .tex file with latexmk to check for errors/warnings. Build artifacts go to a temp dir, not the source tree. Returns diagnostics or 'Compilation succeeded: <path>'.",
        input: {
          type: "object",
          properties: { filePath: str("Path to the .tex file to compile") },
          required: ["filePath"],
          additionalProperties: false,
        },
        async execute(args: any) {
          const absPath = path.resolve(args.filePath)
          const dir = path.dirname(absPath)
          const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "latex-check-"))
          try {
            const result = await $`latexmk -pdf -interaction=nonstopmode -outdir=${tmp} ${absPath}`.cwd(dir).nothrow().quiet()
            if (result.exitCode === 0) return { content: `Compilation succeeded: ${absPath}` }
            return { content: await result.text() }
          } finally {
            fs.rmSync(tmp, { recursive: true, force: true })
          }
        },
      })
    })
  },

  async server(input: any, options?: any) {
    return v1Factory(input, options)
  },
}
