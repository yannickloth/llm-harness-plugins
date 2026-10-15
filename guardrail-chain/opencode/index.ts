import { type Plugin, tool } from "@opencode-ai/plugin"
import { $ } from "bun"
import path from "path"
import { existsSync, readdirSync, statSync, readFileSync } from "fs"
import { createLogger } from "../../shared/plugin-logger"
import { moduleDir } from "../../shared/module-dir"
import { writeLoadCanary } from "../../shared/load-canary"

const pluginDir = path.join(moduleDir(import.meta.url, import.meta.dir), "..")
const classesDir = path.join(pluginDir, "build", "classes")
const mainClass = "eu.infolead.llmhp.guardrails.GuardrailPipelineCli"

function java(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const allArgs = ["java", "--class-path", classesDir, mainClass, ...args]
  return $`${allArgs}`.nothrow().quiet()
}

// ---------------------------------------------------------------------------
// OpenCode v1 entrypoint (legacy function form). v1 loaders call this factory
// with the plugin input and read the returned hook map.
// ---------------------------------------------------------------------------
const v1Factory = async ({ project, client, $_, directory, worktree }: Parameters<Plugin>[0]) => {
  writeLoadCanary("guardrail-chain")
  const logger = createLogger(client, "guardrail-chain")
  logger.info("plugin active — 4 tools (scan-secrets, check-injection, check-path, transcript-filter)")
  const root = worktree ?? directory

  return {
    tool: {
      "scan-secrets": tool({
        description: "Scan text for hardcoded secrets before writing to disk. Detects API keys, tokens, PEM headers, AWS keys, GitHub tokens, Slack tokens.",
        args: {
          content: tool.schema.string().describe("Content to scan for secrets"),
        },
        async execute(args) {
          const result = await $`java --class-path ${classesDir} ${mainClass} scan-secrets ${args.content}`.nothrow().text()
          return result.trim()
        },
      }),

      "check-injection": tool({
        description: "Check a prompt or text for potential injection patterns (ignore previous instructions, DAN, pretend, system override).",
        args: {
          prompt: tool.schema.string().describe("Prompt or text to check for injection patterns"),
        },
        async execute(args) {
          const result = await $`java --class-path ${classesDir} ${mainClass} check-injection ${args.prompt}`.nothrow().text()
          return result.trim()
        },
      }),

      "check-path": tool({
        description: "Validate that a file path is safe — no symlink traversal, contained within directory, not a protected file.",
        args: {
          target: tool.schema.string().describe("Target file path to check"),
          containment: tool.schema.string().describe("Directory the path must be contained within"),
        },
        async execute(args) {
          const result = await $`java --class-path ${classesDir} ${mainClass} check-path ${args.target} ${args.containment}`.nothrow().text()
          return result.trim()
        },
      }),

      "transcript-filter": tool({
        description: "Strip assistant-role messages from a transcript JSON array before feeding to a secondary LLM. Prevents prompt injection via assistant-controlled text.",
        args: {
          transcript: tool.schema.string().describe("JSON transcript array of messages with role+content fields"),
        },
        async execute(args) {
          const result = await $`java --class-path ${classesDir} ${mainClass} transcript-filter ${args.transcript}`.nothrow().text()
          return result.trim()
        },
      }),
    },

    "file.edited": async (input: { file: string }) => {
      const absPath = path.isAbsolute(input.file) ? input.file : path.resolve(root, input.file)
      if (!existsSync(absPath) || !statSync(absPath).isFile()) return

      const content = readFileSync(absPath, "utf-8")
      if (content.length > 100000) return

      const result = await $`java --class-path ${classesDir} ${mainClass} output-filter --`.nothrow().text()
      try {
        const parsed = JSON.parse(result)
        if (parsed.blocked) {
          logger.error(`SECRET DETECTED in edited file: ${input.file}`)
          for (const block of parsed.blocks) {
            logger.error(`  BLOCKED: ${block.source} - ${block.message}`)
          }
        }
      } catch (_) {}
    },
  }
}

// ---------------------------------------------------------------------------
// OpenCode v2 entrypoint (docs/build/plugins/migrate-v1). v2 loads `id` +
// `setup(ctx)`; tools move from a `tool` map to ctx.tool.transform with JSON
// Schema inputs, and execute returns structured content.
// ---------------------------------------------------------------------------
const str = (description: string) => ({ type: "string", description })

export default {
  id: "guardrail-chain",
  async setup(ctx: any) {
    writeLoadCanary("guardrail-chain")
    const root = (ctx.location?.project?.canonical ?? ctx.location?.directory) as string

    const javaText = (args: string[]) =>
      $`${["java", "--class-path", classesDir, mainClass, ...args]}`.nothrow().text().then((t: string) => t.trim())

    await ctx.tool.transform((editor: any) => {
      editor.add({
        name: "scan-secrets",
        description:
          "Scan text for hardcoded secrets before writing to disk. Detects API keys, tokens, PEM headers, AWS keys, GitHub tokens, Slack tokens.",
        input: { type: "object", properties: { content: str("Content to scan for secrets") }, required: ["content"], additionalProperties: false },
        async execute(input: { content: string }) {
          return { content: await javaText(["scan-secrets", input.content]) }
        },
      })

      editor.add({
        name: "check-injection",
        description:
          "Check a prompt or text for potential injection patterns (ignore previous instructions, DAN, pretend, system override).",
        input: { type: "object", properties: { prompt: str("Prompt or text to check for injection patterns") }, required: ["prompt"], additionalProperties: false },
        async execute(input: { prompt: string }) {
          return { content: await javaText(["check-injection", input.prompt]) }
        },
      })

      editor.add({
        name: "check-path",
        description:
          "Validate that a file path is safe — no symlink traversal, contained within directory, not a protected file.",
        input: {
          type: "object",
          properties: { target: str("Target file path to check"), containment: str("Directory the path must be contained within") },
          required: ["target", "containment"],
          additionalProperties: false,
        },
        async execute(input: { target: string; containment: string }) {
          return { content: await javaText(["check-path", input.target, input.containment]) }
        },
      })

      editor.add({
        name: "transcript-filter",
        description:
          "Strip assistant-role messages from a transcript JSON array before feeding to a secondary LLM. Prevents prompt injection via assistant-controlled text.",
        input: { type: "object", properties: { transcript: str("JSON transcript array of messages with role+content fields") }, required: ["transcript"], additionalProperties: false },
        async execute(input: { transcript: string }) {
          return { content: await javaText(["transcript-filter", input.transcript]) }
        },
      })
    })

    // v1 also auto-scans files on the `file.edited` hook. v2 has no file.edited
    // equivalent; the closest is tool.execute.after. Field names vary, so this
    // is best-effort and only reports (the v1 hook only logged too).
    await ctx.tool.hook("execute.after", async (event: any) => {
      const t = event?.tool ?? event?.name
      if (t !== "write" && t !== "edit") return
      const file = event?.input?.filePath ?? event?.input?.file_path ?? event?.args?.filePath
      if (typeof file !== "string") return
      const absPath = path.isAbsolute(file) ? file : path.resolve(root, file)
      if (!existsSync(absPath) || !statSync(absPath).isFile()) return
      if (readFileSync(absPath, "utf-8").length > 100000) return
      const result = await $`java --class-path ${classesDir} ${mainClass} output-filter --`.nothrow().text()
      try {
        const parsed = JSON.parse(result)
        if (parsed.blocked) {
          for (const block of parsed.blocks) {
            // eslint-disable-next-line no-console
            console.error(`guardrail-chain: SECRET DETECTED in edited file ${file}: ${block.source} - ${block.message}`)
          }
        }
      } catch (_) {}
    })
  },
  async server(input: any) {
    return v1Factory(input)
  },
}
