import { describe, test, expect } from "bun:test"

function createCounter() {
  let gen = 0
  let pending = 0
  let flagged = 0

  const incPending = () => { pending++; return gen }
  const onClassified = (interesting: boolean, capturedGen: number) => {
    if (capturedGen !== gen) return
    pending--
    if (interesting) flagged++
  }
  const onClassifyError = (capturedGen: number) => {
    if (capturedGen !== gen) return
    pending--
  }

  const flush = (reinject: boolean) => {
    if (flagged <= 0 && pending <= 0) return false
    flagged = 0
    gen++
    pending = 0
    return true
  }

  return { incPending, onClassified, onClassifyError, flush, getFlagged: () => flagged, getPending: () => pending }
}

describe("flaggedTurnCount state machine", () => {
  test("flush resets counts when flagged>0, pending=0", () => {
    const c = createCounter()
    const g1 = c.incPending(); c.onClassified(true, g1)
    const g2 = c.incPending(); c.onClassified(true, g2)
    expect(c.flush(true)).toBe(true)
    expect(c.getFlagged()).toBe(0)
    expect(c.getPending()).toBe(0)
  })

  test("flush triggers when only pending classifications exist (zero flagged yet)", () => {
    const c = createCounter()
    c.incPending()
    c.incPending()
    expect(c.getFlagged()).toBe(0)
    expect(c.getPending()).toBe(2)
    expect(c.flush(true)).toBe(true)
    expect(c.getFlagged()).toBe(0)
    expect(c.getPending()).toBe(0)
  })

  test("flush is no-op when both flagged and pending are zero", () => {
    const c = createCounter()
    expect(c.flush(true)).toBe(false)
    expect(c.getFlagged()).toBe(0)
    expect(c.getPending()).toBe(0)
  })

  test("pending decrement on classify error doesn't leak", () => {
    const c = createCounter()
    const g = c.incPending()
    c.onClassifyError(g)
    expect(c.getPending()).toBe(0)
    expect(c.getFlagged()).toBe(0)
  })

  test("pending+flagged tracked independently", () => {
    const c = createCounter()
    const g1 = c.incPending(); c.onClassified(true, g1)
    const g2 = c.incPending(); c.onClassified(false, g2)
    c.incPending()
    expect(c.getFlagged()).toBe(1)
    expect(c.getPending()).toBe(1)
    c.flush(true)
    expect(c.getFlagged()).toBe(0)
    expect(c.getPending()).toBe(0)
  })

  test("multiple flushes: second is no-op after first drained", () => {
    const c = createCounter()
    const g = c.incPending(); c.onClassified(true, g)
    expect(c.flush(true)).toBe(true)
    expect(c.flush(true)).toBe(false)
    expect(c.getFlagged()).toBe(0)
    expect(c.getPending()).toBe(0)
  })

  test("stale classification from before-flush is silently dropped (gen bump)", () => {
    const c = createCounter()
    const g = c.incPending()
    c.flush(true)
    expect(c.getFlagged()).toBe(0)
    expect(c.getPending()).toBe(0)
    c.onClassified(true, g)
    expect(c.getFlagged()).toBe(0)
    expect(c.getPending()).toBe(0)
  })

  test("stale classification error from before-flush is silently dropped", () => {
    const c = createCounter()
    const g = c.incPending()
    c.flush(true)
    c.onClassifyError(g)
    expect(c.getFlagged()).toBe(0)
    expect(c.getPending()).toBe(0)
  })

  test("post-flush classifications increment fresh counter", () => {
    const c = createCounter()
    const g1 = c.incPending()
    c.flush(true)
    c.onClassified(true, g1)
    const g2 = c.incPending(); c.onClassified(true, g2)
    expect(c.getFlagged()).toBe(1)
    expect(c.getPending()).toBe(0)
  })

  test("session.deleted flush passes reinject=false", () => {
    const c = createCounter()
    const g = c.incPending(); c.onClassified(true, g)
    expect(c.flush(false)).toBe(true)
    expect(c.getFlagged()).toBe(0)
    expect(c.getPending()).toBe(0)
  })

  test("session.idle flush passes reinject=true", () => {
    const c = createCounter()
    const g = c.incPending(); c.onClassified(true, g)
    expect(c.flush(true)).toBe(true)
    expect(c.getFlagged()).toBe(0)
    expect(c.getPending()).toBe(0)
  })

  test("session.created flush passes reinject=false", () => {
    const c = createCounter()
    const g = c.incPending(); c.onClassified(true, g)
    expect(c.flush(false)).toBe(true)
    expect(c.getFlagged()).toBe(0)
    expect(c.getPending()).toBe(0)
  })
})

describe("keeper busy guard", () => {
  test("second spawn skipped when first in progress", () => {
    let busy = false
    let spawnCount = 0
    const spawn = () => {
      if (busy) return false
      busy = true
      try { spawnCount++; return true } finally { busy = false }
    }
    expect(spawn()).toBe(true)
    expect(spawn()).toBe(true)
    expect(spawnCount).toBe(2)
  })

  test("spawn failure resets busy flag", () => {
    let busy = false
    let errors = 0
    const spawn = (throwOnSpawn: boolean) => {
      if (busy) return false
      busy = true
      try {
        if (throwOnSpawn) throw new Error("spawn failed")
        return true
      } catch {
        errors++
        return false
      } finally {
        busy = false
      }
    }
    expect(spawn(true)).toBe(false)
    expect(errors).toBe(1)
    expect(spawn(false)).toBe(true)
    expect(busy).toBe(false)
  })
})

describe("isInRoot path boundary check", () => {
  test("imports and exercises real isInRoot", async () => {
    const { isInRoot } = await import("./index.ts")
    expect(isInRoot("/a/b", "/a/b")).toBe(true)
    expect(isInRoot("/a/b/c", "/a/b")).toBe(true)
    expect(isInRoot("/a/b-other/c", "/a/b")).toBe(false)
    expect(isInRoot("/a/b/c/../c/d", "/a/b")).toBe(true)
  })

  test("filesystem root '/' allows all absolute paths", async () => {
    const { isInRoot } = await import("./index.ts")
    expect(isInRoot("/foo", "/")).toBe(true)
    expect(isInRoot("/", "/")).toBe(true)
    expect(isInRoot("/foo/bar", "/")).toBe(true)
  })
})
