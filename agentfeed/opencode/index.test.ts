import { describe, test, expect, beforeEach, afterAll } from "bun:test"
import path from "path"
import { promises as fsp } from "fs"

const REPO_ROOT = path.join(import.meta.dir, "..", "..")

// Clean up the unique /tmp/agentfeed-* dirs the isolation tests create.
afterAll(async () => {
  try {
    const entries = await fsp.readdir("/tmp")
    await Promise.all(
      entries
        .filter((e) => e.startsWith("agentfeed-"))
        .map((e) => fsp.rm(path.join("/tmp", e), { recursive: true, force: true })),
    )
  } catch {
    // best-effort cleanup; never fail the suite
  }
})

async function loadHooks(opts: Record<string, unknown> = {}) {
  const mod = await import(`./index.ts?${Date.now()}`)
  return mod.default({ directory: REPO_ROOT, worktree: REPO_ROOT, client: { app: { log: async () => {} } } }, opts)
}

describe("agentfeed plugin", () => {
  let hooks: any

  beforeEach(async () => {
    hooks = await loadHooks({ ledgerDir: "/tmp/agentfeed-test", javaBinary: "true" })
  })

  test("registers hooks and coord tools", () => {
    expect(hooks["chat.message"]).toBeDefined()
    expect(hooks["experimental.chat.system.transform"]).toBeDefined()
    expect(hooks["tool.execute.after"]).toBeDefined()
    expect(hooks.tool["coord.log"]).toBeDefined()
    expect(hooks.tool["coord.claim"]).toBeDefined()
    expect(hooks.tool["coord.release"]).toBeDefined()
    expect(hooks.tool["coord.who_does_what"]).toBeDefined()
    expect(hooks.tool["coord.await"]).toBeDefined()
    expect(hooks.tool["coord.ask"]).toBeDefined()
    expect(hooks.tool["coord.answer"]).toBeDefined()
  })

  test("system.transform injects coordination note once", async () => {
    const out = { system: ["base"] }
    await hooks["experimental.chat.system.transform"]({}, out)
    expect(out.system[0]).toContain("Coordination ledger")
    expect(out.system.length).toBe(2)
    await hooks["experimental.chat.system.transform"]({}, out)
    expect(out.system.length).toBe(2)
  })

  test("first user message is skipped (session-title hygiene)", async () => {
    const out = { parts: [{ type: "text", text: "do something" }] }
    await hooks["chat.message"]({ sessionID: "s1", agent: "a" }, out)
    expect(out.parts[0].text).toBe("do something")
  })

  test("empty text part left untouched", async () => {
    // first call registers session
    await hooks["chat.message"]({ sessionID: "s2", agent: "a" }, { parts: [{ type: "text", text: "hi" }] })
    const out = { parts: [{ type: "text", text: "   " }] }
    await hooks["chat.message"]({ sessionID: "s2", agent: "a" }, out)
    expect(out.parts[0].text).toBe("   ")
  })

  test("who_does_what excludes expired leases", async () => {
    const dir = `/tmp/agentfeed-wdw-${Date.now()}`
    const h = await loadHooks({ ledgerDir: dir, javaBinary: "true" })
    const ctx = { agent: "writer", sessionID: "sw", messageID: "m", directory: dir, worktree: dir, abort: new AbortController().signal, metadata: () => {}, ask: () => ({}) }

    // expired claim (lease in the past)
    await h.tool["coord.claim"].execute({ task: "old task", leaseMinutes: -1 }, ctx)
    // live claim
    await h.tool["coord.claim"].execute({ task: "current task", leaseMinutes: 30 }, ctx)

    const wdw = await h.tool["coord.who_does_what"].execute({}, ctx)
    expect(wdw).toContain("current task")
    expect(wdw).not.toContain("old task")
  })

  test("who_does_what excludes released claims", async () => {
    const dir = `/tmp/agentfeed-rel-${Date.now()}`
    const h = await loadHooks({ ledgerDir: dir, javaBinary: "true" })
    const ctx = { agent: "writer", sessionID: "sr", messageID: "m", directory: dir, worktree: dir, abort: new AbortController().signal, metadata: () => {}, ask: () => ({}) }

    await h.tool["coord.claim"].execute({ task: "task to release", leaseMinutes: 30 }, ctx)
    await h.tool["coord.release"].execute({ task: "task to release" }, ctx)

    const wdw = await h.tool["coord.who_does_what"].execute({}, ctx)
    expect(wdw).not.toContain("task to release")
  })

  test("coord.release requires task or id", async () => {
    const dir = `/tmp/agentfeed-relreq-${Date.now()}`
    const h = await loadHooks({ ledgerDir: dir, javaBinary: "true" })
    const ctx = { agent: "writer", sessionID: "srr", messageID: "m", directory: dir, worktree: dir, abort: new AbortController().signal, metadata: () => {}, ask: () => ({}) }
    const res = await h.tool["coord.release"].execute({}, ctx)
    expect(res).toContain("requires either")
  })

  test("coord.await resolves entry id to a position", async () => {
    const dir = `/tmp/agentfeed-await-${Date.now()}`
    const h = await loadHooks({ ledgerDir: dir, javaBinary: "true" })
    const ctx = { agent: "writer", sessionID: "sa", messageID: "m", directory: dir, worktree: dir, abort: new AbortController().signal, metadata: () => {}, ask: () => ({}) }

    const claimed = await h.tool["coord.claim"].execute({ task: "t1", leaseMinutes: 30 }, ctx)
    const id = claimed.match(/as ([^ ]+)/)?.[1]
    expect(id).toBeTruthy()

    // awaiting at id with no newer entries should time out quickly
    const res = await h.tool["coord.await"].execute({ position: id!, timeoutSeconds: 0.1 }, ctx)
    expect(res).toContain("Timed out")
  })

  test("coord.await resolves full ts|host|seq position", async () => {
    const dir = `/tmp/agentfeed-awaitfull-${Date.now()}`
    const h = await loadHooks({ ledgerDir: dir, javaBinary: "true" })
    const ctx = { agent: "writer", sessionID: "sb", messageID: "m", directory: dir, worktree: dir, abort: new AbortController().signal, metadata: () => {}, ask: () => ({}) }

    const claimed = await h.tool["coord.claim"].execute({ task: "t2", leaseMinutes: 30 }, ctx)
    const id = claimed.match(/as ([^ ]+)/)?.[1]
    // read the entry's real ts from the ledger
    const { promises: fsp } = await import("fs")
    const raw = await fsp.readFile(`${dir}/ledger.jsonl`, "utf8")
    const entry = JSON.parse(raw.trim().split("\n").pop()!)

    // position = its own watermark -> no newer entries -> timeout
    const res = await h.tool["coord.await"].execute(
      { position: `${entry.ts}|${entry.host}|${entry.seq}`, timeoutSeconds: 0.1 },
      ctx,
    )
    expect(res).toContain("Timed out")
    expect(id).toBeTruthy()
  })

  test("coord.await rejects unknown position", async () => {
    const dir = `/tmp/agentfeed-awaitbad-${Date.now()}`
    const h = await loadHooks({ ledgerDir: dir, javaBinary: "true" })
    const ctx = { agent: "writer", sessionID: "sc", messageID: "m", directory: dir, worktree: dir, abort: new AbortController().signal, metadata: () => {}, ask: () => ({}) }
    const res = await h.tool["coord.await"].execute({ position: "nohost:99", timeoutSeconds: 0.1 }, ctx)
    expect(res).toContain("Unknown position")
  })

  test("tool.execute.after auto-records git activity", async () => {
    const dir = `/tmp/agentfeed-git-${Date.now()}`
    const h = await loadHooks({ ledgerDir: dir, javaBinary: "true" })
    // register session->agent
    await h["chat.message"]({ sessionID: "sg", agent: "writer" }, { parts: [{ type: "text", text: "hi" }] })
    await h["tool.execute.after"]({ tool: "bash", sessionID: "sg", args: { command: "git commit -m 'wip'" } })
    const { promises: fsp } = await import("fs")
    const raw = await fsp.readFile(`${dir}/ledger.jsonl`, "utf8")
    expect(raw).toContain('"type":"resource"')
    expect(raw).toContain('"resource":"git"')
    expect(raw).toContain('"agent":"writer"')
  })

  test("tool.execute.after auto-records file edit, coalesced", async () => {
    const dir = `/tmp/agentfeed-file-${Date.now()}`
    const h = await loadHooks({ ledgerDir: dir, javaBinary: "true" })
    await h["chat.message"]({ sessionID: "sf", agent: "editor" }, { parts: [{ type: "text", text: "hi" }] })
    await h["tool.execute.after"]({ tool: "edit", sessionID: "sf", args: { filePath: "src/a.ts" } })
    await h["tool.execute.after"]({ tool: "edit", sessionID: "sf", args: { filePath: "src/a.ts" } }) // same file, coalesced
    await h["tool.execute.after"]({ tool: "edit", sessionID: "sf", args: { filePath: "src/b.ts" } }) // different file
    const { promises: fsp } = await import("fs")
    const raw = await fsp.readFile(`${dir}/ledger.jsonl`, "utf8")
    const lines = raw.trim().split("\n")
    // src/a.ts coalesced to 1, src/b.ts separate -> 2 resource entries
    const resources = lines.filter((l) => l.includes('"type":"resource"'))
    expect(resources).toHaveLength(2)
  })

  test("distinct git operations are NOT coalesced", async () => {
    const dir = `/tmp/agentfeed-gitdistinct-${Date.now()}`
    const h = await loadHooks({ ledgerDir: dir, javaBinary: "true" })
    await h["chat.message"]({ sessionID: "sx", agent: "writer" }, { parts: [{ type: "text", text: "hi" }] })
    await h["tool.execute.after"]({ tool: "bash", sessionID: "sx", args: { command: "git commit -m x" } })
    await h["tool.execute.after"]({ tool: "bash", sessionID: "sx", args: { command: "git push origin main" } })
    const { promises: fsp } = await import("fs")
    const raw = await fsp.readFile(`${dir}/ledger.jsonl`, "utf8")
    const resources = raw.trim().split("\n").filter((l) => l.includes('"type":"resource"'))
    expect(resources).toHaveLength(2)
  })

  test("tool.execute.after ignores non-resource tools", async () => {
    const dir = `/tmp/agentfeed-nonres-${Date.now()}`
    const h = await loadHooks({ ledgerDir: dir, javaBinary: "true" })
    await h["chat.message"]({ sessionID: "sn", agent: "a" }, { parts: [{ type: "text", text: "hi" }] })
    await h["tool.execute.after"]({ tool: "read", sessionID: "sn", args: { filePath: "src/a.ts" } })
    const { promises: fsp } = await import("fs")
    let raw = ""
    try {
      raw = await fsp.readFile(`${dir}/ledger.jsonl`, "utf8")
    } catch {
      // file absent = nothing written
    }
    expect(raw.trim()).toBe("")
  })

  test("autoGit=false suppresses git auto-write", async () => {
    const dir = `/tmp/agentfeed-nogit-${Date.now()}`
    const h = await loadHooks({ ledgerDir: dir, javaBinary: "true", autoGit: false })
    await h["chat.message"]({ sessionID: "sz", agent: "a" }, { parts: [{ type: "text", text: "hi" }] })
    await h["tool.execute.after"]({ tool: "bash", sessionID: "sz", args: { command: "git merge main" } })
    const { promises: fsp } = await import("fs")
    let raw = ""
    try {
      raw = await fsp.readFile(`${dir}/ledger.jsonl`, "utf8")
    } catch {
      // file absent = nothing written
    }
    expect(raw.trim()).toBe("")
  })

  test("coord.ask and coord.answer publish to ledger", async () => {
    const dir = `/tmp/agentfeed-qa-${Date.now()}`
    const h = await loadHooks({ ledgerDir: dir, javaBinary: "true" })
    const ctx = { agent: "writer", sessionID: "sq", messageID: "m", directory: dir, worktree: dir, abort: new AbortController().signal, metadata: () => {}, ask: () => ({}) }
    const askRes = await h.tool["coord.ask"].execute({ question: "who owns ch.4?" }, ctx)
    const id = askRes.match(/\(([^)]+)\)$/)?.[1]
    expect(id).toBeTruthy()
    const ansRes = await h.tool["coord.answer"].execute({ answer: "I do", questionId: id }, ctx)
    expect(ansRes).toContain("Answered")
    const { promises: fsp } = await import("fs")
    const raw = await fsp.readFile(`${dir}/ledger.jsonl`, "utf8")
    expect(raw).toContain('"type":"ask"')
    expect(raw).toContain('"type":"answer"')
  })
})
