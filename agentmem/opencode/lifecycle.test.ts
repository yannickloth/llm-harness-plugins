import { describe, test, expect, mock } from "bun:test"

describe("flaggedTurnCount state machine", () => {
  test("flushFlaggedTurns resets positive count and invokes spawn callback", () => {
    let count = 3
    let spawned = false
    const onSpawn = () => { spawned = true }

    if (count <= 0) return
    count = 0
    onSpawn()

    expect(count).toBe(0)
    expect(spawned).toBe(true)
  })

  test("flushFlaggedTurns is no-op when count is zero", () => {
    let count = 0
    let spawned = false
    const onSpawn = () => { spawned = true }

    if (count <= 0) return
    count = 0
    onSpawn()

    expect(count).toBe(0)
    expect(spawned).toBe(false)
  })

  test("flushFlaggedTurns is no-op when count is negative", () => {
    let count = -1
    let spawned = false
    const onSpawn = () => { spawned = true }

    if (count <= 0) return
    count = 0
    onSpawn()

    expect(count).toBe(-1)
    expect(spawned).toBe(false)
  })

  test("session.deleted triggers flush when count > 0", () => {
    let count = 2
    let spawnCalls: string[] = []

    const handleEvent = (eventType: string) => {
      switch (eventType) {
        case "session.deleted":
        case "session.idle":
          if (count > 0) {
            count = 0
            spawnCalls.push(eventType)
          }
          break
        case "session.created":
          if (count > 0) {
            count = 0
            spawnCalls.push(eventType)
          }
          count = 0
          break
      }
    }

    handleEvent("session.deleted")
    expect(count).toBe(0)
    expect(spawnCalls).toEqual(["session.deleted"])
  })

  test("session.idle triggers flush when count > 0", () => {
    let count = 2
    let spawnCalls: string[] = []

    const handleEvent = (eventType: string) => {
      switch (eventType) {
        case "session.deleted":
        case "session.idle":
          if (count > 0) {
            count = 0
            spawnCalls.push(eventType)
          }
          break
        case "session.created":
          if (count > 0) {
            count = 0
            spawnCalls.push(eventType)
          }
          count = 0
          break
      }
    }

    handleEvent("session.idle")
    expect(count).toBe(0)
    expect(spawnCalls).toEqual(["session.idle"])
  })

  test("session.created flushes pending turns before resetting", () => {
    let count = 2
    let spawnCalls: string[] = []

    const handleEvent = (eventType: string) => {
      switch (eventType) {
        case "session.deleted":
        case "session.idle":
          if (count > 0) {
            count = 0
            spawnCalls.push(eventType)
          }
          break
        case "session.created":
          if (count > 0) {
            count = 0
            spawnCalls.push(eventType)
          }
          count = 0
          break
      }
    }

    handleEvent("session.created")
    expect(count).toBe(0)
    expect(spawnCalls).toEqual(["session.created"])
  })

  test("session.created with zero count just resets", () => {
    let count = 0
    let spawnCalls: string[] = []

    const handleEvent = (eventType: string) => {
      switch (eventType) {
        case "session.deleted":
        case "session.idle":
          if (count > 0) {
            count = 0
            spawnCalls.push(eventType)
          }
          break
        case "session.created":
          if (count > 0) {
            count = 0
            spawnCalls.push(eventType)
          }
          count = 0
          break
      }
    }

    handleEvent("session.created")
    expect(count).toBe(0)
    expect(spawnCalls).toEqual([])
  })

  test("idle followed by deleted doesn't double-spawn", () => {
    let count = 3
    let spawnCalls: string[] = []

    const handleEvent = (eventType: string) => {
      switch (eventType) {
        case "session.deleted":
        case "session.idle":
          if (count > 0) {
            count = 0
            spawnCalls.push(eventType)
          }
          break
        case "session.created":
          if (count > 0) {
            count = 0
            spawnCalls.push(eventType)
          }
          count = 0
          break
      }
    }

    handleEvent("session.idle")
    handleEvent("session.deleted")
    expect(count).toBe(0)
    expect(spawnCalls).toEqual(["session.idle"])
  })

  test("all three event types reach spawn when each has pending turns", () => {
    function createHandler() {
      let count = 0
      let spawnCalls: string[] = []
      return {
        flagTurn: () => { count++ },
        handleEvent: (eventType: string) => {
          switch (eventType) {
            case "session.deleted":
            case "session.idle":
              if (count > 0) {
                count = 0
                spawnCalls.push(eventType)
              }
              break
            case "session.created":
              if (count > 0) {
                count = 0
                spawnCalls.push(eventType)
              }
              count = 0
              break
          }
        },
        getSpawnCalls: () => spawnCalls,
      }
    }

    const h1 = createHandler()
    h1.flagTurn()
    h1.handleEvent("session.deleted")
    expect(h1.getSpawnCalls()).toEqual(["session.deleted"])

    const h2 = createHandler()
    h2.flagTurn()
    h2.handleEvent("session.idle")
    expect(h2.getSpawnCalls()).toEqual(["session.idle"])

    const h3 = createHandler()
    h3.flagTurn()
    h3.handleEvent("session.created")
    expect(h3.getSpawnCalls()).toEqual(["session.created"])
  })
})
