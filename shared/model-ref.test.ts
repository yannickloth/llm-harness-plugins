import { describe, expect, test } from "bun:test"
import { isModelRef, parseModelRef } from "./model-ref"

describe("parseModelRef", () => {
  test("provider/model", () => {
    expect(parseModelRef("anthropic/claude-sonnet-5-5")).toEqual({
      providerID: "anthropic",
      id: "claude-sonnet-5-5",
    })
  })

  test("provider/model#variant", () => {
    expect(parseModelRef("deepseek/deepseek-v4-pro#high")).toEqual({
      providerID: "deepseek",
      id: "deepseek-v4-pro",
      variant: "high",
    })
  })

  test("rejects a bare alias", () => {
    expect(parseModelRef("sonnet")).toBeUndefined()
  })

  test("rejects an empty provider or id", () => {
    expect(parseModelRef("/model")).toBeUndefined()
    expect(parseModelRef("provider/")).toBeUndefined()
  })

  test("rejects whitespace and empty input", () => {
    expect(parseModelRef("a b/c")).toBeUndefined()
    expect(parseModelRef("")).toBeUndefined()
    expect(parseModelRef(undefined)).toBeUndefined()
    expect(parseModelRef(null)).toBeUndefined()
  })

  test("trims surrounding whitespace", () => {
    expect(parseModelRef("  a/b  ")).toEqual({ providerID: "a", id: "b" })
  })

  test("the id may contain slashes (provider is the first segment)", () => {
    expect(parseModelRef("openai/gpt/x")).toEqual({ providerID: "openai", id: "gpt/x" })
  })
})

describe("isModelRef", () => {
  test("agrees with parseModelRef", () => {
    for (const raw of ["a/b", "a/b#c", "sonnet", "", "a/", "/b", "a b/c", undefined]) {
      expect({ raw, ok: isModelRef(raw) }).toEqual({ raw, ok: parseModelRef(raw) !== undefined })
    }
  })
})

describe("single definition", () => {
  test("the grammar is not re-inlined elsewhere in shared/", async () => {
    const files = ["agents.ts", "v2-commands.ts", "v2-skills.ts"]
    for (const f of files) {
      const src = await Bun.file(new URL(`./${f}`, import.meta.url)).text()
      // The provider/model grammar must appear once, in model-ref.ts only.
      const inlined = src.match(/\[1\^\\s\/#\]/g) ?? []
      expect({ file: f, inlined: inlined.length }).toEqual({ file: f, inlined: 0 })
    }
  })
})
