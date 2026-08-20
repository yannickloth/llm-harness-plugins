import path from "path"

/**
 * Client for the persistent semantic-cache daemon (SemanticCacheDaemon).
 *
 * Holds one persistent JVM per cache dir and serializes requests per daemon so
 * concurrent callers never interleave writes or mis-assign responses. A dead or
 * hung daemon is torn down and respawned once before a request fails.
 */

const pluginDir = path.join(import.meta.dir, "..")
const classesDir = path.join(pluginDir, "build", "classes")
const daemonMain = "eu.infolead.llmhp.cache.SemanticCacheDaemon"

const REQUEST_TIMEOUT_MS = 15_000

export interface DaemonContext {
  worktree?: string
  directory: string
}

export function cacheDir(context: DaemonContext): string {
  return context.worktree
    ? path.join(context.worktree, ".agentmem", "cache")
    : path.join(context.directory, ".agentmem", "cache")
}

function b64(s: string): string {
  return Buffer.from(s, "utf8").toString("base64")
}

interface Daemon {
  proc: ReturnType<typeof Bun.spawn>
  lines: LineReader
  tail: Promise<void>
}

const daemons = new Map<string, Daemon>()

/** Minimal newline-delimited reader. Each `next()` resolves one response line (or "" on EOF). */
interface LineReader {
  next(): Promise<string>
}

function createLineReader(stream: ReadableStream<Uint8Array>): LineReader {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  const pending: Array<(line: string) => void> = []
  let buffer = ""
  let done = false

  const dispatch = (line: string | null) => {
    const resolve = pending.shift()
    if (resolve) resolve(line ?? "")
  }

  const pump = async () => {
    try {
      while (!done) {
        const { value, done: d } = await reader.read()
        if (d) {
          done = true
          if (buffer) {
            dispatch(buffer)
            buffer = ""
          }
          dispatch(null)
          break
        }
        buffer += decoder.decode(value, { stream: true })
        let idx: number
        while ((idx = buffer.indexOf("\n")) >= 0) {
          dispatch(buffer.slice(0, idx))
          buffer = buffer.slice(idx + 1)
        }
      }
    } catch {
      done = true
      dispatch(null)
    }
  }
  pump()

  return {
    next(): Promise<string> {
      return new Promise(resolve => {
        if (done) return resolve("")
        pending.push(resolve)
      })
    },
  }
}

async function ensureDaemon(cdir: string): Promise<Daemon | null> {
  const existing = daemons.get(cdir)
  if (existing && !existing.proc.killed && existing.proc.exitCode === null) return existing

  const proc = Bun.spawn(
    ["java", "--class-path", classesDir, daemonMain, cdir],
    { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
  )
  const lines = createLineReader(proc.stdout)
  const daemon: Daemon = { proc, lines, tail: Promise.resolve() }
  daemons.set(cdir, daemon)
  return daemon
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("daemon request timed out")), ms)
    p.then(v => {
      clearTimeout(timer)
      resolve(v)
    }, e => {
      clearTimeout(timer)
      reject(e)
    })
  })
}

async function daemonRequest(cdir: string, frame: string): Promise<string> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const daemon = await ensureDaemon(cdir)

    const run = async (): Promise<string> => {
      try {
        daemon.proc.stdin.write(frame + "\n")
        await daemon.proc.stdin.flush()
      } catch {
        throw new Error("daemon write failed")
      }
      const line = await withTimeout(daemon.lines.next(), REQUEST_TIMEOUT_MS)
      if (line === "") throw new Error("daemon eof")
      return line
    }

    const result = daemon.tail.then(run, run)
    daemon.tail = result.then(() => {}, () => {})
    try {
      const line = await result
      const sep = line.indexOf("\t")
      const status = sep < 0 ? line : line.slice(0, sep)
      const body = sep < 0 ? "" : line.slice(sep + 1)
      if (status === "ERR") throw new Error(body)
      return body
    } catch (e) {
      // Only tear down the daemon we own — a concurrent request may have already
      // respawned a new one; never delete or kill a daemon we don't hold.
      if (daemons.get(cdir) === daemon) {
        daemons.delete(cdir)
        try {
          if (daemon.proc.exitCode === null) daemon.proc.kill()
        } catch {}
      }
      if (attempt === 0) continue
      throw e
    }
  }
  throw new Error("daemon request failed")
}

export async function lookup(cdir: string, prompt: string): Promise<string | null> {
  if (!prompt || prompt.length < 10) return null
  const body = await daemonRequest(cdir, `lookup\t${b64(prompt)}`)
  if (!body) return null
  try {
    const parsed = JSON.parse(body)
    return parsed.hit ? parsed.cached_response : null
  } catch {
    return null
  }
}

export async function store(cdir: string, prompt: string, response: string): Promise<void> {
  if (!prompt || !response) return
  await daemonRequest(cdir, `store\t${b64(prompt)}\t${b64(response)}`)
}

export async function invalidateFiles(cdir: string, filePath: string): Promise<void> {
  await daemonRequest(cdir, `invalidate-files\t${b64(filePath)}`)
}

export async function invalidateStale(cdir: string): Promise<void> {
  await daemonRequest(cdir, "invalidate-stale")
}

export async function stats(cdir: string): Promise<string> {
  return daemonRequest(cdir, "stats")
}
