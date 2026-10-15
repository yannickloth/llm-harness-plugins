import { type Plugin, tool } from "@opencode-ai/plugin"
import { $ } from "bun"
import path from "path"
import { existsSync, mkdirSync, openSync, writeFileSync, closeSync, readFileSync, rmSync } from "fs"
import { collectScopedMem, extractFilePathFromToolInput, FILE_TOOLS } from "../shared/memory-helpers"
import { createLogger, type PluginLogger } from "../../shared/plugin-logger"
import { safeSpawn, safeSpawnSync, spawnDetached, killProcessTree, NO_SUBSPAWN_ENV, extractOpencodeText, extractOpencodeSessionId } from "../../shared/safe-spawn"
import { shouldInjectProjectContext, updateSessionTopic, getSessionTopic } from "../../shared/session-topic"
import { moduleDir } from "../../shared/module-dir"
import { isInRoot } from "./path-utils"
import { writeLoadCanary } from "../../shared/load-canary"

const agentmemDir = path.join(moduleDir(import.meta.url, import.meta.dir), "..")
const classesDir = path.join(agentmemDir, "build", "classes")
const mainClass = "eu.infolead.llmhp.memory.MemorySystemCli"

const DREAM_INTERVAL_MS = 24 * 60 * 60 * 1000
let lastDreamRun = 0
function sanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, "_")
}
let injectedSessionId: string | null = null
const injectedScopes = new Set<string>()
let pendingClassifications = 0
let classificationGeneration = 0
let flaggedTurnCount = 0
let keeperBusy = false
let logger: PluginLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }
const startupInjectedForSession = new Set<string>()

/**
 * The per-message classifier spawns `opencode run --agent memory-keeper` — a
 * heavyweight subprocess (own model connection + memory + all plugins loaded,
 * ~2GB RSS). With many opencode sessions and one spawn per chat message, this
 * is an unbounded spawn storm. These limits cap both concurrency (one in
 * flight per process) and rate (one spawn per window, shared across all
 * sessions via a coordination file in `.agentmem/`).
 *
 * The interval must be generous: at the previous 30s the classifier spawned a
 * 2GB subprocess every 30s per process (observed ~670/hr host-wide across 7+
 * opencode processes), saturating CPU/RAM and stalling interactive sessions.
 * The memory-keeper still runs on session.idle when turns were flagged, so
 * memory capture is preserved without a subprocess per message.
 */
const CLASSIFY_MIN_INTERVAL_MS = (() => {
  const raw = process.env.OPENCODE_MEMORY_CLASSIFY_INTERVAL_MS
  const parsed = raw ? parseInt(raw, 10) : NaN
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 5 * 60 * 1000
})()
let classifierBusy = false
let lastClassifyAt = 0
const CLASSIFY_LOCK_FILE = ".classify-lock"
const CLASSIFY_LAST_FILE = ".classify-last"

/**
 * Remove a coordination lock file left by a session that crashed while holding
 * it. Only steals when the recorded owner PID is dead, so we never block a
 * live holder. Mirrors the graphrag plugin's lock-steal logic.
 */
function stealStaleLock(lockFile: string): void {
  if (!existsSync(lockFile)) return
  const pid = parseInt(readFileSync(lockFile, "utf8").trim().split("\n")[0] ?? "", 10)
  if (!Number.isFinite(pid) || pid <= 0) return
  if (Bun.spawnSync(["kill", "-0", String(pid)]).exitCode !== 0) {
    try {
      rmSync(lockFile, { force: true })
    } catch { /* best effort */ }
  }
}

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
  // Keep the chat window lean: persist the full memory context to a markdown
  // file and inject only a one-line pointer. The model reads the file on demand
  // (mirrors the lazy-loaded AGENTS.md rule pattern), so the chat stays short.
  const detailFile = path.join(mdir, "injections", `${sanitize(sessionId)}.md`)
  try {
    mkdirSync(path.dirname(detailFile), { recursive: true })
    writeFileSync(detailFile, context + "\n")
  } catch (e: any) {
    logger.warn(`memory detail write failed: ${e?.message ?? String(e)}`)
  }
  const relPath = path.relative(root, detailFile)
  try {
    await client.session.prompt({
      path: { id: sessionId },
      body: { noReply: true, parts: [{ type: "text", text: header + `Full persistent memory — details in \`${relPath}\`.\n` }] },
    })
  } catch (e) {
    logger.error(`budget injection failed: ${(e as Error).message}`)
  }
}

async function reinjectMemory(client: ReturnType<Parameters<Plugin>[0]["client"]>, sessionId: string, root: string) {
  await injectBudgetedMem(client, sessionId, root, "# Persistent Project Memory\n**UPDATED** — new memories just saved. Details below; read the file if you need them.\n\n", true)
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
    "These memories persist across sessions. Full content is in the details file — read it on demand.",
    "Use `save-memory` to persist new learnings.",
    "",
  ].join("\n"), false)
}

const MAINTENANCE_TITLE_RE = /^Memory maintenance(?: |$)/

/**
 * Delete a throwaway maintenance session (classifier/keeper/dreamer) created
 * by an `opencode run` subprocess. These are vacuous by design; leaving them
 * in the DB cluttered the `/sessions` list (observed: ~1800 at peak). Best
 * effort — never fatal if the session is already gone or a delete races.
 */
async function deleteMaintenanceSession(
  client: ReturnType<Parameters<Plugin>[0]["client"]>,
  sessionId: string | null | undefined,
  kind: string,
): Promise<void> {
  if (!sessionId) return
  try {
    await client.session.delete({ path: { id: sessionId } })
    logger.info(`cleaned up ${kind} maintenance session ${sessionId}`)
  } catch (e: any) {
    logger.warn(`failed to clean up ${kind} session ${sessionId}: ${e?.message ?? String(e)}`)
  }
}

/**
 * Delete stale "Memory maintenance (...)" sessions already in the project's
 * session list (leftovers from crashes or pre-fix runs). The typed SDK list
 * endpoint only exposes `directory`, so we page through the most-recent
 * sessions and delete every maintenance-titled root session, repeating until
 * a full pass finds none. Self-terminating and idempotent — it only ever
 * removes sessions with the plugin's own maintenance title.
 */
async function sweepMaintenanceSessions(
  client: ReturnType<Parameters<Plugin>[0]["client"]>,
  root: string,
): Promise<void> {
  let deleted = 0
  for (let round = 0; round < 200; round++) {
    const { data } = await client.session.list({ directory: root }).catch(() => ({ data: undefined }))
    const rows = data ?? []
    const targets = rows.filter((s: any) => !s.parentID && MAINTENANCE_TITLE_RE.test(s.title ?? ""))
    if (targets.length === 0) break
    const results = await Promise.allSettled(targets.map((s: any) => client.session.delete({ path: { id: s.id } })))
    deleted += results.filter((r) => r.status === "fulfilled").length
    // Limit a single sweep to a bounded volume; leftover rows are swept on the
    // next activation.
    if (deleted >= 5000) break
  }
  if (deleted > 0) logger.info(`swept ${deleted} stale Memory-maintenance sessions`)
}

function handleScopedInject(client: ReturnType<Parameters<Plugin>[0]["client"]>, root: string, filePath: string, topicGate: boolean) {
  const sessionId = injectedSessionId
  if (!sessionId) return
  if (topicGate && !shouldInjectProjectContext(sessionId)) return
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

function handleFileEditScoped(client: ReturnType<Parameters<Plugin>[0]["client"]>, root: string, file: string, topicGate: boolean) {
  const sessionId = injectedSessionId
  if (!sessionId) return
  if (topicGate && !shouldInjectProjectContext(sessionId)) return
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

/**
 * Rate-limited, mutex-guarded wrapper around classifyMessage. Returns null
 * when a classification is already in flight in this process or one ran too
 * recently (cross-session, via a shared timestamp file), so we never spawn
 * an `opencode run` subprocess per message under load.
 */
async function shouldClassifyNow(mdir: string): Promise<boolean> {
  // A plugin-loaded child opencode process must never re-launch its own
  // classifier; this is what prevents the recursive spawn storm.
  if (process.env[NO_SUBSPAWN_ENV] === "1") return false
  if (classifierBusy) return false
  const now = Date.now()
  if (now - lastClassifyAt < CLASSIFY_MIN_INTERVAL_MS) return false

  const lockFile = path.join(mdir, CLASSIFY_LOCK_FILE)
  mkdirSync(mdir, { recursive: true })
  stealStaleLock(lockFile)
  try {
    const fd = openSync(lockFile, "wx")
    writeFileSync(fd, `${process.pid}\n`)
    closeSync(fd)
  } catch (err: any) {
    if (err?.code === "EEXIST") return false
    throw err
  }
  try {
    const lastFile = path.join(mdir, CLASSIFY_LAST_FILE)
    if (existsSync(lastFile)) {
      const last = parseInt(readFileSync(lastFile, "utf8").trim(), 10)
      if (Number.isFinite(last) && now - last < CLASSIFY_MIN_INTERVAL_MS) return false
    }
    writeFileSync(lastFile, String(now))
    classifierBusy = true
    lastClassifyAt = now
    return true
  } finally {
    rmSync(lockFile, { force: true })
  }
}

async function classifyMessage(client: ReturnType<Parameters<Plugin>[0]["client"]>, text: string): Promise<boolean> {
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
    proc = spawnDetached(
      ["opencode", "run", "--model", "deepseek/deepseek-flash",
       "--agent", "memory-keeper", "--format", "json", "--title", "Memory maintenance (classifier)", "--",
       "Answer YES or NO only, based on the prompt in stdin."],
      { stdin: "pipe", stdout: "pipe", stderr: "ignore" }
    )
    proc.stdin!.write(prompt)
    proc.stdin!.end()
    const kill = setTimeout(() => { try { killProcessTree(proc!) } catch {} }, 15_000)
    // Bound the wait so an unkillable survivor that never closes stdout cannot
    // hang the blocking chat.message hook and strand `classifierBusy` forever.
    const CAP_MS = 18_000
    const out = await Promise.race([
      new Response(proc.stdout).text(),
      new Promise<string | null>(resolve => setTimeout(() => resolve(null), CAP_MS)),
    ])
    clearTimeout(kill)
    // The classifier's `opencode run` created a throwaway session; remove it so
    // it never shows up in the user's session list.
    if (out != null) {
      await deleteMaintenanceSession(client, extractOpencodeSessionId(out), "classifier")
      return extractOpencodeText(out).toUpperCase() === "YES"
    }
    return false
  } catch {
    try { if (proc) killProcessTree(proc) } catch {}
    return false
  } finally {
    classifierBusy = false
  }
}

function spawnKeeper(client: ReturnType<Parameters<Plugin>[0]["client"]>, root: string, sessionId?: string | null, reinject: boolean = true) {
  if (keeperBusy) return
  keeperBusy = true
  const capturedSessionId = sessionId ?? injectedSessionId
  let keeper: ReturnType<typeof Bun.spawn>
  try {
    keeper = spawnDetached(
      ["opencode", "run", "--format", "json", "--agent", "memory-keeper",
       "--model", process.env.OPENCODE_MEMORY_MODEL ?? "auto",
       "--title", "Memory maintenance (keeper)",
       "Extract non-derivable learnings from the most recent conversation and persist them to .agentmem/."],
      { stdout: "pipe", stderr: "pipe" }
    )
  } catch {
    keeperBusy = false
    return
  }
  const kill = setTimeout(() => { try { killProcessTree(keeper) } catch {} }, 120_000)
  const finish = () => {
    clearTimeout(kill)
    keeperBusy = false
  }
  // Bound the wait so an unkillable survivor that never closes stdout cannot
  // strand `keeperBusy` and disable future keepers. Reinject only once the
  // keeper's stdout actually closes (it finished), never on the timeout cap.
  const CAP_MS = 125_000
  const textP = new Response(keeper.stdout).text().catch(() => "")
  Promise.race([
    textP.then(async (out) => {
      await deleteMaintenanceSession(client, extractOpencodeSessionId(out), "keeper")
      if (reinject && capturedSessionId) reinjectMemory(client, capturedSessionId, root).catch(e => logger.error(`keeper reinject failed: ${(e as Error).message}`))
    }),
    new Promise(resolve => setTimeout(resolve, CAP_MS)),
  ]).finally(finish)
}

function flushFlaggedTurns(client: ReturnType<Parameters<Plugin>[0]["client"]>, root: string, reinject: boolean = true) {
  if (process.env[NO_SUBSPAWN_ENV] === "1") return
  if (flaggedTurnCount <= 0 && pendingClassifications <= 0) return
  flaggedTurnCount = 0
  classificationGeneration++
  pendingClassifications = 0
  spawnKeeper(client, root, null, reinject)
}

function trySpawnDreamer(client: ReturnType<Parameters<Plugin>[0]["client"]>, mdir: string) {
  // A plugin-loaded child opencode process must never re-launch its own
  // dreamer/keeper/classifier subprocesses. Without this guard, `session.idle`
  // in the spawned `opencode run` fires this handler again, recursively
  // spawning an unbounded spawn storm (observed: dozens of `memory-dreamer`
  // processes at ~400MB RSS each).
  if (process.env[NO_SUBSPAWN_ENV] === "1") return
  const now = Date.now()
  if (now - lastDreamRun <= DREAM_INTERVAL_MS) return
  if (!existsSync(mdir)) return
  // Atomically claim the consolidation slot so only one dreamer runs host-wide.
  // We record THIS plugin process as the lock owner (lock-acquire-pid) because
  // the default lock-acquire would write the short-lived Java subprocess's own
  // PID, which is dead by the time a second session checks — letting two
  // dreamers run concurrently. Owning with the live plugin PID makes the
  // `kill -0`/isAlive liveness check in ConsolidationLock report a live holder
  // for the whole dream, restoring true cross-process mutual exclusion.
  const lockResult = safeSpawnSync(["java", "--class-path", classesDir, mainClass, "lock-acquire-pid", mdir, String(process.pid)])
  if (lockResult.exitCode !== 0 || lockResult.stdout.trim() !== "ACQUIRED") return
  let dreamer: ReturnType<typeof Bun.spawn> | null = null
  try {
    dreamer = spawnDetached(
      ["opencode", "run", "--format", "json", "--agent", "memory-dreamer",
       "--model", process.env.OPENCODE_MEMORY_MODEL ?? "auto",
       "--title", "Memory maintenance (dreamer)",
       "Consolidate, deduplicate, prune, and link memories in .agentmem/."],
      { stdout: "pipe", stderr: "pipe" }
    )
  } catch {
    // Spawn failed before the dreamer started — release the lock immediately so
    // we don't wedge future consolidation attempts. lastDreamRun is left
    // untouched so a later idle is free to retry.
    safeSpawn(["java", "--class-path", classesDir, mainClass, "lock-release", mdir]).catch(() => {})
    return
  }
  // Only mark the slot consumed once the dreamer actually launched.
  lastDreamRun = now
  const kill = setTimeout(() => { try { killProcessTree(dreamer!) } catch {} }, 300_000)
  // Hold the lock until the dreamer finishes (stdout closes), then release.
  // Bounded by a cap so a pathological unkillable survivor cannot leak the lock
  // indefinitely; the 300s kill normally closes stdout and settles this first.
  const release = () => {
    clearTimeout(kill)
    safeSpawn(["java", "--class-path", classesDir, mainClass, "lock-release", mdir]).catch(() => {})
  }
  const RELEASE_CAP_MS = 320_000
  Promise.race([
    new Response(dreamer.stdout).text().catch(() => "").then(out => deleteMaintenanceSession(client, extractOpencodeSessionId(out), "dreamer")),
    new Promise(resolve => setTimeout(resolve, RELEASE_CAP_MS)),
  ]).finally(release)
}

type AgentmemOptions = {
  /**
   * If true (default), only inject memory context into sessions classified as
   * project-related. Personal/non-coding sessions are left alone.
   */
  topicGate?: boolean
}

// ---------------------------------------------------------------------------
// v1 entrypoint.
// ---------------------------------------------------------------------------
const v1Factory = async ({ client, directory, worktree }: Parameters<Plugin>[0], options: AgentmemOptions = {}) => {
  writeLoadCanary("agentmem")
  logger = createLogger(client, "agentmem")
  const topicGate = options.topicGate ?? true
  logger.info(`plugin active — 6 tools + classifier + auto-injection hooks; topic gate: ${topicGate}`)
  const root = rootDir(directory, worktree)
  const mdir = memDir(directory, worktree)
  // Clear any pre-existing "Memory maintenance" sessions (leftovers from
  // crashes or pre-cleanup runs) so they no longer clutter the session list.
  // Fire-and-forget: it only deletes sessions bearing the plugin's own
  // maintenance title and is self-limiting.
  sweepMaintenanceSessions(client, root).catch(e => logger.warn(`maintenance sweep failed: ${(e as Error).message}`))

  return {
    event: async ({ event }) => {
      switch (event.type) {
        case "session.created": {
          const sid = event.properties?.sessionID
          if (!sid) return
          flushFlaggedTurns(client, root, false)
          injectedScopes.clear()
          injectedSessionId = sid
          // Memory injection is deferred to the first chat.message so the topic
          // gate can decide whether this is a project session. Personal
          // sessions are never injected with project memory.
          break
        }
        case "file.edited": {
          handleFileEditScoped(client, root, event.properties?.file ?? "", topicGate)
          break
        }
        case "session.idle": {
          flushFlaggedTurns(client, root)
          trySpawnDreamer(client, mdir)
          break
        }
        case "session.deleted": {
          flushFlaggedTurns(client, root, false)
          const dsid = event.properties?.sessionID
          if (dsid) startupInjectedForSession.delete(dsid)
          break
        }
      }
    },

    "chat.message": async (input, output) => {
      const text = output.parts?.map((p: any) => p.text ?? "").join(" ") ?? ""
      if (!text || text.length < 10) return
      updateSessionTopic(input.sessionID, text)
      const projectSession = topicGate ? shouldInjectProjectContext(input.sessionID) : true
      if (projectSession && !startupInjectedForSession.has(input.sessionID)) {
        startupInjectedForSession.add(input.sessionID)
        injectMemoryAtStartup(client, input.sessionID, root)
          .then(() => logger.info(`injected memory into session ${input.sessionID}`))
          .catch(e => logger.error(`startup injection failed: ${(e as Error).message}`))
      }
      if (!projectSession) return
      const allow = await shouldClassifyNow(mdir)
      if (!allow) return
      pendingClassifications++
      const gen = classificationGeneration
      classifyMessage(client, text).then(interesting => {
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
      handleScopedInject(client, root, filePath, topicGate)
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
          // A plugin-loaded child opencode process must not re-launch a dreamer
          // subprocess — that would re-enter the recursive spawn storm.
          if (process.env[NO_SUBSPAWN_ENV] === "1") return "Dream disabled in subprocess."
          const mdir = memDir(context.directory, context.worktree)
          const lockResult = safeSpawnSync(["java", "--class-path", classesDir, mainClass, "lock-acquire-pid", mdir, String(process.pid)])
          if (lockResult.exitCode !== 0) return "Dream already in progress (lock busy)."
          try {
            const dreamer = spawnDetached(
              ["opencode", "run", "--format", "json", "--agent", "memory-dreamer",
               "--model", process.env.OPENCODE_MEMORY_MODEL ?? "auto",
               "--title", "Memory maintenance (dreamer)",
               "Consolidate, deduplicate, prune, and link memories in .agentmem/."],
              { stdout: "pipe", stderr: "pipe" }
            )
            const kill = setTimeout(() => { try { killProcessTree(dreamer) } catch {} }, 300_000)
            try {
              // Bound the wait so an unkillable survivor that never closes stdout
              // cannot hold this tool (and the consolidation lock) forever.
              const CAP_MS = 320_000
              const out = await Promise.race([
                new Response(dreamer.stdout).text(),
                new Promise<string | null>(resolve => setTimeout(() => resolve(null), CAP_MS)),
              ])
              if (out != null) await deleteMaintenanceSession(client, extractOpencodeSessionId(out), "dreamer")
              return out == null ? "Dream timed out after 320s." : (out.trim() || "Dream complete.")
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

// ---------------------------------------------------------------------------
// v2 entrypoint. Ported per https://opencode.ai/v2/docs/build/plugins/migrate-v1:
//   config                 → not needed. The agents this plugin spawns are
//                            declared as files in ~/.config/opencode/agent/, a
//                            directory both V1 and V2 discover, and the plugin
//                            registers no skills. (V2 has no plugin-side agent
//                            creation: ctx.agent has update/remove but no add.)
//   client.session.prompt  → ctx.session.synthetic({ sessionID, text })
//   client.session.delete  → ctx.session.remove({ sessionID })
//   client.session.list    → no V2 equivalent in the plugin context; the
//                            leftover-session sweep therefore pages nothing and
//                            is a no-op under V2 (per-session cleanup via
//                            `remove` still works for spawned child sessions).
//   chat.message           → ctx.session.hook("prompt", …)
//   tool.execute.after     → ctx.tool.hook("execute.after", …)
//   event                  → ctx.event.subscribe(…), aborted by the cleanup
//                            function. V2 also emits `file.edited`, but v1 drove
//                            scoped injection from the tool hook, so the tool hook
//                            is kept as the single path.
//   tool map               → ctx.tool.transform(editor) with JSON Schema inputs
//                            and structured `{ content }` results.
// The helpers above are unchanged: they speak the V1 client surface, so a small
// adapter maps the three methods they use onto the V2 context.
// ---------------------------------------------------------------------------
function v2Client(ctx: any) {
  return {
    session: {
      prompt: async ({ path: { id }, body }: any) => {
        const text = (body?.parts ?? []).map((p: any) => p?.text ?? "").join("")
        if (!text) return
        await ctx.session.synthetic({ sessionID: id, text })
      },
      delete: async ({ path: { id } }: any) => {
        await ctx.session.remove({ sessionID: id })
      },
      // No V2 list endpoint on the plugin context — see the header note.
      list: async () => ({ data: [] as any[] }),
    },
  } as any
}

function consoleLogger(service: string) {
  return {
    debug: (_m: string) => {},
    info: (m: string) => console.error(`[${service}] ${m}`),
    warn: (m: string) => console.error(`[${service}] WARN ${m}`),
    error: (m: string) => console.error(`[${service}] ERROR ${m}`),
  }
}

const str = (description: string) => ({ type: "string", description })
const schema = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
})

export default {
  id: "agentmem",

  async setup(ctx: any) {
    writeLoadCanary("agentmem")
    logger = consoleLogger("agentmem")
    const client = v2Client(ctx)
    const topicGate = (ctx.options?.topicGate ?? true) as boolean
    logger.info(`plugin active — 9 tools + classifier + auto-injection hooks; topic gate: ${topicGate}`)
    const root: string = ctx.location?.project?.canonical ?? ctx.location?.directory
    const mdir = path.join(root, ".agentmem")

    sweepMaintenanceSessions(client, root).catch(e => logger.warn(`maintenance sweep failed: ${(e as Error).message}`))

    await ctx.session.hook("prompt", async (event: any) => {
      const text: string = event?.prompt?.text ?? ""
      if (!text || text.length < 10) return
      const sessionID: string | undefined = event?.sessionID
      if (!sessionID) return
      updateSessionTopic(sessionID, text)
      const projectSession = topicGate ? shouldInjectProjectContext(sessionID) : true
      if (projectSession && !startupInjectedForSession.has(sessionID)) {
        startupInjectedForSession.add(sessionID)
        injectMemoryAtStartup(client, sessionID, root)
          .then(() => logger.info(`injected memory into session ${sessionID}`))
          .catch(e => logger.error(`startup injection failed: ${(e as Error).message}`))
      }
      if (!projectSession) return
      const allow = await shouldClassifyNow(mdir)
      if (!allow) return
      pendingClassifications++
      const gen = classificationGeneration
      classifyMessage(client, text).then(interesting => {
        if (gen !== classificationGeneration) return
        pendingClassifications--
        if (interesting) flaggedTurnCount++
      }).catch(() => {
        if (gen !== classificationGeneration) return
        pendingClassifications--
      })
    })

    await ctx.tool.hook("execute.after", (event: any) => {
      const tool = event?.tool ?? event?.name
      if (!FILE_TOOLS.has(tool)) return
      const filePath = extractFilePathFromToolInput(event?.input ?? event?.args ?? {})
      if (!filePath) return
      const sessionID = event?.sessionID ?? event?.session?.id
      if (sessionID) injectedSessionId = sessionID
      handleScopedInject(client, root, filePath, topicGate)
    })

    const controller = new AbortController()
    void (async () => {
      try {
        for await (const input of ctx.event.subscribe({ signal: controller.signal })) {
          if (controller.signal.aborted) break
          const type = input?.type
          const data = input?.data ?? input?.properties
          if (type === "session.created") {
            const sid = data?.sessionID ?? data?.info?.id
            if (!sid) continue
            flushFlaggedTurns(client, root, false)
            injectedScopes.clear()
            injectedSessionId = sid
          } else if (type === "session.idle") {
            flushFlaggedTurns(client, root)
            trySpawnDreamer(client, mdir)
          } else if (type === "session.deleted") {
            flushFlaggedTurns(client, root, false)
            const dsid = data?.sessionID ?? data?.info?.id
            if (dsid) startupInjectedForSession.delete(dsid)
          }
        }
      } catch {
        // the event stream is best-effort bookkeeping
      }
    })()

    await ctx.tool.transform((editor: any) => {
      const sid = (context: any) => injectedSessionId ?? context?.sessionID ?? (context as any)?.sessionID

      editor.add({
        name: "save-memory",
        description: "Save a project learning to persistent memory. Two-step protocol: write topic file with frontmatter, then add index pointer to MEMORY.md.",
        input: schema({
          name: str("Filename stem, [a-zA-Z0-9_-]+"),
          description: str("One-line relevance summary"),
          type: { type: "string", enum: ["user", "feedback", "project", "reference"] },
          subtype: str("failure | serendipity | anomaly | digest | question | episode"),
          who: str("Human | Agent (user-requested) | Agent (autonomous)"),
          context: str("What problem was being solved"),
          confidence: { type: "string", enum: ["high", "medium", "low", "speculative"], default: "medium" },
          content: str("Body. For feedback/project: What/Why/How-to-apply/Who/Context"),
          hook: str("One-line MEMORY.md pointer, <=150 chars"),
          contradicts: str("Memory this one contradicts, if any"),
          guard_trigger: str("Condition that should re-surface this memory"),
        }, ["name", "description", "type", "who", "context", "content", "hook"]),
        async execute(args: any, context: any) {
          const cmd = [
            "java", "--class-path", classesDir,
            mainClass, "save", mdir,
            args.name, args.description, args.type,
            args.subtype ?? "--",
            args.who, args.context, args.confidence ?? "medium",
            args.content, args.hook,
            args.contradicts ?? "--",
            args.guard_trigger ?? "--",
          ]
          const proc = await safeSpawn(cmd)
          const result = proc.stdout.trim()
          if (proc.exitCode === 0) {
            const sessionId = sid(context)
            if (sessionId) await reinjectMemory(client, sessionId, root)
          }
          return { content: result }
        },
      })

      editor.add({
        name: "forget-memory",
        description: "Explicitly delete a memory. Moves file to .cold/ and removes from MEMORY.md index.",
        input: schema({ name: str("Memory file name (with or without .md extension)") }, ["name"]),
        async execute(args: any, context: any) {
          const proc = await safeSpawn(["java", "--class-path", classesDir, mainClass, "delete", mdir, args.name])
          const result = proc.stdout.trim()
          if (proc.exitCode === 0) {
            const sessionId = sid(context)
            if (sessionId) await reinjectMemory(client, sessionId, root)
          }
          return { content: result }
        },
      })

      editor.add({
        name: "check-memory-health",
        description: "Check memory directory health: dangling pointers, orphans, index size.",
        input: schema({}),
        async execute() {
          const result = await $`java --class-path ${classesDir} ${mainClass} quality-health ${mdir}`.nothrow().text()
          return { content: result.trim() }
        },
      })

      editor.add({
        name: "init-memory",
        description: "Bootstrap memory from git history. Scans commits for patterns: frequent fixes, reverted refactors, config breaks.",
        input: schema({ repo_path: str("Repository path (defaults to the project root)") }),
        async execute(args: any) {
          const repoPath = args.repo_path ?? root
          const result = await $`java --class-path ${classesDir} ${mainClass} bootstrap ${mdir} ${repoPath}`.nothrow().text()
          return { content: result.trim() }
        },
      })

      editor.add({
        name: "prune-memories",
        description: "List memory files eligible for pruning based on decay curves. Returns prune candidates.",
        input: schema({ type: str("Filter by memory type (user|feedback|project|reference)") }),
        async execute() {
          const result = await $`java --class-path ${classesDir} ${mainClass} lifecycle-prune ${mdir}`.nothrow().text()
          return { content: result.trim() }
        },
      })

      editor.add({
        name: "dream",
        description: "Run memory consolidation. Merges, deduplicates, prunes, and links memories.",
        input: schema({}),
        async execute() {
          if (process.env[NO_SUBSPAWN_ENV] === "1") return { content: "Dream disabled in subprocess." }
          const lockResult = safeSpawnSync(["java", "--class-path", classesDir, mainClass, "lock-acquire-pid", mdir, String(process.pid)])
          if (lockResult.exitCode !== 0) return { content: "Dream already in progress (lock busy)." }
          try {
            const dreamer = spawnDetached(
              ["opencode", "run", "--format", "json", "--agent", "memory-dreamer",
                "--model", process.env.OPENCODE_MEMORY_MODEL ?? "auto",
                "--title", "Memory maintenance (dreamer)",
                "Consolidate, deduplicate, prune, and link memories in .agentmem/."],
              { stdout: "pipe", stderr: "pipe" }
            )
            const kill = setTimeout(() => { try { killProcessTree(dreamer) } catch {} }, 300_000)
            try {
              const CAP_MS = 320_000
              const out = await Promise.race([
                new Response(dreamer.stdout).text(),
                new Promise<string | null>(resolve => setTimeout(() => resolve(null), CAP_MS)),
              ])
              if (out != null) await deleteMaintenanceSession(client, extractOpencodeSessionId(out), "dreamer")
              return { content: out == null ? "Dream timed out after 320s." : (out.trim() || "Dream complete.") }
            } finally { clearTimeout(kill) }
          } finally {
            await safeSpawn(["java", "--class-path", classesDir, mainClass, "lock-release", mdir]).catch(() => {})
          }
        },
      })

      editor.add({
        name: "verify-memory-files",
        description: "Cross-reference file paths in memories against current project state. Returns STALE markers for paths that no longer exist.",
        input: schema({}),
        async execute() {
          const proc = await safeSpawn(["java", "--class-path", classesDir, mainClass, "verify", mdir, root])
          const text = proc.stdout.trim()
          if (proc.exitCode !== 0) return { content: text || "Verification failed." }
          return { content: text || "No file references found in memories." }
        },
      })

      editor.add({
        name: "verify-memory-report",
        description: "Generate a full memory file-reference verification report with table of OK/STALE paths.",
        input: schema({}),
        async execute() {
          const proc = await safeSpawn(["java", "--class-path", classesDir, mainClass, "verify-report", mdir, root])
          const text = proc.stdout.trim()
          if (proc.exitCode !== 0) return { content: text || "Verification report failed." }
          return { content: text || "No file references found in memories." }
        },
      })

      editor.add({
        name: "memory-budget-status",
        description: "Check per-session memory injection token budget status (12,000 token ceiling).",
        input: schema({}),
        async execute(_args: any, context: any) {
          const sessionId = sid(context) ?? "default"
          const result = await $`java --class-path ${classesDir} ${mainClass} budget-status ${mdir} ${sessionId}`.nothrow().text()
          return { content: result.trim() || "No budget data." }
        },
      })
    })

    return () => controller.abort()
  },

  async server(input: any, options?: any) {
    return v1Factory(input, options)
  },
}
