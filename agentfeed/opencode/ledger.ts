import { hostname as osHostname } from "os"
import { promises as fsp } from "fs"
import path from "path"

export type EventType =
  | "msg"
  | "claim"
  | "release"
  | "status"
  | "handoff"
  | "heartbeat"
  | "resource"
  | "ask"
  | "answer"

export type ResourceKind = "git" | "file"

export type LedgerEntry = {
  id: string
  host: string
  seq: number
  ts: string
  agent: string
  type: EventType
  task?: string
  text?: string
  status?: string
  lease?: string
  target?: string
  taskID?: string
  /** For type === "resource": kind of shared resource (git / file). */
  resource?: ResourceKind
  /** For type === "resource": the resource name (e.g. file path, git ref). */
  file?: string
  /** For type === "resource": git ref/branch the op targets (best-effort). */
  ref?: string
  /** For type === "resource": lifecycle phase — acquire (start) or release (free). */
  action?: "acquire" | "release"
}

export type Watermark = {
  ts: string
  host: string
  seq: number
}

export const EMPTY_WATERMARK: Watermark = { ts: "", host: "", seq: 0 }

export type LedgerReader = {
  readEntries(p: string): Promise<LedgerEntry[]>
  append(p: string, line: string): Promise<void>
  exists(p: string): Promise<boolean>
}

export const defaultReader: LedgerReader = {
  readEntries: async (p) => {
    try {
      const raw = await fsp.readFile(p, "utf8")
      const out: LedgerEntry[] = []
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue
        try {
          out.push(JSON.parse(line) as LedgerEntry)
        } catch {
          // skip a single malformed line (crash mid-append, merge artifact)
          // rather than discarding the whole ledger view
        }
      }
      return out
    } catch {
      return []
    }
  },
  // True append (O_APPEND), not read-all-then-atomic-rewrite: keeps the ledger
  // cheap to grow regardless of its length. Callers must hold the same-host lock
  // (the plugin's withLock) so a single host's appends never interleave; cross-host
  // union is handled by git's append-only merge driver.
  append: async (p, line) => {
    await fsp.mkdir(path.dirname(p), { recursive: true })
    await fsp.appendFile(p, line, "utf8")
  },
  exists: async (p) => {
    try {
      await fsp.access(p)
      return true
    } catch {
      return false
    }
  },
}

function safeHostname(): string {
  return osHostname().replace(/[^a-zA-Z0-9_.-]/g, "_") || "unknown"
}

function iso(d: Date): string {
  return d.toISOString()
}

export class Ledger {
  private reader: LedgerReader
  private host: string
  private clock: () => Date

  constructor(reader: LedgerReader = defaultReader, opts: { host?: string; clock?: () => Date } = {}) {
    this.reader = reader
    this.host = opts.host ?? safeHostname()
    this.clock = opts.clock ?? (() => new Date())
  }

  async read(filePath: string): Promise<LedgerEntry[]> {
    return this.reader.readEntries(filePath)
  }

  /**
   * Single critical section: derive the next seq and append one line. Callers must
   * hold the same-host lock around this. The write is a true O_APPEND, so cost is
   * O(1) in file length regardless of how large the ledger has grown.
   */
  async append(filePath: string, entry: Omit<LedgerEntry, "id" | "host" | "seq" | "ts">): Promise<LedgerEntry> {
    // seq is per-host monotonic: only count this host's own prior entries. After
    // a git merge the ledger holds foreign-host entries with higher seqs; taking
    // a global max would corrupt this host's counter and break the id uniqueness
    // guarantee.
    const entries = await this.reader.readEntries(filePath)
    const seq =
      entries.filter((e) => e.host === this.host).reduce((max, e) => (e.seq > max ? e.seq : max), 0) + 1
    const full: LedgerEntry = {
      ...entry,
      id: `${this.host}:${seq}`,
      host: this.host,
      seq,
      ts: iso(this.clock()),
    }
    await this.reader.append(filePath, JSON.stringify(full) + "\n")
    return full
  }
}

export function sortEntries(entries: LedgerEntry[]): LedgerEntry[] {
  return [...entries].sort((a, b) => {
    const ts = a.ts.localeCompare(b.ts)
    if (ts !== 0) return ts
    const h = a.host.localeCompare(b.host)
    if (h !== 0) return h
    return a.seq - b.seq
  })
}

export function comparePositions(a: LedgerEntry, b: Watermark): number {
  const ts = a.ts.localeCompare(b.ts)
  if (ts !== 0) return ts
  const h = a.host.localeCompare(b.host)
  if (h !== 0) return h
  return a.seq - b.seq
}

export function entriesNewerThan(entries: LedgerEntry[], watermark: Watermark): LedgerEntry[] {
  return sortEntries(entries).filter((e) => comparePositions(e, watermark) > 0)
}

export function watermarkAfter(entries: LedgerEntry[]): Watermark {
  if (entries.length === 0) return EMPTY_WATERMARK
  const last = sortEntries(entries).at(-1)!
  return { ts: last.ts, host: last.host, seq: last.seq }
}
