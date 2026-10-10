import type { Config, Plugin } from "@opencode-ai/plugin"
import { createLogger } from "../../shared/plugin-logger"
import { moduleDir } from "../../shared/module-dir"
import { writeLoadCanary } from "../../shared/load-canary"
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

export default async (
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
