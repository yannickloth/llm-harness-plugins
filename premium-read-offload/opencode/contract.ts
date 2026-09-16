import fs from "fs"

// Structured return contract for offload-read. Kept in its own module because
// opencode's plugin loader treats every function exported by the plugin entry
// file as a plugin and calls it with the PluginInput — so index.ts may only
// export the default plugin. These pure helpers are imported there and unit-
// tested directly.

/** Per-file line range handed to the worker. `from`/`to` are the range actually
 * provided; `total` is the file's full line count. */
export interface LineRange { from: number; to: number; total: number }

/** One citation verdict from the Java core. */
export interface CitationItem { path: string; start: number; end: number; quote: string; status: string }

/** Mechanical citation-verification report. */
export interface CitationReport {
  total: number
  verified: number
  unverified: number
  hasCitations: boolean
  items: CitationItem[]
}

/** Count lines the way the gate does: a trailing newline does not add a line.
 * Returns -1 when the file cannot be read. */
export function countFileLines(absPath: string): number {
  try {
    const text = fs.readFileSync(absPath, "utf-8")
    if (text.length === 0) return 0
    return text.split("\n").length - (text.endsWith("\n") ? 1 : 0)
  } catch {
    return -1
  }
}

/** Deterministic provenance: the full-file range provided to the worker. */
export function buildLineRanges(paths: string[]): Record<string, LineRange> {
  const out: Record<string, LineRange> = {}
  for (const p of paths) {
    const total = countFileLines(p)
    out[p] = { from: 1, to: total, total }
  }
  return out
}

/** Assemble the offload-read return contract. Pure, so it is unit-testable
 * without spawning a worker. */
export function buildOffloadContract(input: {
  answer: string
  filesRead: string[]
  lineRanges: Record<string, LineRange>
  workerSession: string | null
  cacheHit: boolean
  verification: CitationReport | null
}): string {
  const contract: Record<string, unknown> = {
    answer: input.answer,
    files_read: input.filesRead,
    line_ranges: input.lineRanges,
    worker_session: input.workerSession,
    cache_hit: input.cacheHit,
  }
  if (input.verification) {
    contract.citations = input.verification
    contract.verification = "ok"
  } else {
    contract.citations = { total: 0, verified: 0, unverified: 0, hasCitations: false, items: [] }
    contract.verification = "error"
  }
  return JSON.stringify(contract)
}
