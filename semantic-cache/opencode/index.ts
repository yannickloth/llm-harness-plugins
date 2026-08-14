import { type Plugin, tool } from "@opencode-ai/plugin"
import { $ } from "bun"
import path from "path"
import { createLogger } from "../../shared/plugin-logger"

const pluginDir = path.join(import.meta.dir, "..")
const classesDir = path.join(pluginDir, "build", "classes")
const mainClass = "eu.infolead.llmhp.cache.SemanticCacheCli"

function cacheDir(context: { worktree?: string; directory: string }): string {
  return context.worktree
    ? path.join(context.worktree, ".agentmem", "cache")
    : path.join(context.directory, ".agentmem", "cache")
}

export default async ({ client, directory, worktree }: Parameters<Plugin>[0]) => {
  const logger = createLogger(client, "semantic-cache")
  const cdir = cacheDir({ worktree, directory })
  logger.info("plugin active — 3 tools (cache-lookup, cache-store, cache-stats)")

  return {
    tool: {
      "cache-lookup": tool({
        description: "Check if a semantically similar prompt has a cached response. Uses local embedding — no API call. Returns cached response on hit.",
        args: {
          prompt: tool.schema.string().describe("The prompt to check in the cache"),
        },
        async execute(args) {
          const result = await $`java --class-path ${classesDir} ${mainClass} lookup --cache-dir ${cdir}`.nothrow().quiet().stdin(args.prompt)
          const stdout = result.stdout.toString().trim()
          try {
            const parsed = JSON.parse(stdout)
            if (parsed.hit) {
              return `[CACHE HIT] ${parsed.cached_response}\n\n⚠️ Stale — verify against current state before acting.`
            }
            return "[CACHE MISS] No similar prompt found in cache."
          } catch {
            return "[CACHE MISS] Lookup failed."
          }
        },
      }),

      "cache-store": tool({
        description: "Store a prompt-response pair in the semantic cache. Prompt is locally embedded; response stored with WAL atomicity.",
        args: {
          prompt: tool.schema.string().describe("The prompt to cache"),
          response: tool.schema.string().describe("The response to cache"),
        },
        async execute(args) {
          await $`java --class-path ${classesDir} ${mainClass} store --cache-dir ${cdir} ${args.prompt}`.nothrow().quiet().stdin(args.response)
          return "Cached response for prompt."
        },
      }),

      "cache-stats": tool({
        description: "Get cache statistics: hits, misses, entry count, total size, hit rate.",
        args: {},
        async execute(_args) {
          const result = await $`java --class-path ${classesDir} ${mainClass} stats --cache-dir ${cdir}`.nothrow().quiet()
          return result.stdout.toString().trim()
        },
      }),
    },
  }
}
