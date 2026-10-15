import { type Config, type Plugin, tool } from "@opencode-ai/plugin"
import { createLogger } from "../../shared/plugin-logger"
import { moduleDir } from "../../shared/module-dir"
import { registerSkillDir } from "../../shared/v2-skills"
import { $ } from "bun"
import fs from "fs"
import path from "path"
import { writeLoadCanary } from "../../shared/load-canary"

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

function findNixRoot(startDir: string): string | null {
  let dir = startDir
  while (true) {
    const flakePath = path.join(dir, "flake.nix")
    if (fs.existsSync(flakePath)) return dir
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

// ---------------------------------------------------------------------------
// v1 entrypoint.
// ---------------------------------------------------------------------------
const v1Factory: Plugin = async ({ client }) => {
  writeLoadCanary("typst-toolkit")
  const logger = createLogger(client, "typst-toolkit")
  const count = skillCount(skillsDir)
  logger.info(`plugin active — skill self-registration (${count} skills in ${skillsDir})`)

  return {
    config: async (input: Config) => {
      const skills = (input as any).skills ?? {}
      const paths: string[] = Array.isArray(skills.paths) ? [...skills.paths] : []
      if (count > 0 && !paths.includes(skillsDir)) paths.push(skillsDir)
      ;(input as any).skills = { ...skills, paths }
    },
    tool: {
      "typst-check": tool({
        description: "Compile a .typ file with Typst to check for errors/warnings. Returns diagnostics or 'Compilation succeeded: <path>'.",
        args: {
          filePath: tool.schema.string().describe("Path to the .typ file to compile"),
        },
        async execute(args) {
          const absPath = path.resolve(args.filePath)
          const dir = path.dirname(absPath)
          if (!process.env.TYPST_FONT_PATHS) {
            const flakeRoot = findNixRoot(dir)
            if (flakeRoot) {
              return `TYPST_FONT_PATHS is not set but a flake.nix exists at ${flakeRoot}. Enter the dev shell first: cd ${flakeRoot} && nix develop`
            }
          }
          const result = await $`typst compile --root ${dir} --format pdf ${absPath} /dev/null`.nothrow().quiet()
          if (result.exitCode === 0) {
            return `Compilation succeeded: ${absPath}`
          }
          return result.text()
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
  id: "typst-toolkit",

  async setup(ctx: any) {
    writeLoadCanary("typst-toolkit")
    await ctx.skill.transform((editor: any) => registerSkillDir(editor, skillsDir))

    await ctx.tool.transform((editor: any) => {
      editor.add({
        name: "typst-check",
        description:
          "Compile a .typ file with Typst to check for errors/warnings. Returns diagnostics or 'Compilation succeeded: <path>'.",
        input: {
          type: "object",
          properties: { filePath: str("Path to the .typ file to compile") },
          required: ["filePath"],
          additionalProperties: false,
        },
        async execute(args: any) {
          const absPath = path.resolve(args.filePath)
          const dir = path.dirname(absPath)
          if (!process.env.TYPST_FONT_PATHS) {
            const flakeRoot = findNixRoot(dir)
            if (flakeRoot) {
              return { content: `TYPST_FONT_PATHS is not set but a flake.nix exists at ${flakeRoot}. Enter the dev shell first: cd ${flakeRoot} && nix develop` }
            }
          }
          const result = await $`typst compile --root ${dir} --format pdf ${absPath} /dev/null`.nothrow().quiet()
          if (result.exitCode === 0) return { content: `Compilation succeeded: ${absPath}` }
          return { content: await result.text() }
        },
      })
    })
  },

  async server(input: any, options?: any) {
    return v1Factory(input, options)
  },
}
