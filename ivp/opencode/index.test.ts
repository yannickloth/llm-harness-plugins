import { describe, test, expect } from "bun:test"
import { existsSync, readFileSync, readdirSync, statSync } from "fs"
import { join, resolve } from "path"
import plugin from "./index"
import { readAgentRecords } from "../../shared/agents"
import { parseFrontmatter } from "../../shared/v2-skills"

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

    test(`${record.id} is registered in the repo opencode.json`, () => {
      const config = JSON.parse(readFileSync(join(REPO, "opencode.json"), "utf8"))
      const spec = config.agent?.[record.id]
      expect(spec).toBeDefined()
      expect(typeof spec.file).toBe("string")
      const target = resolve(REPO, spec.file)
      expect(existsSync(target)).toBe(true)
      expect(target).toBe(join(AGENTS, `${record.id}.md`))
    })

    test(`${record.id} runs as a subagent`, () => {
      expect(record.mode).toBe("subagent")
    })
  }

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
