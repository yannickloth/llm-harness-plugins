import { describe, test, expect, afterAll } from "bun:test"
import { join } from "path"
import { existsSync, readFileSync, writeFileSync, mkdirSync, mkdtempSync } from "fs"
import { tmpdir } from "os"
import {
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
  type RouterConfig,
} from "./helpers"

const base = join(import.meta.dir, "..")

describe("semantic-router helpers", () => {
  test("cosine: identical, orthogonal, opposite, zero", () => {
    expect(cosine([1, 0, 0], [1, 0, 0])).toBeCloseTo(1, 6)
    expect(cosine([1, 0, 0], [0, 1, 0])).toBeCloseTo(0, 6)
    expect(cosine([1, 0, 0], [-1, 0, 0])).toBeCloseTo(-1, 6)
    expect(cosine([0, 0, 0], [1, 0, 0])).toBe(0)
    // Scale-invariant.
    expect(cosine([2, 0, 0], [5, 0, 0])).toBeCloseTo(1, 6)
  })

  test("centroid is the mean vector", () => {
    expect(centroid([[1, 0], [3, 0], [2, 0]])).toEqual([2, 0])
    expect(centroid([])).toEqual([])
  })

  test("matchRoute requires threshold and a margin over the runner-up", () => {
    const index = [
      { route: { name: "a", utterances: ["x"] }, centroid: [1, 0, 0] },
      { route: { name: "b", utterances: ["y"], threshold: 0.9 }, centroid: [0, 1, 0] },
    ]
    expect(matchRoute([1, 0, 0], index, 0.5)?.name).toBe("a")
    // Ambiguous (45° from both) → no winner despite clearing the threshold.
    expect(matchRoute([1, 1, 0], index, 0.5)).toBeNull()
    // Ambiguity accepted when the margin is disabled.
    expect(matchRoute([1, 1, 0], index, 0.5, 0)?.name).toBe("a")
    // Below every threshold → no route.
    expect(matchRoute([0, 0, 1], index, 0.5)).toBeNull()
    // Per-route margin override.
    const idx2 = [{ route: { name: "a", utterances: ["x"], margin: 0.9 }, centroid: [1, 0, 0] }, index[1]]
    expect(matchRoute([1, 0.2, 0], idx2, 0.5)).toBeNull()
  })

  test("parseConfig applies defaults and rejects malformed config", () => {
    const cfg = parseConfig({
      encoder: { baseURL: "http://x/v1/", model: "m" },
      routes: [{ name: "r", utterances: [" hello "] }],
    })
    expect(cfg.encoder!.baseURL).toBe("http://x/v1") // trailing slash trimmed
    expect(cfg.encoder!.timeoutMs).toBe(5000)
    expect(cfg.defaultThreshold).toBe(0.5)
    expect(cfg.routes[0].utterances).toEqual(["hello"])

    const bad = (raw: unknown) => () => parseConfig(raw)
    // No encoder is valid: routing runs lexical-only (no model required).
    expect(parseConfig({ routes: [{ name: "r", utterances: ["x"] }] }).encoder).toBeNull()
    // A present-but-malformed encoder is still rejected.
    expect(bad({ encoder: { baseURL: "u" }, routes: [{ name: "r", utterances: ["x"] }] })).toThrow(/model/)
    expect(bad({ encoder: { baseURL: "u", model: "m" }, routes: [] })).toThrow(/routes/)
    expect(bad({ encoder: { baseURL: "u", model: "m" }, routes: [{ name: "r", utterances: [] }] })).toThrow(/utterances/)
    expect(bad({ encoder: { baseURL: "u", model: "m" }, routes: [{ name: "r", utterances: ["x"], threshold: 2 }] })).toThrow(/threshold/)
    expect(bad({ encoder: { baseURL: "u", model: "m" }, routes: [{ name: "r", utterances: ["x"], denyTools: [1] }] })).toThrow(/denyTools/)
  })

  test("mergeConfigs overrides routes by name and keeps others", () => {
    const a: RouterConfig = parseConfig({ encoder: { baseURL: "u", model: "m" }, routes: [{ name: "x", utterances: ["a"] }] })
    const b: RouterConfig = parseConfig({ encoder: { baseURL: "u2", model: "m2" }, routes: [{ name: "x", utterances: ["b"] }, { name: "y", utterances: ["c"] }] })
    const m = mergeConfigs(a, b)!
    expect(m.routes.map((r) => r.name).sort()).toEqual(["x", "y"])
    expect(m.routes.find((r) => r.name === "x")!.utterances).toEqual(["b"])
    expect(m.encoder!.baseURL).toBe("u2")
  })

  test("configSignature is stable and sensitive", () => {
    const mk = (model: string, utt: string): RouterConfig =>
      parseConfig({ encoder: { baseURL: "u", model }, routes: [{ name: "r", utterances: [utt] }] })
    expect(configSignature(mk("m", "a"))).toBe(configSignature(mk("m", "a")))
    expect(configSignature(mk("m", "a"))).not.toBe(configSignature(mk("m", "b")))
    expect(configSignature(mk("m", "a"))).not.toBe(configSignature(mk("m2", "a")))
    expect(hashString("abc")).toBe(hashString("abc"))
  })

  test("lexical fallback: tokenize, setCosine, matchLexical", () => {
    expect(tokenize("Check the PROOFS, please!")).toEqual(["check", "proof"])
    expect(tokenize("what is the weather")).toEqual(["weather"])
    expect(setCosine(new Set(["a", "b"]), new Set(["a", "b"]))).toBeCloseTo(1, 6)
    expect(setCosine(new Set(["a"]), new Set(["b"]))).toBe(0)
    expect(setCosine(new Set(), new Set(["a"]))).toBe(0)

    const cfg = parseConfig({
      encoder: { baseURL: "u", model: "m" },
      routes: [
        { name: "proof", utterances: ["check this proof", "verify the derivation"] },
        { name: "weather", utterances: ["what is the weather", "is it raining"] },
      ],
    })
    const idx = buildLexicalIndex(cfg)
    expect(matchLexical("check the proof of theorem 3", idx, 0.25)?.name).toBe("proof")
    expect(matchLexical("is it raining today", idx, 0.25)?.name).toBe("weather")
    expect(matchLexical("order me a pizza", idx, 0.25)).toBeNull()
  })

  test("parseConfig accepts fallbackEncoders and lexical thresholds", () => {
    const cfg = parseConfig({
      encoder: { baseURL: "u", model: "m" },
      fallbackEncoders: [{ baseURL: "u2", model: "m2" }],
      lexicalThreshold: 0.3,
      lexicalMargin: 0.02,
      routes: [{ name: "r", utterances: ["x"], keywords: ["alpha"] }],
    })
    expect(cfg.fallbackEncoders.map((e) => e.baseURL)).toEqual(["u2"])
    expect(cfg.lexicalThreshold).toBe(0.3)
    expect(cfg.lexicalMargin).toBe(0.02)
    expect(cfg.routes[0].keywords).toEqual(["alpha"])
    // Defaults when omitted.
    const d = parseConfig({ encoder: { baseURL: "u", model: "m" }, routes: [{ name: "r", utterances: ["x"] }] })
    expect(d.fallbackEncoders).toEqual([])
    expect(d.lexicalThreshold).toBe(0.25)
    expect(d.lexicalMargin).toBe(0.05)
  })

  test("truncateForEmbedding trims and caps", () => {
    expect(truncateForEmbedding("  hi  ")).toBe("hi")
    expect(truncateForEmbedding("x".repeat(50), 10)).toBe("x".repeat(10))
  })

  test("routeTextForInjection carries route, score, inject and skill", () => {
    const text = routeTextForInjection({
      name: "code-review",
      score: 0.8123,
      route: { name: "code-review", utterances: ["x"], inject: "DO REVIEW", skill: "review-skill" },
    })
    expect(text).toContain('route="code-review"')
    expect(text).toContain("0.812")
    expect(text).toContain("DO REVIEW")
    expect(text).toContain('"review-skill"')
  })
})

// ── integration against a mock embeddings endpoint ──────────────────────────

function vecFor(text: string): number[] {
  const t = text.toLowerCase()
  if (t.includes("review") || t.includes("bug") || t.includes("wrong")) return [1, 0, 0]
  if (t.includes("source") || t.includes("literature") || t.includes("evidence") || t.includes("research")) return [0, 1, 0]
  if (t.includes("idea") || t.includes("brainstorm") || t.includes("option")) return [0, 0, 1]
  return [0, 0, 0]
}

const servers: Array<{ stop: () => void }> = []
afterAll(() => { for (const s of servers) s.stop() })

function mockEmbeddings(): { baseURL: string; batchRequests: () => number; modelRequests: () => number } {
  let batch = 0
  let modelHits = 0
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      if (url.pathname.endsWith("/models")) {
        modelHits++
        return Response.json({ object: "list", data: [{ id: "mock-model", object: "model", loaded: true }] })
      }
      if (!url.pathname.endsWith("/embeddings")) return new Response("nope", { status: 404 })
      const body: any = await req.json()
      const texts: string[] = Array.isArray(body.input) ? body.input : [body.input]
      if (Array.isArray(body.input)) batch++
      return Response.json({
        object: "list",
        data: texts.map((t, i) => ({ object: "embedding", index: i, embedding: vecFor(String(t)) })),
      })
    },
  })
  servers.push(server)
  return { baseURL: `http://127.0.0.1:${server.port}/v1`, batchRequests: () => batch, modelRequests: () => modelHits }
}

function writeRoutes(dir: string, baseURL: string): string {
  const p = join(dir, ".semantic-router", "routes.json")
  mkdirSync(join(dir, ".semantic-router"), { recursive: true })
  writeFileSync(p, JSON.stringify({
    encoder: { baseURL, model: "mock" },
    defaultThreshold: 0.5,
    routes: [
      {
        name: "code-review",
        utterances: ["review this code for bugs", "find bugs in this file"],
        inject: "DO A CODE REVIEW",
        denyTools: ["write", "edit"],
      },
      { name: "research", utterances: ["find sources about this topic", "summarize the literature"], inject: "CITE SOURCES", skill: "research" },
      { name: "brainstorm", utterances: ["give me ideas for this", "brainstorm approaches"], inject: "LIST OPTIONS" },
    ],
  }))
  return p
}

async function loadPlugin(dir: string, configPath: string) {
  process.env.LLMHP_SEMANTIC_ROUTER_CONFIG = configPath
  const mod = await import(join(import.meta.dir, "index.ts") + `?t=${Date.now()}-${Math.random()}`)
  const client = { app: { log: async () => {} } }
  const hooks: any = await mod.default({ client, directory: dir, worktree: dir })
  return { mod, hooks }
}

describe("semantic-router plugin", () => {
  test("entry exports only the default plugin", async () => {
    const mod = await import(join(import.meta.dir, "index.ts"))
    expect(Object.keys(mod).filter((k) => k !== "default")).toEqual([])
  })

  test("routes a message, injects its directive, and gates tools", async () => {
    const mock = mockEmbeddings()
    const dir = mkdtempSync(join(tmpdir(), "semantic-router-"))
    const cfg = writeRoutes(dir, mock.baseURL)
    const { hooks } = await loadPlugin(dir, cfg)

    await hooks["chat.message"]({ sessionID: "s1" }, { parts: [{ type: "text", text: "please review my code for bugs" }] })
    const out = { system: ["BASE"] }
    await hooks["experimental.chat.system.transform"]({ sessionID: "s1" }, out)
    expect(out.system[0]).toContain('route="code-review"')
    expect(out.system[0]).toContain("DO A CODE REVIEW")
    expect(out.system[1]).toBe("BASE")

    // denyTools from the matched route blocks write/edit.
    await expect(hooks["tool.execute.before"]({ tool: "write", sessionID: "s1" })).rejects.toThrow(/SEMANTIC_ROUTER/)
    await expect(hooks["tool.execute.before"]({ tool: "read", sessionID: "s1" })).resolves.toBeUndefined()

    // The utterance index was persisted for reuse.
    expect(existsSync(join(dir, ".semantic-router", "embeddings.json"))).toBe(true)
  })

  test("an unrelated message matches nothing and injects nothing", async () => {
    const mock = mockEmbeddings()
    const dir = mkdtempSync(join(tmpdir(), "semantic-router-"))
    const cfg = writeRoutes(dir, mock.baseURL)
    const { hooks } = await loadPlugin(dir, cfg)

    await hooks["chat.message"]({ sessionID: "s2" }, { parts: [{ type: "text", text: "tell me a joke" }] })
    const out = { system: ["BASE"] }
    await hooks["experimental.chat.system.transform"]({ sessionID: "s2" }, out)
    expect(out.system).toEqual(["BASE"])
    await expect(hooks["tool.execute.before"]({ tool: "write", sessionID: "s2" })).resolves.toBeUndefined()
  })

  test("reuses cached utterance embeddings across instances", async () => {
    const mock = mockEmbeddings()
    const dir = mkdtempSync(join(tmpdir(), "semantic-router-"))
    const cfg = writeRoutes(dir, mock.baseURL)

    const first = await loadPlugin(dir, cfg)
    await first.hooks["chat.message"]({ sessionID: "s1" }, { parts: [{ type: "text", text: "find sources about this topic" }] })
    expect(mock.batchRequests()).toBeGreaterThan(0)

    const before = mock.batchRequests()
    const second = await loadPlugin(dir, cfg)
    await second.hooks["chat.message"]({ sessionID: "s1" }, { parts: [{ type: "text", text: "review this code for bugs" }] })
    expect(mock.batchRequests()).toBe(before) // index loaded from disk, no re-embed
  })

  test("semantic-route-status reports config and active route", async () => {
    const mock = mockEmbeddings()
    const dir = mkdtempSync(join(tmpdir(), "semantic-router-"))
    const cfg = writeRoutes(dir, mock.baseURL)
    const { hooks } = await loadPlugin(dir, cfg)

    await hooks["chat.message"]({ sessionID: "s3" }, { parts: [{ type: "text", text: "brainstorm approaches" }] })
    const status = JSON.parse(String(await hooks.tool["semantic-route-status"].execute({}, { sessionID: "s3" })))
    expect(status.enabled).toBe(true)
    expect(status.routes.map((r: any) => r.name)).toEqual(["code-review", "research", "brainstorm"])
    expect(status.activeRoute).toBe("brainstorm")

    const classified = JSON.parse(String(await hooks.tool["semantic-route"].execute({ question: "find sources" }, { sessionID: "s3" })))
    expect(classified.route).toBe("research")
  })

  test('encoder model "auto" resolves the loaded model from /v1/models', async () => {
    const mock = mockEmbeddings()
    const dir = mkdtempSync(join(tmpdir(), "semantic-router-"))
    const p = join(dir, ".semantic-router", "routes.json")
    mkdirSync(join(dir, ".semantic-router"), { recursive: true })
    writeFileSync(p, JSON.stringify({
      encoder: { baseURL: mock.baseURL, model: "auto" },
      routes: [{ name: "code-review", utterances: ["review this code for bugs"], inject: "REVIEW" }],
    }))
    const { hooks } = await loadPlugin(dir, p)
    await hooks["chat.message"]({ sessionID: "s5" }, { parts: [{ type: "text", text: "review this code for bugs" }] })
    const out = { system: ["BASE"] }
    await hooks["experimental.chat.system.transform"]({ sessionID: "s5" }, out)
    expect(out.system[0]).toContain("REVIEW")
    expect(mock.modelRequests()).toBeGreaterThan(0)
  })

  test("falls back to lexical routing when the encoder is unreachable", async () => {
    const dir = mkdtempSync(join(tmpdir(), "semantic-router-"))
    const cfg = writeRoutes(dir, "http://127.0.0.1:9/v1") // nothing listens here
    const { hooks } = await loadPlugin(dir, cfg)

    await hooks["chat.message"]({ sessionID: "s4" }, { parts: [{ type: "text", text: "review this code for bugs" }] })
    const out = { system: ["BASE"] }
    await hooks["experimental.chat.system.transform"]({ sessionID: "s4" }, out)
    expect(out.system[0]).toContain('route="code-review"')
    expect(out.system[0]).toContain("DO A CODE REVIEW")

    const routed = JSON.parse(String(await hooks.tool["semantic-route"].execute({ question: "review this code for bugs" }, { sessionID: "s4" })))
    expect(routed.mode).toBe("lexical")
    expect(routed.route).toBe("code-review")
    // Tool gating still applies in lexical mode.
    await expect(hooks["tool.execute.before"]({ tool: "write", sessionID: "s4" })).rejects.toThrow(/SEMANTIC_ROUTER/)
  })

  test("falls through to a fallback encoder when the primary is down", async () => {
    const mock = mockEmbeddings()
    const dir = mkdtempSync(join(tmpdir(), "semantic-router-"))
    const p = join(dir, ".semantic-router", "routes.json")
    mkdirSync(join(dir, ".semantic-router"), { recursive: true })
    writeFileSync(p, JSON.stringify({
      encoder: { baseURL: "http://127.0.0.1:9/v1", model: "dead" },
      fallbackEncoders: [{ baseURL: mock.baseURL, model: "mock" }],
      routes: [{ name: "code-review", utterances: ["review this code for bugs"], inject: "REVIEW" }],
    }))
    const { hooks } = await loadPlugin(dir, p)
    const routed = JSON.parse(String(await hooks.tool["semantic-route"].execute({ question: "review this code for bugs" }, { sessionID: "s6" })))
    expect(routed.mode).toBe("embeddings")
    expect(routed.route).toBe("code-review")
  })

  test("disabled via env returns empty plugin", async () => {
    const prev = process.env.LLMHP_SEMANTIC_ROUTER
    process.env.LLMHP_SEMANTIC_ROUTER = "0"
    try {
      const mod = await import(join(import.meta.dir, "index.ts") + `?t=${Date.now()}`)
      const result: any = await mod.default({ client: { app: { log: async () => {} } }, directory: "/tmp", worktree: "/tmp" })
      expect(result.tool).toBeUndefined()
    } finally {
      if (prev === undefined) delete process.env.LLMHP_SEMANTIC_ROUTER
      else process.env.LLMHP_SEMANTIC_ROUTER = prev
    }
  })
})
