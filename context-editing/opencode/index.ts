import { type Plugin, tool } from "@opencode-ai/plugin"
import fs from "fs"
import path from "path"
import { createLogger } from "../../shared/plugin-logger"
import { writeLoadCanary } from "../../shared/load-canary"
import {
  DEFAULT_BUDGET,
  NOTICE_COOLDOWN_MS,
  applyMirrorEdits,
  budgetNotice,
  editableIds,
  editProtocol,
  evaluateRecall,
  isOverBudget,
  messagesTokens,
  overflowWarning,
  parseBudget,
  parseMirror,
  pickReminder,
  reconcileBlocks,
  renderMirror,
  renderParsed,
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

const MODES: readonly Mode[] = ["off", "notices-only", "edit"]

/** Validate a mode from env/config; anything unknown falls back to the default
 * rather than silently behaving as edit. */
function resolveMode(...candidates: (string | undefined)[]): Mode {
  for (const c of candidates) {
    if (c && (MODES as readonly string[]).includes(c)) return c as Mode
  }
  return "notices-only"
}

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
  /** Every editable part id ever shown in the mirror; a part in this set that
   * is absent from the file was deleted by the model and stays deleted. */
  renderedIds: Set<string>
  /** Every trace-recorded part id, so assistant/tool text is appended once. */
  tracedIds: Set<string>
  /** Last persisted mirror text; a change here is a mirror revision. */
  lastMirrorText: string | null
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

  const envMode = process.env[MODE_ENV]
  const envBudget = process.env[BUDGET_ENV]
  const envWindowRaw = Number(process.env[WINDOW_ENV])
  const envWindow = Number.isFinite(envWindowRaw) && envWindowRaw > 0 ? envWindowRaw : undefined
  if (envMode && !(MODES as readonly string[]).includes(envMode)) {
    logger.warn(`ignoring invalid ${MODE_ENV}="${envMode}" — using "notices-only"`)
  }

  let mode = resolveMode(envMode, options.mode)
  let defaultBudget = envBudget ?? options.budget ?? DEFAULT_BUDGET
  let defaultWindow = envWindow ?? options.windowTokens ?? 200_000
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
        renderedIds: new Set(),
        tracedIds: new Set(),
        lastMirrorText: null,
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
    // Clone a text part from the target message when possible, so fields like
    // messageID stay consistent with the message the part is attached to.
    const template =
      (target.parts ?? []).find((p) => p.type === "text") ??
      messages.flatMap((m) => m.parts).find((p) => p.type === "text")
    const part = template
      ? { ...template, id: `${NOTICE_PREFIX}${Date.now()}`, text }
      : { id: `${NOTICE_PREFIX}${Date.now()}`, type: "text", text }
    target.parts = [part, ...(target.parts ?? [])]
  }

  function recordMetric(s: SessionState, event: string, extra: Record<string, unknown>): void {
    appendJsonl(sessionPaths(root, s.id).metrics, { ts: Date.now(), sessionID: s.id, event, ...extra })
  }

  /** Append every textual part (user, assistant, tool output) to the trace
   * once, so the log is a complete-enough forensic record in all modes. */
  function traceParts(s: SessionState, messages: OcMessage[]): void {
    const file = sessionPaths(root, s.id).trace
    for (const m of messages) {
      for (const p of m.parts ?? []) {
        if (typeof p.text !== "string" || !p.text.trim()) continue
        if (s.tracedIds.has(p.id)) continue
        s.tracedIds.add(p.id)
        appendJsonl(file, { ts: Date.now(), type: "part", role: String(m.info?.role ?? ""), partId: p.id, text: p.text.slice(0, 4000) })
      }
    }
  }

  // ── hooks ──────────────────────────────────────────────────────────────────

  return {
    config: async (input: Record<string, unknown>) => {
      const cfg = (input?.context_editing ?? input?.contextEditing) as Record<string, unknown> | undefined
      if (!cfg || typeof cfg !== "object") return
      if (!envMode && typeof cfg.mode === "string") {
        if ((MODES as readonly string[]).includes(cfg.mode)) mode = cfg.mode as Mode
        else logger.warn(`ignoring invalid context_editing.mode="${cfg.mode}"`)
      }
      if (!envBudget && typeof cfg.budget === "string") defaultBudget = cfg.budget
      if (envWindow === undefined && typeof cfg.windowTokens === "number" && cfg.windowTokens > 0) {
        defaultWindow = cfg.windowTokens
      }
      logger.info(`config context_editing applied — mode=${mode} budget=${defaultBudget} window=${defaultWindow}`)
    },

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
      seedProtected(s, text)
    },

    "experimental.chat.system.transform": async (
      input: { sessionID?: string },
      output: { system: string[] },
    ) => {
      if (mode !== "edit") return
      const sid = input?.sessionID
      const mirrorPath = sid ? `.context-editing/${sid}/context.md` : "context.md"
      const block = editProtocol(mirrorPath)
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
      traceParts(s, messages)

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
      const ce = toCe(messages)
      let mirrorText = s.rebuildMirror ? null : readSafe(paths.mirror)
      if (mirrorText == null) {
        mirrorText = renderMirror(ce, s.protectedRegion)
        writeAtomic(paths.mirror, mirrorText)
        s.rebuildMirror = false
        s.renderedIds = new Set()
        s.lastMirrorText = mirrorText
      }

      // Reconcile: append blocks for parts the model has never seen (new turns)
      // so they are not mistaken for deletions. `renderedIds` stays cumulative,
      // so a block the model deleted is not re-appended on the next request.
      let parsed = parseMirror(mirrorText)
      const fresh = reconcileBlocks(parsed, ce, s.renderedIds)
      if (fresh.length > 0) {
        parsed = { protected: parsed.protected, blocks: [...parsed.blocks, ...fresh] }
        mirrorText = renderParsed(parsed)
        writeAtomic(paths.mirror, mirrorText)
      }
      for (const id of editableIds(ce)) s.renderedIds.add(id)

      // Heal an emptied protected region from the state copy rather than
      // rejecting every subsequent request (otherwise the file stays broken).
      if (!parsed.protected.trim() && s.protectedRegion.trim()) {
        parsed = { ...parsed, protected: s.protectedRegion }
        mirrorText = renderParsed(parsed)
        writeAtomic(paths.mirror, mirrorText)
        recordMetric(s, "protected-restored", {})
      }

      // A mirror revision is a change to the file, not a re-projection: a
      // persistent edit/drop stays applied every request and must not bump the
      // revision (or rewrite the diff) each time.
      const mirrorChanged = mirrorText !== s.lastMirrorText

      const applied = applyMirrorEdits(messages, parsed)

      if (applied.issues.length > 0) {
        s.metrics.rejected++
        logger.warn(`projection rejected (${applied.issues.length}): ${applied.issues[0]}`)
        recordMetric(s, "rejected", { issues: applied.issues })
        if (notice) injectNotice(messages, notice)
        return
      }

      if (mirrorChanged) {
        s.lastMirrorText = mirrorText
        s.revision++
        s.metrics.edited += applied.edited
        s.metrics.dropped += applied.dropped
        s.metrics.added += applied.added
        ensureDir(paths.edits)
        writeAtomic(
          `${paths.edits}/r${String(s.revision).padStart(4, "0")}.json`,
          JSON.stringify({ ts: now, revision: s.revision, edited: applied.edited, dropped: applied.dropped, added: applied.added, blocks: parsed.blocks }, null, 2),
        )
      }

      const changed = applied.edited + applied.dropped + applied.added > 0
      recordMetric(s, "request", { size, budget, edited: applied.edited, dropped: applied.dropped, added: applied.added, rejected: 0 })
      if (changed) output.messages = applied.messages
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
      s.renderedIds = new Set()
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
          const needle = args.query.toLowerCase().trim()
          if (!needle) {
            recordMetric(stateFor(context.sessionID), "recall-denied", { reason: "empty query" })
            return JSON.stringify({ allow: false, reason: "empty query" })
          }
          const trace = readSafe(sessionPaths(root, context.sessionID).trace) ?? ""
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
