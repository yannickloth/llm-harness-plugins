import { existsSync, readdirSync, readFileSync, statSync } from "fs"
import { join } from "path"

/**
 * Register a skills directory with an OpenCode v2 skill editor.
 *
 * v1 plugins appended their skills directory to `config.skills.paths` in a
 * `config` hook. v2 has no config hook: the only entry point is
 * `ctx.skill.transform(editor)`, and the editor takes fully-formed records
 * (`{ id, name, description, path, content }` — the shape `ctx.skill.list()`
 * returns) rather than directory paths. So the directory is enumerated here and
 * every `<dir>/<name>/SKILL.md` is added individually, parsing the frontmatter
 * `name`/`description` when present.
 *
 * Returns the number of skills registered. Duplicate ids are ignored by the
 * host; failures on individual entries never abort the others.
 */
export async function registerSkillDir(editor: any, dir: string): Promise<number> {
  if (!dir || !existsSync(dir)) return 0
  let registered = 0
  for (const entry of readdirSync(dir)) {
    const skillFile = join(dir, entry, "SKILL.md")
    if (!existsSync(skillFile) || !statSync(skillFile).isFile()) continue
    const raw = readFileSync(skillFile, "utf8")
    const { name, description } = parseFrontmatter(raw)
    try {
      await editor.add({
        id: entry,
        name: name ?? entry,
        description: description ?? "",
        path: skillFile,
        content: raw,
      })
      registered++
    } catch {
      // already registered, or rejected by the host — skip
    }
  }
  return registered
}

/** Minimal YAML frontmatter reader for the `name`/`description` keys. */
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
