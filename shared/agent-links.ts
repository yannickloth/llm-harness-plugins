import fs from "fs"
import path from "path"

/**
 * Shared helpers for making a plugin's `agents/*.md` discoverable.
 *
 * WHY THIS EXISTS
 * --------------
 * OpenCode does not scan `<plugin>/agents/` for agents. A plugin that spawns
 * `opencode run --agent <name>` therefore fails with `Session.AgentNotFoundError`
 * until the name resolves. Two registration routes exist, and they differ by
 * protocol version:
 *
 *   v1 — the plugin's `config` hook may mutate `config.agent`. `agentConfigEntries()`
 *        builds the records for that hook.
 *   v2 — native creation is NOT available: `ctx.agent` exposes `update`/`remove`
 *        but no `add`, so a plugin cannot introduce a new agent through the
 *        context. The supported route is instead the global agent *directory*
 *        (`~/.config/opencode/agent`), which every version in use discovers.
 *        `ensureAgentLinks()` materialises that for a plugin, idempotently.
 *
 * A symlink (not a copy) is used so the plugin file stays the single source of
 * truth: editing an agent's frontmatter takes effect with no re-run. This mirrors
 * `install-agents.sh`, which does the same for an explicit allowlist.
 *
 * This module replaces the ad-hoc duplication of these rules in individual
 * plugins (e.g. the local `agentFiles()` in `context-toolkit`).
 *
 * Verify:
 *   bun test shared/agent-links.test.ts
 *   bun -e 'import {ensureAgentLinks} from "./shared/agent-links.ts"; console.log(ensureAgentLinks("./scientific-writing/agents", undefined, {dryRun:true}))'
 *
 * Semantics: pure helpers + one idempotent filesystem function. Never
 * overwrites a real file; prunes only symlinks that point back into `dir`.
 * No warn/strict modes — callers decide how to log the returned summary.
 */

export interface AgentFile {
  /** Agent name = filename without `.md`. */
  name: string
  /** Absolute or caller-relative path to the agent markdown file. */
  file: string
}

export interface AgentMeta {
  name?: string
  description?: string
  model?: string
  mode?: string
}

export interface LinkResult {
  created: string[]
  kept: string[]
  removed: string[]
  /** Names whose destination is a real file (never touched). */
  skipped: string[]
  dryRun: boolean
  destDir: string
}

/** List `*.md` files in an agents directory. Missing directory → empty list. */
export function agentFiles(dir: string): AgentFile[] {
  if (!dir || !fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir)
    .filter(entry => entry.endsWith(".md"))
    .sort()
    .map(entry => ({ name: entry.replace(/\.md$/, ""), file: path.join(dir, entry) }))
}

/** Directory every OpenCode version in use scans for agents. */
export function globalAgentDir(): string {
  const base = process.env.XDG_CONFIG_HOME || path.join(process.env.HOME || "", ".config")
  return path.join(base, "opencode", "agent")
}

/**
 * Read `name`, `description`, `model`, and `mode` from an agent file's YAML
 * frontmatter. Minimal on purpose: only these scalar keys are needed, and a
 * dependency-free reader avoids a YAML parser in the plugin load path.
 */
export function parseAgentMeta(raw: string): AgentMeta {
  if (!raw.startsWith("---")) return {}
  const end = raw.indexOf("\n---", 3)
  if (end < 0) return {}
  const out: AgentMeta = {}
  for (const line of raw.slice(3, end).split("\n")) {
    const m = line.match(/^(name|description|model|mode):\s*(.+)$/)
    if (!m) continue
    const value = m[2].trim().replace(/^["']|["']$/g, "")
    ;(out as Record<string, string>)[m[1]] = value
  }
  return out
}

/** The agent body without its frontmatter block (v2 `system` payload). */
export function agentBody(raw: string): string {
  return raw.replace(/^---[\s\S]*?\n---\s*\n?/, "")
}

/**
 * Records for a v1 `config`-hook `agent` map. Callers must not overwrite a
 * name the repo already declares — an explicit entry in `opencode.json` is the
 * user's override (e.g. a pinned model or reasoning effort).
 */
export function agentConfigEntries(dir: string): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {}
  for (const { name, file } of agentFiles(dir)) {
    const raw = fs.readFileSync(file, "utf8")
    const meta = parseAgentMeta(raw)
    const entry: Record<string, unknown> = {
      mode: meta.mode ?? "subagent",
      prompt: `{file:${file}}`,
    }
    // `description` is required for the agent to be enumerable as a subagent:
    // OpenCode drops frontmatter for a `{file:}` prompt reference, so it must
    // be supplied explicitly here.
    if (meta.description) entry.description = meta.description
    if (meta.model) entry.model = meta.model
    out[name] = entry
  }
  return out
}

/** Records for a v2 `ctx.agent.transform` editor. */
export function agentTransformRecords(dir: string): { name: string; description?: string; system: string }[] {
  return agentFiles(dir).map(({ name, file }) => {
    const raw = fs.readFileSync(file, "utf8")
    return { name, description: parseAgentMeta(raw).description, system: agentBody(raw) }
  })
}

/**
 * Ensure every agent in `dir` is discoverable from `destDir` by symlink.
 *
 * Idempotent and non-destructive:
 *  - an existing symlink into `dir` is kept;
 *  - a real file at the destination is never overwritten (`skipped`);
 *  - symlinks into `dir` whose source no longer exists are pruned (`removed`);
 *  - links into *other* plugins are left alone.
 */
export function ensureAgentLinks(
  dir: string,
  destDir: string = globalAgentDir(),
  opts: { dryRun?: boolean } = {},
): LinkResult {
  const res: LinkResult = { created: [], kept: [], removed: [], skipped: [], dryRun: !!opts.dryRun, destDir }
  const files = agentFiles(dir)
  if (files.length === 0) return res
  const wanted = new Set(files.map(f => `${f.name}.md`))

  if (!opts.dryRun && !fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true })

  // Prune links that point into this directory but whose source is gone.
  if (!opts.dryRun && fs.existsSync(destDir)) {
    for (const entry of fs.readdirSync(destDir)) {
      if (wanted.has(entry)) continue
      const dest = path.join(destDir, entry)
      let isLink = false
      try {
        isLink = fs.lstatSync(dest).isSymbolicLink()
      } catch {
        continue
      }
      if (!isLink) continue
      let target = ""
      try {
        target = fs.realpathSync(dest)
      } catch {
        // Broken link: remove only if it was ours.
        const raw = fs.readlinkSync(dest)
        if (path.resolve(path.dirname(dest), raw).startsWith(path.resolve(dir))) {
          fs.unlinkSync(dest)
          res.removed.push(entry)
        }
        continue
      }
      if (target.startsWith(path.resolve(dir))) {
        fs.unlinkSync(dest)
        res.removed.push(entry)
      }
    }
  }

  for (const { name, file } of files) {
    const dest = path.join(destDir, `${name}.md`)
    let exists = false
    try {
      fs.lstatSync(dest)
      exists = true
    } catch {
      exists = false
    }

    if (exists) {
      if (fs.lstatSync(dest).isSymbolicLink()) {
        let target = ""
        try {
          target = fs.realpathSync(dest)
        } catch {
          target = ""
        }
        if (target === fs.realpathSync(file)) {
          res.kept.push(name)
          continue
        }
        // Symlink into a different source: replace only if it points at this dir.
        const raw = fs.readlinkSync(dest)
        if (!path.resolve(path.dirname(dest), raw).startsWith(path.resolve(dir))) {
          res.skipped.push(name)
          continue
        }
      } else {
        res.skipped.push(name)
        continue
      }
    }

    if (!opts.dryRun) {
      try {
        if (exists) fs.unlinkSync(dest)
        fs.symlinkSync(file, dest)
      } catch {
        res.skipped.push(name)
        continue
      }
    }
    res.created.push(name)
  }

  return res
}
