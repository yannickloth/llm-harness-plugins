import { join } from "node:path"
import { loadMemIndex, collectTopicFiles, collectScopedMem, extractFilePathFromToolInput, resolveAbsolute, FILE_TOOLS } from "../shared/memory-helpers"

const JAVA_CLASS = "eu.infolead.llmhp.memory.MemorySystemCli"

function findAgentmemDir(): string {
  const self = import.meta.dir
  return join(self, "..")
}

function reinject(pi: any, root: string) {
  const mdir = join(root, ".agentmem")
  const index = loadMemIndex(mdir)
  if (!index) return
  const topics = collectTopicFiles(mdir)
  pi.sendMessage({
    customType: "agentmem-update",
    content: "# Persistent Project Memory\n**UPDATED** — new memories just saved.\n\n" + index + "\n" + topics,
    display: "Memory updated",
    details: {},
  }, { deliverAs: "followUp" })
}

interface ToolCtx { cwd: string; signal: AbortSignal | undefined }

function memDir(projectRoot: string): string {
  return join(projectRoot, ".agentmem")
}

let projectRoot = ""
let memInjectDone = false

export default function agentmemPi(pi: any) {
  const agentmemDir = findAgentmemDir()
  const classpath = join(agentmemDir, "build", "classes")

  pi.on("session_start", (_event: any, ctx: any) => {
    projectRoot = ctx.cwd
    memInjectDone = false
  })

  pi.on("tool_result", (event: any, ctx: any) => {
    // After our own save/forget tools complete, reinject updated memory
    if (event.toolName === "agentmem-save" || event.toolName === "agentmem-forget") {
      const root = projectRoot || ctx.cwd
      reinject(pi, root)
    }
  })

  pi.on("context", (event: any, ctx: any) => {
    const root = projectRoot || ctx.cwd

    // Session-start: inject full memory index + topic files (once)
    if (!memInjectDone) {
      memInjectDone = true
      const mdir = memDir(root)
      const index = loadMemIndex(mdir)
      const topics = collectTopicFiles(mdir)
      const blocks: string[] = []
      if (index) blocks.push("# Persistent Project Memory\n\n" + index)
      if (topics) blocks.push(topics)
      if (blocks.length > 0) {
        const msg = {
          role: "user" as const,
          content: [{ type: "text" as const, text: blocks.join("\n\n") }],
        }
        const msgs = [...event.messages]
        msgs.unshift(msg)
        return { messages: msgs }
      }
    }

    // Every turn: walk project root for scoped MEMORY.md files
    const scoped = collectScopedMem(ctx.cwd, root)
    if (scoped.length === 0) return undefined

    const msgs = [...event.messages]
    msgs.push({
      role: "user" as const,
      content: [{ type: "text" as const, text: "## Scoped Memory (current directory)\n" + scoped.join("\n") }],
    })
    return { messages: msgs }
  })

  pi.on("tool_result", (event: any, ctx: any) => {
    // For built-in file tools: inject scoped memory
    const root = projectRoot || ctx.cwd
    if (!FILE_TOOLS.has(event.toolName)) return undefined

    const filePath = extractFilePathFromToolInput(event.input ?? {})
    if (!filePath) return undefined

    const abs = resolveAbsolute(ctx.cwd, filePath)
    if (!abs.startsWith(root)) return undefined

    const scoped = collectScopedMem(abs, root)
    if (scoped.length === 0) return undefined

    const scopedBlock = "## Scoped Memory for " + filePath + "\n" + scoped.join("\n")
    const newContent = [...event.content, { type: "text" as const, text: "\n\n" + scopedBlock }]

    return { content: newContent }
  })

  // --- save-memory tool ---
  const saveTool: any = {
    name: "agentmem-save",
    label: "Save Memory",
    description: "Save a project learning to persistent memory at .agentmem/. Two-step: write topic file, add index pointer.",
    parameters: {} as any,
    async execute(toolCallId: string, params: Record<string, unknown>, signal: AbortSignal | undefined, _onUpdate: any, ctx: ToolCtx) {
      const root = projectRoot || ctx.cwd
      const mdir = join(root, ".agentmem")
      const name = String(params.name ?? "")
      const desc = String(params.description ?? "")
      const type = String(params.type ?? "project")
      const who = String(params.who ?? "Agent (autonomous)")
      const context = String(params.context ?? "")
      const confidence = String(params.confidence ?? "medium")
      const content = String(params.content ?? "")
      const hook = String(params.hook ?? "").slice(0, 150)
      const subtype = String(params.subtype ?? "--")
      const contradicts = String(params.contradicts ?? "--")
      const guardTrigger = String(params.guard_trigger ?? "--")
      const args = [
        "java", "--class-path", classpath, JAVA_CLASS, "save", mdir,
        name, desc, type, subtype, who, context, confidence, content, hook,
        contradicts, guardTrigger,
      ]
      const result = Bun.spawnSync(args)
      const output = result.stdout.toString().trim() || result.stderr.toString().trim()
      if (result.exitCode !== 0) return { content: [{ type: "text", text: "ERROR: " + output }], isError: true }
      reinject(pi, root)
      return { content: [{ type: "text", text: output }] }
    },
  }
  pi.registerTool(saveTool)

  // --- forget-memory tool ---
  const forgetTool: any = {
    name: "agentmem-forget",
    label: "Forget Memory",
    description: "Delete a memory. Moves file to .cold/ and removes from MEMORY.md index.",
    parameters: {} as any,
    async execute(toolCallId: string, params: Record<string, unknown>, _signal: AbortSignal | undefined, _onUpdate: any, ctx: ToolCtx) {
      const root = projectRoot || ctx.cwd
      const mdir = join(root, ".agentmem")
      const name = String(params.name ?? "")
      const result = Bun.spawnSync(["java", "--class-path", classpath, JAVA_CLASS, "delete", mdir, name])
      const output = result.stdout.toString().trim() || result.stderr.toString().trim()
      if (result.exitCode !== 0) return { content: [{ type: "text", text: "ERROR: " + output }], isError: true }
      reinject(pi, root)
      return { content: [{ type: "text", text: output }] }
    },
  }
  pi.registerTool(forgetTool)

  const verifyTool: any = {
    name: "agentmem-verify-files",
    label: "Verify Memory Files",
    description: "Cross-reference file paths in memories against current project state. Returns STALE markers.",
    parameters: {} as any,
    async execute(_toolCallId: string, _params: Record<string, unknown>, _signal: AbortSignal | undefined, _onUpdate: any, ctx: ToolCtx) {
      const root = projectRoot || ctx.cwd
      const mdir = join(root, ".agentmem")
      const result = Bun.spawnSync(["java", "--class-path", classpath, JAVA_CLASS, "verify", mdir, root])
      const out = result.stdout.toString().trim()
      return { content: [{ type: "text", text: out || "No file references found in memories." }] }
    },
  }
  pi.registerTool(verifyTool)
}
