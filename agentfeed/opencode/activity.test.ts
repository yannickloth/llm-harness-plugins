import { describe, test, expect } from "bun:test"
import { detectActivity, resourceEntry, coalesceKey } from "./activity"

describe("detectActivity", () => {
  test("git commit via bash", () => {
    const a = detectActivity({ tool: "bash", args: { command: "git commit -m 'x'" } })
    expect(a).toEqual({ resource: "git", file: "", detail: "git commit" })
  })

  test("git merge/push/checkout", () => {
    expect(detectActivity({ tool: "bash", args: { command: "git merge main" } })?.detail).toBe("git merge")
    expect(detectActivity({ tool: "bash", args: { command: "git push origin main" } })?.detail).toBe("git push")
    expect(detectActivity({ tool: "bash", args: { command: "git checkout -b feat" } })?.detail).toBe("git checkout")
  })

  test("non-git bash not detected", () => {
    expect(detectActivity({ tool: "bash", args: { command: "ls -la" } })).toBeNull()
    expect(detectActivity({ tool: "bash", args: { command: "npm run build" } })).toBeNull()
  })

  test("read-only git ops not detected", () => {
    expect(detectActivity({ tool: "bash", args: { command: "git log --oneline" } })).toBeNull()
    expect(detectActivity({ tool: "bash", args: { command: "git status" } })).toBeNull()
    expect(detectActivity({ tool: "bash", args: { command: "git diff" } })).toBeNull()
  })

  test("extracts the mutating op, not a stray git token earlier in the command", () => {
    // "git log" appears inside a quoted string before the real "git merge"
    expect(detectActivity({ tool: "bash", args: { command: "echo 'see git log output' && git merge main" } })?.detail)
      .toBe("git merge")
    // git op at end of command
    expect(detectActivity({ tool: "bash", args: { command: "git merge" } })?.detail).toBe("git merge")
    // hyphenated, not a git subcommand
    expect(detectActivity({ tool: "bash", args: { command: "man git-commit" } })).toBeNull()
  })

  test("supports git -C <dir> and --git-dir= invocations", () => {
    expect(detectActivity({ tool: "bash", args: { command: "git -C /repo commit -m x" } })?.detail).toBe("git commit")
    expect(detectActivity({ tool: "bash", args: { command: "git --git-dir=/repo/.git push" } })?.detail).toBe("git push")
    expect(detectActivity({ tool: "bash", args: { command: "git -C" } })).toBeNull()
  })

  test("file edit detected with path", () => {
    const a = detectActivity({ tool: "edit", args: { filePath: "src/a.ts" } })
    expect(a).toEqual({ resource: "file", file: "src/a.ts", detail: "edit" })
  })

  test("git ref/branch captured for ops targeting a branch", () => {
    expect(detectActivity({ tool: "bash", args: { command: "git push origin main" } })?.ref).toBe("main")
    expect(detectActivity({ tool: "bash", args: { command: "git checkout feat" } })?.ref).toBe("feat")
    expect(detectActivity({ tool: "bash", args: { command: "git merge main" } })?.ref).toBe("main")
    expect(detectActivity({ tool: "bash", args: { command: "git -C /repo push origin dev" } })?.ref).toBe("dev")
    // commit with no branch target -> no ref
    expect(detectActivity({ tool: "bash", args: { command: "git commit -m x" } })?.ref).toBeUndefined()
    // a flag first is not a ref
    expect(detectActivity({ tool: "bash", args: { command: "git pull --rebase" } })?.ref).toBeUndefined()
  })

  test("git ref handling for flag-led branch args and non-branch ops", () => {
    // branch after -b / -u / --force
    expect(detectActivity({ tool: "bash", args: { command: "git checkout -b new-branch" } })?.ref).toBe("new-branch")
    expect(detectActivity({ tool: "bash", args: { command: "git push -u origin feature/x" } })?.ref).toBe("feature/x")
    expect(detectActivity({ tool: "bash", args: { command: "git push --force origin main" } })?.ref).toBe("main")
    // file-path / commit ops are not branches
    expect(detectActivity({ tool: "bash", args: { command: "git restore src/a.ts" } })?.ref).toBeUndefined()
    expect(detectActivity({ tool: "bash", args: { command: "git revert abc123" } })?.ref).toBeUndefined()
  })

  test("write detected with path", () => {
    const a = detectActivity({ tool: "write", args: { path: "docs/x.md" } })
    expect(a).toEqual({ resource: "file", file: "docs/x.md", detail: "write" })
  })

  test("non-file tools not detected", () => {
    expect(detectActivity({ tool: "read", args: { filePath: "src/a.ts" } })).toBeNull()
    expect(detectActivity({ tool: "grep", args: {} })).toBeNull()
  })

  test("missing args not detected", () => {
    expect(detectActivity({ tool: "bash" })).toBeNull()
    expect(detectActivity({ tool: "edit" })).toBeNull()
  })
})

describe("resourceEntry / coalesceKey", () => {
  test("resourceEntry builds a resource ledger entry", () => {
    const a = detectActivity({ tool: "bash", args: { command: "git rebase main" } })!
    const e = resourceEntry("writer", a)
    expect(e.type).toBe("resource")
    expect(e.resource).toBe("git")
    expect(e.agent).toBe("writer")
  })

  test("resourceEntry marks auto ops as acquire and carries git ref", () => {
    const a = detectActivity({ tool: "bash", args: { command: "git push origin main" } })!
    const e = resourceEntry("writer", a)
    expect(e.action).toBe("acquire")
    expect(e.ref).toBe("main")
  })

  test("coalesceKey is per agent+resource+file", () => {
    const a1 = detectActivity({ tool: "edit", args: { filePath: "src/a.ts" } })!
    const a2 = detectActivity({ tool: "edit", args: { filePath: "src/b.ts" } })!
    expect(coalesceKey("writer", a1)).toBe("writer|file|src/a.ts")
    expect(coalesceKey("writer", a1)).not.toBe(coalesceKey("writer", a2))
    expect(coalesceKey("other", a1)).not.toBe(coalesceKey("writer", a1))
  })

  test("coalesceKey distinguishes distinct git operations", () => {
    const commit = detectActivity({ tool: "bash", args: { command: "git commit -m x" } })!
    const push = detectActivity({ tool: "bash", args: { command: "git push origin main" } })!
    // commit and push are different actions — must not coalesce into one key
    expect(coalesceKey("writer", commit)).not.toBe(coalesceKey("writer", push))
    expect(coalesceKey("writer", commit)).toBe("writer|git|git commit")
  })
})
