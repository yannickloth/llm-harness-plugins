import { describe, test, expect } from "bun:test"

const REPO_ROOT = new URL("../..", import.meta.url).pathname

async function loadHooks(opts: Record<string, unknown> = {}) {
  const mod = await import(`./index.ts?${Date.now()}`)
  return mod.default({ client: {}, directory: REPO_ROOT, worktree: REPO_ROOT }, opts)
}

const hetzner = { model: { providerID: "hetzner" } }

describe("system-message-merge plugin", () => {
  test("factory registers the experimental.chat.system.transform hook", async () => {
    const hooks = await loadHooks()
    expect(hooks["experimental.chat.system.transform"]).toBeDefined()
  })

  test("Hetzner, N>1 system messages -> coalesces to one, order preserved, joined with \\n\\n", async () => {
    const hooks = await loadHooks()
    const output = { system: ["first", "second", "third"] }
    await hooks["experimental.chat.system.transform"](hetzner, output)
    expect(output.system).toEqual(["first\n\nsecond\n\nthird"])
  })

  test("Hetzner, single system message -> identity (same string, length 1)", async () => {
    const hooks = await loadHooks()
    const output = { system: ["only"] }
    await hooks["experimental.chat.system.transform"](hetzner, output)
    expect(output.system).toEqual(["only"])
  })

  test("Hetzner, empty array -> stays []", async () => {
    const hooks = await loadHooks()
    const output = { system: [] }
    await hooks["experimental.chat.system.transform"](hetzner, output)
    expect(output.system).toEqual([])
  })

  test("Hetzner, array of only empty strings -> []", async () => {
    const hooks = await loadHooks()
    const output = { system: ["", "", ""] }
    await hooks["experimental.chat.system.transform"](hetzner, output)
    expect(output.system).toEqual([])
  })

  test("Hetzner, idempotency -> calling twice stays length 1, no doubled content", async () => {
    const hooks = await loadHooks()
    const output = { system: ["a", "b"] }
    await hooks["experimental.chat.system.transform"](hetzner, output)
    const first = output.system[0]
    await hooks["experimental.chat.system.transform"](hetzner, output)
    expect(output.system.length).toBe(1)
    expect(output.system[0]).toBe(first)
  })

  test("non-Hetzner provider (deepseek), N>1 -> array UNCHANGED", async () => {
    const hooks = await loadHooks()
    const output = { system: ["a", "b"] }
    await hooks["experimental.chat.system.transform"]({ model: { providerID: "deepseek" } }, output)
    expect(output.system).toEqual(["a", "b"])
  })

  test("enabled:false -> array UNCHANGED even for hetzner", async () => {
    const hooks = await loadHooks({ enabled: false })
    const output = { system: ["a", "b"] }
    await hooks["experimental.chat.system.transform"](hetzner, output)
    expect(output.system).toEqual(["a", "b"])
  })

  test("custom providers:['foo'] matches 'foo', does NOT match 'hetzner'", async () => {
    const hooks = await loadHooks({ providers: ["foo"] })
    const foo = { system: ["a", "b"] }
    await hooks["experimental.chat.system.transform"]({ model: { providerID: "foo" } }, foo)
    expect(foo.system).toEqual(["a\n\nb"])

    const hz = { system: ["a", "b"] }
    await hooks["experimental.chat.system.transform"](hetzner, hz)
    expect(hz.system).toEqual(["a", "b"])
  })

  test("case-insensitivity: 'Hetzner' matches", async () => {
    const hooks = await loadHooks()
    const output = { system: ["a", "b"] }
    await hooks["experimental.chat.system.transform"]({ model: { providerID: "Hetzner" } }, output)
    expect(output.system).toEqual(["a\n\nb"])
  })

  test("empty strings are dropped before joining, order preserved", async () => {
    const hooks = await loadHooks()
    const output = { system: ["first", "", "second"] }
    await hooks["experimental.chat.system.transform"](hetzner, output)
    expect(output.system).toEqual(["first\n\nsecond"])
  })

  test("whitespace-only strings are dropped before joining", async () => {
    const hooks = await loadHooks()
    const output = { system: ["first", "   ", "second"] }
    await hooks["experimental.chat.system.transform"](hetzner, output)
    expect(output.system).toEqual(["first\n\nsecond"])
  })

  test("array of only whitespace-only strings -> []", async () => {
    const hooks = await loadHooks()
    const output = { system: ["  ", "\n", ""] }
    await hooks["experimental.chat.system.transform"](hetzner, output)
    expect(output.system).toEqual([])
  })
})
