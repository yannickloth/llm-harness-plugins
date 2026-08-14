import { describe, test, expect, afterAll } from "bun:test"
import { join } from "path"
import { mkdirSync, writeFileSync, rmSync, existsSync } from "fs"
import { claimSpawnSlot } from "./index"

let tmpRoot = join(import.meta.dir, "..", "build", "test-tmp-graphrag-plugin")

function freshDir(name: string): string {
  const dir = join(tmpRoot, name)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  return dir
}

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true })
})

describe("claimSpawnSlot", () => {
  test("allows first launch with no prior state", async () => {
    const dir = freshDir("first")
    expect(await claimSpawnSlot(dir, 0)).toBe(true)
  })

  test("blocks a second launch within the min interval", async () => {
    const dir = freshDir("rate")
    expect(await claimSpawnSlot(dir, 60_000)).toBe(true)
    expect(await claimSpawnSlot(dir, 60_000)).toBe(false)
  })

  test("clamps non-positive interval to a safe default (never disables throttle)", async () => {
    const dir = freshDir("clamp")
    expect(await claimSpawnSlot(dir, 0)).toBe(true)
    // minIntervalMs=0 is clamped to the 60s default, so a rapid second call is blocked
    expect(await claimSpawnSlot(dir, 0)).toBe(false)
  })

  test("blocks when a live indexer holds .lock", async () => {
    const dir = freshDir("live-lock")
    const pid = process.pid
    writeFileSync(join(dir, ".lock"), `${pid}\n`)
    expect(await claimSpawnSlot(dir, 0)).toBe(false)
  })

  test("does not block when .lock owner is dead", async () => {
    const dir = freshDir("dead-lock")
    const proc = Bun.spawnSync(["sleep", "0"])
    const pid = proc.pid!
    // poll until the child is fully reaped so kill -0 reports it gone
    const deadline = Date.now() + 5000
    while (Bun.spawnSync(["kill", "-0", String(pid)]).exitCode === 0 && Date.now() < deadline) {
      Bun.sleepSync(10)
    }
    writeFileSync(join(dir, ".lock"), `${pid}\n`)
    expect(await claimSpawnSlot(dir, 0)).toBe(true)
  })

  test("steals a stale .spawn-lock whose owner is dead", async () => {
    const dir = freshDir("stale-spawn")
    const proc = Bun.spawnSync(["sleep", "0"])
    const pid = proc.pid!
    const deadline = Date.now() + 5000
    while (Bun.spawnSync(["kill", "-0", String(pid)]).exitCode === 0 && Date.now() < deadline) {
      Bun.sleepSync(10)
    }
    writeFileSync(join(dir, ".spawn-lock"), `${pid}\n`)
    expect(await claimSpawnSlot(dir, 0)).toBe(true)
  })

  test("respects a live .spawn-lock holder", async () => {
    const dir = freshDir("live-spawn")
    writeFileSync(join(dir, ".spawn-lock"), `${process.pid}\n`)
    expect(await claimSpawnSlot(dir, 0)).toBe(false)
  })

  test("does not leave coordination files behind after success", async () => {
    const dir = freshDir("cleanup")
    expect(await claimSpawnSlot(dir, 0)).toBe(true)
    expect(existsSync(join(dir, ".spawn-lock"))).toBe(false)
    expect(existsSync(join(dir, ".last-launch"))).toBe(true)
  })
})
