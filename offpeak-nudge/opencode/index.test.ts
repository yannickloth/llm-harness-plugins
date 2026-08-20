import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import os from "os"
import fs from "fs"
import path from "path"
import {
  isPeakUtc,
  localPeakWindows,
  localOffpeakWindows,
  shiftWindow,
  isHeavyPrompt,
  shouldRemind,
  readState,
  resolveStatePath,
  PEAK_WINDOWS_UTC,
  NUDGE_MARKER,
  buildBanner,
} from "./helpers"

const REPO_ROOT = path.join(import.meta.dir, "..", "..")

describe("offpeak-nudge window math", () => {
  test("peak windows UTC boundaries", () => {
    expect(isPeakUtc(0)).toBe(false)
    expect(isPeakUtc(1)).toBe(true)
    expect(isPeakUtc(3)).toBe(true)
    expect(isPeakUtc(4)).toBe(false)
    expect(isPeakUtc(5)).toBe(false)
    expect(isPeakUtc(6)).toBe(true)
    expect(isPeakUtc(9)).toBe(true)
    expect(isPeakUtc(10)).toBe(false)
    expect(isPeakUtc(12)).toBe(false)
    expect(isPeakUtc(23)).toBe(false)
  })

  test("localPeakWindows converts UTC windows by offset (CEST +2)", () => {
    process.env.TZ = "Europe/Brussels"
    // Europe/Brussels summer (CEST) = UTC+2.
    const d = new Date("2026-08-13T00:00:00Z")
    const local = localPeakWindows(d, PEAK_WINDOWS_UTC)
    expect(local).toEqual([
      [3, 6],
      [8, 12],
    ])
  })

  test("localOffpeakWindows is complement of peak (CEST)", () => {
    process.env.TZ = "Europe/Brussels"
    const d = new Date("2026-08-13T00:00:00Z")
    const off = localOffpeakWindows(d, PEAK_WINDOWS_UTC)
    // Peak local: 03-06 and 08-12 -> off-peak: 00-03, 06-08, 12-24.
    expect(off).toEqual([
      [0, 3],
      [6, 8],
      [12, 24],
    ])
  })

  test("shiftWindow handles midnight wrap for positive offset", () => {
    // UTC peak 01-04 shifted +8 -> local 09-12; 06-10 -> 14-18. No wrap.
    expect(shiftWindow([1, 4], 8)).toEqual([[9, 12]])
    expect(shiftWindow([6, 10], 8)).toEqual([[14, 18]])
    // UTC peak 22-02 shifted +4 -> local 02-06 (wraps past midnight).
    expect(shiftWindow([22, 2], 4)).toEqual([[2, 6]])
  })
})

describe("offpeak-nudge heavy detection", () => {
  test("skill reference marks heavy (integrate-topic)", () => {
    const { heavy, reasons } = isHeavyPrompt("Run integrate-topic for biofabrication", {})
    expect(heavy).toBe(true)
    expect(reasons).toContain("skill-reference")
  })

  test("skill reference matches embedded in path", () => {
    const { heavy } = isHeavyPrompt("use the ./integrate-topic skill now", {})
    expect(heavy).toBe(true)
  })

  test("step threshold triggers heavy at default 2", () => {
    const { heavy, reasons } = isHeavyPrompt("first run phase 1 then phase 2", {})
    expect(heavy).toBe(true)
    expect(reasons.some(r => r.startsWith("steps:"))).toBe(true)
  })

  test("below step threshold is not heavy", () => {
    const { heavy } = isHeavyPrompt("add a comma to line 3", {})
    expect(heavy).toBe(false)
  })

  test("stepThreshold option can raise the bar", () => {
    const { heavy } = isHeavyPrompt("step 1 then step 2", { stepThreshold: 3 })
    expect(heavy).toBe(false)
  })

  test("long-running marker marks heavy", () => {
    const { heavy, reasons } = isHeavyPrompt("process all chapters in a batch overnight", {})
    expect(heavy).toBe(true)
    expect(reasons).toContain("long-running")
  })

  test("empty/trivial prompt not heavy", () => {
    expect(isHeavyPrompt("ok").heavy).toBe(false)
  })
})

describe("offpeak-nudge dedup state", () => {
  let stateDir: string

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "offpeak-nudge-test-"))
  })

  afterEach(() => {
    fs.rmSync(stateDir, { recursive: true, force: true })
  })

  function atUtc(iso: string): Date {
    return new Date(iso)
  }

  test("shouldRemind true once per session per peak window", () => {
    const stateFile = path.join(stateDir, "state.json")
    const peak1 = atUtc("2026-08-13T02:00:00Z") // UTC 02 -> window 0
    expect(shouldRemind("s1", peak1, stateFile)).toBe(true)
    expect(shouldRemind("s1", atUtc("2026-08-13T03:30:00Z"), stateFile)).toBe(false)
  })

  test("new peak window resets reminder", () => {
    const stateFile = path.join(stateDir, "state.json")
    expect(shouldRemind("s1", atUtc("2026-08-13T02:00:00Z"), stateFile)).toBe(true)
    expect(shouldRemind("s1", atUtc("2026-08-13T07:00:00Z"), stateFile)).toBe(true)
  })

  test("off-peak never reminds", () => {
    const stateFile = path.join(stateDir, "state.json")
    expect(shouldRemind("s1", atUtc("2026-08-13T12:00:00Z"), stateFile)).toBe(false)
    expect(shouldRemind("s1", atUtc("2026-08-13T23:00:00Z"), stateFile)).toBe(false)
  })

  test("state persists across reads (reload simulation)", () => {
    const stateFile = path.join(stateDir, "state.json")
    expect(shouldRemind("s2", atUtc("2026-08-13T02:00:00Z"), stateFile)).toBe(true)
    // Reload: readState sees the file written by shouldRemind.
    const state = readState(stateFile)
    expect(state["s2"]).toBeDefined()
    expect(state["s2"].windowIndex).toBe(0)
  })

  test("resolveStatePath respects override env", () => {
    const prev = process.env.OFFPEAK_NUDGE_STATE_FILE
    const p = path.join(stateDir, "override.json")
    process.env.OFFPEAK_NUDGE_STATE_FILE = p
    try {
      expect(resolveStatePath()).toBe(p)
    } finally {
      if (prev === undefined) delete process.env.OFFPEAK_NUDGE_STATE_FILE
      else process.env.OFFPEAK_NUDGE_STATE_FILE = prev
    }
  })
})

describe("offpeak-nudge banner", () => {
  test("banner is well-visible and carries header + off-peak line", () => {
    process.env.TZ = "Europe/Brussels"
    const d = new Date("2026-08-13T02:00:00Z")
    const banner = buildBanner(d)
    expect(banner.startsWith("╭")).toBe(true)
    expect(banner.endsWith("╯")).toBe(true)
    expect(banner).toContain("PEAK PRICING")
    expect(banner).toContain("off-peak")
    expect(banner).toMatch(/\d{2}:00–\d{2}:00/)
  })

  test("banner lines are aligned to the box width", () => {
    const d = new Date("2026-08-13T02:00:00Z")
    const lines = buildBanner(d).split("\n")
    const width = lines[0].length
    for (const l of lines) expect(l.length).toBe(width)
  })
})

describe("offpeak-nudge plugin hooks", () => {
  async function loadHooks(opts: Record<string, unknown> = {}) {
    const mod = await import(`./index.ts?${Date.now()}`)
    return mod.default({ directory: REPO_ROOT, worktree: REPO_ROOT }, opts)
  }

  test("registers both hooks", async () => {
    const hooks = await loadHooks()
    expect(hooks["chat.message"]).toBeDefined()
    expect(hooks["experimental.chat.system.transform"]).toBeDefined()
  })

  test("system.transform injects rule once, dedups on repeat", async () => {
    const hooks = await loadHooks()
    const output = { system: ["base"] }
    await hooks["experimental.chat.system.transform"]({}, output)
    expect(output.system[0]).toContain(NUDGE_MARKER)
    expect(output.system.length).toBe(2)
    await hooks["experimental.chat.system.transform"]({}, output)
    expect(output.system.length).toBe(2)
  })

  test("chat.message prepends banner to heavy prompt during peak", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "offpeak-hook-"))
    const stateFile = path.join(stateDir, "state.json")
    // 02:00 UTC is inside peak window 0 (01:00–04:00).
    const hooks = await loadHooks({
      now: () => new Date("2026-08-13T02:00:00Z"),
      statePath: stateFile,
    })
    const output = { parts: [{ type: "text", text: "run integrate-topic for biofabrication" }] }
    await hooks["chat.message"]({ sessionID: "s-deterministic" }, output)
    expect(output.parts[0].text.startsWith("╭")).toBe(true)
    expect(output.parts[0].text).toContain("run integrate-topic for biofabrication")
    fs.rmSync(stateDir, { recursive: true, force: true })
  })

  test("chat.message dedups within same peak window via state", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "offpeak-hook-"))
    const stateFile = path.join(stateDir, "state.json")
    const hooks = await loadHooks({
      now: () => new Date("2026-08-13T02:00:00Z"),
      statePath: stateFile,
    })
    const a = { parts: [{ type: "text", text: "run integrate-topic alpha" }] }
    const b = { parts: [{ type: "text", text: "run integrate-topic beta" }] }
    await hooks["chat.message"]({ sessionID: "s1" }, a)
    expect(a.parts[0].text.startsWith("╭")).toBe(true)
    await hooks["chat.message"]({ sessionID: "s1" }, b)
    expect(b.parts[0].text).toBe("run integrate-topic beta")
    fs.rmSync(stateDir, { recursive: true, force: true })
  })

  test("chat.message does not banner during off-peak", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "offpeak-hook-"))
    const stateFile = path.join(stateDir, "state.json")
    const hooks = await loadHooks({
      now: () => new Date("2026-08-13T12:00:00Z"),
      statePath: stateFile,
    })
    const output = { parts: [{ type: "text", text: "run integrate-topic now" }] }
    await hooks["chat.message"]({ sessionID: "s2" }, output)
    expect(output.parts[0].text).toBe("run integrate-topic now")
    fs.rmSync(stateDir, { recursive: true, force: true })
  })

  test("chat.message does not banner for light prompt during peak", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "offpeak-hook-"))
    const stateFile = path.join(stateDir, "state.json")
    const hooks = await loadHooks({
      now: () => new Date("2026-08-13T02:00:00Z"),
      statePath: stateFile,
    })
    const output = { parts: [{ type: "text", text: "add a comma" }] }
    await hooks["chat.message"]({ sessionID: "s3" }, output)
    expect(output.parts[0].text).toBe("add a comma")
    fs.rmSync(stateDir, { recursive: true, force: true })
  })

  test("disabled option suppresses injection", async () => {
    const hooks = await loadHooks({ disabled: true })
    const output = { parts: [{ type: "text", text: "run integrate-topic now" }] }
    await hooks["chat.message"]({ sessionID: "s" }, output)
    expect(output.parts[0].text).toBe("run integrate-topic now")
  })
})
