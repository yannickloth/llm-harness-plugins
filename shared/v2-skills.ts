import { existsSync, readdirSync, readFileSync, statSync } from "fs"
import { join } from "path"

/**
 * Register a plugin's skills directory with an OpenCode v2 skill editor.
 *
 * ## Two elements, two drivers
 *
 * This module deliberately keeps the two halves apart, because they change for
 * different reasons:
 *
 * - `readSkillRecords` is governed by the **SKILL.md format** (γ₁f): the
 *   `<dir>/<name>/SKILL.md` convention and the frontmatter keys.
 * - `registerSkillRecords` is governed by the **skill editor API** (γ₁): the
 *   `editor.add` record shape.
 *
 * An earlier version fused them into one readdir→add loop. That was a reducible
 * composite (IVP-2): the data flow is unidirectional and either half can change
 * without the other, so fusing them made the module claim an indivisibility it
 * did not have. Keeping them separate also means a change to the on-disk format
 * touches only the reader, and a change to `Skill.Info` touches only the writer.
 */

export interface SkillRecord {
  /** Directory name — also the skill id. */
  id: string
  name: string
  description?: string
  path: string
  /** Raw file contents, frontmatter included. */
  content: string
}

/** Parse the `name`/`description` keys of a SKILL.md frontmatter block. */
export function parseFrontmatter(raw: string): { name?: string; description?: string } {
  if (!raw.startsWith("---")) return {}
  const end = raw.indexOf("\n---", 3)
  if (end < 0) return {}
  const out: { name?: string; description?: string } = {}
  for (const line of raw.slice(3, end).split("\n")) {
    const m = line.match(/^(name|description):\s*(.+)$/)
    if (m) out[m[1] as "name" | "description"] = m[2].trim().replace(/^["']|["']$/g, "")
  }
  return out
}

/**
 * Enumerate `<dir>/<name>/SKILL.md` and read each one. Governed by the SKILL.md
 * format only — no editor involved.
 */
export function readSkillRecords(dir: string): SkillRecord[] {
  if (!dir || !existsSync(dir)) return []
  const out: SkillRecord[] = []
  for (const entry of readdirSync(dir).sort()) {
    const skillFile = join(dir, entry, "SKILL.md")
    if (!existsSync(skillFile) || !statSync(skillFile).isFile()) continue
    let raw: string
    try {
      raw = readFileSync(skillFile, "utf8")
    } catch {
      continue
    }
    const { name, description } = parseFrontmatter(raw)
    out.push({ id: entry, name: name ?? entry, description, path: skillFile, content: raw })
  }
  return out
}

/**
 * Push records into a skill editor. Governed by the editor API only — no file
 * access. Returns the number added.
 */
export function registerSkillRecords(editor: any, records: readonly SkillRecord[]): number {
  if (typeof editor?.add !== "function") return 0
  let registered = 0
  for (const rec of records) {
    try {
      editor.add({
        id: rec.id,
        name: rec.name,
        description: rec.description ?? "",
        path: rec.path,
        content: rec.content,
      })
      registered++
    } catch {
      // already registered, or rejected by the host — skip
    }
  }
  return registered
}

/** Convenience composition of the two elements above. */
export function registerSkillDir(editor: any, dir: string): number {
  return registerSkillRecords(editor, readSkillRecords(dir))
}
