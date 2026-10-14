import { type Plugin, tool } from "@opencode-ai/plugin"
import fs from "fs"
import path from "path"
import { createLogger } from "../../shared/plugin-logger"
import { writeLoadCanary } from "../../shared/load-canary"
import {
  DEFAULT_BUDGET,
  EDIT_PROTOCOL,
  NOTICE_COOLDOWN_MS,
  applyMirrorEdits,
  budgetNotice,
  evaluateRecall,
  isOverBudget,
  messagesTokens,
  overflowWarning,
  parseBudget,
  parseMirror,
  pickReminder,
  renderMirror,
  sessionFromMessages,
  sessionPaths,
  type CeMessage,
  type OcMessage,
} from "./helpers"

/** Disable the plugin when "0". */
const DISABLED_ENV = "LLMHP_CONTEXT_EDITING"
const MODE_ENV = "LLMHP_CONTEXT_EDITING_MODE"
const BUDGET_ENV = "LLMHP_CONTEXT_EDITING_BUDGET"
const WINDOW_ENV = "LLMHP_CONTEXT_EDITING_WINDOW"

type Mode = "off" | "notices-only" | "edit"

export interface Options {
  /** "off" | "notices-only" (default, Phase 0) | "edit" (Phase 1). */
  mode?: Mode
  /** "50%" | "64k" | "window" | literal count. */
  budget?: string
  /** Model window in tokens; defaults to 200k. */
  windowTokens?: number
}

interface SessionState {
  id: string
  revision: number
  budget: string
  windowTokens: number
  protectedRegion: string
  firedReminders: Set<number>
  lastNoticeAt: number
  rebuildMirror: boolean
  metrics: { edited: number; dropped: number; added: number; rejected: number; forced: number }
}

export default async (
  { client, directory, worktree }: Parameters<Plugin>[0],
  options: Options = {},
) => {
  writeLoadCanary("context-editing")
  const logger = createLogger(client, "context-editing")
  const root = worktree ?? directory

  if (process.env[DISABLED_ENV] === "0") {
    logger.info("plugin disabled via LLMHP_CONTEXT_EDITING=0")
    return {}
  }

  const mode: Mode = (process.env[MODE_ENV] as Mode) ?? options.mode ?? "notices-only"
  const defaultBudget = process.env[BUDGET_ENV] ?? options.budget ?? DEFAULT_BUDGET
  const defaultWindow = Number(process.env[WINDOW_ENV] ?? options.windowTokens ?? 200_000)
  const cooldownMs = NOTICE_COOLDOWN_MS

  logger.info(`plugin active — mode=${mode} budget=${defaultBudget} window=${defaultWindow}`)

  const states = new Map<string, SessionState>()

  function stateFor(sid: string): SessionState {
    let s = states.get(sid)
    if (!s) {
      s = {
        id: sid,
        revision: 0,
        budget: defaultBudget,
        windowTokens: defaultWindow,
        protectedRegion: "",
        firedReminders: new Set(),
        lastNoticeAt: 0,
        rebuildMirror: true,
        metrics: { edited: 0, dropped: 0, added: 0, rejected: 0, forced: 0 },
      }
      states.set(sid, s)
    }
    return s
  }

  // ── filesystem ─────────────────────────────────────────────────────────────

  function ensureDir(dir: string): boolean {
    try {
      fs.mkdirSync(dir, { recursive: true })
      return true
    } catch {
      return false
    }
  }

  function readSafe(file: string): string | null {
    try {
      return fs.readFileSync(file, "utf-8")
    } catch {
      return null
    }
  }

  function writeAtomic(file: string, content: string): boolean {
    try {
      const dir = path.dirname(file)
      ensureDir(dir)
      const tmp = `${file}.tmp-${process.pid}`
      fs.writeFileSync(tmp, content)
      fs.renameSync(tmp, file)
      return true
    } catch (e) {
      logger.warn(`write failed for ${file}: ${(e as Error).message}`)
      return false
    }
  }

  function appendJsonl(file: string, record: Record<string, unknown>): void {
    try {
      ensureDir(path.dirname(file))
      fs.appendFileSync(file, JSON.stringify(record) + "\n")
    } catch {
      // telemetry must never break behavior
    }
  }

  function seedProtected(s: SessionState, text: string): void {
    if (s.protectedRegion || !text.trim()) return
    const goal = text.trim().split("\n").slice(0, 3).join(" ").slice(0, 400)
    s.protectedRegion = `## Goal\n${goal}\n\n## Constraints\n_(none recorded yet)_\n\n## Open questions\n_(none recorded yet)_`
  }

  function firstUserText(messages: OcMessage[]): string {
    for (const m of messages) {
      if (String(m.info?.role ?? "") !== "user") continue
      const p = (m.parts ?? []).find((x) => x.type === "text" && x.text)
      if (p?.text) return p.text
    }
    return ""
  }

  function toCe(messages: OcMessage[]): CeMessage[] {
    return messages.map((m, i) => ({
      id: String(m.info?.id ?? `m${i}`),
      role: String(m.info?.role ?? "user"),
      sessionID: m.info?.sessionID as string | undefined,
      parts: m.parts,
    }))
  }

  const NOTICE_PREFIX = "ce-notice-"

  function stripNotices(messages: OcMessage[]): void {
    for (const m of messages) {
      m.parts = (m.parts ?? []).filter((p) => !String(p.id).startsWith(NOTICE_PREFIX))
    }
  }

  function injectNotice(messages: OcMessage[], text: string): void {
    const target = messages[0]
    if (!target) return
    const template = messages.flatMap((m) => m.parts).find((p) => p.type === "text")
    const part = template
      ? { ...template, id: `${NOTICE_PREFIX}${Date.now()}`, text }
      : { id: `${NOTICE_PREFIX}${Date.now()}`, type: "text", text }
    target.parts = [part, ...(target.parts ?? [])]
  }

  function recordMetric(s: SessionState, event: string, extra: Record<string, unknown>): void {
    appendJsonl(sessionPaths(root, s.id).metrics, { ts: Date.now(), sessionID: s.id, event, ...extra })
  }

  // ── hooks ──────────────────────────────────────────────────────────────────

  return {
    "chat.message": async (
      input: { sessionID: string },
      output: { parts?: Array<{ type: string; text?: string }> },
    ) => {
      if (mode === "off") return
      const sid = input?.sessionID
      if (!sid) return
      const s = stateFor(sid)
      const text = (output?.parts ?? []).find((p) => p.type === "text" && p.text)?.text ?? ""
      if (!text.trim()) return
      appendJsonl(sessionPaths(root, sid).trace, {
        ts: Date.now(),
        type: "message",
        role: "user",
        text: text.slice(0, 4000),
      })
      seedProtected(s, text)
    },

    "experimental.chat.system.transform": async (
      input: { sessionID?: string },
      output: { system: string[] },
    ) => {
      if (mode !== "edit") return
      const block = EDIT_PROTOCOL
      output.system = Array.isArray(output.system) ? [block, ...output.system] : [block]
    },

    "experimental.chat.messages.transform": async (
      _input: {},
      output: { messages: OcMessage[] },
    ) => {
      if (mode === "off") return
      const messages = output?.messages
      if (!Array.isArray(messages) || messages.length === 0) return
      const sid = sessionFromMessages(messages.map((m) => m.info ?? {}))
      if (!sid) return
      const s = stateFor(sid)

      // Notices are transient: drop the previous one, re-add only if due.
      stripNotices(messages)

      const size = messagesTokens(messages)
      const budget = parseBudget(s.budget, s.windowTokens)
      const step = pickReminder(size, budget, s.firedReminders)
      const now = Date.now()
      let notice: string | null = null
      if (step !== null) {
        s.firedReminders.add(step)
        notice = budgetNotice(size, budget)
        s.lastNoticeAt = now
      } else if (isOverBudget(size, budget) && now - s.lastNoticeAt > cooldownMs) {
        notice = overflowWarning(size, budget)
        s.lastNoticeAt = now
        s.metrics.forced++
      }

      if (mode === "notices-only") {
        if (notice) injectNotice(messages, notice)
        recordMetric(s, "request", { size, budget, notice: notice != null })
        return
      }

      // edit mode
      seedProtected(s, firstUserText(messages))
      const paths = sessionPaths(root, sid)
      let mirrorText = s.rebuildMirror ? null : readSafe(paths.mirror)
      if (mirrorText == null) {
        mirrorText = renderMirror(toCe(messages), s.protectedRegion)
        writeAtomic(paths.mirror, mirrorText)
        s.rebuildMirror = false
      }

      const parsed = parseMirror(mirrorText)
      const applied = applyMirrorEdits(messages, parsed)

      if (applied.issues.length > 0) {
        s.metrics.rejected++
        logger.warn(`projection rejected (${applied.issues.length}): ${applied.issues[0]}`)
        recordMetric(s, "rejected", { issues: applied.issues })
        if (notice) injectNotice(messages, notice)
        return
      }

      const changed = applied.edited + applied.dropped + applied.added > 0
      recordMetric(s, "request", { size, budget, edited: applied.edited, dropped: applied.dropped, added: applied.added, rejected: 0 })
      if (changed) {
        s.revision++
        s.metrics.edited += applied.edited
        s.metrics.dropped += applied.dropped
        s.metrics.added += applied.added
        output.messages = applied.messages
        ensureDir(paths.edits)
        writeAtomic(
          `${paths.edits}/r${String(s.revision).padStart(4, "0")}.json`,
          JSON.stringify({ ts: now, revision: s.revision, edited: applied.edited, dropped: applied.dropped, added: applied.added, blocks: parsed.blocks }, null, 2),
        )
      }
      if (notice) injectNotice(output.messages, notice)
    },

    "tool.execute.after": async (
      input: { tool: string; sessionID: string; callID: string; args?: Record<string, unknown> },
      output: { title?: string },
    ) => {
      if (mode === "off") return
      const sid = input?.sessionID
      if (!sid) return
      const paths = sessionPaths(root, sid)
      appendJsonl(paths.trace, {
        ts: Date.now(),
        type: "tool",
        tool: input.tool,
        callID: input.callID,
        title: (output?.title ?? "").slice(0, 200),
      })
      const file = String(input?.args?.filePath ?? input?.args?.path ?? "")
      if ((input.tool === "edit" || input.tool === "write") && file.endsWith("context.md")) {
        stateFor(sid).rebuildMirror = false
        recordMetric(stateFor(sid), "mirror-write", { file })
      }
    },

    "experimental.session.compacting": async (
      input: { sessionID: string },
      output: { context: string[]; prompt?: string },
    ) => {
      if (mode !== "edit") return
      const ctx = "[context-editing] this session is under model-managed context editing; compact by editing context.md, not by summarizing wholesale."
      output.context = Array.isArray(output.context) ? [...output.context, ctx] : [ctx]
      logger.info(`compacting session ${input.sessionID} under context-editing`)
    },

    "experimental.compaction.autocontinue": async (
      _input: { sessionID: string },
      output: { enabled: boolean },
    ) => {
      if (mode === "edit") output.enabled = false
    },

    "session.compacted": async (input: { properties?: { session?: { id?: string } } }) => {
      const sid = input?.properties?.session?.id
      if (!sid) return
      const s = stateFor(sid)
      s.rebuildMirror = true
      s.revision++
      logger.info(`session ${sid} compacted — mirror will be rebuilt`)
    },

    "session.deleted": async (input: { properties?: { session?: { id?: string } } }) => {
      const sid = input?.properties?.session?.id
      if (sid) states.delete(sid)
    },

    tool: {
      "context-editing-status": tool({
        description:
          "Report context-editing mode, budget, window, revision, reminder state, metrics, and file paths for this session.",
        args: {},
        async execute(_args: unknown, context: { sessionID: string }) {
          const s = stateFor(context.sessionID)
          const paths = sessionPaths(root, context.sessionID)
          return JSON.stringify({
            mode,
            budget: s.budget,
            windowTokens: s.windowTokens,
            absoluteBudget: parseBudget(s.budget, s.windowTokens),
            revision: s.revision,
            firedReminders: [...s.firedReminders].sort((a, b) => a - b),
            protectedRegion: s.protectedRegion,
            metrics: s.metrics,
            paths,
          })
        },
      }),

      "context-editing-reset": tool({
        description:
          "Discard the current mirror so the next request re-renders it from the live history. The trace is never touched.",
        args: {},
        async execute(_args: unknown, context: { sessionID: string }) {
          const s = stateFor(context.sessionID)
          s.rebuildMirror = true
          s.revision++
          try {
            fs.rmSync(sessionPaths(root, context.sessionID).mirror, { force: true })
          } catch {
            // best effort
          }
          return JSON.stringify({ reset: true, revision: s.revision })
        },
      }),

      "context-editing-recall": tool({
        description:
          "Gated recall from the trace. Fires only when ALL of: a needed fact is missing from the mirror, it is not " +
          "re-derivable from the environment, it plausibly exists in the trace, and the step cannot proceed without " +
          "it. Fails closed: state the justification; a weak one returns no recall.",
        args: {
          query: tool.schema.string().describe("The fact you are missing, as a search phrase"),
          missingInMirror: tool.schema.boolean().describe("A needed fact is missing or contradictory in the mirror"),
          inTrace: tool.schema.boolean().describe("The fact plausibly exists in the trace"),
          reDerivable: tool.schema.boolean().describe("The fact is cheaply re-derivable from files/git/tests"),
          canProceed: tool.schema.boolean().describe("The step can proceed with a safe default"),
          justification: tool.schema.string().describe("Why the step cannot continue without this"),
        },
        async execute(
          args: {
            query: string
            missingInMirror: boolean
            inTrace: boolean
            reDerivable: boolean
            canProceed: boolean
            justification: string
          },
          context: { sessionID: string },
        ) {
          const decision = evaluateRecall({
            missingInMirror: args.missingInMirror,
            inTrace: args.inTrace,
            reDerivable: args.reDerivable,
            canProceed: args.canProceed,
          })
          if (!decision.allow) {
            recordMetric(stateFor(context.sessionID), "recall-denied", { query: args.query, reason: decision.reason })
            return JSON.stringify({ allow: false, reason: decision.reason })
          }
          const trace = readSafe(sessionPaths(root, context.sessionID).trace) ?? ""
          const needle = args.query.toLowerCase().trim()
          const matches = trace
            .split("\n")
            .filter((l) => l.toLowerCase().includes(needle))
            .slice(0, 10)
          recordMetric(stateFor(context.sessionID), "recall-allowed", { query: args.query, matches: matches.length })
          return JSON.stringify({ allow: true, reason: decision.reason, matches })
        },
      }),
    },
  }
}
