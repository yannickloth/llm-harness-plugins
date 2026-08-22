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
  return mod.default({ directory: REPO_ROOT, worktree: REPO_ROOT, client: { app: { log: async () => {} } } }, { topicGate: false, ...opts })
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
    expect(hooks.config).toBeDefined()
    expect(hooks.tool["coord_log"]).toBeDefined()
    expect(hooks.tool["coord_claim"]).toBeDefined()
    expect(hooks.tool["coord_release"]).toBeDefined()
    expect(hooks.tool["coord_resource"]).toBeDefined()
    expect(hooks.tool["coord_handoff"]).toBeDefined()
    expect(hooks.tool["coord_status"]).toBeDefined()
    expect(hooks.tool["coord_heartbeat"]).toBeDefined()
    expect(hooks.tool["coord_who_does_what"]).toBeDefined()
    expect(hooks.tool["coord_await"]).toBeDefined()
    expect(hooks.tool["coord_ask"]).toBeDefined()
    expect(hooks.tool["coord_answer"]).toBeDefined()
  })

  test("config hook self-registers the coordinate skill", async () => {
    const input: any = {}
    await hooks.config(input)
    expect(input.skills?.coordinate).toBeDefined()
    expect(input.skills.coordinate.file).toContain("skills/coordinate/SKILL.md")
  })

  test("system.transform injects use-case guidance once", async () => {
    const out = { system: ["base"] }
    await hooks["experimental.chat.system.transform"]({}, out)
    expect(out.system[0]).toContain("Coordination ledger")
    expect(out.system[0]).toContain("coord_who_does_what()")
    expect(out.system[0]).toContain("'coordinate' skill") // points agents to full guide    expect(out.system.length).toBe(2)
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
    await h.tool["coord_claim"].execute({ task: "old task", leaseMinutes: -1 }, ctx)
    // live claim
    await h.tool["coord_claim"].execute({ task: "current task", leaseMinutes: 30 }, ctx)

    const wdw = await h.tool["coord_who_does_what"].execute({}, ctx)
    expect(wdw).toContain("current task")
    expect(wdw).not.toContain("old task")
  })

  test("who_does_what excludes released claims", async () => {
    const dir = `/tmp/agentfeed-rel-${Date.now()}`
    const h = await loadHooks({ ledgerDir: dir, javaBinary: "true" })
    const ctx = { agent: "writer", sessionID: "sr", messageID: "m", directory: dir, worktree: dir, abort: new AbortController().signal, metadata: () => {}, ask: () => ({}) }

    await h.tool["coord_claim"].execute({ task: "task to release", leaseMinutes: 30 }, ctx)
    await h.tool["coord_release"].execute({ task: "task to release" }, ctx)

    const wdw = await h.tool["coord_who_does_what"].execute({}, ctx)
    expect(wdw).not.toContain("task to release")
  })

  test("coord_release requires task or id", async () => {
    const dir = `/tmp/agentfeed-relreq-${Date.now()}`
    const h = await loadHooks({ ledgerDir: dir, javaBinary: "true" })
    const ctx = { agent: "writer", sessionID: "srr", messageID: "m", directory: dir, worktree: dir, abort: new AbortController().signal, metadata: () => {}, ask: () => ({}) }
    const res = await h.tool["coord_release"].execute({}, ctx)
    expect(res).toContain("requires either")
  })

  test("coord_await resolves entry id to a position", async () => {
    const dir = `/tmp/agentfeed-await-${Date.now()}`
    const h = await loadHooks({ ledgerDir: dir, javaBinary: "true" })
    const ctx = { agent: "writer", sessionID: "sa", messageID: "m", directory: dir, worktree: dir, abort: new AbortController().signal, metadata: () => {}, ask: () => ({}) }

    const claimed = await h.tool["coord_claim"].execute({ task: "t1", leaseMinutes: 30 }, ctx)
    const id = claimed.match(/as ([^ ]+)/)?.[1]
    expect(id).toBeTruthy()

    // awaiting at id with no newer entries should time out quickly
    const res = await h.tool["coord_await"].execute({ position: id!, timeoutSeconds: 0.1 }, ctx)
    expect(res).toContain("Timed out")
  })

  test("coord_await resolves full ts|host|seq position", async () => {
    const dir = `/tmp/agentfeed-awaitfull-${Date.now()}`
    const h = await loadHooks({ ledgerDir: dir, javaBinary: "true" })
    const ctx = { agent: "writer", sessionID: "sb", messageID: "m", directory: dir, worktree: dir, abort: new AbortController().signal, metadata: () => {}, ask: () => ({}) }

    const claimed = await h.tool["coord_claim"].execute({ task: "t2", leaseMinutes: 30 }, ctx)
    const id = claimed.match(/as ([^ ]+)/)?.[1]
    // read the entry's real ts from the ledger
    const { promises: fsp } = await import("fs")
    const raw = await fsp.readFile(`${dir}/ledger.jsonl`, "utf8")
    const entry = JSON.parse(raw.trim().split("\n").pop()!)

    // position = its own watermark -> no newer entries -> timeout
    const res = await h.tool["coord_await"].execute(
      { position: `${entry.ts}|${entry.host}|${entry.seq}`, timeoutSeconds: 0.1 },
      ctx,
    )
    expect(res).toContain("Timed out")
    expect(id).toBeTruthy()
  })

  test("coord_await rejects unknown position", async () => {
    const dir = `/tmp/agentfeed-awaitbad-${Date.now()}`
    const h = await loadHooks({ ledgerDir: dir, javaBinary: "true" })
    const ctx = { agent: "writer", sessionID: "sc", messageID: "m", directory: dir, worktree: dir, abort: new AbortController().signal, metadata: () => {}, ask: () => ({}) }
    const res = await h.tool["coord_await"].execute({ position: "nohost:99", timeoutSeconds: 0.1 }, ctx)
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

  test("coord_ask and coord_answer publish to ledger", async () => {
    const dir = `/tmp/agentfeed-qa-${Date.now()}`
    const h = await loadHooks({ ledgerDir: dir, javaBinary: "true" })
    const ctx = { agent: "writer", sessionID: "sq", messageID: "m", directory: dir, worktree: dir, abort: new AbortController().signal, metadata: () => {}, ask: () => ({}) }
    const askRes = await h.tool["coord_ask"].execute({ question: "who owns ch.4?" }, ctx)
    const id = askRes.match(/\(([^)]+)\)$/)?.[1]
    expect(id).toBeTruthy()
    const ansRes = await h.tool["coord_answer"].execute({ answer: "I do", questionId: id }, ctx)
    expect(ansRes).toContain("Answered")
    const { promises: fsp } = await import("fs")
    const raw = await fsp.readFile(`${dir}/ledger.jsonl`, "utf8")
    expect(raw).toContain('"type":"ask"')
    expect(raw).toContain('"type":"answer"')
  })

  test("coord_resource acquire marks a held resource; release frees it", async () => {
    const dir = `/tmp/agentfeed-res-${Date.now()}`
    const h = await loadHooks({ ledgerDir: dir, javaBinary: "true" })
    const ctx = { agent: "writer", sessionID: "sr1", messageID: "m", directory: dir, worktree: dir, abort: new AbortController().signal, metadata: () => {}, ask: () => ({}) }

    const acq = await h.tool["coord_resource"].execute({ resource: "git", name: "main", action: "acquire" }, ctx)
    expect(acq).toContain("Acquired")
    let wdw = await h.tool["coord_who_does_what"].execute({}, ctx)
    expect(wdw).toContain("Held resources")
    expect(wdw).toContain('holds git "main"')

    const rel = await h.tool["coord_resource"].execute({ resource: "git", name: "main", action: "release" }, ctx)
    expect(rel).toContain("Released")
    wdw = await h.tool["coord_who_does_what"].execute({}, ctx)
    expect(wdw).not.toContain('holds git "main"')
  })

  test("coord_resource file acquire/release tracked", async () => {
    const dir = `/tmp/agentfeed-resfile-${Date.now()}`
    const h = await loadHooks({ ledgerDir: dir, javaBinary: "true" })
    const ctx = { agent: "editor", sessionID: "sr2", messageID: "m", directory: dir, worktree: dir, abort: new AbortController().signal, metadata: () => {}, ask: () => ({}) }
    await h.tool["coord_resource"].execute({ resource: "file", name: "src/a.ts", action: "acquire" }, ctx)
    const wdw = await h.tool["coord_who_does_what"].execute({}, ctx)
    expect(wdw).toContain('holds file "src/a.ts"')
    await h.tool["coord_resource"].execute({ resource: "file", name: "src/a.ts", action: "release" }, ctx)
    expect(await h.tool["coord_who_does_what"].execute({}, ctx)).not.toContain('holds file "src/a.ts"')
  })

  test("resource re-acquire after release is held again (ordering-correct)", async () => {
    const dir = `/tmp/agentfeed-resreaq-${Date.now()}`
    const h = await loadHooks({ ledgerDir: dir, javaBinary: "true" })
    const ctx = { agent: "editor", sessionID: "srr", messageID: "m", directory: dir, worktree: dir, abort: new AbortController().signal, metadata: () => {}, ask: () => ({}) }
    await h.tool["coord_resource"].execute({ resource: "git", name: "feat", action: "acquire" }, ctx)
    await h.tool["coord_resource"].execute({ resource: "git", name: "feat", action: "release" }, ctx)
    await h.tool["coord_resource"].execute({ resource: "git", name: "feat", action: "acquire" }, ctx)
    const wdw = await h.tool["coord_who_does_what"].execute({}, ctx)
    expect(wdw).toContain('holds git "feat"')
  })

  test("one agent releasing a resource does not drop another holder's hold", async () => {
    const dir = `/tmp/agentfeed-rescompete-${Date.now()}`
    const h = await loadHooks({ ledgerDir: dir, javaBinary: "true" })
    const mkCtx = (agent: string, sessionID: string) => ({ agent, sessionID, messageID: "m", directory: dir, worktree: dir, abort: new AbortController().signal, metadata: () => {}, ask: () => ({}) })
    const writer = mkCtx("writer", "s-wr")
    const auditor = mkCtx("auditor", "s-ar")

    await h.tool["coord_resource"].execute({ resource: "git", name: "main", action: "acquire" }, writer)
    await h.tool["coord_resource"].execute({ resource: "git", name: "main", action: "acquire" }, auditor)
    const before = await h.tool["coord_who_does_what"].execute({}, auditor)
    expect(before).toContain('writer holds git "main"')
    expect(before).toContain('auditor holds git "main"')

    await h.tool["coord_resource"].execute({ resource: "git", name: "main", action: "release" }, writer)
    const wdw = await h.tool["coord_who_does_what"].execute({}, auditor)
    expect(wdw).toContain('holds git "main"')
    expect(wdw).not.toContain('writer holds git "main"')
  })

  test("coord_handoff closes own claim and opens one for target", async () => {
    const dir = `/tmp/agentfeed-handoff-${Date.now()}`
    const h = await loadHooks({ ledgerDir: dir, javaBinary: "true" })
    const ctx = { agent: "writer", sessionID: "sh", messageID: "m", directory: dir, worktree: dir, abort: new AbortController().signal, metadata: () => {}, ask: () => ({}) }
    await h.tool["coord_claim"].execute({ task: "ch.3", leaseMinutes: 30 }, ctx)
    const res = await h.tool["coord_handoff"].execute({ task: "ch.3", to: "auditor" }, ctx)
    expect(res).toContain("Handed")
    const wdw = await h.tool["coord_who_does_what"].execute({}, ctx)
    expect(wdw).toContain('auditor claims "ch.3"')
    expect(wdw).not.toContain('writer claims "ch.3"')
  })

  test("coord_status records a task state", async () => {
    const dir = `/tmp/agentfeed-status-${Date.now()}`
    const h = await loadHooks({ ledgerDir: dir, javaBinary: "true" })
    const ctx = { agent: "writer", sessionID: "sst", messageID: "m", directory: dir, worktree: dir, abort: new AbortController().signal, metadata: () => {}, ask: () => ({}) }
    const res = await h.tool["coord_status"].execute({ task: "ch.3", state: "done" }, ctx)
    expect(res).toContain("done")
    const { promises: fsp } = await import("fs")
    const raw = await fsp.readFile(`${dir}/ledger.jsonl`, "utf8")
    expect(raw).toContain('"type":"status"')
    expect(raw).toContain('"status":"done"')
  })

  test("coord_heartbeat renews a claim lease (dedupes to latest)", async () => {
    const dir = `/tmp/agentfeed-hb-${Date.now()}`
    const h = await loadHooks({ ledgerDir: dir, javaBinary: "true" })
    const ctx = { agent: "writer", sessionID: "shb", messageID: "m", directory: dir, worktree: dir, abort: new AbortController().signal, metadata: () => {}, ask: () => ({}) }
    await h.tool["coord_claim"].execute({ task: "long task", leaseMinutes: 30 }, ctx)
    const res = await h.tool["coord_heartbeat"].execute({ task: "long task" }, ctx)
    expect(res).toContain("Renewed")
    const wdw = await h.tool["coord_who_does_what"].execute({}, ctx)
    // only one line for the task despite two claims
    expect(wdw.match(/claims "long task"/g)).toHaveLength(1)
  })

  test("coord_heartbeat requires task or resource", async () => {
    const dir = `/tmp/agentfeed-hbreq-${Date.now()}`
    const h = await loadHooks({ ledgerDir: dir, javaBinary: "true" })
    const ctx = { agent: "writer", sessionID: "shbr", messageID: "m", directory: dir, worktree: dir, abort: new AbortController().signal, metadata: () => {}, ask: () => ({}) }
    expect(await h.tool["coord_heartbeat"].execute({}, ctx)).toContain("requires")
  })

  test("competing claims by different agents both surface; release frees only owner", async () => {
    const dir = `/tmp/agentfeed-compete-${Date.now()}`
    const h = await loadHooks({ ledgerDir: dir, javaBinary: "true" })
    const mkCtx = (agent: string, sessionID: string) => ({ agent, sessionID, messageID: "m", directory: dir, worktree: dir, abort: new AbortController().signal, metadata: () => {}, ask: () => ({}) })
    const writer = mkCtx("writer", "s-w")
    const auditor = mkCtx("auditor", "s-a")

    await h.tool["coord_claim"].execute({ task: "ch.3", leaseMinutes: 30 }, writer)
    await h.tool["coord_claim"].execute({ task: "ch.3", leaseMinutes: 30 }, auditor)

    const both = await h.tool["coord_who_does_what"].execute({}, writer)
    expect(both).toContain('writer claims "ch.3"')
    expect(both).toContain('auditor claims "ch.3"')

    // writer releasing their own claim must not free auditor's competing claim
    await h.tool["coord_release"].execute({ task: "ch.3" }, writer)
    const after = await h.tool["coord_who_does_what"].execute({}, auditor)
    expect(after).toContain('auditor claims "ch.3"')
    expect(after).not.toContain('writer claims "ch.3"')
  })
})

describe("agentfeed topic gate", () => {
  async function loadGated(opts: Record<string, unknown> = {}) {
    const mod = await import(`./index.ts?${Date.now()}`)
    return mod.default(
      { directory: REPO_ROOT, worktree: REPO_ROOT, client: { app: { log: async () => {} } } },
      { ledgerDir: `/tmp/agentfeed-gate-${Date.now()}`, javaBinary: "true", topicGate: true, ...opts },
    )
  }

  test("does not inject a coordination digest into a personal session", async () => {
    const h = await loadGated()
    const ctx = { agent: "writer", sessionID: "sg-p", messageID: "m", directory: REPO_ROOT, worktree: REPO_ROOT, abort: new AbortController().signal, metadata: () => {}, ask: async () => {} }
    await h.tool["coord_log"].execute({ type: "msg", text: "working on ch.4" }, ctx)
    // personal first message
    const first = { parts: [{ type: "text", text: "ma femme dort mieux sur un matelas gonflable" }] }
    await h["chat.message"]({ sessionID: "sg-p", agent: "writer" }, first)
    const out = { parts: [{ type: "text", text: "encore une question personnelle" }] }
    await h["chat.message"]({ sessionID: "sg-p", agent: "writer" }, out)
    expect(out.parts[0].text.startsWith("##")).toBe(false)
    expect(out.parts[0].text).toBe("encore une question personnelle")
  })

  test("injects a lean coordination pointer into a project session", async () => {
    const h = await loadGated()
    const ctx = { agent: "writer", sessionID: "sg-pr", messageID: "m", directory: REPO_ROOT, worktree: REPO_ROOT, abort: new AbortController().signal, metadata: () => {}, ask: async () => {} }
    await h.tool["coord_log"].execute({ type: "msg", text: "working on the build for ch.4" }, ctx)
    const first = { parts: [{ type: "text", text: "refactor the file src/main.java to fix the bug" }] }
    await h["chat.message"]({ sessionID: "sg-pr", agent: "writer" }, first)
    const out = { parts: [{ type: "text", text: "now check who owns the next task" }] }
    await h["chat.message"]({ sessionID: "sg-pr", agent: "writer" }, out)
    expect(out.parts[0].text.startsWith("## Coordination digest")).toBe(true)
    // lean: points at the details file instead of inlining every entry
    expect(out.parts[0].text).toMatch(/details in `[^`]+digest\.md`/)
    expect(out.parts[0].text).not.toContain("working on the build")
    expect(out.parts[0].text).toContain("now check who owns the next task")
  })

  test("system note is not injected into a personal session", async () => {
    const h = await loadGated()
    await h["chat.message"]({ sessionID: "sg-sys", agent: "a" }, { parts: [{ type: "text", text: "ma femme et son matelas" }] })
    const out = { system: ["base"] }
    await h["experimental.chat.system.transform"]({ sessionID: "sg-sys" }, out)
    expect(out.system.some(s => s.includes("Coordination ledger"))).toBe(false)
    expect(out.system).toEqual(["base"])
  })
})
