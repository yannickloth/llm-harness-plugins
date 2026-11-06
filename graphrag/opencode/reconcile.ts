/**
 * Standalone change detector for the GraphRAG plugin.
 *
 * The opencode hooks see only the edits opencode itself makes. This CLI finds
 * every index manifest under the given roots and reconciles each repository
 * with git, so work done in another harness (pi), an IDE, or a script still
 * marks content dirty. It never indexes: the next opencode idle, or an explicit
 * `graphrag mode=index`, still decides with preflight and the completion gate.
 *
 * Usage:
 *   bun reconcile.ts [--roots DIR[,DIR...]] [--index-root NAME] [--max-depth N] [--quiet]
 *
 * Defaults: roots = cwd, index-root = graph-index, max-depth = 5.
 * Exit code: 0 when at least one manifest was reconciled (or none was found),
 * 1 when candidates existed but every one failed (no git, unreadable, ...).
 *
 * Lives in the plugin module tree (not a top-level export of index.ts) for the
 * same reason lifecycle.ts does: the v1 plugin loader treats top-level
 * functions of the entry file as plugin factories.
 */
import { existsSync, readdirSync, statSync } from "fs"
import path from "path"
import { readManifestV2, reconcileFromGit } from "./lifecycle"

interface Options {
  roots: string[]
  indexRoot: string
  maxDepth: number
  quiet: boolean
}

const SKIP = new Set([
  ".git", "node_modules", "result", "target", "build", ".direnv",
  "downloads", "literature", "tmp", "cache", "output", "update_output", "input",
])

function parseArgs(argv: string[]): Options {
  const options: Options = { roots: [process.cwd()], indexRoot: "graph-index", maxDepth: 5, quiet: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === "--roots") {
      const value = argv[++i] ?? ""
      options.roots = value.split(",").map((r) => r.trim()).filter((r) => r.length > 0).map((r) => path.resolve(r))
    } else if (arg === "--index-root") {
      options.indexRoot = argv[++i] ?? options.indexRoot
    } else if (arg === "--max-depth") {
      options.maxDepth = parseInt(argv[++i] ?? String(options.maxDepth), 10)
      if (!Number.isFinite(options.maxDepth) || options.maxDepth < 1) options.maxDepth = 5
    } else if (arg === "--quiet") {
      options.quiet = true
    } else if (arg.startsWith("--")) {
      console.error(`reconcile: unknown option ${arg}`)
      process.exit(2)
    }
  }
  if (options.roots.length === 0) options.roots = [process.cwd()]
  return options
}

/** Manifests under `root`, at most `maxDepth` levels down. */
function findManifests(root: string, indexRoot: string, maxDepth: number): string[] {
  const found: string[] = []
  const walk = (dir: string, depth: number): void => {
    if (depth > maxDepth) return
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const entry of entries) {
      if (SKIP.has(entry)) continue
      const child = path.join(dir, entry)
      let isDir = false
      try {
        isDir = statSync(child).isDirectory()
      } catch {
        continue
      }
      if (!isDir) continue
      if (entry === indexRoot) {
        const manifest = path.join(child, "manifest.json")
        if (existsSync(manifest)) found.push(manifest)
        continue // never descend into an index root
      }
      walk(child, depth + 1)
    }
  }
  walk(root, 0)
  return found
}

const options = parseArgs(process.argv.slice(2))
const manifests = Array.from(new Set(options.roots.flatMap((root) => findManifests(root, options.indexRoot, options.maxDepth)))).sort()

if (manifests.length === 0) {
  if (!options.quiet) console.log(`reconcile: no ${options.indexRoot}/manifest.json under ${options.roots.join(", ")}`)
  process.exit(0)
}

let ok = 0
const failed: string[] = []

for (const manifestFile of manifests) {
  const root = path.dirname(path.dirname(manifestFile))
  const manifest = readManifestV2(manifestFile)
  if (manifest === null) {
    failed.push(`${root}: unreadable manifest`)
    continue
  }
  const result = reconcileFromGit(root, manifest, manifestFile)
  if (result === null) {
    failed.push(`${root}: git unavailable (not a repository, or git failed)`)
    continue
  }
  ok++
  if (!options.quiet && (result.dirty > 0 || result.removed > 0 || result.structural > 0)) {
    console.log(`${root}: dirty=${result.dirty} removed=${result.removed} structural=${result.structural}`)
  }
}

if (!options.quiet) {
  console.log(`reconcile: ${ok}/${manifests.length} repositories reconciled`)
  for (const line of failed) console.error(`reconcile: ${line}`)
}
process.exit(ok === 0 ? 1 : 0)
