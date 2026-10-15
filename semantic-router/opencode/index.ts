import { type Plugin, tool } from "@opencode-ai/plugin"
import path from "path"
import fs from "fs"
import os from "os"
import { createLogger, type PluginLogger } from "../../shared/plugin-logger"
import {
  ConfigError,
  DEFAULT_LEXICAL_MARGIN,
  DEFAULT_LEXICAL_THRESHOLD,
  DEFAULT_THRESHOLD,
  DEFAULT_TIMEOUT_MS,
  buildLexicalIndex,
  centroid,
  configSignature,
  cosine,
  hashString,
  matchLexical,
  matchRoute,
  mergeConfigs,
  parseConfig,
  routeTextForInjection,
  setCosine,
  tokenize,
  truncateForEmbedding,
  type EncoderConfig,
  type IndexedRoute,
  type LexicalRoute,
  type RouteMatch,
  type RouterConfig,
} from "./helpers"
import { writeLoadCanary } from "../../shared/load-canary"

/** Disable the plugin when "0". */
const DISABLED_ENV = "LLMHP_SEMANTIC_ROUTER"
/** Explicit config path (else project/global candidates are merged). */
const CONFIG_ENV = "LLMHP_SEMANTIC_ROUTER_CONFIG"
const BASE_URL_ENV = "LLMHP_SEMANTIC_ROUTER_BASE_URL"
const MODEL_ENV = "LLMHP_SEMANTIC_ROUTER_MODEL"
const API_KEY_ENV = "LLMHP_SEMANTIC_ROUTER_API_KEY"
const THRESHOLD_ENV = "LLMHP_SEMANTIC_ROUTER_THRESHOLD"
const MARGIN_ENV = "LLMHP_SEMANTIC_ROUTER_MARGIN"
const TIMEOUT_ENV = "LLMHP_SEMANTIC_ROUTER_TIMEOUT_MS"
/** After an embedding failure, stop retrying for this long (fail-open). */
const FAILURE_COOLDOWN_MS = Number(process.env.LLMHP_SEMANTIC_ROUTER_COOLDOWN_MS ?? 60_000)
/** Cap on cached query embeddings. */
const QUERY_CACHE_MAX = 256

// ---------------------------------------------------------------------------
// Router engine shared by both entrypoints: config loading/merging, the
// embedding index with lexical fallback, and classification. The v1 and v2
// entrypoints differ only in how they expose hooks and tools, so they both
// build one engine and wire their own surface around it.
// ---------------------------------------------------------------------------
function createEngine(logger: PluginLogger, root: string, directory: string) {
  // ── config ────────────────────────────────────────────────────────────────

  function configPaths(): string[] {
    const explicit = process.env[CONFIG_ENV]
    if (explicit) return [path.isAbsolute(explicit) ? explicit : path.resolve(root, explicit)]
    // `worktree` can be a parent of `directory` (e.g. a monorepo or a non-git
    // subdir), so search both.
    const dirs = [root]
    if (directory && directory !== root) dirs.push(directory)
    const out: string[] = []
    for (const d of dirs) {
      out.push(path.join(d, ".semantic-router", "routes.json"))
      out.push(path.join(d, ".opencode", "semantic-router.json"))
    }
    out.push(path.join(os.homedir(), ".config", "opencode", "semantic-router.json"))
    return out
  }

  interface LoadResult {
    config: RouterConfig | null
    sources: string[]
    error: string | null
  }

  function applyEnvOverrides(cfg: RouterConfig): RouterConfig {
    const baseURL = process.env[BASE_URL_ENV]
    const model = process.env[MODEL_ENV]
    const apiKey = process.env[API_KEY_ENV]
    const threshold = process.env[THRESHOLD_ENV]
    const margin = process.env[MARGIN_ENV]
    const timeout = process.env[TIMEOUT_ENV]
    const overrides = {
      ...(baseURL ? { baseURL: baseURL.replace(/\/+$/, "") } : {}),
      ...(model ? { model } : {}),
      ...(apiKey !== undefined ? { apiKey } : {}),
      ...(timeout ? { timeoutMs: Number(timeout) } : {}),
    }
    let encoder = cfg.encoder
    if (Object.keys(overrides).length) {
      const merged = { ...(cfg.encoder ?? {}), ...overrides }
      encoder = merged.baseURL && merged.model ? (merged as EncoderConfig) : cfg.encoder
    }
    return {
      ...cfg,
      encoder,
      defaultThreshold: threshold ? Number(threshold) : cfg.defaultThreshold,
      defaultMargin: margin ? Number(margin) : cfg.defaultMargin,
    }
  }

  function loadConfig(): LoadResult {
    let merged: RouterConfig | null = null
    const sources: string[] = []
    let error: string | null = null
    for (const p of configPaths()) {
      if (!fs.existsSync(p)) continue
      try {
        merged = mergeConfigs(merged, parseConfig(JSON.parse(fs.readFileSync(p, "utf-8"))))
        sources.push(p)
      } catch (e) {
        error = `${p}: ${e instanceof ConfigError ? e.message : String(e)}`
      }
    }
    if (merged) merged = applyEnvOverrides(merged)
    return { config: merged, sources, error }
  }

  let loaded = loadConfig()
  let index: IndexedRoute[] | null = null
  let lexIndex: LexicalRoute[] | null = null
  let disabledUntil = 0
  let activeEncoder: EncoderConfig | null = null
  let usingLexical = false
  /** Resolved model per encoder baseURL when config uses "auto". */
  const autoModels = new Map<string, string>()
  const activeRoutes = new Map<string, RouteMatch | null>()
  const queryCache = new Map<string, number[]>()

  logger.info(
    loaded.config
      ? `plugin active — routes=${loaded.config.routes.length} ` +
        (loaded.config.encoder
          ? `encoder=${loaded.config.encoder.baseURL} (${loaded.config.encoder.model})${loaded.config.fallbackEncoders.length ? ` +${loaded.config.fallbackEncoders.length} fallback` : ""}`
          : "lexical-only (no encoder)")
      : `plugin active — no routes configured (inert)${loaded.error ? `; ${loaded.error}` : ""}`,
  )

  // ── embeddings ────────────────────────────────────────────────────────────

  /** Primary encoder then fallbacks, deduplicated. */
  function encoderCandidates(): EncoderConfig[] {
    const cfg = loaded.config
    if (!cfg) return []
    const seen = new Set<string>()
    return [cfg.encoder, ...cfg.fallbackEncoders].filter((e): e is EncoderConfig => e != null).filter((e) => {
      const k = `${e.baseURL}|${e.model}`
      if (seen.has(k)) return false
      seen.add(k)
      return true
    })
  }

  /** "auto" picks the encoder's currently loaded model from /v1/models, so a
   * hardcoded model name cannot go stale when the server swaps models. */
  async function encoderModel(enc: EncoderConfig): Promise<string> {
    if (enc.model !== "auto") return enc.model
    const cached = autoModels.get(enc.baseURL)
    if (cached) return cached
    const res = await fetch(`${enc.baseURL}/models`, {
      headers: enc.apiKey ? { authorization: `Bearer ${enc.apiKey}` } : {},
    })
    if (!res.ok) throw new Error(`models HTTP ${res.status}`)
    const json: any = await res.json()
    const list: any[] = Array.isArray(json?.data) ? json.data : []
    const pick = list.find((m) => m?.loaded) ?? list[0]
    if (!pick?.id) throw new Error("no models available at encoder endpoint")
    autoModels.set(enc.baseURL, String(pick.id))
    logger.info(`encoder model auto-resolved to ${pick.id} at ${enc.baseURL}`)
    return String(pick.id)
  }

  async function embedRequestWith(enc: EncoderConfig, input: string | string[]): Promise<number[][]> {
    const model = await encoderModel(enc)
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), enc.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    try {
      const res = await fetch(`${enc.baseURL}/embeddings`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(enc.apiKey ? { authorization: `Bearer ${enc.apiKey}` } : {}),
        },
        body: JSON.stringify({ model, input }),
        signal: ctrl.signal,
      })
      if (!res.ok) throw new Error(`embeddings HTTP ${res.status}`)
      const json: any = await res.json()
      const data = json?.data
      if (!Array.isArray(data)) throw new Error("embeddings response missing data[]")
      return data.map((d: any) => d?.embedding).filter((e: any) => Array.isArray(e) && e.length > 0)
    } finally {
      clearTimeout(timer)
    }
  }

  /** Batch when the endpoint supports it, else one request per utterance. */
  async function embedManyWith(enc: EncoderConfig, texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return []
    try {
      const batch = await embedRequestWith(enc, texts)
      if (batch.length === texts.length) return batch
    } catch {
      // fall through to sequential
    }
    const out: number[][] = []
    for (const t of texts) {
      const one = await embedRequestWith(enc, t)
      if (!one[0]) throw new Error("embeddings response contained no vector")
      out.push(one[0])
    }
    return out
  }

  function embeddingsFile(): string {
    return path.join(root, ".semantic-router", "embeddings.json")
  }

  function loadCachedVectors(sig: string): Record<string, number[]> {
    try {
      const j = JSON.parse(fs.readFileSync(embeddingsFile(), "utf-8"))
      if (j?.signature === sig && j.vectors && typeof j.vectors === "object") return j.vectors
    } catch {
      // absent or unreadable → recompute
    }
    return {}
  }

  function saveCachedVectors(sig: string, vectors: Record<string, number[]>): void {
    try {
      const dir = path.join(root, ".semantic-router")
      fs.mkdirSync(dir, { recursive: true })
      const gi = path.join(dir, ".gitignore")
      if (!fs.existsSync(gi)) fs.writeFileSync(gi, "embeddings.json\n")
      fs.writeFileSync(embeddingsFile(), JSON.stringify({ signature: sig, vectors }))
    } catch (e) {
      logger.warn(`could not persist embeddings: ${(e as Error).message}`)
    }
  }

  /** Build the route index with the first encoder that works (cache first, so
   * a warm index needs no request). Throws when every encoder is unreachable. */
  async function ensureIndex(): Promise<IndexedRoute[]> {
    if (index) return index
    const cfg = loaded.config
    if (!cfg) return []
    let lastErr: unknown
    for (const enc of encoderCandidates()) {
      const sig = configSignature(cfg, enc)
      const vectors = loadCachedVectors(sig)
      const missing: Array<{ hash: string; text: string }> = []
      for (const r of cfg.routes) {
        for (const u of r.utterances) {
          const h = hashString(u)
          if (!vectors[h]) missing.push({ hash: h, text: u })
        }
      }
      if (missing.length) {
        try {
          const embedded = await embedManyWith(enc, missing.map((m) => m.text))
          missing.forEach((m, i) => { vectors[m.hash] = embedded[i] })
          saveCachedVectors(sig, vectors)
        } catch (e) {
          lastErr = e
          continue // try the next encoder
        }
      }
      activeEncoder = enc
      index = cfg.routes.map((r) => ({
        route: r,
        centroid: centroid(r.utterances.map((u) => vectors[hashString(u)])),
      }))
      return index
    }
    throw lastErr ?? new Error("no encoder reachable")
  }

  /** Embed a query, trying the last-good encoder first then the rest. */
  async function embedQuery(text: string): Promise<number[]> {
    const cfg = loaded.config!
    const seen = new Set<string>()
    const order = [...(activeEncoder ? [activeEncoder] : []), ...encoderCandidates()]
    let lastErr: unknown
    for (const enc of order) {
      const k = `${enc.baseURL}|${enc.model}`
      if (seen.has(k)) continue
      seen.add(k)
      const key = `${configSignature(cfg, enc)}::${hashString(text)}`
      const hit = queryCache.get(key)
      if (hit) { activeEncoder = enc; return hit }
      try {
        const vec = (await embedRequestWith(enc, text))[0]
        if (!vec) throw new Error("embeddings response contained no vector")
        activeEncoder = enc
        if (queryCache.size >= QUERY_CACHE_MAX) {
          const first = queryCache.keys().next().value
          if (first !== undefined) queryCache.delete(first)
        }
        queryCache.set(key, vec)
        return vec
      } catch (e) {
        lastErr = e
      }
    }
    throw lastErr ?? new Error("no encoder reachable")
  }

  function lexicalIndex(): LexicalRoute[] {
    if (lexIndex) return lexIndex
    const cfg = loaded.config
    if (!cfg) return []
    lexIndex = buildLexicalIndex(cfg)
    return lexIndex
  }

  /**
   * Classify a message. Embeddings first; on failure fall back to the local
   * lexical matcher (never fail-closed). Returns the mode and all candidate
   * scores so the tools can show what happened.
   */
  async function classifyDetailed(text: string): Promise<{
    match: RouteMatch | null
    mode: "embeddings" | "lexical"
    candidates: Array<{ name: string; score: number }>
  }> {
    const cfg = loaded.config!
    const trimmed = truncateForEmbedding(text)
    if (!trimmed) return { match: null, mode: usingLexical ? "lexical" : "embeddings", candidates: [] }

    if (Date.now() >= disabledUntil) {
      try {
        const idx = await ensureIndex()
        const vec = await embedQuery(trimmed)
        const candidates = idx
          .map(({ route, centroid: c }) => ({ name: route.name, score: Number(cosine(vec, c).toFixed(4)) }))
          .sort((a, b) => b.score - a.score)
        usingLexical = false
        return { match: matchRoute(vec, idx, cfg.defaultThreshold, cfg.defaultMargin), mode: "embeddings", candidates }
      } catch (e) {
        disabledUntil = Date.now() + FAILURE_COOLDOWN_MS
        usingLexical = true
        logger.warn(`embeddings unavailable → lexical fallback for ${Math.round(FAILURE_COOLDOWN_MS / 1000)}s: ${(e as Error).message}`)
      }
    }

    const li = lexicalIndex()
    const qt = new Set(tokenize(trimmed))
    const candidates = li
      .map(({ route, tokens }) => ({ name: route.name, score: Number(setCosine(qt, tokens).toFixed(4)) }))
      .sort((a, b) => b.score - a.score)
    return { match: matchLexical(trimmed, li, cfg.lexicalThreshold, cfg.lexicalMargin), mode: "lexical", candidates }
  }

  async function classify(text: string): Promise<RouteMatch | null> {
    return (await classifyDetailed(text)).match
  }

  function reload(): void {
    loaded = loadConfig()
    index = null
    lexIndex = null
    disabledUntil = 0
    activeEncoder = null
    usingLexical = false
    autoModels.clear()
    activeRoutes.clear()
    queryCache.clear()
  }

  // ── engine API ─────────────────────────────────────────────────────────────

  // Getters keep the reassignable state live across `reload()` and index builds.
  return {
    get loaded() { return loaded },
    get usingLexical() { return usingLexical },
    get activeEncoder() { return activeEncoder },
    get index() { return index },
    get disabledUntil() { return disabledUntil },
    queryCache,
    activeRoutes,
    classify,
    classifyDetailed,
    reload,
    configPaths,
    embeddingsFile,
    routeTextForInjection,
  }
}

// ---------------------------------------------------------------------------
// v1 entrypoint (legacy function form).
// ---------------------------------------------------------------------------
const v1Factory: Plugin = async ({ client, directory, worktree }) => {
  writeLoadCanary("semantic-router")
  const logger = createLogger(client, "semantic-router")
  const root = worktree ?? directory

  if (process.env[DISABLED_ENV] === "0") {
    logger.info("plugin disabled via LLMHP_SEMANTIC_ROUTER=0")
    return {}
  }

  const e = createEngine(logger, root, directory)

  logger.info(
    e.loaded.config
      ? `plugin active — routes=${e.loaded.config.routes.length} ` +
        (e.loaded.config.encoder
          ? `encoder=${e.loaded.config.encoder.baseURL} (${e.loaded.config.encoder.model})${e.loaded.config.fallbackEncoders.length ? ` +${e.loaded.config.fallbackEncoders.length} fallback` : ""}`
          : "lexical-only (no encoder)")
      : `plugin active — no routes configured (inert)${e.loaded.error ? `; ${e.loaded.error}` : ""}`,
  )

  return {
    "chat.message": async (
      input: { sessionID: string },
      output: { parts: Array<{ type: string; text: string }> },
    ) => {
      if (!e.loaded.config) return
      const textPart = output.parts?.find((p) => p.type === "text" && typeof p.text === "string" && p.text.trim())
      if (!textPart) return
      const match = await e.classify(textPart.text)
      e.activeRoutes.set(input.sessionID, match)
      if (match) logger.info(`session ${input.sessionID} → route "${match.name}" (${match.score.toFixed(3)})`)
    },

    "experimental.chat.system.transform": async (
      input: { sessionID?: string },
      output: { system: string[] },
    ) => {
      const sid = input.sessionID
      if (!sid) return
      const match = e.activeRoutes.get(sid)
      if (!match) return
      const block = e.routeTextForInjection(match)
      output.system = Array.isArray(output.system) ? [block, ...output.system] : [block]
    },

    "tool.execute.before": async (input: { tool: string; sessionID: string }) => {
      const match = e.activeRoutes.get(input.sessionID)
      const deny = match?.route.denyTools
      if (deny && deny.includes(input.tool)) {
        throw new Error(
          `SEMANTIC_ROUTER: tool "${input.tool}" is disabled while route "${match!.name}" is active. ` +
          `Complete the request without it, or rephrase if this is a different kind of task.`,
        )
      }
    },

    tool: {
      "semantic-route": tool({
        description:
          "Classify a query against the configured semantic routes and report the winning route, its " +
          "similarity score, and all candidates. Use to debug routing or check intent before acting.",
        args: {
          question: tool.schema.string().describe("Query text to classify"),
        },
        async execute({ question }: { question: string }) {
          const cfg = e.loaded.config
          if (!cfg) {
            return JSON.stringify({ error: "no semantic-router config found", paths: e.configPaths() })
          }
          try {
            const { match, mode, candidates } = await e.classifyDetailed(question)
            return JSON.stringify({
              route: match?.name ?? null,
              score: match ? Number(match.score.toFixed(4)) : null,
              mode,
              threshold: mode === "lexical" ? cfg.lexicalThreshold : cfg.defaultThreshold,
              margin: mode === "lexical" ? cfg.lexicalMargin : cfg.defaultMargin,
              candidates,
            })
          } catch (err) {
            return JSON.stringify({ error: String(err) })
          }
        },
      }),

      "semantic-route-status": tool({
        description: "Report semantic-router config sources, encoder, routes, thresholds, and the active route for this session.",
        args: {},
        async execute(_args: unknown, context: { sessionID: string }) {
          const cfg = e.loaded.config
          return JSON.stringify({
            enabled: cfg != null,
            configSources: e.loaded.sources,
            configError: e.loaded.error,
            configPaths: e.configPaths(),
            encoders: cfg
              ? [cfg.encoder, ...cfg.fallbackEncoders]
                  .filter((enc): enc is EncoderConfig => enc != null)
                  .map((enc) => ({ baseURL: enc.baseURL, model: enc.model, hasApiKey: !!enc.apiKey }))
              : [],
            mode: e.usingLexical ? "lexical" : "embeddings",
            activeEncoder: e.activeEncoder ? { baseURL: e.activeEncoder.baseURL, model: e.activeEncoder.model } : null,
            defaultThreshold: cfg?.defaultThreshold ?? DEFAULT_THRESHOLD,
            defaultMargin: cfg?.defaultMargin ?? 0.08,
            lexicalThreshold: cfg?.lexicalThreshold ?? DEFAULT_LEXICAL_THRESHOLD,
            lexicalMargin: cfg?.lexicalMargin ?? DEFAULT_LEXICAL_MARGIN,
            routes: cfg?.routes.map((r) => ({
              name: r.name,
              utterances: r.utterances.length,
              threshold: r.threshold ?? cfg.defaultThreshold,
              margin: r.margin ?? cfg.defaultMargin,
              hasInject: !!r.inject,
              skill: r.skill ?? null,
              denyTools: r.denyTools ?? [],
              keywords: r.keywords ?? [],
            })) ?? [],
            indexed: e.index != null,
            activeRoute: e.activeRoutes.get(context.sessionID)?.name ?? null,
            cachedQueries: e.queryCache.size,
            embeddingsFile: e.embeddingsFile(),
            embeddingsBackoffMs: Math.max(0, e.disabledUntil - Date.now()),
          })
        },
      }),

      "semantic-route-reload": tool({
        description: "Reload the semantic-router config from disk and clear the embedding index and query cache.",
        args: {},
        async execute() {
          e.reload()
          logger.info(`reloaded — routes=${e.loaded.config?.routes.length ?? 0}`)
          return JSON.stringify({
            reloaded: true,
            routes: e.loaded.config?.routes.map((r) => r.name) ?? [],
            error: e.loaded.error,
          })
        },
      }),
    },
  }
}

// ---------------------------------------------------------------------------
// v2 entrypoint (docs/build/plugins/migrate-v1): `id` + `setup(ctx)`, with v1
// served by `server`. v2 differences: no `client` (root from `ctx.location`,
// logging to stderr), `chat.message` → `ctx.session.hook("prompt")`,
// `experimental.chat.system.transform` → `ctx.session.hook("context")` (system
// parts), `tool.execute.before` → `ctx.tool.hook("execute.before")`, and the
// tool map → `ctx.tool.transform` with JSON Schema inputs.
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
  id: "semantic-router",

  async setup(ctx: any) {
    writeLoadCanary("semantic-router")
    const logger = consoleLogger("semantic-router")
    const root: string = ctx.location?.project?.canonical ?? ctx.location?.directory

    if (process.env[DISABLED_ENV] === "0") {
      logger.info("plugin disabled via LLMHP_SEMANTIC_ROUTER=0")
      return
    }

    const e = createEngine(logger, root, root)

    await ctx.session.hook("prompt", async (event: any) => {
      if (!e.loaded.config) return
      const text: string | undefined = event?.prompt?.text
      if (typeof text !== "string" || !text.trim()) return
      const match = await e.classify(text)
      e.activeRoutes.set(event.sessionID, match)
      if (match) logger.info(`session ${event.sessionID} → route "${match.name}" (${match.score.toFixed(3)})`)
    })

    await ctx.session.hook("context", (event: any) => {
      const sid: string | undefined = event?.sessionID
      if (!sid) return
      const match = e.activeRoutes.get(sid)
      if (!match) return
      const block = e.routeTextForInjection(match)
      if (Array.isArray(event.system)) event.system.unshift({ type: "text", text: block })
    })

    await ctx.tool.hook("execute.before", (event: any) => {
      const toolName: string = event?.tool ?? event?.name
      const match = e.activeRoutes.get(event?.sessionID)
      const deny = match?.route.denyTools
      if (deny && deny.includes(toolName)) {
        throw new Error(
          `SEMANTIC_ROUTER: tool "${toolName}" is disabled while route "${match!.name}" is active. ` +
          `Complete the request without it, or rephrase if this is a different kind of task.`,
        )
      }
    })

    const str = (description: string) => ({ type: "string", description })
    const emptyInput = { type: "object", properties: {}, additionalProperties: false } as const

    await ctx.tool.transform((editor: any) => {
      editor.add({
        name: "semantic-route",
        description:
          "Classify a query against the configured semantic routes and report the winning route, its " +
          "similarity score, and all candidates. Use to debug routing or check intent before acting.",
        input: {
          type: "object",
          properties: { question: str("Query text to classify") },
          required: ["question"],
          additionalProperties: false,
        },
        async execute(args: any) {
          const cfg = e.loaded.config
          if (!cfg) {
            return { content: JSON.stringify({ error: "no semantic-router config found", paths: e.configPaths() }) }
          }
          try {
            const { match, mode, candidates } = await e.classifyDetailed(args.question)
            return {
              content: JSON.stringify({
                route: match?.name ?? null,
                score: match ? Number(match.score.toFixed(4)) : null,
                mode,
                threshold: mode === "lexical" ? cfg.lexicalThreshold : cfg.defaultThreshold,
                margin: mode === "lexical" ? cfg.lexicalMargin : cfg.defaultMargin,
                candidates,
              }),
            }
          } catch (err) {
            return { content: JSON.stringify({ error: String(err) }) }
          }
        },
      })

      editor.add({
        name: "semantic-route-status",
        description: "Report semantic-router config sources, encoder, routes, thresholds, and the active route for this session.",
        input: emptyInput,
        async execute(_args: any, context: any) {
          const cfg = e.loaded.config
          const sessionID: string | undefined = context?.sessionID
          return {
            content: JSON.stringify({
              enabled: cfg != null,
              configSources: e.loaded.sources,
              configError: e.loaded.error,
              configPaths: e.configPaths(),
              encoders: cfg
                ? [cfg.encoder, ...cfg.fallbackEncoders]
                    .filter((enc): enc is EncoderConfig => enc != null)
                    .map((enc) => ({ baseURL: enc.baseURL, model: enc.model, hasApiKey: !!enc.apiKey }))
                : [],
              mode: e.usingLexical ? "lexical" : "embeddings",
              activeEncoder: e.activeEncoder ? { baseURL: e.activeEncoder.baseURL, model: e.activeEncoder.model } : null,
              defaultThreshold: cfg?.defaultThreshold ?? DEFAULT_THRESHOLD,
              defaultMargin: cfg?.defaultMargin ?? 0.08,
              lexicalThreshold: cfg?.lexicalThreshold ?? DEFAULT_LEXICAL_THRESHOLD,
              lexicalMargin: cfg?.lexicalMargin ?? DEFAULT_LEXICAL_MARGIN,
              routes: cfg?.routes.map((r) => ({
                name: r.name,
                utterances: r.utterances.length,
                threshold: r.threshold ?? cfg.defaultThreshold,
                margin: r.margin ?? cfg.defaultMargin,
                hasInject: !!r.inject,
                skill: r.skill ?? null,
                denyTools: r.denyTools ?? [],
                keywords: r.keywords ?? [],
              })) ?? [],
              indexed: e.index != null,
              activeRoute: sessionID ? e.activeRoutes.get(sessionID)?.name ?? null : null,
              cachedQueries: e.queryCache.size,
              embeddingsFile: e.embeddingsFile(),
              embeddingsBackoffMs: Math.max(0, e.disabledUntil - Date.now()),
            }),
          }
        },
      })

      editor.add({
        name: "semantic-route-reload",
        description: "Reload the semantic-router config from disk and clear the embedding index and query cache.",
        input: emptyInput,
        async execute() {
          e.reload()
          logger.info(`reloaded — routes=${e.loaded.config?.routes.length ?? 0}`)
          return {
            content: JSON.stringify({
              reloaded: true,
              routes: e.loaded.config?.routes.map((r) => r.name) ?? [],
              error: e.loaded.error,
            }),
          }
        },
      })
    })
  },

  async server(input: any, options?: any) {
    return v1Factory(input, options)
  },
}
