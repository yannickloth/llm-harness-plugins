import { type Plugin, tool } from "@opencode-ai/plugin"
import { createLogger } from "../../shared/plugin-logger"
import { $ } from "bun"
import fs from "fs"
import os from "os"
import path from "path"
import { writeLoadCanary } from "../../shared/load-canary"

// ---------------------------------------------------------------------------
// v1 entrypoint (legacy function form).
// ---------------------------------------------------------------------------
const v1Factory: Plugin = async ({ client }) => {
  writeLoadCanary("python-toolkit")
  const logger = createLogger(client, "python-toolkit")
  logger.info("plugin active")

  return {
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

// ---------------------------------------------------------------------------
// v2 entrypoint (docs/build/plugins/migrate-v1): object default with `id` +
// `setup(ctx)`; v1 is served by `server`. Tools move to ctx.tool.transform
// with a JSON Schema input and return structured `{ content }`.
// ---------------------------------------------------------------------------
const str = (description: string) => ({ type: "string", description })

export default {
  id: "python-toolkit",

  async setup(ctx: any) {
    writeLoadCanary("python-toolkit")
    await ctx.tool.transform((editor: any) => {
      editor.add({
        name: "python-check",
        description:
          "Compile-check a .py file with py_compile (catches syntax errors). Bytecode goes to a temp dir, not the source tree. Returns diagnostics or 'Check succeeded: <path>'.",
        input: {
          type: "object",
          properties: { filePath: str("Path to the .py file to check") },
          required: ["filePath"],
          additionalProperties: false,
        },
        async execute(args: any) {
          const absPath = path.resolve(args.filePath)
          const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "python-check-"))
          try {
            const result = await $`python3 -m py_compile ${absPath}`.env({ PYTHONPYCACHEPREFIX: tmp }).nothrow().quiet()
            if (result.exitCode === 0) return { content: `Check succeeded: ${absPath}` }
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
