import { SectionRegistry } from "./section-registry"
import { cachedSection, uncachedSection, orgCachedSection } from "./cache-boundary"
import { describe, test, expect } from "bun:test"

describe("SectionRegistry", () => {
  test("registers and resolves cached sections", async () => {
    const reg = new SectionRegistry()
    reg.section("rules", () => "rule content")
    reg.section("tools", () => "tool content")

    const sections = await reg.resolveSections()

    expect(sections).toHaveLength(2)
    expect(sections[0].cacheScope).toBe("global")
    expect(sections[0].content).toBe("rule content")
    expect(sections[1].cacheScope).toBe("global")
    expect(sections[1].content).toBe("tool content")
  })

  test("registers and resolves uncached sections with reason", async () => {
    const reg = new SectionRegistry()
    reg.uncached("status", () => "current status", "session-scoped git status")

    const sections = await reg.resolveSections()

    expect(sections).toHaveLength(1)
    expect(sections[0].cacheScope).toBeNull()
    expect(sections[0].reason).toBe("session-scoped git status")
    expect(sections[0].content).toBe("current status")
  })

  test("registers org sections", async () => {
    const reg = new SectionRegistry()
    reg.orgSection("org-rules", () => "org-level rules")

    const sections = await reg.resolveSections()

    expect(sections).toHaveLength(1)
    expect(sections[0].cacheScope).toBe("org")
    expect(sections[0].content).toBe("org-level rules")
  })

  test("async factories resolve", async () => {
    const reg = new SectionRegistry()
    reg.section("async-header", async () => {
      await new Promise(r => setTimeout(r, 5))
      return "async result"
    })

    const sections = await reg.resolveSections()

    expect(sections).toHaveLength(1)
    expect(sections[0].content).toBe("async result")
  })

  test("factory returning ScopedSection passes through directly", async () => {
    const reg = new SectionRegistry()
    reg.section("raw", () => cachedSection("raw content"))

    const sections = await reg.resolveSections()

    expect(sections).toHaveLength(1)
    expect(sections[0].content).toBe("raw content")
    expect(sections[0].cacheScope).toBe("global")
  })

  test("factory returning uncachedSection passes through with reason", async () => {
    const reg = new SectionRegistry()
    reg.uncached("dynamic", () => uncachedSection("override content", "custom-reason"), "original-reason")

    const sections = await reg.resolveSections()

    expect(sections).toHaveLength(1)
    expect(sections[0].content).toBe("override content")
    expect(sections[0].reason).toBe("custom-reason")
  })

  test("null/empty factory results are skipped", async () => {
    const reg = new SectionRegistry()
    reg.section("skip-null", () => null!)
    reg.section("skip-empty", () => "")
    reg.section("visible", () => "visible")

    const sections = await reg.resolveSections()

    expect(sections).toHaveLength(1)
    expect(sections[0].content).toBe("visible")
  })

  test("clear removes all sections", () => {
    const reg = new SectionRegistry()
    reg.section("a", () => "a")
    reg.uncached("b", () => "b", "reason-b")

    expect(reg.size).toBe(2)

    reg.clear()

    expect(reg.size).toBe(0)
  })

  test("overwrite warns on duplicate name", async () => {
    const warnings: string[] = []
    const logger = {
      debug: (..._a: unknown[]) => {},
      info: (..._a: unknown[]) => {},
      warn: (...a: unknown[]) => { if (typeof a[0] === "string") warnings.push(a[0]) },
      error: (..._a: unknown[]) => {},
    }
    const reg = new SectionRegistry(logger)
    reg.section("dup", () => "first")
    reg.section("dup", () => "second")

    expect(warnings.some(w => w.includes('replacing existing section "dup"'))).toBe(true)

    const sections = await reg.resolveSections()
    expect(sections).toHaveLength(1)
    expect(sections[0].content).toBe("second")
  })

  test("failed factory is skipped with error logged", async () => {
    const errors: string[] = []
    const logger = {
      debug: (..._a: unknown[]) => {},
      info: (..._a: unknown[]) => {},
      warn: (..._a: unknown[]) => {},
      error: (...a: unknown[]) => { if (typeof a[0] === "string") errors.push(a[0]) },
    }
    const reg = new SectionRegistry(logger)
    reg.section("fail", () => { throw new Error("boom") })
    reg.section("pass", () => "pass")

    const sections = await reg.resolveSections()

    expect(errors.some(w => w.includes('failed resolving section "fail"'))).toBe(true)
    expect(sections).toHaveLength(1)
    expect(sections[0].content).toBe("pass")
  })

  test("buildPrompt combines cached and uncached sections with boundary", async () => {
    const reg = new SectionRegistry()
    reg.section("static", () => "static rules")
    reg.uncached("dynamic", () => "dynamic context", "per-session context")

    const prompt = await reg.buildPrompt()

    expect(prompt).toContain("static rules")
    expect(prompt).toContain("__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__")
    expect(prompt).toContain("dynamic context")
    expect(prompt.indexOf("static rules")).toBeLessThan(prompt.indexOf("__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__"))
    expect(prompt.indexOf("__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__")).toBeLessThan(prompt.indexOf("dynamic context"))
  })

  test("report shows section counts", () => {
    const reg = new SectionRegistry()
    reg.section("a", () => "a")
    reg.section("b", () => "b")
    reg.orgSection("c", () => "c")
    reg.uncached("d", () => "d", "reason-d")
    reg.uncached("e", () => "e", "reason-e")

    const report = reg.report()

    expect(report).toContain("2cached + 1org + 2uncached = 5 total")
    expect(report).toContain("reason-d")
    expect(report).toContain("reason-e")
  })

  test("entries is readonly map", () => {
    const reg = new SectionRegistry()
    reg.section("a", () => "a")

    const entries = reg.entries
    expect(entries.get("a")?.name).toBe("a")
    expect(entries.get("a")?.cacheScope).toBe("global")
  })

  test("chaining works for fluent API", async () => {
    const reg = new SectionRegistry()
      .section("a", () => "a")
      .uncached("b", () => "b", "reason-b")
      .orgSection("c", () => "c")

    expect(reg.size).toBe(3)

    const sections = await reg.resolveSections()
    expect(sections).toHaveLength(3)
  })
})
