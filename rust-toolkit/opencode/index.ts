import { type Plugin, tool } from "@opencode-ai/plugin"
import { createLogger } from "../../shared/plugin-logger"
import { $ } from "bun"
import fs from "fs"
import os from "os"
import path from "path"
import { writeLoadCanary } from "../../shared/load-canary"

function findRoot(startDir: string, needle: string): string | null {
  let dir = startDir
  while (true) {
    if (fs.existsSync(path.join(dir, needle))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

// ---------------------------------------------------------------------------
// v1 entrypoint (legacy function form).
// ---------------------------------------------------------------------------
const v1Factory: Plugin = async ({ client }) => {
  writeLoadCanary("rust-toolkit")
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

// ---------------------------------------------------------------------------
// v2 entrypoint (docs/build/plugins/migrate-v1): object default with `id` +
// `setup(ctx)`; v1 is served by `server`. Tools move to ctx.tool.transform
// with a JSON Schema input and return structured `{ content }`.
// ---------------------------------------------------------------------------
const str = (description: string) => ({ type: "string", description })

export default {
  id: "rust-toolkit",

  async setup(ctx: any) {
    writeLoadCanary("rust-toolkit")
    await ctx.tool.transform((editor: any) => {
      editor.add({
        name: "rust-check",
        description:
          "Check a .rs file. Runs 'cargo check' when the file is inside a Cargo project, otherwise falls back to standalone rustc. Returns errors/warnings or 'Check succeeded: <path>'.",
        input: {
          type: "object",
          properties: { filePath: str("Path to the .rs file to check") },
          required: ["filePath"],
          additionalProperties: false,
        },
        async execute(args: any) {
          const absPath = path.resolve(args.filePath)
          const cargoRoot = findRoot(path.dirname(absPath), "Cargo.toml")
          if (cargoRoot) {
            const result = await $`cargo check`.cwd(cargoRoot).nothrow().quiet()
            if (result.exitCode === 0) return { content: `Check succeeded: ${absPath}` }
            return { content: await result.text() }
          }
          const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rust-check-"))
          try {
            const result = await $`rustc --edition 2021 --crate-type lib -o ${path.join(tmp, "out.rlib")} ${absPath}`.nothrow().quiet()
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
