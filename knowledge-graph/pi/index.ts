import { existsSync, readFileSync } from "node:fs"
import { join, isAbsolute, resolve } from "node:path"

const MAX_INJECT = 6000
const FILE_TOOLS = new Set(["read", "grep", "glob", "edit", "write", "find", "ls"])

const JAVA_CLASS = "eu.infolead.llmhp.graph.GraphCli"

function findPluginDir(): string {
  return join(import.meta.dir, "..")
}

function graphFile(root: string): string {
  return join(root, "graph.json")
}

function extractFilePath(input: Record<string, unknown>): string | null {
  if (typeof input.path === "string" && input.path.length > 0) return input.path
  return null
}

function resolveTo(r: string, rel: string): string {
  if (isAbsolute(rel)) return rel
  return resolve(r, rel)
}

let projectRoot = ""
let overviewDone = false
const injectedScopes = new Set<string>()

export default function kgPi(pi: any) {
  const pluginDir = findPluginDir()
  const classpath = join(pluginDir, "build", "classes")

  pi.on("session_start", (_event: any, ctx: any) => {
    projectRoot = ctx.cwd
    overviewDone = false
    injectedScopes.clear()
  })

  pi.on("context", (event: any, ctx: any) => {
    const root = projectRoot || ctx.cwd

    if (!overviewDone) {
      overviewDone = true
      const gf = graphFile(root)
      if (!existsSync(gf)) return undefined

      const result = Bun.spawnSync([
        "java", "--class-path", classpath, JAVA_CLASS,
        "overview", gf,
      ])
      const text = result.stdout.toString().trim() || result.stderr.toString().trim()
      if (!text) return undefined

      const raw = readFileSync(join(pluginDir, "prompts", "agent-prompt.md"), "utf-8")
      const agentPrompt = raw.replace("<plugin-dir>", pluginDir)
      const msgs = [...event.messages]
      msgs.push({
        role: "user" as const,
        content: [{ type: "text" as const, text: agentPrompt + "\n---\n" + text }],
      })
      return { messages: msgs }
    }

    return undefined
  })

  pi.on("tool_result", (event: any, ctx: any) => {
    const root = projectRoot || ctx.cwd
    if (!FILE_TOOLS.has(event.toolName)) return undefined

    const filePath = extractFilePath(event.input ?? {})
    if (!filePath) return undefined

    const abs = resolveTo(ctx.cwd, filePath)
    if (!abs.startsWith(root)) return undefined

    const dedupKey = abs + "|pi-tool"
    if (injectedScopes.has(dedupKey)) return undefined
    injectedScopes.add(dedupKey)

    const gf = graphFile(root)
    if (!existsSync(gf)) return undefined

    const result = Bun.spawnSync([
      "java", "--class-path", classpath, JAVA_CLASS,
      "subgraph", gf, abs, "1",
    ])
    const text = result.stdout.toString().trim()
    if (!text) return undefined

    const newContent = [...event.content, { type: "text" as const, text: "\n\n## Graph Context\n" + text }]
    return { content: newContent }
  })

  const queryTool: any = {
    name: "kg-query",
    label: "Query Knowledge Graph",
    description: "Query the knowledge graph: transitive-closure, topo-sort, cycles, community-summary, contradictions, impact, diff, rate",
    parameters: {} as any,
    async execute(
      _toolCallId: string,
      params: Record<string, unknown>,
      _signal: AbortSignal | undefined,
      _onUpdate: any,
      ctx: { cwd: string; signal: AbortSignal | undefined }
    ) {
      const root = projectRoot || ctx.cwd
      const gf = graphFile(root)
      if (!existsSync(gf)) {
        return { content: [{ type: "text", text: "No graph.json found. Run parse first." }], isError: true }
      }

      const query = String(params.query ?? "")
      if (!query) {
        return { content: [{ type: "text", text: "Query string required. e.g. 'topo-sort ch:06'" }], isError: true }
      }

      const result = Bun.spawnSync([
        "java", "--class-path", classpath, JAVA_CLASS,
        "query", gf, query,
      ])
      const output = result.stdout.toString().trim() || result.stderr.toString().trim()
      if (result.exitCode !== 0) {
        return { content: [{ type: "text", text: "ERROR: " + output }], isError: true }
      }
      return { content: [{ type: "text", text: output }] }
    },
  }
  pi.registerTool(queryTool)
}
