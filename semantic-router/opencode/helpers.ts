// Pure, dependency-free logic for the semantic-router plugin. Kept out of
// index.ts because opencode's plugin loader treats every function exported by
// the entry file as a plugin and calls it with the PluginInput.

/** OpenAI-compatible embeddings endpoint. */
export interface EncoderConfig {
  baseURL: string
  model: string
  apiKey?: string
  timeoutMs?: number
}

/** One decision path: if a message is semantically close enough to the route's
 * utterances, the route's `inject` text is added to the system prompt. */
export interface RouteConfig {
  name: string
  utterances: string[]
  /** Cosine-similarity cutoff for this route; falls back to defaultThreshold. */
  threshold?: number
  /** Required lead over the runner-up route; falls back to defaultMargin. */
  margin?: number
  /** Instruction block injected into the system prompt when matched. */
  inject?: string
  /** Skill name to nudge the model toward when matched. */
  skill?: string
  /** Tool names blocked while this route is active. */
  denyTools?: string[]
  /** Extra tokens for the lexical fallback matcher (rare terms, synonyms). */
  keywords?: string[]
}

export interface RouterConfig {
  /** Embeddings endpoint, or null for lexical-only routing. Lexical mode needs
   * no model at all, so a config can omit `encoder` when no embeddings server
   * (e.g. a local Unsloth one that is not running) is available. */
  encoder: EncoderConfig | null
  /** Tried in order after `encoder` when embeddings fail. */
  fallbackEncoders: EncoderConfig[]
  defaultThreshold: number
  defaultMargin: number
  /** Lexical-fallback thresholds (used when no encoder is reachable). */
  lexicalThreshold: number
  lexicalMargin: number
  routes: RouteConfig[]
}

export interface RouteMatch {
  name: string
  score: number
  route: RouteConfig
}

/** A route plus its precomputed utterance centroid. */
export interface IndexedRoute {
  route: RouteConfig
  centroid: number[]
}

export const DEFAULT_THRESHOLD = 0.5
/** Required lead over the runner-up. Chat-model embeddings have a high
 * baseline similarity (unrelated text often scores 0.6+), so an absolute
 * threshold alone false-positives; the margin is what makes them usable. */
export const DEFAULT_MARGIN = 0.08
/** Lexical fallback: set-cosine over significant tokens, with its own
 * thresholds because the scale differs from embedding cosine. */
export const DEFAULT_LEXICAL_THRESHOLD = 0.25
export const DEFAULT_LEXICAL_MARGIN = 0.05
export const DEFAULT_TIMEOUT_MS = 5000
/** Embeddings of the first N chars; long messages dilute the intent signal. */
export const EMBED_MAX_CHARS = 2000

/** Words carrying no routing signal. Deliberately small — the set-cosine is
 * already scale-robust, so an over-broad list would hurt more than help. */
const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "but", "by", "can", "could", "do",
  "does", "for", "from", "has", "have", "how", "i", "in", "is", "it", "its",
  "me", "my", "of", "on", "or", "our", "please", "so", "that", "the", "their",
  "them", "then", "there", "these", "this", "to", "was", "we", "what", "when",
  "where", "which", "who", "will", "with", "would", "you", "your",
])

export class ConfigError extends Error {}

function asRecord(v: unknown, what: string): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new ConfigError(`${what} must be an object`)
  return v as Record<string, unknown>
}

function optString(v: unknown, what: string): string | undefined {
  if (v === undefined || v === null) return undefined
  if (typeof v !== "string") throw new ConfigError(`${what} must be a string`)
  return v
}

function parseEncoder(v: unknown, what: string): EncoderConfig {
  const enc = asRecord(v, what)
  const baseURL = optString(enc.baseURL, `${what}.baseURL`)
  const model = optString(enc.model, `${what}.model`)
  if (!baseURL) throw new ConfigError(`${what}.baseURL is required`)
  if (!model) throw new ConfigError(`${what}.model is required`)
  return {
    baseURL: baseURL.replace(/\/+$/, ""),
    model,
    apiKey: optString(enc.apiKey, `${what}.apiKey`),
    timeoutMs: typeof enc.timeoutMs === "number" && enc.timeoutMs > 0 ? enc.timeoutMs : DEFAULT_TIMEOUT_MS,
  }
}

function optStringArray(v: unknown, what: string): string[] | undefined {
  if (v === undefined) return undefined
  if (!Array.isArray(v) || !v.every((t) => typeof t === "string" && t.trim())) {
    throw new ConfigError(`${what} must be a non-empty string array`)
  }
  return (v as string[]).map((t) => t.trim())
}

/** Validate and normalize a raw config object (from JSON). */
export function parseConfig(raw: unknown): RouterConfig {
  const root = asRecord(raw, "config")
  const encoder = root.encoder === undefined || root.encoder === null
    ? null
    : parseEncoder(root.encoder, "config.encoder")
  let fallbackEncoders: EncoderConfig[] = []
  if (root.fallbackEncoders !== undefined) {
    if (!Array.isArray(root.fallbackEncoders)) throw new ConfigError("config.fallbackEncoders must be an array")
    fallbackEncoders = root.fallbackEncoders.map((e, i) => parseEncoder(e, `config.fallbackEncoders[${i}]`))
  }

  const rawRoutes = root.routes
  if (!Array.isArray(rawRoutes) || rawRoutes.length === 0) throw new ConfigError("config.routes must be a non-empty array")
  const routes: RouteConfig[] = rawRoutes.map((r, i) => {
    const o = asRecord(r, `config.routes[${i}]`)
    const name = optString(o.name, `config.routes[${i}].name`)
    if (!name) throw new ConfigError(`config.routes[${i}].name is required`)
    if (!Array.isArray(o.utterances) || o.utterances.length === 0 || !o.utterances.every((u) => typeof u === "string" && u.trim())) {
      throw new ConfigError(`config.routes[${i}].utterances must be a non-empty string array`)
    }
    const threshold = o.threshold
    if (threshold !== undefined && (typeof threshold !== "number" || threshold < -1 || threshold > 1)) {
      throw new ConfigError(`config.routes[${i}].threshold must be a number in [-1, 1]`)
    }
    const margin = o.margin
    if (margin !== undefined && (typeof margin !== "number" || margin < 0 || margin > 2)) {
      throw new ConfigError(`config.routes[${i}].margin must be a number in [0, 2]`)
    }
    let denyTools: string[] | undefined
    if (o.denyTools !== undefined) {
      if (!Array.isArray(o.denyTools) || !o.denyTools.every((t) => typeof t === "string" && t)) {
        throw new ConfigError(`config.routes[${i}].denyTools must be a string array`)
      }
      denyTools = o.denyTools as string[]
    }
    return {
      name,
      utterances: (o.utterances as string[]).map((u) => u.trim()),
      threshold: threshold as number | undefined,
      margin: margin as number | undefined,
      inject: optString(o.inject, `config.routes[${i}].inject`),
      skill: optString(o.skill, `config.routes[${i}].skill`),
      denyTools,
      keywords: optStringArray(o.keywords, `config.routes[${i}].keywords`),
    }
  })

  const dt = root.defaultThreshold
  if (dt !== undefined && (typeof dt !== "number" || dt < -1 || dt > 1)) {
    throw new ConfigError("config.defaultThreshold must be a number in [-1, 1]")
  }
  const dm = root.defaultMargin
  if (dm !== undefined && (typeof dm !== "number" || dm < 0 || dm > 2)) {
    throw new ConfigError("config.defaultMargin must be a number in [0, 2]")
  }
  const lt = root.lexicalThreshold
  if (lt !== undefined && (typeof lt !== "number" || lt < 0 || lt > 1)) {
    throw new ConfigError("config.lexicalThreshold must be a number in [0, 1]")
  }
  const lm = root.lexicalMargin
  if (lm !== undefined && (typeof lm !== "number" || lm < 0 || lm > 2)) {
    throw new ConfigError("config.lexicalMargin must be a number in [0, 2]")
  }
  return {
    encoder,
    fallbackEncoders,
    defaultThreshold: typeof dt === "number" ? dt : DEFAULT_THRESHOLD,
    defaultMargin: typeof dm === "number" ? dm : DEFAULT_MARGIN,
    lexicalThreshold: typeof lt === "number" ? lt : DEFAULT_LEXICAL_THRESHOLD,
    lexicalMargin: typeof lm === "number" ? lm : DEFAULT_LEXICAL_MARGIN,
    routes,
  }
}

/** Merge `override` onto `base`: routes are keyed by name (override wins),
 * encoder/defaultThreshold override when present. */
export function mergeConfigs(base: RouterConfig | null, override: RouterConfig | null): RouterConfig | null {
  if (!base) return override
  if (!override) return base
  const byName = new Map<string, RouteConfig>()
  for (const r of base.routes) byName.set(r.name, r)
  for (const r of override.routes) byName.set(r.name, r)
  return {
    encoder: override.encoder ?? base.encoder,
    fallbackEncoders: override.fallbackEncoders.length ? override.fallbackEncoders : base.fallbackEncoders,
    defaultThreshold: override.defaultThreshold,
    defaultMargin: override.defaultMargin,
    lexicalThreshold: override.lexicalThreshold,
    lexicalMargin: override.lexicalMargin,
    routes: [...byName.values()],
  }
}

/** Cosine similarity. Zero vectors score 0 rather than NaN. */
export function cosine(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length)
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

/** Mean vector of the given vectors (dimension of the first). */
export function centroid(vectors: number[][]): number[] {
  if (vectors.length === 0) return []
  const dim = vectors[0].length
  const out = new Array<number>(dim).fill(0)
  for (const v of vectors) {
    const n = Math.min(dim, v.length)
    for (let i = 0; i < n; i++) out[i] += v[i]
  }
  for (let i = 0; i < dim; i++) out[i] /= vectors.length
  return out
}

/**
 * Best route by centroid similarity. The winner must clear its own threshold
 * AND lead the runner-up by its own margin — the margin suppresses the
 * high-baseline false positives of chat-model embeddings.
 */
export function matchRoute(
  query: number[],
  index: IndexedRoute[],
  defaultThreshold: number,
  defaultMargin = DEFAULT_MARGIN,
): RouteMatch | null {
  const scored = index
    .map(({ route, centroid: c }) => ({ route, score: cosine(query, c) }))
    .sort((a, b) => b.score - a.score)
  if (scored.length === 0) return null
  const top = scored[0]
  const threshold = top.route.threshold ?? defaultThreshold
  if (top.score < threshold) return null
  const margin = top.route.margin ?? defaultMargin
  if (scored.length > 1 && top.score - scored[1].score < margin) return null
  return { name: top.route.name, score: top.score, route: top.route }
}

/** A route plus its significant-token set, for the lexical fallback. */
export interface LexicalRoute {
  route: RouteConfig
  tokens: Set<string>
}

/** Lowercase alphanumeric tokens, stopwords dropped, crude plural stem. */
export function tokenize(text: string): string[] {
  const out: string[] = []
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (!raw || raw.length < 2 || STOPWORDS.has(raw)) continue
    out.push(raw.length > 3 && raw.endsWith("s") ? raw.slice(0, -1) : raw)
  }
  return out
}

/** Cosine similarity of two token sets. */
export function setCosine(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let inter = 0
  for (const t of a) if (b.has(t)) inter++
  return inter / Math.sqrt(a.size * b.size)
}

export function buildLexicalIndex(cfg: RouterConfig): LexicalRoute[] {
  return cfg.routes.map((route) => {
    const tokens = new Set<string>()
    for (const u of route.utterances) for (const t of tokenize(u)) tokens.add(t)
    for (const k of route.keywords ?? []) for (const t of tokenize(k)) tokens.add(t)
    return { route, tokens }
  })
}

/** Lexical fallback matcher: same threshold+margin rule, token-set cosine. */
export function matchLexical(
  query: string,
  index: LexicalRoute[],
  defaultThreshold: number,
  defaultMargin = DEFAULT_LEXICAL_MARGIN,
): RouteMatch | null {
  const qt = new Set(tokenize(query))
  const scored = index
    .map(({ route, tokens }) => ({ route, score: setCosine(qt, tokens) }))
    .sort((a, b) => b.score - a.score)
  if (scored.length === 0) return null
  const top = scored[0]
  if (top.score < (top.route.threshold ?? defaultThreshold)) return null
  if (scored.length > 1 && top.score - scored[1].score < (top.route.margin ?? defaultMargin)) return null
  return { name: top.route.name, score: top.score, route: top.route }
}

/** FNV-1a, for cache keys (not cryptographic). */
export function hashString(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, "0")
}

/** Identity of an index: encoder + the exact utterance set. A change to either
 * invalidates the cached utterance embeddings. Pass the encoder actually used
 * (a fallback encoder yields different vectors). */
export function configSignature(cfg: RouterConfig, encoder: EncoderConfig | null = cfg.encoder): string {
  const enc = encoder ? `${encoder.baseURL}|${encoder.model}` : "lexical"
  const utts = cfg.routes.map((r) => `${r.name}\u0000${r.utterances.join("\u0001")}`).join("\u0002")
  return hashString(`${enc}\u0003${utts}`)
}

export function truncateForEmbedding(text: string, max = EMBED_MAX_CHARS): string {
  const t = text.trim()
  return t.length <= max ? t : t.slice(0, max)
}

/** The block prepended to the system prompt for a matched route. */
export function routeTextForInjection(match: RouteMatch): string {
  const lines = [`[semantic-router] route="${match.name}" similarity=${match.score.toFixed(3)}`]
  if (match.route.inject) lines.push(match.route.inject.trim())
  if (match.route.skill) lines.push(`Prefer the "${match.route.skill}" skill for this request.`)
  return lines.join("\n")
}
