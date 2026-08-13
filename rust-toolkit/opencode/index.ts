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
  const logger = createLogger(client, "rust-toolkit")
  logger.info("plugin active — skill self-registration")
  const entries = skillEntries(skillsDir)
  logger.info(`discovered ${Object.keys(entries).length} skills`)

  return {
    config: async (input: Config) => {
      const existing = (input as any).skills ?? {}
      ;(input as any).skills = { ...existing, ...entries }
    },
    tool: {
      "rust-check": tool({
        description: "Check a .rs file. Runs 'cargo check' when the file is inside a Cargo project, otherwise falls back to standalone rustc. Returns errors/warnings or 'Check succeeded: <path>'.",
        args: {
          filePath: tool.schema.string().describe("Path to the .rs file to check"),
        },
        async execute(args) {
          const absPath = path.resolve(args.filePath)
          const cargoRoot = findRoot(path.dirname(absPath), "Cargo.toml")
          if (cargoRoot) {
            const result = await $`cargo check`.cwd(cargoRoot).nothrow().quiet()
            if (result.exitCode === 0) {
              return `Check succeeded: ${absPath}`
            }
            return result.text()
          }
          const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rust-check-"))
          try {
            const result = await $`rustc --edition 2021 --crate-type lib -o ${path.join(tmp, "out.rlib")} ${absPath}`.nothrow().quiet()
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
