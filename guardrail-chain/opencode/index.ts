import type { Plugin, tool } from "@opencode-ai/plugin"
import { $ } from "bun"
import path from "path"
import { existsSync, readdirSync, statSync, readFileSync } from "fs"
import { createLogger } from "../../shared/plugin-logger"

const pluginDir = path.join(import.meta.dir, "..")
const classesDir = path.join(pluginDir, "build", "classes")
const mainClass = "eu.infolead.llmhp.guardrails.GuardrailPipelineCli"

function java(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const allArgs = ["java", "--class-path", classesDir, mainClass, ...args]
  return $`${allArgs}`.nothrow().quiet()
}

export default async ({ project, client, $_, directory, worktree }: Parameters<Plugin>[0]) => {
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
