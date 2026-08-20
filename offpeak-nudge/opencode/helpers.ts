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

export type NudgeState = Record<string, { windowIndex: number; ts: string }>

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
): boolean {
  const idx = peakWindowIndex(now)
  if (idx < 0) return false
  const state = readState(statePath)
  const last = state[sessionID]
  if (last && last.windowIndex === idx) return false
  state[sessionID] = { windowIndex: idx, ts: now.toISOString() }
  writeState(state, statePath)
  return true
}

function padToWidth(s: string, width: number): string {
  return s.padEnd(width)
}

export function buildBanner(now: Date, windows: PeakWindow[] = PEAK_WINDOWS_UTC): string {
  const off = formatWindows(localOffpeakWindows(now, windows))
  const lines = [
    `⚠ PEAK PRICING — off-peak is 50% cheaper`,
    `off-peak hours (local): ${off}`,
    `current time is PEAK; postpone heavy work if not urgent`,
  ]
  const width = Math.max(...lines.map(l => l.length))
  const rule = "─".repeat(width + 2)
  const body = lines.map(l => `│ ${padToWidth(l, width)} │`).join("\n")
  return [`╭${rule}╮`, body, `╰${rule}╯`].join("\n")
}
