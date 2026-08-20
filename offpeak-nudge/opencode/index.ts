import type { Plugin } from "@opencode-ai/plugin"
import {
  NUDGE_MARKER,
  buildBanner,
  isHeavyPrompt,
  shouldRemind,
  utcHourOf,
  isPeakUtc,
  type HeavyOptions,
} from "./helpers"
import { createLogger } from "../../shared/plugin-logger"

type NudgeOptions = {
  heavy?: HeavyOptions
  /** Disable the reminder entirely (default false). */
  disabled?: boolean
  /** Clock supplier (test seam). Defaults to new Date(). */
  now?: () => Date
  /** State-file path override (test seam). Defaults to $XDG_RUNTIME_DIR. */
  statePath?: string
}

const SYSTEM_RULE = `${NUDGE_MARKER}
DeepSeek uses peak/off-peak time-of-day pricing. Off-peak hours are 50% cheaper than peak.
Peak windows (UTC): 01:00–04:00 and 06:00–10:00.
When the user requests a heavy task (complex skill, many steps, long-running batch) and the
current local time is within a peak window, briefly offer the option to postpone to a
cheaper off-peak window. Show the off-peak hours. Never refuse to run the task, never block,
and do not repeat the reminder if it was already shown earlier this peak window.
The reminder is informational only — the user decides.`

export default async (
  { client, worktree, directory }: Parameters<Plugin>[0],
  options: NudgeOptions = {},
): Promise<{ [key: string]: unknown }> => {
  const logger = createLogger(client, "offpeak-nudge")
  const heavyOpts = options.heavy ?? {}
  const disabled = options.disabled ?? false
  const now = options.now ?? (() => new Date())
  const statePath = options.statePath

  logger.info(`plugin active — disabled: ${disabled}`)

  return {
    "experimental.chat.system.transform": async (
      input: { sessionID?: string; model?: unknown },
      output: { system: string[] },
    ) => {
      if (disabled) return
      if (output.system.some(s => s.includes(NUDGE_MARKER))) return
      output.system = [SYSTEM_RULE, ...output.system]
    },

    "chat.message": async (
      input: { sessionID: string },
      output: { parts: Array<{ type: string; text: string }> },
    ) => {
      if (disabled) return
      if (!input.sessionID) return
      const nowDate = now()
      if (!isPeakUtc(utcHourOf(nowDate))) return

      const textPart = output.parts.find(p => p.type === "text")
      if (!textPart || !textPart.text.trim()) return
      const { heavy } = isHeavyPrompt(textPart.text, heavyOpts)
      if (!heavy) return

      if (!shouldRemind(input.sessionID, nowDate, statePath)) return

      const banner = buildBanner(nowDate)
      textPart.text = `${banner}\n\n${textPart.text}`
    },
  }
}
