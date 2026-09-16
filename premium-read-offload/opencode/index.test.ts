import { describe, test, expect } from "bun:test"
import { join } from "path"
import { existsSync, readFileSync, writeFileSync, mkdirSync, mkdtempSync } from "fs"
import { tmpdir } from "os"

const base = join(import.meta.dir, "..")

describe("premium-read-offload", () => {
  test("plugin directory structure exists", () => {
    expect(existsSync(join(base, "src/main/java/eu/infolead/llmhp/offload/GateDecider.java"))).toBe(true)
    expect(existsSync(join(base, "src/main/java/eu/infolead/llmhp/offload/WorkerStore.java"))).toBe(true)
    expect(existsSync(join(base, "src/main/java/eu/infolead/llmhp/offload/OffloadCli.java"))).toBe(true)
    expect(existsSync(join(base, "opencode/index.ts"))).toBe(true)
    expect(existsSync(join(base, "agents/bulk-reader.md"))).toBe(true)
    expect(existsSync(join(base, "agents/code-writer.md"))).toBe(true)
  })

  test("Java core has the required logic markers", () => {
    const gate = readFileSync(join(base, "src/main/java/eu/infolead/llmhp/offload/GateDecider.java"), "utf-8")
    expect(gate).toContain("PREMIUM_PROVIDERS")
    expect(gate).toContain("isPremium")
    expect(gate).toContain("extractBashReadPath")
    expect(gate).toContain("isTargeted")

    const store = readFileSync(join(base, "src/main/java/eu/infolead/llmhp/offload/WorkerStore.java"), "utf-8")
    expect(store).toContain("ATOMIC_MOVE")
    expect(store).toContain("corpusKey")
    expect(store).toContain("sessionModel")
  })

  test("plugin exports hooks and 4 tools", async () => {
    const mod = await import(join(import.meta.dir, "index.ts"))
    expect(mod.default).toBeDefined()
    const result = await mod.default({ directory: "/tmp/test", worktree: undefined } as any)
    expect(result["tool.execute.before"]).toBeDefined()
    expect(result["chat.message"]).toBeDefined()
    expect(result.tool).toBeDefined()
    expect(result.tool["offload-read"]).toBeDefined()
    expect(result.tool["allow-direct-read"]).toBeDefined()
    expect(result.tool["code-write"]).toBeDefined()
    expect(result.tool["offload-status"]).toBeDefined()
  })

  test("plugin entry exports only the default plugin", async () => {
    // opencode's loader treats every function export as a plugin and calls it
    // with the PluginInput; a stray named helper export crashes plugin load
    // ("{} is not iterable"). Keep helpers in contract.ts.
    const mod = await import(join(import.meta.dir, "index.ts"))
    expect(Object.keys(mod).filter((k) => k !== "default")).toEqual([])
  })

  test("worker data dir links the real auth.json (worker 401 guard)", async () => {
    // The worker runs with XDG_DATA_HOME pointing at an isolated dir; built-in
    // providers authenticate from auth.json there, so it must be linked in or
    // the model call 401s and offload-read returns "no text output".
    const dir = mkdtempSync(join(tmpdir(), "offload-auth-"))
    const realData = join(dir, "real")
    mkdirSync(join(realData, "opencode"), { recursive: true })
    writeFileSync(join(realData, "opencode", "auth.json"), '{"deepseek":{"type":"api","key":"x"}}')
    const workerDir = join(dir, "worker")
    const prevXdg = process.env.XDG_DATA_HOME
    const prevDir = process.env.LLMHP_OFFLOAD_DATA_DIR
    process.env.XDG_DATA_HOME = realData
    process.env.LLMHP_OFFLOAD_DATA_DIR = workerDir
    try {
      const mod = await import(join(import.meta.dir, "index.ts") + `?t=${Date.now()}`)
      const result = await mod.default({ directory: dir, worktree: dir } as any)
      const out = JSON.parse(String(await result.tool["offload-status"].execute({}, { sessionID: "s1" } as any)))
      expect(out.dataDir).toBe(workerDir)
      expect(existsSync(join(workerDir, "opencode", "auth.json"))).toBe(true)
    } finally {
      if (prevXdg === undefined) delete process.env.XDG_DATA_HOME
      else process.env.XDG_DATA_HOME = prevXdg
      if (prevDir === undefined) delete process.env.LLMHP_OFFLOAD_DATA_DIR
      else process.env.LLMHP_OFFLOAD_DATA_DIR = prevDir
    }
  })

  test("worker prompts go on stdin, never argv (E2BIG guard)", () => {
    // A 3000-line corpus exceeds Linux's 128 KiB per-argument limit
    // (MAX_ARG_STRLEN) and fails with E2BIG if passed as an argv message.
    const src = readFileSync(join(base, "opencode/index.ts"), "utf-8")
    expect(src).toContain("input: message")
    expect(src).not.toContain('"--", message')
    expect(src).not.toContain('"-f", ...corpusPaths')
  })

  test("tool schemas carry the expected args", async () => {
    const mod = await import(join(import.meta.dir, "index.ts"))
    const result = await mod.default({ directory: "/tmp/test", worktree: undefined } as any)
    expect(result.tool["offload-read"].args.question).toBeDefined()
    expect(result.tool["offload-read"].args.paths).toBeDefined()
    expect(result.tool["allow-direct-read"].args.path).toBeDefined()
    expect(result.tool["allow-direct-read"].args.reason).toBeDefined()
    expect(result.tool["code-write"].args.spec).toBeDefined()
    expect(result.tool["code-write"].args.reference).toBeDefined()
    expect(result.tool["code-write"].args.target).toBeDefined()
  })

  test("disabled via env returns empty plugin", async () => {
    const prev = process.env.LLMHP_PREMIUM_OFFLOAD
    process.env.LLMHP_PREMIUM_OFFLOAD = "0"
    try {
      const mod = await import(join(import.meta.dir, "index.ts") + `?t=${Date.now()}`)
      const result = await mod.default({ directory: "/tmp/test", worktree: undefined } as any)
      expect(result.tool).toBeUndefined()
    } finally {
      if (prev === undefined) delete process.env.LLMHP_PREMIUM_OFFLOAD
      else process.env.LLMHP_PREMIUM_OFFLOAD = prev
    }
  })

  test("offload-read rejects empty paths", async () => {
    const mod = await import(join(import.meta.dir, "index.ts"))
    const result = await mod.default({ directory: "/tmp/test", worktree: undefined } as any)
    const out = await result.tool["offload-read"].execute(
      { question: "q", paths: [] },
      { sessionID: "s1", directory: "/tmp/test", worktree: "/tmp/test" } as any,
    )
    expect(String(out)).toContain("at least one path")
  })

  test("code-write requires a reference", async () => {
    const mod = await import(join(import.meta.dir, "index.ts"))
    const result = await mod.default({ directory: "/tmp/test", worktree: undefined } as any)
    const out = await result.tool["code-write"].execute(
      { spec: "write tests" },
      { sessionID: "s1", directory: "/tmp/test", worktree: "/tmp/test" } as any,
    )
    expect(String(out)).toContain("reference is required")
  })

  test("offload-read skips a trivial question (worth-it guard)", async () => {
    const mod = await import(join(import.meta.dir, "index.ts"))
    const result = await mod.default({ directory: "/tmp/test", worktree: undefined } as any)
    const out = await result.tool["offload-read"].execute(
      { question: "how many lines are in this file?", paths: ["tiny.ts"] },
      { sessionID: "s1", directory: "/tmp/test", worktree: "/tmp/test" } as any,
    )
    const parsed = JSON.parse(String(out))
    expect(parsed.skipped).toBe(true)
  })

  test("countFileLines matches gate semantics (trailing newline not a line)", async () => {
    const contract = await import(join(import.meta.dir, "contract.ts"))
    const dir = mkdtempSync(join(tmpdir(), "offload-lines-"))
    const f = join(dir, "a.ts")
    writeFileSync(f, "l1\nl2\nl3\n")
    expect(contract.countFileLines(f)).toBe(3)
    writeFileSync(f, "")
    expect(contract.countFileLines(f)).toBe(0)
    expect(contract.countFileLines(join(dir, "missing.ts"))).toBe(-1)
  })

  test("structured return contract carries provenance", async () => {
    const contract = await import(join(import.meta.dir, "contract.ts"))
    const dir = mkdtempSync(join(tmpdir(), "offload-contract-"))
    const f = join(dir, "a.ts")
    writeFileSync(f, "l1\nl2\nl3\n")
    const ranges = contract.buildLineRanges([f])
    expect(ranges[f]).toEqual({ from: 1, to: 3, total: 3 })

    const out = JSON.parse(contract.buildOffloadContract({
      answer: "summary",
      filesRead: [f],
      lineRanges: ranges,
      workerSession: "ses_x",
      cacheHit: true,
      verification: { total: 2, verified: 1, unverified: 1, hasCitations: true, items: [] },
    }))
    expect(out.answer).toBe("summary")
    expect(out.files_read).toEqual([f])
    expect(out.line_ranges[f].total).toBe(3)
    expect(out.worker_session).toBe("ses_x")
    expect(out.cache_hit).toBe(true)
    expect(out.citations.unverified).toBe(1)
    expect(out.verification).toBe("ok")
  })

  test("contract marks verification error when the core is unreachable", async () => {
    const contract = await import(join(import.meta.dir, "contract.ts"))
    const out = JSON.parse(contract.buildOffloadContract({
      answer: "summary", filesRead: [], lineRanges: {}, workerSession: null, cacheHit: false, verification: null,
    }))
    expect(out.verification).toBe("error")
    expect(out.citations.total).toBe(0)
  })

  test("offload-status reports thresholds, TTL, and metrics path", async () => {
    const mod = await import(join(import.meta.dir, "index.ts"))
    const result = await mod.default({ directory: "/tmp/test", worktree: undefined } as any)
    const out = await result.tool["offload-status"].execute({}, { sessionID: "s1" } as any)
    const parsed = JSON.parse(String(out))
    expect(parsed.thresholds.minWorthLines).toBeDefined()
    expect(typeof parsed.workerTtlDays).toBe("number")
    expect(String(parsed.metrics)).toContain("metrics.jsonl")
  })
})

describe("gate integration (java)", () => {
  const classes = join(base, "build/classes")
  const main = "eu.infolead.llmhp.offload.OffloadCli"

  test("decide-read blocks a premium bulk read and allows deepseek", async () => {
    const proj = mkdtempSync(join(tmpdir(), "pro-"))
    // record a premium session and a cheap session
    Bun.spawnSync(["java", "--class-path", classes, main, "record-model", proj, "s-kimi", "kimi", "k3"])
    Bun.spawnSync(["java", "--class-path", classes, main, "record-model", proj, "s-ds", "deepseek", "deepseek-flash"])

    const big = join(proj, "big.txt")
    Bun.write(big, Array.from({ length: 3000 }, (_, i) => `line ${i}`).join("\n"))

    const premium = Bun.spawnSync(["java", "--class-path", classes, main, "decide-read", proj, "s-kimi", big, "-", "-"])
    expect(JSON.parse(premium.stdout.toString()).decision).toBe("block")

    const cheap = Bun.spawnSync(["java", "--class-path", classes, main, "decide-read", proj, "s-ds", big, "-", "-"])
    expect(JSON.parse(cheap.stdout.toString()).decision).toBe("allow")
  })

  test("targeted read is allowed; huge limit is blocked", async () => {
    const proj = mkdtempSync(join(tmpdir(), "pro-"))
    Bun.spawnSync(["java", "--class-path", classes, main, "record-model", proj, "s", "kimi", "k3"])
    const big = join(proj, "big.txt")
    Bun.write(big, Array.from({ length: 3000 }, (_, i) => `line ${i}`).join("\n"))

    const targeted = Bun.spawnSync(["java", "--class-path", classes, main, "decide-read", proj, "s", big, "10", "50"])
    expect(JSON.parse(targeted.stdout.toString()).decision).toBe("allow")

    const huge = Bun.spawnSync(["java", "--class-path", classes, main, "decide-read", proj, "s", big, "1", "999999"])
    expect(JSON.parse(huge.stdout.toString()).decision).toBe("block")
  })

  test("unknown session fails open", async () => {
    const proj = mkdtempSync(join(tmpdir(), "pro-"))
    const big = join(proj, "big.txt")
    Bun.write(big, "x\n".repeat(3000))
    const r = Bun.spawnSync(["java", "--class-path", classes, main, "decide-read", proj, "unknown", big, "-", "-"])
    expect(JSON.parse(r.stdout.toString()).decision).toBe("allow")
  })
})
