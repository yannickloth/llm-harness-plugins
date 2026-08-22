import { describe, test, expect, beforeEach } from "bun:test"
import {
  classifyTopic,
  updateSessionTopic,
  getSessionTopic,
  setSessionTopic,
  clearSessionTopic,
  shouldInjectProjectContext,
} from "./session-topic"

describe("classifyTopic", () => {
  test("returns project for code/tooling messages", () => {
    expect(classifyTopic("please refactor the file src/app.ts")).toBe("project")
    expect(classifyTopic("run the build and tests")).toBe("project")
    expect(classifyTopic("fix the bug in main.java")).toBe("project")
  })

  test("returns project for coordination/plugin jargon", () => {
    expect(classifyTopic("coord_claim the session task")).toBe("project")
    expect(classifyTopic("agentfeed ledger build: fast")).toBe("project")
    expect(classifyTopic("run integrate-topic now")).toBe("project")
  })

  test("returns personal for a French personal question", () => {
    expect(classifyTopic("est-il normal que ma femme dorme mieux sur un matelas gonflable")).toBe("personal")
  })

  test("returns personal for German/Spanish/Italian personal text", () => {
    expect(classifyTopic("warum schläft meine frau besser auf einer matratze")).toBe("personal")
    expect(classifyTopic("por qué mi mujer duerme mejor en un colchón")).toBe("personal")
    expect(classifyTopic("perché mia moglie dorme meglio su un materasso")).toBe("personal")
  })

  test("returns unknown for ambiguous short text", () => {
    expect(classifyTopic("hello there")).toBe("unknown")
  })
})

describe("session topic lifecycle", () => {
  beforeEach(() => {
    clearSessionTopic("s")
  })

  test("unknown by default, not injected", () => {
    expect(getSessionTopic("s")).toBe("unknown")
    expect(shouldInjectProjectContext("s")).toBe(false)
  })

  test("personal message makes session personal and non-injected", () => {
    const t = updateSessionTopic("s", "ma femme dort mal sur le matelas")
    expect(t).toBe("personal")
    expect(shouldInjectProjectContext("s")).toBe(false)
  })

  test("project message makes session project and injected", () => {
    const t = updateSessionTopic("s", "refactor the build in src/main.java")
    expect(t).toBe("project")
    expect(shouldInjectProjectContext("s")).toBe(true)
  })

  test("project is sticky even after a later personal message", () => {
    updateSessionTopic("s", "fix the bug in module.ts")
    updateSessionTopic("s", "bonjour comment vas-tu")
    expect(getSessionTopic("s")).toBe("project")
    expect(shouldInjectProjectContext("s")).toBe(true)
  })

  test("a personal session can turn project later", () => {
    updateSessionTopic("s", "je parle de ma femme")
    expect(getSessionTopic("s")).toBe("personal")
    updateSessionTopic("s", "how do I fix the build?")
    expect(getSessionTopic("s")).toBe("project")
  })

  test("setSessionTopic and clearSessionTopic work", () => {
    setSessionTopic("s", "project")
    expect(shouldInjectProjectContext("s")).toBe(true)
    clearSessionTopic("s")
    expect(getSessionTopic("s")).toBe("unknown")
  })
})
