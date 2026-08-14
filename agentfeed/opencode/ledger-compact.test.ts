import { describe, test, expect } from "bun:test"
import { partitionForCompact } from "./ledger-compact"
import type { LedgerEntry } from "./ledger"

const NOW = Date.parse("2026-08-14T12:00:00Z")
const DAY = 24 * 60 * 60 * 1000

function entry(partial: Partial<LedgerEntry> & { id: string }): LedgerEntry {
  return {
    host: partial.id.split(":")[0],
    seq: parseInt(partial.id.split(":")[1], 10),
    agent: "a",
    type: "msg",
    ...partial,
  } as LedgerEntry
}

const mk = (id: string, ts: string, type: LedgerEntry["type"] = "msg", extra: Partial<LedgerEntry> = {}) =>
  entry({ id, ts, type, ...extra })

describe("partitionForCompact", () => {
  test("keeps fresh entries, archives old informational entries", () => {
    const entries = [
      mk("mbp:1", new Date(NOW - 10 * DAY).toISOString(), "msg", { text: "old" }),
      mk("mbp:2", new Date(NOW - 1 * DAY).toISOString(), "msg", { text: "recent" }),
    ]
    const { live, settled } = partitionForCompact(entries, NOW, 7 * DAY)
    expect(live.map((e) => e.id)).toEqual(["mbp:2"])
    expect(settled.map((e) => e.id)).toEqual(["mbp:1"])
  })

  test("always keeps an open claim with unexpired lease even if old", () => {
    const entries = [
      mk("mbp:1", new Date(NOW - 30 * DAY).toISOString(), "claim", {
        task: "t", status: "open", lease: new Date(NOW + DAY).toISOString(),
      }),
    ]
    const { live, settled } = partitionForCompact(entries, NOW, 7 * DAY)
    expect(live).toHaveLength(1)
    expect(settled).toHaveLength(0)
  })

  test("archives a released claim once old", () => {
    const entries = [
      mk("mbp:1", new Date(NOW - 30 * DAY).toISOString(), "claim", {
        task: "t", status: "open", lease: new Date(NOW - 20 * DAY).toISOString(),
      }),
      mk("mbp:2", new Date(NOW - 29 * DAY).toISOString(), "release", { task: "t" }),
    ]
    const { live, settled } = partitionForCompact(entries, NOW, 7 * DAY)
    expect(settled.map((e) => e.id)).toEqual(["mbp:1", "mbp:2"])
    expect(live).toHaveLength(0)
  })

  test("keeps unanswered asks regardless of age", () => {
    const entries = [mk("mbp:1", new Date(NOW - 30 * DAY).toISOString(), "ask", { text: "q?" })]
    const { live, settled } = partitionForCompact(entries, NOW, 7 * DAY)
    expect(live).toHaveLength(1)
    expect(settled).toHaveLength(0)
  })

  test("keeps held resource with unexpired lease even if old", () => {
    const entries = [
      mk("mbp:1", new Date(NOW - 30 * DAY).toISOString(), "resource", {
        resource: "git", ref: "main", action: "acquire", lease: new Date(NOW + DAY).toISOString(),
      }),
    ]
    const { live, settled } = partitionForCompact(entries, NOW, 7 * DAY)
    expect(live).toHaveLength(1)
    expect(settled).toHaveLength(0)
  })

  test("archives released/expired resource acquires", () => {
    const entries = [
      mk("mbp:1", new Date(NOW - 30 * DAY).toISOString(), "resource", {
        resource: "git", ref: "main", action: "acquire", lease: new Date(NOW - 20 * DAY).toISOString(),
      }),
    ]
    const { live, settled } = partitionForCompact(entries, NOW, 7 * DAY)
    expect(settled).toHaveLength(1)
    expect(live).toHaveLength(0)
  })
})
