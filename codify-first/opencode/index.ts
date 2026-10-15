// codify-first — injects the "codify first" directive and self-registers the
// codify-first skill pack.
//
// Dual-version entrypoint (harness idiom): `server(input)` is the v1 path,
// `setup(ctx)` the v2 path. Mapping of the v1 hooks onto v2:
//   - `config`               → skills replayed into `ctx.skill.transform`; the
//                              `codify_first` settings block arrives as
//                              `ctx.options` (v2 passes plugin options there);
//   - `chat.message`         → `ctx.session.hook("prompt")` (records the topic);
//   - `experimental.chat.system.transform` → `ctx.session.hook("context")`
//     (v2 hands the system prompt as `event.system` — same shape
//     datetime-inject's v2 port uses).
import type { Config, Plugin } from "@opencode-ai/plugin"
import { createLogger } from "../../shared/plugin-logger"
import { moduleDir } from "../../shared/module-dir"
import { writeLoadCanary } from "../../shared/load-canary"
import { registerSkillDir } from "../../shared/v2-skills"
import { updateSessionTopic, getSessionTopic } from "../../shared/session-topic"
import fs from "fs"
import path from "path"
import { CODIFY_FIRST_MARKER, CODIFY_FIRST_DIRECTIVE } from "./directive"

const skillsDir = path.resolve(moduleDir(import.meta.url, import.meta.dir), "..", "skills")

type CodifyFirstOptions = {
  /** Master switch (default true). */
  enabled?: boolean
  /**
   * If true (default), the directive is only injected into sessions classified
   * as project-related (or not yet classified). Personal sessions are left
   * alone.
   */
  topicGate?: boolean
}

type CodifyFirstSettings = Required<CodifyFirstOptions>

function skillCount(dir: string): number {
  if (!fs.existsSync(dir)) return 0
  return fs
    .readdirSync(dir)
    .filter(entry => {
      const d = path.join(dir, entry)
      return fs.statSync(d).isDirectory() && fs.existsSync(path.join(d, "SKILL.md"))
    }).length
}

// ---------------------------------------------------------------------------
// v1 entrypoint.
// ---------------------------------------------------------------------------
const v1Factory: Plugin = async (
  { client }: Parameters<Plugin>[0],
  options: CodifyFirstOptions = {},
) => {
  writeLoadCanary("codify-first")
  const logger = createLogger(client, "codify-first")
  // Constructor options are the defaults; the `codify_first` key in
  // opencode.json (read in the config hook below) overrides them.
  const settings: CodifyFirstSettings = {
    enabled: options.enabled ?? true,
    topicGate: options.topicGate ?? true,
  }
  const count = skillCount(skillsDir)

  logger.info(`plugin active — directive: ${settings.enabled}; topic gate: ${settings.topicGate}; skill self-registration (${count} skills in ${skillsDir})`)

  return {
    config: async (input: Config) => {
      const cfg = (input as any).codify_first ?? (input as any).codifyFirst
      if (cfg && typeof cfg === "object") {
        if (typeof cfg.enabled === "boolean") settings.enabled = cfg.enabled
        if (typeof cfg.topicGate === "boolean") settings.topicGate = cfg.topicGate
        logger.info(`config codify_first applied — directive: ${settings.enabled}; topic gate: ${settings.topicGate}`)
      }
      const skills = (input as any).skills ?? {}
      const paths: string[] = Array.isArray(skills.paths) ? [...skills.paths] : []
      if (count > 0 && !paths.includes(skillsDir)) paths.push(skillsDir)
      ;(input as any).skills = { ...skills, paths }
    },

    "chat.message": async (
      input: { sessionID: string },
      output: { parts: Array<{ type: string; text: string }> },
    ) => {
      if (!settings.topicGate) return
      const textPart = output.parts.find(p => p.type === "text")
      if (!textPart || !textPart.text.trim()) return
      updateSessionTopic(input.sessionID, textPart.text)
    },

    "experimental.chat.system.transform": async (
      input: { sessionID?: string },
      output: { system: string[] },
    ) => {
      if (!settings.enabled) return
      // The system prompt is built before the first user message is
      // classified, so only suppress when the session is explicitly personal.
      const sid = (input as any).sessionID
      if (settings.topicGate && sid && getSessionTopic(sid) === "personal") return
      if (output.system.some(s => s.includes(CODIFY_FIRST_MARKER))) return
      output.system = [...output.system, CODIFY_FIRST_DIRECTIVE]
    },
  }
}

// ---------------------------------------------------------------------------
// v2 entrypoint.
// ---------------------------------------------------------------------------
export default {
  id: "codify-first",

  async setup(ctx: any) {
    writeLoadCanary("codify-first")
    const options = (ctx.options ?? {}) as CodifyFirstOptions
    const settings: CodifyFirstSettings = {
      enabled: options.enabled ?? true,
      topicGate: options.topicGate ?? true,
    }

    await ctx.skill.transform((editor: any) => registerSkillDir(editor, skillsDir))

    await ctx.session.hook("prompt", (event: any) => {
      if (!settings.topicGate) return
      const text: string | undefined = event?.prompt?.text
      if (!text || !text.trim()) return
      updateSessionTopic(event.sessionID, text)
    })

    await ctx.session.hook("context", (event: any) => {
      if (!settings.enabled) return
      const sid: string | undefined = event?.sessionID
      if (settings.topicGate && sid && getSessionTopic(sid) === "personal") return
      const parts: Array<{ type: string; text: string }> = Array.isArray(event.system) ? event.system : []
      if (parts.some(p => (p.text ?? "").includes(CODIFY_FIRST_MARKER))) return
      if (Array.isArray(event.system)) event.system.push({ type: "text", text: CODIFY_FIRST_DIRECTIVE })
    })
  },

  async server(input: any, options?: any) {
    return v1Factory(input, options)
  },
}
