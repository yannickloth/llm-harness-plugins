import type { Config, Plugin, tool } from "@opencode-ai/plugin"
import { createLogger } from "../../shared/plugin-logger"
import { $ } from "bun"
import fs from "fs"
import os from "os"
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
  const logger = createLogger(client, "python-toolkit")
  logger.info("plugin active — skill self-registration")
  const entries = skillEntries(skillsDir)
  logger.info(`discovered ${Object.keys(entries).length} skills`)

  return {
    config: async (input: Config) => {
      const existing = (input as any).skills ?? {}
      ;(input as any).skills = { ...existing, ...entries }
    },
    tool: {
      "python-check": tool({
        description: "Compile-check a .py file with py_compile (catches syntax errors). Bytecode goes to a temp dir, not the source tree. Returns diagnostics or 'Check succeeded: <path>'.",
        args: {
          filePath: tool.schema.string().describe("Path to the .py file to check"),
        },
        async execute(args) {
          const absPath = path.resolve(args.filePath)
          const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "python-check-"))
          try {
            const result = await $`python3 -m py_compile ${absPath}`.env({ PYTHONPYCACHEPREFIX: tmp }).nothrow().quiet()
            if (result.exitCode === 0) {
              return `Check succeeded: ${absPath}`
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
