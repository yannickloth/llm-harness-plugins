import { type Plugin, type Config, tool } from "@opencode-ai/plugin"
import { $ } from "bun"
import path from "path"
import { existsSync } from "fs"
import { SectionRegistry } from "../../shared/section-registry"
import { buildPromptWithBoundary, uncachedSection } from "../../shared/cache-boundary"
import { createLogger, type PluginLogger } from "../../shared/plugin-logger"
import { moduleDir } from "../../shared/module-dir"
import { registerSkillDir } from "../../shared/v2-skills"
import { writeLoadCanary } from "../../shared/load-canary"

const pluginDir = path.join(moduleDir(import.meta.url, import.meta.dir), "..")
const classesDir = path.join(pluginDir, "build", "classes")
const mainClass = "eu.infolead.llmhp.graph.GraphCli"
const skillsDir = path.join(pluginDir, "skills")

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

// ---------------------------------------------------------------------------
// v1 entrypoint (legacy function form).
// ---------------------------------------------------------------------------
const v1Factory: Plugin = async ({ client, directory, worktree }) => {
  writeLoadCanary("knowledge-graph")
  const logger = createLogger(client, "knowledge-graph")
  logger.info("plugin active — kg-query tool + auto-injection hooks")
  const root = worktree ?? directory

  const buildHeader = async () => {
    const raw = await $`cat ${path.join(pluginDir, "prompts", "agent-prompt.md")}`.nothrow().text()
    return raw.replace("<plugin-dir>", pluginDir)
  }

  return {
    config: async (input: Config) => {
      if (!existsSync(skillsDir)) return
      const skills = (input as Record<string, unknown>).skills as
        | { paths?: string[] }
        | undefined
      const paths = Array.isArray(skills?.paths) ? [...skills!.paths] : []
      if (!paths.includes(skillsDir)) paths.push(skillsDir)
      ;(input as Record<string, unknown>).skills = { ...skills, paths }
      logger.info(`registered skills dir: ${skillsDir}`)
    },

    "session.created": async (input: { properties?: { session?: { id?: string } } }) => {
      const sessionId = input?.properties?.session?.id
      if (!sessionId) return
      injectedSessionId = sessionId

      const registry = new SectionRegistry(logger)
      registry.section("kg-header", buildHeader)

      const gf = graphFile(root)
      if (existsSync(gf)) {
        try {
          const ctxText = await $`java --class-path ${classesDir} ${mainClass} overview ${gf}`.nothrow().text()
          if (ctxText.trim()) registry.section("kg-overview", () => ctxText)
        } catch (e) {
          logger.error(`graph overview failed: ${(e as Error).message}`)
        }
      } else {
        logger.info("no graph.json — injecting agent prompt only")
      }

      try {
        const prompt = await registry.buildPrompt()
        logger.info(registry.report())
        await injectContext(logger, client, sessionId, prompt)
        logger.info(`injected graph context into session ${sessionId}`)
      } catch (e) {
        logger.error(`session.created injection failed: ${(e as Error).message}`)
      }
    },

    "session.deleted": () => {
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
        description: "Query the knowledge graph: transitive-closure, topo-sort, cycles, community-summary, contradictions, impact, diagram (mermaid export)",
        args: {
          query: tool.schema.string().describe("e.g. 'topo-sort ch:06', 'transitive-closure thm:knowledge-theorem', 'community-summary ch55:methylation', 'cycles', 'diagram thm:knowledge-theorem 2'"),
        },
        async execute(args, context) {
          const gf = graphFile(worktree ?? context.directory ?? root)
          if (!existsSync(gf)) return "No graph.json found. Run parse first."

          const parts = args.query.trim().split(/\s+/).filter(Boolean)
          if (parts.length === 0) return "Provide a query, e.g. 'cycles' or 'impact ch:06'."

          const result = await $`java --class-path ${classesDir} ${mainClass} query ${gf} ${parts}`.nothrow().text()
          return result.trim()
        },
      }),
    },
  }
}

// ---------------------------------------------------------------------------
// v2 entrypoint (docs/build/plugins/migrate-v1): `id` + `setup(ctx)`, with v1
// served by `server`. v2 differences: no `client` (root from `ctx.location`,
// logging to stderr), injection via `ctx.session.synthetic({ sessionID, text })`
// (the v2 equivalent of v1's noReply prompt), `session.created` / `session.deleted` via `ctx.event.subscribe`,
// `tool.execute.after` → `ctx.tool.hook("execute.after")`, the tool map →
// `ctx.tool.transform`, skills via `ctx.skill.transform` (no config hook).
// `file.edited` maps to the same-named V2 event.
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
  id: "knowledge-graph",

  async setup(ctx: any) {
    writeLoadCanary("knowledge-graph")
    const logger = consoleLogger("knowledge-graph")
    const root: string = ctx.location?.project?.canonical ?? ctx.location?.directory

    const buildHeader = async () => {
      const raw = await $`cat ${path.join(pluginDir, "prompts", "agent-prompt.md")}`.nothrow().text()
      return raw.replace("<plugin-dir>", pluginDir)
    }

    async function injectContextV2(sessionId: string, text: string) {
      if (!text.trim()) return
      const truncated = text.length > MAX_INJECT
        ? text.slice(0, MAX_INJECT) + "\n... [truncated]"
        : text
      try {
        await ctx.session.synthetic({ sessionID: sessionId, text: truncated })
      } catch (e) {
        logger.error(`inject failed: ${(e as Error).message}`)
      }
    }

    await ctx.skill.transform((editor: any) => registerSkillDir(editor, skillsDir))

    const controller = new AbortController()
    void (async () => {
      try {
        for await (const input of ctx.event.subscribe({ signal: controller.signal })) {
          if (controller.signal.aborted) break
          const type = input?.type
          const data = input?.properties ?? input?.data

          if (type === "session.created") {
            const sessionId: string | undefined = data?.sessionID ?? data?.session?.id ?? data?.info?.id
            if (!sessionId) continue
            injectedSessionId = sessionId

            const registry = new SectionRegistry(logger)
            registry.section("kg-header", buildHeader)

            const gf = graphFile(root)
            if (existsSync(gf)) {
              try {
                const ctxText = await $`java --class-path ${classesDir} ${mainClass} overview ${gf}`.nothrow().text()
                if (ctxText.trim()) registry.section("kg-overview", () => ctxText)
              } catch (e) {
                logger.error(`graph overview failed: ${(e as Error).message}`)
              }
            } else {
              logger.info("no graph.json — injecting agent prompt only")
            }

            try {
              const prompt = await registry.buildPrompt()
              logger.info(registry.report())
              await injectContextV2(sessionId, prompt)
              logger.info(`injected graph context into session ${sessionId}`)
            } catch (e) {
              logger.error(`session.created injection failed: ${(e as Error).message}`)
            }
          } else if (type === "session.deleted") {
            injectedSessionId = null
            injectedFiles.clear()
          } else if (type === "file.edited") {
            // v1's `file.edited` hook: inject the impact subgraph for the edited
            // file. V2 exposes the same event (`properties.file`), so this is the
            // faithful mapping rather than dropping it for the tool hook.
            const sessionId = injectedSessionId
            if (!sessionId) continue
            const file: string = data?.file ?? data?.properties?.file ?? ""
            if (!file) continue
            const gf = graphFile(root)
            if (!existsSync(gf)) continue
            const absPath = path.isAbsolute(file) ? file : path.resolve(root, file)
            if (!absPath.startsWith(root)) continue
            const dedupKey = absPath + "|edit"
            if (injectedFiles.has(dedupKey)) continue
            injectedFiles.add(dedupKey)
            try {
              const result = await $`java --class-path ${classesDir} ${mainClass} subgraph ${gf} ${absPath} 1`.nothrow().text()
              if (!result.trim()) continue
              const section = uncachedSection(
                "## Graph Impact (edited file)\n" + result,
                "per-file subgraph injection on edit"
              )
              await injectContextV2(sessionId, buildPromptWithBoundary([section]))
            } catch (e) {
              // silently ignore
            }
          }
        }
      } catch {
        // the event stream is best-effort
      }
    })()

    await ctx.tool.hook("execute.after", async (event: any) => {
      const toolName: string = event?.tool ?? event?.name
      if (!FILE_TOOLS.has(toolName)) return

      const sessionId: string | undefined = event?.sessionID ?? event?.context?.sessionID ?? injectedSessionId ?? undefined
      if (!sessionId) return

      const gf = graphFile(root)
      if (!existsSync(gf)) return

      const filePath = extractFilePathFromToolInput(event?.input ?? event?.args ?? {})
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
        await injectContextV2(sessionId, buildPromptWithBoundary([section]))
      } catch (e) {
        // silently ignore
      }
    })

    await ctx.tool.transform((editor: any) => {
      editor.add({
        name: "kg-query",
        description: "Query the knowledge graph: transitive-closure, topo-sort, cycles, community-summary, contradictions, impact, diagram (mermaid export)",
        input: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "e.g. 'topo-sort ch:06', 'transitive-closure thm:knowledge-theorem', 'community-summary ch55:methylation', 'cycles', 'diagram thm:knowledge-theorem 2'",
            },
          },
          required: ["query"],
          additionalProperties: false,
        },
        async execute(args: any) {
          const gf = graphFile(root)
          if (!existsSync(gf)) return { content: "No graph.json found. Run parse first." }

          const parts = args.query.trim().split(/\s+/).filter(Boolean)
          if (parts.length === 0) return { content: "Provide a query, e.g. 'cycles' or 'impact ch:06'." }

          const result = await $`java --class-path ${classesDir} ${mainClass} query ${gf} ${parts}`.nothrow().text()
          return { content: result.trim() }
        },
      })
    })

    return () => controller.abort()
  },

  async server(input: any, options?: any) {
    return v1Factory(input, options)
  },
}
