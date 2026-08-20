import { type Plugin, tool } from "@opencode-ai/plugin"
import path from "path"
import { createLogger } from "../../shared/plugin-logger"
import { cacheDir, invalidateFiles, invalidateStale, lookup, stats, store } from "./daemon-client"

const WRITE_TOOLS: ReadonlySet<string> = new Set(["edit", "write"])

// Bounded dedup for cache-hit injection (avoid re-injecting the same stale block).
const injectedKeys = new Set<string>()
const MAX_INJECTED_KEYS = 1000

// Auto-store bookkeeping: the assistant's completed text for a turn is paired
// with that turn's user prompt (pendingBySession) and flushed on the next user
// message. A turn that was served from the cache is NOT re-stored (its response
// is a stale starting point the user was told to verify).
interface PendingTurn {
  prompt: string
  served: boolean
}
const pendingBySession = new Map<string, PendingTurn>()
const assistantTextBySession = new Map<string, string[]>()

async function injectContext(client: ReturnType<Parameters<Plugin>[0]["client"]>, sessionId: string, text: string) {
  try {
    await client.session.prompt({
      path: { id: sessionId },
      body: { noReply: true, parts: [{ type: "text", text }] },
    })
  } catch {
    // injection must never break the session
  }
}

function markInjected(key: string): boolean {
  if (injectedKeys.has(key)) return false
  if (injectedKeys.size >= MAX_INJECTED_KEYS) injectedKeys.clear()
  injectedKeys.add(key)
  return true
}

function extractFilePath(args: Record<string, unknown>): string | null {
  if (typeof args.filePath === "string" && args.filePath) return args.filePath
  if (typeof args.file_path === "string" && args.file_path) return args.file_path
  if (typeof args.path === "string" && args.path) return args.path
  return null
}

export default async ({ client, directory, worktree }: Parameters<Plugin>[0]) => {
  const logger = createLogger(client, "semantic-cache")
  const cdir = cacheDir({ worktree, directory })
  logger.info("plugin active — 3 tools + lookup/store/invalidation hooks (persistent daemon)")

  return {
    event: async ({ event }) => {
      switch (event.type) {
        case "session.created": {
          invalidateStale(cdir).catch(() => {})
          break
        }
        case "session.deleted": {
          const sid = event.properties?.sessionID
          if (!sid) break
          pendingBySession.delete(sid)
          assistantTextBySession.delete(sid)
          break
        }
      }
    },

    "chat.message": async (input, output) => {
      const sessionId = input.sessionID
      if (!sessionId) return
      const text = output.parts?.map((p: any) => p.text ?? "").join(" ").trim() ?? ""
      if (!text) return

      // Flush the prior turn's completed (prompt, assistant-response) pair —
      // unless that turn was served from the cache (we don't re-store a stale
      // answer the user was told to verify).
      const prior = pendingBySession.get(sessionId)
      const priorText = assistantTextBySession.get(sessionId)
      if (prior && !prior.served && priorText && priorText.length) {
        store(cdir, prior.prompt, priorText.join("\n")).catch(() => {})
      }

      // Determine whether the current turn is served from cache.
      const cached = await lookup(cdir, text)
      pendingBySession.set(sessionId, { prompt: text, served: !!cached })
      assistantTextBySession.delete(sessionId)

      // Inject a cached hit as stale context (deduped per session+prompt).
      if (cached && markInjected(`${sessionId}|${text}`)) {
        await injectContext(
          client,
          sessionId,
          `[CACHE HIT] A semantically similar prompt was answered before. Treat the following as a **stale starting point** — verify against current state before acting.\n\n${cached}`,
        )
        logger.info(`injected cached response for session ${sessionId}`)
      }
    },

    "experimental.text.complete": async (input, output) => {
      const sessionId = input.sessionID
      if (!sessionId || !output?.text) return
      const bucket = assistantTextBySession.get(sessionId) ?? []
      bucket.push(output.text)
      assistantTextBySession.set(sessionId, bucket)
    },

    "tool.execute.after": async (input, output) => {
      const toolName = input.tool
      if (!WRITE_TOOLS.has(toolName)) return
      const filePath = extractFilePath(input.args ?? {})
      if (!filePath) return

      // Invalidate entries that reference the changed file, then store the
      // file-op outcome so a future identical edit is served from cache.
      invalidateFiles(cdir, filePath).catch(() => {})
      if (output?.output) {
        store(cdir, `the file ${path.basename(filePath)} was modified (${toolName})`, output.output).catch(() => {})
      }
    },

    tool: {
      "cache-lookup": tool({
        description: "Check if a semantically similar prompt has a cached response. Uses local embedding — no API call. Returns cached response on hit.",
        args: {
          prompt: tool.schema.string().describe("The prompt to check in the cache"),
        },
        async execute(args, context) {
          const cd = cacheDir(context)
          const cached = await lookup(cd, args.prompt)
          if (cached) {
            return `[CACHE HIT] ${cached}\n\n⚠️ Stale — verify against current state before acting.`
          }
          return "[CACHE MISS] No similar prompt found in cache."
        },
      }),

      "cache-store": tool({
        description: "Store a prompt-response pair in the semantic cache. Prompt is locally embedded; response stored with WAL atomicity.",
        args: {
          prompt: tool.schema.string().describe("The prompt to cache"),
          response: tool.schema.string().describe("The response to cache"),
        },
        async execute(args, context) {
          await store(cacheDir(context), args.prompt, args.response)
          return "Cached response for prompt."
        },
      }),

      "cache-stats": tool({
        description: "Get cache statistics: hits, misses, entry count, total size, hit rate.",
        args: {},
        async execute(_args, context) {
          const body = await stats(cacheDir(context))
          return body || "No cache data."
        },
      }),
    },
  }
}
