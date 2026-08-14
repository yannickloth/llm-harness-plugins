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
    await fsp.mkdir(path.dirname(p), { recursive: true })
    const tmp = `${p}.${process.pid}.tmp`
    await fsp.writeFile(tmp, JSON.stringify(wm), "utf8")
    await fsp.rename(tmp, p)
  },
}

export function watermarkPath(dir: string, sessionID: string, agent: string): string {
  return path.join(dir, ".agentfeed", "watermarks", `${safeKey(sessionID)}_${safeKey(agent)}.json`)
}

function safeKey(s: string): string {
  return s.replace(/[^a-zA-Z0-9_.-]/g, "_")
}
