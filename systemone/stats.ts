#!/usr/bin/env bun
/**
 * Adoption report for the local System One decision tools.
 *
 *   bun systemone/stats.ts            # last 7 days
 *   bun systemone/stats.ts --days 30
 *   bun systemone/stats.ts --all
 *
 * Reads the ledger written by systemone/opencode/index.ts
 * (~/.local/share/systemone/calls.jsonl, override with SYSTEMONE_LEDGER) and
 * answers the only question a log can answer: **did the calls happen**. It cannot
 * tell you whether a decision was right, or whether a call should have happened
 * but didn't — that needs the sampling audit described in README.md.
 */

import fs from "fs"
import os from "os"
import path from "path"

type Entry = {
  ts: string
  kind: "call" | "exposure"
  tool?: string
  ok?: boolean
  latency_ms?: number
  session?: string
  agent?: string
  project?: string
  trigger?: string
  command?: string
  error?: string
  external?: boolean
}

const LEDGER =
  process.env.SYSTEMONE_LEDGER ?? path.join(os.homedir(), ".local", "share", "systemone", "calls.jsonl")

const args = process.argv.slice(2)
const all = args.includes("--all")
const daysArg = args.indexOf("--days")
const days = daysArg >= 0 ? Number(args[daysArg + 1]) : 7
const since = all ? 0 : Date.now() - (Number.isFinite(days) ? days : 7) * 86_400_000

if (!fs.existsSync(LEDGER)) {
  console.log(`no ledger at ${LEDGER}`)
  console.log("the systemone plugin writes to it on the first decision call; nothing has run yet")
  process.exit(0)
}

const rows: Entry[] = fs
  .readFileSync(LEDGER, "utf8")
  .split("\n")
  .filter(Boolean)
  .flatMap(line => {
    try {
      return [JSON.parse(line) as Entry]
    } catch {
      return [] // a torn line is not worth failing the report over
    }
  })
  .filter(e => new Date(e.ts).getTime() >= since)

const calls = rows.filter(r => r.kind === "call")
const exposures = rows.filter(r => r.kind === "exposure")

function pct(n: number, d: number): string {
  return d === 0 ? "—" : `${Math.round((100 * n) / d)}%`
}

function quantile(values: number[], q: number): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]
}

const range = all ? "all time" : `last ${days} days`
console.log(`\nSystem One adoption — ${range}`)
console.log(`ledger: ${LEDGER}`)
console.log(`${rows.length} entries: ${calls.length} calls, ${exposures.length} exposures\n`)

// ── calls per tool ──────────────────────────────────────────────────────────
const byTool = new Map<string, Entry[]>()
for (const c of calls) {
  const name = c.tool ?? "(unknown)"
  byTool.set(name, [...(byTool.get(name) ?? []), c])
}

console.log("Calls")
console.log("  tool                          n    ok%    p50      p95")
for (const [name, entries] of [...byTool.entries()].sort((a, b) => b[1].length - a[1].length)) {
  const ok = entries.filter(e => e.ok).length
  const latencies = entries.map(e => e.latency_ms ?? 0).filter(v => v > 0)
  const p50 = quantile(latencies, 0.5)
  const p95 = quantile(latencies, 0.95)
  console.log(
    `  ${name.padEnd(28)} ${String(entries.length).padStart(4)}  ${pct(ok, entries.length).padStart(4)}  ` +
      `${(p50 === null ? "—" : `${p50}ms`).padStart(7)}  ${(p95 === null ? "—" : `${p95}ms`).padStart(7)}`,
  )
}
if (byTool.size === 0) console.log("  (none — no decision tool has been called in this window)")

// ── exposures: moments where a judgment was expected ────────────────────────
const byTrigger = new Map<string, Entry[]>()
for (const e of exposures) {
  const t = e.trigger ?? "(unknown)"
  byTrigger.set(t, [...(byTrigger.get(t) ?? []), e])
}

console.log("\nExposures (moments a decision was expected)")
for (const [trigger, entries] of byTrigger) {
  console.log(`  ${trigger.padEnd(20)} ${entries.length}`)
}
if (byTrigger.size === 0) console.log("  (none)")

// ── session-level adoption: exposure vs the call it should have triggered ───
const sessionsWith = (predicate: (e: Entry) => boolean) =>
  new Set(rows.filter(predicate).map(e => e.session).filter(Boolean) as string[])

const riskExposed = sessionsWith(e => e.kind === "exposure" && e.trigger === "risky_command")
const riskCalled = sessionsWith(e => e.kind === "call" && e.tool === "systemone_risk")
const riskAdopted = [...riskExposed].filter(s => riskCalled.has(s)).length

const fetched = sessionsWith(e => e.kind === "exposure" && e.trigger === "fetched_content")
const screened = sessionsWith(e => e.kind === "call" && e.tool === "systemone_screen")
const fetchAdopted = [...fetched].filter(s => screened.has(s)).length

console.log("\nSession-level adoption (rough)")
console.log(`  risky command  → systemone_risk : ${pct(riskAdopted, riskExposed.size).padStart(4)}  (${riskAdopted}/${riskExposed.size} sessions)`)
console.log(`  fetched content → systemone_screen: ${pct(fetchAdopted, fetched.size).padStart(4)}  (${fetchAdopted}/${fetched.size} sessions)`)
console.log("\n  This is a proxy: it counts sessions where BOTH the exposure and the call")
console.log("  appeared, not whether the call was the right one for that moment.")

// ── failures are the leading indicator of avoidance ─────────────────────────
const failures = calls.filter(c => !c.ok)
if (failures.length > 0) {
  console.log(`\nRecent failures (${failures.length} total — a failing tool gets abandoned)`)
  for (const f of failures.slice(-5)) {
    console.log(`  ${f.ts}  ${f.tool}: ${String(f.error ?? "ok=false").slice(0, 120)}`)
  }
}

console.log("\nCross-check that the endpoint itself was used (server side):")
console.log("  journalctl --user -u unsloth-studio --since today | grep -c 'POST.*\"/v1/systemone\"'")
console.log("  journalctl --user -u unsloth-studio --since today | grep -c 'POST.*\"/mcp/decisions\"'")
console.log("")
