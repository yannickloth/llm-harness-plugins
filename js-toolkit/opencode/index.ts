import { type Plugin, tool } from "@opencode-ai/plugin"
import { createLogger } from "../../shared/plugin-logger"
import { $ } from "bun"
import fs from "fs"
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
  writeLoadCanary("js-toolkit")
  const logger = createLogger(client, "js-toolkit")
  logger.info("plugin active")

  return {
    tool: {
      "tsc-check": tool({
        description: "Type-check TypeScript with tsc --noEmit. Locates the nearest tsconfig.json and type-checks the project it belongs to. Returns errors or 'Type-check succeeded: <path>'.",
        args: {
          filePath: tool.schema.string().describe("Path to the .ts file to type-check"),
        },
        async execute(args) {
          const absPath = path.resolve(args.filePath)
          const root = findRoot(path.dirname(absPath), "tsconfig.json")
          if (!root) {
            return `No tsconfig.json found in any parent of ${absPath}. Cannot run tsc --noEmit.`
          }
          const result = await $`npx tsc --noEmit --project ${root}`.cwd(root).nothrow().quiet()
          if (result.exitCode === 0) {
            return `Type-check succeeded: ${absPath}`
          }
          return result.text()
        },
      }),

      "node-check": tool({
        description: "Syntax-check a .js/.mjs/.cjs file with node --check. Returns errors or 'Syntax OK: <path>'.",
        args: {
          filePath: tool.schema.string().describe("Path to the .js file to syntax-check"),
        },
        async execute(args) {
          const absPath = path.resolve(args.filePath)
          const result = await $`node --check ${absPath}`.nothrow().quiet()
          if (result.exitCode === 0) {
            return `Syntax OK: ${absPath}`
          }
          return result.text()
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
  id: "js-toolkit",

  async setup(ctx: any) {
    writeLoadCanary("js-toolkit")
    await ctx.tool.transform((editor: any) => {
      editor.add({
        name: "tsc-check",
        description:
          "Type-check TypeScript with tsc --noEmit. Locates the nearest tsconfig.json and type-checks the project it belongs to. Returns errors or 'Type-check succeeded: <path>'.",
        input: {
          type: "object",
          properties: { filePath: str("Path to the .ts file to type-check") },
          required: ["filePath"],
          additionalProperties: false,
        },
        async execute(args: any) {
          const absPath = path.resolve(args.filePath)
          const root = findRoot(path.dirname(absPath), "tsconfig.json")
          if (!root) {
            return { content: `No tsconfig.json found in any parent of ${absPath}. Cannot run tsc --noEmit.` }
          }
          const result = await $`npx tsc --noEmit --project ${root}`.cwd(root).nothrow().quiet()
          if (result.exitCode === 0) return { content: `Type-check succeeded: ${absPath}` }
          return { content: await result.text() }
        },
      })

      editor.add({
        name: "node-check",
        description: "Syntax-check a .js/.mjs/.cjs file with node --check. Returns errors or 'Syntax OK: <path>'.",
        input: {
          type: "object",
          properties: { filePath: str("Path to the .js file to syntax-check") },
          required: ["filePath"],
          additionalProperties: false,
        },
        async execute(args: any) {
          const absPath = path.resolve(args.filePath)
          const result = await $`node --check ${absPath}`.nothrow().quiet()
          if (result.exitCode === 0) return { content: `Syntax OK: ${absPath}` }
          return { content: await result.text() }
        },
      })
    })
  },

  async server(input: any, options?: any) {
    return v1Factory(input, options)
  },
}
