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
  planForPrompt,
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
  /** Skill name → providerID: skills whose execution runs on a plan-bearing
   *  provider. Skills without a mapping are not provider-attributed. */
  skillProviders?: Record<string, string>
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
  zai: "Z.AI",
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
  const weekdayNote = plan.peakWeekdaysOnly
    ? ` Peak windows apply Monday–Friday only in UTC${(plan.peakTimezoneOffsetHours ?? 0) >= 0 ? "+" : ""}${plan.peakTimezoneOffsetHours ?? 0}.`
    : ""
  return `${NUDGE_MARKER}
${provider} uses peak/off-peak time-of-day pricing. Off-peak hours are ${Math.round((1 - ratio) * 100)}% cheaper than peak.
Peak windows (UTC): ${peak}.${weekendNote}${weekdayNote}
During OFF-PEAK: run heavy tasks unconditionally — price is low, no confirmation needed.
During PEAK: a heavy task must NOT be run by default. Ask the user for explicit
confirmation before running it. If the user does not confirm, do not run. Do not
repeat the reminder if it was already shown earlier this peak window.`
}

type AgentEntry = { name: string; model?: { providerID?: string } }

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
  const skillProviders = options.skillProviders ?? undefined

  /** providerID (lowercase) → plan, for every configured time-of-day plan. */
  const planIndex = (): Map<string, PricingPlan> => {
    const all = plans ?? DEFAULT_PRICING_PLANS
    return new Map(
      all.filter(p => p.timeOfDay).map(p => [p.providerID.toLowerCase(), p]),
    )
  }

  // Agent names per plan provider, resolved once from the opencode API
  // (agent .md frontmatter / opencode.json `agent` entries carry `model`).
  let agentNamesByProvider: Record<string, string[]> | null = null
  const loadAgentNames = async (): Promise<Record<string, string[]>> => {
    if (agentNamesByProvider) return agentNamesByProvider
    const byProvider: Record<string, string[]> = {}
    try {
      const res = await (client as { app?: { agents?: (o?: unknown) => Promise<unknown> } })
        ?.app?.agents?.({ query: { directory: worktree ?? directory } })
      const agents = ((res as { data?: unknown })?.data ?? res) as AgentEntry[] | undefined
      for (const a of agents ?? []) {
        const prov = a.model?.providerID
        if (!prov) continue
        ;(byProvider[prov.toLowerCase()] ??= []).push(a.name)
      }
    } catch {
      // agent resolution is best-effort; nudges still work via primary provider
    }
    agentNamesByProvider = byProvider
    return byProvider
  }

  /** Plan for the primary session model, or — when the task invokes an
   *  agent/skill bound to a plan-bearing provider — that provider's plan. */
  const resolvePlan = async (
    providerID: string | undefined,
    text: string,
  ): Promise<{ plan: PricingPlan; provider: string } | undefined> => {
    const primary = providerID ? planForProvider(providerID, plans) : undefined
    if (primary) return { plan: primary, provider: providerID! }
    const promptPlan = planForPrompt(text, {
      plans,
      agentNamesByProvider: await loadAgentNames(),
      skillProviders,
    })
    if (promptPlan) return { plan: promptPlan, provider: promptPlan.providerID }
    return undefined
  }

  let lastStatus: "peak" | "offpeak" | null = null
  const countedMessages = new Set<string>()
  /** providerID (lowercase) of the last plan-bearing model seen, per session. */
  const sessionProviders = new Map<string, string>()
  let activeProvider: string | null = null

  const trackProvider = (sessionID: string | undefined, providerID: string | undefined) => {
    if (!providerID) return
    const id = providerID.toLowerCase()
    if (!planIndex().has(id)) return
    if (sessionID) sessionProviders.set(sessionID, id)
    activeProvider = id
  }

  logger.info(`plugin active — disabled: ${disabled}`)

  const showToast = async (body: { title: string; message: string; variant: "info" | "success" | "warning" | "error" }) => {
    if (disabled) return
    try {
      await client.tui.showToast({ body })
    } catch {
      // toast must never break plugin behavior
    }
  }

  const statusToastFor = (providerID: string | null) => {
    const plan = providerID ? planIndex().get(providerID) : undefined
    if (!plan) return null
    const windows = effectivePeakWindows(now(), plan)
    return buildStatusToast(now(), {
      provider: displayName(plan.providerID),
      windows,
      offPeakRatio: ratioForPlan(plan),
    })
  }

  const checkBoundary = () => {
    if (!activeProvider) return
    const plan = planIndex().get(activeProvider)
    if (!plan) return
    const windows = effectivePeakWindows(now(), plan)
    const status = pricingStatus(now(), windows)
    if (lastStatus !== null && status !== lastStatus) {
      const toast = statusToastFor(activeProvider)
      if (toast) void showToast(toast)
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
      const provider = input.model?.providerID
      const plan = provider ? planForProvider(provider, plans) : undefined
      if (!plan) return
      trackProvider(input.sessionID, provider)
      if (output.system.some(s => s.includes(NUDGE_MARKER))) return
      output.system = [systemRuleFor(plan, displayName(provider!)), ...output.system]
    },

    event: async (input: { event: { type: string; properties?: any } }) => {
      if (disabled) return
      const ev = input.event

      if (ev.type === "server.connected") {
        startBoundaryTimer()
        return
      }

      if (ev.type === "session.created") {
        // Sessions start provider-neutral; only surface pricing status once a
        // plan-bearing provider is actually in use for this session.
        const providerID =
          sessionProviders.get(ev.properties?.info?.id ?? "") ?? null
        const toast = statusToastFor(providerID)
        if (toast) void showToast(toast)
        return
      }

      if (ev.type === "session.deleted") {
        const id = ev.properties?.info?.id
        if (id) sessionProviders.delete(id)
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
        const provider = info.model?.providerID
        trackProvider(sessionID, provider)
        const plan = provider ? planForProvider(provider, plans) : undefined
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

      const providerID = input.model?.providerID
      const resolved = await resolvePlan(providerID, text)
      if (!resolved) return
      const { plan, provider } = resolved
      trackProvider(input.sessionID, providerID)

      const windows = effectivePeakWindows(nowDate, plan)
      // Off-peak: run unconditionally — never touch the user's message.
      if (!isPeakUtc(utcHourOf(nowDate), windows)) return

      // Primary model is on the plan → heavy-prompt heuristics decide.
      // Otherwise the plan was matched via an agent/skill reference, which is
      // itself the heavy signal (it bills the plan provider).
      const primaryHasPlan = providerID
        ? planForProvider(providerID, plans) !== undefined
        : false
      if (primaryHasPlan) {
        const { heavy } = isHeavyPrompt(text, heavyOpts)
        if (!heavy) return
      }

      // Peak + heavy task: keep the informational banner AND require explicit
      // user confirmation. By default the task is not run. Dedup key is
      // provider-scoped so distinct plan providers nudge independently.
      if (!shouldRemind(`${provider}:${input.sessionID}`, nowDate, statePath, windows)) return

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
