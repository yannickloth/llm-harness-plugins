import type { Config, Plugin, tool } from "@opencode-ai/plugin"
import { createLogger } from "../../shared/plugin-logger"
import { $ } from "bun"
import fs from "fs"
import path from "path"

const skillsDir = path.join(import.meta.dir, "..", "skills")

function extractName(skillFile: string, dirName: string): string {
  const content = fs.readFileSync(skillFile, "utf-8")
  if (!content.startsWith("---")) return dirName
  const endIdx = content.indexOf("---", 3)
  if (endIdx === -1) return dirName
  const fm = content.slice(3, endIdx)
  const m = fm.match(/^name:\s*(.+)$/m)
  return m ? m[1].trim() : dirName
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

function skillEntries(dir: string): Record<string, { file: string }> {
  const entries: Record<string, { file: string }> = {}
  if (!fs.existsSync(dir)) return entries
  for (const entry of fs.readdirSync(dir)) {
    const d = path.join(dir, entry)
    if (!fs.statSync(d).isDirectory()) continue
    const sf = path.join(d, "SKILL.md")
    if (!fs.existsSync(sf)) continue
    try {
      const name = extractName(sf, entry)
      entries[name] = { file: path.relative(path.join(dir, "../.."), sf) }
    } catch {}
  }
  return entries
}

export default async ({ client, directory }: Parameters<Plugin>[0]) => {
  const logger = createLogger(client, "typst-toolkit")
  logger.info("plugin active — skill self-registration")
  const entries = skillEntries(skillsDir)
  logger.info(`discovered ${Object.keys(entries).length} skills`)

  return {
    config: async (input: Config) => {
      const existing = (input as any).skills ?? {}
      ;(input as any).skills = { ...existing, ...entries }
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
