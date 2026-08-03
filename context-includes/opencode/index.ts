import type { Plugin } from "@opencode-ai/plugin"
import { parseClaudeMd } from "../../shared/claudemd"
import { existsSync } from "fs"
import path from "path"

export default async ({ client, directory, worktree }: Parameters<Plugin>[0]) => {
  const root = worktree ?? directory
  const files = [
    path.join(root, "CLAUDE.md"),
    path.join(root, "AGENTS.md"),
  ]

  const resolvedContents: string[] = []

  for (const file of files) {
    if (!existsSync(file)) continue
    try {
      const { content } = parseClaudeMd(file, root)
      if (content.trim()) {
        resolvedContents.push(content)
        console.log("[context-includes] resolved", file)
      }
    } catch (e) {
      console.error("[context-includes]", file, ":", (e as Error).message)
    }
  }

  if (resolvedContents.length === 0) {
    console.log("[context-includes] no instruction files found, skipping injection")
    return {}
  }

  const merged = resolvedContents.join("\n\n")

  return {
    "session.created": async (input: { properties?: { session?: { id?: string } } }) => {
      const sessionId = input?.properties?.session?.id
      if (!sessionId) return

      try {
        await client.session.prompt({
          path: { id: sessionId },
          body: {
            noReply: true,
            parts: [{ type: "text", text: merged }],
          },
        })
        console.log("[context-includes] injected resolved instructions into session", sessionId)
      } catch (e) {
        console.error("[context-includes] injection failed:", (e as Error).message)
      }
    },
  }
}
