import type { LedgerEntry, ResourceKind } from "./ledger"

/**
 * Pure logic for deriving auto-published "resource" events from tool calls.
 * Detects shared-resource activity (git operations, file edits) that agents
 * should record without thinking to, so others can avoid conflicts and know
 * where to look. Separated from hook wiring for testability (IVP: detection
 * logic vs orchestration).
 */

export type ToolCall = {
  tool: string
  args?: Record<string, unknown>
}

/** A candidate auto-event derived from a tool call, or null if not one. */
export type Activity = {
  resource: ResourceKind
  file: string
  detail: string
  /** git ref/branch the op touches (best-effort); undefined for non-git ops. */
  ref?: string
}

export function detectActivity(call: ToolCall): Activity | null {
  if (call.tool === "bash") {
    const cmd = argString(call.args?.command)
    if (cmd) {
      const op = gitOp(cmd)
      if (op) return { resource: "git", file: "", detail: `git ${op}`, ref: gitRef(cmd) }
    }
    return null
  }
  if (call.tool === "edit" || call.tool === "write") {
    const file = argString(call.args?.filePath) || argString(call.args?.path)
    if (file) return { resource: "file", file, detail: call.tool }
    return null
  }
  return null
}

// A mutating git operation. Accepts an optional `-C <dir>` (and `--git-dir=…`)
// between `git` and the op, since `git -C /repo commit` is a common shared-repo
// invocation. The op must be a word-boundary-delimited mutating subcommand.
const GIT_OPS = /(?:^|[\s&;|])(?:git)(?:\s+)(?:(?:-C\s+\S+|--git-dir=\S+)\s+)*(merge|commit|checkout|push|pull|rebase|branch|stash|reset|revert|switch|restore)(?:\s|$)/g

/**
 * Find the first *mutating* git operation actually invoked in a command.
 * Uses the same match that GIT_OPS accepts, so it cannot disagree (avoids
 * grabbing a stray "git <token>" inside quotes or a non-mutating op like
 * "git log"). Returns the op token or null.
 */
function gitOp(cmd: string): string | null {
  GIT_OPS.lastIndex = 0
  const m = GIT_OPS.exec(cmd)
  return m ? m[1] : null
}

/**
 * Best-effort extraction of the git ref/branch an op targets, e.g. the branch in
 * `git push origin main` / `git checkout feat` / `git merge main` / `git branch new`.
 * Only branch-targeting ops are considered; flags and their values are skipped.
 * For push/pull/fetch the target is the branch after the remote (`origin main` → `main`).
 * Returns undefined when not clearly identifiable (commit/revert/restore/stash, a
 * leading flag, or no positional branch token).
 */
const REMOTE_REFS = new Set(["push", "pull", "fetch"])
const NO_REF = new Set(["commit", "reset", "revert", "restore", "stash"])
// `-b`/`-B` name a new branch for checkout/switch — their value IS the ref target.
const CAPTURE_BRANCH = new Set(["-b", "-B", "--branch"])
// Flags that consume a following value, so that value is not mistaken for a branch.
const VALUE_FLAGS = new Set(["-u", "-o", "-m", "-t", "--set-upstream", "--track", "--onto", "--abbrev", "--output", "--stdin"])
function gitRef(cmd: string): string | undefined {
  const m = gitOpMatch(cmd)
  if (!m) return undefined
  const op = m[1]
  if (NO_REF.has(op)) return undefined
  const rest = cmd.slice(m.index + m[0].length).trim()
  const tokens = rest.split(/\s+/).filter(Boolean)
  const positional: string[] = []
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    if (t.startsWith("-")) {
      if (CAPTURE_BRANCH.has(t) && i + 1 < tokens.length) {
        positional.push(tokens[i + 1]) // e.g. `checkout -b feat` → feat
        i++
      } else if (VALUE_FLAGS.has(t) && i + 1 < tokens.length) {
        i++ // skip the flag's value (e.g. -u origin)
      }
      continue
    }
    positional.push(t)
  }
  if (positional.length === 0) return undefined
  // remote ops: branch is the last positional (after the remote)
  const candidate = REMOTE_REFS.has(op) ? positional[positional.length - 1] : positional[0]
  // a branch-like ref only (not a file path like src/a.ts, not a remote URL)
  if (!/^[a-zA-Z0-9_./-]+$/.test(candidate)) return undefined
  if (candidate.includes("/") && candidate.split("/").length > 2) return undefined // looks like a path
  return candidate.replace(/['";)&,]+$/g, "")
}

/** Re-run the git op regex to locate the match span (lastIndex already reset). */
function gitOpMatch(cmd: string): RegExpExecArray | null {
  GIT_OPS.lastIndex = 0
  return GIT_OPS.exec(cmd)
}

function argString(v: unknown): string {
  return typeof v === "string" ? v.trim() : ""
}

/**
 * Build a ledger resource entry from detected activity. Auto-detected ops are the
 * *start* of resource use — marked `action: "acquire"` so others can later see the
 * matching release (free). `ref` (git branch) rides along when identifiable.
 */
export function resourceEntry(agent: string, a: Activity): Omit<LedgerEntry, "id" | "host" | "seq" | "ts"> {
  return {
    agent,
    type: "resource",
    resource: a.resource,
    file: a.file || undefined,
    ref: a.ref,
    action: "acquire",
    task: a.detail,
  }
}

/**
 * Coalescing key for a resource event — same agent touching the same resource
 * within a short window should not flood the ledger. For files the path is the
 * resource; for git the specific operation (commit vs push) is, so distinct
 * actions by one agent are not masked by an earlier one. Git ref (branch) is
 * folded in so switching branches is not collapsed with the prior one.
 */
export function coalesceKey(agent: string, a: Activity): string {
  const resource = a.resource === "git" ? `${a.detail}${a.ref ? `@${a.ref}` : ""}` : a.file
  return `${agent}|${a.resource}|${resource}`
}
