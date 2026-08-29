import { describe, test, expect } from "bun:test"
import { join } from "path"
import { extractFilePath } from "./index"

describe("sdlc-guardrails", () => {
  test("plugin directory structure exists", () => {
    const { existsSync } = require("fs")
    const base = join(import.meta.dir, "..")
    expect(existsSync(join(base, "src/main/java/eu/infolead/llmhp/sdlcguardrails/DiffGuard.java"))).toBe(true)
    expect(existsSync(join(base, "src/main/java/eu/infolead/llmhp/sdlcguardrails/SdlcGuardrailsCli.java"))).toBe(true)
    expect(existsSync(join(base, "opencode/index.ts"))).toBe(true)
  })

  test("enforcement rules present in Java source", () => {
    const { readFileSync } = require("fs")
    const source: string = readFileSync(join(import.meta.dir, "..", "src/main/java/eu/infolead/llmhp/sdlcguardrails/DiffGuard.java"), "utf-8")
    expect(source).toContain("R2") // protected path
    expect(source).toContain("R3") // test protection
    expect(source).toContain("R1") // plan sync
  })

  test("opencode shim registers hooks and tools", async () => {
    const mod = await import(join(import.meta.dir, "..", "opencode", "index.ts"))
    expect(mod.default).toBeDefined()
    const result = await mod.default({
      directory: "/tmp/test",
      worktree: undefined,
    })
    expect(result.tool).toBeDefined()
    expect(result.tool["sdlc-check"]).toBeDefined()
    expect(result.tool["sdlc-status"]).toBeDefined()
    expect(result.tool["sdlc-audit"]).toBeDefined()
    expect(result.tool["sdlc-sync"]).toBeDefined()
    expect(result.tool["sdlc-verify"]).toBeDefined()
    expect(result.tool["sdlc-incident"]).toBeDefined()
    expect(typeof result["tool.execute.before"]).toBe("function")
    expect(typeof result["tool.execute.after"]).toBe("function")
    expect(typeof result["command.execute.before"]).toBe("function")
  })

  test("extractFilePath resolves common arg shapes", () => {
    expect(extractFilePath({ filePath: "src/A.ts" })).toBe("src/A.ts")
    expect(extractFilePath({ file_path: "src/B.ts" })).toBe("src/B.ts")
    expect(extractFilePath({ path: "src/C.ts" })).toBe("src/C.ts")
    expect(extractFilePath({ file: "src/D.ts" })).toBe("src/D.ts")
    expect(extractFilePath({})).toBeNull()
    expect(extractFilePath({ filePath: 42 })).toBeNull()
  })
})
