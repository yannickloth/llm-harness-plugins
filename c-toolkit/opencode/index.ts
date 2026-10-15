import { type Plugin, tool } from "@opencode-ai/plugin"
import { createLogger } from "../../shared/plugin-logger"
import { $ } from "bun"
import path from "path"
import { writeLoadCanary } from "../../shared/load-canary"

// ---------------------------------------------------------------------------
// v1 entrypoint (legacy function form). v1 loaders call this factory with the
// plugin input and read the returned hook map.
// ---------------------------------------------------------------------------
const v1Factory: Plugin = async ({ client }) => {
  writeLoadCanary("c-toolkit")
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

// ---------------------------------------------------------------------------
// v2 entrypoint (docs/build/plugins/migrate-v1): v2 loads an object default
// with `id` + `setup(ctx)`; the v1 factory is served by `server`. Tools move
// from a `tool` map to ctx.tool.transform with JSON Schema inputs and execute
// returns structured `{ content }`.
// ---------------------------------------------------------------------------
const str = (description: string) => ({ type: "string", description })

export default {
  id: "c-toolkit",

  async setup(ctx: any) {
    writeLoadCanary("c-toolkit")
    await ctx.tool.transform((editor: any) => {
      editor.add({
        name: "c-check",
        description:
          "Compile-check a .c file with gcc -std=c11 -fsyntax-only (no output files). Returns errors/warnings or 'Compilation succeeded: <path>'.",
        input: {
          type: "object",
          properties: { filePath: str("Path to the .c file to check") },
          required: ["filePath"],
          additionalProperties: false,
        },
        async execute(args: any) {
          const absPath = path.resolve(args.filePath)
          const result = await $`gcc -std=c11 -fsyntax-only ${absPath}`.nothrow().quiet()
          if (result.exitCode === 0) return { content: `Compilation succeeded: ${absPath}` }
          return { content: await result.text() }
        },
      })

      editor.add({
        name: "cpp-check",
        description:
          "Compile-check a .cpp/.cc/.cxx file with g++ -std=c++17 -fsyntax-only (no output files). Returns errors/warnings or 'Compilation succeeded: <path>'.",
        input: {
          type: "object",
          properties: { filePath: str("Path to the C++ file to check") },
          required: ["filePath"],
          additionalProperties: false,
        },
        async execute(args: any) {
          const absPath = path.resolve(args.filePath)
          const result = await $`g++ -std=c++17 -fsyntax-only ${absPath}`.nothrow().quiet()
          if (result.exitCode === 0) return { content: `Compilation succeeded: ${absPath}` }
          return { content: await result.text() }
        },
      })
    })
  },

  async server(input: any, options?: any) {
    return v1Factory(input, options)
  },
}
