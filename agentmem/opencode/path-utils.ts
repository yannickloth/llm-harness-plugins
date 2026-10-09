import path from "path"

/**
 * Check that `absPath` is inside `root`.
 *
 * Kept in a separate module (not the plugin entry `index.ts`) on purpose:
 * opencode's legacy plugin loader treats every top-level function export of a
 * plugin entry as a plugin factory and calls it with `(input, options)`. If
 * this lived in `index.ts`, the loader would call `isInRoot(input, options)`,
 * which does `path.resolve(root)` on the options object and throws
 * `The "paths[0]" property must be of type string, got undefined`, making the
 * whole plugin fail to load.
 */
export function isInRoot(absPath: string, root: string): boolean {
  const normalizedRoot = path.resolve(root)
  const normalized = path.resolve(absPath)
  return normalized === normalizedRoot || normalized.startsWith(normalizedRoot + (normalizedRoot === path.sep ? "" : path.sep))
}
