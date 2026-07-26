import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { isAbsolute, join, resolve } from "node:path"
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs"
import { describe, test, expect, beforeEach, afterEach } from "bun:test"

// Duplicated from agentmem/pi/index.ts for testing
const MAX_INJECT = 8000

function loadMemIndex(mdir: string): string | null {
  const f = join(mdir, "MEMORY.md")
  if (!existsSync(f)) return null
  const content = readFileSync(f, "utf-8").trim()
  if (!content) return null
  return content.length > MAX_INJECT ? content.slice(0, MAX_INJECT) + "\n... [truncated]" : content
}

function loadTopicFiles(mdir: string): string {
  if (!existsSync(mdir)) return ""
  const parts: string[] = []
  for (const entry of readdirSync(mdir)) {
    if (!entry.endsWith(".md") || entry === "MEMORY.md" || entry === "REVIEW.md") continue
    const fp = join(mdir, entry)
    if (!statSync(fp).isFile()) continue
    const content = readFileSync(fp, "utf-8")
    const combined = `\n<!-- memory: ${entry} -->\n${content}`
    parts.push(combined)
  }
  const full = parts.join("\n")
  return full.length > MAX_INJECT ? full.slice(0, MAX_INJECT) + "\n... [truncated]" : full
}

function collectScoped(cwd: string, projectRoot: string): string[] {
  const results: string[] = []
  let current = cwd
  while (current.length >= projectRoot.length && current.startsWith(projectRoot)) {
    const memFile = join(current, "MEMORY.md")
    if (existsSync(memFile) && current !== join(projectRoot, ".agentmem")) {
      const content = readFileSync(memFile, "utf-8").trim()
      if (content) {
        const relDir = current === projectRoot ? "root" : current.slice(projectRoot.length + 1) || "root"
        results.push(`### Scoped memory: ${relDir}\n${content}`)
      }
    }
    if (current === projectRoot) break
    current = join(current, "..")
  }
  return results
}

function resolveFilePath(input: Record<string, unknown>): string | null {
  if (typeof input.path === "string" && input.path.length > 0) return input.path
  return null
}

function resolveAbsolute(cwd: string, rawPath: string): string {
  if (isAbsolute(rawPath)) return rawPath
  return join(cwd, rawPath)
}

describe("Pi extension helpers", () => {
  let tmpDir: string

  beforeEach(() => { tmpDir = mkdtempSync("/tmp/agentmem-pi-test-") })
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

  describe("loadTopicFiles", () => {
    test("excludes MEMORY.md and REVIEW.md", () => {
      const mdir = join(tmpDir, ".agentmem")
      mkdirSync(mdir)
      writeFileSync(join(mdir, "alpha.md"), "alpha")
      writeFileSync(join(mdir, "MEMORY.md"), "idx")
      writeFileSync(join(mdir, "REVIEW.md"), "rvw")
      writeFileSync(join(mdir, "beta.md"), "beta")
      const result = loadTopicFiles(mdir)
      expect(result).toContain("alpha.md")
      expect(result).toContain("beta.md")
      expect(result).not.toContain("REVIEW.md")
      expect(result).not.toContain("idx")
    })
  })

  describe("collectScoped", () => {
    test("walks upward from cwd to project root", () => {
      mkdirSync(join(tmpDir, "src", "lib"), { recursive: true })
      writeFileSync(join(tmpDir, "src", "MEMORY.md"), "- [src](src.md)")
      writeFileSync(join(tmpDir, "MEMORY.md"), "- [root](root.md)")
      const result = collectScoped(join(tmpDir, "src", "lib"), tmpDir)
      expect(result.length).toBe(2)
      expect(result[0]).toContain("Scoped memory: src")
      expect(result[1]).toContain("Scoped memory: root")
    })
  })

  describe("resolveFilePath", () => {
    test("extracts path from tool input", () => {
      expect(resolveFilePath({ path: "/a/b.ts" })).toBe("/a/b.ts")
    })

    test("returns null for empty path", () => {
      expect(resolveFilePath({ path: "" })).toBeNull()
      expect(resolveFilePath({})).toBeNull()
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
