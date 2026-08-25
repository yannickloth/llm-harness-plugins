import { type Config, type Plugin, tool } from "@opencode-ai/plugin"
import { createLogger } from "../../shared/plugin-logger"
import { moduleDir } from "../../shared/module-dir"
import { $ } from "bun"
import fs from "fs"
import path from "path"
const skillsDir = path.join(moduleDir(import.meta.url, import.meta.dir), "..", "skills")

function extractName(skillFile: string, dirName: string): string {
  const content = fs.readFileSync(skillFile, "utf-8")
  if (!content.startsWith("---")) return dirName
  const endIdx = content.indexOf("---", 3)
  if (endIdx === -1) return dirName
  const fm = content.slice(3, endIdx)
  const m = fm.match(/^name:\s*(.+)$/m)
  return m ? m[1].trim() : dirName
}

function findRoot(startDir: string, needle: string): string | null {
  let dir = startDir
  while (true) {
    if (fs.existsSync(path.join(dir, needle))) return dir
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
  const logger = createLogger(client, "js-toolkit")
  logger.info("plugin active — skill self-registration")
  const entries = skillEntries(skillsDir)
  logger.info(`discovered ${Object.keys(entries).length} skills`)

  return {
    config: async (input: Config) => {
      const existing = (input as any).skills ?? {}
      ;(input as any).skills = { ...existing, ...entries }
    },
    tool: {
      "tsc-check": tool({
        description: "Type-check TypeScript with tsc --noEmit. Locates the nearest tsconfig.json and type-checks the project it belongs to. Returns errors or 'Type-check succeeded: <path>'.",
        args: {
          filePath: tool.schema.string().describe("Path to the .ts file to type-check"),
        },
        async execute(args) {
          const absPath = path.resolve(args.filePath)
          const root = findRoot(path.dirname(absPath), "tsconfig.json")
          if (!root) {
            return `No tsconfig.json found in any parent of ${absPath}. Cannot run tsc --noEmit.`
          }
          const result = await $`npx tsc --noEmit --project ${root}`.cwd(root).nothrow().quiet()
          if (result.exitCode === 0) {
            return `Type-check succeeded: ${absPath}`
          }
          return result.text()
        },
      }),

      "node-check": tool({
        description: "Syntax-check a .js/.mjs/.cjs file with node --check. Returns errors or 'Syntax OK: <path>'.",
        args: {
          filePath: tool.schema.string().describe("Path to the .js file to syntax-check"),
        },
        async execute(args) {
          const absPath = path.resolve(args.filePath)
          const result = await $`node --check ${absPath}`.nothrow().quiet()
          if (result.exitCode === 0) {
            return `Syntax OK: ${absPath}`
          }
          return result.text()
        },
      }),
    },
  }
}
