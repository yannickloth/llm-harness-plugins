import { type Plugin, tool } from "@opencode-ai/plugin"
import { $ } from "bun"
import path from "path"
import { existsSync } from "fs"
import { loadMemIndex, collectScopedMem, extractFilePathFromToolInput, FILE_TOOLS } from "../shared/memory-helpers"
import { createLogger, type PluginLogger } from "../../shared/plugin-logger"
import { safeSpawn, safeSpawnSync } from "../../shared/safe-spawn"

const agentmemDir = path.join(import.meta.dir, "..")
const classesDir = path.join(agentmemDir, "build", "classes")
const mainClass = "eu.infolead.llmhp.memory.MemorySystemCli"

const DREAM_INTERVAL_MS = 24 * 60 * 60 * 1000
let lastDreamRun = 0
let injectedSessionId: string | null = null
const injectedScopes = new Set<string>()
let pendingClassifications = 0
let classificationGeneration = 0
let flaggedTurnCount = 0
let keeperBusy = false
let logger: PluginLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }

function memDir(directory: string, worktree?: string): string {
  return worktree ? path.join(worktree, ".agentmem") : path.join(directory, ".agentmem")
}

function rootDir(directory: string, worktree?: string): string {
  return worktree ?? directory
}

async function parseFrontmatterOutput(raw: string): Promise<string | null> {
  if (!raw.trim()) return null
  const lines = raw.split("\n")
  const frontmatterEnd = lines.findIndex((l, i) => l === "---" && i > 0)
  const content = frontmatterEnd >= 0 ? lines.slice(frontmatterEnd + 1).join("\n").trim() : raw
  return content || null
}

async function injectBudgetedMem(client: ReturnType<Parameters<Plugin>[0]["client"]>, sessionId: string, root: string, header: string, deltaMode: boolean) {
  const mdir = path.join(root, ".agentmem")
  const cmd = deltaMode ? "budget-inject-delta" : "budget-inject"
  const proc = await safeSpawn(["java", "--class-path", classesDir, mainClass, cmd, mdir, root, sessionId])
  if (proc.exitCode !== 0) return
  const raw = proc.stdout
  const context = await parseFrontmatterOutput(raw)
  if (!context) return
  try {
    await client.session.prompt({
      path: { id: sessionId },
      body: { noReply: true, parts: [{ type: "text", text: header + context }] },
    })
  } catch (e) {
    logger.error(`budget injection failed: ${(e as Error).message}`)
  }
}

async function reinjectMemory(client: ReturnType<Parameters<Plugin>[0]["client"]>, sessionId: string, root: string) {
  await injectBudgetedMem(client, sessionId, root, "# Persistent Project Memory\n**UPDATED** — new memories just saved. These are now in your context.\n\n", true)
}

async function injectMemoryAtStartup(client: ReturnType<Parameters<Plugin>[0]["client"]>, sessionId: string, root: string) {
  const mdir = path.join(root, ".agentmem")
  if (!existsSync(path.join(mdir, "MEMORY.md"))) return
  const budgetFile = path.join(mdir, ".sessions", `budget-${sessionId.replace(/[^a-zA-Z0-9_-]/g, "_")}.json`)
  if (!existsSync(budgetFile)) {
    await safeSpawn(["java", "--class-path", classesDir, mainClass, "budget-init", mdir, sessionId]).catch(() => {})
  }
  await injectBudgetedMem(client, sessionId, root, [
    "# Persistent Project Memory",
    "",
    "These memories persist across sessions. They are ALREADY IN your context — you do NOT need to read them again.",
    "Use `save-memory` to persist new learnings.",
    "",
  ].join("\n"), false)
}

export function isInRoot(absPath: string, root: string): boolean {
  const normalizedRoot = path.resolve(root)
  const normalized = path.resolve(absPath)
  return normalized === normalizedRoot || normalized.startsWith(normalizedRoot + (normalizedRoot === path.sep ? "" : path.sep))
}

function handleScopedInject(client: ReturnType<Parameters<Plugin>[0]["client"]>, root: string, filePath: string) {
  const sessionId = injectedSessionId
  if (!sessionId) return
  const absPath = path.isAbsolute(filePath) ? filePath : path.resolve(root, filePath)
  if (!isInRoot(absPath, root)) return
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
  if (!isInRoot(absPath, root)) return
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

async function classifyMessage(text: string): Promise<boolean> {
  const prompt = `Classify whether this message contains information worth remembering across sessions. Answer YES or NO only.

Memory-worthy signals:
- User states a preference, correction, or constraint ("always do X", "never do Y", "that's wrong")
- A non-obvious decision with rationale is being discussed
- Something surprising happens (expected X, got Y)
- References to external systems, tools, or processes outside the codebase
- Project deadlines, scope changes, or architectural decisions

NOT memory-worthy:
- Simple questions ("what does X do?", "run the tests")
- Mechanical requests ("edit this file", "commit these changes")
- Greetings, acknowledgments, clarifications of the current task
- Anything derivable from current code or git history

User message: "${text.replace(/"/g, '\\"').slice(0, 800)}"

Answer (YES/NO):`

  let proc: ReturnType<typeof Bun.spawn> | null = null
  try {
    proc = Bun.spawn(
      ["opencode", "run", "--model", "deepseek/deepseek-v4-flash",
       "--agent", "memory-keeper", "--print", "--",
       "Answer YES or NO only, based on the prompt in stdin."],
      { stdin: "pipe", stdout: "pipe", stderr: "pipe" }
    )
    proc.stdin.write(prompt)
    proc.stdin.end()
    const kill = setTimeout(() => { try { proc!.kill() } catch {} }, 15_000)
    const out = await new Response(proc.stdout).text()
    clearTimeout(kill)
    return out.trim().toUpperCase() === "YES"
  } catch {
    try { proc?.kill() } catch {}
    return false
  }
}

function spawnKeeper(client: ReturnType<Parameters<Plugin>[0]["client"]>, root: string, sessionId?: string | null, reinject: boolean = true) {
  if (keeperBusy) return
  keeperBusy = true
  const capturedSessionId = sessionId ?? injectedSessionId
  let keeper: ReturnType<typeof Bun.spawn>
  try {
    keeper = Bun.spawn(
      ["opencode", "run", "--agent", "memory-keeper",
       "--model", process.env.OPENCODE_MEMORY_MODEL ?? "auto",
       "Extract non-derivable learnings from the most recent conversation and persist them to .agentmem/."],
      { stdout: "pipe", stderr: "pipe" }
    )
  } catch {
    keeperBusy = false
    return
  }
  const kill = setTimeout(() => { try { keeper.kill() } catch {} finally { keeperBusy = false } }, 120_000)
  new Response(keeper.stdout).text().then(() => {
    clearTimeout(kill)
    keeperBusy = false
    if (reinject && capturedSessionId) reinjectMemory(client, capturedSessionId, root).catch(e => logger.error(`keeper reinject failed: ${(e as Error).message}`))
  }).catch(() => { clearTimeout(kill); keeperBusy = false })
}

function flushFlaggedTurns(client: ReturnType<Parameters<Plugin>[0]["client"]>, root: string, reinject: boolean = true) {
  if (flaggedTurnCount <= 0 && pendingClassifications <= 0) return
  flaggedTurnCount = 0
  classificationGeneration++
  pendingClassifications = 0
  spawnKeeper(client, root, null, reinject)
}

function trySpawnDreamer(mdir: string) {
  const now = Date.now()
  if (now - lastDreamRun <= DREAM_INTERVAL_MS) return
  if (!existsSync(mdir)) return
  const lockCheck = safeSpawnSync(["java", "--class-path", classesDir, mainClass, "lock-check", mdir])
  if (lockCheck.stdout.trim() !== "FREE") return
  lastDreamRun = now
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
  logger = createLogger(client, "agentmem")
  logger.info("plugin active — 6 tools + classifier + auto-injection hooks")
  const root = rootDir(directory, worktree)
  const mdir = memDir(directory, worktree)

  return {
    event: async ({ event }) => {
      switch (event.type) {
        case "session.created": {
          const sid = event.properties?.sessionID
          if (!sid) return
          flushFlaggedTurns(client, root, false)
          injectedScopes.clear()
          injectedSessionId = sid
          injectMemoryAtStartup(client, sid, root)
            .then(() => logger.info(`injected memory into session ${sid}`))
            .catch(e => logger.error(`session.created injection failed: ${(e as Error).message}`))
          break
        }
        case "file.edited": {
          handleFileEditScoped(client, root, event.properties?.file ?? "")
          break
        }
        case "session.idle": {
          flushFlaggedTurns(client, root)
          trySpawnDreamer(mdir)
          break
        }
        case "session.deleted": {
          flushFlaggedTurns(client, root, false)
          break
        }
      }
    },

    "chat.message": async (input, output) => {
      const text = output.parts?.map((p: any) => p.text ?? "").join(" ") ?? ""
      if (!text || text.length < 10) return
      pendingClassifications++
      const gen = classificationGeneration
      classifyMessage(text).then(interesting => {
        if (gen !== classificationGeneration) return
        pendingClassifications--
        if (interesting) flaggedTurnCount++
      }).catch(() => {
        if (gen !== classificationGeneration) return
        pendingClassifications--
      })
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
          const proc = await safeSpawn(cmd)
          const result = proc.stdout.trim()
          if (proc.exitCode === 0) {
            const sid = injectedSessionId ?? (context as any).sessionID
            if (sid) await reinjectMemory(client, sid, root)
          }
          return result
        },
      }),

      "forget-memory": tool({
        description: "Explicitly delete a memory. Moves file to .cold/ and removes from MEMORY.md index.",
        args: {
          name: tool.schema.string().describe("Memory file name (with or without .md extension)"),
        },
        async execute(args, context) {
          const mdir = memDir(context.directory, context.worktree)
          const proc = await safeSpawn(["java", "--class-path", classesDir, mainClass, "delete", mdir, args.name])
          const result = proc.stdout.trim()
          if (proc.exitCode === 0) {
            const sid = injectedSessionId ?? (context as any).sessionID
            if (sid) await reinjectMemory(client, sid, root)
          }
          return result
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
          const lockResult = safeSpawnSync(["java", "--class-path", classesDir, mainClass, "lock-acquire", mdir])
          if (lockResult.exitCode !== 0) return "Dream already in progress (lock busy)."
          try {
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
          } finally {
            await safeSpawn(["java", "--class-path", classesDir, mainClass, "lock-release", mdir]).catch(() => {})
          }
        },
      }),

      "verify-memory-files": tool({
        description: "Cross-reference file paths in memories against current project state. Returns STALE markers for paths that no longer exist.",
        args: {},
        async execute(_args, context) {
          const mdir = memDir(context.directory, context.worktree)
          const projRoot = context.worktree ?? context.directory
          const proc = await safeSpawn(["java", "--class-path", classesDir, mainClass, "verify", mdir, projRoot])
          const text = proc.stdout.trim()
          if (proc.exitCode !== 0) return text || "Verification failed."
          return text || "No file references found in memories."
        },
      }),

      "verify-memory-report": tool({
        description: "Generate a full memory file-reference verification report with table of OK/STALE paths.",
        args: {},
        async execute(_args, context) {
          const mdir = memDir(context.directory, context.worktree)
          const projRoot = context.worktree ?? context.directory
          const proc = await safeSpawn(["java", "--class-path", classesDir, mainClass, "verify-report", mdir, projRoot])
          const text = proc.stdout.trim()
          if (proc.exitCode !== 0) return text || "Verification report failed."
          return text || "No file references found in memories."
        },
      }),

      "memory-budget-status": tool({
        description: "Check per-session memory injection token budget status (12,000 token ceiling).",
        args: {},
        async execute(_args, context) {
          const mdir = memDir(context.directory, context.worktree)
          const sid = injectedSessionId ?? "default"
          const result = await $`java --class-path ${classesDir} ${mainClass} budget-status ${mdir} ${sid}`.nothrow().text()
          return result.trim() || "No budget data."
        },
      }),
    },
  }
}
