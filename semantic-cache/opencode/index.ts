import type { Plugin, tool } from "@opencode-ai/plugin"
import { $ } from "bun"
import path from "path"

const pluginDir = path.join(import.meta.dir, "..")
const classesDir = path.join(pluginDir, "build", "classes")
const mainClass = "eu.infolead.llmhp.cache.SemanticCacheCli"

export default async ({ client, directory, worktree }: Parameters<Plugin>[0]) => {
  const root = worktree ?? directory
  console.log("[semantic-cache] plugin active — 3 tools (cache-lookup, cache-store, cache-stats)")

  return {
    tool: {
      "cache-lookup": tool({
        description: "Check if a semantically similar prompt has a cached response. Uses local embedding — no API call. Returns cached response on hit.",
        args: {
          prompt: tool.schema.string().describe("The prompt to check in the cache"),
        },
        async execute(args) {
          const result = await $`java --class-path ${classesDir} ${mainClass} lookup`.nothrow().stdin(args.prompt)
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
          await $`java --class-path ${classesDir} ${mainClass} store ${args.prompt}`.nothrow().stdin(args.response)
          return "Cached response for prompt."
        },
      }),

      "cache-stats": tool({
        description: "Get cache statistics: hits, misses, entry count, total size, hit rate.",
        args: {},
        async execute(args) {
          const result = await $`java --class-path ${classesDir} ${mainClass} stats`.nothrow()
          return result.stdout.toString().trim()
        },
      }),
    },
  }
}
