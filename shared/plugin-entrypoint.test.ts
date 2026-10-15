import { describe, test, expect } from "bun:test"
import { readdirSync, existsSync } from "fs"
import { dirname, join } from "path"
import { fileURLToPath } from "url"

/**
 * Dual-version entrypoint contract.
 *
 * OpenCode V2 requires `export default { id, setup(ctx) }` and *rejects* a
 * callable default (the loader checks `typeof default === "object"`). V1 calls
 * the default as a factory, so the same object carries `server(input, options)`
 * — V2 calls `setup`, V1 calls `server`. This test pins that shape for every
 * plugin: a plugin that regresses to a bare function default (or drops `server`)
 * would still import cleanly, so nothing else would catch it here.
 */
const root = dirname(dirname(fileURLToPath(import.meta.url)))

function pluginDirs(): string[] {
  return readdirSync(root)
    .filter((entry) => existsSync(join(root, entry, "opencode", "index.ts")))
    .sort()
}

describe("plugin dual entrypoint contract", () => {
  const dirs = pluginDirs()

  test("repo has plugins to check", () => {
    expect(dirs.length).toBeGreaterThan(0)
  })

  for (const dir of dirs) {
    test(`${dir} exports { id, setup, server } and writes its load canary`, async () => {
      const mod = await import(join(root, dir, "opencode", "index.ts"))
      const plugin: any = mod.default

      // V2 loader: must be a non-callable object with a non-empty string id and
      // a setup function.
      expect(typeof plugin).toBe("object")
      expect(typeof plugin.id).toBe("string")
      expect(plugin.id).toBe(dir)
      expect(typeof plugin.setup).toBe("function")

      // V1 loader: `server` is the callable factory.
      expect(typeof plugin.server).toBe("function")

      // Both entrypoints must be able to write the load marker under the plugin
      // id (canary_preflight.sh relies on this to fail closed on a silent drop).
      const src = await Bun.file(join(root, dir, "opencode", "index.ts")).text()
      const calls = src.match(new RegExp(`writeLoadCanary\\(["'\`]${dir}["'\`]\\)`, "g")) ?? []
      expect(calls.length).toBeGreaterThanOrEqual(2)
    })
  }
})
