import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { $ } from "bun"
import path from "path"
import { existsSync, readFileSync, writeFileSync, openSync, closeSync, rmSync, mkdirSync } from "fs"
import { createLogger } from "../../shared/plugin-logger"
import { moduleDir } from "../../shared/module-dir"

const pluginDir = path.join(moduleDir(import.meta.url, import.meta.dir), "..")
const classesDir = path.join(pluginDir, "build", "classes")
const kgClassesDir = path.join(pluginDir, "..", "knowledge-graph", "build", "classes")
const indexCliClass = "eu.infolead.llmhp.graphrag.IndexCli"
const configFile = path.join(pluginDir, "config", "graphrag.yaml")

const EXCLUDE_SEGMENTS = new Set([
  "result", ".git", "graph-index", "tmp", "target", "build",
  ".direnv", "node_modules", "downloads", "literature",
])

const FILE_READ_TOOLS = new Set(["read", "glob", "grep"])

interface GraphRagConfig {
  autoUpdate: boolean
  debounceSeconds: number
  graphragBinary: string
  indexRoot: string
}

interface Manifest {
  commit: string
  timestamp: string
  graphrag_version: string
  graphrag_binary: string
  dirty: string[]
}

function loadConfig(): GraphRagConfig {
  const cfg: GraphRagConfig = {
    autoUpdate: true,
    debounceSeconds: 300,
    graphragBinary: "graphrag",
    indexRoot: "graph-index",
  }
  try {
    const raw = readFileSync(configFile, "utf-8")
    for (const line of raw.split("\n")) {
      const t = line.trim()
      if (t.startsWith("auto_update:")) cfg.autoUpdate = t.includes("true")
      else if (t.startsWith("debounce_seconds:")) cfg.debounceSeconds = parseInt(t.split(":")[1]?.trim() ?? "300", 10)
      else if (t.startsWith("graphrag_binary:")) cfg.graphragBinary = t.split(":").slice(1).join(":").trim()
      else if (t.startsWith("index_root:")) cfg.indexRoot = t.split(":")[1]?.trim()
    }
  } catch {
    // defaults
  }
  return cfg
}

async function resolveBinary(binary: string): Promise<string | null> {
  const result = await $`command -v ${binary}`.nothrow().text()
  const p = result.trim()
  return p.length > 0 ? p : null
}

async function binaryVersion(binary: string): Promise<string | null> {
  const probe = await $`python3 -c ${"from importlib.metadata import version; print(version('graphrag'))"}`.nothrow().text()
  const v = probe.trim()
  if (/^\d+\.\d+\.\d+/.test(v)) return v
  const resolved = await resolveBinary(binary)
  if (resolved) {
    const m = resolved.match(/graphrag-(\d+\.\d+\.\d+)/)
    if (m) return m[1]
  }
  return null
}

function manifestPath(root: string, cfg: GraphRagConfig): string {
  return path.join(root, cfg.indexRoot, "manifest.json")
}

function readManifest(root: string, cfg: GraphRagConfig): Manifest | null {
  try {
    return JSON.parse(readFileSync(manifestPath(root, cfg), "utf-8")) as Manifest
  } catch {
    return null
  }
}

function addToDirtySet(root: string, cfg: GraphRagConfig, file: string): void {
  const mp = manifestPath(root, cfg)
  const rel = path.isAbsolute(file) ? path.relative(root, file) : file
  try {
    let manifest: Manifest | null = null
    try {
      if (existsSync(mp)) manifest = JSON.parse(readFileSync(mp, "utf-8")) as Manifest
    } catch { /* corrupt */ }
    if (!manifest) {
      manifest = {
        commit: "none",
        timestamp: new Date().toISOString(),
        graphrag_version: "unknown",
        graphrag_binary: "graphrag",
        dirty: [rel],
      }
      writeFileSync(mp, JSON.stringify(manifest, null, 2))
      return
    }
    if (manifest.dirty.includes(rel)) return
    manifest.dirty.push(rel)
    writeFileSync(mp, JSON.stringify(manifest, null, 2))
  } catch {
    // best effort
  }
}

function isRelevantFile(root: string, file: string): boolean {
  if (!file.endsWith(".typ") && !file.endsWith(".tex")) return false
  const rel = path.isAbsolute(file) ? path.relative(root, file) : file
  if (rel.startsWith("..")) return false
  for (const seg of rel.split(path.sep)) {
    if (EXCLUDE_SEGMENTS.has(seg)) return false
  }
  return true
}

function stalenessLine(manifest: Manifest | null, currentVersion: string | null): string {
  if (!manifest) return "[graphrag index: missing — run `graphrag mode=index` to build]"
  const dirty = manifest.dirty.length
  const versionMismatch = currentVersion !== null && manifest.graphrag_version !== currentVersion
  if (versionMismatch) {
    return `[graphrag index: VERSION MISMATCH — index built with ${manifest.graphrag_version}, current binary is ${currentVersion}; reindex required]`
  }
  if (dirty > 0) {
    return `[graphrag index: STALE — ${dirty} file(s) changed since ${manifest.commit.slice(0, 8)} @ ${manifest.timestamp}]`
  }
  return `[graphrag index: fresh @ ${manifest.commit.slice(0, 8)} @ ${manifest.timestamp}]`
}

function launchDetached(args: string[], logFile: string): void {
  const fd = openSync(logFile, "a")
  const proc = Bun.spawn(args, {
    stdout: fd,
    stderr: fd,
    stdin: "ignore",
  })
  proc.unref()
}

/**
 * Remove a `.spawn-lock` left behind by a session that crashed while holding it.
 * Only steals when the recorded owner PID is dead, mirroring the Java lock logic.
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

/**
 * Cross-instance indexer throttle. Returns true iff this process may launch an
 * indexer job right now, atomically claiming the slot so no other session on
 * the same host launches concurrently. Guards against an N-session spawn storm
 * (each opencode session loads this plugin, so per-instance debounce counters
 * do NOT serialize).
 *
 * Serialization is filesystem-backed: an O_EXCL `.spawn-lock` ensures exactly
 * one winner per slot; under the lock we refuse when an indexer is already
 * running (live PID in `.lock`) or a launch happened too recently
 * (`minIntervalMs`, tracked in `.last-launch`).
 */
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

export default async ({ client, directory, worktree }: Parameters<Plugin>[0]) => {
  const logger = createLogger(client, "graphrag")
  const cfg = loadConfig()
  const root = worktree ?? directory
  const indexRoot = path.join(root, cfg.indexRoot)
  const settingsFile = path.join(indexRoot, "settings.yaml")
  const logDir = path.join(indexRoot, "logs")

  const javaCp = `${classesDir}:${kgClassesDir}`

  async function injectContext(sessionId: string, text: string) {
    try {
      await client.session.prompt({
        path: { id: sessionId },
        body: { noReply: true, parts: [{ type: "text", text }] },
      })
    } catch (e) {
      logger.error(`inject failed: ${(e as Error).message}`)
    }
  }

  async function checkVersion(): Promise<{ current: string | null; manifest: Manifest | null; match: boolean }> {
    const manifest = readManifest(root, cfg)
    const current = await binaryVersion(cfg.graphragBinary)
    const match = manifest === null || current === null || manifest.graphrag_version === current
    return { current, manifest, match }
  }

  logger.info("plugin active — graphrag tool + staleness hooks")

  return {
    event: async ({ event }) => {
      switch (event.type) {
        case "session.created": {
          const sessionId = (event.properties as { info?: { id?: string } })?.info?.id
          if (!sessionId) return

          const binPath = await resolveBinary(cfg.graphragBinary)
          if (!binPath) {
            logger.info("binary not found on PATH")
            await injectContext(sessionId,
              "graphrag not on PATH — start opencode from the project terminal so direnv loads, or set graphrag_binary in config.")
            return
          }
          const version = await binaryVersion(cfg.graphragBinary)
          logger.info(`binary=${binPath} version=${version ?? "unknown"}`)

          const manifest = readManifest(root, cfg)
          if (!manifest) {
            await injectContext(sessionId,
              "GraphRAG index missing — build with `graphrag mode=index` when ready.")
            return
          }
          if (manifest.dirty.length > 0) {
            await injectContext(sessionId,
              `GraphRAG index stale: ${manifest.dirty.length} files changed since ${manifest.commit.slice(0, 8)}.`)
          }
          break
        }

        case "file.edited": {
          const file = (event.properties as { file?: string })?.file ?? ""
          if (file && isRelevantFile(root, file)) addToDirtySet(root, cfg, file)
          break
        }

        case "file.watcher.updated": {
          const props = event.properties as { file?: string; event?: string }
          const file = props?.file ?? ""
          if (props?.event !== "unlink" && file && isRelevantFile(root, file)) {
            addToDirtySet(root, cfg, file)
          }
          break
        }

        case "session.idle": {
          if (!cfg.autoUpdate) break
          const manifest = readManifest(root, cfg)
          const dirtyCount = manifest ? manifest.dirty.length : 0
          if (dirtyCount === 0) break
          const now = Date.now()
          const binPath = await resolveBinary(cfg.graphragBinary)
          if (!binPath) {
            logger.info("skipping auto-update — graphrag binary not on PATH")
            break
          }
          if (!(await claimSpawnSlot(indexRoot, cfg.debounceSeconds * 1000))) {
            logger.info("skipping auto-update — indexer already running or launched recently")
            break
          }
          try {
            mkdirSync(logDir, { recursive: true })
          } catch { /* exists */ }
          const logFile = path.join(logDir, `update-${now}.log`)
          launchDetached([
            "java", "--class-path", javaCp, indexCliClass,
            "update", root, configFile,
          ], logFile)
          const label = manifest ? `${dirtyCount} dirty files` : "lazy init"
          logger.info(`incremental update launched (${label}), log: ${logFile}`)
          break
        }
      }
    },

    "tool.execute.after": async (event: {
      tool: string
      input: Record<string, unknown>
    }) => {
      if (!FILE_READ_TOOLS.has(event.tool)) return
      const filePath = (event.input.filePath ?? event.input.path ?? event.input.pattern ?? "") as string
      if (!filePath) return
      const absPath = path.isAbsolute(filePath) ? filePath : path.resolve(root, filePath)
      if (!absPath.startsWith(root)) return
      if (!isRelevantFile(root, absPath)) return

      let manifest = readManifest(root, cfg)
      const rel = path.relative(root, absPath)
      if (!manifest) {
        manifest = {
          commit: "none",
          timestamp: new Date().toISOString(),
          graphrag_version: "unknown",
          graphrag_binary: cfg.graphragBinary,
          dirty: [rel],
        }
        try {
          writeFileSync(manifestPath(root, cfg), JSON.stringify(manifest, null, 2))
        } catch { /* best effort */ }
        return
      }

      if (!manifest.dirty.includes(rel)) {
        manifest.dirty.push(rel)
        try {
          writeFileSync(manifestPath(root, cfg), JSON.stringify(manifest, null, 2))
        } catch { /* best effort */ }
      }
    },

    tool: {
      graphrag: tool({
        description: "GraphRAG semantic index: mode=local|global|drift (semantic search), status (index state), index (build/update in background)",
        args: {
          mode: tool.schema.enum(["local", "global", "drift", "status", "index"])
            .describe("local=entity-focused, global=corpus-wide themes, drift=hybrid, status=manifest state, index=build or update"),
          query: tool.schema.string().optional()
            .describe("Search query (required for local/global/drift)"),
        },
        async execute(args, context) {
          const mode = args.mode as string

          if (mode === "status") {
            const out = await $`java --class-path ${javaCp} ${indexCliClass} status ${root} ${configFile}`.nothrow().text()
            return out.trim() || "No index state available."
          }

          if (mode === "index") {
            // Route through the same cross-session throttle as auto-update.
            // claimSpawnSlot does the authoritative .lock PID-liveness check
            // (so a stale .lock left by a crashed indexer is stolen, not a
            // permanent block) and honors the .last-launch debounce — unlike a
            // bare existsSync(.lock) check, which would wedge on a stale lock.
            if (!(await claimSpawnSlot(indexRoot, cfg.debounceSeconds * 1000))) {
              return "An index job is already running or was launched too recently. Try again later."
            }
            const isInit = !existsSync(manifestPath(root, cfg))
            try {
              mkdirSync(logDir, { recursive: true })
            } catch { /* exists */ }
            const logFile = path.join(logDir, `${isInit ? "init" : "update"}-${Date.now()}.log`)
            launchDetached([
              "java", "--class-path", javaCp, indexCliClass,
              isInit ? "init" : "update", root, configFile, pluginDir,
            ], logFile)
            return `Index ${isInit ? "init" : "update"} started in background. Log: ${logFile}. Check progress with mode=status.`
          }

          const query = (args.query ?? "").trim()
          if (!query) return "Query required for local/global/drift modes."

          const binPath = await resolveBinary(cfg.graphragBinary)
          if (!binPath) {
            return "graphrag not on PATH — start opencode from the project terminal so direnv loads, or set graphrag_binary in config."
          }
          if (!existsSync(settingsFile)) {
            return "No index found. Build one with mode=index first."
          }

          const { current, manifest, match } = await checkVersion()
          if (!match && manifest) {
            return `REFUSED: index was built with graphrag ${manifest.graphrag_version} but current binary is ${current}. Rebuild with mode=index before querying.`
          }

          const result = await $`${binPath} query --method ${mode} --query ${query} --root ${indexRoot} --config ${settingsFile}`.nothrow().text()
          const prefix = stalenessLine(manifest, current)
          if (!result.trim()) return `${prefix}\nQuery returned no output. Check logs in ${logDir}.`
          return `${prefix}\n\n${result.trim()}`
        },
      }),
    },
  }
}
