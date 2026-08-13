import type { Plugin } from "@opencode-ai/plugin"
import { parseInstructionsMd } from "../../shared/instructions-md"
import { createLogger } from "../../shared/plugin-logger"
import { existsSync } from "fs"
import path from "path"

export default async ({ client, directory, worktree }: Parameters<Plugin>[0]) => {
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
