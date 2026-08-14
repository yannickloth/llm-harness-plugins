import { type Plugin, tool } from "@opencode-ai/plugin"
import { $ } from "bun"
import path from "path"
import { existsSync } from "fs"
import { SectionRegistry } from "../../shared/section-registry"
import { buildPromptWithBoundary, cachedSection, uncachedSection } from "../../shared/cache-boundary"
import { createLogger, type PluginLogger } from "../../shared/plugin-logger"

const pluginDir = path.join(import.meta.dir, "..")
const classesDir = path.join(pluginDir, "build", "classes")
const mainClass = "eu.infolead.llmhp.graph.GraphCli"

const MAX_INJECT = 6000
const FILE_TOOLS = new Set(["read", "grep", "glob", "edit", "write", "find", "ls"])

function graphFile(dir: string): string {
  return path.join(dir, "graph.json")
}

function extractFilePathFromToolInput(input: Record<string, unknown>): string | null {
  if (typeof input.filePath === "string") return input.filePath
  if (typeof input.file_path === "string") return input.file_path
  if (typeof input.path === "string") return input.path
  if (typeof input.directory === "string") return input.directory
  if (typeof input.query === "object" && input.query) {
    const q = input.query as Record<string, unknown>
    if (typeof q.path === "string") return q.path
    if (typeof q.directory === "string") return q.directory
  }
  return null
}

let injectedSessionId: string | null = null
const injectedFiles = new Set<string>()

async function injectContext(
  logger: PluginLogger,
  client: ReturnType<Parameters<Plugin>[0]["client"]>,
  sessionId: string,
  text: string
) {
  if (!text.trim()) return
  const truncated = text.length > MAX_INJECT
    ? text.slice(0, MAX_INJECT) + "\n... [truncated]"
    : text
  try {
    await client.session.prompt({
      path: { id: sessionId },
      body: {
        noReply: true,
        parts: [{ type: "text", text: truncated }],
      },
    })
  } catch (e) {
    logger.error(`inject failed: ${(e as Error).message}`)
  }
}

export default async ({ client, directory, worktree }: Parameters<Plugin>[0]) => {
  const logger = createLogger(client, "knowledge-graph")
  logger.info("plugin active — kg-query tool + auto-injection hooks")
  const root = worktree ?? directory
  const registry = new SectionRegistry(logger)

  registry.section("kg-header", async () => {
    const raw = await $`cat ${path.join(pluginDir, "prompts", "agent-prompt.md")}`.nothrow().text()
    return raw.replace("<plugin-dir>", pluginDir)
  })

  return {
    "session.created": async (input: { properties?: { session?: { id?: string } } }) => {
      const sessionId = input?.properties?.session?.id
      if (!sessionId) return
      injectedSessionId = sessionId

      const gf = graphFile(root)
      if (!existsSync(gf)) {
        logger.info("no graph.json found, skipping context injection")
        return
      }

      try {
        const ctxText = await $`java --class-path ${classesDir} ${mainClass} overview ${gf}`.nothrow().text()
        if (!ctxText.trim()) return

        registry.section("kg-overview", () => ctxText)

        const prompt = await registry.buildPrompt()
        logger.info(registry.report())

        await injectContext(logger, client, sessionId, prompt)
        logger.info(`injected graph context into session ${sessionId}`)
      } catch (e) {
        logger.error(`session.created injection failed: ${(e as Error).message}`)
      }
    },

    "session.deleted": () => {
      registry.clear()
      injectedSessionId = null
      injectedFiles.clear()
    },

    "file.edited": async (input: { file: string }) => {
      const sessionId = injectedSessionId
      if (!sessionId) return

      const gf = graphFile(root)
      if (!existsSync(gf)) return

      const absPath = path.isAbsolute(input.file) ? input.file : path.resolve(root, input.file)
      if (!absPath.startsWith(root)) return

      const dedupKey = absPath + "|edit"
      if (injectedFiles.has(dedupKey)) return
      injectedFiles.add(dedupKey)

      try {
        const result = await $`java --class-path ${classesDir} ${mainClass} subgraph ${gf} ${absPath} 1`.nothrow().text()
        if (!result.trim()) return

        const section = uncachedSection(
          "## Graph Impact (edited file)\n" + result,
          "per-file subgraph injection on edit"
        )
        await injectContext(logger, client, sessionId, buildPromptWithBoundary([section]))
      } catch (e) {
        // silently ignore
      }
    },

    "tool.execute.after": async (event: {
      tool: string
      input: Record<string, unknown>
      context?: { sessionID?: string }
    }) => {
      if (!FILE_TOOLS.has(event.tool)) return

      const sessionId = event.context?.sessionID ?? injectedSessionId
      if (!sessionId) return

      const gf = graphFile(root)
      if (!existsSync(gf)) return

      const filePath = extractFilePathFromToolInput(event.input)
      if (!filePath) return

      const absPath = path.isAbsolute(filePath) ? filePath : path.resolve(root, filePath)
      if (!absPath.startsWith(root)) return

      const dedupKey = absPath + "|tool"
      if (injectedFiles.has(dedupKey)) return
      injectedFiles.add(dedupKey)

      try {
        const result = await $`java --class-path ${classesDir} ${mainClass} subgraph ${gf} ${absPath} 1`.nothrow().text()
        if (!result.trim()) return

        const section = uncachedSection(
          "## Graph Context (file read)\n" + result,
          "per-file subgraph injection on read"
        )
        await injectContext(logger, client, sessionId, buildPromptWithBoundary([section]))
      } catch (e) {
        // silently ignore
      }
    },

    tool: {
      "kg-query": tool({
        description: "Query the knowledge graph: transitive-closure, topo-sort, cycles, community-summary, contradictions, impact, diff, rate",
        args: {
          query: tool.schema.string().describe("e.g. 'topo-sort ch:06', 'transitive-closure thm:knowledge-theorem', 'community-summary ch55:methylation', 'cycles', 'rate review all theorems in section 3'"),
        },
        async execute(args, context) {
          const gf = graphFile(worktree ?? context.directory ?? root)
          if (!existsSync(gf)) return "No graph.json found. Run parse first."

          const result = await $`java --class-path ${classesDir} ${mainClass} query ${gf} ${args.query}`.nothrow().text()
          return result.trim()
        },
      }),
    },
  }
}
