import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { z } from "zod"
import {
  NUDGE_MARKER,
  buildBanner,
  buildStatusToast,
  formatWindows,
  isHeavyPrompt,
  localOffpeakWindows,
  localPeakWindows,
  pricingStatus,
  planForProvider,
  recordSpend,
  ratioForPlan,
  shouldRemind,
  summarizeSpend,
  utcHourOf,
  isPeakUtc,
  windowsForPlan,
  effectivePeakWindows,
  DEFAULT_PRICING_PLANS,
  type HeavyOptions,
  type PricingPlan,
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
  /** Provider pricing plans. Defaults to the built-in registry (DeepSeek). */
  plans?: PricingPlan[]
  /** Interval (ms) for boundary checks. Default 60s. Test seam. */
  boundaryIntervalMs?: number
  /** Enable the boundary-timer (default true). */
  boundaryTimer?: boolean
}

// Marker used to rewrite a heavy prompt during peak so the model asks for the
// user's explicit confirmation instead of running it (default: do not run).
const CONFIRM_MARKER = "[offpeak-confirm]"

const BRAND_NAMES: Record<string, string> = {
  deepseek: "DeepSeek",
  anthropic: "Anthropic",
  openai: "OpenAI",
  openrouter: "OpenRouter",
  groq: "Groq",
}

function displayName(providerID: string): string {
  return BRAND_NAMES[providerID] ?? providerID.charAt(0).toUpperCase() + providerID.slice(1)
}

function systemRuleFor(plan: PricingPlan, provider: string): string {
  const windows = windowsForPlan(plan)
  const peak = windows.map(([s, e]) => `${s}:00–${e}:00`).join(" & ")
  const ratio = ratioForPlan(plan)
  const weekendNote = plan.weekendOffPeak
    ? ` From ${plan.weekendOffPeak.since} onward, weekends (Saturday and Sunday) in UTC${plan.weekendOffPeak.utcOffsetHours >= 0 ? "+" : ""}${plan.weekendOffPeak.utcOffsetHours} are entirely off-peak.`
    : ""
  return `${NUDGE_MARKER}
${provider} uses peak/off-peak time-of-day pricing. Off-peak hours are ${Math.round((1 - ratio) * 100)}% cheaper than peak.
Peak windows (UTC): ${peak}.${weekendNote}
During OFF-PEAK: run heavy tasks unconditionally — price is low, no confirmation needed.
During PEAK: a heavy task must NOT be run by default. Ask the user for explicit
confirmation before running it. If the user does not confirm, do not run. Do not
repeat the reminder if it was already shown earlier this peak window.`
}

export default async (
  { client, worktree, directory }: Parameters<Plugin>[0],
  options: NudgeOptions = {},
): Promise<{ [key: string]: unknown }> => {
  const logger = createLogger(client, "offpeak-nudge")
  const heavyOpts = options.heavy ?? {}
  const disabled = options.disabled ?? false
  const now = options.now ?? (() => new Date())
  const statePath = options.statePath
  const plans = options.plans ?? undefined

  const defaultTimeOfDayPlan = (): PricingPlan | undefined =>
    plans?.find(p => p.timeOfDay) ?? DEFAULT_PRICING_PLANS.find(p => p.timeOfDay)

  let lastStatus: "peak" | "offpeak" | null = null
  const countedMessages = new Set<string>()

  logger.info(`plugin active — disabled: ${disabled}`)

  const showToast = async (body: { title: string; message: string; variant: "info" | "success" | "warning" | "error" }) => {
    if (disabled) return
    try {
      await client.tui.showToast({ body })
    } catch {
      // toast must never break plugin behavior
    }
  }

  const checkBoundary = () => {
    const windows = effectivePeakWindows(now(), defaultTimeOfDayPlan())
    const status = pricingStatus(now(), windows)
    if (lastStatus !== null && status !== lastStatus) {
      showToast(buildStatusToast(now(), { provider: "" }))
    }
    lastStatus = status
  }

  const startBoundaryTimer = () => {
    if (options.boundaryTimer === false) return
    const ms = options.boundaryIntervalMs ?? 60_000
    const t = setInterval(checkBoundary, ms)
    // allow Node to keep the process alive
    t.unref?.()
  }

  return {
    tool: {
      peak_price_status: tool({
        description:
          "Returns the current time-of-day pricing status (peak or off-peak) for a provider, " +
          "with the off-peak discount ratio, the local off-peak hours and the local peak hours. " +
          "Deterministic — call this instead of guessing the pricing when a user asks whether to " +
          "postpone a heavy task.",
        args: {
          provider: z.string().optional().describe("provider id (default: deepseek)"),
        },
        async execute(args) {
          const provider = (args.provider ?? "deepseek").toLowerCase()
          const plan = planForProvider(provider, plans)
          if (!plan) {
            return `provider "${provider}" has no time-of-day pricing plan; pricing is flat.`
          }
          const windows = effectivePeakWindows(now(), plan)
          const status = pricingStatus(now(), windows)
          const ratio = ratioForPlan(plan)
          const off = formatWindows(localOffpeakWindows(now(), windows))
          const peak = formatWindows(localPeakWindows(now(), windows))
          return JSON.stringify(
            {
              provider: displayName(provider),
              status,
              offPeakRatio: ratio,
              offPeakPercentCheaper: Math.round((1 - ratio) * 100),
              offPeakHoursLocal: off,
              peakHoursLocal: peak,
            },
            null,
            2,
          )
        },
      }),
    },

    "experimental.chat.system.transform": async (
      input: { sessionID?: string; model?: { providerID?: string } },
      output: { system: string[] },
    ) => {
      if (disabled) return
      const provider = input.model?.providerID ?? "deepseek"
      const plan = planForProvider(provider, plans)
      if (!plan) return
      if (output.system.some(s => s.includes(NUDGE_MARKER))) return
      output.system = [systemRuleFor(plan, displayName(provider)), ...output.system]
    },

    event: async (input: { event: { type: string; properties?: any } }) => {
      if (disabled) return
      const ev = input.event

      if (ev.type === "server.connected") {
        checkBoundary()
        const boundaryWindows = effectivePeakWindows(now(), defaultTimeOfDayPlan())
        lastStatus = pricingStatus(now(), boundaryWindows)
        showToast(buildStatusToast(now(), { provider: "", windows: boundaryWindows }))
        startBoundaryTimer()
        return
      }

      if (ev.type === "session.created") {
        // The Session event carries no model/provider; use provider-neutral status.
        const boundaryWindows = effectivePeakWindows(now(), defaultTimeOfDayPlan())
        showToast(buildStatusToast(now(), { provider: "", windows: boundaryWindows }))
        return
      }

      if (ev.type === "session.idle") {
        const sessionID = ev.properties?.sessionID
        if (!sessionID) return
        const summary = summarizeSpend(sessionID, now(), statePath)
        if (!summary) return
        showToast({ title: "Cost summary", message: summary, variant: "info" })
        return
      }

      if (ev.type === "message.updated") {
        const info = ev.properties?.info
        if (!info || info.role !== "assistant") return
        if (typeof info.cost !== "number" || !info.tokens) return
        const sessionID = info.sessionID
        if (!sessionID) return
        // message.updated can fire multiple times per message (streaming parts);
        // count the cost exactly once per message to avoid double-counting.
        if (countedMessages.has(info.id)) return
        countedMessages.add(info.id)
        const provider = info.model?.providerID ?? "deepseek"
        const plan = planForProvider(provider, plans)
        recordSpend(
          sessionID,
          now(),
          {
            cost: info.cost,
            tokens: {
              input: info.tokens.input ?? 0,
              output: info.tokens.output ?? 0,
              cacheRead: info.tokens.cache?.read ?? 0,
            },
          },
          statePath,
          plan,
        )
        return
      }
    },

    "chat.message": async (
      input: { sessionID: string; model?: { providerID?: string } },
      output: { parts: Array<{ type: string; text: string }> },
    ) => {
      if (disabled) return
      if (!input.sessionID) return
      const nowDate = now()

      const textPart = output.parts.find(p => p.type === "text")
      if (!textPart || !textPart.text.trim()) return
      const text = textPart.text

      const provider = input.model?.providerID ?? "deepseek"
      const plan = planForProvider(provider, plans)
      if (!plan) return
      const windows = effectivePeakWindows(nowDate, plan)
      // Off-peak: run unconditionally — never touch the user's message.
      if (!isPeakUtc(utcHourOf(nowDate), windows)) return

      const { heavy } = isHeavyPrompt(text, heavyOpts)
      if (!heavy) return

      // Peak + heavy task: keep the informational banner AND require explicit
      // user confirmation. By default the task is not run.
      if (!shouldRemind(input.sessionID, nowDate, statePath, windows)) return

      const ratio = ratioForPlan(plan)
      const banner = buildBanner(nowDate, windows, displayName(provider), ratio)
      const off = formatWindows(localOffpeakWindows(nowDate, windows))
      textPart.text = `${banner}\n\n${CONFIRM_MARKER}
The user requested a heavy task during peak pricing. Do NOT run it unless the user
explicitly confirms. Ask for confirmation, showing the off-peak hours (${off}).
If the user confirms, run the task. If not, do not run it.\n\n${text}`

      showToast({
        title: `${displayName(provider)} peak`,
        message: `Heavy task detected during ${displayName(provider)} peak hours — off-peak is ${Math.round((1 - ratio) * 100)}% cheaper (off-peak: ${off}). Confirmation required before running.`,
        variant: "warning",
      })
    },
  }
}
