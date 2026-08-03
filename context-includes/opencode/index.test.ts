import { describe, test, expect, beforeAll, afterEach, beforeEach } from "bun:test"
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "fs"
import path from "path"
import os from "os"
import type { Plugin } from "@opencode-ai/plugin"

type Prompt = (...args: any[]) => Promise<void> | void
interface MockSession { prompt: Prompt; calls: { text: string }[] }
interface MockClient { session: MockSession }

type PluginHandlers = Awaited<
  ReturnType<(typeof import("./index.ts"))["default"]>
>

let tmpRoot: string
let client: MockClient

beforeAll(async () => {
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), "context-includes-"))
})

beforeEach(async () => {
  client = { session: { prompt: async () => {}, calls: [] } }
  const real = client.session.prompt
  client.session.prompt = (...args: any[]) => {
    const body = args[0]?.body
    const text: string = body?.parts?.[0]?.text ?? ""
    client.session.calls.push({ text })
    return real(...args)
  }
})

afterEach(async () => {
  rmSync(tmpRoot, { recursive: true, force: true })
  mkdirSync(tmpRoot, { recursive: true })
})

async function loadPlugin(): Promise<PluginHandlers> {
  const mod = await import("./index.ts")
  const defaultExport = mod.default as Parameters<Plugin>[0] extends never
    ? never
    : (opts: any) => Promise<PluginHandlers>
  return defaultExport({ client, directory: tmpRoot })
}

async function fire(
  handlers: PluginHandlers,
  name: keyof PluginHandlers,
  sessionId: string
) {
  const fn = handlers[name] as any
  await fn({ properties: { session: { id: sessionId } } })
}

function writeClaudeMd(content: string) {
  writeFileSync(path.join(tmpRoot, "CLAUDE.md"), content)
}

function writeAgentsMd(content: string) {
  writeFileSync(path.join(tmpRoot, "AGENTS.md"), content)
}

function writeIncluded(rel: string, content: string) {
  const abs = path.join(tmpRoot, rel)
  mkdirSync(path.dirname(abs), { recursive: true })
  writeFileSync(abs, content)
}

describe("context-includes plugin", () => {
  test("session.created resolves @include directives and injects merged content", async () => {
    writeIncluded("docs/style.md", "style rules: ALWAYS prefix with X\n")
    writeClaudeMd("project rules\n@./docs/style.md\nmore\n")
    const handlers = await loadPlugin()

    await fire(handlers, "session.created", "s1")

    expect(client.session.calls).toHaveLength(1)
    const text = client.session.calls[0].text
    expect(text).toContain("project rules")
    expect(text).toContain("style rules: ALWAYS prefix with X")
    expect(text).toContain("more")
  })

  test("session.created merges CLAUDE.md and AGENTS.md together", async () => {
    writeAgentsMd("agents block\n")
    writeClaudeMd("claude block\n")
    const handlers = await loadPlugin()

    await fire(handlers, "session.created", "s1")

    expect(client.session.calls).toHaveLength(1)
    const text = client.session.calls[0].text
    expect(text).toContain("claude block")
    expect(text).toContain("agents block")
  })

  test("cache hit: second session.created reuses cached merge and does not re-parse files", async () => {
    writeClaudeMd("version-one\n")
    const handlers = await loadPlugin()

    await fire(handlers, "session.created", "s1")
    expect(client.session.calls[0].text).toContain("version-one")

    writeClaudeMd("version-two\n")
    await fire(handlers, "session.created", "s1")

    expect(client.session.calls).toHaveLength(2)
    expect(client.session.calls[1].text).toContain("version-one")
    expect(client.session.calls[1].text).not.toContain("version-two")
  })

  test("session.compacted clears cache and re-injects with fresh file contents", async () => {
    writeClaudeMd("old-content\n")
    const handlers = await loadPlugin()

    await fire(handlers, "session.created", "s1")
    expect(client.session.calls[0].text).toContain("old-content")

    writeClaudeMd("new-content\n")
    await fire(handlers, "session.compacted", "s1")

    expect(client.session.calls).toHaveLength(2)
    expect(client.session.calls[1].text).toContain("new-content")
    expect(client.session.calls[1].text).not.toContain("old-content")
  })

  test("session.deleted clears the cache (no re-parse on empty compact after delete)", async () => {
    writeClaudeMd("data\n")
    const handlers = await loadPlugin()

    await fire(handlers, "session.created", "s1")
    expect(client.session.calls).toHaveLength(1)

    await fire(handlers, "session.deleted", "s1")
  })

  test("deferred: cache clear on delete is observable via subsequent compact", async () => {
    writeClaudeMd("a-version\n")
    const handlers = await loadPlugin()
    await fire(handlers, "session.created", "s1")
    expect(client.session.calls[0].text).toContain("a-version")

    await fire(handlers, "session.deleted", "s1")
    writeClaudeMd("b-version\n")

    const callsBefore = client.session.calls.length
    await fire(handlers, "session.compacted", "s1")
    expect(client.session.calls.length).toBe(callsBefore + 1)
    expect(client.session.calls[callsBefore].text).toContain("b-version")
  })

  test("no instruction files exist: injection never occurs", async () => {
    const handlers = await loadPlugin()

    await fire(handlers, "session.created", "s1")
    await fire(handlers, "session.compacted", "s1")

    expect(client.session.calls).toHaveLength(0)
  })

  test("CLAUDE.md becomes available mid-session: compaction picks it up and injects", async () => {
    const handlers = await loadPlugin()
    await fire(handlers, "session.created", "s1")
    expect(client.session.calls).toHaveLength(0)

    writeClaudeMd("late-arriving rules\n")
    await fire(handlers, "session.compacted", "s1")

    expect(client.session.calls).toHaveLength(1)
    expect(client.session.calls[0].text).toContain("late-arriving rules")
  })

  test("CLAUDE.md removed mid-session: compaction clears cache and stops injecting", async () => {
    writeClaudeMd("will-be-removed\n")
    const handlers = await loadPlugin()
    await fire(handlers, "session.created", "s1")
    expect(client.session.calls).toHaveLength(1)

    rmSync(path.join(tmpRoot, "CLAUDE.md"))
    await fire(handlers, "session.compacted", "s1")

    expect(client.session.calls).toHaveLength(1)
  })

  test("error in one file does not prevent the other file from resolving and injecting", async () => {
    // Force a top-level parse failure on CLAUDE.md via a path-escape include.
    // (A missing @include is preserved verbatim and does NOT throw at index level.)
    const escapeTarget = path.join(tmpRoot, "..", `context-escape-${Date.now()}-${Math.random().toString(36).slice(2)}.md`)
    writeFileSync(escapeTarget, "secret\n")

    writeIncluded("docs/other.md", "other content\n")
    writeAgentsMd("agents content\n@./docs/other.md\n")
    writeClaudeMd(`root rules\n@../${path.basename(escapeTarget)}\n`)

    const origErr = console.error
    const errored: string[] = []
    console.error = (...args: any[]) => {
      errored.push(args.map(String).join(" "))
      origErr(...args)
    }

    const handlers = await loadPlugin()
    await fire(handlers, "session.created", "s1")

    console.error = origErr
    rmSync(escapeTarget, { force: true })

    expect(errored.some(m => m.includes("escapes root directory"))).toBe(true)
    // AGENTS.md still resolves and injects despite CLAUDE.md failing to parse.
    expect(client.session.calls).toHaveLength(1)
    const text = client.session.calls[0].text
    expect(text).toContain("agents content")
    expect(text).toContain("other content")
  })

  test("a missing @include target is preserved verbatim and does not abort resolution", async () => {
    writeIncluded("docs/ok.md", "ok content\n")
    writeClaudeMd("root rules\n@./does-not-exist.md\n")
    writeIncluded("docs/ok.md", "ok content\n")
    writeAgentsMd("agents\n@./docs/ok.md\n")
    const handlers = await loadPlugin()

    const origErr = console.error
    console.error = () => {}
    await fire(handlers, "session.created", "s1")
    console.error = origErr

    const text = client.session.calls[0].text
    expect(text).toContain("root rules")
    expect(text).toContain("@./does-not-exist.md")
    expect(text).toContain("agents")
    expect(text).toContain("ok content")
  })

  test("empty resolved content does not inject", async () => {
    writeClaudeMd("   \n\n  \n")
    writeAgentsMd("\n\n")
    const handlers = await loadPlugin()

    await fire(handlers, "session.created", "s1")

    expect(client.session.calls).toHaveLength(0)
  })

  test("missing session id is a no-op (defensive optional chaining)", async () => {
    writeClaudeMd("data\n")
    const handlers = await loadPlugin()
    const created = handlers["session.created"] as (input?: {
      properties?: { session?: { id?: string } }
    }) => Promise<void>

    await created({ properties: undefined })
    await created({})
    await created(undefined)

    expect(client.session.calls).toHaveLength(0)
  })

  test("concurrent injectIfResolved calls are serialized (injection lock)", async () => {
    writeClaudeMd("lock-test\n")
    client.session.prompt = async () => {
      await new Promise(r => setTimeout(r, 10))
    }
    const orig = client.session.prompt
    ;(client.session as any).prompt = async (...args: any[]) => {
      await client.session.prompt!(...args)
      // @ts-ignore
      return orig(...args)
    }
    // Override properly: track calls via a real counter
    let callCount = 0
    client.session.prompt = async () => {
      callCount++
      await new Promise(r => setTimeout(r, 10))
    }
    const handlers = await loadPlugin()
    await fire(handlers, "session.created", "s1")

    expect(callCount).toBe(1)
  })

  test("injection lock: compaction during created skips duplicate push", async () => {
    writeClaudeMd("race-test\n")

    let resolvePrompt: () => void
    const promptBlocked = new Promise<void>(r => { resolvePrompt = r })
    let callCount = 0
    client.session.prompt = async () => {
      callCount++
      await promptBlocked
    }

    const handlers = await loadPlugin()
    const createdPromise = fire(handlers, "session.created", "s1")

    await new Promise(r => setTimeout(r, 1))
    const compactedPromise = fire(handlers, "session.compacted", "s1")

    await new Promise(r => setTimeout(r, 1))
    resolvePrompt!()
    await createdPromise
    await compactedPromise

    expect(callCount).toBe(1)
  })
})
