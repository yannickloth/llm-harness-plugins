import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import os from "os"
import fs from "fs"
import path from "path"
import {
  isPeakUtc,
  localPeakWindows,
  localOffpeakWindows,
  formatWindows,
  shiftWindow,
  isHeavyPrompt,
  shouldRemind,
  readState,
  resolveStatePath,
  PEAK_WINDOWS_UTC,
  NUDGE_MARKER,
  buildBanner,
  buildStatusToast,
  pricingStatus,
  recordSpend,
  summarizeSpend,
  setScheduled,
  takeScheduled,
  hasScheduled,
  allScheduled,
  planForProvider,
  windowsForPlan,
  ratioForPlan,
  isWeekendOffPeak,
  effectivePeakWindows,
  type PricingPlan,
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

describe("offpeak-nudge weekend policy", () => {
  const BEIJING_WEEKEND: PricingPlan = {
    providerID: "deepseek",
    timeOfDay: true,
    peakWindowsUtc: PEAK_WINDOWS_UTC,
    offPeakRatio: 0.5,
    weekendOffPeak: { since: "2026-08-23", utcOffsetHours: 8 },
  }

  test("isWeekendOffPeak uses policy timezone day-of-week", () => {
    // 2026-08-22 15:59 UTC = Sat 07:59 Brussels = Sat 23:59 Beijing -> before effective.
    expect(isWeekendOffPeak(new Date("2026-08-22T15:59:59Z"), BEIJING_WEEKEND.weekendOffPeak)).toBe(false)
    // 2026-08-22 16:00 UTC = Sat 18:00 Brussels = Sun 00:00 Beijing -> weekend active.
    expect(isWeekendOffPeak(new Date("2026-08-22T16:00:00Z"), BEIJING_WEEKEND.weekendOffPeak)).toBe(true)
    // 2026-08-24 08:00 UTC = Mon 10:00 Brussels = Mon 16:00 Beijing -> weekday.
    expect(isWeekendOffPeak(new Date("2026-08-24T08:00:00Z"), BEIJING_WEEKEND.weekendOffPeak)).toBe(false)
  })

  test("effectivePeakWindows is empty on weekend after effective date", () => {
    // Sunday Aug 23 in Beijing; 08:00 UTC is normally inside peak window [6,10).
    expect(effectivePeakWindows(new Date("2026-08-23T08:00:00Z"), BEIJING_WEEKEND)).toEqual([])
    // Same instant on a weekday after the policy start remains peak.
    expect(effectivePeakWindows(new Date("2026-08-25T08:00:00Z"), BEIJING_WEEKEND)).toEqual(PEAK_WINDOWS_UTC)
  })

  test("peak_price_status reports off-peak during Beijing weekend even in normal peak window", async () => {
    const mod = await import(`./index.ts?${Date.now()}`)
    const hooks = await mod.default(
      {
        directory: REPO_ROOT,
        worktree: REPO_ROOT,
        client: { app: { log: async () => {} }, tui: { showToast: async () => {} } },
      },
      { now: () => new Date("2026-08-23T08:00:00Z") },
    )
    const result = JSON.parse(
      await hooks["tool"]["peak_price_status"].execute({}, { sessionID: "s", messageID: "m", agent: "default", directory: REPO_ROOT, worktree: REPO_ROOT, abort: new AbortController().signal, metadata: () => {}, ask: async () => {} }),
    )
    expect(result.status).toBe("offpeak")
    expect(result.peakHoursLocal).toBe("")
    expect(result.offPeakHoursLocal).toBe("00:00–00:00")
  })

  test("chat.message does not banner during Beijing weekend", async () => {
    const mod = await import(`./index.ts?${Date.now()}`)
    const hooks = await mod.default(
      {
        directory: REPO_ROOT,
        worktree: REPO_ROOT,
        client: { app: { log: async () => {} }, tui: { showToast: async () => {} } },
      },
      { now: () => new Date("2026-08-23T08:00:00Z") },
    )
    const out = { parts: [{ type: "text", text: "Run a full-document-review on the entire repo" }] }
    await hooks["chat.message"](
      { sessionID: "s-weekend", model: { providerID: "deepseek" } },
      out,
    )
    expect(out.parts[0].text).not.toContain("PEAK PRICING")
  })

  test("recordSpend attributes weekend peak-window usage as off-peak under Beijing policy", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "offpeak-weekend-"))
    const stateFile = path.join(stateDir, "state.json")
    recordSpend("s-weekend", new Date("2026-08-23T08:00:00Z"), { cost: 0.03, tokens: { input: 1000, output: 500, cacheRead: 0 } }, stateFile, BEIJING_WEEKEND)
    const state = readState(stateFile)
    expect(state["s-weekend"].cost?.peak).toBeCloseTo(0)
    expect(state["s-weekend"].cost?.offpeak).toBeCloseTo(0.03)
    fs.rmSync(stateDir, { recursive: true, force: true })
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

  test("pricingStatus reports peak vs off-peak", () => {
    expect(pricingStatus(new Date("2026-08-13T02:00:00Z"))).toBe("peak")
    expect(pricingStatus(new Date("2026-08-13T12:00:00Z"))).toBe("offpeak")
  })

  test("buildStatusToast peak is warning with off-peak hours", () => {
    process.env.TZ = "Europe/Brussels"
    const t = buildStatusToast(new Date("2026-08-13T02:00:00Z"))
    expect(t.variant).toBe("warning")
    expect(t.title).toBe("DeepSeek peak")
    expect(t.message).toContain("PEAK")
    expect(t.message).toContain("off-peak")
  })

  test("buildStatusToast off-peak is info with next peak hours", () => {
    process.env.TZ = "Europe/Brussels"
    const t = buildStatusToast(new Date("2026-08-13T12:00:00Z"))
    expect(t.variant).toBe("info")
    expect(t.title).toBe("DeepSeek off-peak")
    expect(t.message).toContain("off-peak")
    expect(t.message).toContain("Peak resumes")
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
    expect(hooks["event"]).toBeDefined()
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

  test("event shows a status toast on session.created", async () => {
    const shown: unknown[] = []
    const mod = await import(`./index.ts?${Date.now()}`)
    const hooks = await mod.default(
      {
        directory: REPO_ROOT,
        worktree: REPO_ROOT,
        client: {
          app: { log: async () => {} },
          tui: { showToast: async (arg: unknown) => shown.push(arg) },
        },
      },
      {
        now: () => new Date("2026-08-13T02:00:00Z"),
      },
    )
    await hooks["event"]({ event: { type: "session.created" } })
    expect(shown.length).toBe(1)
    const toast = shown[0] as { body: { title: string; variant: string } }
    expect(toast.body.variant).toBe("warning")
    // non-session.created events do not trigger a toast
    await hooks["event"]({ event: { type: "session.idle" } })
    expect(shown.length).toBe(1)
  })

  test("event shows a status toast on server.connected", async () => {
    const shown: unknown[] = []
    const mod = await import(`./index.ts?${Date.now()}`)
    const hooks = await mod.default(
      {
        directory: REPO_ROOT,
        worktree: REPO_ROOT,
        client: {
          app: { log: async () => {} },
          tui: { showToast: async (arg: unknown) => shown.push(arg) },
        },
      },
      {
        now: () => new Date("2026-08-13T12:00:00Z"),
      },
    )
    await hooks["event"]({ event: { type: "server.connected" } })
    expect(shown.length).toBe(1)
    const toast = shown[0] as { body: { variant: string; title: string } }
    expect(toast.body.title).toBe("Off-peak pricing")
    expect(toast.body.variant).toBe("info")
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

  test("chat.message shows a visible toast during peak for heavy prompt", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "offpeak-hook-"))
    const stateFile = path.join(stateDir, "state.json")
    const shown: unknown[] = []
    const mod = await import(`./index.ts?${Date.now()}`)
    const hooks = await mod.default(
      {
        directory: REPO_ROOT,
        worktree: REPO_ROOT,
        client: {
          app: { log: async () => {} },
          tui: { showToast: async (arg: unknown) => shown.push(arg) },
        },
      },
      {
        now: () => new Date("2026-08-13T02:00:00Z"),
        statePath: stateFile,
      },
    )
    const output = { parts: [{ type: "text", text: "run integrate-topic for biofabrication" }] }
    await hooks["chat.message"]({ sessionID: "s-toast" }, output)
    expect(shown.length).toBe(1)
    const toast = shown[0] as { body: { title: string; variant: string; message: string } }
    expect(toast.body.title).toBe("DeepSeek peak")
    expect(toast.body.variant).toBe("warning")
    expect(toast.body.message).toContain("off-peak")
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

  test("non-time-of-day provider gets no banner during peak", async () => {    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "offpeak-hook-"))
    const stateFile = path.join(stateDir, "state.json")
    const mod = await import(`./index.ts?${Date.now()}`)
    const hooks = await mod.default(
      {
        directory: REPO_ROOT,
        worktree: REPO_ROOT,
        client: { app: { log: async () => {} }, tui: { showToast: async () => {} } },
      },
      {
        now: () => new Date("2026-08-13T02:00:00Z"),
        statePath: stateFile,
        plans: [{ providerID: "other", timeOfDay: false }],
      },
    )
    const output = { parts: [{ type: "text", text: "run integrate-topic for biofabrication" }] }
    await hooks["chat.message"](
      { sessionID: "s-other", model: { providerID: "other" } },
      output,
    )
    expect(output.parts[0].text).toBe("run integrate-topic for biofabrication")
    fs.rmSync(stateDir, { recursive: true, force: true })
  })

  test("system.transform skips injection for providers without a time-of-day plan", async () => {
    const hooks = await loadHooks({
      plans: [{ providerID: "deepseek", timeOfDay: true }, { providerID: "other", timeOfDay: false }],
    })
    const output = { system: ["base"] }
    await hooks["experimental.chat.system.transform"]({ model: { providerID: "other" } }, output)
    expect(output.system.length).toBe(1)
  })

  test("off-peak: heavy prompt is left untouched (run unconditionally)", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "offpeak-hook-"))
    const stateFile = path.join(stateDir, "state.json")
    const hooks = await loadHooks({ now: () => new Date("2026-08-13T12:00:00Z"), statePath: stateFile })
    const out = { parts: [{ type: "text", text: "run integrate-topic for biofabrication" }] }
    await hooks["chat.message"]({ sessionID: "s-off" }, out)
    expect(out.parts[0].text).toBe("run integrate-topic for biofabrication")
    fs.rmSync(stateDir, { recursive: true, force: true })
  })

  test("peak: heavy prompt is rewritten to require confirmation (do not run by default)", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "offpeak-hook-"))
    const stateFile = path.join(stateDir, "state.json")
    const hooks = await loadHooks({ now: () => new Date("2026-08-13T02:00:00Z"), statePath: stateFile })
    const out = { parts: [{ type: "text", text: "run integrate-topic for biofabrication" }] }
    await hooks["chat.message"]({ sessionID: "s-confirm" }, out)
    expect(out.parts[0].text.startsWith("╭")).toBe(true)
    expect(out.parts[0].text).toContain("Do NOT run it")
    expect(out.parts[0].text).toContain("Ask for confirmation")
    expect(out.parts[0].text).toContain("run integrate-topic for biofabrication")
    fs.rmSync(stateDir, { recursive: true, force: true })
  })

  test("peak: light prompt is left untouched (no confirmation needed)", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "offpeak-hook-"))
    const stateFile = path.join(stateDir, "state.json")
    const hooks = await loadHooks({ now: () => new Date("2026-08-13T02:00:00Z"), statePath: stateFile })
    const out = { parts: [{ type: "text", text: "add a comma" }] }
    await hooks["chat.message"]({ sessionID: "s-light" }, out)
    expect(out.parts[0].text).toBe("add a comma")
    fs.rmSync(stateDir, { recursive: true, force: true })
  })

  test("registers peak_price_status tool returning deterministic status", async () => {
    const mod = await import(`./index.ts?${Date.now()}`)
    const hooks = await mod.default(
      {
        directory: REPO_ROOT,
        worktree: REPO_ROOT,
        client: { app: { log: async () => {} }, tui: { showToast: async () => {} } },
      },
      { now: () => new Date("2026-08-13T02:00:00Z") },
    )
    const def = hooks["tool"]["peak_price_status"]
    expect(def).toBeDefined()
    const result = await def.execute({}, { sessionID: "s", messageID: "m", agent: "default", directory: REPO_ROOT, worktree: REPO_ROOT, abort: new AbortController().signal, metadata: () => {}, ask: async () => {} })
    const parsed = JSON.parse(result as string)
    expect(parsed.status).toBe("peak")
    expect(parsed.provider).toBe("DeepSeek")
  })

  test("peak_price_status returns correct off-peak and peak hours in both states", async () => {
    const mkHooks = (now: Date) =>
      import(`./index.ts?${Date.now()}`).then(mod =>
        mod.default(
          {
            directory: REPO_ROOT,
            worktree: REPO_ROOT,
            client: { app: { log: async () => {} }, tui: { showToast: async () => {} } },
          },
          { now: () => now },
        ),
      )

    const peakTime = new Date("2026-08-13T02:00:00Z")
    const peakHooks = await mkHooks(peakTime)
    const peakResult = JSON.parse(
      await peakHooks["tool"]["peak_price_status"].execute({}, { sessionID: "s", messageID: "m", agent: "default", directory: REPO_ROOT, worktree: REPO_ROOT, abort: new AbortController().signal, metadata: () => {}, ask: async () => {} }),
    )
    expect(peakResult.status).toBe("peak")
    expect(peakResult.offPeakHoursLocal).toBe(formatWindows(localOffpeakWindows(peakTime, PEAK_WINDOWS_UTC)))
    expect(peakResult.peakHoursLocal).toBe(formatWindows(localPeakWindows(peakTime, PEAK_WINDOWS_UTC)))

    const offpeakTime = new Date("2026-08-13T12:00:00Z")
    const offpeakHooks = await mkHooks(offpeakTime)
    const offpeakResult = JSON.parse(
      await offpeakHooks["tool"]["peak_price_status"].execute({}, { sessionID: "s", messageID: "m", agent: "default", directory: REPO_ROOT, worktree: REPO_ROOT, abort: new AbortController().signal, metadata: () => {}, ask: async () => {} }),
    )
    expect(offpeakResult.status).toBe("offpeak")
    expect(offpeakResult.offPeakHoursLocal).toBe(formatWindows(localOffpeakWindows(offpeakTime, PEAK_WINDOWS_UTC)))
    expect(offpeakResult.peakHoursLocal).toBe(formatWindows(localPeakWindows(offpeakTime, PEAK_WINDOWS_UTC)))
  })
})

describe("offpeak-nudge cost tracking", () => {
  let stateDir: string
  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "offpeak-cost-"))
  })
  afterEach(() => {
    fs.rmSync(stateDir, { recursive: true, force: true })
  })

  test("recordSpend attributes peak vs off-peak", () => {
    const stateFile = path.join(stateDir, "state.json")
    recordSpend("s1", new Date("2026-08-13T02:00:00Z"), { cost: 0.02, tokens: { input: 1000, output: 500, cacheRead: 200 } }, stateFile)
    recordSpend("s1", new Date("2026-08-13T12:00:00Z"), { cost: 0.01, tokens: { input: 1000, output: 500, cacheRead: 0 } }, stateFile)
    const state = readState(stateFile)
    expect(state["s1"].cost?.peak).toBeCloseTo(0.02)
    expect(state["s1"].cost?.offpeak).toBeCloseTo(0.01)
    expect(state["s1"].tokens?.peak.input).toBe(1000)
    expect(state["s1"].tokens?.offpeak.output).toBe(500)
  })

  test("summarizeSpend reports spend during peak/off-peak hours", () => {
    const stateFile = path.join(stateDir, "state.json")
    recordSpend("s1", new Date("2026-08-13T02:00:00Z"), { cost: 0.02, tokens: { input: 1000, output: 500, cacheRead: 200 } }, stateFile)
    const summary = summarizeSpend("s1", new Date("2026-08-13T12:00:00Z"), stateFile)
    expect(summary).toContain("during peak hours $0.0200")
    expect(summary).toContain("during off-peak hours $0.0000")
    expect(summary).not.toContain("would cost")
  })

  test("event message.updated records spend for assistant messages", async () => {
    const stateFile = path.join(stateDir, "state.json")
    const mod = await import(`./index.ts?${Date.now()}`)
    const hooks = await mod.default(
      {
        directory: REPO_ROOT,
        worktree: REPO_ROOT,
        client: { app: { log: async () => {} }, tui: { showToast: async () => {} } },
      },
      { now: () => new Date("2026-08-13T02:00:00Z"), statePath: stateFile },
    )
    await hooks["event"]({
      event: {
        type: "message.updated",
        properties: {
          info: {
            role: "assistant",
            sessionID: "s-ledger",
            cost: 0.05,
            tokens: { input: 2000, output: 800, cache: { read: 100 } },
          },
        },
      },
    })
    const state = readState(stateFile)
    expect(state["s-ledger"].cost?.peak).toBeCloseTo(0.05)
  })

  test("message.updated double-emit for the same message is counted once", async () => {
    const stateFile = path.join(stateDir, "state.json")
    const mod = await import(`./index.ts?${Date.now()}`)
    const hooks = await mod.default(
      {
        directory: REPO_ROOT,
        worktree: REPO_ROOT,
        client: { app: { log: async () => {} }, tui: { showToast: async () => {} } },
      },
      { now: () => new Date("2026-08-13T02:00:00Z"), statePath: stateFile },
    )
    const ev = {
      event: {
        type: "message.updated",
        properties: {
          info: {
            id: "msg-42",
            role: "assistant",
            sessionID: "s-dedup",
            cost: 0.05,
            tokens: { input: 2000, output: 800, cache: { read: 100 } },
          },
        },
      },
    }
    await hooks["event"](ev)
    await hooks["event"](ev)
    const state = readState(stateFile)
    expect(state["s-dedup"].cost?.peak).toBeCloseTo(0.05)
  })

  test("session.idle shows cost summary toast", async () => {
    const stateFile = path.join(stateDir, "state.json")
    const shown: unknown[] = []
    const mod = await import(`./index.ts?${Date.now()}`)
    const hooks = await mod.default(
      {
        directory: REPO_ROOT,
        worktree: REPO_ROOT,
        client: {
          app: { log: async () => {} },
          tui: { showToast: async (arg: unknown) => shown.push(arg) },
        },
      },
      { now: () => new Date("2026-08-13T12:00:00Z"), statePath: stateFile },
    )
    recordSpend("s-sum", new Date("2026-08-13T02:00:00Z"), { cost: 0.04, tokens: { input: 1000, output: 500, cacheRead: 0 } }, stateFile)
    await hooks["event"]({
      event: { type: "session.idle", properties: { sessionID: "s-sum" } },
    })
    expect(shown.length).toBe(1)
    const toast = shown[0] as { body: { title: string; message: string } }
    expect(toast.body.title).toBe("Cost summary")
    expect(toast.body.message).toContain("peak")
  })
})

describe("offpeak-nudge provider plans", () => {
  test("planForProvider matches case-insensitively", () => {
    expect(planForProvider("DEEPSEEK")?.timeOfDay).toBe(true)
    expect(planForProvider("deepseek")?.providerID).toBe("deepseek")
  })

  test("unknown provider has no plan", () => {
    expect(planForProvider("mystery")).toBeUndefined()
  })

  test("windowsForPlan and ratioForPlan honor the plan", () => {
    const plan: PricingPlan = {
      providerID: "x",
      timeOfDay: true,
      peakWindowsUtc: [[2, 5]],
      offPeakRatio: 0.25,
    }
    expect(windowsForPlan(plan)).toEqual([[2, 5]])
    expect(ratioForPlan(plan)).toBe(0.25)
  })

  test("buildStatusToast uses plan ratio and provider label", () => {
    const t = buildStatusToast(new Date("2026-08-13T02:00:00Z"), {
      windows: [[2, 5]],
      provider: "Foo",
      offPeakRatio: 0.25,
    })
    expect(t.title).toBe("Foo peak")
    expect(t.message).toContain("75%")
  })
})

describe("offpeak-nudge scheduling", () => {
  let stateDir: string
  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "offpeak-sched-"))
  })
  afterEach(() => {
    fs.rmSync(stateDir, { recursive: true, force: true })
  })

  test("setScheduled/takeScheduled round-trips and consumes", () => {
    const stateFile = path.join(stateDir, "state.json")
    setScheduled("s1", "run the full review", stateFile)
    expect(hasScheduled("s1", stateFile)).toBe(true)
    expect(takeScheduled("s1", stateFile)).toBe("run the full review")
    expect(hasScheduled("s1", stateFile)).toBe(false)
  })

  test("allScheduled lists tasks across sessions", () => {
    const stateFile = path.join(stateDir, "state.json")
    setScheduled("s1", "task A", stateFile)
    setScheduled("s2", "task B", stateFile)
    const tasks = allScheduled(stateFile)
    expect(tasks).toContain("task A")
    expect(tasks).toContain("task B")
  })
})
