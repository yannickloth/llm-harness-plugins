import type { Plugin, tool } from "@opencode-ai/plugin"
import { $ } from "bun"
import path from "path"
import { existsSync, statSync } from "fs"
import { loadMemIndex, collectTopicFiles, collectScopedMem, extractFilePathFromToolInput, FILE_TOOLS } from "../shared/memory-helpers"

const agentmemDir = path.join(import.meta.dir, "..")
const classesDir = path.join(agentmemDir, "build", "classes")
const mainClass = "eu.infolead.llmhp.memory.MemorySystemCli"

const DREAM_INTERVAL_MS = 24 * 60 * 60 * 1000
const KEEPER_DEBOUNCE_MS = 60_000
let lastKeeperRun = 0
let lastDreamRun = 0
let injectedSessionId: string | null = null
const injectedScopes = new Set<string>()

function memDir(directory: string, worktree?: string): string {
  return worktree ? path.join(worktree, ".agentmem") : path.join(directory, ".agentmem")
}

function rootDir(directory: string, worktree?: string): string {
  return worktree ?? directory
}

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

function handleScopedInject(client: ReturnType<Parameters<Plugin>[0]["client"]>, root: string, filePath: string) {
  const sessionId = injectedSessionId
  if (!sessionId) return
  const absPath = path.isAbsolute(filePath) ? filePath : path.resolve(root, filePath)
  if (!absPath.startsWith(root)) return
  const scoped = collectScopedMem(absPath, root)
  if (scoped.length === 0) return
  const dedupKey = absPath + "|" + scoped.length
  if (injectedScopes.has(dedupKey)) return
  injectedScopes.add(dedupKey)
  client.session.prompt({
    path: { id: sessionId },
    body: { noReply: true, parts: [{ type: "text", text: "## Scoped Memory for current file/operation\n" + scoped.join("\n") }] },
  }).catch(() => {})
}

function handleFileEditScoped(client: ReturnType<Parameters<Plugin>[0]["client"]>, root: string, file: string) {
  const sessionId = injectedSessionId
  if (!sessionId) return
  const absPath = path.isAbsolute(file) ? file : path.resolve(root, file)
  if (!absPath.startsWith(root)) return
  const scoped = collectScopedMem(absPath, root)
  if (scoped.length === 0) return
  const dedupKey = absPath + "|edit"
  if (injectedScopes.has(dedupKey)) return
  injectedScopes.add(dedupKey)
  client.session.prompt({
    path: { id: sessionId },
    body: { parts: [{ type: "text", text: "## Scoped Memory for edited file\n" + scoped.join("\n") }], noReply: true },
  }).catch(() => {})
}

function trySpawnKeeper(mdir: string, client: ReturnType<Parameters<Plugin>[0]["client"]>, root: string) {
  const now = Date.now()
  if (now - lastKeeperRun <= KEEPER_DEBOUNCE_MS) return
  if (!existsSync(mdir)) return
  const lastWrite = path.join(mdir, ".last-write")
  let mtime = 0
  try { mtime = statSync(lastWrite).mtimeMs } catch {}
  if (now - mtime <= 15_000) return
  lastKeeperRun = now
  const keeper = Bun.spawn(
    ["opencode", "run", "--agent", "memory-keeper",
     "--model", process.env.OPENCODE_MEMORY_MODEL ?? "auto",
     "Extract non-derivable learnings from the most recent conversation and persist them to .agentmem/."],
    { stdout: "pipe", stderr: "pipe" }
  )
  const kill = setTimeout(() => { try { keeper.kill() } catch {} }, 120_000)
  new Response(keeper.stdout).text().then(() => {
    clearTimeout(kill)
    if (injectedSessionId) reinjectMemory(client, injectedSessionId, root)
  }).catch(() => { clearTimeout(kill) })
}

function trySpawnDreamer(mdir: string) {
  const now = Date.now()
  if (now - lastDreamRun <= DREAM_INTERVAL_MS) return
  if (!existsSync(mdir)) return
  lastDreamRun = now
  const lockCheck = Bun.spawnSync(["java", "--class-path", classesDir, mainClass, "lock-check", mdir])
  if (lockCheck.stdout.toString().trim() !== "FREE") return
  const dreamer = Bun.spawn(
    ["opencode", "run", "--agent", "memory-dreamer",
     "--model", process.env.OPENCODE_MEMORY_MODEL ?? "auto",
     "Consolidate, deduplicate, prune, and link memories in .agentmem/."],
    { stdout: "pipe", stderr: "pipe" }
  )
  const kill = setTimeout(() => { try { dreamer.kill() } catch {} }, 300_000)
  new Response(dreamer.stdout).text().then(() => clearTimeout(kill)).catch(() => clearTimeout(kill))
}

export default async ({ client, directory, worktree }: Parameters<Plugin>[0]) => {
  console.log("[agentmem] plugin active — 6 tools + auto-injection hooks")
  const root = rootDir(directory, worktree)

  return {
    event: async ({ event }) => {
      switch (event.type) {
        case "session.created": {
          const sid = event.properties?.sessionID
          if (!sid) return
          const mdir = memDir(directory, worktree)
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
              path: { id: sid },
              body: { noReply: true, parts: [{ type: "text", text: context }] },
            })
            injectedSessionId = sid
            console.log("[agentmem] injected memory into session", sid)
          } catch (e) {
            console.error("[agentmem] session.created injection failed:", (e as Error).message)
          }
          break
        }
        case "file.edited": {
          handleFileEditScoped(client, root, event.properties?.file ?? "")
          break
        }
        case "session.idle": {
          const mdir = path.join(root, ".agentmem")
          trySpawnKeeper(mdir, client, root)
          trySpawnDreamer(mdir)
          break
        }
      }
    },

    "tool.execute.after": (input, output) => {
      if (!FILE_TOOLS.has(input.tool)) return
      const filePath = extractFilePathFromToolInput(input.args ?? {})
      if (!filePath) return
      if (input.sessionID) injectedSessionId = input.sessionID
      handleScopedInject(client, root, filePath)
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
          const mdir = memDir(context.directory, context.worktree)
          const cmd = [
            "java", "--class-path", classesDir,
            mainClass, "save", mdir,
            args.name, args.description, args.type,
            args.subtype ?? "--",
            args.who, args.context, args.confidence,
            args.content, args.hook,
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
          const mdir = memDir(context.directory, context.worktree)
          const result = await $`java --class-path ${classesDir} ${mainClass} delete ${mdir} ${args.name}`.nothrow().text()
          if (injectedSessionId) await reinjectMemory(client, injectedSessionId, root)
          return result.trim()
        },
      }),

      "check-memory-health": tool({
        description: "Check memory directory health: dangling pointers, orphans, index size.",
        args: {},
        async execute(_args, context) {
          const mdir = memDir(context.directory, context.worktree)
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
          const mdir = memDir(context.directory, context.worktree)
          const repoPath = args.repo_path ?? context.worktree ?? context.directory
          const result = await $`java --class-path ${classesDir} ${mainClass} bootstrap ${mdir} ${repoPath}`.nothrow().text()
          return result.trim()
        },
      }),

      "prune-memories": tool({
        description: "List memory files eligible for pruning based on decay curves. Returns prune candidates.",
        args: {
          type: tool.schema.string().optional().describe("Filter by memory type (user|feedback|project|reference)"),
        },
        async execute(_args, context) {
          const mdir = memDir(context.directory, context.worktree)
          const result = await $`java --class-path ${classesDir} ${mainClass} lifecycle-prune ${mdir}`.nothrow().text()
          return result.trim()
        },
      }),

      "dream": tool({
        description: "Run memory consolidation. Merges, deduplicates, prunes, and links memories.",
        args: {},
        async execute(_args, context) {
          const mdir = memDir(context.directory, context.worktree)
          const result = Bun.spawnSync(["java", "--class-path", classesDir, mainClass, "lock-check", mdir])
          if (result.stdout.toString().trim() !== "FREE") return "Dream already in progress (lock busy)."
          const dreamer = Bun.spawn(
            ["opencode", "run", "--agent", "memory-dreamer",
             "--model", process.env.OPENCODE_MEMORY_MODEL ?? "auto",
             "Consolidate, deduplicate, prune, and link memories in .agentmem/."],
            { stdout: "pipe", stderr: "pipe" }
          )
          const kill = setTimeout(() => { try { dreamer.kill() } catch {} }, 300_000)
          try {
            const out = await new Response(dreamer.stdout).text()
            return out.trim() || "Dream complete."
          } finally { clearTimeout(kill) }
        },
      }),
    },
  }
}
