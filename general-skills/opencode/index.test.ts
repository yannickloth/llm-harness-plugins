import { describe, test, expect } from "bun:test"
import pluginFactory from "./index"
import { STE100_MARKER, STE100_RULE } from "./ste100-rule"

const noopClient = {
  app: {
    log: async () => true,
  },
}

describe("general-skills STE-100 system injection", () => {
  test("STE100_RULE starts with the stable marker", () => {
    expect(STE100_RULE.startsWith(STE100_MARKER)).toBe(true)
  })

  test("STE100_RULE names ASD-STE100", () => {
    expect(STE100_RULE).toContain("ASD-STE100 Simplified Technical English")
  })

  test("STE100_RULE covers all ten requirements", () => {
    const reqs = [
      "Approved vocabulary",
      "One meaning per word",
      "Short sentences",
      "Active voice",
      "Simple grammar",
      "Avoid abbreviations",
      "Clarity over style",
      "Structured writing",
      "Sequencing",
      "Negative commands",
    ]
    for (const r of reqs) expect(STE100_RULE).toContain(r)
  })

  test("STE100_RULE states scope applies to technical/scientific and exempts chat", () => {
    expect(STE100_RULE).toContain("technical or scientific")
    expect(STE100_RULE).toContain("conversational chat")
  })

  test("system.transform injects the rule at the front of the system prompt", async () => {
    const plugin = await pluginFactory({ client: noopClient } as any)
    const output = { system: ["existing system"] }
    await plugin["experimental.chat.system.transform"]({} as any, output)
    expect(output.system).toHaveLength(2)
    expect(output.system[0].startsWith(STE100_MARKER)).toBe(true)
    expect(output.system[1]).toBe("existing system")
  })

  test("system.transform does not duplicate when marker already present", async () => {
    const plugin = await pluginFactory({ client: noopClient } as any)
    const output = { system: [STE100_RULE, "existing system"] }
    await plugin["experimental.chat.system.transform"]({} as any, output)
    expect(output.system).toHaveLength(2)
  })

  test("system.transform handles an empty system array", async () => {
    const plugin = await pluginFactory({ client: noopClient } as any)
    const output = { system: [] }
    await plugin["experimental.chat.system.transform"]({} as any, output)
    expect(output.system).toHaveLength(1)
    expect(output.system[0].startsWith(STE100_MARKER)).toBe(true)
  })
})
