import { type Plugin, tool } from "@opencode-ai/plugin"
import { createLogger } from "../../shared/plugin-logger"
import { $ } from "bun"
import path from "path"

export default async ({ client }: Parameters<Plugin>[0]) => {
  const logger = createLogger(client, "c-toolkit")
  logger.info("plugin active")

  return {
    tool: {
      "c-check": tool({
        description: "Compile-check a .c file with gcc -std=c11 -fsyntax-only (no output files). Returns errors/warnings or 'Compilation succeeded: <path>'.",
        args: {
          filePath: tool.schema.string().describe("Path to the .c file to check"),
        },
        async execute(args) {
          const absPath = path.resolve(args.filePath)
          const result = await $`gcc -std=c11 -fsyntax-only ${absPath}`.nothrow().quiet()
          if (result.exitCode === 0) {
            return `Compilation succeeded: ${absPath}`
          }
          return result.text()
        },
      }),

      "cpp-check": tool({
        description: "Compile-check a .cpp/.cc/.cxx file with g++ -std=c++17 -fsyntax-only (no output files). Returns errors/warnings or 'Compilation succeeded: <path>'.",
        args: {
          filePath: tool.schema.string().describe("Path to the C++ file to check"),
        },
        async execute(args) {
          const absPath = path.resolve(args.filePath)
          const result = await $`g++ -std=c++17 -fsyntax-only ${absPath}`.nothrow().quiet()
          if (result.exitCode === 0) {
            return `Compilation succeeded: ${absPath}`
          }
          return result.text()
        },
      }),
    },
  }
}
