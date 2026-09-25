import { type Plugin, tool } from "@opencode-ai/plugin"
import { createLogger } from "../../shared/plugin-logger"
import { $ } from "bun"
import fs from "fs"
import os from "os"
import path from "path"

export default async ({ client }: Parameters<Plugin>[0]) => {
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
