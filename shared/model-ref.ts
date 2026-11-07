/**
 * The `provider/model[#variant]` reference — one definition, one amendment unit.
 *
 * This grammar is shared by the agent registry (`Agent.Info.model`) and the
 * command registry (`CommandV2Info.model`). It is both a change driver in its own
 * right and, when OpenCode defines it once, a single unit that both registries
 * reference. Keeping three inline copies (as this module once did) makes a format
 * change silently partial: one copy updates, the others keep parsing the old form.
 *
 * `parseModelRef` is the strict reader: it returns `undefined` for anything that
 * is not a full reference, which is what the agent registry needs (a bare alias
 * must be dropped, not passed through).
 */

export interface ModelRef {
  providerID: string
  id: string
  variant?: string
}

/** `provider/model[#variant]`. Rejects a bare alias (`sonnet`) and an empty id. */
const MODEL_REF = /^([^\s/#]+)\/(.+?)(?:#(\S+))?$/

/** Parse a model reference. Returns `undefined` when `raw` is not one. */
export function parseModelRef(raw: string | undefined | null): ModelRef | undefined {
  if (!raw) return undefined
  const m = raw.trim().match(MODEL_REF)
  if (!m) return undefined
  return { providerID: m[1], id: m[2], ...(m[3] ? { variant: m[3] } : {}) }
}

/** True when `raw` is a well-formed model reference. */
export function isModelRef(raw: string | undefined | null): boolean {
  return parseModelRef(raw) !== undefined
}
