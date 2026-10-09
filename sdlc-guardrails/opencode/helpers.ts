/**
 * Extract a file path from a tool's arguments.
 *
 * Kept in a separate module (not the plugin entry `index.ts`) on purpose:
 * opencode's legacy plugin loader treats every top-level function export of a
 * plugin entry as a plugin factory and calls it with `(input, options)`. If
 * this lived in `index.ts`, the loader would call `extractFilePath(input)`,
 * which reads string fields off the plugin input object, so it would not throw
 * — but exporting it would still be a latent hazard and inconsistent with the
 * one-factory-per-entry rule.
 */
export function extractFilePath(args: Record<string, unknown>): string | null {
  if (typeof args.filePath === "string" && args.filePath) return args.filePath
  if (typeof args.file_path === "string" && args.file_path) return args.file_path
  if (typeof args.path === "string" && args.path) return args.path
  if (typeof args.file === "string" && args.file) return args.file
  return null
}
