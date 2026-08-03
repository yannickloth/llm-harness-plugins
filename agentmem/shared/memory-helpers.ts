import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { isAbsolute, join } from "node:path"

export const MAX_INJECT_LENGTH = 8000
export const MAX_TOTAL_TOKENS = 12_000
export const MAX_SECTION_TOKENS = 2_000
export const CHARS_PER_TOKEN = 4

export const FILE_TOOLS: ReadonlySet<string> = new Set(["read", "grep", "glob", "edit", "write", "find", "ls"])

export function estimateTokens(text: string): number {
  if (!text) return 0
  return Math.ceil(text.length / CHARS_PER_TOKEN)
}

export function loadMemIndex(memDirPath: string): string | null {
  const f = join(memDirPath, "MEMORY.md")
  if (!existsSync(f)) return null
  const content = readFileSync(f, "utf-8").trim()
  if (!content) return null
  return content.length > MAX_INJECT_LENGTH
    ? content.slice(0, MAX_INJECT_LENGTH) + "\n... [truncated]"
    : content
}

export function collectTopicFiles(memDirPath: string): string {
  if (!existsSync(memDirPath)) return ""
  const parts: string[] = []
  const entries = readdirSync(memDirPath)
    .filter(e => e.endsWith(".md") && e !== "MEMORY.md" && e !== "REVIEW.md")
    .sort()
  for (const entry of entries) {
    const filePath = join(memDirPath, entry)
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

export function collectScopedMem(cwd: string, projectRoot: string): string[] {
  const results: string[] = []
  const rooted = projectRoot.endsWith("/") ? projectRoot : projectRoot + "/"
  let current = cwd
  while (current.startsWith(rooted) || current === projectRoot) {
    const memFile = join(current, "MEMORY.md")
    if (existsSync(memFile) && current !== join(projectRoot, ".agentmem")) {
      const content = readFileSync(memFile, "utf-8").trim()
      if (content) {
        const idx = current === projectRoot ? "root" : current.slice(rooted.length) || "root"
        results.push(`### Scoped memory: ${idx}\n${content}`)
      }
    }
    if (current === projectRoot) break
    current = join(current, "..")
  }
  return results
}

export function extractFilePathFromToolInput(input: Record<string, unknown>): string | null {
  if (typeof input.filePath === "string") return input.filePath
  if (typeof input.file_path === "string") return input.file_path
  if (typeof input.query === "object" && input.query) {
    const q = input.query as Record<string, unknown>
    if (typeof q.path === "string") return q.path
    if (typeof q.directory === "string") return q.directory
  }
  if (typeof input.target_directory === "string" && (input.target_directory as string).length > 0) return input.target_directory as string
  if (typeof input.path === "string" && (input.path as string).length > 0) return input.path as string
  return null
}

export function resolveAbsolute(cwd: string, rawPath: string): string {
  return isAbsolute(rawPath) ? rawPath : join(cwd, rawPath)
}
