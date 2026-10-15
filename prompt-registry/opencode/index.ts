import { type Plugin, tool } from "@opencode-ai/plugin"
import { $ } from "bun"
import path from "path"
import { createLogger } from "../../shared/plugin-logger"
import { moduleDir } from "../../shared/module-dir"
import { writeLoadCanary } from "../../shared/load-canary"

const pluginDir = path.join(moduleDir(import.meta.url, import.meta.dir), "..")
const classesDir = path.join(pluginDir, "build", "classes")
const mainClass = "eu.infolead.llmhp.promptregistry.PromptRegistryCli"

function registryDir(context: { worktree?: string; directory: string }): string {
  const root = context.worktree ?? context.directory
  return path.join(root, ".prompt-registry", "registry")
}

// ---------------------------------------------------------------------------
// v1 entrypoint.
// ---------------------------------------------------------------------------
const v1Factory: Plugin = async ({ client, directory, worktree }) => {
  writeLoadCanary("prompt-registry")
  const logger = createLogger(client, "prompt-registry")
  const rdir = registryDir({ worktree, directory })
  logger.info("plugin active — 5 tools (prompt-commit, prompt-pull, prompt-list, prompt-diff, prompt-test)")

  return {
    tool: {
      "prompt-commit": tool({
        description: "Commit the current version of a prompt from a plugin's prompts/ directory to the registry. Increments version.",
        args: {
          name: tool.schema.string().describe("Prompt name (matches the .md filename without extension)"),
          from: tool.schema.string().optional().describe("Path to the plugin root directory containing prompts/"),
          author: tool.schema.string().optional().describe("Author identifier"),
        },
        async execute(args) {
          const argv = ["java", "--class-path", classesDir, mainClass, "commit", "--registry-dir", rdir, args.name]
          if (args.from) argv.push("--from", args.from)
          if (args.author) argv.push("--author", args.author)
          const result = await $`${argv}`.nothrow().quiet()
          return result.stdout.toString().trim()
        },
      }),

      "prompt-pull": tool({
        description: "Pull a specific prompt version from the registry into a plugin's prompts/ directory. Use name@version to pull a specific version, or just name for the active version.",
        args: {
          name_ver: tool.schema.string().describe("Prompt name, optionally with @version (e.g. 'agent-prompt' or 'agent-prompt@3')"),
          to: tool.schema.string().optional().describe("Path to the plugin root directory containing prompts/"),
        },
        async execute(args) {
          const argv = ["java", "--class-path", classesDir, mainClass, "pull", "--registry-dir", rdir, args.name_ver]
          if (args.to) argv.push("--to", args.to)
          const result = await $`${argv}`.nothrow().quiet()
          return result.stdout.toString().trim()
        },
      }),

      "prompt-list": tool({
        description: "List all registered prompts and their versions. Optionally filter by prompt name.",
        args: {
          name: tool.schema.string().optional().describe("Optional prompt name to show versions for"),
        },
        async execute(args) {
          const argv = ["java", "--class-path", classesDir, mainClass, "list", "--registry-dir", rdir]
          if (args.name) argv.push(args.name)
          const result = await $`${argv}`.nothrow().quiet()
          return result.stdout.toString().trim()
        },
      }),

      "prompt-diff": tool({
        description: "Compare two versions of a prompt. Shows lines added/removed.",
        args: {
          name: tool.schema.string().describe("Prompt name"),
          v1: tool.schema.number().describe("First version number"),
          v2: tool.schema.number().describe("Second version number"),
        },
        async execute(args) {
          const result = await $`java --class-path ${classesDir} ${mainClass} diff --registry-dir ${rdir} ${args.name} ${String(args.v1)} ${String(args.v2)}`.nothrow().quiet()
          return result.stdout.toString().trim()
        },
      }),

      "prompt-test": tool({
        description: "Set up an A/B test for two prompt variants. Generates test metadata — spawn two subagents with each variant to compare outputs.",
        args: {
          name: tool.schema.string().describe("Prompt name"),
          variant_a: tool.schema.number().describe("Variant A version number"),
          variant_b: tool.schema.number().describe("Variant B version number"),
        },
        async execute(args) {
          const result = await $`java --class-path ${classesDir} ${mainClass} test --registry-dir ${rdir} ${args.name} ${String(args.variant_a)} ${String(args.variant_b)}`.nothrow().quiet()
          return result.stdout.toString().trim()
        },
      }),
    },
  }
}

// ---------------------------------------------------------------------------
// v2 entrypoint (docs/build/plugins/migrate-v1): `id` + `setup(ctx)`, with v1
// served by `server`. v2 has no `client`, the root comes from `ctx.location`,
// and the tool map becomes `ctx.tool.transform` with JSON Schema inputs and
// structured `{ content }` results.
// ---------------------------------------------------------------------------
const str = (description: string) => ({ type: "string", description })
const num = (description: string) => ({ type: "number", description })
const strOpt = (description: string) => ({ type: "string", description })

export default {
  id: "prompt-registry",

  async setup(ctx: any) {
    writeLoadCanary("prompt-registry")
    const root: string = ctx.location?.project?.canonical ?? ctx.location?.directory
    const rdir = path.join(root, ".prompt-registry", "registry")

    const javaText = (argv: string[]) => $`${argv}`.nothrow().quiet().then(r => r.stdout.toString().trim())

    await ctx.tool.transform((editor: any) => {
      editor.add({
        name: "prompt-commit",
        description:
          "Commit the current version of a prompt from a plugin's prompts/ directory to the registry. Increments version.",
        input: {
          type: "object",
          properties: {
            name: str("Prompt name (matches the .md filename without extension)"),
            from: strOpt("Path to the plugin root directory containing prompts/"),
            author: strOpt("Author identifier"),
          },
          required: ["name"],
          additionalProperties: false,
        },
        async execute(args: any) {
          const argv = ["java", "--class-path", classesDir, mainClass, "commit", "--registry-dir", rdir, args.name]
          if (args.from) argv.push("--from", args.from)
          if (args.author) argv.push("--author", args.author)
          return { content: await javaText(argv) }
        },
      })

      editor.add({
        name: "prompt-pull",
        description:
          "Pull a specific prompt version from the registry into a plugin's prompts/ directory. Use name@version to pull a specific version, or just name for the active version.",
        input: {
          type: "object",
          properties: {
            name_ver: str("Prompt name, optionally with @version (e.g. 'agent-prompt' or 'agent-prompt@3')"),
            to: strOpt("Path to the plugin root directory containing prompts/"),
          },
          required: ["name_ver"],
          additionalProperties: false,
        },
        async execute(args: any) {
          const argv = ["java", "--class-path", classesDir, mainClass, "pull", "--registry-dir", rdir, args.name_ver]
          if (args.to) argv.push("--to", args.to)
          return { content: await javaText(argv) }
        },
      })

      editor.add({
        name: "prompt-list",
        description: "List all registered prompts and their versions. Optionally filter by prompt name.",
        input: {
          type: "object",
          properties: { name: strOpt("Optional prompt name to show versions for") },
          additionalProperties: false,
        },
        async execute(args: any) {
          const argv = ["java", "--class-path", classesDir, mainClass, "list", "--registry-dir", rdir]
          if (args.name) argv.push(args.name)
          return { content: await javaText(argv) }
        },
      })

      editor.add({
        name: "prompt-diff",
        description: "Compare two versions of a prompt. Shows lines added/removed.",
        input: {
          type: "object",
          properties: {
            name: str("Prompt name"),
            v1: num("First version number"),
            v2: num("Second version number"),
          },
          required: ["name", "v1", "v2"],
          additionalProperties: false,
        },
        async execute(args: any) {
          return {
            content: await javaText([
              "java", "--class-path", classesDir, mainClass, "diff",
              "--registry-dir", rdir, args.name, String(args.v1), String(args.v2),
            ]),
          }
        },
      })

      editor.add({
        name: "prompt-test",
        description:
          "Set up an A/B test for two prompt variants. Generates test metadata — spawn two subagents with each variant to compare outputs.",
        input: {
          type: "object",
          properties: {
            name: str("Prompt name"),
            variant_a: num("Variant A version number"),
            variant_b: num("Variant B version number"),
          },
          required: ["name", "variant_a", "variant_b"],
          additionalProperties: false,
        },
        async execute(args: any) {
          return {
            content: await javaText([
              "java", "--class-path", classesDir, mainClass, "test",
              "--registry-dir", rdir, args.name, String(args.variant_a), String(args.variant_b),
            ]),
          }
        },
      })
    })
  },

  async server(input: any, options?: any) {
    return v1Factory(input, options)
  },
}
