// structured-compaction — per-repo migration plugin.
//
// On first load for a given project, reads that project's opencode.json,
// adds the structured compaction config (Belcak et al., "You don't need long
// context", 2026) if it is not already present, writes it back, and shows a
// one-shot toast.  Subsequent loads for the same project are no-ops because
// the config is now in the file.
//
// Dual-version entrypoint: server(input) for v1, setup(ctx) for v2.
import type { Plugin } from "@opencode-ai/plugin"
import { writeFileSync, readFileSync, existsSync } from "node:fs"
import { resolve } from "node:path"
import { createLogger } from "../../shared/plugin-logger"
import { writeLoadCanary } from "../../shared/load-canary"

// ---------------------------------------------------------------------------
// The config we inject.
// ---------------------------------------------------------------------------

const AGENTS_SUMMARY = {
  model: "deepseek/deepseek-flash",
  prompt: [
    "Provide a forward-looking handoff brief for continuing this task. Focus on what matters for the next action, not a summary of everything that happened.",
    "",
    "Include these sections:",
    "",
    "1. TASK: The original objective or goal",
    "2. CURRENT STATE: What is being worked on right now",
    "3. COMPLETED: Actions already taken, files modified, changes made",
    "4. NEXT STEPS: What should happen immediately next",
    "5. KNOWN ISSUES: Errors, blockers, or things that need attention",
    "6. ARTIFACTS: File paths, commands, outputs that are relevant going forward",
    "7. SEARCH HINTS: Keywords or patterns that would help retrieve older conversation turns if needed",
    "",
    "Keep it concise. Omit irrelevant details.",
  ].join("\n"),
}

const COMPACTION_CONFIG = {
  auto: true,
  preserve_recent_tokens: 2048,
  tail_turns: 3,
  prune: true,
}

// ---------------------------------------------------------------------------
// Core migration logic — shared by v1 and v2 entrypoints.
// ---------------------------------------------------------------------------

function migrateIfMissing(configPath: string): boolean {
  if (!existsSync(configPath)) {
    return false
  }

  const raw = readFileSync(configPath, "utf-8")
  const cfg: Record<string, unknown> = JSON.parse(raw)

  // Already configured? Nothing to do.
  const agents = (cfg.agents as Record<string, unknown>) ?? {}
  const summary = (agents.summary as Record<string, unknown>) ?? {}
  const compaction = (cfg.compaction as Record<string, unknown>) ?? {}

  if (summary.model && compaction.auto !== undefined) {
    return false
  }

  if (!cfg.agents) {
    cfg.agents = {}
  }
  cfg.agents.summary = AGENTS_SUMMARY

  if (!cfg.compaction) {
    cfg.compaction = {}
  }
  Object.assign(cfg.compaction, COMPACTION_CONFIG)

  writeFileSync(configPath, JSON.stringify(cfg, null, 2) + "\n", "utf-8")
  return true
}

// ---------------------------------------------------------------------------
// v1 entrypoint.
// ---------------------------------------------------------------------------

const v1Factory: Plugin = async ({ client, directory, worktree }) => {
  writeLoadCanary("structured-compaction")
  const logger = createLogger(client, "structured-compaction")

  // Prefer worktree (shared workspace), fall back to session directory.
  const configPath = resolve(worktree ?? directory ?? ".", "opencode.json")
  logger.info(`checking config at ${configPath}`)

  const migrated = migrateIfMissing(configPath)

  if (migrated) {
    logger.info("migration applied")
    try {
      await client.tui.showToast({
        body: {
          title: "Structured Compaction",
          message:
            "Added forward-looking brief template and compaction settings to opencode.json.",
          variant: "info",
          duration: 8000,
        },
      })
    } catch {
      logger.info("toast failed after migration")
    }
  } else {
    logger.info("config already present — no migration needed")
  }

  return {}
}

// ---------------------------------------------------------------------------
// v2 entrypoint.
// ---------------------------------------------------------------------------

const setupV2 = async (ctx: {
  options: Record<string, unknown>
  location: { directory: string; project?: { canonical: string } }
  tui?: {
    showToast: (msg: { body: { title: string; message: string; variant: string; duration: number } }) => Promise<unknown>
  }
}) => {
  writeLoadCanary("structured-compaction")
  const projectPath = ctx.location?.project?.canonical ?? ctx.location?.directory
  const configPath = resolve(projectPath, "opencode.json")

  const migrated = migrateIfMissing(configPath)

  if (migrated) {
    try {
      await ctx.tui?.showToast({
        body: {
          title: "Structured Compaction",
          message:
            "Added forward-looking brief template and compaction settings to opencode.json.",
          variant: "info",
          duration: 8000,
        },
      })
    } catch {
      // Best-effort toast.
    }
  }
}

// ---------------------------------------------------------------------------
// Default export: serves both v1 (via `server`) and v2 (via `setup`).
// ---------------------------------------------------------------------------

export default {
  id: "structured-compaction",
  setup: setupV2,
  server: v1Factory,
}
