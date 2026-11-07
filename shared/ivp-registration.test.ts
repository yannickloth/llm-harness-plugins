import { describe, expect, test } from "bun:test"
import { dirname, join } from "path"
import { fileURLToPath } from "url"
import { existsSync } from "fs"

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const ivp = join(root, "ivp")

/**
 * Registration contract for the ivp pack.
 *
 * The plugin ships three channels and each uses a *different* editor shape:
 *
 *   skill.transform   -> editor.add(skill)
 *   agent.transform   -> editor.update(id, fn)      (create-by-update)
 *   command.transform -> editor.add(definition)
 *
 * Writing the command registry with `update` throws inside a `try`, so the
 * transform reports success while registering nothing. That failure is silent at
 * runtime and cost a live probe to find, so it is pinned here: the fake editors
 * below expose *only* the method the real one has.
 */

function fakeSkillEditor(sink: any[]) {
  return { add: (s: any) => sink.push(s) }
}

function fakeAgentEditor(sink: any[]) {
  return {
    get: () => undefined,
    update: (id: string, fn: (a: any) => void) => {
      // The real editor inserts a default agent, so `permissions` exists.
      const agent: any = { permissions: [] }
      fn(agent)
      sink.push({ id, ...agent })
    },
  }
}

function fakeCommandEditor(sink: any[]) {
  return { add: (def: any) => sink.push(def) }
}

async function runSetup() {
  const mod = await import(join(ivp, "opencode", "index.ts"))
  const skills: any[] = []
  const agents: any[] = []
  const commands: any[] = []
  const ctx = {
    skill: { transform: async (fn: any) => fn(fakeSkillEditor(skills)) },
    agent: { transform: async (fn: any) => fn(fakeAgentEditor(agents)) },
    command: { transform: async (fn: any) => fn(fakeCommandEditor(commands)) },
  }
  await (mod.default as any).setup(ctx)
  return { skills, agents, commands }
}

describe("ivp registration", () => {
  test("registers every skill directory", async () => {
    const { skills } = await runSetup()
    expect(skills.map(s => s.id).sort()).toEqual([
      "apply-ivp",
      "assess-ivp",
      "identify-change-drivers",
      "review-ivp-to-convergence",
      "sort-into-modules",
    ])
    for (const s of skills) {
      expect(s.path.startsWith(ivp)).toBe(true)
      expect(s.content.length).toBeGreaterThan(0)
    }
  })

  test("registers every agent through create-by-update", async () => {
    const { agents } = await runSetup()
    expect(agents.map(a => a.id).sort()).toEqual([
      "current-modularization-auditor",
      "driver-assignment-auditor",
      "driver-identifier",
      "gamma-modularizer",
      "ivp-refactor-auditor",
      "nest-decider",
    ])
    for (const a of agents) {
      expect(a.mode).toBe("subagent")
      expect(a.model).toEqual({ providerID: "deepseek", id: "deepseek-v4-pro" })
    }
  })

  test("every agent prompt carries the absolute knowledge-path preamble", async () => {
    const { agents } = await runSetup()
    const expected = join(ivp, "prompts", "ivp-knowledge.md")
    // The canonical checkout is a sibling of the plugins repo, not inside it.
    const canonical = join(root, "..", "ivp-book-series")
    for (const a of agents) {
      expect(a.system).toContain(expected)
      // The preamble must state the canonical checkout's status, present or not,
      // so an agent never assumes a checkout it cannot read.
      expect(a.system).toContain(canonical)
    }
  })

  test("registers every command through add", async () => {
    const { commands } = await runSetup()
    expect(commands.map(c => c.name).sort()).toEqual([
      "apply-ivp",
      "assess-ivp",
      "identify-change-drivers",
      "review-ivp-to-convergence",
      "sort-into-modules",
    ])
    for (const c of commands) {
      expect(typeof c.template).toBe("string")
      expect(c.template.length).toBeGreaterThan(0)
    }
  })

  test("the read-only assessment command runs in a child session", async () => {
    const { commands } = await runSetup()
    const assess = commands.find(c => c.name === "assess-ivp")
    expect(assess.agent).toBe("current-modularization-auditor")
    expect(assess.subtask).toBe(true)
  })

  test("v1 path registers skills and agents, and has no command channel", async () => {
    const mod = await import(join(ivp, "opencode", "index.ts"))
    const config: any = { skills: {}, agent: {} }
    const hooks = await (mod.default as any).server({ client: { app: { log: async () => {} } } })
    await hooks.config(config)

    expect(config.skills.paths).toEqual([join(ivp, "skills")])
    expect(Object.keys(config.agent).length).toBe(6)
    expect(config.commands).toBeUndefined()
    // The preamble is applied to v1 prompts too.
    expect(config.agent["driver-identifier"].prompt).toContain(join(ivp, "prompts", "ivp-knowledge.md"))
  })
})

describe("ivp file layout", () => {
  test("prompts/ivp-knowledge.md exists (the preamble points at it)", () => {
    expect(existsSync(join(ivp, "prompts", "ivp-knowledge.md"))).toBe(true)
  })

  test("imports no symbol it does not use", async () => {
    const src = await Bun.file(join(ivp, "opencode", "index.ts")).text()
    const names: string[] = []
    for (const line of src.split("\n")) {
      if (!line.startsWith("import ")) continue
      const braced = line.match(/\{([^}]+)\}/)
      if (!braced) continue
      for (const part of braced[1].split(",")) {
        const name = part.trim().split(/\s+as\s+/).pop()?.trim()
        if (name) names.push(name)
      }
    }
    expect(names.length).toBeGreaterThan(0)
    for (const name of names) {
      // Count references outside the import statement itself.
      const uses = src
        .split("\n")
        .filter(l => !l.startsWith("import "))
        .filter(l => new RegExp(`\\b${name}\\b`).test(l))
        .filter(l => !/^\s*(\*|\/\/)/.test(l)) // comments mentioning a name do not count
      expect({ name, used: uses.length > 0 }).toEqual({ name, used: true })
    }
  })
})
