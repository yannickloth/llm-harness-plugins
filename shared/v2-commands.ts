import { existsSync, readdirSync, readFileSync, statSync } from "fs"
import { join } from "path"

/**
 * Register a plugin's own command files with OpenCode v2 — no copies into the
 * project, no `commands` entries in every consumer's `opencode.json`.
 *
 * Commands are the one channel the plugins in this repo did not use: skills go
 * through `v2-skills.ts`, agents through `agents.ts`, rules through the
 * `session.hook("context")` system prompt. A command is a *user-invoked* prompt
 * template (`/name`), so the model never pays for it until someone types it.
 *
 * ## Shape of the record
 *
 * The v2 command editor has **`add` only** — no `update`, no `get` (verified
 * against a live probe: the agent editor creates by `update`, the command editor
 * does not). So each command is registered exactly once with `add`, and the
 * fields are carried on the record:
 *
 *   { name, description?, template, agent?, model?, subtask? }
 *
 * `GET /api/command` reports only `{ name, description }`, but the execution
 * fields are retained by the registry; they are not re-readable from the API.
 * Ordering and duplicates are the host's concern — `add` is called once per file
 * per transform replay.
 *
 * ## File convention
 *
 * `<dir>/<name>.md` becomes the command `/<name>`. Frontmatter keys used here:
 *
 *   description: one line shown in the command list
 *   agent:       agent the command runs under (e.g. a read-only auditor)
 *   model:       `provider/model[#variant]` for this invocation only
 *   subtask:     `true` to run in a child session
 *
 * The body is the template. `$ARGUMENTS`, `$1`…`$N` and !`shell` expansions are
 * OpenCode's own; this module does not interpret them.
 *
 * Synchronous on purpose: v2 transforms must edit domain state synchronously in
 * the callback (the runtime ignores a returned promise).
 */

export interface CommandRecord {
  /** Command name without the leading slash. */
  name: string
  description?: string
  /** Markdown body — the prompt template. */
  template: string
  agent?: string
  /** Only `provider/model[#variant]`; bare aliases are dropped (v2 needs a ModelRef). */
  model?: string
  subtask?: boolean
}

/** Parse a model reference the way the agent registry does. */
export function parseModelRef(raw: string): { providerID: string; id: string; variant?: string } | undefined {
  const m = raw.trim().match(/^([^\s/#]+)\/(.+?)(?:#(\S+))?$/)
  if (!m) return undefined
  return { providerID: m[1], id: m[2], ...(m[3] ? { variant: m[3] } : {}) }
}

function stripQuotes(value: string): string {
  const v = value.trim()
  if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
    return v.slice(1, -1)
  }
  return v
}

/** Parse one `commands/<name>.md` file: a small frontmatter subset plus the body. */
export function parseCommand(raw: string, fallbackName: string): CommandRecord {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  const fmLines = match ? match[1].split(/\r?\n/) : []
  const template = (match ? match[2] : raw).trim()

  const scalars: Record<string, string> = {}
  for (const line of fmLines) {
    // Nested blocks (no frontmatter key this module models uses them) are skipped.
    if (/^\s+\S/.test(line)) continue
    const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/)
    if (!kv) continue
    scalars[kv[1]] = stripQuotes(kv[2])
  }

  return {
    name: scalars.name || fallbackName,
    description: scalars.description || undefined,
    template,
    agent: scalars.agent || undefined,
    model: scalars.model && parseModelRef(scalars.model) ? scalars.model : undefined,
    subtask: scalars.subtask === "true" ? true : undefined,
  }
}

/** All `*.md` commands in `dir`, sorted by filename for a stable order. */
export function readCommandRecords(dir: string): CommandRecord[] {
  if (!dir || !existsSync(dir)) return []
  const out: CommandRecord[] = []
  for (const entry of readdirSync(dir).sort()) {
    if (!entry.endsWith(".md")) continue
    const file = join(dir, entry)
    if (!statSync(file).isFile()) continue
    let raw: string
    try {
      raw = readFileSync(file, "utf8")
    } catch {
      continue
    }
    out.push(parseCommand(raw, entry.replace(/\.md$/, "")))
  }
  return out
}

/**
 * v2: register each command through `ctx.command.transform`'s editor with
 * `add`. The command editor has no `update`/`get`, so this is a plain add per
 * file; the host ignores a duplicate name.
 *
 * Returns the number registered. An entry the host rejects never aborts the
 * others.
 */
export function registerCommandDirV2(editor: any, dir: string): number {
  if (typeof editor?.add !== "function") return 0
  let registered = 0
  for (const rec of readCommandRecords(dir)) {
    const definition: Record<string, unknown> = { name: rec.name, template: rec.template }
    if (rec.description) definition.description = rec.description
    if (rec.agent) definition.agent = rec.agent
    if (rec.model) {
      const ref = parseModelRef(rec.model)
      if (ref) definition.model = ref
    }
    if (rec.subtask) definition.subtask = true
    try {
      editor.add(definition)
      registered++
    } catch {
      // rejected by the host (duplicate name, unsupported field) — skip
    }
  }
  return registered
}
