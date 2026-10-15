import { type Plugin, tool } from "@opencode-ai/plugin"
import fs from "fs"
import path from "path"
import { createLogger, type PluginLogger } from "../../shared/plugin-logger"
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

/**
 * context-editing — dual-version OpenCode plugin entrypoint.
 *
 * Both versions share one module-level core (`createCore`): per-session state,
 * the mirror filesystem, the projection pipeline and the tool implementations.
 * The two entrypoints differ only in how they expose that core:
 *
 *   v1 (`server(input, options)`, the legacy factory) → `config`, the v1 hook
 *        names / payload shapes, and a `tool: { name: tool({...}) }` map.
 *   v2 (`id` + `setup(ctx)`)                          → `ctx.session.hook(...)`,
 *        `ctx.tool.hook("execute.after")`, `ctx.tool.transform(...)` with JSON
 *        Schema tool inputs, and `ctx.event.subscribe(...)` for lifecycle
 *        events.
 */

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

const NOTICE_PREFIX = "ce-notice-"

/** Tool arguments of `context-editing-recall`. */
interface RecallArgs {
  query: string
  missingInMirror: boolean
  inTrace: boolean
  reDerivable: boolean
  canProceed: boolean
  justification: string
}

// ---------------------------------------------------------------------------
// Core shared by both entrypoints: settings (env / options / config section),
// per-session state, mirror filesystem, projection pipeline and tool bodies.
// ---------------------------------------------------------------------------
function createCore(logger: PluginLogger, root: string, options: Options) {
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

  // ── settings ───────────────────────────────────────────────────────────────

  /** Apply the `context_editing` settings block (v1: opencode.json `config`
   * hook; v2: `ctx.options`). Env always wins, as it did in v1. */
  function applyConfig(cfg: Record<string, unknown> | undefined): void {
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

  // ── hook bodies ────────────────────────────────────────────────────────────

  /** v1 `chat.message` / v2 `ctx.session.hook("prompt")`: remember the opening
   * user text as the goal seed for the protected region. */
  function seedFromUserText(sid: string | undefined, text: string): void {
    if (mode === "off") return
    if (!sid) return
    const s = stateFor(sid)
    if (!text.trim()) return
    seedProtected(s, text)
  }

  /** v1 `experimental.chat.system.transform` / v2
   * `ctx.session.hook("context")`: the edit-protocol block, or null when the
   * system prompt must be left alone. */
  function systemBlock(sid: string | undefined): string | null {
    if (mode !== "edit") return null
    const mirrorPath = sid ? `.context-editing/${sid}/context.md` : "context.md"
    return editProtocol(mirrorPath)
  }

  /** v1 `experimental.chat.messages.transform` / v2
   * `ctx.session.hook("context", …)` (messages): project the live history onto
   * the mirror edits. Returns the message array the host must use — the same
   * reference as the input unless an edit rewrote it — or null when there is
   * nothing to do. */
  function project(messages: OcMessage[] | undefined): OcMessage[] | null {
    if (mode === "off") return null
    if (!Array.isArray(messages) || messages.length === 0) return null
    const sid = sessionFromMessages(messages.map((m) => m.info ?? {}))
    if (!sid) return null
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
      return messages
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
      return messages
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
    const out = changed ? applied.messages : messages
    if (notice) injectNotice(out, notice)
    return out
  }

  /** v1 `tool.execute.after` / v2 `ctx.tool.hook("execute.after")`. */
  function afterTool(
    toolName: string,
    sid: string | undefined,
    callID: string | undefined,
    args: Record<string, unknown> | undefined,
    title: string | undefined,
  ): void {
    if (mode === "off") return
    if (!sid) return
    const paths = sessionPaths(root, sid)
    appendJsonl(paths.trace, {
      ts: Date.now(),
      type: "tool",
      tool: toolName,
      callID,
      title: (title ?? "").slice(0, 200),
    })
    const file = String(args?.filePath ?? args?.path ?? "")
    if ((toolName === "edit" || toolName === "write") && file.endsWith("context.md")) {
      stateFor(sid).rebuildMirror = false
      recordMetric(stateFor(sid), "mirror-write", { file })
    }
  }

  /** v1 `session.compacted` / v2 the `session.compacted` event: the mirror is
   * rebuilt from the (post-compaction) live history. */
  function onCompacted(sid: string): void {
    const s = stateFor(sid)
    s.rebuildMirror = true
    s.renderedIds = new Set()
    s.revision++
    logger.info(`session ${sid} compacted — mirror will be rebuilt`)
  }

  /** v1 `session.deleted` / v2 the `session.deleted` event. */
  function onDeleted(sid: string): void {
    states.delete(sid)
  }

  // ── tool bodies ────────────────────────────────────────────────────────────

  function toolStatus(sessionID: string): string {
    const s = stateFor(sessionID)
    const paths = sessionPaths(root, sessionID)
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
  }

  function toolReset(sessionID: string): string {
    const s = stateFor(sessionID)
    s.rebuildMirror = true
    s.revision++
    try {
      fs.rmSync(sessionPaths(root, sessionID).mirror, { force: true })
    } catch {
      // best effort
    }
    return JSON.stringify({ reset: true, revision: s.revision })
  }

  function toolRecall(sessionID: string, args: RecallArgs): string {
    const decision = evaluateRecall({
      missingInMirror: args.missingInMirror,
      inTrace: args.inTrace,
      reDerivable: args.reDerivable,
      canProceed: args.canProceed,
    })
    if (!decision.allow) {
      recordMetric(stateFor(sessionID), "recall-denied", { query: args.query, reason: decision.reason })
      return JSON.stringify({ allow: false, reason: decision.reason })
    }
    const needle = args.query.toLowerCase().trim()
    if (!needle) {
      recordMetric(stateFor(sessionID), "recall-denied", { reason: "empty query" })
      return JSON.stringify({ allow: false, reason: "empty query" })
    }
    const trace = readSafe(sessionPaths(root, sessionID).trace) ?? ""
    const matches = trace
      .split("\n")
      .filter((l) => l.toLowerCase().includes(needle))
      .slice(0, 10)
    recordMetric(stateFor(sessionID), "recall-allowed", { query: args.query, matches: matches.length })
    return JSON.stringify({ allow: true, reason: decision.reason, matches })
  }

  // Getters keep the reassignable settings live across `applyConfig`.
  return {
    get mode() { return mode },
    get budget() { return defaultBudget },
    get windowTokens() { return defaultWindow },
    get isEditMode() { return mode === "edit" },
    applyConfig,
    seedFromUserText,
    systemBlock,
    project,
    afterTool,
    onCompacted,
    onDeleted,
    toolStatus,
    toolReset,
    toolRecall,
  }
}

// ---------------------------------------------------------------------------
// v1 entrypoint (legacy function form, unchanged semantics).
// ---------------------------------------------------------------------------
const v1Factory = async (
  { client, directory, worktree }: Parameters<Plugin>[0],
  options: Options = {},
): Promise<{ [key: string]: unknown }> => {
  writeLoadCanary("context-editing")
  const logger = createLogger(client, "context-editing")
  const root = worktree ?? directory

  if (process.env[DISABLED_ENV] === "0") {
    logger.info("plugin disabled via LLMHP_CONTEXT_EDITING=0")
    return {}
  }

  const core = createCore(logger, root, options)

  logger.info(`plugin active — mode=${core.mode} budget=${core.budget} window=${core.windowTokens}`)

  return {
    config: async (input: Record<string, unknown>) => {
      const cfg = (input?.context_editing ?? input?.contextEditing) as Record<string, unknown> | undefined
      if (!cfg || typeof cfg !== "object") return
      core.applyConfig(cfg)
    },

    "chat.message": async (
      input: { sessionID: string },
      output: { parts?: Array<{ type: string; text?: string }> },
    ) => {
      const text = (output?.parts ?? []).find((p) => p.type === "text" && p.text)?.text ?? ""
      core.seedFromUserText(input?.sessionID, text)
    },

    "experimental.chat.system.transform": async (
      input: { sessionID?: string },
      output: { system: string[] },
    ) => {
      const block = core.systemBlock(input?.sessionID)
      if (!block) return
      output.system = Array.isArray(output.system) ? [block, ...output.system] : [block]
    },

    "experimental.chat.messages.transform": async (
      _input: {},
      output: { messages: OcMessage[] },
    ) => {
      const before = output?.messages
      const out = core.project(Array.isArray(before) ? before : undefined)
      if (out && out !== before) output.messages = out
    },

    "tool.execute.after": async (
      input: { tool: string; sessionID: string; callID: string; args?: Record<string, unknown> },
      output: { title?: string },
    ) => {
      core.afterTool(input?.tool, input?.sessionID, input?.callID, input?.args, output?.title)
    },

    "experimental.session.compacting": async (
      input: { sessionID: string },
      output: { context: string[]; prompt?: string },
    ) => {
      if (!core.isEditMode) return
      const ctx = "[context-editing] this session is under model-managed context editing; compact by editing context.md, not by summarizing wholesale."
      output.context = Array.isArray(output.context) ? [...output.context, ctx] : [ctx]
      logger.info(`compacting session ${input.sessionID} under context-editing`)
    },

    "experimental.compaction.autocontinue": async (
      _input: { sessionID: string },
      output: { enabled: boolean },
    ) => {
      if (core.isEditMode) output.enabled = false
    },

    "session.compacted": async (input: { properties?: { session?: { id?: string } } }) => {
      const sid = input?.properties?.session?.id
      if (!sid) return
      core.onCompacted(sid)
    },

    "session.deleted": async (input: { properties?: { session?: { id?: string } } }) => {
      const sid = input?.properties?.session?.id
      if (sid) core.onDeleted(sid)
    },

    tool: {
      "context-editing-status": tool({
        description:
          "Report context-editing mode, budget, window, revision, reminder state, metrics, and file paths for this session.",
        args: {},
        async execute(_args: unknown, context: { sessionID: string }) {
          return core.toolStatus(context.sessionID)
        },
      }),

      "context-editing-reset": tool({
        description:
          "Discard the current mirror so the next request re-renders it from the live history. The trace is never touched.",
        args: {},
        async execute(_args: unknown, context: { sessionID: string }) {
          return core.toolReset(context.sessionID)
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
          args: RecallArgs,
          context: { sessionID: string },
        ) {
          return core.toolRecall(context.sessionID, args)
        },
      }),
    },
  }
}

// ---------------------------------------------------------------------------
// v2 entrypoint (docs/build/plugins/migrate-v1): `id` + `setup(ctx)`, with v1
// served by `server`. v2 differences from v1:
//   - no `client`: logging goes to stderr (`consoleLogger`) and the project
//     root comes from `ctx.location`, not `{ directory, worktree }`;
//   - no `config` hook: the `context_editing` settings block arrives as
//     `ctx.options` and is applied through the same `applyConfig` path;
//   - `chat.message` → `ctx.session.hook("prompt")` (mutate `event.prompt.text`
//     if needed — here it only reads);
//   - `experimental.chat.system.transform` → `ctx.session.hook("context")`
//     where the system prompt is `{ type: "text", text }` parts;
//   - `experimental.chat.messages.transform` → the same `context` hook, whose
//     payload also carries `messages`;
//   - `tool.execute.after` → `ctx.tool.hook("execute.after")`;
//   - `experimental.session.compacting` → `ctx.session.hook("compaction")`
//     (`event.context` is the compaction-context array);
//   - `experimental.compaction.autocontinue` → **no v2 equivalent**; it is
//     folded into the compaction hook as a best-effort field set (see below);
//   - `session.compacted` / `session.deleted` → `ctx.event.subscribe(…)`
//     yielding `{ type, properties }`;
//   - the tool map → `ctx.tool.transform(editor)` with JSON Schema inputs and
//     `{ content }` results.
// ---------------------------------------------------------------------------
function consoleLogger(service: string) {
  return {
    debug: (_m: string) => {},
    info: (m: string) => console.error(`[${service}] ${m}`),
    warn: (m: string) => console.error(`[${service}] WARN ${m}`),
    error: (m: string) => console.error(`[${service}] ERROR ${m}`),
  }
}

const str = (description: string) => ({ type: "string", description })
const bool = (description: string) => ({ type: "boolean", description })
const emptyInput = { type: "object", properties: {}, additionalProperties: false } as const
const schema = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
})

export default {
  id: "context-editing",

  async setup(ctx: any) {
    writeLoadCanary("context-editing")
    const logger = consoleLogger("context-editing")
    const root: string = ctx.location?.project?.canonical ?? ctx.location?.directory

    if (process.env[DISABLED_ENV] === "0") {
      logger.info("plugin disabled via LLMHP_CONTEXT_EDITING=0")
      return
    }

    const settings = (ctx.options ?? {}) as Record<string, unknown>
    const core = createCore(logger, root, settings as Options)
    // v2 has no config hook: the `context_editing` settings block arrives here
    // as the plugin options, so it goes through the same path the v1 config
    // hook uses (env still wins).
    core.applyConfig(settings)

    logger.info(`plugin active — mode=${core.mode} budget=${core.budget} window=${core.windowTokens}`)

    await ctx.session.hook("prompt", (event: any) => {
      const text: string | undefined = event?.prompt?.text
      core.seedFromUserText(event?.sessionID, text ?? "")
    })

    await ctx.session.hook("context", (event: any) => {
      const block = core.systemBlock(event?.sessionID)
      if (!block) return
      if (Array.isArray(event.system)) event.system.unshift({ type: "text", text: block })
    })

    await ctx.session.hook("context", (event: any) => {
      const messages = event?.messages
      const out = core.project(Array.isArray(messages) ? messages : undefined)
      if (out && out !== messages && Array.isArray(event.messages)) {
        event.messages.splice(0, event.messages.length, ...out)
      }
    })

    await ctx.tool.hook("execute.after", (event: any) => {
      const toolName: string = event?.tool ?? event?.name
      if (!toolName) return
      const result = event?.result
      core.afterTool(
        toolName,
        event?.sessionID ?? event?.session?.id,
        event?.id ?? event?.callID ?? event?.messageID,
        (event?.input ?? event?.args) as Record<string, unknown> | undefined,
        (result?.metadata?.title ?? result?.output?.title ?? event?.output?.title ?? event?.title) as string | undefined,
      )
    })

    await ctx.session.hook("compaction", (event: any) => {
      if (!core.isEditMode) return
      const note =
        "[context-editing] this session is under model-managed context editing; compact by editing context.md, not by summarizing wholesale."
      // V2's compaction event carries the transcript (`messages`) and an optional
      // `result` override, but no documented extra-instructions slot like V1's
      // `output.context`. Write it only when the payload exposes such a field, so
      // this stays forward-compatible instead of silently corrupting the event.
      if (Array.isArray(event?.context)) {
        event.context.push(note)
      }
      // V1's `experimental.compaction.autocontinue` has no V2 hook. If the payload
      // models the decision, suppressing it keeps the V1 guarantee (one compressor
      // at a time); otherwise V2 owns the decision.
      if (typeof event?.autocontinue === "boolean") event.autocontinue = false
      logger.info(`compacting session ${event?.sessionID} under context-editing`)
    })

    const controller = new AbortController()
    void (async () => {
      try {
        for await (const input of ctx.event.subscribe({ signal: controller.signal })) {
          if (controller.signal.aborted) break
          const type = input?.type
          const data = input?.properties ?? input?.data
          const sid: string | undefined = data?.session?.id ?? data?.sessionID ?? data?.info?.id
          if (!sid) continue
          if (type === "session.compacted") core.onCompacted(sid)
          else if (type === "session.deleted") core.onDeleted(sid)
        }
      } catch {
        // the event stream is best-effort bookkeeping
      }
    })()

    await ctx.tool.transform((editor: any) => {
      editor.add({
        name: "context-editing-status",
        description:
          "Report context-editing mode, budget, window, revision, reminder state, metrics, and file paths for this session.",
        input: emptyInput,
        async execute(_args: any, context: any) {
          return { content: core.toolStatus(String(context?.sessionID ?? "")) }
        },
      })

      editor.add({
        name: "context-editing-reset",
        description:
          "Discard the current mirror so the next request re-renders it from the live history. The trace is never touched.",
        input: emptyInput,
        async execute(_args: any, context: any) {
          return { content: core.toolReset(String(context?.sessionID ?? "")) }
        },
      })

      editor.add({
        name: "context-editing-recall",
        description:
          "Gated recall from the trace. Fires only when ALL of: a needed fact is missing from the mirror, it is not " +
          "re-derivable from the environment, it plausibly exists in the trace, and the step cannot proceed without " +
          "it. Fails closed: state the justification; a weak one returns no recall.",
        input: schema(
          {
            query: str("The fact you are missing, as a search phrase"),
            missingInMirror: bool("A needed fact is missing or contradictory in the mirror"),
            inTrace: bool("The fact plausibly exists in the trace"),
            reDerivable: bool("The fact is cheaply re-derivable from files/git/tests"),
            canProceed: bool("The step can proceed with a safe default"),
            justification: str("Why the step cannot continue without this"),
          },
          ["query", "missingInMirror", "inTrace", "reDerivable", "canProceed", "justification"],
        ),
        async execute(args: any, context: any) {
          return { content: core.toolRecall(String(context?.sessionID ?? ""), args as RecallArgs) }
        },
      })
    })

    return () => controller.abort()
  },

  async server(input: any, options?: any) {
    return v1Factory(input, options)
  },
}
