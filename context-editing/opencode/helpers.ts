/**
 * Context Editing — pure logic.
 *
 * Everything testable lives here, free of the OpenCode plugin API: budget
 * parsing and token estimation, the mirror file (render / parse), the
 * projection merge back to a message array, wire-format validation, the recall
 * gate, notices, telemetry, and path layout. `index.ts` only wires hooks to
 * these functions.
 */

export const MIRROR_VERSION = 1
export const DEFAULT_BUDGET = "50%"
export const REMINDER_STEPS = [25, 50, 75] as const
export const NOTICE_COOLDOWN_MS = 60_000

/// ── token accounting ────────────────────────────────────────────────────────

/** Deterministic character heuristic; the provider confirms the real count
 * later (the estimated-vs-confirmed split, §12). */
export function estimateTokens(text: string): number {
  if (!text) return 0
  return Math.ceil(text.length / 4)
}

export function partsTokens(parts: Array<{ text?: string }>): number {
  let n = 0
  for (const p of parts) n += estimateTokens(p?.text ?? "")
  return n
}

export function messagesTokens(messages: Array<{ parts: Array<{ text?: string }> }>): number {
  let n = 0
  for (const m of messages) n += partsTokens(m?.parts ?? [])
  return n
}

/**
 * Parse a budget spec into an absolute token count.
 *   "50%"   → half the window
 *   "64k"   → 64 * 1024
 *   "window"→ the whole window
 * A bare number is taken as a literal token count, but the shorthand forms must
 * use "k" (a bare "64" means sixty-four tokens, not sixty-four thousand).
 */
export function parseBudget(spec: string | undefined, windowTokens: number): number {
  const s = (spec ?? DEFAULT_BUDGET).trim().toLowerCase()
  if (!windowTokens || windowTokens <= 0) return 0
  if (s === "window") return windowTokens
  if (s.endsWith("%")) {
    const pct = Number(s.slice(0, -1))
    if (!Number.isFinite(pct) || pct < 1) return Math.floor(windowTokens * 0.5)
    return Math.max(1, Math.floor(windowTokens * (pct / 100)))
  }
  if (s.endsWith("k")) {
    const k = Number(s.slice(0, -1))
    if (Number.isFinite(k) && k > 0) return Math.floor(k * 1024)
    return 0
  }
  const n = Number(s)
  if (Number.isFinite(n) && n > 0) return Math.floor(n)
  return Math.floor(windowTokens * 0.5)
}

export function isOverBudget(size: number, budget: number): boolean {
  return budget > 0 && size > budget
}

/** Highest reminder step crossed and not yet fired, else null. */
export function pickReminder(
  size: number,
  budget: number,
  fired: ReadonlySet<number>,
): number | null {
  if (budget <= 0) return null
  const pct = (size / budget) * 100
  let hit: number | null = null
  for (const step of REMINDER_STEPS) {
    if (pct >= step && !fired.has(step)) hit = step
  }
  return hit
}

/// ── notices ─────────────────────────────────────────────────────────────────

export function budgetNotice(size: number, budget: number): string {
  const pct = budget > 0 ? Math.round((size / budget) * 100) : 0
  return (
    `[context-editing] context ≈ ${size} tokens (${pct}% of the ${budget}-token budget). ` +
    `Keep it relevant: this is a constraint, not a goal — if you cannot trim ` +
    `truthfully, exceed the budget rather than invent content.`
  )
}

export function overflowWarning(size: number, budget: number): string {
  return (
    `[context-editing] context ≈ ${size} tokens, over the ${budget}-token budget. ` +
    `Compact now: compress or drop superseded material, or state plainly that ` +
    `it cannot be reduced without loss. Do not fabricate.`
  )
}

export const EDIT_PROTOCOL = [
  "## Context editing",
  "Your context is the file `context.md` shown to you in this request. Edit it",
  "with ordinary file tools to keep it relevant; the edited file becomes your",
  "next input.",
  "Allowed operations: KEEP (verbatim), COMPRESS, DROP, ADD, FIX, MERGE.",
  "Rules:",
  "- Prefer ADD over DROP when unsure. Only drop a span if its information is",
  "  still carried by what you keep, or is cheaply re-derivable from the",
  "  environment (files, git, a test rerun).",
  "- Ground every ADD/FIX in something observed — never invent facts.",
  "- The head region (goal, constraints, open questions) is append-mostly: add,",
  "  do not drop.",
  "- Machine-generated block markers and any `pinned` block are not yours to",
  "  edit; leave them intact.",
  "- Budget is a constraint: if you cannot meet it truthfully, exceed it and say",
  "  so. Never fabricate to hit a number.",
].join("\n")

/// ── message/mirror model ────────────────────────────────────────────────────

export interface CePart {
  id: string
  type: string
  text?: string
  callID?: string
  toolUseID?: string
  [k: string]: unknown
}

export interface CeMessage {
  id: string
  role: string
  sessionID?: string
  parts: CePart[]
}

export interface MirrorBlock {
  msgId: string
  partId: string
  role: string
  kind: "text" | "pinned"
  pinnedType?: string
  text: string
}

export interface ParsedMirror {
  protected: string
  blocks: MirrorBlock[]
}

const OPEN = (msgId: string, partId: string, role: string, extra = "") =>
  `<!-- ce:b msg=${msgId} id=${partId} role=${role}${extra} -->`
const CLOSE = "<!-- /ce:b -->"

function marker(block: MirrorBlock): string {
  const extra = block.kind === "pinned" ? ` kind=pinned type=${block.pinnedType ?? "unknown"}` : ""
  return OPEN(block.msgId, block.partId, block.role, extra)
}

const UNEDITABLE = new Set(["tool", "tool_use", "tool_result", "reasoning", "image", "file", "step-start", "step-finish", "snapshot", "patch"])

export function isEditablePart(part: CePart): boolean {
  if (part.type !== "text") return false
  return typeof part.text === "string" && part.text.length > 0
}

/**
 * Render the mirror. The protected region is prepended verbatim; each editable
 * text part becomes a body block; every other part becomes a bodyless pinned
 * marker re-spliced from the trace at projection time (§8.2).
 */
export function renderMirror(messages: CeMessage[], protectedRegion: string): string {
  const out: string[] = [`<!-- context-editing:mirror v${MIRROR_VERSION} -->`, ""]
  out.push("# Head (append-mostly — add, do not drop)")
  out.push("")
  out.push(protectedRegion.trim() || "_no goal recorded yet_")
  out.push("")
  out.push("# Context (editable — KEEP / COMPRESS / DROP / ADD / FIX / MERGE)")
  out.push("")
  for (const m of messages) {
    for (const p of m.parts) {
      if (isEditablePart(p)) {
        const b: MirrorBlock = { msgId: m.id, partId: p.id, role: m.role, kind: "text", text: p.text ?? "" }
        out.push(marker(b))
        out.push(b.text)
        out.push(CLOSE)
      } else {
        const b: MirrorBlock = { msgId: m.id, partId: p.id, role: m.role, kind: "pinned", pinnedType: p.type, text: "" }
        out.push(marker(b))
      }
      out.push("")
    }
  }
  return out.join("\n")
}

const HEAD_RE = /^#\s+Head\b/m
const BODY_RE = /^#\s+Context\b/m
const OPEN_LINE_RE = /^<!-- ce:b msg=(\S+) id=(\S+) role=(\S+)(?: kind=pinned type=(\S+))? -->$/gm
const CLOSE_LINE = "<!-- /ce:b -->"

/**
 * Parse a mirror back into its protected region and ordered blocks. A single
 * left-to-right scan preserves the interleaving of editable and pinned blocks;
 * a text block's body runs from its open line to the next close line.
 */
export function parseMirror(md: string): ParsedMirror {
  const text = md ?? ""
  const headIdx = text.search(HEAD_RE)
  const bodyIdx = text.search(BODY_RE)
  let protectedRegion = ""
  if (headIdx >= 0 && bodyIdx > headIdx) {
    const head = text.slice(headIdx, bodyIdx)
    protectedRegion = head.replace(/^#\s+Head.*$/m, "").trim()
    if (protectedRegion === "_no goal recorded yet_") protectedRegion = ""
  }

  const body = bodyIdx >= 0 ? text.slice(bodyIdx) : text
  const blocks: MirrorBlock[] = []
  OPEN_LINE_RE.lastIndex = 0
  let m: RegExpExecArray | null
  let cursor = 0
  while ((m = OPEN_LINE_RE.exec(body)) !== null) {
    const openStart = m.index
    if (openStart < cursor) continue
    const [, msgId, partId, role, pinnedType] = m
    const openEnd = m.index + m[0].length
    if (pinnedType) {
      blocks.push({ msgId, partId, role, kind: "pinned", pinnedType, text: "" })
      cursor = openEnd
      continue
    }
    const closeIdx = body.indexOf(CLOSE_LINE, openEnd)
    if (closeIdx < 0) {
      blocks.push({ msgId, partId, role, kind: "text", text: body.slice(openEnd).replace(/^\n/, "").trimEnd() })
      break
    }
    const raw = body.slice(openEnd, closeIdx).replace(/^\n/, "")
    blocks.push({ msgId, partId, role, kind: "text", text: raw.replace(/\n$/, "") })
    cursor = closeIdx + CLOSE_LINE.length
    OPEN_LINE_RE.lastIndex = cursor
  }
  return { protected: protectedRegion, blocks }
}

/// ── projection + validation ─────────────────────────────────────────────────

export interface ProjectionResult {
  messages: CeMessage[]
  issues: string[]
}

/**
 * Merge the parsed mirror with pinned parts from the source trace. Editable
 * text comes from the file; every non-text part is reinstated verbatim from
 * the trace, so the request stays structurally valid (§8.2). Ordering follows
 * the mirror's block order; message grouping follows the source message ids.
 */
export function project(parsed: ParsedMirror, source: CeMessage[]): ProjectionResult {
  const partById = new Map<string, CePart>()
  const roleById = new Map<string, string>()
  const sessionId = source[0]?.sessionID
  const order: string[] = []
  for (const m of source) {
    if (!order.includes(m.id)) order.push(m.id)
    roleById.set(m.id, m.role)
    for (const p of m.parts) partById.set(p.id, p)
  }

  const byMsg = new Map<string, CePart[]>()
  const issues: string[] = []
  const ensure = (id: string): CePart[] => {
    if (!byMsg.has(id)) byMsg.set(id, [])
    return byMsg.get(id)!
  }

  for (const b of parsed.blocks) {
    if (b.kind === "pinned") {
      const orig = partById.get(b.partId)
      if (!orig) {
        issues.push(`missing pinned part ${b.partId} in trace`)
        continue
      }
      ensure(b.msgId).push(orig)
    } else {
      ensure(b.msgId).push({ id: b.partId, type: "text", text: b.text })
    }
  }

  const messages: CeMessage[] = order
    .filter((id) => byMsg.has(id))
    .map((id) => ({
      id,
      role: roleById.get(id) ?? "user",
      sessionID: sessionId,
      parts: byMsg.get(id)!,
    }))

  return { messages, issues }
}

/**
 * Wire-format invariants. A tool call and its result must both survive or both
 * go: splitting the pair breaks the provider message format (§8.2).
 */
export function validateParts(parts: CePart[]): string[] {
  const issues: string[] = []
  const uses = new Map<string, number>()
  const results = new Map<string, number>()
  for (const p of parts) {
    if (p.type === "tool" || p.type === "tool_use") {
      const cid = String((p.callID ?? p.id) as string)
      uses.set(cid, (uses.get(cid) ?? 0) + 1)
    }
    if (p.type === "tool_result") {
      const cid = String((p.toolUseID ?? p.callID) as string)
      results.set(cid, (results.get(cid) ?? 0) + 1)
    }
  }
  for (const [cid, n] of uses) {
    const r = results.get(cid) ?? 0
    if (r === 0) issues.push(`tool call ${cid} has no matching result (pair split)`)
    else if (r > n) issues.push(`tool call ${cid} has ${r} results for ${n} calls`)
  }
  for (const [cid, n] of results) {
    if ((uses.get(cid) ?? 0) === 0) issues.push(`tool result ${cid} has no matching call (pair split)`)
    else if (n > 1 && n !== (uses.get(cid) ?? 0)) issues.push(`duplicate tool result ${cid}`)
  }
  return issues
}

/** Full validation: projection issues + pair atomicity + protected region. */
export function validateProjection(result: ProjectionResult, parsed: ParsedMirror): string[] {
  const issues = [...result.issues, ...validateParts(result.messages.flatMap((m) => m.parts))]
  if (!parsed.protected.trim()) issues.push("protected region is empty")
  return issues
}

/// ── applying mirror edits onto an OpenCode-shaped message array ─────────────

export interface OcMessage {
  info: { id?: string; role?: string; sessionID?: string; [k: string]: unknown }
  parts: CePart[]
}

export interface ApplyResult {
  messages: OcMessage[]
  issues: string[]
  edited: number
  dropped: number
  added: number
}

/**
 * Apply a parsed mirror to an OpenCode `{info, parts}[]` array **in place of**
 * its parts while preserving original part objects (and therefore every field
 * the provider requires): editable text bodies are updated, text parts absent
 * from the mirror are dropped, pinned parts are kept verbatim, and new text
 * blocks with no matching part are appended to the last surviving message.
 * Dropping a tool pair is left to validation (§8.2), which the caller checks.
 */
export function applyMirrorEdits(messages: OcMessage[], parsed: ParsedMirror): ApplyResult {
  const textBlock = new Map<string, MirrorBlock>()
  for (const b of parsed.blocks) if (b.kind === "text") textBlock.set(b.partId, b)

  const seen = new Set<string>()
  const out: OcMessage[] = []
  let edited = 0
  let dropped = 0

  for (const m of messages) {
    const parts: CePart[] = []
    for (const p of m.parts) {
      if (isEditablePart(p)) {
        seen.add(p.id)
        const b = textBlock.get(p.id)
        if (!b) {
          dropped++
          continue
        }
        if (b.text !== p.text) edited++
        parts.push({ ...p, text: b.text })
      } else {
        parts.push(p)
      }
    }
    if (parts.length > 0) out.push({ info: m.info, parts })
  }

  const additions = parsed.blocks.filter((b) => b.kind === "text" && !seen.has(b.partId))
  let added = 0
  if (additions.length > 0) {
    const target = out[out.length - 1]
    const template = messages.flatMap((m) => m.parts).find((p) => p.type === "text")
    if (target) {
      for (const b of additions) {
        const part: CePart = template
          ? { ...template, id: b.partId, text: b.text }
          : { id: b.partId, type: "text", text: b.text }
        target.parts.push(part)
        added++
      }
    } else {
      for (const b of additions) {
        out.push({
          info: { id: `ce-add-${b.partId}`, role: b.role, sessionID: b.msgId },
          parts: [{ id: b.partId, type: "text", text: b.text }],
        })
        added++
      }
    }
  }

  const issues = validateParts(out.flatMap((m) => m.parts))
  if (!parsed.protected.trim()) issues.push("protected region is empty")
  return { messages: out, issues, edited, dropped, added }
}

/** High-level: parse + project + validate. Empties issues when valid. */
export function buildProjection(mirrorText: string, source: CeMessage[]): ProjectionResult {
  const parsed = parseMirror(mirrorText)
  const result = project(parsed, source)
  const vissues = validateProjection(result, parsed)
  return { messages: result.messages, issues: vissues }
}

/// ── recall gate ─────────────────────────────────────────────────────────────

export interface RecallConditions {
  missingInMirror: boolean
  inTrace: boolean
  reDerivable: boolean
  canProceed: boolean
}

/**
 * Fail-closed: recall fires only when all three conditions of §6 hold. A weak
 * justification (or an optional-only need) returns a reason and no recall.
 */
export function evaluateRecall(c: RecallConditions): { allow: boolean; reason: string } {
  if (!c.missingInMirror) return { allow: false, reason: "no missing or contradictory fact in the mirror" }
  if (c.canProceed) return { allow: false, reason: "step can proceed with a safe default — recall not required" }
  if (!c.inTrace) return { allow: false, reason: "fact is not known to exist in the trace" }
  if (c.reDerivable) return { allow: false, reason: "fact is re-derivable from the environment — do not recall" }
  return { allow: true, reason: "missing, in the trace, not re-derivable, and blocking" }
}

/// ── misc ────────────────────────────────────────────────────────────────────

/** Recover the session id from the message list (the transform hook has none). */
export function sessionFromMessages(messages: Array<{ sessionID?: string }>): string | undefined {
  for (const m of messages) if (m?.sessionID) return m.sessionID
  return undefined
}

export interface CePaths {
  dir: string
  mirror: string
  trace: string
  edits: string
  metrics: string
  index: string
}

export function sessionPaths(root: string, sessionID: string): CePaths {
  const dir = `${root}/.context-editing/${sessionID}`
  return {
    dir,
    mirror: `${dir}/context.md`,
    trace: `${dir}/trace.jsonl`,
    edits: `${dir}/edits`,
    metrics: `${dir}/metrics.jsonl`,
    index: `${dir}/index`,
  }
}
