import { type Plugin, tool } from "@opencode-ai/plugin"
import { createLogger } from "../../shared/plugin-logger"
import { $ } from "bun"
import fs from "fs"
import os from "os"
import path from "path"

function findRoot(startDir: string, needle: string): string | null {
  let dir = startDir
  while (true) {
    if (fs.existsSync(path.join(dir, needle))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

export default async ({ client }: Parameters<Plugin>[0]) => {
  const logger = createLogger(client, "rust-toolkit")
  logger.info("plugin active")

  return {
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
