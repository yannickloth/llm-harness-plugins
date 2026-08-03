export const SYSTEM_PROMPT_DYNAMIC_BOUNDARY = "__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__"

export type CacheScope = "global" | "org" | null

export interface ScopedSection {
  content: string
  cacheScope: CacheScope
  reason?: string
}

export function cachedSection(content: string): ScopedSection {
  return { content, cacheScope: "global" }
}

export function uncachedSection(content: string, reason: string): ScopedSection {
  return { content, cacheScope: null, reason }
}

export function orgCachedSection(content: string): ScopedSection {
  return { content, cacheScope: "org" }
}

export function buildPromptWithBoundary(sections: ScopedSection[]): string {
  const cached = sections.filter(s => s.cacheScope !== null)
  const uncached = sections.filter(s => s.cacheScope === null)

  const parts: string[] = []

  if (cached.length > 0) {
    parts.push(cached.map(s => s.content).join("\n\n"))
  }

  if (uncached.length > 0) {
    parts.push(SYSTEM_PROMPT_DYNAMIC_BOUNDARY)
    parts.push(uncached.map(s => s.content).join("\n\n"))
  }

  return parts.join("\n")
}

export function tagSection(content: string, scope: CacheScope, reason?: string): string {
  const reasonClause = reason ? ` reason="${reason.replace(/"/g, "'")}"` : ""
  return `<!-- cache-scope:${scope ?? "null"}${reasonClause} -->\n${content}`
}

export function isDynamicBoundary(line: string): boolean {
  return line.trim() === SYSTEM_PROMPT_DYNAMIC_BOUNDARY
}

export function reportScopeBreakdown(sections: ScopedSection[]): string {
  const cached = sections.filter(s => s.cacheScope === "global").length
  const org = sections.filter(s => s.cacheScope === "org").length
  const uncached = sections.filter(s => s.cacheScope === null).length
  const reasons = sections
    .filter(s => s.cacheScope === null && s.reason)
    .map(s => `  - ${s.reason}`)

  let report = `[cache-boundary] sections: ${cached}cached + ${org}org + ${uncached}uncached = ${sections.length} total`
  if (reasons.length > 0) {
    report += `\n${reasons.join("\n")}`
  }
  return report
}
