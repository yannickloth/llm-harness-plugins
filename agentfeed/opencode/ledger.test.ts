import { describe, test, expect } from "bun:test"
import { Ledger, sortEntries, entriesNewerThan, watermarkAfter, EMPTY_WATERMARK } from "./ledger"

function memReader(start: string) {
  let content = start
  return {
    readEntries: async () => {
      if (!content) return []
      return content
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    },
    atomicWrite: async (_p: string, c: string) => {
      content = c
    },
    exists: async () => content.length > 0,
  }
}

describe("Ledger", () => {
  test("append assigns host-qualified monotonic seq starting at 1", async () => {
    const r = memReader("")
    const ledger = new Ledger(r, { host: "mbp", clock: () => new Date("2026-08-13T22:22:05Z") })
    const a = await ledger.append("/l.jsonl", { agent: "a", type: "msg", text: "hi" })
    const b = await ledger.append("/l.jsonl", { agent: "a", type: "msg", text: "again" })
    expect(a.id).toBe("mbp:1")
    expect(b.id).toBe("mbp:2")
    expect(a.seq).toBe(1)
    expect(b.seq).toBe(2)
  })

  test("append is per-host: foreign-host entries do not advance this host's seq", async () => {
    const existing = JSON.stringify({
      id: "desk:7", host: "desk", seq: 7, ts: "2026-08-13T22:00:00.000Z",
      agent: "w", type: "claim", task: "x", status: "open",
    })
    const r = memReader(`${existing}\n`)
    const ledger = new Ledger(r, { host: "mbp" })
    const a = await ledger.append("/l.jsonl", { agent: "a", type: "msg", text: "hi" })
    // desk:7 must not advance mbp's counter
    expect(a.seq).toBe(1)
    expect(a.id).toBe("mbp:1")
  })

  test("append continues this host's own seq across its prior entries", async () => {
    const existing = JSON.stringify({
      id: "mbp:3", host: "mbp", seq: 3, ts: "2026-08-13T22:00:00.000Z",
      agent: "a", type: "msg", text: "earlier",
    })
    const r = memReader(`${existing}\n`)
    const ledger = new Ledger(r, { host: "mbp" })
    const a = await ledger.append("/l.jsonl", { agent: "a", type: "msg", text: "hi" })
    expect(a.seq).toBe(4)
    expect(a.id).toBe("mbp:4")
  })

  test("append is atomic (rewrites full content including prior entries)", async () => {
    let content = ""
    let writes = 0
    const r = {
      readEntries: async () => (content ? content.split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []),
      atomicWrite: async (_p: string, c: string) => {
        content = c
        writes++
      },
      exists: async () => content.length > 0,
    }
    const ledger = new Ledger(r, { host: "mbp" })
    await ledger.append("/l.jsonl", { agent: "a", type: "msg", text: "1" })
    await ledger.append("/l.jsonl", { agent: "a", type: "msg", text: "2" })
    const entries = await r.readEntries("/l.jsonl")
    expect(entries).toHaveLength(2)
    expect(writes).toBe(2)
  })
})

describe("sortEntries / watermark", () => {
  const mk = (id: string, host: string, seq: number, ts: string) => ({ id, host, seq, ts, agent: "a", type: "msg" as const, text: id })

  test("sorts by ts, then host, then seq", () => {
    const entries = [
      mk("mbp:1", "mbp", 1, "2026-08-13T22:22:05.000Z"),
      mk("desk:1", "desk", 1, "2026-08-13T22:22:05.000Z"),
      mk("mbp:2", "mbp", 2, "2026-08-13T22:22:05.000Z"),
      mk("desk:2", "desk", 2, "2026-08-13T22:22:05.000Z"),
    ]
    const sorted = sortEntries(entries)
    expect(sorted.map((e) => e.id)).toEqual(["desk:1", "desk:2", "mbp:1", "mbp:2"])
  })

  test("entriesNewerThan returns only entries after watermark", () => {
    const entries = [
      mk("mbp:1", "mbp", 1, "2026-08-13T22:22:05.000Z"),
      mk("mbp:2", "mbp", 2, "2026-08-13T22:22:06.000Z"),
    ]
    const wm = { ts: "2026-08-13T22:22:05.000Z", host: "mbp", seq: 1 }
    const newer = entriesNewerThan(entries, wm)
    expect(newer.map((e) => e.id)).toEqual(["mbp:2"])
  })

  test("entriesNewerThan with empty watermark returns all", () => {
    const entries = [mk("mbp:1", "mbp", 1, "2026-08-13T22:22:05.000Z")]
    expect(entriesNewerThan(entries, EMPTY_WATERMARK)).toHaveLength(1)
  })

  test("watermarkAfter returns last position by global order", () => {
    const entries = [
      mk("mbp:1", "mbp", 1, "2026-08-13T22:22:05.000Z"),
      mk("mbp:2", "mbp", 2, "2026-08-13T22:22:07.000Z"),
    ]
    expect(watermarkAfter(entries)).toEqual({ ts: "2026-08-13T22:22:07.000Z", host: "mbp", seq: 2 })
  })

  test("after a git merge, older foreign-host entries are NOT shown as new", () => {
    // watermark at mbp:2 (22:22:07). A git merge introduces desk entries with
    // an OLDER ts (already existed elsewhere) and a NEWER one. Only the newer
    // must surface as new; the older must not be re-shown.
    const wm = { ts: "2026-08-13T22:22:07.000Z", host: "mbp", seq: 2 }
    const merged = [
      mk("mbp:1", "mbp", 1, "2026-08-13T22:22:05.000Z"),
      mk("mbp:2", "mbp", 2, "2026-08-13T22:22:07.000Z"),
      mk("desk:1", "desk", 1, "2026-08-13T22:20:00.000Z"), // older, merged in
      mk("desk:2", "desk", 2, "2026-08-13T22:25:00.000Z"), // newer
    ]
    const newer = entriesNewerThan(merged, wm)
    expect(newer.map((e) => e.id)).toEqual(["desk:2"])
    expect(watermarkAfter(merged)).toEqual({ ts: "2026-08-13T22:25:00.000Z", host: "desk", seq: 2 })
  })

  test("defaultReader skips a single malformed line instead of discarding all", async () => {
    const dir = `/tmp/agentfeed-malformed-${Date.now()}`
    const file = `${dir}/ledger.jsonl`
    const { promises: fsp } = await import("fs")
    await fsp.mkdir(dir, { recursive: true })
    await fsp.writeFile(file, '{"id":"a:1","host":"a","seq":1,"ts":"t","agent":"x","type":"msg","text":"ok"}\nNOT JSON\n{"id":"a:2","host":"a","seq":2,"ts":"t","agent":"x","type":"msg","text":"also ok"}\n')
    const { defaultReader } = await import("./ledger")
    const entries = await defaultReader.readEntries(file)
    expect(entries).toHaveLength(2)
    expect(entries.map((e) => e.id)).toEqual(["a:1", "a:2"])
    await fsp.rm(dir, { recursive: true, force: true })
  })
})
