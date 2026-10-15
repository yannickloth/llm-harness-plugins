import { type Plugin, tool } from "@opencode-ai/plugin"
import path from "path"
import fs from "fs"
import { createLogger } from "../../shared/plugin-logger"
import { updateSessionTopic, shouldInjectProjectContext } from "../../shared/session-topic"
import { cacheDir, invalidateFiles, invalidateStale, lookup, SOURCE_AUTO, SOURCE_FILEOP, stats, store } from "./daemon-client"
import { writeLoadCanary } from "../../shared/load-canary"

const WRITE_TOOLS: ReadonlySet<string> = new Set(["edit", "write"])

// Marker prefix used on every cache-hit injection we push into the session.
// The injected noReply message re-fires the chat.message hook; skipping lines
// that carry this marker breaks the re-entrant inject→lookup→inject loop that
// otherwise runs away (observed: 569k lookups and 316k hit files in minutes).
const CACHE_HIT_MARKER = "[CACHE HIT]"

// Bounded dedup for cache-hit injection (avoid re-injecting the same stale block).
const injectedKeys = new Set<string>()
const MAX_INJECTED_KEYS = 1000

// Hard runtime backstop: cap cache-hit injections per session per turn. Even if
// a re-entrancy path ever slips past the marker guard, this bounds the damage
// (no more 316k hit files / runaway lookups).
const MAX_INJECTIONS_PER_SESSION = 8
const injectionsBySession = new Map<string, number>()
function canInject(sessionId: string): boolean {
  const n = injectionsBySession.get(sessionId) ?? 0
  if (n >= MAX_INJECTIONS_PER_SESSION) return false
  injectionsBySession.set(sessionId, n + 1)
  return true
}

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

/** Stable short hash for naming per-hit detail files (mirrors CacheStore.hashKey). */
function hash(s: string): string {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (31 * h + s.charCodeAt(i)) | 0
  return (h < 0 ? -h : h).toString(16)
}

type SemanticCacheOptions = {
  /**
   * If true (default), only inject cached context into sessions classified as
   * project-related. Personal/non-coding sessions are left alone.
   */
  topicGate?: boolean
}

// ---------------------------------------------------------------------------
// v1 entrypoint (legacy function form).
// ---------------------------------------------------------------------------
const v1Factory = async ({ client, directory, worktree }: Parameters<Plugin>[0], options: SemanticCacheOptions = {}) => {
  writeLoadCanary("semantic-cache")
  const logger = createLogger(client, "semantic-cache")
  const cdir = cacheDir({ worktree, directory })
  const topicGate = options.topicGate ?? true
  logger.info(`plugin active — 3 tools + lookup/store/invalidation hooks (persistent daemon); topic gate: ${topicGate}`)

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
          injectionsBySession.delete(sid)
          break
        }
      }
    },

    "chat.message": async (input, output) => {
      const sessionId = input.sessionID
      if (!sessionId) return
      const text = output.parts?.map((p: any) => p.text ?? "").join(" ").trim() ?? ""
      if (!text) return
      // Never re-process a cache-hit pointer we injected ourselves. Without
      // this, the injected noReply message re-fires this hook, whose text is
      // semantically similar to cached prompts → another hit → another unique
      // detail file → infinite inject loop (see CACHE_HIT_MARKER).
      if (text.startsWith(CACHE_HIT_MARKER)) return
      updateSessionTopic(sessionId, text)

      // Flush the prior turn's completed (prompt, assistant-response) pair —
      // unless that turn was served from the cache (we don't re-store a stale
      // answer the user was told to verify).
      const prior = pendingBySession.get(sessionId)
      const priorText = assistantTextBySession.get(sessionId)
      if (prior && !prior.served && priorText && priorText.length) {
        store(cdir, prior.prompt, priorText.join("\n"), SOURCE_AUTO).catch(() => {})
      }

      // Determine whether the current turn is served from cache.
      // A cache daemon failure (e.g. `java` missing from PATH) must never break
      // the session: treat it as a cache miss and continue.
      const cached = await lookup(cdir, text).catch((e: unknown) => {
        logger.warn(`cache lookup unavailable: ${(e as Error)?.message ?? String(e)}`)
        return undefined
      })
      pendingBySession.set(sessionId, { prompt: text, served: !!cached })
      assistantTextBySession.delete(sessionId)

      // Inject a cached hit as stale context (deduped per session+prompt).
      // Only do this for project sessions; personal sessions must not be
      // diverted by unrelated cached answers.
      if (topicGate && !shouldInjectProjectContext(sessionId)) return
      if (cached && canInject(sessionId) && markInjected(`${sessionId}|${text}`)) {
        // Keep the chat window lean: persist the full cached response to a
        // markdown file and inject only a one-line pointer. The model reads the
        // file on demand (mirrors the lazy-loaded AGENTS.md rule pattern).
        const detailFile = path.join(cdir, "hits", `${hash(text)}.md`)
        try {
          fs.mkdirSync(path.dirname(detailFile), { recursive: true })
          fs.writeFileSync(detailFile, `[CACHE HIT] stale cached answer (verify before acting)\n\n${cached}\n`)
        } catch {
          // never let a detail-file write failure break the session
        }
        const relPath = path.relative(worktree ?? directory, detailFile)
        await injectContext(
          client,
          sessionId,
          `${CACHE_HIT_MARKER} A semantically similar prompt was answered before. Details (stale — verify against current state): \`${relPath}\`.`,
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
        store(cdir, `the file ${path.basename(filePath)} was modified (${toolName})`, output.output, SOURCE_FILEOP).catch(() => {})
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
          let cached: string | undefined
          try {
            cached = await lookup(cd, args.prompt)
          } catch (e) {
            return `[CACHE UNAVAILABLE] ${(e as Error)?.message ?? String(e)}`
          }
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
          try {
            await store(cacheDir(context), args.prompt, args.response)
            return "Cached response for prompt."
          } catch (e) {
            return `[CACHE UNAVAILABLE] ${(e as Error)?.message ?? String(e)}`
          }
        },
      }),

      "cache-stats": tool({
        description: "Get cache statistics: hits, misses, entry count, total size, hit rate.",
        args: {},
        async execute(_args, context) {
          try {
            const body = await stats(cacheDir(context))
            return body || "No cache data."
          } catch (e) {
            return `[CACHE UNAVAILABLE] ${(e as Error)?.message ?? String(e)}`
          }
        },
      }),
    },
  }
}

// ---------------------------------------------------------------------------
// v2 entrypoint (docs/build/plugins/migrate-v1): `id` + `setup(ctx)`, with v1
// served by `server`. v2 differences: no `client` (root from `ctx.location`,
// logging to stderr), `chat.message` → `ctx.session.hook("prompt")` (mutable
// `event.prompt.text`), `event` → `ctx.event.subscribe`, `tool.execute.after` →
// `ctx.tool.hook("execute.after")`, and the tool map → `ctx.tool.transform`.
// `experimental.text.complete` has no v2 equivalent; the assistant text is
// captured from the `session.next.text.ended` server event instead.
// ---------------------------------------------------------------------------
function consoleLogger(service: string) {
  return {
    debug: (_m: string) => {},
    info: (m: string) => console.error(`[${service}] ${m}`),
    warn: (m: string) => console.error(`[${service}] WARN ${m}`),
    error: (m: string) => console.error(`[${service}] ERROR ${m}`),
  }
}

export default {
  id: "semantic-cache",

  async setup(ctx: any) {
    writeLoadCanary("semantic-cache")
    const logger = consoleLogger("semantic-cache")
    const root: string = ctx.location?.project?.canonical ?? ctx.location?.directory
    const cdir = cacheDir({ directory: root, worktree: root })
    const options = (ctx.options ?? {}) as SemanticCacheOptions
    const topicGate = options.topicGate ?? true

    async function injectContextV2(sessionId: string, text: string) {
      try {
        await ctx.session.synthetic({ sessionID: sessionId, text })
      } catch {
        // injection must never break the session
      }
    }

    const controller = new AbortController()
    void (async () => {
      try {
        for await (const input of ctx.event.subscribe({ signal: controller.signal })) {
          if (controller.signal.aborted) break
          const type = input?.type
          const props = input?.properties ?? input?.data ?? {}

          if (type === "session.created") {
            invalidateStale(cdir).catch(() => {})
          } else if (type === "session.deleted") {
            const sid: string | undefined = props?.sessionID ?? props?.info?.id
            if (!sid) continue
            pendingBySession.delete(sid)
            assistantTextBySession.delete(sid)
            injectionsBySession.delete(sid)
          } else if (type === "session.next.text.ended") {
            const sid: string | undefined = props?.sessionID
            const text: string | undefined = props?.text
            if (!sid || !text) continue
            const bucket = assistantTextBySession.get(sid) ?? []
            bucket.push(text)
            assistantTextBySession.set(sid, bucket)
          }
        }
      } catch {
        // the event stream is best-effort bookkeeping
      }
    })()

    await ctx.session.hook("prompt", async (event: any) => {
      const sessionId: string | undefined = event?.sessionID
      if (!sessionId) return
      const text: string = (event?.prompt?.text ?? "").trim()
      if (!text) return
      // Never re-process a cache-hit pointer we injected ourselves.
      if (text.startsWith(CACHE_HIT_MARKER)) return
      updateSessionTopic(sessionId, text)

      // Flush the prior turn's completed (prompt, assistant-response) pair —
      // unless that turn was served from the cache.
      const prior = pendingBySession.get(sessionId)
      const priorText = assistantTextBySession.get(sessionId)
      if (prior && !prior.served && priorText && priorText.length) {
        store(cdir, prior.prompt, priorText.join("\n"), SOURCE_AUTO).catch(() => {})
      }

      const cached = await lookup(cdir, text).catch((e: unknown) => {
        logger.warn(`cache lookup unavailable: ${(e as Error)?.message ?? String(e)}`)
        return undefined
      })
      pendingBySession.set(sessionId, { prompt: text, served: !!cached })
      assistantTextBySession.delete(sessionId)

      if (topicGate && !shouldInjectProjectContext(sessionId)) return
      if (cached && canInject(sessionId) && markInjected(`${sessionId}|${text}`)) {
        const detailFile = path.join(cdir, "hits", `${hash(text)}.md`)
        try {
          fs.mkdirSync(path.dirname(detailFile), { recursive: true })
          fs.writeFileSync(detailFile, `[CACHE HIT] stale cached answer (verify before acting)\n\n${cached}\n`)
        } catch {
          // never let a detail-file write failure break the session
        }
        const relPath = path.relative(root, detailFile)
        await injectContextV2(
          sessionId,
          `${CACHE_HIT_MARKER} A semantically similar prompt was answered before. Details (stale — verify against current state): \`${relPath}\`.`,
        )
        logger.info(`injected cached response for session ${sessionId}`)
      }
    })

    await ctx.tool.hook("execute.after", async (event: any) => {
      const toolName: string = event?.tool ?? event?.name
      if (!WRITE_TOOLS.has(toolName)) return
      const filePath = extractFilePath(event?.input ?? event?.args ?? {})
      if (!filePath) return

      // Invalidate entries that reference the changed file, then store the
      // file-op outcome so a future identical edit is served from cache.
      invalidateFiles(cdir, filePath).catch(() => {})
      const output = event?.result?.output ?? event?.result?.content ?? event?.output
      if (output !== undefined && output !== null) {
        store(cdir, `the file ${path.basename(filePath)} was modified (${toolName})`, typeof output === "string" ? output : JSON.stringify(output), SOURCE_FILEOP).catch(() => {})
      }
    })

    const str = (description: string) => ({ type: "string", description })

    await ctx.tool.transform((editor: any) => {
      editor.add({
        name: "cache-lookup",
        description:
          "Check if a semantically similar prompt has a cached response. Uses local embedding — no API call. Returns cached response on hit.",
        input: {
          type: "object",
          properties: { prompt: str("The prompt to check in the cache") },
          required: ["prompt"],
          additionalProperties: false,
        },
        async execute(args: any) {
          let cached: string | undefined
          try {
            cached = await lookup(cdir, args.prompt)
          } catch (e) {
            return { content: `[CACHE UNAVAILABLE] ${(e as Error)?.message ?? String(e)}` }
          }
          if (cached) {
            return { content: `[CACHE HIT] ${cached}\n\n⚠️ Stale — verify against current state before acting.` }
          }
          return { content: "[CACHE MISS] No similar prompt found in cache." }
        },
      })

      editor.add({
        name: "cache-store",
        description: "Store a prompt-response pair in the semantic cache. Prompt is locally embedded; response stored with WAL atomicity.",
        input: {
          type: "object",
          properties: {
            prompt: str("The prompt to cache"),
            response: str("The response to cache"),
          },
          required: ["prompt", "response"],
          additionalProperties: false,
        },
        async execute(args: any) {
          try {
            await store(cdir, args.prompt, args.response)
            return { content: "Cached response for prompt." }
          } catch (e) {
            return { content: `[CACHE UNAVAILABLE] ${(e as Error)?.message ?? String(e)}` }
          }
        },
      })

      editor.add({
        name: "cache-stats",
        description: "Get cache statistics: hits, misses, entry count, total size, hit rate.",
        input: { type: "object", properties: {}, additionalProperties: false },
        async execute() {
          try {
            const body = await stats(cdir)
            return { content: body || "No cache data." }
          } catch (e) {
            return { content: `[CACHE UNAVAILABLE] ${(e as Error)?.message ?? String(e)}` }
          }
        },
      })
    })

    return () => controller.abort()
  },

  async server(input: any, options?: any) {
    return v1Factory(input, options)
  },
}
