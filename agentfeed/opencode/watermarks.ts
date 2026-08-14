import { promises as fsp } from "fs"
import path from "path"
import { EMPTY_WATERMARK, type Watermark } from "./ledger"

/**
 * Persists the last-rendered ledger position per (sessionID, agent).
 * Survives process restarts; stored under .agentfeed (git-ignored).
 */

export type WatermarkStore = {
  read(path: string): Promise<Watermark>
  write(path: string, wm: Watermark): Promise<void>
}

export const defaultWatermarkStore: WatermarkStore = {
  read: async (p) => {
    try {
      const raw = await fsp.readFile(p, "utf8")
      const data = JSON.parse(raw)
      if (
        data &&
        typeof data.ts === "string" &&
        typeof data.host === "string" &&
        typeof data.seq === "number"
      ) {
        return data as Watermark
      }
    } catch {
      // fall through to empty
    }
    return EMPTY_WATERMARK
  },
  write: async (p, wm) => {
    const dir = path.dirname(p)
    const tmp = `${p}.${process.pid}.tmp`
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await fsp.mkdir(dir, { recursive: true })
        await fsp.writeFile(tmp, JSON.stringify(wm), "utf8")
        await fsp.rename(tmp, p)
        return
      } catch (e: any) {
        // A concurrent op (e.g. `git clean` removing the git-ignored .agentfeed
        // dir during a coordination cycle) can remove the watermark directory
        // between the temp write and the rename (ENOENT). Recreate the dir and
        // retry; on the final attempt leave the error to the caller.
        if (attempt < 2 && e?.code === "ENOENT") continue
        throw e
      }
    }
  },
}

export function watermarkPath(dir: string, sessionID: string, agent: string): string {
  return path.join(dir, ".agentfeed", "watermarks", `${safeKey(sessionID)}_${safeKey(agent)}.json`)
}

function safeKey(s: string): string {
  return s.replace(/[^a-zA-Z0-9_.-]/g, "_")
}
