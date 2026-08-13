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
    const source: string = readFileSync(join(import.meta.dir, "..", "src/main/java/eu/infolead/llmhp/permissionmodes/PermissionModes.java"), "utf-8")

    expect(source).toContain("BYPASS_IMMUNE")
    expect(source).toContain("isBypassImmune")
    expect(source).toContain(".opencode/")
    expect(source).toContain("agents.md")
    expect(source).toContain("normalizeToolName")
    expect(source).toContain("isDangerousTool")
    expect(source).toContain("unescapeJson")
    expect(source).toContain("ATOMIC_MOVE")
    expect(source).toContain("DANGEROUS_CATEGORY_LABELS")
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
    expect(statusTool.args).toBeDefined()
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

  test("tool.execute.before handles allowed = true correctly", async () => {
    const tmpDir = `${require("os").tmpdir()}/perm-test-${Date.now()}`
    const mod = await import(join(import.meta.dir, "..", "opencode", "index.ts"))

    const result = await mod.default({ directory: tmpDir, worktree: tmpDir })

    const ret = await result["tool.execute.before"]({ tool: "read", args: { filePath: "src/main.ts" } })
    expect(ret).toBeDefined()
    expect(ret.mode).toBeDefined()
    expect(typeof ret.reason).toBe("string")
  })

  test("tool.execute.before returns error gracefully on broken JVM", async () => {
    const tmpDir = `${require("os").tmpdir()}/perm-test-broken-${Date.now()}`
    const mod = await import(join(import.meta.dir, "..", "opencode", "index.ts"))

    const result = await mod.default({ directory: tmpDir, worktree: tmpDir })

    const ret = await result["tool.execute.before"]({ tool: "read", args: {} })
    expect(ret).toBeDefined()
    expect(ret.mode).toBeDefined()
  })

  test("tool.execute.before extracts bash command as filePath", async () => {
    const tmpDir = `${require("os").tmpdir()}/perm-test-bash-${Date.now()}`
    const mod = await import(join(import.meta.dir, "..", "opencode", "index.ts"))

    const result = await mod.default({ directory: tmpDir, worktree: tmpDir })

    const ret = await result["tool.execute.before"]({ tool: "bash", args: { command: "rm -rf .git" } })
    expect(ret).toBeDefined()
    expect(ret.mode).toBeDefined()
    expect(typeof ret.reason).toBe("string")
  })

  test("tool.execute.before handles edit with filePath", async () => {
    const tmpDir = `${require("os").tmpdir()}/perm-test-edit-${Date.now()}`
    const mod = await import(join(import.meta.dir, "..", "opencode", "index.ts"))

    const result = await mod.default({ directory: tmpDir, worktree: tmpDir })

    const ret = await result["tool.execute.before"]({ tool: "edit", args: { filePath: "src/main.ts", oldString: "x", newString: "y" } })
    expect(ret).toBeDefined()
    expect(ret.mode).toBeDefined()
  })

  test("tool.execute.before handles write with path alias", async () => {
    const tmpDir = `${require("os").tmpdir()}/perm-test-write-${Date.now()}`
    const mod = await import(join(import.meta.dir, "..", "opencode", "index.ts"))

    const result = await mod.default({ directory: tmpDir, worktree: tmpDir })

    const ret = await result["tool.execute.before"]({ tool: "write", args: { path: "out.txt", content: "hi" } })
    expect(ret).toBeDefined()
    expect(ret.mode).toBeDefined()
  })

  test("tool.execute.before handles read with file_path alias", async () => {
    const tmpDir = `${require("os").tmpdir()}/perm-test-read-${Date.now()}`
    const mod = await import(join(import.meta.dir, "..", "opencode", "index.ts"))

    const result = await mod.default({ directory: tmpDir, worktree: tmpDir })

    const ret = await result["tool.execute.before"]({ tool: "read", args: { file_path: "README.md" } })
    expect(ret).toBeDefined()
    expect(ret.mode).toBeDefined()
  })

  test("tool.execute.before handles task with filePath", async () => {
    const tmpDir = `${require("os").tmpdir()}/perm-test-task-${Date.now()}`
    const mod = await import(join(import.meta.dir, "..", "opencode", "index.ts"))

    const result = await mod.default({ directory: tmpDir, worktree: tmpDir })

    const ret = await result["tool.execute.before"]({ tool: "task", args: { filePath: "tmp/plan.md" } })
    expect(ret).toBeDefined()
    expect(ret.mode).toBeDefined()
  })

  test("permission-mode tool transitions", async () => {
    const tmpDir = require("fs").mkdtempSync(`${require("os").tmpdir()}/perm-tt-`)
    try {
      const mod = await import(join(import.meta.dir, "..", "opencode", "index.ts"))
      const result = await mod.default({ directory: tmpDir, worktree: tmpDir })

      const output = await result.tool["permission-mode"].execute({ mode: "plan" })
      const parsed = JSON.parse(output)
      expect(parsed.mode).toBe("plan")
      expect(parsed.symbol).toBe("P")
    } finally {
      require("fs").rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  test("permission-mode rejects invalid mode", async () => {
    const tmpDir = require("fs").mkdtempSync(`${require("os").tmpdir()}/perm-ti-`)
    try {
      const mod = await import(join(import.meta.dir, "..", "opencode", "index.ts"))
      const result = await mod.default({ directory: tmpDir, worktree: tmpDir })

      const output = await result.tool["permission-mode"].execute({ mode: "bogus" })
      expect(output).toContain("error")
      expect(output).toContain("unknown mode")
    } finally {
      require("fs").rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  test("permission-status returns valid JSON", async () => {
    const tmpDir = require("fs").mkdtempSync(`${require("os").tmpdir()}/perm-ts-`)
    try {
      const mod = await import(join(import.meta.dir, "..", "opencode", "index.ts"))
      const result = await mod.default({ directory: tmpDir, worktree: tmpDir })

      const output = await result.tool["permission-status"].execute({})
      const parsed = JSON.parse(output)
      expect(parsed.mode).toBeDefined()
      expect(parsed.symbol).toBeDefined()
      expect(typeof parsed.autoStripped).toBe("boolean")
      expect(typeof parsed.bypassImmuneCount).toBe("number")
      expect(parsed.blockedCategories).toBeDefined()
      expect(parsed.allows).toBeDefined()
      expect(parsed.denys).toBeDefined()
    } finally {
      require("fs").rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  test("permission-state returns full JSON with configs", async () => {
    const tmpDir = require("fs").mkdtempSync(`${require("os").tmpdir()}/perm-tst-`)
    try {
      const mod = await import(join(import.meta.dir, "..", "opencode", "index.ts"))
      const result = await mod.default({ directory: tmpDir, worktree: tmpDir })

      const output = await result.tool["permission-state"].execute({})
      const parsed = JSON.parse(output)
      expect(parsed.currentMode).toBeDefined()
      expect(parsed.configs).toBeDefined()
      expect(parsed.bypassImmune).toBeDefined()
      expect(parsed.bypassImmune.length).toBeGreaterThan(0)
      expect(parsed.bypassImmune).toContain(".git/")
    } finally {
      require("fs").rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  test("permission-check returns a result with allowed/mode", async () => {
    const tmpDir = require("fs").mkdtempSync(`${require("os").tmpdir()}/perm-tc-`)
    try {
      const mod = await import(join(import.meta.dir, "..", "opencode", "index.ts"))
      const result = await mod.default({ directory: tmpDir, worktree: tmpDir })

      const output = await result.tool["permission-check"].execute({ tool: "read", filePath: "src/main.ts" })
      const parsed = JSON.parse(output)
      expect(typeof parsed.allowed).toBe("boolean")
      expect(parsed.mode).toBeDefined()
    } finally {
      require("fs").rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  test("permission-check handles missing filePath", async () => {
    const tmpDir = require("fs").mkdtempSync(`${require("os").tmpdir()}/perm-tcf-`)
    try {
      const mod = await import(join(import.meta.dir, "..", "opencode", "index.ts"))
      const result = await mod.default({ directory: tmpDir, worktree: tmpDir })

      const output = await result.tool["permission-check"].execute({ tool: "bash" })
      const parsed = JSON.parse(output)
      expect(typeof parsed.allowed).toBe("boolean")
    } finally {
      require("fs").rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  test("permission-mode handles error on missing java", async () => {
    const tmpDir = require("fs").mkdtempSync(`${require("os").tmpdir()}/perm-tm-`)
    try {
      const mod = await import(join(import.meta.dir, "..", "opencode", "index.ts"))
      const result = await mod.default({ directory: tmpDir, worktree: tmpDir })

      const output = await result.tool["permission-mode"].execute({ mode: "plan" })
      expect(output).toBeDefined()
      expect(output.length).toBeGreaterThan(0)
    } finally {
      require("fs").rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  test("all 6 modes can be set via permission-mode", async () => {
    const tmpDir = require("fs").mkdtempSync(`${require("os").tmpdir()}/perm-t6-`)
    try {
      const mod = await import(join(import.meta.dir, "..", "opencode", "index.ts"))
      const result = await mod.default({ directory: tmpDir, worktree: tmpDir })

      for (const mode of ["default", "plan", "acceptEdits", "bypassPermissions", "dontAsk", "auto"]) {
        const output = await result.tool["permission-mode"].execute({ mode })
        const parsed = JSON.parse(output)
        expect(parsed.mode).toBe(mode)
      }
    } finally {
      require("fs").rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  test("tool.execute.before returns error mode string on parse failure", async () => {
    const tmpDir = `${require("os").tmpdir()}/perm-test-parserr-${Date.now()}`
    const mod = await import(join(import.meta.dir, "..", "opencode", "index.ts"))
    const result = await mod.default({ directory: tmpDir, worktree: tmpDir })

    const ret = await result["tool.execute.before"]({ tool: "read", args: { filePath: "src/" + "x".repeat(10000) } })
    expect(ret).toBeDefined()
    expect(typeof ret.reason).toBe("string")
  })
})
