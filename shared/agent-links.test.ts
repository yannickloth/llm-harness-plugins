import {
  agentBody,
  agentConfigEntries,
  agentFiles,
  agentTransformRecords,
  ensureAgentLinks,
  globalAgentDir,
  parseAgentMeta,
} from "./agent-links"
import { mkdtempSync, mkdirSync, lstatSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { afterEach, describe, expect, test } from "bun:test"

const SAMPLE = `---
name: example-auditor
description: Audits example things for example defects.
model: deepseek/deepseek-v4-pro
mode: subagent
---

# Example Auditor

Read-only. Reports findings.
`

describe("parseAgentMeta", () => {
  test("reads name/description/model/mode", () => {
    expect(parseAgentMeta(SAMPLE)).toEqual({
      name: "example-auditor",
      description: "Audits example things for example defects.",
      model: "deepseek/deepseek-v4-pro",
      mode: "subagent",
    })
  })

  test("strips surrounding quotes and is empty without frontmatter", () => {
    expect(parseAgentMeta(`---\ndescription: "quoted value"\n---\nbody`).description).toBe("quoted value")
    expect(parseAgentMeta("no frontmatter here")).toEqual({})
  })

  test("a description containing a colon is kept whole", () => {
    const raw = `---\ndescription: Uses {file:} refs: beware\n---\nx`
    expect(parseAgentMeta(raw).description).toBe("Uses {file:} refs: beware")
  })
})

describe("agentBody", () => {
  test("removes the frontmatter block", () => {
    expect(agentBody(SAMPLE).trimStart().startsWith("# Example Auditor")).toBe(true)
  })
})

describe("agent-links filesystem behaviour", () => {
  let root: string
  let src: string
  let dest: string

  const setup = () => {
    root = mkdtempSync(join(tmpdir(), "agent-links-"))
    src = join(root, "agents")
    dest = join(root, "dest")
    mkdirSync(src, { recursive: true })
    writeFileSync(join(src, "one.md"), SAMPLE)
    writeFileSync(join(src, "two.md"), SAMPLE.replace("example-auditor", "two-auditor"))
  }

  afterEach(() => rmSync(root, { recursive: true, force: true }))

  test("agentFiles lists *.md sorted, ignores other files", () => {
    setup()
    writeFileSync(join(src, "notes.txt"), "x")
    expect(agentFiles(src).map(f => f.name)).toEqual(["one", "two"])
    expect(agentFiles(join(root, "missing"))).toEqual([])
  })

  test("creates links, then keeps them on a second run (idempotent)", () => {
    setup()
    const first = ensureAgentLinks(src, dest)
    expect(first.created.sort()).toEqual(["one", "two"])
    expect(lstatSync(join(dest, "one.md")).isSymbolicLink()).toBe(true)

    const second = ensureAgentLinks(src, dest)
    expect(second.created).toEqual([])
    expect(second.kept.sort()).toEqual(["one", "two"])
  })

  test("dryRun reports without writing", () => {
    setup()
    const res = ensureAgentLinks(src, dest, { dryRun: true })
    expect(res.created.sort()).toEqual(["one", "two"])
    expect(res.dryRun).toBe(true)
    expect(() => lstatSync(dest)).toThrow()
  })

  test("never overwrites a real file at the destination", () => {
    setup()
    mkdirSync(dest, { recursive: true })
    writeFileSync(join(dest, "one.md"), "REAL")
    const res = ensureAgentLinks(src, dest)
    expect(res.skipped).toContain("one")
    expect(lstatSync(join(dest, "one.md")).isSymbolicLink()).toBe(false)
    // the real file's content is untouched
    expect(readFileSync(join(dest, "one.md"), "utf8")).toBe("REAL")
  })

  test("prunes a stale link back into this directory, keeps foreign links", () => {
    setup()
    mkdirSync(dest, { recursive: true })
    // stale link into src, whose target no longer exists
    symlinkSync(join(src, "gone.md"), join(dest, "gone.md"))
    // foreign link, must be untouched
    const other = join(root, "other")
    mkdirSync(other, { recursive: true })
    writeFileSync(join(other, "keep.md"), "x")
    symlinkSync(join(other, "keep.md"), join(dest, "keep.md"))

    const res = ensureAgentLinks(src, dest)
    expect(res.removed).toContain("gone.md")
    expect(lstatSync(join(dest, "keep.md")).isSymbolicLink()).toBe(true)
    expect(() => lstatSync(join(dest, "gone.md"))).toThrow()
  })
})

describe("v1 / v2 record builders", () => {
  let dir: string
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  test("agentConfigEntries supplies description, mode and a {file:} prompt", () => {
    dir = mkdtempSync(join(tmpdir(), "agent-records-"))
    writeFileSync(join(dir, "one.md"), SAMPLE)
    const entries = agentConfigEntries(dir)
    expect(entries.one.description).toBe("Audits example things for example defects.")
    expect(entries.one.mode).toBe("subagent")
    expect(String(entries.one.prompt).startsWith("{file:")).toBe(true)
    expect(entries.one.model).toBe("deepseek/deepseek-v4-pro")
  })

  test("agentTransformRecords carry the body without frontmatter", () => {
    dir = mkdtempSync(join(tmpdir(), "agent-records-"))
    writeFileSync(join(dir, "one.md"), SAMPLE)
    const [rec] = agentTransformRecords(dir)
    expect(rec.name).toBe("one")
    expect(rec.description).toBe("Audits example things for example defects.")
    expect(rec.system.includes("frontmatter")).toBe(false)
  })

  test("globalAgentDir honours XDG_CONFIG_HOME", () => {
    const prev = process.env.XDG_CONFIG_HOME
    process.env.XDG_CONFIG_HOME = "/tmp/cfg"
    expect(globalAgentDir()).toBe("/tmp/cfg/opencode/agent")
    if (prev === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = prev
  })
})
