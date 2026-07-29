import { loadMemIndex, collectTopicFiles, collectScopedMem, extractFilePathFromToolInput, resolveAbsolute } from "../shared/memory-helpers"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { describe, test, expect, beforeEach, afterEach } from "bun:test"

describe("Pi extension helpers", () => {
  let tmpDir: string

  beforeEach(() => { tmpDir = join("/tmp", "agentmem-pi-test-" + Math.random().toString(36).slice(2)); mkdirSync(tmpDir) })
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }) })

  describe("loadMemIndex", () => {
    test("returns null when dir doesn't exist", () => {
      expect(loadMemIndex("/tmp/nonexistent-pi-xyz")).toBeNull()
    })

    test("returns content of MEMORY.md", () => {
      const mdir = join(tmpDir, ".agentmem")
      mkdirSync(mdir)
      writeFileSync(join(mdir, "MEMORY.md"), "- [Bar](bar.md) -- pi test")
      expect(loadMemIndex(mdir)).toBe("- [Bar](bar.md) -- pi test")
    })
  })

  describe("collectTopicFiles", () => {
    test("excludes MEMORY.md and REVIEW.md", () => {
      const mdir = join(tmpDir, ".agentmem")
      mkdirSync(mdir)
      writeFileSync(join(mdir, "alpha.md"), "alpha")
      writeFileSync(join(mdir, "MEMORY.md"), "idx")
      writeFileSync(join(mdir, "REVIEW.md"), "rvw")
      writeFileSync(join(mdir, "beta.md"), "beta")
      const result = collectTopicFiles(mdir)
      expect(result).toContain("alpha.md")
      expect(result).toContain("beta.md")
      expect(result).not.toContain("REVIEW.md")
      expect(result).not.toContain("idx")
    })
  })

  describe("collectScopedMem", () => {
    test("walks upward from cwd to project root", () => {
      mkdirSync(join(tmpDir, "src", "lib"), { recursive: true })
      writeFileSync(join(tmpDir, "src", "MEMORY.md"), "- [src](src.md)")
      writeFileSync(join(tmpDir, "MEMORY.md"), "- [root](root.md)")
      const result = collectScopedMem(join(tmpDir, "src", "lib"), tmpDir)
      expect(result.length).toBe(2)
      expect(result[0]).toContain("Scoped memory: src")
      expect(result[1]).toContain("Scoped memory: root")
    })
  })

  describe("extractFilePathFromToolInput", () => {
    test("extracts path from tool input", () => {
      expect(extractFilePathFromToolInput({ path: "/a/b.ts" })).toBe("/a/b.ts")
    })

    test("returns null for empty path", () => {
      expect(extractFilePathFromToolInput({ path: "" })).toBeNull()
      expect(extractFilePathFromToolInput({})).toBeNull()
    })
  })

  describe("resolveAbsolute", () => {
    test("returns absolute paths unchanged", () => {
      expect(resolveAbsolute("/cwd", "/abs/path")).toBe("/abs/path")
    })

    test("joins relative path with cwd", () => {
      expect(resolveAbsolute("/cwd", "relative/file.ts")).toBe("/cwd/relative/file.ts")
    })
  })
})
