import { type Plugin, tool } from "@opencode-ai/plugin"
import { createLogger } from "../../shared/plugin-logger"
import { $ } from "bun"
import fs from "fs"
import os from "os"
import path from "path"

export default async ({ client }: Parameters<Plugin>[0]) => {
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
