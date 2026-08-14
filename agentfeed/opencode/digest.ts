import type { LedgerEntry } from "./ledger"

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
  const shown = entries.slice(-max)
  const lines = shown.map(lineFor)
  return `${DIGEST_HEADER}\n${lines.join("\n")}`
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
      // git → "git commit"; file → "touched <path>"
      return e.resource === "git"
        ? `- ${who}: ${e.task ?? "git"}`
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
