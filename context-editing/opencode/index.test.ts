import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import type { Plugin } from "@opencode-ai/plugin"
import { renderMirror, sessionPaths, type OcMessage } from "./helpers"

type Handlers = Awaited<ReturnType<(typeof import("./index.ts"))["default"]>>

let root: string

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "context-editing-"))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

async function load(opts: Record<string, unknown> = {}): Promise<Handlers> {
  const mod = await import("./index.ts")
  const client = { app: { log: async () => {} } }
  return (mod.default as any).server({ client, directory: root, worktree: root }, opts)
}

function stripBlock(md: string, id: string): string {
  const re = new RegExp(`<!-- ce:b [^\\n]* id=${id} [^\\n]* -->\\n[\\s\\S]*?<!-- /ce:b -->\\n?`, "g")
  return md.replace(re, "")
}

function msgs(sid: string, text: string): OcMessage[] {
  return [
    { info: { id: "m1", role: "user", sessionID: sid }, parts: [{ id: "p1", type: "text", text }] },
    {
      info: { id: "m2", role: "assistant", sessionID: sid },
      parts: [
        { id: "p2", type: "text", text: "assistant reply" },
        { id: "p3", type: "tool", callID: "c1" },
      ],
    },
    { info: { id: "m3", role: "tool", sessionID: sid }, parts: [{ id: "p4", type: "tool_result", toolUseID: "c1" }] },
  ]
}

describe("context-editing plugin", () => {
  test("notices-only (default) injects a budget notice and writes no mirror", async () => {
    const hooks = await load({ mode: "notices-only", windowTokens: 100, budget: "50%" })
    await hooks["chat.message"]({ sessionID: "s1" }, { parts: [{ type: "text", text: "please fix the bug" }] })

    const out = { messages: msgs("s1", "x".repeat(240)) } as { messages: OcMessage[] }
    await hooks["experimental.chat.messages.transform"]({}, out)

    expect(String(out.messages[0].parts[0].id)).toStartWith("ce-notice-")
    expect(out.messages[0].parts[0].text).toContain("context-editing")
    expect(existsSync(sessionPaths(root, "s1").mirror)).toBe(false)
  })

  test("system.transform injects the edit protocol only in edit mode", async () => {
    const edit = await load({ mode: "edit" })
    const s1 = { system: ["base"] }
    await edit["experimental.chat.system.transform"]({ sessionID: "s1" }, s1)
    expect(s1.system[0]).toContain("Context editing")
    expect(s1.system[1]).toBe("base")

    const notices = await load({ mode: "notices-only" })
    const s2 = { system: ["base"] }
    await notices["experimental.chat.system.transform"]({ sessionID: "s2" }, s2)
    expect(s2.system).toEqual(["base"])
  })

  test("edit mode writes a mirror, then applies the model's edit and restores pinned parts", async () => {
    const hooks = await load({ mode: "edit", budget: "window" })
    await hooks["chat.message"]({ sessionID: "s2" }, { parts: [{ type: "text", text: "please fix the bug" }] })

    const first = { messages: msgs("s2", "ORIGINAL_TEXT") } as { messages: OcMessage[] }
    await hooks["experimental.chat.messages.transform"]({}, first)
    const mirrorPath = sessionPaths(root, "s2").mirror
    expect(existsSync(mirrorPath)).toBe(true)
    expect(readFileSync(mirrorPath, "utf-8")).toContain("ORIGINAL_TEXT")
    // No edits yet → the array is left untouched (cache-friendly).
    expect(first.messages[0].parts[0].text).toBe("ORIGINAL_TEXT")

    writeFileSync(mirrorPath, readFileSync(mirrorPath, "utf-8").replace("ORIGINAL_TEXT", "EDITED_TEXT"))

    const second = { messages: msgs("s2", "ORIGINAL_TEXT") } as { messages: OcMessage[] }
    await hooks["experimental.chat.messages.transform"]({}, second)
    expect(second.messages[0].parts[0].text).toBe("EDITED_TEXT")
    expect(second.messages[1].parts.find((p) => p.id === "p3")!.callID).toBe("c1")
    expect(existsSync(path.join(sessionPaths(root, "s2").edits, "r0001.json"))).toBe(true)
  })

  test("an emptied protected region is healed, not left broken", async () => {
    const hooks = await load({ mode: "edit", budget: "window" })
    await hooks["chat.message"]({ sessionID: "s3" }, { parts: [{ type: "text", text: "please fix the bug" }] })

    const first = { messages: msgs("s3", "ORIGINAL") } as { messages: OcMessage[] }
    await hooks["experimental.chat.messages.transform"]({}, first)

    const mirrorPath = sessionPaths(root, "s3").mirror
    const badMirror = renderMirror(msgs("s3", "ORIGINAL").map((m) => ({
      id: String(m.info.id), role: String(m.info.role), sessionID: m.info.sessionID as string, parts: m.parts,
    })), "")
    writeFileSync(mirrorPath, badMirror)

    const second = { messages: msgs("s3", "ORIGINAL") } as { messages: OcMessage[] }
    await hooks["experimental.chat.messages.transform"]({}, second)
    // The message array is unaffected, and the mirror is repaired on disk.
    expect(second.messages[0].parts[0].text).toBe("ORIGINAL")
    expect(readFileSync(mirrorPath, "utf-8")).toContain("please fix the bug")
  })

  test("status reports mode, budget and paths", async () => {
    const hooks = await load({ mode: "edit", budget: "64k", windowTokens: 128_000 })
    const status = JSON.parse(String(await hooks.tool["context-editing-status"].execute({}, { sessionID: "s4" })))
    expect(status.mode).toBe("edit")
    expect(status.budget).toBe("64k")
    expect(status.absoluteBudget).toBe(65_536)
    expect(status.paths.mirror).toContain(".context-editing/s4/context.md")
  })

  test("recall fails closed, then allows with matches when all conditions hold", async () => {
    const hooks = await load({ mode: "notices-only" })
    await hooks["chat.message"]({ sessionID: "s5" }, { parts: [{ type: "text", text: "the deploy key rotates on fridays" }] })
    await hooks["experimental.chat.messages.transform"]({}, { messages: msgs("s5", "the deploy key rotates on fridays") } as any)

    const denied = JSON.parse(String(await hooks.tool["context-editing-recall"].execute(
      { query: "deploy key", missingInMirror: false, inTrace: true, reDerivable: false, canProceed: false, justification: "x" },
      { sessionID: "s5" },
    )))
    expect(denied.allow).toBe(false)

    const allowed = JSON.parse(String(await hooks.tool["context-editing-recall"].execute(
      { query: "deploy key", missingInMirror: true, inTrace: true, reDerivable: false, canProceed: false, justification: "blocking" },
      { sessionID: "s5" },
    )))
    expect(allowed.allow).toBe(true)
    expect(allowed.matches.length).toBeGreaterThan(0)
  })

  test("reset discards the mirror; compacted rebuilds; deleted clears state", async () => {
    const hooks = await load({ mode: "edit", budget: "window" })
    await hooks["chat.message"]({ sessionID: "s6" }, { parts: [{ type: "text", text: "goal text" }] })
    await hooks["experimental.chat.messages.transform"]({}, { messages: msgs("s6", "ORIGINAL") } as any)
    expect(existsSync(sessionPaths(root, "s6").mirror)).toBe(true)

    await hooks.tool["context-editing-reset"].execute({}, { sessionID: "s6" })
    expect(existsSync(sessionPaths(root, "s6").mirror)).toBe(false)

    await hooks["session.compacted"]({ properties: { session: { id: "s6" } } })
    const before = JSON.parse(String(await hooks.tool["context-editing-status"].execute({}, { sessionID: "s6" })))
    expect(before.revision).toBeGreaterThan(0)

    await hooks["session.deleted"]({ properties: { session: { id: "s6" } } })
    const after = JSON.parse(String(await hooks.tool["context-editing-status"].execute({}, { sessionID: "s6" })))
    expect(after.revision).toBe(0)
  })

  test("reconciliation: a new turn survives; a deleted block stays deleted", async () => {
    const hooks = await load({ mode: "edit", budget: "window" })
    await hooks["chat.message"]({ sessionID: "t1" }, { parts: [{ type: "text", text: "goal one" }] })

    // Turn 1: only the user message exists.
    await hooks["experimental.chat.messages.transform"]({}, { messages: [msgs("t1", "USER_ONE")[0]] } as any)

    // Turn 2: the assistant text and tool pair appear for the first time.
    const t2 = { messages: msgs("t1", "USER_ONE") } as { messages: OcMessage[] }
    await hooks["experimental.chat.messages.transform"]({}, t2)
    expect(t2.messages.some((m) => m.parts.some((p) => p.id === "p2"))).toBe(true)

    // The model deletes the assistant block from the mirror.
    const mirrorPath = sessionPaths(root, "t1").mirror
    writeFileSync(mirrorPath, stripBlock(readFileSync(mirrorPath, "utf-8"), "p2"))

    // It stays dropped on this and the next request.
    const t3 = { messages: msgs("t1", "USER_ONE") } as { messages: OcMessage[] }
    await hooks["experimental.chat.messages.transform"]({}, t3)
    expect(t3.messages.some((m) => m.parts.some((p) => p.id === "p2"))).toBe(false)

    const t4 = { messages: msgs("t1", "USER_ONE") } as { messages: OcMessage[] }
    await hooks["experimental.chat.messages.transform"]({}, t4)
    expect(t4.messages.some((m) => m.parts.some((p) => p.id === "p2"))).toBe(false)

    // A persistent drop must not mint a new revision on every request.
    const revs = readdirSync(sessionPaths(root, "t1").edits).sort()
    expect(revs).toEqual(["r0001.json", "r0002.json"])
  })

  test("invalid mode env falls back to notices-only", async () => {
    const prev = process.env.LLMHP_CONTEXT_EDITING_MODE
    process.env.LLMHP_CONTEXT_EDITING_MODE = "banana"
    try {
      const hooks = await load()
      const status = JSON.parse(String(await hooks.tool["context-editing-status"].execute({}, { sessionID: "t2" })))
      expect(status.mode).toBe("notices-only")
    } finally {
      if (prev === undefined) delete process.env.LLMHP_CONTEXT_EDITING_MODE
      else process.env.LLMHP_CONTEXT_EDITING_MODE = prev
    }
  })

  test("config hook applies context_editing settings", async () => {
    const hooks = await load()
    await hooks.config({ context_editing: { mode: "edit", budget: "64k", windowTokens: 128_000 } } as any)
    const status = JSON.parse(String(await hooks.tool["context-editing-status"].execute({}, { sessionID: "cfg1" })))
    expect(status.mode).toBe("edit")
    expect(status.budget).toBe("64k")
    expect(status.windowTokens).toBe(128_000)
  })

  test("the trace records user and assistant text", async () => {
    const hooks = await load({ mode: "notices-only" })
    await hooks["experimental.chat.messages.transform"]({}, { messages: msgs("t3", "USER_ONE") } as any)
    const trace = readFileSync(sessionPaths(root, "t3").trace, "utf-8")
    expect(trace).toContain("USER_ONE")
    expect(trace).toContain("assistant reply")
  })

  test("compaction coordination disables autocontinue only in edit mode", async () => {
    const edit = await load({ mode: "edit" })
    const auto = { enabled: true }
    await edit["experimental.compaction.autocontinue"]({ sessionID: "s7" }, auto)
    expect(auto.enabled).toBe(false)

    const notices = await load({ mode: "notices-only" })
    const auto2 = { enabled: true }
    await notices["experimental.compaction.autocontinue"]({ sessionID: "s8" }, auto2)
    expect(auto2.enabled).toBe(true)
  })
})
