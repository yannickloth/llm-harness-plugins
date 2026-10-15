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
  writeLoadCanary("java-toolkit")
  const logger = createLogger(client, "java-toolkit")
  logger.info("plugin active")

  return {
    tool: {
      "java-check": tool({
        description: "Compile a .java file with javac to check for errors/warnings. Class files go to a temp dir, not the source tree. Returns diagnostics or 'Compilation succeeded: <path>'.",
        args: {
          filePath: tool.schema.string().describe("Path to the .java file to compile"),
        },
        async execute(args) {
          const absPath = path.resolve(args.filePath)
          const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "java-check-"))
          try {
            const result = await $`javac -d ${tmp} ${absPath}`.nothrow().quiet()
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
  id: "java-toolkit",

  async setup(ctx: any) {
    writeLoadCanary("java-toolkit")
    await ctx.tool.transform((editor: any) => {
      editor.add({
        name: "java-check",
        description:
          "Compile a .java file with javac to check for errors/warnings. Class files go to a temp dir, not the source tree. Returns diagnostics or 'Compilation succeeded: <path>'.",
        input: {
          type: "object",
          properties: { filePath: str("Path to the .java file to compile") },
          required: ["filePath"],
          additionalProperties: false,
        },
        async execute(args: any) {
          const absPath = path.resolve(args.filePath)
          const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "java-check-"))
          try {
            const result = await $`javac -d ${tmp} ${absPath}`.nothrow().quiet()
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
