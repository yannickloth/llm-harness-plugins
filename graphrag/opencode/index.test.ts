import { describe, test, expect, afterAll } from "bun:test"
import { join } from "path"
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, utimesSync } from "fs"
import { claimSpawnSlot } from "./spawn-slot"
import {
  gateMissing, statusNotice, readManifestV2, mergeManifestV2Atomic,
  resolveEnvKey, parseGraphragYamlConfig, probeEndpoint, requiredArtifacts, isQueryMode,
  isStructuralFile, markRemoved, markFullReindex, reconcileFromGit, readReconcileState,
  isRelevantFile,
} from "./lifecycle"

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

describe("gateMissing (FS-5)", () => {
  const allParquets = ["text_units.parquet", "communities.parquet", "community_reports.parquet", "covariates.parquet", "entities.parquet", "relationships.parquet"]

  test("empty fixture reports every required entry for each mode", () => {
    const dir = freshDir("gate-empty")
    expect(gateMissing(dir, "global")).toEqual(["communities.parquet", "community_reports.parquet"])
    expect(gateMissing(dir, "local")).toEqual(["text_units.parquet", "lancedb"])
    expect(gateMissing(dir, "drift")).toEqual(["covariates.parquet", "entities.parquet", "relationships.parquet"])
  })

  test("complete fixture passes; zero-size parquet counts as missing", () => {
    const dir = freshDir("gate-full")
    const out = join(dir, "output")
    mkdirSync(out, { recursive: true })
    for (const f of allParquets) writeFileSync(join(out, f), "x")
    mkdirSync(join(dir, "lancedb"))
    writeFileSync(join(dir, "lancedb", "table.lance"), "x")
    expect(gateMissing(dir, "global")).toEqual([])
    expect(gateMissing(dir, "local")).toEqual([])
    writeFileSync(join(out, "communities.parquet"), "")
    expect(gateMissing(dir, "global")).toEqual(["communities.parquet"])
  })

  test("requiredArtifacts is consistent with gateMissing and isQueryMode", () => {
    expect(requiredArtifacts("global").length).toBe(2)
    expect(isQueryMode("status")).toBe(false)
    expect(isQueryMode("drift")).toBe(true)
  })
})

describe("statusNotice (FS-4)", () => {
  const base = {
    schema: 2, commit: "c0ffee01", timestamp: "2026-08-07T13:10:00Z",
    graphrag_version: "2.7.0", graphrag_binary: "graphrag", dirty: [] as string[],
    removed: [] as string[], full_reindex: false,
    status: "complete", last_good_build: "2026-11-05T00:00:00Z",
    partial_reason: null, failure_reason: null, consecutive_failures: 0,
    artifacts_present: [] as string[],
  }

  test("null manifest reports missing", () => {
    expect(statusNotice(null)).toContain("missing")
  })
  test("complete and fresh is silent", () => {
    expect(statusNotice({ ...base, status: "complete" })).toBeNull()
  })
  test("complete but stale still notifies (regression guard)", () => {
    const line = statusNotice({ ...base, status: "complete", dirty: ["a.typ"] })
    expect(line).toContain("stale")
    expect(line).toContain("1 files changed")
    expect(line).not.toContain("Queries unavailable")
  })
  test("building is silent while fresh", () => {
    const line = statusNotice({ ...base, status: "building", timestamp: new Date().toISOString() })
    expect(line).toBeNull()
  })
  test("building is reported when stale (dead run left the marker)", () => {
    const line = statusNotice({ ...base, status: "building", timestamp: "2026-08-07T13:10:00Z" })
    expect(line).toContain("stuck in building")
    expect(line).toContain("Run graphrag mode=index.")
  })
  test("partial names the reason and the dirty count, without an absolute query claim", () => {
    const line = statusNotice({
      ...base, status: "partial", dirty: ["a.typ", "b.typ"],
      partial_reason: "missing: entities.parquet", consecutive_failures: 3,
    })
    expect(line).toContain("missing: entities.parquet")
    expect(line).toContain("3 consecutive failures")
    expect(line).toContain("Run graphrag mode=index.")
    expect(line).not.toContain("Queries unavailable")
    expect(line).not.toContain("\n")
  })
  test("failed_preflight names the failure reason", () => {
    const line = statusNotice({ ...base, status: "failed_preflight", failure_reason: "embedding endpoint unreachable at http://localhost:1234/v1" })
    expect(line).toContain("embedding endpoint unreachable")
  })
  test("removals alone still make a complete index stale", () => {
    const line = statusNotice({ ...base, status: "complete", removed: ["ch03.tex"] })
    expect(line).toContain("stale")
    expect(line).toContain("1 files removed")
  })
  test("structural inputs alone still make a complete index stale", () => {
    const line = statusNotice({ ...base, status: "complete", full_reindex: true })
    expect(line).toContain("structural inputs changed")
  })
})

describe("manifest v2 helpers (FS contract, A7)", () => {
  test("schema-1 manifest reads with defaults", () => {
    const dir = freshDir("manifest-legacy")
    const file = join(dir, "manifest.json")
    writeFileSync(file, JSON.stringify({
      commit: "c", timestamp: "t", graphrag_version: "2.7.0",
      graphrag_binary: "graphrag", dirty: ["x"],
    }))
    const m = readManifestV2(file)
    expect(m?.schema).toBe(1)
    expect(m?.status).toBe("unknown")
    expect(m?.consecutive_failures).toBe(0)
    expect(m?.artifacts_present).toEqual([])
  })

  test("merge preserves foreign fields and nulls clear fields", () => {
    const dir = freshDir("manifest-merge")
    const file = join(dir, "manifest.json")
    writeFileSync(file, JSON.stringify({
      schema: 2, commit: "keepme", timestamp: "t", graphrag_version: "2.7.0",
      graphrag_binary: "graphrag", dirty: ["x"], status: "failed_preflight",
      failure_reason: "missing env K", consecutive_failures: 2,
      artifacts_present: ["documents.parquet"], last_good_build: null, partial_reason: null,
    }))
    expect(mergeManifestV2Atomic(file, { status: "idle", failure_reason: null })).toBe(true)
    const m = readManifestV2(file)
    expect(m?.commit).toBe("keepme")
    expect(m?.dirty).toEqual(["x"])
    expect(m?.status).toBe("idle")
    expect(m?.failure_reason).toBeNull()
    expect(m?.artifacts_present).toEqual(["documents.parquet"])
  })
})

describe("resolveEnvKey (FS-1)", () => {
  test("process.env hit wins", async () => {
    process.env.__GRAPHRAG_TEST_KEY__ = "from-env"
    expect(await resolveEnvKey("__GRAPHRAG_TEST_KEY__", "/nonexistent-root-dir", "/nonexistent-index-dir")).toBe("from-env")
    delete process.env.__GRAPHRAG_TEST_KEY__
  })

  test(".env fallback parses quotes and comments", async () => {
    const dir = freshDir("envfile")
    writeFileSync(join(dir, ".env"), "# comment\nTEST_VAR = \"quoted-value\"\nOTHER=nope\n")
    expect(await resolveEnvKey("TEST_VAR", dir, dir)).toBe("quoted-value")
  })

  test("absent everywhere resolves to null", async () => {
    const dir = freshDir("env-absent")
    expect(await resolveEnvKey("__GRAPHRAG_NO_SUCH_KEY__", dir, dir)).toBeNull()
  })
})

describe("config parsing and endpoint probe", () => {
  test("parses the plugin's real graphrag.yaml", () => {
    const text = readFileSync(join(import.meta.dir, "..", "config", "graphrag.yaml"), "utf8")
    const parsed = parseGraphragYamlConfig(text)
    expect(parsed.chatApiKeyEnv).toBe("DEEPSEEK_API_KEY")
    expect(parsed.embeddingApiKeyEnv).toBe("GRAPHRAG_API_KEY")
    expect(parsed.embeddingApiBase).toBe("http://localhost:1234/v1")
  })

  test("closed endpoint probes false quickly", async () => {
    expect(await probeEndpoint("http://127.0.0.1:9/v1", 500)).toBe(false)
  })
})

describe("change tracking (deletions, structural inputs, git)", () => {
  const emptyManifest = (over: Record<string, unknown> = {}) => JSON.stringify({
    schema: 2, commit: "c", timestamp: "t", graphrag_version: "2.7.0",
    graphrag_binary: "graphrag", dirty: [], removed: [], full_reindex: false,
    status: "complete", last_good_build: null, partial_reason: null,
    failure_reason: null, consecutive_failures: 0, artifacts_present: [], ...over,
  })

  function gitRepo(name: string): string {
    const dir = freshDir(name)
    const run = (args: string[]) => Bun.spawnSync(["git", "-C", dir, ...args])
    run(["init", "-q"])
    run(["config", "user.email", "t@example.com"])
    run(["config", "user.name", "t"])
    writeFileSync(join(dir, "a.tex"), "alpha")
    writeFileSync(join(dir, "b.tex"), "beta")
    writeFileSync(join(dir, "refs.bib"), "@book{x}")
    run(["add", "."])
    run(["commit", "-q", "-m", "init"])
    return dir
  }

  test("isStructuralFile classifies content-affecting inputs", () => {
    expect(isStructuralFile("/repo", "/repo/refs.bib")).toBe(true)
    expect(isStructuralFile("/repo", "/repo/figures/plot.png")).toBe(true)
    expect(isStructuralFile("/repo", "/repo/ch01.tex")).toBe(false)
    expect(isStructuralFile("/repo", "/repo/build/refs.bib")).toBe(false)
  })

  test("markRemoved dedupes and persists", () => {
    const dir = freshDir("removed")
    const file = join(dir, "manifest.json")
    writeFileSync(file, emptyManifest())
    expect(markRemoved(file, "ch02.tex")).toBe(true)
    expect(markRemoved(file, "ch02.tex")).toBe(false)
    expect(readManifestV2(file)?.removed).toEqual(["ch02.tex"])
  })

  test("markFullReindex is idempotent", () => {
    const dir = freshDir("full")
    const file = join(dir, "manifest.json")
    writeFileSync(file, emptyManifest())
    expect(markFullReindex(file)).toBe(true)
    expect(markFullReindex(file)).toBe(false)
    expect(readManifestV2(file)?.full_reindex).toBe(true)
  })

  test("reconcileFromGit finds edits, deletions, untracked sources and structural changes", () => {
    const dir = gitRepo("git-reconcile")
    const file = join(dir, "manifest.json")
    writeFileSync(file, emptyManifest({ commit: "none" }))
    writeFileSync(join(dir, "a.tex"), "alpha changed")
    rmSync(join(dir, "b.tex"))
    writeFileSync(join(dir, "refs.bib"), "@book{y}")
    writeFileSync(join(dir, "c.tex"), "new")
    const res = reconcileFromGit(dir, readManifestV2(file), file)
    expect(res).not.toBeNull()
    const m = readManifestV2(file)
    expect(m?.dirty).toContain("a.tex")
    expect(m?.dirty).toContain("c.tex")
    expect(m?.removed).toContain("b.tex")
    expect(m?.full_reindex).toBe(true)
  })

  test("reconcileFromGit records when the check ran", () => {
    const dir = gitRepo("git-state")
    const file = join(dir, "manifest.json")
    writeFileSync(file, emptyManifest({ commit: "none" }))
    reconcileFromGit(dir, readManifestV2(file), file)
    const state = readReconcileState(file)
    expect(state).not.toBeNull()
    expect(Date.parse(state!.timestamp)).toBeGreaterThan(0)
  })

  test("nested worktrees are not part of the parent tree", () => {
    expect(isRelevantFile("/repo", "/repo/.worktrees/ch12/ch01.tex")).toBe(false)
    expect(isRelevantFile("/repo", "/repo/worktrees/ch12/ch01.tex")).toBe(false)
    expect(isRelevantFile("/repo", "/repo/ch01.tex")).toBe(true)
  })

  test("worktrees get independent manifests and independent changes", () => {
    const main = gitRepo("worktree-main")
    const wt = join(main, "..", `${main.split("/").pop()}-wt`)
    rmSync(wt, { recursive: true, force: true })
    const run = (dir: string, args: string[]) => Bun.spawnSync(["git", "-C", dir, ...args])
    expect(run(main, ["worktree", "add", "-q", wt, "-b", "wt-branch"]).exitCode).toBe(0)

    const mainManifest = join(main, "manifest.json")
    const wtManifest = join(wt, "manifest.json")
    writeFileSync(mainManifest, emptyManifest({ commit: "none" }))
    writeFileSync(wtManifest, emptyManifest({ commit: "none" }))

    writeFileSync(join(wt, "a.tex"), "changed only in the worktree")

    const mainRes = reconcileFromGit(main, readManifestV2(mainManifest), mainManifest)
    const wtRes = reconcileFromGit(wt, readManifestV2(wtManifest), wtManifest)

    expect(mainRes).not.toBeNull()
    expect(wtRes).not.toBeNull()
    expect(readManifestV2(mainManifest)?.dirty).not.toContain("a.tex")
    expect(readManifestV2(wtManifest)?.dirty).toContain("a.tex")
  })

  test("a stale manifest lock is stolen instead of wedging the merge", () => {
    const dir = freshDir("lock-stale")
    const file = join(dir, "manifest.json")
    writeFileSync(file, emptyManifest())
    const lock = `${file}.lock`
    writeFileSync(lock, "999999\n")
    const old = new Date(Date.now() - 60_000)
    utimesSync(lock, old, old)
    expect(mergeManifestV2Atomic(file, { dirty: ["x.tex"] })).toBe(true)
    expect(readManifestV2(file)?.dirty).toEqual(["x.tex"])
  })

  test("reconcile.ts discovers every manifest under a root", () => {
    const root = freshDir("discover-root")
    const repo = join(root, "one")
    mkdirSync(join(repo, "graph-index"), { recursive: true })
    const run = (args: string[]) => Bun.spawnSync(["git", "-C", repo, ...args])
    run(["init", "-q"]); run(["config", "user.email", "t@example.com"]); run(["config", "user.name", "t"])
    writeFileSync(join(repo, "a.tex"), "alpha")
    run(["add", "."]); run(["commit", "-q", "-m", "init"])
    writeFileSync(join(repo, "graph-index", "manifest.json"), emptyManifest({ commit: "none" }))
    writeFileSync(join(repo, "a.tex"), "changed")

    const script = join(import.meta.dir, "reconcile.ts")
    const proc = Bun.spawnSync(["bun", script, "--roots", root], { timeout: 20000 })
    const out = proc.stdout.toString()
    expect(proc.exitCode).toBe(0)
    expect(out).toContain("1/1 repositories reconciled")
    expect(readManifestV2(join(repo, "graph-index", "manifest.json"))?.dirty).toContain("a.tex")
  })
})
