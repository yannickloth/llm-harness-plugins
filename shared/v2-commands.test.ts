import { describe, expect, test } from "bun:test"
import { join } from "path"
import { dirname } from "path"
import { fileURLToPath } from "url"
import { mkdtempSync, writeFileSync, rmSync } from "fs"
import { tmpdir } from "os"
import {
  parseCommand,
  parseModelRef,
  readCommandRecords,
  registerCommandDirV2,
} from "./v2-commands"

const root = dirname(dirname(fileURLToPath(import.meta.url)))

describe("parseCommand", () => {
  test("reads frontmatter and body", () => {
    const raw = [
      "---",
      "description: Assess the code",
      "agent: some-auditor",
      "model: deepseek/deepseek-v4-pro#high",
      "subtask: true",
      "---",
      "Body line one.",
      "",
      "Body line two.",
    ].join("\n")
    const rec = parseCommand(raw, "fallback")
    expect(rec.name).toBe("fallback")
    expect(rec.description).toBe("Assess the code")
    expect(rec.agent).toBe("some-auditor")
    expect(rec.model).toBe("deepseek/deepseek-v4-pro#high")
    expect(rec.subtask).toBe(true)
    expect(rec.template).toBe("Body line one.\n\nBody line two.")
  })

  test("a `name:` key overrides the filename-derived name", () => {
    const rec = parseCommand("---\nname: renamed\n---\nx", "file-name")
    expect(rec.name).toBe("renamed")
  })

  test("no frontmatter: whole file is the template", () => {
    const rec = parseCommand("Just a template.\n", "plain")
    expect(rec.name).toBe("plain")
    expect(rec.description).toBeUndefined()
    expect(rec.template).toBe("Just a template.")
  })

  test("drops a bare model alias (v2 needs provider/model)", () => {
    expect(parseCommand("---\nmodel: sonnet\n---\nx", "a").model).toBeUndefined()
  })

  test("stripQuotes handles quoted values", () => {
    const rec = parseCommand('---\ndescription: "quoted text"\n---\nx', "a")
    expect(rec.description).toBe("quoted text")
  })

  test("subtask only when literally true", () => {
    expect(parseCommand("---\nsubtask: yes\n---\nx", "a").subtask).toBeUndefined()
    expect(parseCommand("---\nsubtask: true\n---\nx", "a").subtask).toBe(true)
  })
})

describe("parseModelRef", () => {
  test("splits provider, id, variant", () => {
    expect(parseModelRef("a/b#c")).toEqual({ providerID: "a", id: "b", variant: "c" })
  })
  test("no variant", () => {
    expect(parseModelRef("anthropic/claude-sonnet-5-5")).toEqual({
      providerID: "anthropic",
      id: "claude-sonnet-5-5",
    })
  })
  test("rejects a bare alias", () => {
    expect(parseModelRef("sonnet")).toBeUndefined()
  })
  test("rejects an empty id", () => {
    expect(parseModelRef("provider/")).toBeUndefined()
  })
})

describe("readCommandRecords", () => {
  test("missing directory yields nothing", () => {
    expect(readCommandRecords(join(root, "does-not-exist"))).toEqual([])
  })

  test("reads .md files sorted, ignoring others", () => {
    const dir = mkdtempSync(join(tmpdir(), "ivp-cmd-"))
    try {
      writeFileSync(join(dir, "b.md"), "B body")
      writeFileSync(join(dir, "a.md"), "A body")
      writeFileSync(join(dir, "notes.txt"), "ignored")
      const recs = readCommandRecords(dir)
      expect(recs.map(r => r.name)).toEqual(["a", "b"])
      expect(recs.map(r => r.template)).toEqual(["A body", "B body"])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("registerCommandDirV2", () => {
  test("adds each command with its template and optional fields", () => {
    const dir = mkdtempSync(join(tmpdir(), "ivp-cmd-"))
    try {
      writeFileSync(
        join(dir, "assess.md"),
        "---\nagent: auditor\nmodel: p/m#v\nsubtask: true\ndescription: d\n---\nTemplate",
      )
      const added: any[] = []
      const editor = { add: (def: any) => added.push(def) }
      expect(registerCommandDirV2(editor, dir)).toBe(1)
      expect(added).toHaveLength(1)
      const rec = added[0]
      expect(rec.name).toBe("assess")
      expect(rec.template).toBe("Template")
      expect(rec.agent).toBe("auditor")
      expect(rec.description).toBe("d")
      expect(rec.subtask).toBe(true)
      expect(rec.model).toEqual({ providerID: "p", id: "m", variant: "v" })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("omits absent optional fields instead of writing nulls", () => {
    const dir = mkdtempSync(join(tmpdir(), "ivp-cmd-"))
    try {
      writeFileSync(join(dir, "plain.md"), "Body")
      const added: any[] = []
      registerCommandDirV2({ add: (def: any) => added.push(def) }, dir)
      expect(added[0]).toEqual({ name: "plain", template: "Body" })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("an editor without `add` registers nothing (does not throw)", () => {
    const dir = mkdtempSync(join(tmpdir(), "ivp-cmd-"))
    try {
      writeFileSync(join(dir, "x.md"), "Body")
      expect(registerCommandDirV2({ update: () => {} }, dir)).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("one rejected entry does not abort the others", () => {
    const dir = mkdtempSync(join(tmpdir(), "ivp-cmd-"))
    try {
      writeFileSync(join(dir, "a.md"), "A")
      writeFileSync(join(dir, "b.md"), "B")
      const added: string[] = []
      const editor = {
        add: (def: any) => {
          if (def.name === "a") throw new Error("duplicate")
          added.push(def.name)
        },
      }
      expect(registerCommandDirV2(editor, dir)).toBe(1)
      expect(added).toEqual(["b"])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("ivp commands", () => {
  const commandsDir = join(root, "ivp", "commands")

  test("ships the five documented commands", () => {
    const recs = readCommandRecords(commandsDir)
    expect(recs.map(r => r.name).sort()).toEqual([
      "apply-ivp",
      "assess-ivp",
      "identify-change-drivers",
      "review-ivp-to-convergence",
      "sort-into-modules",
    ])
  })

  test("every command has a description and a non-empty template", () => {
    for (const rec of readCommandRecords(commandsDir)) {
      expect({ name: rec.name, hasDescription: Boolean(rec.description) }).toEqual({
        name: rec.name,
        hasDescription: true,
      })
      expect(rec.template.length).toBeGreaterThan(0)
    }
  })

  test("pins an agent only where the invocation differs from the session", () => {
    const byName = Object.fromEntries(readCommandRecords(commandsDir).map(r => [r.name, r]))
    // Report-only assessment must not run under a writable session agent.
    expect(byName["assess-ivp"].agent).toBe("current-modularization-auditor")
    expect(byName["assess-ivp"].subtask).toBe(true)
    expect(byName["identify-change-drivers"].agent).toBe("driver-identifier")
    expect(byName["sort-into-modules"].agent).toBe("gamma-modularizer")
  })

  test("does not pin a bare model alias", () => {
    for (const rec of readCommandRecords(commandsDir)) {
      if (rec.model) expect(rec.model).toMatch(/^[^\s/#]+\/.+/)
    }
  })
})
