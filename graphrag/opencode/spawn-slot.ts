import path from "path"
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, openSync, closeSync } from "fs"

/**
 * Spawn-slot coordination for the graphrag indexer.
 *
 * Kept in a separate module (not the plugin entry `index.ts`) on purpose:
 * opencode's legacy plugin loader treats every top-level function export of a
 * plugin entry as a plugin factory and calls it with `(input, options)`. If
 * this lived in `index.ts`, the loader would call `claimSpawnSlot(input,
 * options)`, which does `path.join(indexRoot, ...)` on the options object and
 * throws `path must be a string or TypedArray`, making the whole plugin fail
 * to load.
 */
function stealIfOwnerDead(lockFile: string): void {
  if (!existsSync(lockFile)) return
  const pid = parseInt(readFileSync(lockFile, "utf8").trim().split("\n")[0] ?? "", 10)
  if (!Number.isFinite(pid) || pid <= 0) return
  if (Bun.spawnSync(["kill", "-0", String(pid)]).exitCode !== 0) {
    try {
      rmSync(lockFile, { force: true })
    } catch { /* best effort */ }
  }
}

export async function claimSpawnSlot(indexRoot: string, minIntervalMs: number): Promise<boolean> {
  if (!Number.isFinite(minIntervalMs) || minIntervalMs <= 0) minIntervalMs = 60_000
  mkdirSync(indexRoot, { recursive: true })
  const spawnLock = path.join(indexRoot, ".spawn-lock")
  stealIfOwnerDead(spawnLock)
  try {
    const fd = openSync(spawnLock, "wx")
    writeFileSync(fd, `${process.pid}\n`)
    closeSync(fd)
  } catch (err: any) {
    if (err?.code === "EEXIST") return false // another session holds the slot
    throw err
  }

  try {
    const lockFile = path.join(indexRoot, ".lock")
    if (existsSync(lockFile)) {
      const content = readFileSync(lockFile, "utf8").split("\n")
      const pid = parseInt(content[0] ?? "", 10)
      if (Number.isFinite(pid) && pid > 0 && Bun.spawnSync(["kill", "-0", String(pid)]).exitCode === 0) {
        return false // an indexer job is already running
      }
    }

    const lastLaunchFile = path.join(indexRoot, ".last-launch")
    const now = Date.now()
    if (existsSync(lastLaunchFile)) {
      const last = parseInt(readFileSync(lastLaunchFile, "utf8").trim(), 10)
      if (Number.isFinite(last) && now - last < minIntervalMs) {
        return false // too soon since the last launch (across all sessions)
      }
    }
    writeFileSync(lastLaunchFile, String(now))
    return true
  } finally {
    try {
      rmSync(spawnLock, { force: true })
    } catch { /* best effort */ }
  }
}
