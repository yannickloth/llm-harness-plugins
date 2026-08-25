import { type Plugin, tool, type Config } from "@opencode-ai/plugin"
import path from "path"
import fs from "fs"
import zlib from "zlib"
import { Ledger, entriesNewerThan, watermarkAfter, sortEntries, type LedgerEntry } from "./ledger"
import { partitionForCompact } from "./ledger-compact"
import { buildDigest } from "./digest"
import { withLock } from "./lock"
import { detectActivity, resourceEntry, coalesceKey, type Activity } from "./activity"
import {
  defaultWatermarkStore,
  watermarkPath,
  type WatermarkStore,
} from "./watermarks"
import { createLogger, type PluginLogger } from "../../shared/plugin-logger"
import { updateSessionTopic, shouldInjectProjectContext, getSessionTopic } from "../../shared/session-topic"
import { moduleDir } from "../../shared/module-dir"

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
  /** Default hold TTL (ms) for auto-detected resource acquires. */
  resourceLeaseMs?: number
  /** Retain raw ledger events younger than this before archiving on compact. */
  compactRetentionMs?: number
  /**
   * If true (default), only inject coordination context into sessions classified
   * as project-related. Personal/non-coding sessions are left alone.
   */
  topicGate?: boolean
}

const SYSTEM_NOTE = `## Coordination ledger

A shared coordination ledger exists for this project (see agentfeed). Agents in the
same project can publish to and read from it so they can tell each other what they are
doing, coordinate task ownership, and resolve conflicts over shared resources.

Shared-resource activity (git operations, file edits) is recorded automatically so
other agents can see where you are working and avoid conflicts — you do not need to
announce those yourself.

Available tools:
- coord_who_does_what(): list open claims + held resources — CALL BEFORE starting work
- coord_claim(task, lease?): claim a task (default lease 30 min)
- coord_release(task|id): release a claim when done
- coord_resource(resource, name, action): acquire or release a shared resource (git/file); release frees it
- coord_handoff(task, to): hand a task to another agent
- coord_status(task, state): mark a task done/failed/in-progress (task board)
- coord_heartbeat(task|resource, kind?): renew a claim/hold lease so long-running work isn't reclaimed
- coord_log(type, text): announce your intent/progress (type: msg | status)
- coord_ask(question, to?): ask other agents a question
- coord_answer(answer, questionId|question): answer a question from coord_ask
- coord_await(position, timeout?): wait until the ledger passes a position

Typical use:
1. coord_who_does_what() — see what is claimed/held; do not duplicate.
2. coord_claim("<task>") — take ownership of unclaimed work.
3. coord_log("msg", "working on <task>: <brief plan>") — tell others your intent.
4. coord_ask(...) when blocked or unsure; coord_answer(...) to reply.
5. When done: coord_status("<task>", "done") + coord_release("<task>").
6. After finishing on a shared resource, coord_resource(action: "release") so others know it's free.

Full guidance: use the 'coordinate' skill for the complete coordination protocol.`

export default (async ({ client, worktree, directory }: Parameters<Plugin>[0], options: AgentfeedOptions = {}) => {
  const logger: PluginLogger = createLogger(client, "agentfeed")
  const root = worktree ?? directory
  const ledgerDir = options.ledgerDir ?? path.join(root, "agentfeed")
  const ledgerFile = path.join(ledgerDir, "ledger.jsonl")
  const lockFile = path.join(ledgerDir, ".ledger.lock")
  const feedOutDir = options.feedOutDir ?? path.join(ledgerDir, "feeds")
  const digestFile = path.join(feedOutDir, "digest.md")
  const maxDigestEntries = options.maxDigestEntries ?? 50
  const liveFeeds = options.liveFeeds ?? true
  const javaBinary = options.javaBinary ?? "java"
  const autoGit = options.autoGit ?? true
  const autoFile = options.autoFile ?? true
  const resourceCoalesceMs = options.resourceCoalesceMs ?? 30_000
  const resourceLeaseMs = options.resourceLeaseMs ?? 30 * 60_000
  let compactRetentionMs = options.compactRetentionMs ?? 7 * 24 * 60 * 60 * 1000
  const topicGate = options.topicGate ?? true
  const archiveDir = path.join(ledgerDir, ".agentfeed", "ledger-archive")

  const ledger = new Ledger()
  const wmStore: WatermarkStore = defaultWatermarkStore
  const seenSessions = new Set<string>()
  const agentBySession = new Map<string, string>()
  const lastAutoEvent = new Map<string, number>()
  const dir = moduleDir(import.meta.url, import.meta.dir)
  const classesDir = path.join(dir, "..", "build", "classes")
  const mainClass = "eu.infolead.llmhp.agentfeed.AtomCli"
  const skillFile = path.join(dir, "..", "skills", "coordinate", "SKILL.md")
  const skillName = skillNameFrom(skillFile)

  logger.info(`plugin active — ledger: ${ledgerFile}; live feeds: ${liveFeeds}; autoGit: ${autoGit}; autoFile: ${autoFile}; topic gate: ${topicGate}`)

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

  /**
   * Compact the ledger: move settled entries (older than retention, not live
   * state) to a git-ignored, gzip-compressed archive and rewrite the live window.
   * Also archives stale watermark files (per-session read positions) to keep the
   * fan-out of per-(session,agent) files bounded. Backup, not deletion — git is the
   * full durable record, and the archives keep local copies. Must run while holding
   * the lock; document as a single-host operation (concurrent hosts should compact
   * too; git still unions).
   */
  async function compact(): Promise<{ live: number; archived: number; archivedBytes: number; watermarksPruned: number }> {
    return withLock(lockFile, async () => {
      const entries = await ledger.read(ledgerFile)
      const { live, settled } = partitionForCompact(entries, Date.now(), compactRetentionMs)
      let archivedBytes = 0
      if (settled.length > 0) {
        // Write settled entries to a git-ignored compressed archive (backup).
        fs.mkdirSync(archiveDir, { recursive: true })
        const month = new Date().toISOString().slice(0, 7) // YYYY-MM
        const archivePath = path.join(archiveDir, `${month}.ledger.jsonl.gz`)
        const settledText = settled.map((e) => JSON.stringify(e)).join("\n") + "\n"
        const gz = zlib.gzipSync(settledText, { level: 9 })
        fs.appendFileSync(archivePath, gz)
        archivedBytes = gz.length

        // Rewrite the tracked ledger to the live window only.
        const liveText = live.map((e) => JSON.stringify(e)).join("\n")
        const tmp = `${ledgerFile}.${process.pid}.compact.tmp`
        fs.writeFileSync(tmp, liveText + (liveText ? "\n" : ""), "utf8")
        fs.renameSync(tmp, ledgerFile)
      }

      const watermarksPruned = pruneStaleWatermarks()

      regenerateFeedsAsync()
      return { live: live.length, archived: settled.length, archivedBytes, watermarksPruned }
    })
  }

  /** Move watermark files untouched for 30 days into a git-ignored archive. */
  function pruneStaleWatermarks(): number {
    const wmDir = path.join(ledgerDir, ".agentfeed", "watermarks")
    if (!fs.existsSync(wmDir)) return 0
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000
    const archive = path.join(wmDir, "archive")
    let moved = 0
    for (const name of fs.readdirSync(wmDir)) {
      if (!name.endsWith(".json")) continue
      const src = path.join(wmDir, name)
      let st: fs.Stats
      try { st = fs.statSync(src) } catch { continue }
      if (st.mtimeMs > cutoff) continue
      fs.mkdirSync(archive, { recursive: true })
      fs.renameSync(src, path.join(archive, name))
      moved++
    }
    return moved
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
    // Auto-detected ops are informational "touched X" events — NOT holds. They do
    // not appear in coord_who_does_what()'s held list (no lease). To signal that a
    // resource is held and later freed, call coord_resource(acquire/release).
    await publish(resourceEntry(agent, a))
  }

  return {
    config: async (input: Config) => {
      // Self-register the 'coordinate' skill so agents can load the full
      // coordination protocol on demand (mirrors the general-skills pattern).
      if (skillName) {
        const existing = (input as any).skills ?? {}
        ;(input as any).skills = { ...existing, [skillName]: { file: path.relative(dir, skillFile) } }
      }
    },

    "chat.message": async (
      input: { sessionID: string; agent?: string },
      output: { parts: Array<{ type: string; text?: string }> },
    ) => {
      try {
        const agent = input.agent ?? "default"
        agentBySession.set(input.sessionID, agent)
        const textPart = output.parts.find((p) => p.type === "text")
        if (textPart?.text) updateSessionTopic(input.sessionID, textPart.text)
        if (topicGate && !shouldInjectProjectContext(input.sessionID)) return
        if (!seenSessions.has(input.sessionID)) {
          seenSessions.add(input.sessionID)
          return
        }
        if (!textPart || !textPart.text?.trim()) return
        const wmPath = watermarkPath(ledgerDir, input.sessionID, agent)
        const wm = await wmStore.read(wmPath)
        const entries = entriesNewerThan(await ledger.read(ledgerFile), wm)
        if (entries.length === 0) return
        const digest = buildDigest(entries, { maxEntries: maxDigestEntries })
        if (!digest) return
        // Keep the chat window lean: persist the full digest to a markdown file
        // and prepend only a one-line pointer. The model reads the file if it
        // needs the details (mirrors the lazy-loaded AGENTS.md rule pattern).
        try {
          fs.mkdirSync(path.dirname(digestFile), { recursive: true })
          fs.writeFileSync(digestFile, digest + "\n")
        } catch (writeErr: any) {
          logger.warn(`digest write failed: ${writeErr?.message ?? String(writeErr)}`)
        }
        const relPath = path.relative(root, digestFile)
        textPart.text = `## Coordination digest\n${entries.length} new entr${entries.length === 1 ? "y" : "ies"} — details in \`${relPath}\`.\n\n${textPart.text}`
        // Advance watermark to the true last new entry (even if digest truncated)
        await wmStore.write(wmPath, watermarkAfter(entries))
      } catch (e: any) {
        logger.error(`chat.message failed: ${e?.message ?? String(e)}`)
      }
    },

    "experimental.chat.system.transform": async (
      input: { sessionID?: string },
      output: { system: string[] },
    ) => {
      try {
        const sid = (input as any).sessionID
        if (topicGate && sid && getSessionTopic(sid) === "personal") return
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
      "coord_resource": tool({
        description:
          "Acquire or release a shared resource (git or file) so other agents know whether it is held or free. Auto-detected git/file activity marks an acquire; call this with action 'release' when you are done so others can take over.",
        args: {
          resource: tool.schema.enum(["git", "file"]).describe("Kind of resource"),
          name: tool.schema.string().describe("Resource name (git branch/ref, or file path)"),
          action: tool.schema.enum(["acquire", "release"]).describe("acquire = start using; release = free it"),
        },
        async execute(args, ctx) {
          // Explicit acquires get the same default hold TTL as auto-acquires so a
          // hold is always reclaimable after expiry (no permanent locks on crash).
          const lease = args.action === "acquire"
            ? new Date(Date.now() + resourceLeaseMs).toISOString()
            : undefined
          const entry = {
            agent: ctx.agent,
            type: "resource" as const,
            resource: args.resource,
            file: args.resource === "file" ? args.name : undefined,
            ref: args.resource === "git" ? args.name : undefined,
            action: args.action,
            lease,
            task: args.action === "acquire" ? (args.resource === "git" ? "git hold" : "file hold") : undefined,
          }
          const e = await publish(entry)
          return args.action === "acquire"
            ? `Acquired ${args.resource} "${args.name}" (${e.id}) — release it when done`
            : `Released ${args.resource} "${args.name}" (${e.id}) — now free`
        },
      }),

      "coord_handoff": tool({
        description:
          "Hand a task to another agent: closes your claim on it and opens a claim for the target. The target sees the handoff in their digest and can coord_claim to accept.",
        args: {
          task: tool.schema.string().min(1).describe("Task identifier to hand off"),
          to: tool.schema.string().min(1).describe("Target agent name"),
        },
        async execute(args, ctx) {
          const now = Date.now()
          const lease = new Date(now + 30 * 60_000).toISOString()
          // Close own claim on the task (if any) and open one for the target.
          await publish({
            agent: ctx.agent,
            type: "release",
            task: args.task,
          })
          const e = await publish({
            agent: args.to,
            type: "claim",
            task: args.task,
            status: "open",
            lease,
            target: ctx.agent,
          })
          return `Handed "${args.task}" to ${args.to} (${e.id}); they should coord_claim it to accept`
        },
      }),

      "coord_status": tool({
        description:
          "Report a task's state (done / failed / in-progress) so others can see board progress. Use when you finish or fail a task.",
        args: {
          task: tool.schema.string().min(1).describe("Task identifier"),
          state: tool.schema.enum(["done", "failed", "in-progress"]).describe("Task state"),
        },
        async execute(args, ctx) {
          const e = await publish({
            agent: ctx.agent,
            type: "status",
            task: args.task,
            status: args.state,
          })
          return `Marked "${args.task}" ${args.state} (${e.id})`
        },
      }),

      "coord_heartbeat": tool({
        description:
          "Renew the lease on a claim (or on a held resource) so long-running work is not reclaimed by another agent after the TTL. Call periodically on long tasks.",
        args: {
          task: tool.schema.string().optional().describe("Task to renew (or leave empty to renew a resource)"),
          resource: tool.schema.string().optional().describe("Resource name to renew (branch or file path)"),
          kind: tool.schema.enum(["git", "file"]).optional().describe("Resource kind when renewing a resource"),
        },
        async execute(args, ctx) {
          if (!args.task && !args.resource) {
            return "coord_heartbeat requires 'task' or 'resource'."
          }
          const lease = new Date(Date.now() + 30 * 60_000).toISOString()
          if (args.resource) {
            // Renew a held resource by re-publishing its acquire with a fresh lease.
            const kind = args.kind ?? "git"
            const e = await publish({
              agent: ctx.agent,
              type: "resource",
              resource: kind,
              file: kind === "file" ? args.resource : undefined,
              ref: kind === "git" ? args.resource : undefined,
              action: "acquire",
              lease,
              task: kind === "file" ? "file hold" : "git hold",
            })
            return `Renewed hold on "${args.resource}" until ${lease} (${e.id})`
          }
          const e = await publish({
            agent: ctx.agent,
            type: "claim",
            task: args.task,
            status: "in-progress",
            lease,
          })
          return `Renewed lease on "${args.task}" until ${lease} (${e.id})`
        },
      }),

      "coord_log": tool({
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

      "coord_claim": tool({
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

      "coord_release": tool({
        description: "Release a claim you previously made, by task name or claim id.",
        args: {
          task: tool.schema.string().optional(),
          id: tool.schema.string().optional(),
        },
        async execute(args, ctx) {
          if (!args.task && !args.id) {
            return "coord_release requires either 'task' or 'id'."
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

      "coord_who_does_what": tool({
        description:
          "List current open task claims and held shared resources (excluding expired leases, released claims, and released resources) so you can avoid duplicating another agent's work.",
        args: {},
        async execute() {
          const entries = await ledger.read(ledgerFile)
          const now = Date.now()
          const open = dedupeClaims(
            entries.filter(
              (e) =>
                e.type === "claim" &&
                (e.status === "open" || e.status === "in-progress") &&
                !leaseExpired(e.lease, now),
            ),
          )
          // A claim by an agent is closed only if THAT agent released the same task
          // with a position newer than the claim. A release by a different agent does
          // not free another's claim — those are competing claims, both still open.
          // (Renewals/handoffs create newer claims for the same agent, which are kept.)
          const live = open.filter((c) => {
            const laterReleaseByOwner = entries.some(
              (e) =>
                e.type === "release" &&
                e.agent === c.agent &&
                (e.task ?? e.taskID ?? "") === (c.task ?? c.taskID ?? "") &&
                (e.ts > c.ts || (e.ts === c.ts && e.seq > c.seq)),
            )
            return !laterReleaseByOwner
          })
          const held = heldResources(entries, now)
          const lines: string[] = []
          if (live.length > 0) {
            lines.push("Open claims:")
            for (const e of live) {
              lines.push(`- ${e.id}: ${e.agent} claims "${e.task ?? ""}" (lease until ${e.lease ?? "?"})`)
            }
          }
          if (held.length > 0) {
            lines.push("Held resources:")
            for (const r of held) {
              lines.push(`- ${r.id}: ${r.agent} holds ${r.resource} "${r.label}" (acquired ${r.ts})`)
            }
          }
          if (lines.length === 0) return "No open claims or held resources."
          return lines.join("\n")
        },
      }),

      "coord_compact": tool({
        description:
          "Archive settled coordination events to a git-ignored compressed backup and shrink the live ledger. Keeps open claims, held resources, unanswered asks, and recent events; compresses the rest into .agentfeed/ledger-archive/. Run on each host; git remains the full durable record.",
        args: {
          retentionMs: tool.schema.number().optional().describe("Retention window (ms). Default 7 days."),
        },
        async execute(args) {
          const prevRetention = compactRetentionMs
          if (args.retentionMs && args.retentionMs > 0) {
            compactRetentionMs = args.retentionMs
          }
          try {
            const r = await compact()
            const parts: string[] = []
            if (r.archived > 0) parts.push(`archived ${r.archived} settled to ${path.join(".agentfeed", "ledger-archive")} (${r.archivedBytes} bytes gzip)`)
            else parts.push("nothing to archive")
            if (r.watermarksPruned > 0) parts.push(`archived ${r.watermarksPruned} stale watermark(s)`)
            parts.push(`${r.live} live entries retained`)
            return `Compacted: ${parts.join("; ")}.`
          } finally {
            compactRetentionMs = prevRetention
          }
        },
      }),

      "coord_await": tool({
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

      "coord_ask": tool({
        description: "Broadcast a question to other agents. It appears in everyone's coordination digest; others can answer with coord_answer.",
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

      "coord_answer": tool({
        description: "Answer a question previously posted with coord_ask. Pass the question id or re-state the question text.",
        args: {
          answer: tool.schema.string().min(1).describe("Your answer"),
          questionId: tool.schema.string().optional().describe("The ask entry id (host:seq) you are answering"),
          question: tool.schema.string().optional().describe("The question text you are answering (used if no questionId)"),
        },
        async execute(args, ctx) {
          if (!args.questionId && !args.question) {
            return "coord_answer requires either 'questionId' or 'question'."
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
 * Collapse multiple claims on the same task *by the same agent* to the most recent
 * (latest lease). Needed because coord_heartbeat renews a claim by re-claiming the
 * same task. Claims on the same task by *different* agents are genuine conflicts
 * and must all be surfaced (coord_who_does_what should not hide them).
 */
function dedupeClaims(claims: LedgerEntry[]): LedgerEntry[] {
  const byAgentTask = new Map<string, LedgerEntry>()
  for (const c of claims) {
    const key = `${c.agent}|${c.task ?? c.taskID ?? ""}`
    const existing = byAgentTask.get(key)
    if (!existing || (c.lease ?? "") > (existing.lease ?? "")) byAgentTask.set(key, c)
  }
  return [...byAgentTask.values()]
}

/**
 * Shared resources currently held (acquired but not released and lease not expired).
 * Used by coord_who_does_what to show what is in use — so others know when it frees.
 *
 * Ordering is by ledger position (ts, then host, then seq), not raw per-host seq
 * (two hosts both have seq 1). A resource is held by the *set* of agents who have
 * an unexpired acquire on it; a release removes only the releasing agent, so a
 * competing holder's hold is preserved.
 */
function heldResources(entries: LedgerEntry[], now: number): Array<{ id: string; agent: string; resource: string; label: string; ts: string }> {
  const holders = new Map<string, Map<string, LedgerEntry>>() // resourceKey -> agent -> latest acquire
  for (const e of sortEntries(entries)) {
    if (e.type !== "resource") continue
    const key = resourceKey(e)
    const perAgent = holders.get(key) ?? new Map<string, LedgerEntry>()
    holders.set(key, perAgent)
    if (e.action === "release") {
      perAgent.delete(e.agent)
      if (perAgent.size === 0) holders.delete(key)
    } else if (e.lease && !leaseExpired(e.lease, now)) {
      // Only *held* resources (explicit acquire/heartbeat with a lease) are tracked;
      // informational auto "touched X" events have no lease and are not holds.
      perAgent.set(e.agent, e)
    }
  }
  const out: Array<{ id: string; agent: string; resource: string; label: string; ts: string }> = []
  for (const [key, perAgent] of holders) {
    // Every competing holder is surfaced (like claims): two agents holding the same
    // resource is a conflict `coord_who_does_what` should make visible, not hide.
    for (const e of perAgent.values()) {
      out.push({
        id: e.id,
        agent: e.agent,
        resource: e.resource ?? "?",
        label: e.resource === "git" ? (e.ref ?? e.task ?? "?") : (e.file ?? e.task ?? "?"),
        ts: e.ts,
      })
    }
  }
  return out
}

function resourceKey(e: LedgerEntry): string {
  if (e.resource === "git") return `git:${e.ref ?? e.file ?? e.task ?? ""}`
  return `file:${e.file ?? ""}`
}

/** Read the `name:` from a SKILL.md frontmatter block, or the dir name. */
function skillNameFrom(skillFile: string): string {
  try {
    const content = fs.readFileSync(skillFile, "utf-8")
    if (content.startsWith("---")) {
      const end = content.indexOf("---", 3)
      if (end !== -1) {
        const fm = content.slice(3, end)
        const m = fm.match(/^name:\s*(.+)$/m)
        if (m) return m[1].trim()
      }
    }
  } catch {
    // skill file missing — registration is best-effort
  }
  return path.basename(path.dirname(skillFile))
}

/**
 * Resolve a coord_await position argument to a ledger watermark.
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
