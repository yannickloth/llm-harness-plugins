import { describe, expect, test } from "bun:test"
import { join, dirname } from "path"
import { fileURLToPath } from "url"
import { readFileSync } from "fs"

/**
 * IVP registry consistency.
 *
 * `shared/IVP-REGISTRY.md` is a hand-written driver registry. Two things in it are
 * mechanically checkable, and both have already been wrong once:
 *
 *   1. the Γ-equivalence class table must equal the partition induced by the
 *      assignment table;
 *   2. every driver in `C` must govern at least one element (Gate A finding 1:
 *      a declared driver with no element is not a driver of this set).
 *
 * The test parses the Markdown rather than restating the answer, so editing the
 * assignment without recomputing the classes fails instead of drifting.
 */

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const registry = readFileSync(join(root, "shared", "IVP-REGISTRY.md"), "utf8")

/** Rows of the `## Assignment Γ(e)` table: | # | element | file:line | Γ(e) | form | */
function assignmentRows(): { n: number; element: string; gamma: string[] }[] {
  const section = registry.split(/^## Assignment Γ\(e\)$/m)[1]?.split(/^## /m)[0] ?? ""
  const rows: { n: number; element: string; gamma: string[] }[] = []
  for (const line of section.split("\n")) {
    if (!line.startsWith("|")) continue
    const cells = line.split("|").map(c => c.trim())
    // cells[0] and [last] are empty (leading/trailing pipe)
    if (cells.length < 6) continue
    const n = Number(cells[1])
    if (!Number.isInteger(n)) continue
    // The Γ column is the one holding a braced Greek-letter set.
    const gammaCell = cells.find(c => /\{γ/.test(c)) ?? ""
    const match = gammaCell.match(/\{([^}]*)\}/)
    if (!match) continue
    const gamma = match[1].split(",").map(s => s.trim()).filter(Boolean)
    rows.push({ n, element: cells[2], gamma })
  }
  return rows
}

/** Rows of the class table: | Class | Γ | Elements | Module | */
function declaredClasses(): { name: string; gamma: string; members: number[] }[] {
  const section = registry.split(/^## Γ-equivalence classes/m)[1]?.split(/^## /m)[0] ?? ""
  const out: { name: string; gamma: string; members: number[] }[] = []
  for (const line of section.split("\n")) {
    if (!line.startsWith("|")) continue
    const cells = line.split("|").map(c => c.trim())
    if (cells.length < 5) continue
    const name = cells[1]
    // Class names use Unicode subscripts (M₁, M₂ …), which `\d` does not match.
    if (!/^M[\d\u2080-\u2089]+$/.test(name)) continue
    const gammaMatch = (cells.find(c => /\{γ/.test(c)) ?? "").match(/\{([^}]*)\}/)
    if (!gammaMatch) continue
    const gamma = gammaMatch[1].split(",").map(s => s.trim()).filter(Boolean).sort().join(",")
    // Members are the leading integers of the Elements cell; the Module cell is
    // a separate column and must not contribute digits (e.g. "v2-skills.ts").
    const members = (cells[3].match(/\d+/g) ?? []).map(Number)
    out.push({ name, gamma, members })
  }
  return out
}

describe("IVP registry", () => {
  const rows = assignmentRows()
  const classes = declaredClasses()

  test("registry parses", () => {
    expect(rows.length).toBe(17)
    expect(classes.length).toBe(10)
  })

  test("every element has a non-empty Γ (IVP-1 admissibility)", () => {
    const empty = rows.filter(r => r.gamma.length === 0).map(r => r.n)
    expect(empty).toEqual([])
  })

  test("every driver governs at least one element", () => {
    const drivers = [...new Set(rows.flatMap(r => r.gamma))]
    const orphans = drivers.filter(d => !rows.some(r => r.gamma.includes(d)))
    expect(orphans).toEqual([])
    // And no driver is declared in the drivers table but unused in the assignment.
    const declared = [...registry.matchAll(/^\| (γ[₀-₉a-z]+) \| A/gm)].map(m => m[1])
    expect(declared.length).toBeGreaterThan(0)
    const unused = declared.filter(d => !rows.some(r => r.gamma.includes(d)))
    expect(unused).toEqual([])
  })

  test("the class table equals the partition induced by the assignment", () => {
    const induced = new Map<string, number[]>()
    for (const r of rows) {
      const key = [...r.gamma].sort().join(",")
      if (!induced.has(key)) induced.set(key, [])
      induced.get(key)!.push(r.n)
    }
    const declared = new Map(classes.map(c => [c.gamma, [...c.members].sort((a, b) => a - b)]))
    const expected = new Map([...induced.entries()].map(([k, v]) => [k, v.sort((a, b) => a - b)]))

    expect(declared.size).toBe(expected.size)
    for (const [gamma, members] of expected) {
      expect({ gamma, members: declared.get(gamma) ?? null }).toEqual({ gamma, members })
    }
  })

  test("class count matches the stated count", () => {
    const stated = registry.match(/`P_Γ` has \*\*(\d+)\*\* classes/)
    expect(stated).not.toBeNull()
    expect(Number(stated![1])).toBe(classes.length)
  })

  test("no element appears in two classes", () => {
    const seen = new Map<number, string>()
    for (const c of classes) {
      for (const n of c.members) {
        expect({ n, previous: seen.get(n) ?? null }).toEqual({ n, previous: null })
        seen.set(n, c.name)
      }
    }
  })

  test("every element is placed in a class", () => {
    const placed = new Set(classes.flatMap(c => c.members))
    const missing = rows.map(r => r.n).filter(n => !placed.has(n))
    expect(missing).toEqual([])
  })
})
