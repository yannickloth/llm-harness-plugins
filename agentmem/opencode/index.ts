import type { Plugin, tool } from "@opencode-ai/plugin"
import { $ } from "bun"
import path from "path"
import { existsSync, readdirSync, statSync, readFileSync } from "fs"

const agentmemDir = path.join(import.meta.dir, "..")
const classesDir = path.join(agentmemDir, "build", "classes")
const mainClass = "eu.infolead.llmhp.memory.MemorySystemCli"

const MAX_INJECT_LENGTH = 8000
const FILE_TOOLS = new Set(["read", "grep", "glob", "edit", "write", "find", "ls"])

function memDir(context: { worktree?: string; directory: string }): string {
  return context.worktree
    ? path.join(context.worktree, ".agentmem")
    : path.join(context.directory, ".agentmem")
}

function loadMemIndex(memDirPath: string): string | null {
  const f = path.join(memDirPath, "MEMORY.md")
  if (!existsSync(f)) return null
  const content = readFileSync(f, "utf-8").trim()
  if (!content) return null
  return content.length > MAX_INJECT_LENGTH
    ? content.slice(0, MAX_INJECT_LENGTH) + "\n... [truncated]"
    : content
}

function collectScopedMem(cwd: string, projectRoot: string): string[] {
  const results: string[] = []
  let current = cwd
  while (current.startsWith(projectRoot)) {
    const memFile = path.join(current, "MEMORY.md")
    if (existsSync(memFile) && current !== path.join(projectRoot, ".agentmem")) {
      const content = readFileSync(memFile, "utf-8").trim()
      if (content) {
        const relDir = path.relative(projectRoot, current) || "root"
        results.push(`### Scoped memory: ${relDir}\n${content}`)
      }
    }
    if (current === projectRoot) break
    current = path.dirname(current)
  }
  return results
}

function collectTopicFiles(memDirPath: string): string {
  if (!existsSync(memDirPath)) return ""
  const parts: string[] = []
  const entries = readdirSync(memDirPath)
    .filter(e => e.endsWith(".md") && e !== "MEMORY.md" && e !== "REVIEW.md")
    .sort()
  for (const entry of entries) {
    const filePath = path.join(memDirPath, entry)
    if (!statSync(filePath).isFile()) continue
    const content = readFileSync(filePath, "utf-8")
    const combined = `\n<!-- memory: ${entry} -->\n${content}`
    parts.push(combined)
  }
  const full = parts.join("\n")
  return full.length > MAX_INJECT_LENGTH
    ? full.slice(0, MAX_INJECT_LENGTH) + "\n... [truncated]"
    : full
}

function extractFilePathFromToolInput(input: Record<string, unknown>): string | null {
  if (typeof input.filePath === "string") return input.filePath
  if (typeof input.file_path === "string") return input.file_path
  if (typeof input.query === "object" && input.query) {
    const q = input.query as Record<string, unknown>
    if (typeof q.path === "string") return q.path
    if (typeof q.directory === "string") return q.directory
  }
  if (typeof input.target_directory === "string") return input.target_directory
  if (typeof input.path === "string") return input.path
  return null
}

let injectedSessionId: string | null = null
const injectedScopes = new Set<string>()

async function reinjectMemory(client: ReturnType<Parameters<Plugin>[0]["client"]>, sessionId: string, root: string) {
  const mdir = path.join(root, ".agentmem")
  const memIndex = loadMemIndex(mdir)
  if (!memIndex) return
  const topicFiles = collectTopicFiles(mdir)
  const context = [
    "# Persistent Project Memory",
    "**UPDATED** — new memories just saved. These are now in your context.",
    "",
    memIndex,
    topicFiles,
  ].join("\n")
  try {
    await client.session.prompt({
      path: { id: sessionId },
      body: { noReply: true, parts: [{ type: "text", text: context }] },
    })
  } catch (e) {
    console.error("[agentmem] reinject failed:", (e as Error).message)
  }
}

export default async ({ project, client, $, directory, worktree }: Parameters<Plugin>[0]) => {
  console.log("[agentmem] plugin active — 4 tools + auto-injection hooks")
  const root = worktree ?? directory

  return {
    "session.created": async (input: { properties?: { session?: { id?: string } } }) => {
      const sessionId = input?.properties?.session?.id
      if (!sessionId) return

      const mdir = path.join(root, ".agentmem")
      const memIndex = loadMemIndex(mdir)
      if (!memIndex) return

      const topicFiles = collectTopicFiles(mdir)

      const context = [
        "# Persistent Project Memory",
        "",
        "These memories persist across sessions. They are ALREADY IN your context — you do NOT need to read them again.",
        "Use `save-memory` to persist new learnings.",
        "",
        memIndex,
        topicFiles,
      ].join("\n")

      try {
        await client.session.prompt({
          path: { id: sessionId },
          body: {
            noReply: true,
            parts: [{ type: "text", text: context }],
          },
        })
        injectedSessionId = sessionId
        console.log("[agentmem] injected memory into session", sessionId)
      } catch (e) {
        console.error("[agentmem] session.created injection failed:", (e as Error).message)
      }
    },

    "tool.execute.after": async (event: {
      tool: string
      input: Record<string, unknown>
      output: Record<string, unknown>
      context?: { sessionID?: string }
    }) => {
      if (!FILE_TOOLS.has(event.tool)) return

      const filePath = extractFilePathFromToolInput(event.input)
      if (!filePath) return

      const sessionId = event.context?.sessionID ?? injectedSessionId
      if (!sessionId) return

      const absPath = path.isAbsolute(filePath) ? filePath : path.resolve(root, filePath)
      if (!absPath.startsWith(root)) return

      const scoped = collectScopedMem(absPath, root)
      if (scoped.length === 0) return

      const context = [
        "## Scoped Memory for current file/operation",
        scoped.join("\n"),
      ].join("\n")

      const dedupKey = absPath + "|" + context.length
      if (injectedScopes.has(dedupKey)) return
      injectedScopes.add(dedupKey)

      try {
        await client.session.prompt({
          path: { id: sessionId },
          body: {
            noReply: true,
            parts: [{ type: "text", text: context }],
          },
        })
      } catch (e) {
        // silently ignore — best-effort injection
      }
    },

    "file.edited": async (input: { file: string }) => {
      const sessionId = injectedSessionId
      if (!sessionId) return

      const absPath = path.isAbsolute(input.file) ? input.file : path.resolve(root, input.file)
      if (!absPath.startsWith(root)) return

      const scoped = collectScopedMem(absPath, root)
      if (scoped.length === 0) return

      const dedupKey = absPath + "|edit"
      if (injectedScopes.has(dedupKey)) return
      injectedScopes.add(dedupKey)

      try {
        await client.session.prompt({
          path: { id: sessionId },
          body: {
            parts: [{ type: "text", text: "## Scoped Memory for edited file\n" + scoped.join("\n") }],
            noReply: true,
          },
        })
      } catch (e) {
        // silently ignore
      }
    },

    tool: {
      "save-memory": tool({
        description: "Save a project learning to persistent memory. Two-step protocol: write topic file with frontmatter, then add index pointer to MEMORY.md.",
        args: {
          name: tool.schema.string().describe("Filename stem, [a-zA-Z0-9_-]+"),
          description: tool.schema.string().describe("One-line relevance summary"),
          type: tool.schema.enum(["user", "feedback", "project", "reference"]),
          subtype: tool.schema.string().optional().describe("failure | serendipity | anomaly | digest | question | episode"),
          who: tool.schema.string().describe("Human | Agent (user-requested) | Agent (autonomous)"),
          context: tool.schema.string().describe("What problem was being solved"),
          confidence: tool.schema.enum(["high", "medium", "low", "speculative"]).default("medium"),
          content: tool.schema.string().describe("Body. For feedback/project: What/Why/How-to-apply/Who/Context"),
          hook: tool.schema.string().describe("One-line MEMORY.md pointer, <=150 chars"),
          contradicts: tool.schema.string().optional(),
          guard_trigger: tool.schema.string().optional(),
        },
        async execute(args, context) {
          const mdir = memDir(context)
          const cmd = [
            "java", "--class-path", classesDir,
            mainClass, "save", mdir,
            args.name, args.description, args.type, args.who,
            args.context, args.confidence, args.content, args.hook,
            args.subtype ?? "--",
            args.contradicts ?? "--",
            args.guard_trigger ?? "--"
          ]
          const result = await $`${cmd}`.nothrow().text()
          if (injectedSessionId) await reinjectMemory(client, injectedSessionId, root)
          return result.trim()
        },
      }),

      "forget-memory": tool({
        description: "Explicitly delete a memory. Moves file to .cold/ and removes from MEMORY.md index.",
        args: {
          name: tool.schema.string().describe("Memory file name (with or without .md extension)"),
        },
        async execute(args, context) {
          const mdir = memDir(context)
          const result = await $`java --class-path ${classesDir} ${mainClass} delete ${mdir} ${args.name}`.nothrow().text()
          if (injectedSessionId) await reinjectMemory(client, injectedSessionId, root)
          return result.trim()
        },
      }),

      "check-memory-health": tool({
        description: "Check memory directory health: dangling pointers, orphans, index size.",
        args: {},
        async execute(_args, context) {
          const mdir = memDir(context)
          const result = await $`java --class-path ${classesDir} ${mainClass} quality-health ${mdir}`.nothrow().text()
          return result.trim()
        },
      }),

      "init-memory": tool({
        description: "Bootstrap memory from git history. Scans commits for patterns: frequent fixes, reverted refactors, config breaks.",
        args: {
          repo_path: tool.schema.string().optional(),
        },
        async execute(args, context) {
          const mdir = memDir(context)
          const repoPath = args.repo_path
            ?? context.worktree
            ?? context.directory
          const result = await $`java --class-path ${classesDir} ${mainClass} bootstrap ${mdir} ${repoPath}`.nothrow().text()
          return result.trim()
        },
      }),
    },
  }
}
