import { describe, test, expect } from "bun:test"
import { readFileSync } from "fs"
import { dirname, join } from "path"
import { fileURLToPath } from "url"
import { parseAgent, readAgentRecords, registerAgentDirV1, registerAgentDirV2 } from "./agents"

const root = dirname(dirname(fileURLToPath(import.meta.url)))

const SAMPLE = `---
name: sample-auditor
description: Verifies things. Read-only.
mode: subagent
steps: 4
model: deepseek/deepseek-flash
color: "#ff6b6b"
permission:
  read: allow
  edit: deny
  bash: deny
  task: deny
tools: [Read, Glob, Grep]
---

# Sample

Body line one.
Body line two.
`

describe("parseAgent", () => {
  test("reads scalars, body, and the permission map", () => {
    const rec = parseAgent(SAMPLE, "fallback")
    expect(rec.id).toBe("sample-auditor")
    expect(rec.description).toBe("Verifies things. Read-only.")
    expect(rec.mode).toBe("subagent")
    expect(rec.steps).toBe(4)
    expect(rec.model).toBe("deepseek/deepseek-flash")
    expect(rec.color).toBe("#ff6b6b")
    expect(rec.system).toBe("# Sample\n\nBody line one.\nBody line two.")
    expect(rec.permissionMap).toEqual({ read: "allow", edit: "deny", bash: "deny", task: "deny" })
  })

  test("maps V1 permission verbs to V2 actions", () => {
    const rec = parseAgent(SAMPLE, "fallback")
    expect(rec.permissions).toEqual([
      { action: "read", resource: "*", effect: "allow" },
      { action: "edit", resource: "*", effect: "deny" },
      { action: "shell", resource: "*", effect: "deny" },
      { action: "subagent", resource: "*", effect: "deny" },
    ])
  })

  test("ignores Claude-style tools: lists and permissionMode", () => {
    const rec = parseAgent(`---\nname: x\ntools: [Read, Edit, Bash]\npermissionMode: acceptEdits\n---\nbody`, "x")
    expect(rec.permissions).toEqual([])
    expect(rec.permissionMap).toEqual({})
    expect(rec.system).toBe("body")
  })

  test("drops bare model aliases (V2 needs provider/model) and keeps variant", () => {
    expect(parseAgent(`---\nname: x\nmodel: haiku\n---\nb`, "x").model).toBeUndefined()
    expect(parseAgent(`---\nname: x\nmodel: anthropic/claude-sonnet-4-5#high\n---\nb`, "x").model).toBe(
      "anthropic/claude-sonnet-4-5#high",
    )
  })

  test("defaults mode to subagent and id to the filename when absent", () => {
    const rec = parseAgent(`---\ndescription: d\n---\nbody`, "from-file")
    expect(rec.mode).toBe("subagent")
    expect(rec.id).toBe("from-file")
  })
})

describe("registerAgentDirV2", () => {
  function mockEditor() {
    const agents = new Map<string, any>()
    return {
      agents,
      editor: {
        get: (id: string) => agents.get(id),
        update: (id: string, fn: (a: any) => void) => {
          const a = agents.get(id) ?? { id, permissions: [{ action: "*", resource: "*", effect: "allow" }] }
          if (!agents.has(id)) agents.set(id, a)
          fn(a)
        },
      },
    }
  }

  test("creates agents inline and appends rules to the defaults", () => {
    const { agents, editor } = mockEditor()
    const n = registerAgentDirV2(editor, join(root, "agentmem", "agents"))
    expect(n).toBeGreaterThan(0)

    const keeper = agents.get("memory-keeper")
    expect(keeper).toBeDefined()
    expect(keeper.mode).toBe("subagent")
    expect(keeper.steps).toBe(5)
    expect(keeper.system).toContain("memory") // body captured as system
    // default allow-all rule is preserved, then frontmatter rules appended
    expect(keeper.permissions[0]).toEqual({ action: "*", resource: "*", effect: "allow" })
    expect(keeper.permissions).toContainEqual({ action: "edit", resource: "*", effect: "allow" })
    expect(keeper.permissions).toContainEqual({ action: "shell", resource: "*", effect: "allow" })
  })

  test("is idempotent across transform replays", () => {
    const { agents, editor } = mockEditor()
    const first = registerAgentDirV2(editor, join(root, "agentmem", "agents"))
    const second = registerAgentDirV2(editor, join(root, "agentmem", "agents"))
    expect(first).toBeGreaterThan(0)
    expect(second).toBe(0)
    expect(agents.size).toBe(first)
  })

  test("no-op for a missing directory", () => {
    const { editor } = mockEditor()
    expect(registerAgentDirV2(editor, join(root, "does-not-exist"))).toBe(0)
  })
})

describe("registerAgentDirV1", () => {
  test("builds inline V1 agent entries (singular `agent` map)", () => {
    const config: any = {}
    const n = registerAgentDirV1(config, join(root, "agentmem", "agents"))
    expect(n).toBeGreaterThan(0)
    const keeper = config.agent["memory-keeper"]
    expect(keeper.mode).toBe("subagent")
    expect(keeper.prompt).toContain("memory")
    expect(keeper.maxSteps).toBe(5)
    // bash is a V1 permission verb
    expect(keeper.permission).toEqual({ edit: "allow", bash: "allow" })
  })

  test("expresses unsupported-verb denies as tools:false", () => {
    const config: any = {}
    registerAgentDirV1(config, join(root, "general-skills", "agents"))
    const auditor = config.agent["config-auditor"]
    expect(auditor.permission).toMatchObject({ edit: "deny", bash: "deny" })
    expect(auditor.tools).toMatchObject({ task: false })
  })

  test("does not clobber an existing config agent", () => {
    const config: any = { agent: { "memory-keeper": { mode: "primary" } } }
    registerAgentDirV1(config, join(root, "agentmem", "agents"))
    expect(config.agent["memory-keeper"]).toEqual({ mode: "primary" })
  })
})

describe("readAgentRecords", () => {
  test("reads every agent file in the repo's agent directories", () => {
    for (const plugin of ["agentmem", "general-skills", "scientific-writing", "typst-toolkit", "ivp"]) {
      const records = readAgentRecords(join(root, plugin, "agents"))
      expect(records.length).toBeGreaterThan(0)
      for (const rec of records) {
        expect(rec.id.length).toBeGreaterThan(0)
        expect(rec.system.length).toBeGreaterThan(0)
      }
    }
  })

  test("every plugin that ships agents wires both registration paths", () => {
    const plugins = [
      "agentmem", "context-toolkit", "general-skills", "ivp", "latex-toolkit",
      "natural-prose", "premium-read-offload", "scientific-writing",
      "sdlc-guardrails", "tier-router", "typst-toolkit",
    ]
    for (const plugin of plugins) {
      const withAgents = readAgentRecords(join(root, plugin, "agents")).length > 0
      const src = readFileSync(join(root, plugin, "opencode", "index.ts"), "utf8")
      const wired = /registerAgentDirV2/.test(src) && /registerAgentDirV1/.test(src)
      expect({ plugin, withAgents, wired }).toEqual({ plugin, withAgents: true, wired: true })
    }
  })
})
