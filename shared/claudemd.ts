import { readFileSync, realpathSync, existsSync, statSync, lstatSync } from "fs"
import path from "path"

export const TEXT_FILE_EXTENSIONS = new Set([
  ".md", ".mdc", ".markdown", ".txt", ".typ", ".tex",
  ".ts", ".js", ".mjs", ".cjs", ".tsx", ".jsx",
  ".py", ".rb", ".java", ".scala", ".kt", ".kts",
  ".c", ".h", ".cpp", ".hpp", ".cc", ".hh", ".cxx", ".hxx",
  ".rs", ".go", ".zig", ".swift", ".cs",
  ".html", ".htm", ".css", ".scss", ".sass", ".less",
  ".json", ".jsonc", ".json5", ".xml", ".yaml", ".yml", ".toml", ".ini", ".cfg",
  ".sh", ".bash", ".zsh", ".fish",
  ".sql", ".graphql", ".gql",
  ".env", ".dockerfile", ".makefile", ".mk",
  ".rst", ".adoc", ".asciidoc",
  ".claude", ".cursorrules", ".gitignore", ".gitattributes",
])

const INCLUDE_RE = /^@\S+$/
const MAX_INCLUDE_DEPTH = 16
const MAX_FILE_SIZE = 2 * 1024 * 1024 // 2MB

interface Token {
  type: string
  raw: string
  text?: string
  tokens?: Token[]
}

function stripHtmlComments(text: string): string {
  let result = text
  result = result.replace(/<!--[\s\S]*?-->/g, "")
  result = result.replace(/<!--.*/gm, "")
  return result
}

function isBinary(ext: string): boolean {
  return !TEXT_FILE_EXTENSIONS.has(ext.toLowerCase())
}

function walkTextTokens(tokens: Token[], context: Set<string>): string[] {
  const results: string[] = []

  for (const token of tokens) {
    switch (token.type) {
      case "code":
      case "codespan":
        continue

      case "html":
        continue

      case "text": {
        if (token.text !== undefined) {
          results.push(token.text)
        } else if (token.tokens) {
          results.push(...walkTextTokens(token.tokens, context))
        } else {
          results.push(token.raw ?? "")
        }
        break
      }

      case "paragraph":
      case "heading":
      case "list":
      case "list_item":
      case "blockquote":
      case "table":
      case "table_row":
      case "table_cell":
      case "em":
      case "strong":
      case "del":
      case "link":
      case "image":
      case "br":
      case "hr":
      case "space":
      case "html_block": {
        if (token.tokens) {
          results.push(...walkTextTokens(token.tokens, context))
        } else if (token.type === "html_block") {
          continue
        }
        break
      }

      default: {
        if (token.text !== undefined) {
          results.push(token.text)
        } else if (token.tokens) {
          results.push(...walkTextTokens(token.tokens, context))
        }
        break
      }
    }
  }

  return results
}

function walkLexTokens(lexTokens: Token[], context: Set<string>): string[] {
  const results: string[] = []

  for (const token of lexTokens) {
    switch (token.type) {
      case "code":
      case "codespan":
      case "html":
      case "html_block":
        continue

      case "paragraph":
      case "heading":
      case "text":
      case "em":
      case "strong":
      case "del":
      case "link":
      case "list":
      case "list_item":
      case "blockquote":
      case "table":
      case "table_row":
      case "table_cell":
      case "br":
      case "hr":
      case "space": {
        if (token.text !== undefined) {
          results.push(token.text)
        } else if (token.tokens) {
          results.push(...walkTextTokens(token.tokens, context))
        }
        break
      }

      default: {
        if (token.text !== undefined) {
          results.push(token.text)
        }
        break
      }
    }
  }

  return results
}

function extractIncludePathsFromTokensList(rawTokens: Token[]): string[] {
  const textParts = walkLexTokens(rawTokens, new Set())
  const combined = textParts.join("\n")
  const stripped = stripHtmlComments(combined)

  const paths: string[] = []
  for (const line of stripped.split("\n")) {
    const trimmed = line.trim()
    if (trimmed.startsWith("@@/") && /^@\S+$/.test(trimmed)) {
      paths.push(trimmed.slice(1))
    } else if (trimmed.startsWith("@") && /^@\S+$/.test(trimmed)) {
      paths.push(trimmed.slice(1))
    }
  }

  return paths
}

function parseMarkdownTokens(text: string): Token[] {
  const tokens: Token[] = []
  if (!text || typeof text !== "string") return tokens
  const lines = text.split("\n")
  let i = 0

  while (i < lines.length) {
    const line = lines[i]

    if (line.startsWith("```") || line.startsWith("~~~")) {
      const fenceMarker = line.slice(0, 3)
      const fenceStart = i
      i++
      const codeLines: string[] = []
      while (i < lines.length) {
        if (lines[i].startsWith(fenceMarker)) break
        codeLines.push(lines[i])
        i++
      }
      tokens.push({
        type: "code",
        raw: lines.slice(fenceStart, i + 1).join("\n"),
        text: codeLines.join("\n"),
      })
      i++
      continue
    }

    if (line.startsWith("|") && i + 1 < lines.length) {
      const nextLine = lines[i + 1]
      if (/^\|[\s\-:]+\|/.test(nextLine)) {
        const tableStart = i
        i += 2
        while (i < lines.length && lines[i].startsWith("|")) {
          i++
        }
        tokens.push({
          type: "table",
          raw: lines.slice(tableStart, i).join("\n"),
          tokens: undefined,
        })
        continue
      }
    }

    const headingMatch = line.match(/^(#{1,6})\s+(.*)/)
    if (headingMatch) {
      tokens.push({
        type: "heading",
        raw: line,
        text: headingMatch[2],
        tokens: [{ type: "text", raw: headingMatch[2], text: headingMatch[2] }],
      })
      i++
      continue
    }

    if (line.startsWith("> ")) {
      const blockStart = i
      while (i < lines.length && lines[i].startsWith("> ")) {
        i++
      }
      tokens.push({
        type: "blockquote",
        raw: lines.slice(blockStart, i).join("\n"),
        tokens: [{ type: "text", raw: lines.slice(blockStart, i).map((l: string) => l.slice(2)).join("\n"), text: lines.slice(blockStart, i).map((l: string) => l.slice(2)).join("\n") }],
      })
      continue
    }

    if (line.match(/^(\s*[-*+]\s+|\s*\d+\.\s+)/)) {
      const listStart = i
      const listLines: string[] = []
      while (i < lines.length && lines[i].match(/^(\s*[-*+]\s+|\s*\d+\.\s+|^\s{2,})/)) {
        listLines.push(lines[i])
        i++
      }
      tokens.push({
        type: "list",
        raw: listLines.join("\n"),
        tokens: [{ type: "text", raw: listLines.join("\n"), text: listLines.join("\n") }],
      })
      continue
    }

    if (/^<[a-zA-Z]/.test(line)) {
      const htmlStart = i
      while (i < lines.length && !/^<\/[a-zA-Z]/.test(lines[i])) {
        i++
      }
      if (i < lines.length) i++ // past closing tag
      tokens.push({
        type: "html",
        raw: lines.slice(htmlStart, i).join("\n"),
        tokens: undefined,
      })
      continue
    }

    if (line.trim() === "") {
      tokens.push({ type: "space", raw: line, text: "\n" })
      i++
      continue
    }

    // paragraph: accumulate non-empty, non-special lines
    const paraStart = i
    while (i < lines.length &&
      lines[i].trim() !== "" &&
      !lines[i].startsWith("`") &&
      !lines[i].startsWith("~") &&
      !lines[i].startsWith("#") &&
      !lines[i].startsWith("> ") &&
      !lines[i].startsWith("|") &&
      !lines[i].match(/^(\s*[-*+]\s+|\s*\d+\.\s+)/) &&
      !/^<[a-zA-Z]/.test(lines[i])) {
      i++
    }
    if (i > paraStart) {
      const paraText = lines.slice(paraStart, i).join("\n")
      tokens.push({
        type: "paragraph",
        raw: paraText,
        text: paraText,
        tokens: [{ type: "text", raw: paraText, text: paraText }],
      })
      continue
    }

    i++
  }

  return tokens
}

export function extractIncludePathsFromTokens(text: string): string[] {
  const stripped = stripHtmlComments(text)
  const tokens = parseMarkdownTokens(stripped)
  return extractIncludePathsFromTokensList(tokens)
}

export function extractIncludePaths(text: string): string[] {
  if (!text || typeof text !== "string") return []
  const tokens = parseMarkdownTokens(text)
  return extractIncludePathsFromTokensList(tokens)
}

function resolvePath(includePath: string, sourceDir: string): string {
  if (includePath.startsWith("~/")) {
    const home = process.env.HOME || process.env.USERPROFILE
    if (!home) throw new Error("@include uses ~/ but HOME is not set")
    return path.resolve(home, includePath.slice(2))
  }
  if (includePath.startsWith("@/")) {
    return path.resolve(sourceDir, includePath.slice(2))
  }
  return path.resolve(sourceDir, includePath)
}

export interface IncludeResult {
  content: string
  included: string[]
}

export function parseClaudeMd(filePath: string, rootDir?: string): IncludeResult {
  const resolved = path.resolve(filePath)
  return resolveIncludes(resolved, rootDir ?? path.dirname(resolved), new Set(), 0)
}

function resolveIncludes(absPath: string, rootDir: string, visited: Set<string>, depth: number): IncludeResult {
  if (depth > MAX_INCLUDE_DEPTH) {
    throw new Error(`@include depth exceeded ${MAX_INCLUDE_DEPTH} at ${absPath}`)
  }

  const canonical = path.resolve(absPath)
  if (visited.has(canonical)) {
    throw new Error(`circular @include: ${canonical}`)
  }
  visited.add(canonical)

  if (!existsSync(canonical)) {
    throw new Error(`@include file not found: ${canonical}`)
  }

  const stats = statSync(canonical)
  if (stats.isDirectory()) {
    throw new Error(`@include target is a directory: ${canonical}`)
  }
  if (stats.size > MAX_FILE_SIZE) {
    throw new Error(`@include file too large (>2MB): ${canonical}`)
  }

  const lstats = lstatSync(canonical)
  let realPath: string
  if (lstats.isSymbolicLink()) {
    realPath = realpathSync(canonical)
  } else {
    realPath = canonical
  }

  const ext = path.extname(realPath)
  if (isBinary(ext)) {
    throw new Error(`@include binary file blocked (${ext}): ${realPath}`)
  }

  const normalizedRoot = realpathSync(path.resolve(rootDir))

  const sourceRoot = path.dirname(canonical)
  let content = readFileSync(canonical, "utf-8")
  const paths = extractIncludePaths(content)
  const included = [canonical]

  for (const incPath of paths) {
    const target = resolvePath(incPath, sourceRoot)
    const childCanonical = path.resolve(target)
    if (existsSync(childCanonical)) {
      const childReal = realpathSync(childCanonical)
      if (!childReal.startsWith(normalizedRoot + path.sep) && childReal !== normalizedRoot) {
        throw new Error(`@include path escapes root directory: ${childReal} not under ${normalizedRoot}`)
      }
    }
    try {
      const result = resolveIncludes(target, rootDir, visited, depth + 1)
      const marker = `@${incPath}`
      const lines = content.split("\n")
      for (let j = 0; j < lines.length; j++) {
        const stripped = stripHtmlComments(lines[j]).trim()
        if (stripped === marker) {
          lines[j] = lines[j].replace(marker, result.content)
        }
      }
      content = lines.join("\n")
      included.push(...result.included)
    } catch (e: unknown) {
      const msg = (e as Error).message
      if (msg.includes("circular") || msg.includes("depth")) throw e
    }
    visited.delete(path.resolve(target))
  }

  return { content, included }
}

export function parseClaudeMdText(text: string, sourceDir: string = process.cwd(), rootDir?: string): IncludeResult {
  const paths = extractIncludePaths(text)
  let content = text
  const allIncluded: string[] = []
  const resolvedRoot = rootDir ?? sourceDir

  const visited = new Set<string>()
  for (const incPath of paths) {
    const target = resolvePath(incPath, sourceDir)
    const result = resolveIncludes(target, resolvedRoot, visited, 0)
    const marker = `@${incPath}`
    const lines = content.split("\n")
    for (let j = 0; j < lines.length; j++) {
      const stripped = stripHtmlComments(lines[j]).trim()
      if (stripped === marker) {
        lines[j] = lines[j].replace(marker, result.content)
      }
    }
    content = lines.join("\n")
    allIncluded.push(...result.included)
  }

  return { content, included: allIncluded }
}

export function gatherIncludes(filePath: string, rootDir?: string): string[] {
  const abs = path.resolve(filePath)
  return collectIncludes(abs, rootDir ?? path.dirname(abs), new Set(), 0)
}

function collectIncludes(absPath: string, rootDir: string, visited: Set<string>, depth: number): string[] {
  if (depth > MAX_INCLUDE_DEPTH || visited.has(absPath)) return []

  const canonical = path.resolve(absPath)
  if (visited.has(canonical)) return []
  visited.add(canonical)

  if (!existsSync(canonical)) return []
  const stats = lstatSync(canonical)
  if (stats.isDirectory()) return []

  const realPath = stats.isSymbolicLink() ? realpathSync(canonical) : canonical
  const ext = path.extname(realPath)
  if (isBinary(ext)) return []

  const normalizedRoot = realpathSync(path.resolve(rootDir))

  const content = readFileSync(canonical, "utf-8")
  const paths = extractIncludePaths(content)
  const sourceRoot = path.dirname(canonical)
  const results = [canonical]

  for (const incPath of paths) {
    const target = resolvePath(incPath, sourceRoot)
    const childCanonical = path.resolve(target)
    if (existsSync(childCanonical)) {
      const childReal = realpathSync(childCanonical)
      if (!childReal.startsWith(normalizedRoot + path.sep) && childReal !== normalizedRoot) continue
    }
    try {
      results.push(...collectIncludes(target, rootDir, visited, depth + 1))
    } catch (e: unknown) {
      const msg = (e as Error).message
      if (msg.includes("circular") || msg.includes("depth")) throw e
    }
    visited.delete(path.resolve(target))
  }

  return results
}
