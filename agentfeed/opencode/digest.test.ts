import { describe, test, expect } from "bun:test"
import { buildDigest, DIGEST_HEADER } from "./digest"

function mk(id: string, host: string, seq: number, agent: string, type: any, extra: any = {}): any {
  return { id, host, seq, ts: "2026-08-13T22:00:00.000Z", agent, type, ...extra }
}

describe("buildDigest", () => {
  test("empty entries yield empty digest", () => {
    expect(buildDigest([])).toBe("")
  })

  test("msg renders header + line", () => {
    const d = buildDigest([mk("mbp:1", "mbp", 1, "auditor", "msg", { text: "hi" })])
    expect(d).toContain(DIGEST_HEADER)
    expect(d).toContain("- [mbp:1] auditor: hi")
  })

  test("claim renders lease", () => {
    const d = buildDigest([mk("mbp:2", "mbp", 2, "writer", "claim", { task: "draft ch.4", lease: "2999-12-31T00:00:00.000Z" })])
    expect(d).toContain('claim "draft ch.4" (lease until 2999-12-31T00:00:00.000Z)')
  })

  test("status renders arrow", () => {
    const d = buildDigest([mk("mbp:3", "mbp", 3, "writer", "status", { task: "draft ch.4", status: "done" })])
    expect(d).toContain("- [mbp:3] writer: draft ch.4 → done")
  })

  test("handoff renders target", () => {
    const d = buildDigest([mk("mbp:4", "mbp", 4, "writer", "handoff", { task: "ch.3", target: "auditor" })])
    expect(d).toContain("- [mbp:4] writer: handed \"ch.3\" to auditor")
  })

  test("caps at maxEntries (default 50)", () => {
    const entries = Array.from({ length: 60 }, (_, i) => mk(`mbp:${i}`, "mbp", i, "a", "msg", { text: String(i) }))
    const d = buildDigest(entries)
    const lines = d.split("\n").filter((l) => l.startsWith("- "))
    expect(lines).toHaveLength(50)
    expect(lines[0]).toContain("[mbp:10]")
  })

  test("release renders task/id", () => {
    expect(buildDigest([mk("mbp:5", "mbp", 5, "writer", "release", { task: "ch.3" })])).toContain('release "ch.3"')
    expect(buildDigest([mk("mbp:6", "mbp", 6, "writer", "release", { taskID: "mbp:2" })])).toContain('release "mbp:2"')
  })

  test("heartbeat renders alive", () => {
    expect(buildDigest([mk("mbp:7", "mbp", 7, "writer", "heartbeat")])).toContain("- [mbp:7] writer: alive")
  })

  test("unknown type falls back to generic line (forward-compat)", () => {
    const d = buildDigest([mk("mbp:8", "mbp", 8, "writer", "rename", { task: "old", text: "now new" })])
    expect(d).toContain("- [mbp:8] writer: rename \"old\" — now new")
  })

  test("resource git renders single 'git <op>' (no double git)", () => {
    const e = { ...mk("mbp:9", "mbp", 9, "writer", "resource", { task: "git commit" }), resource: "git" }
    expect(buildDigest([e])).toContain("- [mbp:9] writer: git commit")
    expect(buildDigest([e])).not.toContain("git git")
  })

  test("resource git with ref renders op on branch", () => {
    const e = { ...mk("mbp:9", "mbp", 9, "writer", "resource", { task: "git push", ref: "main" }), resource: "git" }
    expect(buildDigest([e])).toContain("- [mbp:9] writer: git push on main")
  })

  test("resource git release renders 'released'", () => {
    const e = { ...mk("mbp:9", "mbp", 9, "writer", "resource", { task: "git hold", ref: "main", action: "release" }), resource: "git" }
    expect(buildDigest([e])).toContain("- [mbp:9] writer: released on main")
  })

  test("conflict alert on concurrent acquires by different agents", () => {
    const a = { ...mk("mbp:1", "mbp", 1, "writer", "resource", { task: "git hold", ref: "main", action: "acquire", lease: "2999-12-31T00:00:00.000Z" }), resource: "git" }
    const b = { ...mk("desk:1", "desk", 1, "auditor", "resource", { task: "git hold", ref: "main", action: "acquire", lease: "2999-12-31T00:00:00.000Z" }), resource: "git" }
    const d = buildDigest([a, b])
    expect(d).toContain("possible conflict")
    expect(d).toContain("writer")
    expect(d).toContain("auditor")
  })

  test("no conflict alert when one agent releases before the other acquires", () => {
    const a = { ...mk("mbp:1", "mbp", 1, "writer", "resource", { task: "git hold", ref: "main", action: "acquire", lease: "2999-12-31T00:00:00.000Z" }), resource: "git", ts: "2026-08-13T22:00:01.000Z" }
    const r = { ...mk("mbp:2", "mbp", 2, "writer", "resource", { task: "git hold", ref: "main", action: "release" }), resource: "git", ts: "2026-08-13T22:00:02.000Z" }
    const b = { ...mk("desk:1", "desk", 1, "auditor", "resource", { task: "git hold", ref: "main", action: "acquire", lease: "2999-12-31T00:00:00.000Z" }), resource: "git", ts: "2026-08-13T22:00:03.000Z" }
    expect(buildDigest([a, r, b])).not.toContain("possible conflict")
  })

  test("no conflict alert when agents acquire different resources", () => {
    const a = { ...mk("mbp:1", "mbp", 1, "writer", "resource", { task: "git hold", ref: "main", action: "acquire", lease: "2999-12-31T00:00:00.000Z" }), resource: "git" }
    const b = { ...mk("desk:1", "desk", 1, "auditor", "resource", { task: "edit", action: "acquire", lease: "2999-12-31T00:00:00.000Z" }), resource: "file", file: "src/a.ts" }
    expect(buildDigest([a, b])).not.toContain("possible conflict")
  })

  test("auto touches with no lease do not raise a conflict", () => {
    const a = { ...mk("mbp:1", "mbp", 1, "writer", "resource", { task: "edit" }), resource: "file", file: "src/a.ts" }
    const b = { ...mk("desk:1", "desk", 1, "auditor", "resource", { task: "edit" }), resource: "file", file: "src/a.ts" }
    expect(buildDigest([a, b])).not.toContain("possible conflict")
  })

  test("resource file renders 'touched <path>'", () => {
    const e = { ...mk("mbp:10", "mbp", 10, "writer", "resource", { task: "edit" }), resource: "file", file: "src/a.ts" }
    expect(buildDigest([e])).toContain("- [mbp:10] writer: touched src/a.ts")
  })

  test("resource file release renders 'released <path>'", () => {
    const e = { ...mk("mbp:10", "mbp", 10, "writer", "resource", { task: "edit", action: "release" }), resource: "file", file: "src/a.ts" }
    expect(buildDigest([e])).toContain("- [mbp:10] writer: released src/a.ts")
  })

  test("ask and answer render", () => {
    expect(buildDigest([mk("mbp:11", "mbp", 11, "writer", "ask", { text: "who owns ch.4?" })])).toContain("- [mbp:11] writer asks: who owns ch.4?")
    expect(buildDigest([mk("mbp:12", "mbp", 12, "editor", "answer", { text: "I do", taskID: "mbp:11" })])).toContain("- [mbp:12] editor answers (mbp:11): I do")
  })

  test("answer references question text when no id", () => {
    const d = buildDigest([mk("mbp:13", "mbp", 13, "editor", "answer", { text: "I do", task: "who owns ch.4?" })])
    expect(d).toContain("- [mbp:13] editor answers (who owns ch.4?): I do")
  })
})
