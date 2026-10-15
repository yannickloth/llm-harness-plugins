import { describe, test, expect, beforeEach, afterAll } from "bun:test"
import { readFileSync } from "fs"
import { join } from "path"
import codifyFirst from "./index"
import { CODIFY_FIRST_MARKER, CODIFY_FIRST_DIRECTIVE } from "./directive"
import { clearSessionTopic } from "../../shared/session-topic"

const client = { app: { log: async () => {} } } as any

const usedSessions: string[] = []

function makePlugin(options?: Parameters<typeof codifyFirst>[1]) {
  return (codifyFirst as any).server(client as any, options)
}

let counter = 0
function freshSession(prefix: string): string {
  const id = `${prefix}-${++counter}`
  usedSessions.push(id)
  return id
}

async function systemOf(hooks: any, sessionID: string | undefined, parts: string[]) {
  const output = { system: [...parts] }
  await hooks["experimental.chat.system.transform"]({ sessionID }, output)
  return output.system
}

async function userSays(hooks: any, sessionID: string, text: string) {
  const output = { parts: [{ type: "text", text }] }
  await hooks["chat.message"]({ sessionID }, output)
  return output
}

describe("codify-first", () => {
  beforeEach(() => {
    for (const id of usedSessions) clearSessionTopic(id)
    usedSessions.length = 0
  })

  test("directive carries marker, gate criteria, and skill pointer", () => {
    expect(CODIFY_FIRST_DIRECTIVE).toContain(CODIFY_FIRST_MARKER)
    expect(CODIFY_FIRST_DIRECTIVE).toContain("recur")
    expect(CODIFY_FIRST_DIRECTIVE).toContain("stable")
    expect(CODIFY_FIRST_DIRECTIVE).toContain("bounded")
    expect(CODIFY_FIRST_DIRECTIVE).toContain("partly codified")
    expect(CODIFY_FIRST_DIRECTIVE).toContain("propose")
    expect(CODIFY_FIRST_DIRECTIVE).toContain("improvement")
    expect(CODIFY_FIRST_DIRECTIVE).toContain("deterministic gates")
    expect(CODIFY_FIRST_DIRECTIVE).toContain("`codify-first` skill")
  })

  test("transform appends the directive exactly once", async () => {
    const hooks = await makePlugin()
    const sid = freshSession("dedup")
    const once = await systemOf(hooks, sid, ["base prompt"])
    expect(once).toHaveLength(2)
    expect(once[1]).toContain(CODIFY_FIRST_MARKER)
    const twice = await systemOf(hooks, sid, once)
    expect(twice).toHaveLength(2)
    expect(twice.filter(s => s.includes(CODIFY_FIRST_MARKER))).toHaveLength(1)
  })

  test("topic gate: personal session suppresses, project session injects, unknown injects", async () => {
    const hooks = await makePlugin()
    const personal = freshSession("personal")
    await userSays(hooks, personal, "je dors mal, mon matelas fait mal au dos")
    expect(await systemOf(hooks, personal, ["base"])).toEqual(["base"])

    const project = freshSession("project")
    await userSays(hooks, project, "please fix the failing test in src/index.ts")
    const injected = await systemOf(hooks, project, ["base"])
    expect(injected).toHaveLength(2)
    expect(injected[1]).toContain(CODIFY_FIRST_MARKER)

    const unknown = freshSession("unknown")
    expect(await systemOf(hooks, unknown, ["base"])).toHaveLength(2)
  })

  test("topicGate: false disables classification and always injects", async () => {
    const hooks = await makePlugin({ topicGate: false })
    const personal = freshSession("off")
    await userSays(hooks, personal, "je dors mal")
    expect(await systemOf(hooks, personal, ["base"])).toHaveLength(2)
  })

  test("enabled: false suppresses injection but keeps skill registration", async () => {
    const hooks = await makePlugin({ enabled: false })
    const sid = freshSession("disabled")
    expect(await systemOf(hooks, sid, ["base"])).toEqual(["base"])
    const config: any = {}
    await hooks.config(config)
    expect(config.skills.paths.some((p: string) => p.includes("codify-first"))).toBe(true)
  })

  test("config hook registers the skills directory exactly once", async () => {
    const hooks = await makePlugin()
    const config: any = { skills: { paths: ["/elsewhere/skills"] } }
    await hooks.config(config)
    expect(config.skills.paths).toHaveLength(2)
    expect(config.skills.paths[1]).toContain(join("codify-first", "skills"))
    await hooks.config(config)
    expect(config.skills.paths).toHaveLength(2)
  })

  test("codify_first config key overrides constructor options", async () => {
    const hooks = await makePlugin({ enabled: false })
    const config: any = { codify_first: { enabled: true, topicGate: false } }
    await hooks.config(config)
    const sid = freshSession("cfg")
    expect(await systemOf(hooks, sid, ["base"])).toHaveLength(2)
  })

  test("companion skill exists with valid frontmatter", () => {
    const skill = readFileSync(join(import.meta.dir, "..", "skills", "codify-first", "SKILL.md"), "utf8")
    expect(skill).toMatch(/^---\nname: codify-first\n/)
    expect(skill).toContain("description:")
    expect(skill).toContain("## Gate")
    expect(skill).toContain("Execute through the artifact")
    expect(skill).toContain("Harvest & propose improvements")
    expect(skill).toContain("Deterministic gates")
  })
})

afterAll(() => {
  for (const id of usedSessions) clearSessionTopic(id)
})
