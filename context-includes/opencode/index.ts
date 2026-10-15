import type { Plugin } from "@opencode-ai/plugin"
import { parseInstructionsMd } from "../../shared/instructions-md"
import { createLogger } from "../../shared/plugin-logger"
import { existsSync } from "fs"
import path from "path"
import { writeLoadCanary } from "../../shared/load-canary"

// ---------------------------------------------------------------------------
// v1 entrypoint (legacy function form).
// ---------------------------------------------------------------------------
const v1Factory: Plugin = async ({ client, directory, worktree }) => {
  writeLoadCanary("context-includes")
  const logger = createLogger(client, "context-includes")
  const root = worktree ?? directory
  const files = [
    path.join(root, "CLAUDE.md"),
    path.join(root, "AGENTS.md"),
  ]

  let cachedMerged: string | null = null
  let injectionInFlight = false

  function resolveInstructions(): string | null {
    if (cachedMerged !== null) return cachedMerged

    const resolvedContents: string[] = []

    for (const file of files) {
      if (!existsSync(file)) continue
      try {
        const { content } = parseInstructionsMd(file, root)
        if (content.trim()) {
          resolvedContents.push(content)
          logger.info(`resolved ${file}`)
        }
      } catch (e) {
        logger.error(`${file}: ${(e as Error).message}`)
      }
    }

    if (resolvedContents.length === 0) {
      logger.info("no instruction files found, skipping injection")
      cachedMerged = ""
      return ""
    }

    cachedMerged = resolvedContents.join("\n\n")
    return cachedMerged
  }

  async function injectIfResolved(sessionId: string) {
    if (injectionInFlight) {
      logger.info(`injection already in flight for ${sessionId} - skipping`)
      return
    }
    injectionInFlight = true
    try {
      const merged = resolveInstructions()
      if (!merged) return

      try {
        await client.session.prompt({
          path: { id: sessionId },
          body: {
            noReply: true,
            parts: [{ type: "text", text: merged }],
          },
        })
        logger.info(`injected resolved instructions into session ${sessionId}`)
      } catch (e) {
        logger.error(`injection failed: ${(e as Error).message}`)
      }
    } finally {
      injectionInFlight = false
    }
  }

  return {
    "session.created": async (input: { properties?: { session?: { id?: string } } }) => {
      const sessionId = input?.properties?.session?.id
      if (!sessionId) return
      await injectIfResolved(sessionId)
    },

    "session.compacted": async (input: { properties?: { session?: { id?: string } } }) => {
      const sessionId = input?.properties?.session?.id
      if (!sessionId) return
      cachedMerged = null
      logger.info("cache cleared on compaction, re-resolving")
      await injectIfResolved(sessionId)
    },

    "session.deleted": () => {
      cachedMerged = null
    },
  }
}

// ---------------------------------------------------------------------------
// v2 entrypoint (docs/build/plugins/migrate-v1): `id` + `setup(ctx)`, with v1
// served by `server`. v2 differences: no `client` (root from `ctx.location`,
// logging to stderr), the v1 `session.created` / `session.compacted` /
// `session.deleted` hooks become one `ctx.event.subscribe` iterator, and the
// injection goes through `ctx.session.synthetic({ sessionID, text })` (the v2
// equivalent of v1's noReply prompt — a message added without a model reply).
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
  id: "context-includes",

  async setup(ctx: any) {
    writeLoadCanary("context-includes")
    const logger = consoleLogger("context-includes")
    const root: string = ctx.location?.project?.canonical ?? ctx.location?.directory
    const files = [
      path.join(root, "CLAUDE.md"),
      path.join(root, "AGENTS.md"),
    ]

    let cachedMerged: string | null = null
    let injectionInFlight = false

    function resolveInstructions(): string | null {
      if (cachedMerged !== null) return cachedMerged

      const resolvedContents: string[] = []

      for (const file of files) {
        if (!existsSync(file)) continue
        try {
          const { content } = parseInstructionsMd(file, root)
          if (content.trim()) {
            resolvedContents.push(content)
            logger.info(`resolved ${file}`)
          }
        } catch (e) {
          logger.error(`${file}: ${(e as Error).message}`)
        }
      }

      if (resolvedContents.length === 0) {
        logger.info("no instruction files found, skipping injection")
        cachedMerged = ""
        return ""
      }

      cachedMerged = resolvedContents.join("\n\n")
      return cachedMerged
    }

    async function injectIfResolved(sessionId: string) {
      if (injectionInFlight) {
        logger.info(`injection already in flight for ${sessionId} - skipping`)
        return
      }
      injectionInFlight = true
      try {
        const merged = resolveInstructions()
        if (!merged) return

        try {
          await ctx.session.synthetic({ sessionID: sessionId, text: merged })
          logger.info(`injected resolved instructions into session ${sessionId}`)
        } catch (e) {
          logger.error(`injection failed: ${(e as Error).message}`)
        }
      } finally {
        injectionInFlight = false
      }
    }

    const controller = new AbortController()
    void (async () => {
      try {
        for await (const input of ctx.event.subscribe({ signal: controller.signal })) {
          if (controller.signal.aborted) break
          const type = input?.type
          const data = input?.properties ?? input?.data
          const sessionId: string | undefined = data?.sessionID ?? data?.session?.id ?? data?.info?.id

          if (type === "session.created") {
            if (sessionId) await injectIfResolved(sessionId)
          } else if (type === "session.compacted") {
            cachedMerged = null
            logger.info("cache cleared on compaction, re-resolving")
            if (sessionId) await injectIfResolved(sessionId)
          } else if (type === "session.deleted") {
            cachedMerged = null
          }
        }
      } catch {
        // the event stream is best-effort
      }
    })()

    return () => controller.abort()
  },

  async server(input: any, options?: any) {
    return v1Factory(input, options)
  },
}
