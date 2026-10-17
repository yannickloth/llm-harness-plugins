import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { describe, expect, test } from "bun:test"
import { buildSummary, createSpendReporter } from "./spend"

const DAY = 24 * 60 * 60 * 1000
// Fixed clock at local noon: the day/month boundaries are then deterministic
// (tests must not flake when they run near midnight).
const BASE = new Date(2026, 5, 15, 12, 0, 0).getTime()

/**
 * A stand-in for OpenCode's DB with only the columns the reporter reads. Each
 * test gets its own fixture so the assertions never depend on test order.
 */
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "spend-test-"))
  const main = join(dir, "opencode.db")
  const db = new Database(main)
  db.exec("CREATE TABLE session(id TEXT PRIMARY KEY, parent_id TEXT)")
  db.exec("CREATE TABLE message(rowid INTEGER PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)")

  const session = (id: string, parentID: string | null = null) => {
    db.query("INSERT INTO session(id,parent_id) VALUES(?,?)").run(id, parentID)
  }

  const msg = (sessionID: string, role: string, cost: number, at: number, updated = at) => {
    const res = db.query("INSERT INTO message(session_id,time_created,time_updated,data) VALUES(?,?,?,?)").run(
      sessionID,
      at,
      updated,
      JSON.stringify({ role, ...(role === "assistant" ? { cost } : {}) }),
    )
    return Number(res.lastInsertRowid)
  }

  const finalize = (rid: number, cost: number, at: number) => {
    db.query("UPDATE message SET data=?, time_updated=? WHERE rowid=?").run(JSON.stringify({ role: "assistant", cost }), at, rid)
  }

  const reporter = (cacheName: string, seen: string[], nowMs = BASE) =>
    createSpendReporter({
      log: () => {},
      notify: (message) => {
        seen.push(message)
      },
      paths: { main, cache: join(dir, cacheName) },
      now: () => new Date(nowMs),
    })

  return {
    db,
    dir,
    reporter,
    session,
    msg,
    finalize,
    cleanup: () => {
      try {
        db.close()
      } catch {
        // ignore
      }
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

describe("buildSummary", () => {
  test("renders every window with two decimals", () => {
    expect(buildSummary({ session: 3.5, subs: 0.25, today: 3.75, month: 10, allTime: 1234.5 })).toBe(
      "session $3.50 · subs $0.25 · today $3.75 · month $10.00 · all-time $1234.50",
    )
  })

  test("zero-cost sessions still render", () => {
    expect(buildSummary({ session: 0, subs: 0, today: 0, month: 0, allTime: 0 })).toBe(
      "session $0.00 · subs $0.00 · today $0.00 · month $0.00 · all-time $0.00",
    )
  })
})

describe("createSpendReporter", () => {
  test("reports root sessions with subagent cost folded into subs", async () => {
    const f = fixture()
    try {
      f.session("root")
      f.msg("root", "assistant", 1.5, BASE - 1000)
      f.msg("root", "user", 0, BASE - 900) // no cost on user rows
      f.msg("root", "assistant", 2.0, BASE - 800)
      f.session("child", "root")
      f.msg("child", "assistant", 0.25, BASE - 700)

      const seen: string[] = []
      const spend = f.reporter("cache.db", seen)!
      await spend.ready()

      await spend.report("root")
      expect(seen).toHaveLength(1)
      expect(seen[0]).toContain("session $3.50")
      expect(seen[0]).toContain("subs $0.25")
      expect(seen[0]).toContain("today $3.75")

      // A subagent session idles too; it must not produce a second summary.
      await spend.report("child")
      expect(seen).toHaveLength(1)
      spend.close()
    } finally {
      f.cleanup()
    }
  })

  test("picks up a cost filled in after the cache was built", async () => {
    const f = fixture()
    try {
      f.session("root")
      f.msg("root", "assistant", 1.5, BASE - 1000)
      const late = f.msg("root", "assistant", 2.0, BASE - 800)

      const seen: string[] = []
      const spend = f.reporter("cache.db", seen)!
      await spend.ready()
      await spend.report("root")
      expect(seen[0]).toContain("session $3.50")

      // Streaming fills the cost in later: same rowid, newer time_updated.
      f.finalize(late, 5, BASE + 1000)
      await spend.report("root")
      expect(seen[1]).toContain("session $6.50")
      spend.close()
    } finally {
      f.cleanup()
    }
  })

  test("picks up messages appended after the first sync", async () => {
    const f = fixture()
    try {
      f.session("root")
      f.msg("root", "assistant", 1, BASE - 1000)
      const seen: string[] = []
      const spend = f.reporter("cache.db", seen)!
      await spend.ready()
      await spend.report("root")
      expect(seen[0]).toContain("session $1.00")

      f.msg("root", "assistant", 2, BASE - 500)
      await spend.report("root")
      expect(seen[1]).toContain("session $3.00")
      spend.close()
    } finally {
      f.cleanup()
    }
  })

  test("persists across a restart", async () => {
    const f = fixture()
    try {
      f.session("root")
      f.msg("root", "assistant", 4, BASE - 1000)

      const before: string[] = []
      const a = f.reporter("cache.db", before)!
      await a.ready()
      await a.report("root")
      expect(before[0]).toContain("session $4.00")
      a.close()

      // Same cache file: meta (boot/rid) must survive, so no re-bootstrap.
      const seen: string[] = []
      const spend = f.reporter("cache.db", seen)!
      await spend.ready()
      await spend.report("root")
      expect(seen[0]).toContain("session $4.00")
      spend.close()
    } finally {
      f.cleanup()
    }
  })

  test("stops counting messages deleted from the source", async () => {
    const f = fixture()
    try {
      f.session("keep")
      f.msg("keep", "assistant", 1, BASE - 1000)
      f.session("gone")
      f.msg("gone", "assistant", 2, BASE - 900)

      const first: string[] = []
      const a = f.reporter("cache.db", first)!
      await a.ready()
      await a.report("keep")
      expect(first[0]).toContain("all-time $3.00")
      a.close()

      f.db.query("DELETE FROM message WHERE session_id='gone'").run()
      f.db.query("DELETE FROM session WHERE id='gone'").run()

      const seen: string[] = []
      const b = f.reporter("cache.db", seen)!
      await b.ready() // maintenance prunes the orphaned cache row
      await b.report("keep")
      expect(seen[0]).toContain("all-time $1.00")
      b.close()
    } finally {
      f.cleanup()
    }
  })

  test("repairs a cost that finalized while the process was away", async () => {
    const f = fixture()
    try {
      f.session("root")
      const rid = f.msg("root", "assistant", 0, BASE - 1000) // in flight

      const first: string[] = []
      const a = f.reporter("cache.db", first)!
      await a.ready()
      await a.report("root")
      expect(first[0]).toContain("session $0.00")
      a.close()

      // Finalized while no process was running: outside any tail window.
      f.finalize(rid, 2.5, BASE + 1000)

      const seen: string[] = []
      const b = f.reporter("cache.db", seen)!
      await b.ready() // maintenance repairs cached zero-cost rows
      await b.report("root")
      expect(seen[0]).toContain("session $2.50")
      b.close()
    } finally {
      f.cleanup()
    }
  })

  test("counts an old session toward all-time only", async () => {
    const f = fixture()
    try {
      f.session("old")
      f.msg("old", "assistant", 7, BASE - 65 * DAY)

      const seen: string[] = []
      const spend = f.reporter("cache.db", seen)!
      await spend.ready()
      await spend.report("old")
      expect(seen[0]).toContain("today $0.00")
      expect(seen[0]).toContain("month $0.00")
      expect(seen[0]).toContain("all-time $7.00")
      spend.close()
    } finally {
      f.cleanup()
    }
  })

  test("rebuilds when the source DB was recreated", async () => {
    const f = fixture()
    try {
      f.session("root")
      f.msg("root", "assistant", 2, BASE - 1000)
      f.msg("root", "assistant", 0.5, BASE - 900) // watermark rid = 2

      const first: string[] = []
      const a = f.reporter("cache.db", first)!
      await a.ready()
      await a.report("root")
      expect(first[0]).toContain("session $2.50")
      a.close()

      // Recreated source: new file, rowids restart at 1.
      f.db.close()
      rmSync(join(f.dir, "opencode.db"), { force: true })
      const fresh = new Database(join(f.dir, "opencode.db"))
      fresh.exec("CREATE TABLE session(id TEXT PRIMARY KEY, parent_id TEXT)")
      fresh.exec("CREATE TABLE message(rowid INTEGER PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)")
      fresh.query("INSERT INTO session(id,parent_id) VALUES(?,NULL)").run("new")
      fresh
        .query("INSERT INTO message(session_id,time_created,time_updated,data) VALUES(?,?,?,?)")
        .run("new", BASE - 500, BASE - 500, JSON.stringify({ role: "assistant", cost: 9 }))
      fresh.close()

      const seen: string[] = []
      const b = f.reporter("cache.db", seen)!
      await b.ready()
      await b.report("new")
      expect(seen[0]).toContain("session $9.00")
      expect(seen[0]).toContain("all-time $9.00")
      b.close()
    } finally {
      f.cleanup()
    }
  })

  test("returns null when the DB is absent", () => {
    const f = fixture()
    try {
      const spend = createSpendReporter({
        log: () => {},
        notify: () => {},
        paths: {
          main: join(tmpdir(), `definitely-missing-${process.pid}-${Date.now()}.db`),
          cache: join(tmpdir(), `spend-test-cache-${process.pid}-${Date.now()}.db`),
        },
      })
      expect(spend).toBeNull()
    } finally {
      f.cleanup()
    }
  })
})
