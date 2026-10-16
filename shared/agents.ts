import { existsSync, readdirSync, readFileSync, statSync } from "fs"
import { join } from "path"

/**
 * Register a plugin's own agent files with OpenCode — no symlinks, no copies.
 *
 * OpenCode discovers agent *files* only from `~/.config/opencode/agents/` and
 * `<project>/.opencode/agents/` (plus the legacy `agent/`, `mode/`, `modes/`).
 * A plugin directory is never scanned, and there is no API to register an agent
 * *directory*. Historically the workaround was to symlink each `<plugin>/agents/
 * <name>.md` into the global agent directory.
 *
 * V2 removed the need for that: `ctx.agent.transform`'s editor creates an agent
 * when `update(id, …)` is called for an id that does not exist yet (the editor
 * has no `add`, so creation is spelled `update`). This module reads the files
 * once and registers them inline. V1 has no equivalent create-by-update, so for
 * V1 the same records are replayed into the config hook's `agent` map as inline
 * entries (`prompt`, `mode`, `maxSteps`, `permission`, `tools`).
 *
 * Reading the files ourselves also avoids feeding their frontmatter to a client's
 * config validator — the exact failure mode that forced the symlink script to
 * keep an allowlist (a legacy `tools:`/`permission:` file the oldest client in
 * use cannot validate made that client refuse to start).
 */

export type PermissionEffect = "allow" | "deny" | "ask"

export interface PermissionRule {
  action: string
  resource: string
  effect: PermissionEffect
}

export interface AgentRecord {
  id: string
  description?: string
  mode: "subagent" | "primary" | "all"
  steps?: number
  /** Only `provider/model[#variant]`; bare aliases are dropped (V2 needs a ModelRef). */
  model?: string
  color?: string
  hidden?: boolean
  /** Markdown body — becomes the agent's `system` prompt. */
  system: string
  /** V2 permission rules (ordered). */
  permissions: PermissionRule[]
  /** Raw V1 `permission:` map (verb -> effect), used by the V1 config path. */
  permissionMap: Record<string, PermissionEffect>
}

/** V1 permission verb (tool name) -> V2 permission action. */
const V2_ACTION: Record<string, string> = {
  bash: "shell",
  write: "edit",
  patch: "edit",
  task: "subagent",
  todowrite: "todo",
}

/** Permission verbs V1's `AgentConfig.permission` object accepts (closed schema). */
const V1_PERMISSION = new Set(["edit", "bash", "webfetch", "doom_loop", "external_directory"])

const MODES = new Set(["subagent", "primary", "all"])

function stripQuotes(value: string): string {
  const v = value.trim()
  if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
    return v.slice(1, -1)
  }
  return v
}

function asEffect(value: string): PermissionEffect | undefined {
  const v = stripQuotes(value).toLowerCase()
  return v === "allow" || v === "deny" || v === "ask" ? v : undefined
}

/**
 * Parse one `<name>.md` agent file: frontmatter (a small, deliberate subset —
 * the shapes these plugins actually use) plus the Markdown body.
 */
export function parseAgent(raw: string, fallbackId: string): AgentRecord {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  const fmLines = match ? match[1].split(/\r?\n/) : []
  const body = match ? match[2] : raw

  const scalars: Record<string, string> = {}
  const permissionMap: Record<string, PermissionEffect> = {}
  let inPermission = false

  for (const line of fmLines) {
    if (/^\s+\S/.test(line)) {
      if (inPermission) {
        const nested = line.match(/^\s+([A-Za-z_][\w-]*):\s*(.*)$/)
        const effect = nested ? asEffect(nested[2]) : undefined
        if (nested && effect) permissionMap[nested[1]] = effect
      }
      continue
    }
    inPermission = false
    const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/)
    if (!kv) continue
    const key = kv[1]
    const value = stripQuotes(kv[2])
    if (key === "permission") {
      inPermission = true
      continue
    }
    // `tools:` (Claude-style `[Read, Glob]`) and `permissionMode:` are Claude
    // Code artifacts opencode never interpreted; they are intentionally ignored.
    scalars[key] = value
  }

  const mode = MODES.has(scalars.mode) ? (scalars.mode as AgentRecord["mode"]) : "subagent"
  const steps = Number(scalars.steps)
  const rawModel = scalars.model ?? ""
  const model = /^[^\s/#]+\/[^\s#]+(#\S+)?$/.test(rawModel) ? rawModel : undefined
  const color = /^#[0-9a-fA-F]{6}$/.test(scalars.color ?? "") ? scalars.color : undefined

  const permissions: PermissionRule[] = Object.entries(permissionMap).map(([verb, effect]) => ({
    action: V2_ACTION[verb] ?? verb,
    resource: "*",
    effect,
  }))

  return {
    id: scalars.name || fallbackId,
    description: scalars.description || undefined,
    mode,
    steps: Number.isFinite(steps) && steps > 0 ? steps : undefined,
    model,
    color,
    hidden: scalars.hidden === "true" ? true : undefined,
    system: body.trim(),
    permissions,
    permissionMap,
  }
}

/** All `*.md` agents in `dir`, sorted by filename for a stable order. */
export function readAgentRecords(dir: string): AgentRecord[] {
  if (!dir || !existsSync(dir)) return []
  const out: AgentRecord[] = []
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
    out.push(parseAgent(raw, entry.replace(/\.md$/, "")))
  }
  return out
}

/**
 * V2: create each agent through `ctx.agent.transform`'s editor. `update` on an
 * absent id inserts a default agent, then the callback mutates it. Duplicate ids
 * are skipped (transforms replay). Rules are appended, so the runtime defaults
 * (including the `read *.env -> ask` guards) survive.
 *
 * Synchronous on purpose: V2 transforms must edit domain state synchronously.
 */
export function registerAgentDirV2(editor: any, dir: string): number {
  let registered = 0
  for (const rec of readAgentRecords(dir)) {
    try {
      if (editor.get(rec.id)) continue
      editor.update(rec.id, (agent: any) => {
        agent.name = rec.id
        if (rec.description) agent.description = rec.description
        agent.mode = rec.mode
        if (rec.steps) agent.steps = rec.steps
        if (rec.color) agent.color = rec.color
        if (rec.hidden) agent.hidden = true
        if (rec.model) {
          const m = rec.model.match(/^([^/]+)\/(.+?)(?:#(.+))?$/)
          if (m) agent.model = { providerID: m[1], id: m[2], ...(m[3] ? { variant: m[3] } : {}) }
        }
        agent.system = rec.system
        for (const rule of rec.permissions) agent.permissions.push(rule)
      })
      registered++
    } catch {
      // already registered, or rejected by the host — skip
    }
  }
  return registered
}

/**
 * V1: register the same agents inline on the config hook's `agent` map. V1 has
 * no create-by-update, and `{ file }` entries make V1 parse (and validate) the
 * file's frontmatter, so the definition is built here instead. Permission verbs
 * V1's schema does not model are expressed as `tools: { <verb>: false }` when
 * the effect is `deny` (V1's `tools` map is open-ended); `allow`/`ask` for those
 * verbs fall back to V1's defaults.
 */
export function registerAgentDirV1(config: any, dir: string): number {
  if (!config) return 0
  const agents = ((config as any).agent ??= {}) as Record<string, unknown>
  let registered = 0
  for (const rec of readAgentRecords(dir)) {
    if (agents[rec.id]) continue
    const entry: Record<string, unknown> = { mode: rec.mode }
    if (rec.description) entry.description = rec.description
    if (rec.system) entry.prompt = rec.system
    if (rec.steps) entry.maxSteps = rec.steps
    if (rec.model) entry.model = rec.model
    if (rec.color) entry.color = rec.color
    if (rec.hidden) entry.disable = true

    const permission: Record<string, PermissionEffect> = {}
    const tools: Record<string, boolean> = {}
    for (const [verb, effect] of Object.entries(rec.permissionMap)) {
      if (V1_PERMISSION.has(verb)) permission[verb] = effect
      else if (effect === "deny") tools[verb] = false
    }
    if (Object.keys(permission).length) entry.permission = permission
    if (Object.keys(tools).length) entry.tools = tools

    agents[rec.id] = entry
    registered++
  }
  return registered
}
