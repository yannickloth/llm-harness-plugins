import { type Plugin, tool } from "@opencode-ai/plugin"
import path from "path"
import { Ledger, entriesNewerThan, watermarkAfter, type LedgerEntry } from "./ledger"
import { buildDigest } from "./digest"
import { withLock } from "./lock"
import { detectActivity, resourceEntry, coalesceKey, type Activity } from "./activity"
import {
  defaultWatermarkStore,
  watermarkPath,
  type WatermarkStore,
} from "./watermarks"
import { createLogger, type PluginLogger } from "../../shared/plugin-logger"

export type AgentfeedOptions = {
  ledgerDir?: string
  maxDigestEntries?: number
  liveFeeds?: boolean
  javaBinary?: string
  feedOutDir?: string
  /** Auto-record shared-resource events from tool calls. */
  autoGit?: boolean
  /** Auto-record file edit/write events (coalesced to avoid flooding). */
  autoFile?: boolean
  /** Min seconds between auto-events for the same agent+resource. */
  resourceCoalesceMs?: number
}

const SYSTEM_NOTE = `## Coordination ledger

A shared coordination ledger exists for this project (see agentfeed). Agents in the
same project can publish to and read from it so they can tell each other what they are
doing, coordinate task ownership, and resolve conflicts over shared resources.

Shared-resource activity (git operations, file edits) is recorded automatically so
other agents can see where you are working and avoid conflicts.

Available tools:
- coord.log(type, text): publish a message or status update
- coord.claim(task, lease?): claim a task (default lease 30 min)
- coord.release(task|id): release a claim
- coord.who_does_what(): list current open claims
- coord.await(position, timeout?): wait until the ledger passes a position
- coord.ask(question, to?): ask other agents a question
- coord.answer(answer, questionId|question): answer a question from coord.ask

Call coord.who_does_what() before starting work to avoid duplicating another agent's task.`

export default (async ({ client, worktree, directory }: Parameters<Plugin>[0], options: AgentfeedOptions = {}) => {
  const logger: PluginLogger = createLogger(client, "agentfeed")
  const root = worktree ?? directory
  const ledgerDir = options.ledgerDir ?? path.join(root, "agentfeed")
  const ledgerFile = path.join(ledgerDir, "ledger.jsonl")
  const lockFile = path.join(ledgerDir, ".ledger.lock")
  const feedOutDir = options.feedOutDir ?? path.join(ledgerDir, "feeds")
  const maxDigestEntries = options.maxDigestEntries ?? 50
  const liveFeeds = options.liveFeeds ?? true
  const javaBinary = options.javaBinary ?? "java"
  const autoGit = options.autoGit ?? true
  const autoFile = options.autoFile ?? true
  const resourceCoalesceMs = options.resourceCoalesceMs ?? 30_000

  const ledger = new Ledger()
  const wmStore: WatermarkStore = defaultWatermarkStore
  const seenSessions = new Set<string>()
  const agentBySession = new Map<string, string>()
  const lastAutoEvent = new Map<string, number>()
  const classesDir = path.join(import.meta.dir, "..", "build", "classes")
  const mainClass = "eu.infolead.llmhp.agentfeed.AtomCli"

  logger.info(`plugin active — ledger: ${ledgerFile}; live feeds: ${liveFeeds}; autoGit: ${autoGit}; autoFile: ${autoFile}`)

  function regenerateFeedsAsync(): void {
    if (!liveFeeds) return
    // fire-and-forget; feed regen is idempotent, never blocks a tool response.
    // Requires the compiled CLI (build.sh) at build/classes, like permission-modes.
    void (async () => {
      try {
        const { spawn } = await import("child_process")
        const child = spawn(javaBinary, ["--class-path", classesDir, mainClass, "--ledger", ledgerFile, "--out", feedOutDir], {
          stdio: "ignore",
        })
        child.on("error", (e) => logger.warn(`feed regen spawn failed (is agentfeed built? run build.sh): ${e.message}`))
        child.on("exit", (code) => {
          if (code !== 0) logger.warn(`feed regen exited ${code}`)
        })
      } catch (e: any) {
        logger.warn(`feed regen error: ${e?.message ?? String(e)}`)
      }
    })()
  }

  async function publish(entry: Omit<LedgerEntry, "id" | "host" | "seq" | "ts">): Promise<LedgerEntry> {
    const saved = await withLock(lockFile, () => ledger.append(ledgerFile, entry))
    regenerateFeedsAsync()
    return saved
  }

  /** Auto-publish a shared-resource event, coalesced per agent+resource. */
  async function autoPublishActivity(agent: string, a: Activity): Promise<void> {
    const enabled = a.resource === "git" ? autoGit : autoFile
    if (!enabled) return
    const key = coalesceKey(agent, a)
    const now = Date.now()
    const last = lastAutoEvent.get(key) ?? 0
    if (now - last < resourceCoalesceMs) return
    lastAutoEvent.set(key, now)
    await publish(resourceEntry(agent, a))
  }

  return {
    "chat.message": async (
      input: { sessionID: string; agent?: string },
      output: { parts: Array<{ type: string; text?: string }> },
    ) => {
      try {
        const agent = input.agent ?? "default"
        agentBySession.set(input.sessionID, agent)
        if (!seenSessions.has(input.sessionID)) {
          seenSessions.add(input.sessionID)
          return
        }
        const textPart = output.parts.find((p) => p.type === "text")
        if (!textPart || !textPart.text?.trim()) return
        const wmPath = watermarkPath(ledgerDir, input.sessionID, agent)
        const wm = await wmStore.read(wmPath)
        const entries = entriesNewerThan(await ledger.read(ledgerFile), wm)
        if (entries.length === 0) return
        const digest = buildDigest(entries, { maxEntries: maxDigestEntries })
        if (!digest) return
        textPart.text = `${digest}\n\n${textPart.text}`
        // Advance watermark to the true last new entry (even if digest truncated)
        await wmStore.write(wmPath, watermarkAfter(entries))
      } catch (e: any) {
        logger.error(`chat.message failed: ${e?.message ?? String(e)}`)
      }
    },

    "experimental.chat.system.transform": async (
      _input: unknown,
      output: { system: string[] },
    ) => {
      try {
        if (output.system.some((s) => s.includes(SYSTEM_NOTE.split("\n")[0]))) return
        output.system = [SYSTEM_NOTE, ...output.system]
      } catch (e: any) {
        logger.error(`system.transform failed: ${e?.message ?? String(e)}`)
      }
    },

    "tool.execute.after": async (
      input: { tool: string; sessionID: string; args?: Record<string, unknown> },
    ) => {
      try {
        const a = detectActivity({ tool: input.tool, args: input.args })
        if (!a) return
        const agent = agentBySession.get(input.sessionID) ?? "default"
        await autoPublishActivity(agent, a)
      } catch (e: any) {
        logger.error(`tool.execute.after (auto resource) failed: ${e?.message ?? String(e)}`)
      }
    },

    tool: {
      "coord.log": tool({
        description: "Publish a message or status update to the shared coordination ledger. Other agents and the human reader will see it.",
        args: {
          type: tool.schema.enum(["msg", "status"]),
          text: tool.schema.string().min(1).describe("What to publish"),
        },
        async execute(args, ctx) {
          await publish({
            agent: ctx.agent,
            type: args.type,
            text: args.text,
          })
          return `Logged ${args.type}: ${args.text}`
        },
      }),

      "coord.claim": tool({
        description: "Claim a task with a TTL lease so other agents know you own it.",
        args: {
          task: tool.schema.string().min(1).describe("Task identifier to claim"),
          leaseMinutes: tool.schema.number().optional(),
        },
        async execute(args, ctx) {
          const lease = new Date(Date.now() + (args.leaseMinutes ?? 30) * 60_000).toISOString()
          const e = await publish({
            agent: ctx.agent,
            type: "claim",
            task: args.task,
            status: "open",
            lease,
          })
          return `Claimed "${args.task}" as ${e.id} (lease until ${lease})`
        },
      }),

      "coord.release": tool({
        description: "Release a claim you previously made, by task name or claim id.",
        args: {
          task: tool.schema.string().optional(),
          id: tool.schema.string().optional(),
        },
        async execute(args, ctx) {
          if (!args.task && !args.id) {
            return "coord.release requires either 'task' or 'id'."
          }
          const e = await publish({
            agent: ctx.agent,
            type: "release",
            task: args.task,
            taskID: args.id,
          })
          return `Released ${args.id ?? `"${args.task}"`} (${e.id})`
        },
      }),

      "coord.who_does_what": tool({
        description: "List current open task claims (excluding expired leases and released tasks) so you can avoid duplicating another agent's work.",
        args: {},
        async execute() {
          const entries = await ledger.read(ledgerFile)
          const now = Date.now()
          const releasedKeys = new Set(
            entries
              .filter((e) => e.type === "release")
              .map((e) => e.task ?? e.taskID ?? ""),
          )
          const open = entries.filter(
            (e) =>
              e.type === "claim" &&
              (e.status === "open" || e.status === "in-progress") &&
              !leaseExpired(e.lease, now) &&
              !releasedKeys.has(e.task ?? e.taskID ?? ""),
          )
          if (open.length === 0) return "No open claims."
          return open.map((e) => `- ${e.id}: ${e.agent} claims "${e.task ?? ""}" (lease until ${e.lease ?? "?"})`).join("\n")
        },
      }),

      "coord.await": tool({
        description: "Wait until the ledger has new entries after the given position, or a timeout elapses. Useful for waiting on a handoff. Pass an entry id (host:seq) or a full position 'ts|host|seq'.",
        args: {
          position: tool.schema.string().describe("Entry id 'host:seq' or watermark 'ts|host|seq'"),
          timeoutSeconds: tool.schema.number().optional(),
        },
        async execute(args) {
          const timeout = (args.timeoutSeconds ?? 30) * 1000
          const deadline = Date.now() + timeout
          let seen = await ledger.read(ledgerFile)
          const target = resolvePosition(args.position, seen)
          if (!target) return `Unknown position: ${args.position}`
          for (;;) {
            if (entriesNewerThan(seen, target).length > 0) break
            if (Date.now() > deadline) return `Timed out waiting after ${args.position}`
            await new Promise((r) => setTimeout(r, 250))
            seen = await ledger.read(ledgerFile)
          }
          const newer = entriesNewerThan(seen, target)
          return buildDigest(newer) || "New activity seen."
        },
      }),

      "coord.ask": tool({
        description: "Broadcast a question to other agents. It appears in everyone's coordination digest; others can answer with coord.answer.",
        args: {
          question: tool.schema.string().min(1).describe("The question to ask"),
          to: tool.schema.string().optional().describe("Optional: direct the question to a specific agent"),
        },
        async execute(args, ctx) {
          const e = await publish({
            agent: ctx.agent,
            type: "ask",
            text: args.question,
            target: args.to,
          })
          return `Asked${args.to ? ` ${args.to}` : ""}: "${args.question}" (${e.id})`
        },
      }),

      "coord.answer": tool({
        description: "Answer a question previously posted with coord.ask. Pass the question id or re-state the question text.",
        args: {
          answer: tool.schema.string().min(1).describe("Your answer"),
          questionId: tool.schema.string().optional().describe("The ask entry id (host:seq) you are answering"),
          question: tool.schema.string().optional().describe("The question text you are answering (used if no questionId)"),
        },
        async execute(args, ctx) {
          if (!args.questionId && !args.question) {
            return "coord.answer requires either 'questionId' or 'question'."
          }
          const e = await publish({
            agent: ctx.agent,
            type: "answer",
            text: args.answer,
            taskID: args.questionId,
            task: args.question,
          })
          return `Answered ${args.questionId ?? `"${args.question}"`} (${e.id})`
        },
      }),
    },
  }
}) satisfies Plugin

function leaseExpired(lease: string | undefined, now: number): boolean {
  if (!lease) return false
  const t = Date.parse(lease)
  if (Number.isNaN(t)) return false
  return t < now
}

/**
 * Resolve a coord.await position argument to a ledger watermark.
 * Accepts either an entry id ("host:seq") — resolved to that entry's actual
 * position — or a full "ts|host|seq" triple.
 */
function resolvePosition(
  s: string,
  entries: LedgerEntry[],
): { ts: string; host: string; seq: number } | null {
  const idMatch = s.match(/^([^:]+):(\d+)$/)
  if (idMatch) {
    const host = idMatch[1]
    const seq = parseInt(idMatch[2], 10)
    const found = entries.find((e) => e.host === host && e.seq === seq)
    if (!found) return null
    return { ts: found.ts, host: found.host, seq: found.seq }
  }
  const [ts, host, seq] = s.split("|")
  if (!ts) return null
  return { ts, host: host ?? "", seq: parseInt(seq ?? "0", 10) || 0 }
}
