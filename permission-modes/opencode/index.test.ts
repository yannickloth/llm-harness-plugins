import { describe, test, expect } from "bun:test"
import { join } from "path"

describe("permission-modes", () => {
  test("plugin directory structure exists", () => {
    const { existsSync } = require("fs")
    const { join } = require("path")
    const base = join(import.meta.dir, "..")

    expect(existsSync(join(base, "src/main/java/eu/infolead/llmhp/permissionmodes/PermissionModes.java"))).toBe(true)
    expect(existsSync(join(base, "src/main/java/eu/infolead/llmhp/permissionmodes/PermissionModesCli.java"))).toBe(true)
    expect(existsSync(join(base, "opencode/index.ts"))).toBe(true)
  })

  test("BYPASS_IMMUNE patterns exist in Java source", () => {
    const { readFileSync } = require("fs")
    const source = readFileSync(join(import.meta.dir, "..", "src/main/java/eu/infolead/llmhp/permissionmodes/PermissionModes.java"), "utf-8")

    expect(source).toContain("BYPASS_IMMUNE")
    expect(source).toContain("bypassImmuneCheck")
  })
    expect(hooks.hooks.PreToolUse[0].hooks[0].command).toContain("PermissionModesCli")
  })

  test("opencode index exports 4 tools", async () => {
    const mod = await import(join(import.meta.dir, "..", "opencode", "index.ts"))
    expect(mod.default).toBeDefined()

    const result = await mod.default({
      directory: "/tmp/test",
      worktree: undefined,
    })

    expect(result.tool).toBeDefined()
    expect(result.tool["permission-mode"]).toBeDefined()
    expect(result.tool["permission-status"]).toBeDefined()
    expect(result.tool["permission-state"]).toBeDefined()
    expect(result.tool["permission-check"]).toBeDefined()
    expect(result["tool.execute.before"]).toBeDefined()
  })

  test("tool schemas have correct args", async () => {
    const mod = await import(join(import.meta.dir, "..", "opencode", "index.ts"))
    const result = await mod.default({
      directory: "/tmp/test",
      worktree: undefined,
    })

    const modeTool = result.tool["permission-mode"]
    expect(modeTool.args).toBeDefined()
    expect(modeTool.args.mode).toBeDefined()
    expect(modeTool.description).toContain("Transition to a permission mode")

    const checkTool = result.tool["permission-check"]
    expect(checkTool.args.tool).toBeDefined()
    expect(checkTool.args.filePath).toBeDefined()

    const statusTool = result.tool["permission-status"]
    expect(statusTool.args).toBeDefined()

    const stateTool = result.tool["permission-state"]
    expect(stateTool.args).toBeDefined()
  })

  test("tool.execute.before handler shape", async () => {
    const mod = await import(join(import.meta.dir, "..", "opencode", "index.ts"))
    const result = await mod.default({
      directory: "/tmp/test",
      worktree: undefined,
    })

    const handler = result["tool.execute.before"]
    expect(typeof handler).toBe("function")
  })
})
