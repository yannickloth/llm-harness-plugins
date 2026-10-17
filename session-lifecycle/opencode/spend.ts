// Cost accounting for session-lifecycle.
//
// Why here and not as its own plugin: cost is per-session lifecycle state, and
// this plugin already owns `session.idle` in both entrypoints — a separate
// plugin would duplicate the event plumbing and need its own registration.
//
// Why the DB and not the event stream: `offpeak-nudge` summarizes the cost of
// the current session from live `message.updated` events, but that number dies
// with the process and cannot see subagents, the day, the month or the lifetime
// total. This module reads the truth source OpenCode itself persists
// (`<data>/opencode/opencode.db`) into a small incrementally-synced cache, so
// the summary survives restarts and covers sessions this process never saw.
//
// Cost of a sync: O(tail), not O(table). `message` has no index on
// `time_updated`, so `WHERE time_updated > ?` scans the whole table (seconds
// cold, ~230 ms warm on a 351k-row DB) and would block the event loop on every
// idle. Rewrites only happen while a message is recent, so the scan is bounded
// by rowid instead (TAIL_ROWS, ~2 ms), and the rare stragglers are healed by a
// once-per-process repair pass.
//
// Watermark safety: the sync watermark is the wall clock captured *before* the
// selects, not the largest `time_updated` observed. A row finalized between the
// select and the fetch can be newer than every timestamp we saw; advancing to a
// value derived from observed rows would skip it forever.
//
// The Java sidecar is not involved: this is pure TypeScript bookkeeping, and
// every failure here is swallowed and logged (a missing summary must never
// break a turn or the plugin load).
import { Database } from "bun:sqlite"
import { existsSync } from "fs"
import { homedir } from "os"
import { join } from "path"

/** Rewrites are looked for in this many rowids below the watermark. */
const TAIL_ROWS = 4096

const fmt = (n: number) => `$${n.toFixed(2)}`

export type SpendLevel = "debug" | "info" | "warn" | "error"

export type SpendReporter = {
  /** Summarize a session if it is a root session and the cache is booted. */
  report: (sessionID: string) => Promise<void>
  /** Resolve once bootstrap + maintenance finished (test seam). */
  ready: () => Promise<void>
  close: () => void
}

export type SpendParts = {
  session: number
  subs: number
  today: number
  month: number
  allTime: number
}

/** One-line summary. Pure so the shape is pinned by a test. */
export function buildSummary(p: SpendParts): string {
  return (
    `session ${fmt(p.session)}` +
    ` · subs ${fmt(p.subs)}` +
    ` · today ${fmt(p.today)}` +
    ` · month ${fmt(p.month)}` +
    ` · all-time ${fmt(p.allTime)}`
  )
}

type Paths = {
  /** OpenCode's live DB. Defaults to <data>/opencode/opencode.db. */
  main?: string
  /** This module's cache. Defaults to <data>/opencode/spend-cache.db. */
  cache?: string
}

type Row = { rid: number; sid: string; tc: number; tu: number; cost: number }

function defaultPaths(): { main: string; cache: string } {
  const dataDir = process.env.XDG_DATA_HOME ?? join(homedir(), ".local/share")
  return {
    main: join(dataDir, "opencode", "opencode.db"),
    cache: join(dataDir, "opencode", "spend-cache.db"),
  }
}

/**
 * Open the cache + live DB and return the reporter. Returns null when there is
 * no DB yet (a fresh install must not fail the plugin load) or when the cache
 * cannot be opened — in both cases the caller can retry later.
 */
export function createSpendReporter(opts: {
  log: (level: SpendLevel, message: string) => void
  notify: (message: string) => Promise<void> | void
  paths?: Paths
  /** Clock seam for tests. Defaults to `new Date()`. */
  now?: () => Date
}): SpendReporter | null {
  const defaults = defaultPaths()
  const mainPath = opts.paths?.main ?? defaults.main
  const cachePath = opts.paths?.cache ?? defaults.cache
  if (!existsSync(mainPath)) return null

  const nowMs = () => (opts.now?.() ?? new Date()).getTime()

  const open = (): { cache: Database; main: Database } | null => {
    let cache: Database | undefined
    let main: Database | undefined
    try {
      cache = new Database(cachePath)
      // busy_timeout first: the WAL switch takes a short lock and would
      // otherwise fail immediately when another instance is writing the cache.
      cache.exec("PRAGMA busy_timeout=5000")
      cache.exec("PRAGMA journal_mode=WAL")
      // This file is a cache of the source DB, not a source of truth: losing
      // the last commits on a crash costs nothing (they are re-derived). FULL
      // makes each idle's write an fsync — measured 54-177 ms per commit, which
      // is too long to hold the event loop for.
      cache.exec("PRAGMA synchronous=NORMAL")
      cache.exec(
        "CREATE TABLE IF NOT EXISTS spend(rid INTEGER PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, cost REAL NOT NULL DEFAULT 0)",
      )
      cache.exec("CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT)")
      // The summary is four scans of the cache; without these it is ~400 ms on
      // a 312k-row cache (measured), i.e. a visible event-loop stall per idle.
      // Covering (key, cost) indexes make each scan index-only.
      cache.exec("CREATE INDEX IF NOT EXISTS spend_session_cost ON spend(session_id, cost)")
      cache.exec("CREATE INDEX IF NOT EXISTS spend_created_cost ON spend(time_created, cost)")
      main = new Database(mainPath, { readonly: true })
      main.exec("PRAGMA busy_timeout=5000")
      return { cache, main }
    } catch (e) {
      try {
        cache?.close()
      } catch {
        // nothing to clean up
      }
      try {
        main?.close()
      } catch {
        // ditto
      }
      opts.log("warn", `cost cache unavailable: ${e}`)
      return null
    }
  }

  const db = open()
  if (!db) return null
  const { cache, main } = db

  const close = () => {
    try {
      main.close()
    } catch {
      // teardown must never break the plugin unload
    }
    try {
      cache.close()
    } catch {
      // ditto
    }
  }

  const getMeta = cache.query("SELECT v FROM meta WHERE k=?")
  const setMeta = cache.query("INSERT OR REPLACE INTO meta(k,v) VALUES(?,?)")
  // REPLACE everywhere: a paged bootstrap that is interrupted can leave
  // mid-stream cost=0 rows behind, and OR IGNORE would freeze them forever.
  const upsert = cache.query("INSERT OR REPLACE INTO spend(rid,session_id,time_created,time_updated,cost) VALUES(?,?,?,?,?)")
  const del = cache.query("DELETE FROM spend WHERE rid=?")

  const getV = (k: string) => (getMeta.get(k) as { v: string } | undefined)?.v

  let booted = getV("boot") === "1"
  // A recreated source DB restarts `rowid` at 1, so the cached watermark would
  // point past every row and nothing would ever sync again. Rebuild instead.
  // `max(rowid)` is O(1) on the primary key.
  const srcMax = Number((main.query("SELECT max(rowid) AS r FROM message").get() as any)?.r ?? 0)
  if (booted && srcMax < Number(getV("rid") ?? -1)) {
    cache.exec("DELETE FROM spend")
    cache.exec("DELETE FROM meta")
    booted = false
  }

  /** Only assistant messages carry `cost`; malformed rows are skipped. */
  const toRow = (r: any): Row | null => {
    let d: any
    try {
      d = JSON.parse(r.data)
    } catch {
      return null
    }
    if (d.role !== "assistant") return null
    return { rid: r.rid, sid: r.session_id, tc: r.time_created, tu: r.time_updated, cost: Number(d.cost) || 0 }
  }

  // First run on a large DB: page through `message` by rowid and yield to the
  // event loop between pages so the plugin never blocks startup.
  const bootstrap = async () => {
    try {
      const startedAt = nowMs()
      let rid = -1
      while (true) {
        const rows = main
          .query("SELECT rowid AS rid, session_id, time_created, time_updated, data FROM message WHERE rowid > ? ORDER BY rowid LIMIT 5000")
          .all(rid) as any[]
        if (rows.length === 0) break
        const out: Row[] = []
        for (const r of rows) {
          const row = toRow(r)
          if (row) out.push(row)
        }
        cache.transaction(() => {
          for (const r of out) upsert.run(r.rid, r.sid, r.tc, r.tu, r.cost)
        })()
        rid = rows[rows.length - 1].rid
        await Bun.sleep(0)
      }
      cache.transaction(() => {
        setMeta.run("rid", String(rid))
        setMeta.run("synced_at", String(startedAt))
        setMeta.run("boot", "1")
      })()
      booted = true
    } catch (e) {
      // Leave `booted` false: report() then no-ops instead of reading a
      // half-built cache. The next process start retries.
      opts.log("warn", `cost cache bootstrap failed: ${e}`)
    }
  }

  // Drop cache rows whose message is gone. `message` cascades on session
  // delete, and without this the cache would keep counting deleted sessions
  // forever (and a reused rowid could be overwritten with a stale cost).
  const prune = () => {
    const live = new Set<number>()
    for (const r of main.query("SELECT rowid AS rid FROM message").all() as any[]) live.add(r.rid)
    const stale: number[] = []
    for (const r of cache.query("SELECT rid FROM spend").all() as any[]) if (!live.has(r.rid)) stale.push(r.rid)
    if (stale.length === 0) return 0
    cache.transaction(() => {
      for (const rid of stale) del.run(rid)
    })()
    return stale.length
  }

  // A cached `cost = 0` row is an in-flight message: if the source now has a
  // cost, the row was finalized outside the tail window (sleep, restart, a
  // long queue) and would otherwise stay at zero forever.
  const repairZeroCost = () => {
    const zeros = cache.query("SELECT rid FROM spend WHERE cost=0").all() as any[]
    if (zeros.length === 0) return 0
    const fetch = main.query("SELECT session_id, time_created, time_updated, data FROM message WHERE rowid=?")
    const changed: Row[] = []
    for (const z of zeros) {
      const r = fetch.get(z.rid) as any
      if (!r) continue
      const row = toRow({ rid: z.rid, ...r })
      if (row && row.cost !== 0) changed.push(row)
    }
    if (changed.length === 0) return 0
    cache.transaction(() => {
      for (const r of changed) upsert.run(r.rid, r.sid, r.tc, r.tu, r.cost)
    })()
    return changed.length
  }

  // Once per process. ~0.6 s on a 351k-row DB, so it is deliberately not part
  // of the per-idle path; the yield lets the event loop run between phases.
  const maintain = async () => {
    try {
      prune()
      await Bun.sleep(0)
      repairZeroCost()
    } catch (e) {
      opts.log("warn", `cost cache maintenance failed: ${e}`)
    }
  }

  let booting: Promise<void> | null = null
  if (!booted) booting = bootstrap()
  const warm = (async () => {
    if (booting) await booting
    if (booted) await maintain()
  })()

  // Incremental pass: rows that can still be rewritten (bounded rowid tail)
  // plus every new row. Both branches are indexed range scans.
  const sync = () => {
    if (!booted) return
    const startedAt = nowMs()
    const rid = Number(getV("rid") ?? -1)
    const syncedAt = Number(getV("synced_at") ?? 0)
    const touched = new Set<number>()
    if (rid >= 0) {
      const tail = main
        .query("SELECT rowid AS rid FROM message WHERE rowid > ? AND time_updated > ?")
        .all(rid - TAIL_ROWS, syncedAt) as any[]
      for (const r of tail) touched.add(r.rid)
    }
    let maxRid = rid
    for (const r of main.query("SELECT rowid AS rid FROM message WHERE rowid > ? ORDER BY rowid").all(rid) as any[]) {
      touched.add(r.rid)
      maxRid = Math.max(maxRid, r.rid)
    }
    if (touched.size > 0) {
      const fetch = main.query("SELECT session_id, time_created, time_updated, data FROM message WHERE rowid=?")
      const rows: Row[] = []
      for (const id of touched) {
        const r = fetch.get(id) as any
        if (!r) continue
        const row = toRow({ rid: id, ...r })
        if (row) rows.push(row)
      }
      cache.transaction(() => {
        for (const r of rows) upsert.run(r.rid, r.sid, r.tc, r.tu, r.cost)
      })()
    }
    // No write when nothing moved: advancing `synced_at` is optional (an older
    // watermark only re-reads the bounded tail), and a commit per idle would
    // make an otherwise read-only path pay for an fsync.
    if (touched.size === 0 && maxRid === rid) return
    cache.transaction(() => {
      setMeta.run("rid", String(maxRid))
      setMeta.run("synced_at", String(startedAt))
    })()
  }

  const sum = (where: string, ...args: any[]) =>
    (cache.query(`SELECT sum(cost) c FROM spend WHERE ${where}`).get(...args) as { c: number | null } | undefined)?.c ?? 0

  const report = async (sessionID: string) => {
    try {
      // Subagent sessions idle too; their cost is already counted under the
      // parent's `subs`, so reporting them would double the noise.
      const row = main.query("SELECT parent_id FROM session WHERE id=?").get(sessionID) as { parent_id: string | null } | undefined
      if (!row || row.parent_id) return
      // A summary before the first bootstrap finishes would read an empty cache.
      if (!booted) return
      sync()
      const kids = main.query("SELECT id FROM session WHERE parent_id=?").all(sessionID) as { id: string }[]
      let subs = 0
      for (const k of kids) subs += sum("session_id=?", k.id)
      const today = new Date(nowMs()).setHours(0, 0, 0, 0)
      const at = new Date(nowMs())
      const month = new Date(at.getFullYear(), at.getMonth(), 1).getTime()
      const msg = buildSummary({
        session: sum("session_id=?", sessionID),
        subs,
        today: sum("time_created>=?", today),
        month: sum("time_created>=?", month),
        allTime: sum("1"),
      })
      await opts.notify(msg)
    } catch (e) {
      opts.log("warn", `cost report failed: ${e}`)
    }
  }

  return { report, ready: () => warm, close }
}
