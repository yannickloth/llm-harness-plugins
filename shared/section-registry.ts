import {
  buildPromptWithBoundary,
  cachedSection,
  uncachedSection,
  orgCachedSection,
  type ScopedSection,
} from "./cache-boundary"

type SectionFactory = () => string | Promise<string> | ScopedSection | Promise<ScopedSection>

export interface SectionEntry {
  name: string
  factory: SectionFactory
  cacheScope: "global" | "org" | null
  reason?: string
}

export class SectionRegistry {
  private sections = new Map<string, SectionEntry>()

  section(name: string, factory: SectionFactory): SectionRegistry {
    if (this.sections.has(name)) {
      console.warn(`[section-registry] replacing existing section "${name}"`)
    }
    this.sections.set(name, { name, factory, cacheScope: "global" })
    return this
  }

  orgSection(name: string, factory: SectionFactory): SectionRegistry {
    if (this.sections.has(name)) {
      console.warn(`[section-registry] replacing existing section "${name}"`)
    }
    this.sections.set(name, { name, factory, cacheScope: "org" })
    return this
  }

  uncached(name: string, factory: SectionFactory, reason: string): SectionRegistry {
    if (this.sections.has(name)) {
      console.warn(`[section-registry] replacing existing section "${name}"`)
    }
    this.sections.set(name, { name, factory, cacheScope: null, reason })
    return this
  }

  async resolveSections(): Promise<ScopedSection[]> {
    const resolved: ScopedSection[] = []

    for (const entry of this.sections.values()) {
      try {
        const raw = await entry.factory()

        if (raw == null || raw === "") continue

        if (typeof raw === "object" && "cacheScope" in raw) {
          resolved.push(raw as ScopedSection)
        } else if (typeof raw === "string") {
          switch (entry.cacheScope) {
            case "global":
              resolved.push(cachedSection(raw))
              break
            case "org":
              resolved.push(orgCachedSection(raw))
              break
            case null:
              resolved.push(uncachedSection(raw, entry.reason ?? "unspecified"))
              break
          }
        }
      } catch (e) {
        console.error(
          `[section-registry] failed resolving section "${entry.name}":`,
          (e as Error).message
        )
      }
    }

    return resolved
  }

  buildPrompt(): Promise<string> {
    return this.resolveSections().then(buildPromptWithBoundary)
  }

  report(): string {
    const entries = [...this.sections.values()]
    const cached = entries.filter(e => e.cacheScope === "global").length
    const org = entries.filter(e => e.cacheScope === "org").length
    const uncached = entries.filter(e => e.cacheScope === null).length
    const reasons = entries
      .filter(e => e.cacheScope === null && e.reason)
      .map(e => `  - ${e.reason} [${e.name}]`)

    let r = `[section-registry] sections: ${cached}cached + ${org}org + ${uncached}uncached = ${entries.length} total`
    if (reasons.length > 0) r += `\n${reasons.join("\n")}`
    return r
  }

  clear(): void {
    this.sections.clear()
  }

  get entries(): ReadonlyMap<string, SectionEntry> {
    return this.sections
  }

  get size(): number {
    return this.sections.size
  }
}
