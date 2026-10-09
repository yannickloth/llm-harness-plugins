import { writeLoadCanary } from "./load-canary"
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { afterEach, describe, expect, test } from "bun:test"

describe("writeLoadCanary", () => {
  let dir: string

  const start = () => {
    dir = mkdtempSync(join(tmpdir(), "load-canary-"))
    process.env.LLMHP_CANARY_DIR = dir
    process.env.LLMHP_CANARY_NONCE = "n0"
  }

  afterEach(() => {
    delete process.env.LLMHP_CANARY_DIR
    delete process.env.LLMHP_CANARY_NONCE
    rmSync(dir, { recursive: true, force: true })
  })

  test("writes a nonce-scoped marker with epoch and pid", () => {
    start()
    writeLoadCanary("datetime-inject")
    const files = readdirSync(dir)
    expect(files).toEqual(["n0.datetime-inject.testigo"])
    const [epoch, perf, pid] = readFileSync(join(dir, files[0]), "utf8").trim().split(" ")
    expect(Number(epoch)).toBeGreaterThan(0)
    expect(Number(perf)).toBeGreaterThan(0)
    expect(Number(pid)).toBeGreaterThan(0)
  })

  test("scopes markers to the nonce so stale probes do not count", () => {
    start()
    process.env.LLMHP_CANARY_NONCE = "n2"
    writeLoadCanary("agentmem")
    writeLoadCanary("tier-router")
    expect(readdirSync(dir).sort()).toEqual(["n2.agentmem.testigo", "n2.tier-router.testigo"])
  })

  test("is a no-op without the probe env (interactive sessions)", () => {
    dir = mkdtempSync(join(tmpdir(), "load-canary-"))
    delete process.env.LLMHP_CANARY_DIR
    delete process.env.LLMHP_CANARY_NONCE
    writeLoadCanary("datetime-inject")
    expect(readdirSync(dir)).toEqual([])
    rmSync(dir, { recursive: true, force: true })
  })

  test("is a no-op with only one of the two env vars", () => {
    start()
    delete process.env.LLMHP_CANARY_NONCE
    writeLoadCanary("datetime-inject")
    delete process.env.LLMHP_CANARY_DIR
    process.env.LLMHP_CANARY_NONCE = "n0"
    writeLoadCanary("datetime-inject")
    expect(readdirSync(dir)).toEqual([])
  })

  test("swallows filesystem errors instead of failing the plugin load", () => {
    const base = mkdtempSync(join(tmpdir(), "load-canary-"))
    const blocker = join(base, "not-a-dir")
    writeFileSync(blocker, "a file where the marker dir should be")
    process.env.LLMHP_CANARY_DIR = blocker
    process.env.LLMHP_CANARY_NONCE = "n0"
    expect(() => writeLoadCanary("datetime-inject")).not.toThrow()
    delete process.env.LLMHP_CANARY_DIR
    delete process.env.LLMHP_CANARY_NONCE
    rmSync(base, { recursive: true, force: true })
  })
})
