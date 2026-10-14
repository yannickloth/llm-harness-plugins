import { describe, test, expect } from "bun:test"
import {
  DEFAULT_BUDGET,
  REMINDER_STEPS,
  applyMirrorEdits,
  buildProjection,
  budgetNotice,
  estimateTokens,
  evaluateRecall,
  isOverBudget,
  messagesTokens,
  parseBudget,
  parseMirror,
  pickReminder,
  project,
  renderMirror,
  sessionFromMessages,
  sessionPaths,
  validateParts,
  validateProjection,
  type CeMessage,
  type ParsedMirror,
} from "./helpers"

describe("token accounting", () => {
  test("estimateTokens is a deterministic char heuristic", () => {
    expect(estimateTokens("")).toBe(0)
    expect(estimateTokens("abcd")).toBe(1)
    expect(estimateTokens("abcde")).toBe(2)
    expect(estimateTokens("a".repeat(400))).toBe(100)
  })

  test("messagesTokens sums part text", () => {
    expect(messagesTokens([
      { parts: [{ text: "abcd" }, { text: "abcd" }] },
      { parts: [{ text: "abcdefgh" }] },
    ])).toBe(1 + 1 + 2)
  })
})

describe("parseBudget", () => {
  test("percent of window", () => {
    expect(parseBudget("50%", 100_000)).toBe(50_000)
    expect(parseBudget("25%", 40_000)).toBe(10_000)
  })

  test("k suffix means kilo-tokens", () => {
    expect(parseBudget("64k", 1_000_000)).toBe(65_536)
    expect(parseBudget("1k", 100)).toBe(1024)
  })

  test("window means the whole window", () => {
    expect(parseBudget("window", 128_000)).toBe(128_000)
  })

  test("bare number is a literal token count, not kilo", () => {
    expect(parseBudget("64", 100_000)).toBe(64)
  })

  test("default and invalid fall back to half the window", () => {
    expect(parseBudget(undefined, 100_000)).toBe(50_000)
    expect(parseBudget("garbage", 100_000)).toBe(50_000)
    expect(parseBudget("0%", 100_000)).toBe(50_000)
    expect(parseBudget("50%", 0)).toBe(0)
  })
})

describe("budget guard and reminders", () => {
  test("isOverBudget", () => {
    expect(isOverBudget(51, 50)).toBe(true)
    expect(isOverBudget(50, 50)).toBe(false)
    expect(isOverBudget(10, 0)).toBe(false)
  })

  test("pickReminder returns the highest newly-crossed step only", () => {
    expect(pickReminder(24, 100, new Set())).toBeNull()
    expect(pickReminder(26, 100, new Set())).toBe(25)
    expect(pickReminder(76, 100, new Set())).toBe(75)
    expect(pickReminder(76, 100, new Set([25]))).toBe(75)
    expect(pickReminder(76, 100, new Set(REMINDER_STEPS as unknown as number[]))).toBeNull()
    expect(pickReminder(200, 0, new Set())).toBeNull()
  })

  test("notices state the fail-open, do-not-fabricate rule", () => {
    expect(budgetNotice(450, 500)).toContain("90%")
    expect(budgetNotice(450, 500)).toContain("not a goal")
    expect(budgetNotice(450, 500).toLowerCase()).toContain("invent")
  })
})

const SOURCE: CeMessage[] = [
  { id: "m1", role: "user", sessionID: "s1", parts: [{ id: "p1", type: "text", text: "please fix the bug" }] },
  {
    id: "m2",
    role: "assistant",
    sessionID: "s1",
    parts: [
      { id: "p2", type: "text", text: "I will read the file" },
      { id: "p3", type: "tool", callID: "c1" },
      { id: "p4", type: "text", text: "the bug is on line 3" },
    ],
  },
  { id: "m3", role: "tool", sessionID: "s1", parts: [{ id: "p5", type: "tool_result", toolUseID: "c1" }] },
]

describe("mirror render / parse", () => {
  test("round-trips order with interleaved pinned and text blocks", () => {
    const md = renderMirror(SOURCE, "## Goal\nfix the bug")
    const parsed = parseMirror(md)
    expect(parsed.protected).toContain("fix the bug")
    expect(parsed.blocks.map((b) => b.partId)).toEqual(["p1", "p2", "p3", "p4", "p5"])
    expect(parsed.blocks.map((b) => b.kind)).toEqual(["text", "text", "pinned", "text", "pinned"])
    expect(parsed.blocks.find((b) => b.partId === "p2")!.text).toBe("I will read the file")
    expect(parsed.blocks.find((b) => b.partId === "p3")!.pinnedType).toBe("tool")
  })

  test("empty protected region renders a placeholder that parses back to empty", () => {
    const md = renderMirror(SOURCE, "")
    expect(parseMirror(md).protected).toBe("")
  })

  test("multi-line and empty text bodies survive", () => {
    const msgs: CeMessage[] = [
      { id: "m1", role: "user", parts: [{ id: "a", type: "text", text: "line1\nline2\nline3" }] },
      { id: "m2", role: "assistant", parts: [{ id: "b", type: "text", text: "" }] },
    ]
    const parsed = parseMirror(renderMirror(msgs, "goal"))
    expect(parsed.blocks.find((b) => b.partId === "a")!.text).toBe("line1\nline2\nline3")
    expect(parsed.blocks.find((b) => b.partId === "b")!.text).toBe("")
  })
})

describe("projection + validation", () => {
  test("a faithful mirror projects to the original structure with no issues", () => {
    const md = renderMirror(SOURCE, "## Goal\nfix the bug")
    const { messages, issues } = buildProjection(md, SOURCE)
    expect(issues).toEqual([])
    expect(messages.map((m) => m.id)).toEqual(["m1", "m2", "m3"])
    expect(messages[1].parts.map((p) => p.id)).toEqual(["p2", "p3", "p4"])
    expect(messages[2].parts[0].type).toBe("tool_result")
  })

  test("editing a text body flows through; pinned parts are restored from the trace", () => {
    const md = renderMirror(SOURCE, "## Goal\nfix the bug")
    const edited = md.replace("the bug is on line 3", "bug: line 3")
    const { messages, issues } = buildProjection(edited, SOURCE)
    expect(issues).toEqual([])
    expect(messages[1].parts.find((p) => p.id === "p4")!.text).toBe("bug: line 3")
    // The tool call was never in the file body; it is reinstated verbatim.
    expect(messages[1].parts.find((p) => p.id === "p3")!.callID).toBe("c1")
  })

  test("dropping a tool result splits the pair and is rejected", () => {
    const md = renderMirror(SOURCE, "## Goal\nfix the bug")
    const withoutP5 = md.replace(/^<!-- ce:b msg=m3 id=p5.*$/m, "")
    const parsed = parseMirror(withoutP5)
    expect(parsed.blocks.some((b) => b.partId === "p5")).toBe(false)
    const result = project(parsed, SOURCE)
    const issues = validateProjection(result, parsed)
    expect(issues.some((i) => /pair split|matching result|c1/.test(i))).toBe(true)
  })

  test("an empty protected region is rejected", () => {
    const parsed: ParsedMirror = { protected: "", blocks: [] }
    const result = project(parsed, SOURCE)
    expect(validateProjection(result, parsed)).toContain("protected region is empty")
  })

  test("a pinned block whose part is absent from the trace is reported", () => {
    const parsed: ParsedMirror = {
      protected: "goal",
      blocks: [{ msgId: "m9", partId: "ghost", role: "tool", kind: "pinned", pinnedType: "tool", text: "" }],
    }
    const result = project(parsed, SOURCE)
    expect(result.issues.some((i) => i.includes("ghost"))).toBe(true)
  })
})

describe("applyMirrorEdits", () => {
  const oc = () => [
    { info: { id: "m1", role: "user", sessionID: "s1" }, parts: [{ id: "p1", type: "text", text: "please fix the bug" }] },
    {
      info: { id: "m2", role: "assistant", sessionID: "s1" },
      parts: [
        { id: "p2", type: "text", text: "I will read the file" },
        { id: "p3", type: "tool", callID: "c1" },
        { id: "p4", type: "text", text: "the bug is on line 3" },
      ],
    },
    { info: { id: "m3", role: "tool", sessionID: "s1" }, parts: [{ id: "p5", type: "tool_result", toolUseID: "c1" }] },
  ]

  test("edits text in place, keeps pinned parts, counts edits", () => {
    const parsed = parseMirror(renderMirror(SOURCE, "goal"))
    parsed.blocks.find((b) => b.partId === "p4")!.text = "bug at line 3"
    const res = applyMirrorEdits(oc(), parsed)
    expect(res.issues).toEqual([])
    expect(res.edited).toBe(1)
    expect(res.dropped).toBe(0)
    expect(res.messages[1].parts.find((p) => p.id === "p4")!.text).toBe("bug at line 3")
    expect(res.messages[1].parts.find((p) => p.id === "p3")!.callID).toBe("c1")
  })

  test("dropping a text part counts as dropped", () => {
    const parsed = parseMirror(renderMirror(SOURCE, "goal"))
    parsed.blocks = parsed.blocks.filter((b) => b.partId !== "p2")
    const res = applyMirrorEdits(oc(), parsed)
    expect(res.dropped).toBe(1)
    expect(res.messages[1].parts.map((p) => p.id)).toEqual(["p3", "p4"])
  })

  test("a pinned part cannot be dropped by removing its marker — it is restored", () => {
    const parsed = parseMirror(renderMirror(SOURCE, "goal"))
    parsed.blocks = parsed.blocks.filter((b) => b.partId !== "p5")
    const res = applyMirrorEdits(oc(), parsed)
    expect(res.issues).toEqual([])
    expect(res.messages.some((m) => m.parts.some((p) => p.id === "p5"))).toBe(true)
  })

  test("validateParts detects a split pair directly", () => {
    expect(validateParts([{ id: "t1", type: "tool", callID: "c9" }]))
      .toContain("tool call c9 has no matching result (pair split)")
    expect(validateParts([{ id: "r1", type: "tool_result", toolUseID: "c9" }]))
      .toContain("tool result c9 has no matching call (pair split)")
    expect(validateParts([
      { id: "t1", type: "tool", callID: "c9" },
      { id: "r1", type: "tool_result", toolUseID: "c9" },
    ])).toEqual([])
  })

  test("an added text block is appended to the last message", () => {
    const parsed = parseMirror(renderMirror(SOURCE, "goal"))
    parsed.blocks.push({ msgId: "m3", partId: "new1", role: "assistant", kind: "text", text: "note: see changelog" })
    const res = applyMirrorEdits(oc(), parsed)
    expect(res.added).toBe(1)
    expect(res.issues).toEqual([])
    expect(res.messages[res.messages.length - 1].parts.some((p) => p.id === "new1")).toBe(true)
  })

  test("an emptied protected region is rejected", () => {
    const parsed = parseMirror(renderMirror(SOURCE, "goal"))
    parsed.protected = ""
    expect(applyMirrorEdits(oc(), parsed).issues).toContain("protected region is empty")
  })
})

describe("recall gate is fail-closed", () => {
  const base = { missingInMirror: true, inTrace: true, reDerivable: false, canProceed: false }

  test("all three conditions → allow", () => {
    expect(evaluateRecall(base).allow).toBe(true)
  })

  test("any condition failing → deny with a reason", () => {
    expect(evaluateRecall({ ...base, missingInMirror: false }).allow).toBe(false)
    expect(evaluateRecall({ ...base, canProceed: true }).allow).toBe(false)
    expect(evaluateRecall({ ...base, inTrace: false }).allow).toBe(false)
    expect(evaluateRecall({ ...base, reDerivable: true }).allow).toBe(false)
    expect(evaluateRecall({ ...base, reDerivable: true }).reason).toContain("re-derivable")
  })
})

describe("misc", () => {
  test("sessionFromMessages recovers the first session id", () => {
    expect(sessionFromMessages([{ sessionID: "s9" }])).toBe("s9")
    expect(sessionFromMessages([{}, { sessionID: "s2" }])).toBe("s2")
    expect(sessionFromMessages([])).toBeUndefined()
  })

  test("sessionPaths is namespaced by session", () => {
    const p = sessionPaths("/root", "abc")
    expect(p.mirror).toBe("/root/.context-editing/abc/context.md")
    expect(p.trace).toBe("/root/.context-editing/abc/trace.jsonl")
    expect(p.metrics).toBe("/root/.context-editing/abc/metrics.jsonl")
  })

  test("default budget constant is 50%", () => {
    expect(DEFAULT_BUDGET).toBe("50%")
  })
})
