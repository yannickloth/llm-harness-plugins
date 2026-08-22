import os from "os"
import fs from "fs"
import path from "path"

export type PeakWindow = [number, number]

export const PEAK_WINDOWS_UTC: PeakWindow[] = [
  [1, 4],
  [6, 10],
]

export const NUDGE_MARKER = "[offpeak-nudge]"
export const STATE_FILE_NAME = "offpeak-nudge-state.json"

export type HeavyOptions = {
  skillNames?: string[]
  stepThreshold?: number
  longRunningKeywords?: string[]
}

/**
 * Time-of-day pricing plan for a provider. Providers without a plan (or with
 * `timeOfDay: false`) are treated as flat-priced: no nudges, no cost warnings.
 */
export type PricingPlan = {
  providerID: string
  /** DeepSeek-style time-of-day pricing (peak window vs cheaper off-peak). */
  timeOfDay: boolean
  /** Peak windows in UTC hours. */
  peakWindowsUtc?: PeakWindow[]
  /** Off-peak cost as a ratio of peak cost (0.5 => half price). */
  offPeakRatio?: number
  /** Optional weekend off-peak policy. From `since` (ISO date) onward, the given
   *  UTC offset timezone treats Saturdays and Sundays as entirely off-peak. */
  weekendOffPeak?: { since: string; utcOffsetHours: number }
}

export const DEFAULT_PRICING_PLANS: PricingPlan[] = [
  {
    providerID: "deepseek",
    timeOfDay: true,
    peakWindowsUtc: PEAK_WINDOWS_UTC,
    offPeakRatio: 0.5,
    weekendOffPeak: { since: "2026-08-23", utcOffsetHours: 8 },
  },
]

export function planForProvider(
  providerID: string | undefined,
  plans: PricingPlan[] = DEFAULT_PRICING_PLANS,
): PricingPlan | undefined {
  if (!providerID) return undefined
  const id = providerID.toLowerCase()
  return plans.find(p => p.providerID.toLowerCase() === id && p.timeOfDay)
}

export function windowsForPlan(
  plan: PricingPlan | undefined,
): PeakWindow[] {
  return plan?.peakWindowsUtc ?? PEAK_WINDOWS_UTC
}

export function ratioForPlan(plan: PricingPlan | undefined): number {
  return plan?.offPeakRatio ?? 0.5
}

/** Convert a UTC timestamp to wall-clock date/day-of-week in a fixed UTC offset. */
function dateInOffset(d: Date, offsetHours: number): { isoDate: string; day: number } {
  const shifted = new Date(d.getTime() + offsetHours * 3_600_000)
  return { isoDate: shifted.toISOString().slice(0, 10), day: shifted.getUTCDay() }
}

export function isWeekendOffPeak(
  d: Date,
  policy: { since: string; utcOffsetHours: number } | undefined,
): boolean {
  if (!policy) return false
  const { isoDate, day } = dateInOffset(d, policy.utcOffsetHours)
  if (isoDate < policy.since) return false
  return day === 0 || day === 6 // Sunday or Saturday in policy timezone
}

/** Peak windows that apply at instant `d`, honoring any weekend-off-peak policy. */
export function effectivePeakWindows(d: Date, plan: PricingPlan | undefined): PeakWindow[] {
  if (!plan) return PEAK_WINDOWS_UTC
  if (isWeekendOffPeak(d, plan.weekendOffPeak)) return []
  return plan.peakWindowsUtc ?? PEAK_WINDOWS_UTC
}

const DEFAULT_SKILL_NAMES = [
  "integrate-topic",
  "review-convergence",
  "full-document-review",
  "synthesize-document",
  "formalization-pipeline",
  "medication-differential-analysis",
  "svg-illustration-pipeline",
  "tikz-illustration-pipeline",
  "split-chapter",
  "pipeline-governor",
]

const DEFAULT_LONG_RUNNING = [
  "batch",
  "overnight",
  "multi-file",
  "all chapters",
  "agent fan-out",
  "fan-out",
  "escalate",
]

const STEP_ENUMERATORS = [
  /\bphase[s]?\b\s+\d+/gi,
  /\bstep[s]?\b\s+\d+/gi,
  /\bpipeline\b/gi,
  /(?:^|\n)\s*\d+\.\s/g,
]

export function isPeakUtc(utcHour: number, windows: PeakWindow[] = PEAK_WINDOWS_UTC): boolean {
  return windows.some(([start, end]) => utcHour >= start && utcHour < end)
}

function pad(n: number): string {
  return String(n).padStart(2, "0")
}

function isoOffsetMs(d: Date): number {
  const asUtc = new Date(
    d.getUTCFullYear(),
    d.getUTCMonth(),
    d.getUTCDate(),
    d.getUTCHours(),
    d.getUTCMinutes(),
    d.getUTCSeconds(),
  )
  return d.getTime() - asUtc.getTime()
}

export function utcHourOf(d: Date): number {
  return d.getUTCHours()
}

export function localOffsetHours(d: Date): number {
  return Math.round(isoOffsetMs(d) / 3_600_000)
}

/** Pure window-shift math, testable with an explicit offset in hours. */
export function shiftWindow(
  [s, e]: PeakWindow,
  offsetHours: number,
): PeakWindow[] {
  const ls = (s + offsetHours + 24) % 24
  const le = (e + offsetHours + 24) % 24
  return le === ls ? [[ls, 24]] : le > ls ? [[ls, le]] : [[ls, 24], [0, le]]
}

/** Peak windows expressed in local wall-clock hours for the given instant. */
export function localPeakWindows(d: Date, windows: PeakWindow[] = PEAK_WINDOWS_UTC): PeakWindow[] {
  const off = localOffsetHours(d)
  return windows.flatMap(w => shiftWindow(w, off))
}

/** Complement of peak in local hours (the off-peak bands). */
export function localOffpeakWindows(d: Date, windows: PeakWindow[] = PEAK_WINDOWS_UTC): PeakWindow[] {
  const peak = localPeakWindows(d, windows)
  const covered = new Set<number>()
  for (const [s, e] of peak) {
    for (let h = s; h < e; h++) covered.add(h % 24)
  }
  const off: PeakWindow[] = []
  let i = 0
  while (i < 24) {
    if (!covered.has(i)) {
      const start = i
      while (i < 24 && !covered.has(i)) i++
      off.push([start, i])
    } else {
      i++
    }
  }
  return off
}

function fmtRange(win: PeakWindow): string {
  const [s, e] = win
  if (e === 24) return `${pad(s)}:00–00:00`
  return `${pad(s)}:00–${pad(e)}:00`
}

export function formatWindows(windows: PeakWindow[]): string {
  return windows.map(fmtRange).join(" & ")
}

export function countExplicitSteps(text: string): number {
  let count = 0
  for (const re of STEP_ENUMERATORS) {
    const matches = text.match(re)
    if (matches) count += matches.length
  }
  return count
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

export function hasSkillReference(text: string, skillNames: string[] = DEFAULT_SKILL_NAMES): boolean {
  return skillNames.some(name =>
    new RegExp(`(?:^|[^\\w-])${escapeRegExp(name)}(?:$|[^\\w-])`, "i").test(text),
  )
}

export function hasLongRunningMarker(text: string, keywords: string[] = DEFAULT_LONG_RUNNING): boolean {
  const lower = text.toLowerCase()
  return keywords.some(k => lower.includes(k.toLowerCase()))
}

export function isHeavyPrompt(
  text: string,
  opts: HeavyOptions = {},
): { heavy: boolean; reasons: string[] } {
  const reasons: string[] = []
  const skills = opts.skillNames ?? DEFAULT_SKILL_NAMES
  const threshold = opts.stepThreshold ?? 2
  const lr = opts.longRunningKeywords ?? DEFAULT_LONG_RUNNING

  if (hasSkillReference(text, skills)) reasons.push("skill-reference")
  const steps = countExplicitSteps(text)
  if (steps >= threshold) reasons.push(`steps:${steps}>=${threshold}`)
  if (hasLongRunningMarker(text, lr)) reasons.push("long-running")

  return { heavy: reasons.length > 0, reasons }
}

export function peakWindowIndex(d: Date, windows: PeakWindow[] = PEAK_WINDOWS_UTC): number {
  const h = utcHourOf(d)
  const idx = windows.findIndex(([s, e]) => h >= s && h < e)
  return idx
}

export function resolveStatePath(): string | null {
  const override = process.env.OFFPEAK_NUDGE_STATE_FILE
  if (override) return override
  const runtime = process.env.XDG_RUNTIME_DIR
  if (runtime) return path.join(runtime, STATE_FILE_NAME)
  const cache = os.tmpdir()
  return path.join(cache, STATE_FILE_NAME)
}

export type TokenBucket = {
  input: number
  output: number
  cacheRead: number
}

export type CostBucket = { peak: number; offpeak: number }

export type SessionLedger = {
  windowIndex: number
  ts: string
  /** User opted out of nudges/toasts for this session. */
  quiet?: boolean
  cost?: CostBucket
  tokens?: { peak: TokenBucket; offpeak: TokenBucket }
  /** A heavy task the user asked to postpone to a cheaper window. */
  scheduled?: { task: string; scheduledAt: string; forWindow: "peak" | "offpeak" }
}

export type NudgeState = Record<string, SessionLedger>

export function readState(statePath?: string): NudgeState {
  const p = statePath ?? resolveStatePath()
  if (!p) return {}
  try {
    const raw = fs.readFileSync(p, "utf-8")
    const parsed = JSON.parse(raw)
    return typeof parsed === "object" && parsed !== null ? (parsed as NudgeState) : {}
  } catch {
    return {}
  }
}

export function writeState(state: NudgeState, statePath?: string): void {
  const p = statePath ?? resolveStatePath()
  if (!p) return
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, JSON.stringify(state, null, 2))
  } catch {
    // never break plugin behavior on state write failure
  }
}

export function shouldRemind(
  sessionID: string,
  now: Date,
  statePath?: string,
  windows: PeakWindow[] = PEAK_WINDOWS_UTC,
): boolean {
  const idx = peakWindowIndex(now, windows)
  if (idx < 0) return false
  const state = readState(statePath)
  const last = state[sessionID]
  if (last && last.windowIndex === idx) return false
  state[sessionID] = { windowIndex: idx, ts: now.toISOString() }
  writeState(state, statePath)
  return true
}

export function isQuiet(sessionID: string, statePath?: string): boolean {
  return readState(statePath)[sessionID]?.quiet === true
}

export function setQuiet(sessionID: string, quiet: boolean, statePath?: string): void {
  const state = readState(statePath)
  state[sessionID] = { ...(state[sessionID] ?? { windowIndex: -1, ts: "" }), quiet }
  writeState(state, statePath)
}

export function setScheduled(
  sessionID: string,
  task: string,
  statePath?: string,
): void {
  const state = readState(statePath)
  state[sessionID] = {
    ...(state[sessionID] ?? { windowIndex: -1, ts: "" }),
    scheduled: { task, scheduledAt: new Date().toISOString(), forWindow: "offpeak" },
  }
  writeState(state, statePath)
}

/** Consume and return the pending scheduled task for a session, if any. */
export function takeScheduled(sessionID: string, statePath?: string): string | null {
  const state = readState(statePath)
  const ledger = state[sessionID]
  if (!ledger?.scheduled) return null
  const task = ledger.scheduled.task
  delete ledger.scheduled
  state[sessionID] = ledger
  writeState(state, statePath)
  return task
}

export function hasScheduled(sessionID: string, statePath?: string): boolean {
  return readState(statePath)[sessionID]?.scheduled != null
}

/** Return all scheduled task descriptions across sessions. */
export function allScheduled(statePath?: string): string[] {
  const state = readState(statePath)
  const out: string[] = []
  for (const ledger of Object.values(state)) {
    if (ledger.scheduled) out.push(ledger.scheduled.task)
  }
  return out
}

/**
 * Record real spend for an assistant message, attributed to peak/off-peak by
 * the timestamp of the completion. Returns a summary line if this message
 * updated the ledger, otherwise null.
 */
export function recordSpend(
  sessionID: string,
  now: Date,
  spend: { cost: number; tokens: { input: number; output: number; cacheRead: number } },
  statePath?: string,
  plan?: PricingPlan,
): string | null {
  const state = readState(statePath)
  const windows = effectivePeakWindows(now, plan)
  const ledger = state[sessionID] ?? { windowIndex: peakWindowIndex(now, windows), ts: now.toISOString() }
  const bucket = isPeakUtc(utcHourOf(now), windows) ? "peak" : "offpeak"

  const cost = ledger.cost ?? { peak: 0, offpeak: 0 }
  const tokens = ledger.tokens ?? {
    peak: { input: 0, output: 0, cacheRead: 0 },
    offpeak: { input: 0, output: 0, cacheRead: 0 },
  }

  cost[bucket] += spend.cost
  tokens[bucket].input += spend.tokens.input
  tokens[bucket].output += spend.tokens.output
  tokens[bucket].cacheRead += spend.tokens.cacheRead

  ledger.cost = cost
  ledger.tokens = tokens
  state[sessionID] = ledger
  writeState(state, statePath)

  return summarizeSpend(sessionID, now, statePath)
}

export function summarizeSpend(
  sessionID: string,
  now: Date,
  statePath?: string,
): string | null {
  const ledger = readState(statePath)[sessionID]
  if (!ledger || !ledger.cost) return null
  const { peak, offpeak } = ledger.cost
  const total = peak + offpeak
  if (total <= 0) return null
  const fmt = (n: number) => `$${n.toFixed(4)}`
  return `spend so far this session — during peak hours ${fmt(peak)} / during off-peak hours ${fmt(offpeak)} / total ${fmt(total)}`
}

function padToWidth(s: string, width: number): string {
  return s.padEnd(width)
}

export type PricingStatus = "peak" | "offpeak"

export function pricingStatus(now: Date, windows: PeakWindow[] = PEAK_WINDOWS_UTC): PricingStatus {
  return isPeakUtc(utcHourOf(now), windows) ? "peak" : "offpeak"
}

export function buildStatusToast(
  now: Date,
  opts: {
    windows?: PeakWindow[]
    provider?: string
    offPeakRatio?: number
  } = {},
): { title: string; message: string; variant: "info" | "warning" } {
  const windows = opts.windows ?? PEAK_WINDOWS_UTC
  const provider = opts.provider ?? "DeepSeek"
  const ratio = opts.offPeakRatio ?? 0.5
  const status = pricingStatus(now, windows)
  const neutral = provider === ""
  if (status === "peak") {
    const off = formatWindows(localOffpeakWindows(now, windows))
    return {
      title: neutral ? "Peak pricing" : `${provider} peak`,
      message: neutral
        ? `Currently PEAK — off-peak is ${pctOff(ratio)} cheaper (off-peak: ${off}).`
        : `Currently ${provider} PEAK — off-peak is ${pctOff(ratio)} cheaper (off-peak: ${off}).`,
      variant: "warning",
    }
  }
  const peak = formatWindows(localPeakWindows(now, windows))
  return {
    title: neutral ? "Off-peak pricing" : `${provider} off-peak`,
    message: neutral
      ? `Currently off-peak — ${pctOff(ratio)} cheaper than peak. Peak resumes at ${peak}.`
      : `Currently ${provider} off-peak — ${pctOff(ratio)} cheaper than peak. Peak resumes at ${peak}.`,
    variant: "info",
  }
}

function pctOff(ratio: number): string {
  return `${Math.round((1 - ratio) * 100)}%`
}

export function buildBanner(
  now: Date,
  windows: PeakWindow[] = PEAK_WINDOWS_UTC,
  provider = "DeepSeek",
  offPeakRatio = 0.5,
): string {
  const off = formatWindows(localOffpeakWindows(now, windows))
  const lines = [
    `⚠ ${provider} PEAK PRICING — off-peak is ${pctOff(offPeakRatio)} cheaper`,
    `off-peak hours (local): ${off}`,
    `current time is PEAK; postpone heavy work if not urgent`,
  ]
  const width = Math.max(...lines.map(l => l.length))
  const rule = "─".repeat(width + 2)
  const body = lines.map(l => `│ ${padToWidth(l, width)} │`).join("\n")
  return [`╭${rule}╮`, body, `╰${rule}╯`].join("\n")
}
