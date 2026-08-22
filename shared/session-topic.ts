/**
 * Shared session-topic classifier for plugin context injection.
 *
 * Problem: project plugins (datetime-inject, agentfeed, semantic-cache,
 * offpeak-nudge, agentmem) prepend project-specific context to every user
 * message, even when the user is asking a personal, non-coding question.
 *
 * Solution: plugins consult this module before injecting. A session is only
 * treated as a project session when the conversation actually looks project-
 * related. Once classified as "project" it stays project; personal/unknown
 * sessions are left alone.
 */

export type SessionTopic = "project" | "personal" | "unknown"

const topics = new Map<string, SessionTopic>()

const PROJECT_MARKERS = [
  // Code / tooling / repo operations
  /\b(?:file|files|path|folder|directory|repo|repository|commit|branch|git|build|test|tests|bug|fix|refactor|code|function|class|module|package|import|export|debug|deploy|CI|CD|docker|makefile|readme|ts|js|java|py|go|rs|tsx|jsx|kt|swift|c|cpp|h|hpp)\b/i,
  // Coordination / plugin jargon
  /\b(?:coord_|agentfeed|ledger|session|task|claim|resource|release|handoff|heartbeat|coord_log|build:)\b/i,
  // Skills / pipelines known to be project-only
  /\b(?:integrate-topic|review-convergence|full-document-review|synthesize-document|formalization-pipeline|medication-differential-analysis|svg-illustration-pipeline|tikz-illustration-pipeline|split-chapter|pipeline-governor)\b/i,
  // File paths with extensions
  /(?:\/|\\)[a-zA-Z0-9_\-.\/\\]+\.(?:ts|js|java|py|go|rs|md|json|yaml|yml|toml|sh|dockerfile)\b/i,
]

const PERSONAL_MARKERS = [
  // French
  /\b(?:je|tu|il|elle|nous|vous|ils|elles|ma|ta|sa|mon|ton|son|femme|mari|enfant|sommeil|matelas|mal|dos|question|pourquoi|comment|bonjour|merci|oui|non|s'il|chez|avec|sans|maison|travail|vie|temps|argent|jour|nuit)\b/i,
  // German
  /\b(?:ich|du|er|sie|es|wir|ihr|mein|dein|sein|frau|mann|kind|schlaf|matratze|rücken|frage|warum|wie|danke|ja|nein|mit|ohne|haus|arbeit|leben|zeit|geld|tag|nacht)\b/i,
  // Spanish
  /\b(?:yo|tú|él|ella|nosotros|vosotros|ellos|ellas|mi|tu|su|mujer|marido|hijo|hija|sueño|colchón|dolor|espalda|pregunta|por qué|cómo|hola|gracias|sí|no|con|sin|casa|trabajo|vida|tiempo|dinero|día|noche)\b/i,
  // Italian
  /\b(?:io|tu|lui|lei|noi|voi|loro|mio|tuo|suo|moglie|marito|figlio|figlia|sonno|materasso|male|schiena|domanda|perché|come|ciao|grazie|sì|no|con|senza|casa|lavoro|vita|tempo|soldi|giorno|notte)\b/i,
]

export function classifyTopic(text: string): SessionTopic {
  const lower = text.toLowerCase()
  if (PROJECT_MARKERS.some(re => re.test(lower))) return "project"
  if (PERSONAL_MARKERS.some(re => re.test(lower))) return "personal"
  return "unknown"
}

/**
 * Update a session's topic from a new user message.
 * Project is sticky: once a session is classified as project, it stays project.
 */
export function updateSessionTopic(sessionID: string, text: string): SessionTopic {
  const current = topics.get(sessionID) ?? "unknown"
  if (current === "project") return "project"
  const detected = classifyTopic(text)
  if (detected === "project") {
    topics.set(sessionID, "project")
    return "project"
  }
  if (detected === "personal") {
    topics.set(sessionID, "personal")
    return "personal"
  }
  return current
}

export function getSessionTopic(sessionID: string): SessionTopic {
  return topics.get(sessionID) ?? "unknown"
}

export function setSessionTopic(sessionID: string, topic: SessionTopic): void {
  topics.set(sessionID, topic)
}

export function clearSessionTopic(sessionID: string): void {
  topics.delete(sessionID)
}

/**
 * Plugins call this before injecting project context.
 * Default is conservative: only inject when the session is explicitly project.
 * Unknown and personal sessions are left alone.
 */
export function shouldInjectProjectContext(sessionID: string): boolean {
  return getSessionTopic(sessionID) === "project"
}
