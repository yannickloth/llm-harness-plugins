import { describe, test, expect } from "bun:test"
import { existsSync, readFileSync, readdirSync, statSync } from "fs"
import { join, resolve } from "path"
import plugin from "./index"
import { readAgentRecords, registerAgentDirV1, registerAgentDirV2 } from "../../shared/agents"
import { parseFrontmatter, registerSkillDir } from "../../shared/v2-skills"

const PACK = resolve(import.meta.dir, "..")
const REPO = resolve(PACK, "..")
const SKILLS = join(PACK, "skills")
const AGENTS = join(PACK, "agents")
const KNOWLEDGE = join(PACK, "prompts", "ivp-knowledge.md")

const EXPECTED_SKILLS = [
  "apply-ivp",
  "assess-ivp",
  "identify-change-drivers",
  "review-ivp-to-convergence",
  "sort-into-modules",
]

const EXPECTED_AGENTS = [
  "current-modularization-auditor",
  "driver-assignment-auditor",
  "driver-identifier",
  "gamma-modularizer",
  "ivp-refactor-auditor",
  "nest-decider",
]

/** Report-only agents: they must not be able to edit. */
const READ_ONLY_AGENTS = [
  "current-modularization-auditor",
  "driver-assignment-auditor",
  "ivp-refactor-auditor",
  "nest-decider",
]

/** Agents that move code or write the registry. */
const WRITING_AGENTS = ["driver-identifier", "gamma-modularizer"]

describe("ivp plugin entrypoint", () => {
  test("declares the ivp id and both harness entrypoints", () => {
    expect(plugin.id).toBe("ivp")
    expect(typeof plugin.server).toBe("function")
    expect(typeof plugin.setup).toBe("function")
  })
})

describe("ivp skills", () => {
  test("the expected skills exist and nothing else is shipped", () => {
    const found = readdirSync(SKILLS)
      .filter(entry => statSync(join(SKILLS, entry)).isDirectory())
      .sort()
    expect(found).toEqual([...EXPECTED_SKILLS].sort())
  })

  for (const name of EXPECTED_SKILLS) {
    test(`${name} has a SKILL.md whose name matches its directory`, () => {
      const file = join(SKILLS, name, "SKILL.md")
      expect(existsSync(file)).toBe(true)
      const raw = readFileSync(file, "utf8")
      const { name: declared, description } = parseFrontmatter(raw)
      expect(declared).toBe(name)
      expect(description ?? "").toContain("IVP")
    })
  }

  test("every step of the six-step process is owned by a skill", () => {
    const corpus = EXPECTED_SKILLS.map(name => readFileSync(join(SKILLS, name, "SKILL.md"), "utf8")).join("\n")
    for (const command of ["/identify-change-drivers", "/assess-ivp", "/sort-into-modules", "/review-ivp-to-convergence", "/apply-ivp"]) {
      expect(corpus).toContain(command)
    }
  })
})

describe("ivp agents", () => {
  const records = readAgentRecords(AGENTS)

  test("the expected agents exist and nothing else is shipped", () => {
    expect(records.map(r => r.id).sort()).toEqual([...EXPECTED_AGENTS].sort())
  })

  for (const record of readAgentRecords(AGENTS)) {
    test(`${record.id} pins an explicit provider/model`, () => {
      // A bare alias such as "sonnet" resolves through the host's alias map to
      // whatever that map points at. Pin the explicit reference so a remap in
      // the host config cannot change this agent's model silently.
      expect(record.model).toBeDefined()
      expect(record.model).toMatch(/^[\w.-]+\/[\w.-]+(#\S+)?$/)
    })

    test(`${record.id} runs as a subagent`, () => {
      expect(record.mode).toBe("subagent")
    })
  }

  test("the pack is consumed by reference, not registered in this repo", () => {
    // Consumers point their own opencode.json at ../llm-harness-plugins/ivp.
    // The harness itself does not load the pack; if it ever does, that is a
    // deliberate change and this test should be updated with it.
    const config = JSON.parse(readFileSync(join(REPO, "opencode.json"), "utf8"))
    expect(config.plugin).not.toContain("./ivp/opencode")
    for (const record of records) expect(config.agent?.[record.id]).toBeUndefined()
  })

  for (const name of READ_ONLY_AGENTS) {
    test(`${name} cannot edit`, () => {
      const record = records.find(r => r.id === name)
      expect(record?.permissionMap.edit).toBe("deny")
    })
  }

  for (const name of WRITING_AGENTS) {
    test(`${name} can edit`, () => {
      const record = records.find(r => r.id === name)
      expect(record?.permissionMap.edit).toBe("allow")
    })
  }

  test("gamma-modularizer can run the build it is required to verify", () => {
    const record = records.find(r => r.id === "gamma-modularizer")
    expect(record?.permissionMap.bash).toBe("allow")
  })

  test("the read-only auditors cannot run shell commands", () => {
    for (const name of READ_ONLY_AGENTS) {
      const record = records.find(r => r.id === name)
      expect(record?.permissionMap.bash).toBe("deny")
    }
  })
})

describe("ivp registration paths", () => {
  test("the v2 agent transform registers all six agents", () => {
    const created: Record<string, any> = {}
    const editor = {
      get: (id: string) => created[id],
      update: (id: string, fn: (agent: any) => void) => {
        const agent: any = { permissions: [] }
        fn(agent)
        created[id] = agent
      },
    }
    expect(registerAgentDirV2(editor, AGENTS)).toBe(EXPECTED_AGENTS.length)
    expect(Object.keys(created).sort()).toEqual([...EXPECTED_AGENTS].sort())
    for (const agent of Object.values(created)) {
      expect(agent.mode).toBe("subagent")
      expect(agent.system.length).toBeGreaterThan(0)
    }
  })

  test("the v1 config hook registers all six agents inline", () => {
    const config: any = {}
    expect(registerAgentDirV1(config, AGENTS)).toBe(EXPECTED_AGENTS.length)
    expect(Object.keys(config.agent).sort()).toEqual([...EXPECTED_AGENTS].sort())
  })

  test("the skill editor registers all five skills", () => {
    const skills: any[] = []
    expect(registerSkillDir({ add: (s: any) => skills.push(s) }, SKILLS)).toBe(EXPECTED_SKILLS.length)
    expect(skills.map(s => s.id).sort()).toEqual([...EXPECTED_SKILLS].sort())
  })
})

describe("ivp consumers", () => {
  // The pack is consumed by reference: sibling projects put
  // ../llm-harness-plugins/ivp/... in their own opencode.json. If the pack
  // moves or a file is renamed, those configs break. This test is the guard.
  test("every sibling project that references the pack resolves", () => {
    const siblings = resolve(REPO, "..")
    if (!existsSync(siblings)) return
    const broken: string[] = []
    let referenced = 0

    for (const entry of readdirSync(siblings)) {
      const configPath = join(siblings, entry, "opencode.json")
      if (!existsSync(configPath)) continue
      const raw = readFileSync(configPath, "utf8")
      const refs = raw.match(/[^"'\s{(:]*llm-harness-plugins\/ivp\/[^"'\s})]+/g) ?? []
      for (const ref of refs) {
        referenced++
        const target = resolve(join(siblings, entry), ref)
        if (!existsSync(target)) broken.push(`${entry}: ${ref}`)
      }
    }

    expect(broken).toEqual([])
    // Zero references is a pass: only a machine without sibling checkouts.
  })
})

describe("ivp reference", () => {
  const text = existsSync(KNOWLEDGE) ? readFileSync(KNOWLEDGE, "utf8") : ""

  test("the reference exists", () => {
    expect(existsSync(KNOWLEDGE)).toBe(true)
    expect(text.length).toBeGreaterThan(1000)
  })

  test("it names the canonical paper and its labels", () => {
    expect(text).toContain("ivp-graph-proof-2")
    expect(text).toContain("prc:ivp")
    expect(text).toContain("thm:uniqueness")
    expect(text).toContain("tab:ledger")
  })

  test("it carries the four directives and the hypothesis ledger", () => {
    for (const directive of ["IVP-1", "IVP-2", "IVP-3", "IVP-4"]) expect(text).toContain(directive)
    for (const hypothesis of ["S1", "S2", "T1", "T2", "T3", "T4", "M1", "M2", "M3"]) {
      expect(text).toContain(`| ${hypothesis} |`)
    }
    expect(text).toContain("Ω")
  })

  test("it keeps purity at module level", () => {
    expect(text.toLowerCase()).toContain("purity constrains modules")
  })

  test("it labels nesting as an extension", () => {
    expect(text.toLowerCase()).toContain("engineering extension")
  })
})

describe("ivp cross-plugin dependencies", () => {
  test("the auditors the review gate delegates to exist", () => {
    for (const name of ["logic-auditor", "proof-soundness-auditor"]) {
      expect(existsSync(join(REPO, "general-skills", "agents", `${name}.md`))).toBe(true)
    }
  })

  test("the review-convergence meta-skill exists", () => {
    expect(existsSync(join(REPO, "general-skills", "skills", "review-convergence", "SKILL.md"))).toBe(true)
  })
})
