import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { $ } from "bun"
import path from "path"
import { existsSync, readFileSync, openSync, mkdirSync } from "fs"
import { createLogger } from "../../shared/plugin-logger"
import { moduleDir } from "../../shared/module-dir"
import { claimSpawnSlot } from "./spawn-slot"
import {
  gateMissing,
  isQueryMode,
  isRelevantFile,
  isStructuralFile,
  markFullReindex,
  markRemoved,
  mergeManifestV2Atomic,
  parseGraphragYamlConfig,
  probeEndpoint,
  readManifestV2,
  readReconcileState,
  reconcileFromGit,
  resolveEnvKey,
  statusNotice,
} from "./lifecycle"
import type { GraphragYamlConfig, ManifestV2 } from "./lifecycle"
import { writeLoadCanary } from "../../shared/load-canary"

const pluginDir = path.join(moduleDir(import.meta.url, import.meta.dir), "..")
const classesDir = path.join(pluginDir, "build", "classes")
const kgClassesDir = path.join(pluginDir, "..", "knowledge-graph", "build", "classes")
const indexCliClass = "eu.infolead.llmhp.graphrag.IndexCli"
const configFile = path.join(pluginDir, "config", "graphrag.yaml")

const FILE_READ_TOOLS = new Set(["read", "glob", "grep"])

type StatusNoticeMode = "per_session" | "per_run" | "off"

interface GraphRagConfig {
  autoUpdate: boolean
  debounceSeconds: number
  graphragBinary: string
  indexRoot: string
  reindexThreshold: number
  preflight: boolean
  statusNotice: StatusNoticeMode
  embedEndpointTimeoutMs: number
  models: GraphragYamlConfig
}

interface Preflight {
  ok: boolean
  reason: string | null
  env: Record<string, string>
}

function parseStatusNotice(raw: string | undefined): StatusNoticeMode {
  const value = (raw ?? "").trim().replace(/^["']|["']$/g, "")
  return value === "per_session" || value === "per_run" || value === "off" ? value : "per_session"
}

function parseIntOr(raw: string | undefined, fallback: number): number {
  const parsed = parseInt((raw ?? "").trim(), 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

function loadConfig(): GraphRagConfig {
  const cfg: GraphRagConfig = {
    autoUpdate: true,
    debounceSeconds: 300,
    graphragBinary: "graphrag",
    indexRoot: "graph-index",
    reindexThreshold: 400,
    preflight: true,
    statusNotice: "per_session",
    embedEndpointTimeoutMs: 2000,
    models: {
      chatApiKeyEnv: "DEEPSEEK_API_KEY",
      embeddingApiKeyEnv: "GRAPHRAG_API_KEY",
      embeddingApiBase: "http://localhost:1234/v1",
    },
  }
  try {
    const raw = readFileSync(configFile, "utf-8")
    cfg.models = parseGraphragYamlConfig(raw)
    for (const line of raw.split("\n")) {
      const t = line.trim()
      if (t.startsWith("auto_update:")) cfg.autoUpdate = t.includes("true")
      else if (t.startsWith("debounce_seconds:")) cfg.debounceSeconds = parseInt(t.split(":")[1]?.trim() ?? "300", 10)
      else if (t.startsWith("graphrag_binary:")) cfg.graphragBinary = t.split(":").slice(1).join(":").trim()
      else if (t.startsWith("index_root:")) cfg.indexRoot = t.split(":")[1]?.trim()
      else if (t.startsWith("reindex_threshold:")) cfg.reindexThreshold = parseIntOr(t.split(":")[1], 400)
      else if (t.startsWith("preflight:")) cfg.preflight = !t.includes("false")
      else if (t.startsWith("status_notice:")) cfg.statusNotice = parseStatusNotice(t.split(":")[1])
      else if (t.startsWith("embed_endpoint_timeout_ms:")) cfg.embedEndpointTimeoutMs = parseIntOr(t.split(":")[1], 2000)
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

function readManifest(root: string, cfg: GraphRagConfig): ManifestV2 | null {
  return readManifestV2(manifestPath(root, cfg))
}

function addToDirtySet(root: string, cfg: GraphRagConfig, file: string): void {
  const mp = manifestPath(root, cfg)
  const rel = path.isAbsolute(file) ? path.relative(root, file) : file
  const manifest = readManifest(root, cfg)
  if (!manifest) {
    mergeManifestV2Atomic(mp, {
      commit: "none",
      timestamp: new Date().toISOString(),
      graphrag_version: "unknown",
      graphrag_binary: cfg.graphragBinary,
      dirty: [rel],
    })
    return
  }
  if (manifest.dirty.includes(rel)) return
  mergeManifestV2Atomic(mp, { dirty: [...manifest.dirty, rel] })
}

function stalenessLine(manifest: ManifestV2 | null, currentVersion: string | null): string {
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

function launchDetached(args: string[], logFile: string, env?: Record<string, string>): void {
  const fd = openSync(logFile, "a")
  const proc = Bun.spawn(args, {
    stdout: fd,
    stderr: fd,
    stdin: "ignore",
    env: env ? { ...process.env, ...env } : process.env,
  })
  proc.unref()
}

// ---------------------------------------------------------------------------
// v1 entrypoint (legacy function form).
// ---------------------------------------------------------------------------
const v1Factory: Plugin = async ({ client, directory, worktree }) => {
  writeLoadCanary("graphrag")
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

  async function checkVersion(): Promise<{ current: string | null; manifest: ManifestV2 | null; match: boolean }> {
    const manifest = readManifest(root, cfg)
    const current = await binaryVersion(cfg.graphragBinary)
    const match = manifest === null || current === null || manifest.graphrag_version === current
    return { current, manifest, match }
  }

  // FS-1: resolve the keys the graphrag CLI needs and prove the embedding
  // endpoint answers before any spawn. GraphRAG 2.7 validates every configured
  // model at start, so a dead endpoint aborts the run before any workflow.
  async function preflight(): Promise<Preflight> {
    const env: Record<string, string> = {}
    const missing: string[] = []
    for (const name of [cfg.models.chatApiKeyEnv, cfg.models.embeddingApiKeyEnv]) {
      const value = await resolveEnvKey(name, root, indexRoot)
      if (value === null) missing.push(name)
      else env[name] = value
    }
    if (missing.length > 0) {
      return { ok: false, reason: `missing env ${missing.join(", ")}`, env }
    }
    const endpoint = cfg.models.embeddingApiBase
    if (!(await probeEndpoint(endpoint, cfg.embedEndpointTimeoutMs))) {
      return { ok: false, reason: `embedding endpoint unreachable at ${endpoint}`, env }
    }
    if (readManifest(root, cfg)?.status === "failed_preflight") {
      mergeManifestV2Atomic(manifestPath(root, cfg), { status: "idle", failure_reason: null })
    }
    return { ok: true, reason: null, env }
  }

  // FS-1 (query): graphrag validates every configured model at query start, so
  // the chat key must resolve; local additionally embeds the query text, which
  // needs the embedding key and a live endpoint. global/drift use chat only.
  async function queryPreflight(mode: string): Promise<Preflight> {
    const env: Record<string, string> = {}
    const chat = await resolveEnvKey(cfg.models.chatApiKeyEnv, root, indexRoot)
    if (!chat) return { ok: false, reason: `missing env ${cfg.models.chatApiKeyEnv}`, env }
    env[cfg.models.chatApiKeyEnv] = chat
    if (mode === "local") {
      const embed = await resolveEnvKey(cfg.models.embeddingApiKeyEnv, root, indexRoot)
      if (embed) env[cfg.models.embeddingApiKeyEnv] = embed
      if (!(await probeEndpoint(cfg.models.embeddingApiBase, cfg.embedEndpointTimeoutMs))) {
        return { ok: false, reason: `embedding endpoint unreachable at ${cfg.models.embeddingApiBase}`, env }
      }
    }
    return { ok: true, reason: null, env }
  }

  // FS-4: lifecycle health appended to the Java status report.
  async function statusBlock(): Promise<string> {
    const manifest = readManifest(root, cfg)
    const lines: string[] = ["lifecycle (ts):"]
    if (!manifest) {
      lines.push("status: missing")
    } else {
      lines.push(`status: ${manifest.status ?? "unknown"}`)
      lines.push(`last_good_build: ${manifest.last_good_build ?? "none"}`)
      lines.push(`consecutive_failures: ${manifest.consecutive_failures ?? 0}`)
      if (manifest.partial_reason) lines.push(`partial_reason: ${manifest.partial_reason}`)
      if (manifest.failure_reason) lines.push(`failure_reason: ${manifest.failure_reason}`)
      lines.push(`dirty: ${manifest.dirty.length}`)
      if (manifest.removed.length > 0) lines.push(`removed: ${manifest.removed.length}`)
      lines.push(`full_reindex: ${manifest.full_reindex}`)
      const reconciled = readReconcileState(manifestPath(root, cfg))
      if (reconciled) {
        lines.push(`last reconciled: ${reconciled.timestamp} (dirty=${reconciled.dirty} removed=${reconciled.removed} structural=${reconciled.structural})`)
      }
    }
    const up = await probeEndpoint(cfg.models.embeddingApiBase, cfg.embedEndpointTimeoutMs)
    lines.push(`embedding endpoint: ${up ? "up" : "down"} at ${cfg.models.embeddingApiBase}`)
    return lines.join("\n")
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

          // One notice per session; statusNotice covers both missing and stale,
          // and stays silent while a build is running.
          if (cfg.statusNotice !== "off") {
            const note = statusNotice(readManifest(root, cfg))
            if (note) await injectContext(sessionId, note)
          }
          break
        }

        case "file.edited": {
          const file = (event.properties as { file?: string })?.file ?? ""
          if (!file) break
          const absPath = path.isAbsolute(file) ? file : path.resolve(root, file)
          if (isRelevantFile(root, absPath)) addToDirtySet(root, cfg, file)
          else if (isStructuralFile(root, absPath)) markFullReindex(manifestPath(root, cfg))
          break
        }

        case "file.watcher.updated": {
          const props = event.properties as { file?: string; event?: string }
          const file = props?.file ?? ""
          if (!file) break
          const absPath = path.isAbsolute(file) ? file : path.resolve(root, file)
          const rel = path.relative(root, absPath)
          // A deleted source must leave the index. Ignoring `unlink` was why a
          // removed chapter stayed in the graph forever.
          if (props?.event === "unlink") {
            if (isRelevantFile(root, absPath)) markRemoved(manifestPath(root, cfg), rel)
            break
          }
          if (isRelevantFile(root, absPath)) addToDirtySet(root, cfg, file)
          else if (isStructuralFile(root, absPath)) markFullReindex(manifestPath(root, cfg))
          break
        }

        case "session.idle": {
          if (!cfg.autoUpdate) break
          // Reconcile with git before deciding: the hooks below only see the
          // edits this process makes, so a checkout or an external editor would
          // otherwise leave the dirty set empty while the tree changed.
          const before = readManifest(root, cfg)
          reconcileFromGit(root, before, manifestPath(root, cfg))
          const manifest = readManifest(root, cfg)
          const work = manifest
            ? manifest.dirty.length + manifest.removed.length + (manifest.full_reindex ? 1 : 0)
            : 0
          if (work === 0) break
          const now = Date.now()
          const binPath = await resolveBinary(cfg.graphragBinary)
          if (!binPath) {
            logger.info("skipping auto-update — graphrag binary not on PATH")
            break
          }
          // Preflight before the slot claim: it is cheap and keeps a doomed run
          // from burning the debounce window.
          let spawnEnv: Record<string, string> = {}
          if (cfg.preflight) {
            const pre = await preflight()
            if (!pre.ok) {
              const reason = pre.reason ?? "unknown"
              mergeManifestV2Atomic(manifestPath(root, cfg), { status: "failed_preflight", failure_reason: reason })
              logger.info(`preflight blocked auto-update: ${reason}`)
              break
            }
            spawnEnv = pre.env
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
          ], logFile, spawnEnv)
          const label = manifest ? `${work} change signals` : "lazy init"
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

      const manifest = readManifest(root, cfg)
      const rel = path.relative(root, absPath)
      if (!manifest) {
        mergeManifestV2Atomic(manifestPath(root, cfg), {
          commit: "none",
          timestamp: new Date().toISOString(),
          graphrag_version: "unknown",
          graphrag_binary: cfg.graphragBinary,
          dirty: [rel],
        })
        return
      }

      if (!manifest.dirty.includes(rel)) {
        mergeManifestV2Atomic(manifestPath(root, cfg), { dirty: [...manifest.dirty, rel] })
      }
    },

    tool: {
      graphrag: tool({
        description: "GraphRAG semantic index over the project corpus. Routing: use grep for exact strings, labels, and file anchors; use graphrag local/global/drift only for thematic, cross-chapter, community, or semantic-relationship questions. Queries run an LLM at query time (seconds to minutes). Modes: local=entity-focused, global=corpus-wide themes, drift=claims+hybrid, status=index state and lifecycle health, index=build/update in background.",
        args: {
          mode: tool.schema.enum(["local", "global", "drift", "status", "index"])
            .describe("local=entity-focused, global=corpus-wide themes, drift=claims+hybrid, status=index state and lifecycle health, index=build/update in background"),
          query: tool.schema.string().optional()
            .describe("Search query (required for local/global/drift)"),
        },
        async execute(args, context) {
          const mode = args.mode as string

          if (mode === "status") {
            const out = await $`java --class-path ${javaCp} ${indexCliClass} status ${root} ${configFile}`.nothrow().text()
            const javaOut = out.trim() || "No index state available."
            return `${javaOut}\n──────────\n${await statusBlock()}`
          }

          if (mode === "index") {
            // FS-1: a doomed spawn is skipped and its reason recorded.
            let spawnEnv: Record<string, string> = {}
            if (cfg.preflight) {
              const pre = await preflight()
              if (!pre.ok) {
                const reason = pre.reason ?? "unknown"
                mergeManifestV2Atomic(manifestPath(root, cfg), { status: "failed_preflight", failure_reason: reason })
                return `Preflight failed: ${reason}. Fix it (export the key in the project env / start the embedding server), then retry mode=index.`
              }
              spawnEnv = pre.env
            }
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
            ], logFile, spawnEnv)
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

          if (!isQueryMode(mode)) return `Unknown mode: ${mode}.`
          // FS-5: a mode whose artifacts are absent would exit as a raw
          // traceback inside graphrag, so refuse with the missing list instead.
          const missing = gateMissing(indexRoot, mode)
          if (missing.length > 0) {
            return `index incomplete: ${mode} requires ${missing.join(", ")}. Run mode=index to build.`
          }

          const pre = await queryPreflight(mode)
          const result = pre.ok
            ? await $`${binPath} query --method ${mode} --query ${query} --root ${indexRoot} --config ${settingsFile}`
                .env({ ...process.env, ...pre.env })
                .nothrow()
                .text()
            : ""
          const prefix = stalenessLine(manifest, current)
          if (!pre.ok) return `Query refused: ${pre.reason}. Fix it, then retry.`
          if (!result.trim()) return `${prefix}\nQuery returned no output. Check logs in ${logDir}.`
          return `${prefix}\n\n${result.trim()}`
        },
      }),
    },
  }
}

// ---------------------------------------------------------------------------
// v2 entrypoint (docs/build/plugins/migrate-v1): `id` + `setup(ctx)`, with v1
// served by `server`. v2 differences: no `client` (root from `ctx.location`,
// logging to stderr), the v1 `event` hook becomes a `ctx.event.subscribe`
// iterator (`{ type, properties }`), `tool.execute.after` →
// `ctx.tool.hook("execute.after")`, and the tool map → `ctx.tool.transform`.
// ---------------------------------------------------------------------------
function consoleLogger(service: string) {
  return {
    debug: (_m: string) => {},
    info: (m: string) => console.error(`[${service}] ${m}`),
    warn: (m: string) => console.error(`[${service}] WARN ${m}`),
    error: (m: string) => console.error(`[${service}] ERROR ${m}`),
  }
}

export default {
  id: "graphrag",

  async setup(ctx: any) {
    writeLoadCanary("graphrag")
    const logger = consoleLogger("graphrag")
    const cfg = loadConfig()
    const root: string = ctx.location?.project?.canonical ?? ctx.location?.directory
    const indexRoot = path.join(root, cfg.indexRoot)
    const settingsFile = path.join(indexRoot, "settings.yaml")
    const logDir = path.join(indexRoot, "logs")

    const javaCp = `${classesDir}:${kgClassesDir}`

    async function injectContext(sessionId: string, text: string) {
      try {
        await ctx.session.synthetic({ sessionID: sessionId, text })
      } catch (e) {
        logger.error(`inject failed: ${(e as Error).message}`)
      }
    }

    async function checkVersion(): Promise<{ current: string | null; manifest: ManifestV2 | null; match: boolean }> {
      const manifest = readManifest(root, cfg)
      const current = await binaryVersion(cfg.graphragBinary)
      const match = manifest === null || current === null || manifest.graphrag_version === current
      return { current, manifest, match }
    }

    // FS-1: keys + embedding endpoint must hold before any spawn (see the v1
    // entrypoint; both paths stay in parity).
    async function preflight(): Promise<Preflight> {
      const env: Record<string, string> = {}
      const missing: string[] = []
      for (const name of [cfg.models.chatApiKeyEnv, cfg.models.embeddingApiKeyEnv]) {
        const value = await resolveEnvKey(name, root, indexRoot)
        if (value === null) missing.push(name)
        else env[name] = value
      }
      if (missing.length > 0) {
        return { ok: false, reason: `missing env ${missing.join(", ")}`, env }
      }
      const endpoint = cfg.models.embeddingApiBase
      if (!(await probeEndpoint(endpoint, cfg.embedEndpointTimeoutMs))) {
        return { ok: false, reason: `embedding endpoint unreachable at ${endpoint}`, env }
      }
      if (readManifest(root, cfg)?.status === "failed_preflight") {
        mergeManifestV2Atomic(manifestPath(root, cfg), { status: "idle", failure_reason: null })
      }
      return { ok: true, reason: null, env }
    }

    // FS-1 (query): graphrag validates every configured model at query start,
    // so the chat key must resolve; local additionally embeds the query text,
    // which needs the embedding key and a live endpoint. global/drift use chat only.
    async function queryPreflight(mode: string): Promise<Preflight> {
      const env: Record<string, string> = {}
      const chat = await resolveEnvKey(cfg.models.chatApiKeyEnv, root, indexRoot)
      if (!chat) return { ok: false, reason: `missing env ${cfg.models.chatApiKeyEnv}`, env }
      env[cfg.models.chatApiKeyEnv] = chat
      if (mode === "local") {
        const embed = await resolveEnvKey(cfg.models.embeddingApiKeyEnv, root, indexRoot)
        if (embed) env[cfg.models.embeddingApiKeyEnv] = embed
        if (!(await probeEndpoint(cfg.models.embeddingApiBase, cfg.embedEndpointTimeoutMs))) {
          return { ok: false, reason: `embedding endpoint unreachable at ${cfg.models.embeddingApiBase}`, env }
        }
      }
      return { ok: true, reason: null, env }
    }

    // FS-4: lifecycle health appended to the Java status report.
    async function statusBlock(): Promise<string> {
      const manifest = readManifest(root, cfg)
      const lines: string[] = ["lifecycle (ts):"]
      if (!manifest) {
        lines.push("status: missing")
      } else {
        lines.push(`status: ${manifest.status ?? "unknown"}`)
        lines.push(`last_good_build: ${manifest.last_good_build ?? "none"}`)
        lines.push(`consecutive_failures: ${manifest.consecutive_failures ?? 0}`)
        if (manifest.partial_reason) lines.push(`partial_reason: ${manifest.partial_reason}`)
        if (manifest.failure_reason) lines.push(`failure_reason: ${manifest.failure_reason}`)
        lines.push(`dirty: ${manifest.dirty.length}`)
        if (manifest.removed.length > 0) lines.push(`removed: ${manifest.removed.length}`)
        lines.push(`full_reindex: ${manifest.full_reindex}`)
        const reconciled = readReconcileState(manifestPath(root, cfg))
        if (reconciled) {
          lines.push(`last reconciled: ${reconciled.timestamp} (dirty=${reconciled.dirty} removed=${reconciled.removed} structural=${reconciled.structural})`)
        }
      }
      const up = await probeEndpoint(cfg.models.embeddingApiBase, cfg.embedEndpointTimeoutMs)
      lines.push(`embedding endpoint: ${up ? "up" : "down"} at ${cfg.models.embeddingApiBase}`)
      return lines.join("\n")
    }

    const controller = new AbortController()
    void (async () => {
      try {
        for await (const input of ctx.event.subscribe({ signal: controller.signal })) {
          if (controller.signal.aborted) break
          const type = input?.type
          const props = input?.properties ?? input?.data ?? {}

          if (type === "session.created") {
            const sessionId: string | undefined = props?.sessionID ?? props?.info?.id
            if (!sessionId) continue

            const binPath = await resolveBinary(cfg.graphragBinary)
            if (!binPath) {
              logger.info("binary not found on PATH")
              await injectContext(sessionId,
                "graphrag not on PATH — start opencode from the project terminal so direnv loads, or set graphrag_binary in config.")
              continue
            }
            const version = await binaryVersion(cfg.graphragBinary)
            logger.info(`binary=${binPath} version=${version ?? "unknown"}`)

            // One notice per session; statusNotice covers both missing and stale.
            if (cfg.statusNotice !== "off") {
              const note = statusNotice(readManifest(root, cfg))
              if (note) await injectContext(sessionId, note)
            }
          } else if (type === "file.edited") {
            const file = props?.file ?? ""
            if (!file) continue
            const absPath = path.isAbsolute(file) ? file : path.resolve(root, file)
            if (isRelevantFile(root, absPath)) addToDirtySet(root, cfg, file)
            else if (isStructuralFile(root, absPath)) markFullReindex(manifestPath(root, cfg))
          } else if (type === "file.watcher.updated") {
            const file = props?.file ?? ""
            if (!file) continue
            const absPath = path.isAbsolute(file) ? file : path.resolve(root, file)
            const rel = path.relative(root, absPath)
            if (props?.event === "unlink") {
              if (isRelevantFile(root, absPath)) markRemoved(manifestPath(root, cfg), rel)
              continue
            }
            if (isRelevantFile(root, absPath)) addToDirtySet(root, cfg, file)
            else if (isStructuralFile(root, absPath)) markFullReindex(manifestPath(root, cfg))
          } else if (type === "session.idle") {
            if (!cfg.autoUpdate) continue
            // Reconcile with git before deciding (see the v1 handler).
            const before = readManifest(root, cfg)
            reconcileFromGit(root, before, manifestPath(root, cfg))
            const manifest = readManifest(root, cfg)
            const work = manifest
              ? manifest.dirty.length + manifest.removed.length + (manifest.full_reindex ? 1 : 0)
              : 0
            if (work === 0) continue
            const now = Date.now()
            const binPath = await resolveBinary(cfg.graphragBinary)
            if (!binPath) {
              logger.info("skipping auto-update — graphrag binary not on PATH")
              continue
            }
            // Preflight before the slot claim: cheap, and keeps a doomed run from
            // burning the debounce window.
            let spawnEnv: Record<string, string> = {}
            if (cfg.preflight) {
              const pre = await preflight()
              if (!pre.ok) {
                const reason = pre.reason ?? "unknown"
                mergeManifestV2Atomic(manifestPath(root, cfg), { status: "failed_preflight", failure_reason: reason })
                logger.info(`preflight blocked auto-update: ${reason}`)
                continue
              }
              spawnEnv = pre.env
            }
            if (!(await claimSpawnSlot(indexRoot, cfg.debounceSeconds * 1000))) {
              logger.info("skipping auto-update — indexer already running or launched recently")
              continue
            }
            try {
              mkdirSync(logDir, { recursive: true })
            } catch { /* exists */ }
            const logFile = path.join(logDir, `update-${now}.log`)
            launchDetached([
              "java", "--class-path", javaCp, indexCliClass,
              "update", root, configFile,
            ], logFile, spawnEnv)
            const label = manifest ? `${work} change signals` : "lazy init"
            logger.info(`incremental update launched (${label}), log: ${logFile}`)
          }
        }
      } catch {
        // the event stream is best-effort
      }
    })()

    await ctx.tool.hook("execute.after", async (event: any) => {
      const toolName: string = event?.tool ?? event?.name
      if (!FILE_READ_TOOLS.has(toolName)) return
      const input = event?.input ?? event?.args ?? {}
      const filePath = (input.filePath ?? input.path ?? input.pattern ?? "") as string
      if (!filePath) return
      const absPath = path.isAbsolute(filePath) ? filePath : path.resolve(root, filePath)
      if (!absPath.startsWith(root)) return
      if (!isRelevantFile(root, absPath)) return

      const manifest = readManifest(root, cfg)
      const rel = path.relative(root, absPath)
      if (!manifest) {
        mergeManifestV2Atomic(manifestPath(root, cfg), {
          commit: "none",
          timestamp: new Date().toISOString(),
          graphrag_version: "unknown",
          graphrag_binary: cfg.graphragBinary,
          dirty: [rel],
        })
        return
      }

      if (!manifest.dirty.includes(rel)) {
        mergeManifestV2Atomic(manifestPath(root, cfg), { dirty: [...manifest.dirty, rel] })
      }
    })

    await ctx.tool.transform((editor: any) => {
      editor.add({
        name: "graphrag",
        description: "GraphRAG semantic index over the project corpus. Routing: use grep for exact strings, labels, and file anchors; use graphrag local/global/drift only for thematic, cross-chapter, community, or semantic-relationship questions. Queries run an LLM at query time (seconds to minutes). Modes: local=entity-focused, global=corpus-wide themes, drift=claims+hybrid, status=index state and lifecycle health, index=build/update in background.",
        input: {
          type: "object",
          properties: {
            mode: {
              type: "string",
              enum: ["local", "global", "drift", "status", "index"],
              description: "local=entity-focused, global=corpus-wide themes, drift=claims+hybrid, status=index state and lifecycle health, index=build/update in background",
            },
            query: { type: "string", description: "Search query (required for local/global/drift)" },
          },
          required: ["mode"],
          additionalProperties: false,
        },
        async execute(args: any) {
          const mode = args.mode as string

          if (mode === "status") {
            const out = await $`java --class-path ${javaCp} ${indexCliClass} status ${root} ${configFile}`.nothrow().text()
            const javaOut = out.trim() || "No index state available."
            return { content: `${javaOut}\n──────────\n${await statusBlock()}` }
          }

          if (mode === "index") {
            // FS-1: a doomed spawn is skipped and its reason recorded.
            let spawnEnv: Record<string, string> = {}
            if (cfg.preflight) {
              const pre = await preflight()
              if (!pre.ok) {
                const reason = pre.reason ?? "unknown"
                mergeManifestV2Atomic(manifestPath(root, cfg), { status: "failed_preflight", failure_reason: reason })
                return { content: `Preflight failed: ${reason}. Fix it (export the key in the project env / start the embedding server), then retry mode=index.` }
              }
              spawnEnv = pre.env
            }
            // Route through the same cross-session throttle as auto-update.
            if (!(await claimSpawnSlot(indexRoot, cfg.debounceSeconds * 1000))) {
              return { content: "An index job is already running or was launched too recently. Try again later." }
            }
            const isInit = !existsSync(manifestPath(root, cfg))
            try {
              mkdirSync(logDir, { recursive: true })
            } catch { /* exists */ }
            const logFile = path.join(logDir, `${isInit ? "init" : "update"}-${Date.now()}.log`)
            launchDetached([
              "java", "--class-path", javaCp, indexCliClass,
              isInit ? "init" : "update", root, configFile, pluginDir,
            ], logFile, spawnEnv)
            return { content: `Index ${isInit ? "init" : "update"} started in background. Log: ${logFile}. Check progress with mode=status.` }
          }

          const query = (args.query ?? "").trim()
          if (!query) return { content: "Query required for local/global/drift modes." }

          const binPath = await resolveBinary(cfg.graphragBinary)
          if (!binPath) {
            return { content: "graphrag not on PATH — start opencode from the project terminal so direnv loads, or set graphrag_binary in config." }
          }
          if (!existsSync(settingsFile)) {
            return { content: "No index found. Build one with mode=index first." }
          }

          const { current, manifest, match } = await checkVersion()
          if (!match && manifest) {
            return { content: `REFUSED: index was built with graphrag ${manifest.graphrag_version} but current binary is ${current}. Rebuild with mode=index before querying.` }
          }

          if (!isQueryMode(mode)) return { content: `Unknown mode: ${mode}.` }
          // FS-5: refuse a mode whose artifacts are absent instead of letting
          // graphrag die with a raw traceback.
          const missing = gateMissing(indexRoot, mode)
          if (missing.length > 0) {
            return { content: `index incomplete: ${mode} requires ${missing.join(", ")}. Run mode=index to build.` }
          }

          const pre = await queryPreflight(mode)
          const result = pre.ok
            ? await $`${binPath} query --method ${mode} --query ${query} --root ${indexRoot} --config ${settingsFile}`
                .env({ ...process.env, ...pre.env })
                .nothrow()
                .text()
            : ""
          const prefix = stalenessLine(manifest, current)
          if (!pre.ok) return { content: `Query refused: ${pre.reason}. Fix it, then retry.` }
          if (!result.trim()) return { content: `${prefix}\nQuery returned no output. Check logs in ${logDir}.` }
          return { content: `${prefix}\n\n${result.trim()}` }
        },
      })
    })

    return () => controller.abort()
  },

  async server(input: any, options?: any) {
    return v1Factory(input, options)
  },
}
