import { type Config, type Plugin, tool } from "@opencode-ai/plugin"
import { createLogger } from "../../shared/plugin-logger"
import { moduleDir } from "../../shared/module-dir"
import { $ } from "bun"
import fs from "fs"
import os from "os"
import path from "path"

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

export default async ({ client }: Parameters<Plugin>[0]) => {
  const logger = createLogger(client, "latex-toolkit")
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
