import { $ } from "bun"
import path from "path"
import { existsSync, readdirSync, statSync, readFileSync } from "fs"
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "fs"
import { describe, test, expect, beforeEach, afterEach } from "bun:test"

// Duplicate the pure helpers for testing (they're module-internal in index.ts)
// These are the exact same implementations from agentmem/opencode/index.ts

const MAX_INJECT_LENGTH = 8000

function loadMemIndex(memDirPath: string): string | null {
  const f = path.join(memDirPath, "MEMORY.md")
  if (!existsSync(f)) return null
  const content = readFileSync(f, "utf-8").trim()
  if (!content) return null
  return content.length > MAX_INJECT_LENGTH
    ? content.slice(0, MAX_INJECT_LENGTH) + "\n... [truncated]"
    : content
}

function collectScopedMem(cwd: string, projectRoot: string): string[] {
  const results: string[] = []
  let current = cwd
  while (current.startsWith(projectRoot)) {
    const memFile = path.join(current, "MEMORY.md")
    if (existsSync(memFile) && current !== path.join(projectRoot, ".agentmem")) {
      const content = readFileSync(memFile, "utf-8").trim()
      if (content) {
        const relDir = path.relative(projectRoot, current) || "root"
        results.push(`### Scoped memory: ${relDir}\n${content}`)
      }
    }
    if (current === projectRoot) break
    current = path.dirname(current)
  }
  return results
}

function collectTopicFiles(memDirPath: string): string {
  if (!existsSync(memDirPath)) return ""
  const parts: string[] = []
  for (const entry of readdirSync(memDirPath)) {
    if (!entry.endsWith(".md") || entry === "MEMORY.md" || entry === "REVIEW.md") continue
    const filePath = path.join(memDirPath, entry)
    if (!statSync(filePath).isFile()) continue
    const content = readFileSync(filePath, "utf-8")
    const combined = `\n<!-- memory: ${entry} -->\n${content}`
    parts.push(combined)
  }
  const full = parts.join("\n")
  return full.length > MAX_INJECT_LENGTH
    ? full.slice(0, MAX_INJECT_LENGTH) + "\n... [truncated]"
    : full
}

function extractFilePathFromToolInput(input: Record<string, unknown>): string | null {
  if (typeof input.filePath === "string") return input.filePath
  if (typeof input.file_path === "string") return input.file_path
  if (typeof input.query === "object" && input.query) {
    const q = input.query as Record<string, unknown>
    if (typeof q.path === "string") return q.path
    if (typeof q.directory === "string") return q.directory
  }
  if (typeof input.target_directory === "string") return input.target_directory
  if (typeof input.path === "string") return input.path
  return null
}

describe("OpenCode plugin helpers", () => {
  let tmpDir: string

  beforeEach(() => { tmpDir = mkdtempSync("/tmp/agentmem-test-") })
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }) })

  describe("loadMemIndex", () => {
    test("returns null when dir doesn't exist", () => {
      expect(loadMemIndex("/tmp/nonexistent-xyz")).toBeNull()
    })

    test("returns null when MEMORY.md is empty", () => {
      const mdir = path.join(tmpDir, "empty-idx")
      mkdirSync(mdir)
      writeFileSync(path.join(mdir, "MEMORY.md"), "")
      expect(loadMemIndex(mdir)).toBeNull()
    })

    test("returns content of MEMORY.md", () => {
      const mdir = path.join(tmpDir, "with-idx")
      mkdirSync(mdir)
      writeFileSync(path.join(mdir, "MEMORY.md"), "- [Foo](foo.md) -- test")
      expect(loadMemIndex(mdir)).toBe("- [Foo](foo.md) -- test")
    })

    test("truncates content over MAX_INJECT_LENGTH", () => {
      const mdir = path.join(tmpDir, "big-idx")
      mkdirSync(mdir)
      const big = "x".repeat(MAX_INJECT_LENGTH + 1000)
      writeFileSync(path.join(mdir, "MEMORY.md"), big)
      const result = loadMemIndex(mdir)
      expect(result).toBeTruthy()
      expect(result!.length).toBeLessThanOrEqual(MAX_INJECT_LENGTH + 20)
      expect(result).toContain("truncated")
    })
  })

  describe("collectScopedMem", () => {
    test("returns empty array when no MEMORY.md in tree", () => {
      mkdirSync(path.join(tmpDir, "subdir"), { recursive: true })
      expect(collectScopedMem(path.join(tmpDir, "subdir"), tmpDir)).toEqual([])
    })

    test("finds MEMORY.md in cwd and ancestor dirs", () => {
      mkdirSync(path.join(tmpDir, "a", "b", "c"), { recursive: true })
      writeFileSync(path.join(tmpDir, "a", "MEMORY.md"), "- [A](a.md)")
      writeFileSync(path.join(tmpDir, "MEMORY.md"), "- [Root](root.md)")
      const result = collectScopedMem(path.join(tmpDir, "a", "b", "c"), tmpDir)
      expect(result.length).toBe(2)
      expect(result[0]).toContain("Scoped memory: a")
      expect(result[1]).toContain("Scoped memory: root")
    })

    test("skips .agentmem directory MEMORY.md", () => {
      mkdirSync(path.join(tmpDir, ".agentmem"), { recursive: true })
      writeFileSync(path.join(tmpDir, ".agentmem", "MEMORY.md"), "agentmem index")
      const result = collectScopedMem(path.join(tmpDir, ".agentmem"), tmpDir)
      expect(result).toEqual([])
    })
  })

  describe("collectTopicFiles", () => {
    test("returns empty when dir doesn't exist", () => {
      expect(collectTopicFiles("/tmp/nonexistent-xyz")).toBe("")
    })

    test("collects .md files excluding MEMORY.md and REVIEW.md", () => {
      const mdir = path.join(tmpDir, ".agentmem")
      mkdirSync(mdir)
      writeFileSync(path.join(mdir, "alpha.md"), "alpha content")
      writeFileSync(path.join(mdir, "MEMORY.md"), "index")
      writeFileSync(path.join(mdir, "REVIEW.md"), "review")
      writeFileSync(path.join(mdir, "notes.txt"), "not md")
      const result = collectTopicFiles(mdir)
      expect(result).toContain("alpha.md")
      expect(result).toContain("alpha content")
      expect(result).not.toContain("REVIEW.md")
      expect(result).not.toContain("notes.txt")
    })

    test("truncates when total content exceeds MAX_INJECT_LENGTH", () => {
      const mdir = path.join(tmpDir, ".agentmem")
      mkdirSync(mdir)
      writeFileSync(path.join(mdir, "big.md"), "---\n" + "x".repeat(MAX_INJECT_LENGTH + 200))
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
