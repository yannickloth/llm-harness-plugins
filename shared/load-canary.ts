import { mkdirSync, writeFileSync } from "fs"
import { join } from "path"

/**
 * Load canary — verifiable proof that a plugin actually loaded.
 *
 * A plugin that fails to load (a bad path in `opencode.json`, a TS import
 * error, an opencode plugin-API change) disappears silently: the session
 * runs without its guardrails and nothing fails. Logging "plugin active"
 * only helps someone who already suspects the problem. Inspired by the
 * SessionStart canary in ~/code/polaris (canario_muro.sh): write a marker,
 * let an out-of-harness checker fail closed on its absence.
 *
 * The marker is written only when both `LLMHP_CANARY_DIR` and
 * `LLMHP_CANARY_NONCE` are set — i.e. only under `shared/canary_preflight.sh`.
 * Interactive sessions never set them, so this is a no-op in normal use,
 * and a marker's nonce-prefixed name proves which probe produced it.
 *
 * Like logging, the canary must never break plugin behavior: any filesystem
 * error is swallowed.
 */
export function writeLoadCanary(pluginId: string): void {
  const dir = process.env.LLMHP_CANARY_DIR
  const nonce = process.env.LLMHP_CANARY_NONCE
  if (!dir || !nonce || !pluginId) return
  try {
    mkdirSync(dir, { recursive: true })
    // Token 1 is epoch ms (human debugging). Token 2 is performance.now(): a
    // monotonic, sub-millisecond clock comparable across all plugins of one
    // probe process — Date.now() ties within the same millisecond (observed
    // with 4 plugins), which would make order verification vacuous. The nonce
    // in the filename scopes the file to one preflight probe.
    writeFileSync(
      join(dir, `${nonce}.${pluginId}.testigo`),
      `${Date.now()} ${performance.now()} ${process.pid}\n`,
    )
  } catch {
    // marker is best-effort by design
  }
}
