import { moduleDir } from "./module-dir"
import { join } from "path"
import { describe, expect, test } from "bun:test"

describe("moduleDir", () => {
  test("derives directory from import.meta.url file path", () => {
    const url = "file:///home/user/project/shared/index.ts"
    expect(moduleDir(url, undefined)).toBe("/home/user/project/shared")
  })

  test("falls back to import.meta.dir when url is absent", () => {
    expect(moduleDir(undefined, "/home/user/project/shared")).toBe("/home/user/project/shared")
  })

  test("ignores non-file urls", () => {
    expect(moduleDir("http://example.com/x.ts", "/fallback/dir")).toBe("/fallback/dir")
  })

  test("throws when neither source is available", () => {
    expect(() => moduleDir(undefined, undefined)).toThrow(/Cannot resolve module directory/)
  })

  test("resolves a trailing slash file path", () => {
    const url = "file:///home/user/project/shared/plugin/index.ts"
    expect(moduleDir(url, undefined)).toBe("/home/user/project/shared/plugin")
  })

  test("joins with the parent", () => {
    const url = "file:///home/user/plugins/agentmem/opencode/index.ts"
    const dir = moduleDir(url, undefined)
    expect(join(dir, "..")).toBe("/home/user/plugins/agentmem")
  })
})
