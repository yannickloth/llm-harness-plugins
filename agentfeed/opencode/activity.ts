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
}

export function detectActivity(call: ToolCall): Activity | null {
  if (call.tool === "bash") {
    const cmd = argString(call.args?.command)
    if (cmd) {
      const op = gitOp(cmd)
      if (op) return { resource: "git", file: "", detail: `git ${op}` }
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

function argString(v: unknown): string {
  return typeof v === "string" ? v.trim() : ""
}

/**
 * Build a ledger resource entry from detected activity.
 */
export function resourceEntry(agent: string, a: Activity): Omit<LedgerEntry, "id" | "host" | "seq" | "ts"> {
  return {
    agent,
    type: "resource",
    resource: a.resource,
    file: a.file || undefined,
    task: a.detail,
  }
}

/**
 * Coalescing key for a resource event — same agent touching the same resource
 * within a short window should not flood the ledger. For files the path is the
 * resource; for git the specific operation (commit vs push) is, so distinct
 * actions by one agent are not masked by an earlier one.
 */
export function coalesceKey(agent: string, a: Activity): string {
  const resource = a.resource === "git" ? a.detail : a.file
  return `${agent}|${a.resource}|${resource}`
}
