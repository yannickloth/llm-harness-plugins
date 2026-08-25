import { dirname } from "path"
import { fileURLToPath } from "url"

/**
 * Resolve the directory containing the calling module.
 *
 * `import.meta.dir` (Bun-specific) is `undefined` in some plugin load
 * contexts — notably when opencode loads plugins inside an `opencode run`
 * subprocess spawned by another plugin. Calling `path.join(undefined, ...)`
 * then throws `"The 'paths[0]' property must be of type string, got
 * undefined"`, which fails the whole plugin load.
 *
 * `import.meta.url` is standard ESM and is always populated, so derive the
 * directory from it via `fileURLToPath`. Fall back to `import.meta.dir` only
 * when `import.meta.url` is unavailable (e.g. bundled to CJS).
 */
export function moduleDir(metaUrl?: string, metaDir?: string): string {
  if (metaUrl && metaUrl.startsWith("file:")) {
    try {
      return dirname(fileURLToPath(metaUrl))
    } catch {
      // fall through to the Bun-specific field
    }
  }
  if (metaDir) return metaDir
  throw new Error("Cannot resolve module directory: no import.meta.url or import.meta.dir")
}
