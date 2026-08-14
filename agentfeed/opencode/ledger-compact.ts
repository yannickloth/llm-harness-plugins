import type { LedgerEntry } from "./ledger"
import { sortEntries } from "./ledger"

/**
 * Pure logic for compacting the coordination ledger: move "settled" entries to a
 * compressed archive (backup, not deletion) and keep the live window bounded.
 * Separated from I/O for testability (IVP: retention policy vs storage).
 *
 * The ledger is a coordination STATE machine, not a durable event archive:
 * open claims, held resources, and unanswered asks are live state and are always
 * kept; raw informational events (msg/resource/status/ask/answer/heartbeat) and
 * resolved claims/releases older than `retentionMs` are archived. Git history
 * remains the full, durable backup of every entry that ever existed.
 */

export type CompactResult = {
  /** Entries to keep in the live ledger window. */
  live: LedgerEntry[]
  /** Entries to archive (settled / older than retention). */
  settled: LedgerEntry[]
}

/** True if an entry represents live coordination state that must never be archived. */
function isLiveState(e: LedgerEntry, now: number): boolean {
  // An open / in-progress claim that has not expired.
  if (e.type === "claim" && (e.status === "open" || e.status === "in-progress")) {
    if (!leaseExpired(e.lease, now)) return true
  }
  // A held resource: an acquire with an unexpired lease and no later release.
  if (e.type === "resource" && e.action === "acquire" && !leaseExpired(e.lease, now)) return true
  // An unanswered ask directed at anyone.
  if (e.type === "ask") return true
  return false
}

/**
 * Partition entries into live vs settled. An entry is settled when it is NOT live
 * state AND it is older than the retention window. Open claims/asks and unexpired
 * holds are always kept even if old, since they encode current coordination intent.
 * Claims whose lease has expired, and released claims, are no longer live state and
 * archive once old.
 */
export function partitionForCompact(entries: LedgerEntry[], now: number, retentionMs: number): CompactResult {
  const cutoff = now - retentionMs
  const sorted = sortEntries(entries)

  const live: LedgerEntry[] = []
  const settled: LedgerEntry[] = []
  for (const e of sorted) {
    const fresh = e.ts ? Date.parse(e.ts) >= cutoff : false
    const state = isLiveState(e, now)
    const keep = fresh || state
    ;(keep ? live : settled).push(e)
  }
  return { live, settled }
}

function leaseExpired(lease: string | undefined, now: number): boolean {
  if (!lease) return false
  const t = Date.parse(lease)
  if (Number.isNaN(t)) return false
  return t < now
}
