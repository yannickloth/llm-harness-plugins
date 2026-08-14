import { sortEntries, type LedgerEntry } from "./ledger"

export const DIGEST_HEADER = "## Coordination digest"

export type DigestOptions = {
  maxEntries?: number
}

/**
 * Render ledger entries into the digest text prepended to prompts.
 * Idempotent for a given (entries, watermark): advancing the watermark to the
 * last rendered entry reproduces exactly the same set on the next call.
 */
export function buildDigest(entries: LedgerEntry[], options: DigestOptions = {}): string {
  if (entries.length === 0) return ""
  const max = options.maxEntries ?? 50
  // Drop low-signal auto "touched X" events (resource entries with no lease and no
  // release) from the digest so coordination content — claims, status, asks, holds,
  // releases — is not drowned out. They still land in the ledger (audit trail and
  // hold tracking) but do not consume the digest window.
  const informative = entries.filter(
    (e) => e.type !== "resource" || e.action === "release" || Boolean(e.lease),
  )
  if (informative.length === 0) return ""
  const shown = informative.slice(-max)
  const lines = shown.map(lineFor)
  const alert = conflictAlert(entries)
  return alert ? `${DIGEST_HEADER}\n${lines.join("\n")}\n\n${alert}` : `${DIGEST_HEADER}\n${lines.join("\n")}`
}

/**
 * Detect overlapping *holds* on the same shared resource — an agent acquires a
 * resource another agent still holds (not yet released, lease not expired). This
 * is the class of collision the ledger exists to prevent. Simulates holds in
 * position order; returns a concise "⚠ possible conflict" line or null.
 */
export function conflictAlert(entries: LedgerEntry[]): string | null {
  const held = new Map<string, string>() // resourceKey -> holder agent
  const conflicts = new Map<string, Set<string>>()
  const now = Date.now()
  for (const e of sortEntries(entries)) {
    if (e.type !== "resource") continue
    const key = resourceKey(e)
    if (!key) continue
    if (e.action === "release") {
      held.delete(key)
    } else if (e.lease && !leaseExpired(e.lease, now)) {
      // Only *held* resources (explicit acquire/heartbeat with a lease) are tracked;
      // informational auto "touched X" events have no lease and are not holds.
      const prev = held.get(key)
      if (prev && prev !== e.agent) {
        if (!conflicts.has(key)) conflicts.set(key, new Set([prev]))
        conflicts.get(key)!.add(e.agent)
      }
      held.set(key, e.agent)
    }
  }
  for (const [key, agents] of conflicts) {
    if (agents.size > 1) {
      const kind = key.startsWith("git") ? "branch/ref" : "file"
      const name = key.startsWith("git") ? key.slice(4) : key.slice(5)
      return `⚠ possible conflict: agents ${[...agents].join(", ")} hold ${kind} \`${name}\` concurrently — coordinate before proceeding.`
    }
  }
  return null
}

function resourceKey(e: LedgerEntry): string {
  if (e.resource === "git") return e.ref ? `git:${e.ref}` : "git"
  return e.file ? `file:${e.file}` : ""
}

function leaseExpired(lease: string | undefined, now: number): boolean {
  if (!lease) return false
  const t = Date.parse(lease)
  if (Number.isNaN(t)) return false
  return t < now
}

function lineFor(e: LedgerEntry): string {
  const who = `[${e.host}:${e.seq}] ${e.agent}`
  switch (e.type) {
    case "msg":
      return `- ${who}: ${e.text ?? ""}`
    case "claim":
      return `- ${who}: claim "${e.task ?? ""}"${e.lease ? ` (lease until ${e.lease})` : ""}`
    case "release":
      return `- ${who}: release "${e.task ?? e.taskID ?? ""}"`
    case "status":
      return `- ${who}: ${e.task ?? ""} → ${e.status ?? ""}`
    case "handoff":
      return `- ${who}: handed "${e.task ?? ""}" to ${e.target ?? "?"}`
    case "heartbeat":
      return `- ${who}: alive`
    case "resource":
      // git → "git commit on feat" / release "free: git" ; file → "touched <path>" / "released <path>"
      if (e.resource === "git") {
        const label = e.action === "release" ? "released" : e.task ?? "git"
        const ref = e.ref ? ` on ${e.ref}` : ""
        return `- ${who}: ${label}${ref}`
      }
      return e.action === "release"
        ? `- ${who}: released ${e.file ?? e.task ?? ""}`
        : `- ${who}: touched ${e.file ?? e.task ?? ""}`
    case "ask":
      return `- ${who} asks: ${e.text ?? ""}`
    case "answer":
      return `- ${who} answers (${e.taskID ?? e.task ?? e.target ?? "?"}): ${e.text ?? ""}`
    default:
      // forward-compatible: unknown event types (e.g. from a merged, newer
      // ledger schema) must still render rather than emit a blank/undefined line
      return `- ${who}: ${e.type}${e.task ? ` "${e.task}"` : ""}${e.text ? ` — ${e.text}` : ""}`
  }
}
