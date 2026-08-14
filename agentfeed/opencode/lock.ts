import { promises as fsp } from "fs"
import path from "path"

/**
 * Same-host advisory lock via exclusive lockfile creation (O_EXCL semantics).
 * Guards the ledger append critical section so two processes on one host cannot
 * compute the same seq. Cross-host safety is not provided by design — that is
 * git merge of host-qualified ids.
 */

const STALE_MS = 60_000
const RETRY_MS = 25
const TIMEOUT_MS = 15_000

export type LockOptions = {
  staleMs?: number
  retryMs?: number
  timeoutMs?: number
}

export async function withLock<T>(
  lockPath: string,
  fn: () => Promise<T>,
  options: LockOptions = {},
): Promise<T> {
  const staleMs = options.staleMs ?? STALE_MS
  const retryMs = options.retryMs ?? RETRY_MS
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS

  await fsp.mkdir(path.dirname(lockPath), { recursive: true })
  const deadline = Date.now() + timeoutMs

  for (;;) {
    try {
      await fsp.writeFile(lockPath, JSON.stringify({ pid: process.pid, ts: Date.now() }), {
        flag: "wx",
      })
      break
    } catch (err: any) {
      if (err?.code !== "EEXIST") throw err
      await maybeSteal(lockPath, staleMs)
      if (Date.now() > deadline) throw new Error(`agentfeed: lock timeout on ${lockPath}`)
      await sleep(retryMs)
    }
  }

  try {
    return await fn()
  } finally {
    await fsp.rm(lockPath, { force: true })
  }
}

async function maybeSteal(lockPath: string, staleMs: number): Promise<void> {
  try {
    const raw = await fsp.readFile(lockPath, "utf8")
    const meta = JSON.parse(raw) as { pid?: number; ts?: number }
    if (!meta.pid || typeof meta.ts !== "number") return // malformed — don't guess, keep waiting
    const age = Date.now() - meta.ts
    if (age <= staleMs) return
    if (await pidAlive(meta.pid)) return
    await fsp.rm(lockPath, { force: true })
  } catch {
    // lock vanished or unreadable — retry loop will re-attempt
  }
}

async function pidAlive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0)
    return true
  } catch (err: any) {
    // EPERM means the process exists but is owned by another user → alive.
    if (err?.code === "EPERM") return true
    return false // ESRCH / others → not alive
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
