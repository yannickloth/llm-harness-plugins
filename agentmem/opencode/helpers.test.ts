import { loadMemIndex, collectScopedMem, collectTopicFiles, extractFilePathFromToolInput } from "../shared/memory-helpers"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { describe, test, expect, beforeEach, afterEach } from "bun:test"

describe("OpenCode plugin helpers", () => {
  let tmpDir: string

  beforeEach(() => { tmpDir = join("/tmp", "agentmem-test-" + Math.random().toString(36).slice(2)); mkdirSync(tmpDir) })
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }) })

  describe("loadMemIndex", () => {
    test("returns null when dir doesn't exist", () => {
      expect(loadMemIndex("/tmp/nonexistent-xyz")).toBeNull()
    })

    test("returns null when MEMORY.md is empty", () => {
      const mdir = join(tmpDir, "empty-idx")
      mkdirSync(mdir)
      writeFileSync(join(mdir, "MEMORY.md"), "")
      expect(loadMemIndex(mdir)).toBeNull()
    })

    test("returns content of MEMORY.md", () => {
      const mdir = join(tmpDir, "with-idx")
      mkdirSync(mdir)
      writeFileSync(join(mdir, "MEMORY.md"), "- [Foo](foo.md) -- test")
      expect(loadMemIndex(mdir)).toBe("- [Foo](foo.md) -- test")
    })

    test("truncates content over MAX_INJECT_LENGTH", () => {
      const mdir = join(tmpDir, "big-idx")
      mkdirSync(mdir)
      const big = "x".repeat(9000)
      writeFileSync(join(mdir, "MEMORY.md"), big)
      const result = loadMemIndex(mdir)
      expect(result).toBeTruthy()
      expect(result!.length).toBeLessThanOrEqual(8020)
      expect(result).toContain("truncated")
    })
  })

  describe("collectScopedMem", () => {
    test("returns empty array when no MEMORY.md in tree", () => {
      mkdirSync(join(tmpDir, "subdir"), { recursive: true })
      expect(collectScopedMem(join(tmpDir, "subdir"), tmpDir)).toEqual([])
    })

    test("finds MEMORY.md in cwd and ancestor dirs", () => {
      mkdirSync(join(tmpDir, "a", "b", "c"), { recursive: true })
      writeFileSync(join(tmpDir, "a", "MEMORY.md"), "- [A](a.md)")
      writeFileSync(join(tmpDir, "MEMORY.md"), "- [Root](root.md)")
      const result = collectScopedMem(join(tmpDir, "a", "b", "c"), tmpDir)
      expect(result.length).toBe(2)
      expect(result[0]).toContain("Scoped memory: a")
      expect(result[1]).toContain("Scoped memory: root")
    })

    test("skips .agentmem directory MEMORY.md", () => {
      mkdirSync(join(tmpDir, ".agentmem"), { recursive: true })
      writeFileSync(join(tmpDir, ".agentmem", "MEMORY.md"), "agentmem index")
      const result = collectScopedMem(join(tmpDir, ".agentmem"), tmpDir)
      expect(result).toEqual([])
    })
  })

  describe("collectTopicFiles", () => {
    test("returns empty when dir doesn't exist", () => {
      expect(collectTopicFiles("/tmp/nonexistent-xyz")).toBe("")
    })

    test("collects .md files excluding MEMORY.md and REVIEW.md", () => {
      const mdir = join(tmpDir, ".agentmem")
      mkdirSync(mdir)
      writeFileSync(join(mdir, "alpha.md"), "alpha content")
      writeFileSync(join(mdir, "MEMORY.md"), "index")
      writeFileSync(join(mdir, "REVIEW.md"), "review")
      writeFileSync(join(mdir, "notes.txt"), "not md")
      const result = collectTopicFiles(mdir)
      expect(result).toContain("alpha.md")
      expect(result).toContain("alpha content")
      expect(result).not.toContain("REVIEW.md")
      expect(result).not.toContain("notes.txt")
    })

    test("truncates when total content exceeds MAX_INJECT_LENGTH", () => {
      const mdir = join(tmpDir, ".agentmem")
      mkdirSync(mdir)
      writeFileSync(join(mdir, "big.md"), "---\n" + "x".repeat(8200))
      const result = collectTopicFiles(mdir)
      expect(result).toContain("truncated")
    })
  })

  describe("extractFilePathFromToolInput", () => {
    test("extracts filePath field", () => {
      expect(extractFilePathFromToolInput({ filePath: "/foo/bar.ts" })).toBe("/foo/bar.ts")
    })

    test("extracts path field as fallback", () => {
      expect(extractFilePathFromToolInput({ path: "/fallback/path.ts" })).toBe("/fallback/path.ts")
    })

    test("extracts from query.path for glob-like tools", () => {
      expect(extractFilePathFromToolInput({ query: { path: "/q/glob.ts" } })).toBe("/q/glob.ts")
    })

    test("returns null when no path found", () => {
      expect(extractFilePathFromToolInput({ command: "ls", other: "stuff" })).toBeNull()
    })
  })
})
