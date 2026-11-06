import {
  existsSync, readFileSync, writeFileSync, renameSync, readdirSync, statSync,
  openSync, closeSync, rmSync,
} from "fs"
import path from "path"

// Shared lifecycle logic for the graphrag plugin (spec: plugin-graphrag.functional-spec.md).
// Lives here, NOT in index.ts: the v1 plugin loader treats every top-level function
// export of index.ts as a plugin factory (see spawn-slot.ts header). Same constraint
// applies to any helper exported from this module — index.ts must never re-export it
// at top level.

export interface ManifestV2 {
  schema: number
  commit: string
  timestamp: string
  graphrag_version: string
  graphrag_binary: string
  dirty: string[]
  // Sources deleted or renamed away since the last build. The exporter can only
  // delete documents for sources it is told about, so a deletion must be
  // recorded explicitly — an index that keeps a deleted chapter stays wrong.
  removed: string[]
  // A content-affecting input outside the indexed source set changed (.bib,
  // .sty, figures): the rendered blocks are stale even though no .typ/.tex did.
  full_reindex: boolean
  status: string // idle | building | complete | partial | failed_preflight | failed_run | stale | unknown
  last_good_build: string | null
  partial_reason: string | null
  failure_reason: string | null
  consecutive_failures: number
  artifacts_present: string[]
}

const MANIFEST_DEFAULTS: Omit<ManifestV2, "commit" | "timestamp"> = {
  schema: 2,
  graphrag_version: "unknown",
  graphrag_binary: "graphrag",
  dirty: [],
  removed: [],
  full_reindex: false,
  status: "unknown",
  last_good_build: null,
  partial_reason: null,
  failure_reason: null,
  consecutive_failures: 0,
  artifacts_present: [],
}

export function readManifestV2(manifestFile: string): ManifestV2 | null {
  try {
    const raw = JSON.parse(readFileSync(manifestFile, "utf8"))
    return {
      schema: typeof raw.schema === "number" ? raw.schema : 1, // schema-1 manifests predate the field
      commit: raw.commit ?? "none",
      timestamp: raw.timestamp ?? "",
      graphrag_version: raw.graphrag_version ?? "unknown",
      graphrag_binary: raw.graphrag_binary ?? "graphrag",
      dirty: Array.isArray(raw.dirty) ? raw.dirty : [],
      removed: Array.isArray(raw.removed) ? raw.removed : [],
      full_reindex: raw.full_reindex === true,
      status: raw.status ?? "unknown",
      last_good_build: raw.last_good_build ?? null,
      partial_reason: raw.partial_reason ?? null,
      failure_reason: raw.failure_reason ?? null,
      consecutive_failures: raw.consecutive_failures ?? 0,
      artifacts_present: Array.isArray(raw.artifacts_present) ? raw.artifacts_present : [],
    }
  } catch {
    return null
  }
}

/**
 * Read-modify-write preserving fields this side does not own. Writes are atomic
 * (tmp + rename). `undefined` patch values are skipped; explicit nulls clear fields.
 *
 * The read-modify-write pair is guarded by a lock file: the plugin host and the
 * standalone reconcile service both merge into the same manifest, and an
 * unguarded pair loses one side's entries. Rename makes each write atomic; the
 * lock makes the merge atomic.
 */
export function mergeManifestV2Atomic(manifestFile: string, patch: Partial<ManifestV2>): boolean {
  const written = withManifestLock(manifestFile, () => {
    const base = readManifestV2(manifestFile) ?? {
      ...MANIFEST_DEFAULTS,
      commit: "none",
      timestamp: new Date().toISOString(),
    }
    const merged = { ...base, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) }
    const tmp = `${manifestFile}.tmp`
    writeFileSync(tmp, JSON.stringify(merged, null, 2))
    renameSync(tmp, manifestFile)
    return true
  })
  return written === true
}

const LOCK_STALE_MS = 30_000
const LOCK_WAIT_MS = 2_000

/** Run `fn` while holding `<manifestFile>.lock`; null when the lock stays busy. */
export function withManifestLock<T>(manifestFile: string, fn: () => T): T | null {
  const lockFile = `${manifestFile}.lock`
  const deadline = Date.now() + LOCK_WAIT_MS
  let fd: number | null = null
  while (fd === null) {
    try {
      fd = openSync(lockFile, "wx")
      writeFileSync(fd, `${process.pid}\n`)
    } catch (error: any) {
      if (error?.code !== "EEXIST") return null
      try {
        // A crashed holder must not wedge the lock forever.
        if (Date.now() - statSync(lockFile).mtimeMs > LOCK_STALE_MS) {
          rmSync(lockFile, { force: true })
          continue
        }
      } catch { /* released between stat and open */ }
      if (Date.now() > deadline) return null
      Bun.sleepSync(20)
    }
  }
  try {
    return fn()
  } finally {
    try { closeSync(fd) } catch { /* already closed */ }
    try { rmSync(lockFile, { force: true }) } catch { /* best effort */ }
  }
}

export interface ReconcileState {
  timestamp: string
  dirty: number
  removed: number
  structural: number
}

function reconcileStatePath(manifestFile: string): string {
  return path.join(path.dirname(manifestFile), ".reconciled")
}

export function readReconcileState(manifestFile: string): ReconcileState | null {
  try {
    const raw = JSON.parse(readFileSync(reconcileStatePath(manifestFile), "utf8"))
    if (typeof raw.timestamp !== "string") return null
    return {
      timestamp: raw.timestamp,
      dirty: Number(raw.dirty ?? 0),
      removed: Number(raw.removed ?? 0),
      structural: Number(raw.structural ?? 0),
    }
  } catch {
    return null
  }
}

function writeReconcileState(manifestFile: string, state: ReconcileState): void {
  try {
    const file = reconcileStatePath(manifestFile)
    const tmp = `${file}.tmp`
    writeFileSync(tmp, JSON.stringify(state, null, 2))
    renameSync(tmp, file)
  } catch { /* best effort */ }
}

const EXCLUDE_SEGMENTS = new Set([
  "result", ".git", "graph-index", "tmp", "target", "build",
  ".direnv", "node_modules", "downloads", "literature",
  // Nested worktrees: their content belongs to their own index. Exporting them
  // here would double-index the tree and report the worktree as dirty noise.
  "worktrees", ".worktrees",
])

/** Indexed sources: Typst and LaTeX files outside the excluded trees. */
export function isRelevantFile(root: string, file: string): boolean {
  if (!file.endsWith(".typ") && !file.endsWith(".tex")) return false
  const rel = path.isAbsolute(file) ? path.relative(root, file) : file
  if (rel.startsWith("..")) return false
  for (const seg of rel.split(path.sep)) {
    if (EXCLUDE_SEGMENTS.has(seg)) return false
  }
  return true
}

const STRUCTURAL_EXTENSIONS = [".bib", ".bst", ".sty", ".cls", ".png", ".jpg", ".jpeg", ".svg", ".pdf", ".puml"]

/**
 * Inputs that change the rendered text without being indexed themselves. A .bib
 * or figure edit changes the blocks' content, but no .typ/.tex file changes, so
 * the dirty set alone would miss it entirely.
 */
export function isStructuralFile(root: string, file: string): boolean {
  const rel = path.isAbsolute(file) ? path.relative(root, file) : file
  if (rel.startsWith("..")) return false
  for (const seg of rel.split(path.sep)) {
    if (EXCLUDE_SEGMENTS.has(seg)) return false
  }
  const lower = rel.toLowerCase()
  return STRUCTURAL_EXTENSIONS.some((ext) => lower.endsWith(ext))
}

/** Remember a deleted/renamed-away source; the exporter drops its documents. */
export function markRemoved(manifestFile: string, rel: string): boolean {
  const manifest = readManifestV2(manifestFile)
  const removed = manifest?.removed ?? []
  if (removed.includes(rel)) return false
  return mergeManifestV2Atomic(manifestFile, { removed: [...removed, rel] })
}

/** Structural input changed: the whole corpus must be re-exported, not just one file. */
export function markFullReindex(manifestFile: string): boolean {
  const manifest = readManifestV2(manifestFile)
  if (manifest?.full_reindex === true) return false
  return mergeManifestV2Atomic(manifestFile, { full_reindex: true })
}

function git(root: string, args: string[]): string | null {
  try {
    const proc = Bun.spawnSync(["git", "-C", root, ...args], { timeout: 5000 })
    if (proc.exitCode !== 0) return null
    return proc.stdout?.toString() ?? ""
  } catch {
    return null
  }
}

export interface ReconcileResult {
  dirty: number
  removed: number
  structural: number
}

/** A dirty set beyond this many entries is cheaper to rebuild than to list. */
const DIRTY_CAP = 2000

/**
 * Reconcile the manifest with git at session idle. The editor hooks see only the
 * edits the harness itself makes; a checkout, rebase, or an editor outside this
 * process leaves the dirty set empty while the working tree changes. This pass
 * unions `git status` (and commits since the indexed commit) into the manifest.
 */
export function reconcileFromGit(
  root: string,
  manifest: ManifestV2 | null,
  manifestFile: string,
): ReconcileResult | null {
  const status = git(root, ["status", "--porcelain=v1", "--untracked-files=all"])
  if (status === null) return null

  const dirty = new Set<string>()
  const removed = new Set<string>()
  let structural = 0

  const classify = (code: string, rel: string): void => {
    if (!rel) return
    const abs = path.join(root, rel)
    if (code.includes("D")) {
      if (isRelevantFile(root, abs)) removed.add(rel)
      return
    }
    if (isRelevantFile(root, abs)) dirty.add(rel)
    else if (isStructuralFile(root, abs)) structural++
  }

  for (const line of status.split("\n")) {
    if (!line.trim()) continue
    const code = line.slice(0, 2)
    const rest = line.slice(3).trim()
    if (rest.includes(" -> ")) {
      const [oldPath, newPath] = rest.split(" -> ")
      classify(code, newPath ?? "")
      if ((code.startsWith("R") || code.startsWith("C")) && isRelevantFile(root, path.join(root, oldPath ?? ""))) {
        removed.add(oldPath ?? "")
      }
      continue
    }
    classify(code, rest)
  }

  const commit = manifest?.commit ?? ""
  if (/^[0-9a-f]{7,40}$/i.test(commit)) {
    const diff = git(root, ["diff", "--name-status", `${commit}..HEAD`])
    if (diff !== null) {
      for (const line of diff.split("\n")) {
        if (!line.trim()) continue
        const parts = line.split("\t")
        const code = (parts[0] ?? "").charAt(0)
        if (code === "D") {
          const rel = parts[1] ?? ""
          if (isRelevantFile(root, path.join(root, rel))) removed.add(rel)
        } else if (code === "R" || code === "C") {
          const oldPath = parts[1] ?? ""
          const newPath = parts[2] ?? ""
          if (isRelevantFile(root, path.join(root, newPath))) dirty.add(newPath)
          if (isRelevantFile(root, path.join(root, oldPath))) removed.add(oldPath)
        } else if (parts[1]) {
          const rel = parts[1]
          if (isRelevantFile(root, path.join(root, rel))) dirty.add(rel)
          else if (isStructuralFile(root, path.join(root, rel))) structural++
        }
      }
    }
  }

  const base = manifest ?? readManifestV2(manifestFile)
  const mergedRemoved = Array.from(new Set([...(base?.removed ?? []), ...removed]))
  const mergedDirty = Array.from(new Set([...(base?.dirty ?? []), ...dirty])).filter(
    (p) => !mergedRemoved.includes(p),
  )
  const patch: Partial<ManifestV2> = {}
  if (dirty.size > DIRTY_CAP) {
    // Too many *new* paths to list: a rebuild is cheaper than the bookkeeping.
    // Judge only this pass's findings — a large dirty list inherited from an
    // earlier session is history, and clearing it would lose the record.
    patch.full_reindex = true
  } else if (mergedDirty.length > 0) {
    patch.dirty = mergedDirty
  }
  if (mergedRemoved.length > 0) patch.removed = mergedRemoved
  if (structural > 0) patch.full_reindex = true
  if (Object.keys(patch).length > 0) mergeManifestV2Atomic(manifestFile, patch)
  writeReconcileState(manifestFile, {
    timestamp: new Date().toISOString(),
    dirty: mergedDirty.length,
    removed: mergedRemoved.length,
    structural,
  })
  return { dirty: mergedDirty.length, removed: mergedRemoved.length, structural }
}

function readEnvFile(file: string, name: string): string | null {
  try {
    const raw = readFileSync(file, "utf8")
    for (const line of raw.split("\n")) {
      let t = line.trim()
      if (!t || t.startsWith("#")) continue
      if (t.startsWith("export ")) t = t.slice(7).trim()
      const eq = t.indexOf("=")
      if (eq < 0) continue
      if (t.slice(0, eq).trim() !== name) continue
      let val = t.slice(eq + 1).trim()
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1)
      }
      return val.length > 0 ? val : null
    }
  } catch { /* absent */ }
  return null
}

/**
 * Key resolution chain (FS-1): process.env → indexRoot/.env → root/.env → direnv.
 * direnv loads the nix devShell, where consumer projects export API keys.
 */
export async function resolveEnvKey(name: string, root: string, indexRoot: string): Promise<string | null> {
  const fromEnv = process.env[name]
  if (fromEnv) return fromEnv
  const fromFile = readEnvFile(path.join(indexRoot, ".env"), name) ?? readEnvFile(path.join(root, ".env"), name)
  if (fromFile) return fromFile
  try {
    const proc = Bun.spawnSync(["direnv", "exec", root, "printenv", name], { timeout: 20000 })
    const out = proc.stdout?.toString().trim() ?? ""
    if (proc.exitCode === 0 && out.length > 0) return out
  } catch { /* direnv missing */ }
  return null
}

export async function probeEndpoint(apiBase: string, timeoutMs: number): Promise<boolean> {
  const url = apiBase.replace(/\/+$/, "") + "/models"
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
    return res.status < 400
  } catch {
    return false
  }
}

export function requiredArtifacts(mode: string): string[] {
  if (mode === "local") return ["text_units.parquet", "lancedb"]
  if (mode === "global") return ["communities.parquet", "community_reports.parquet"]
  if (mode === "drift") return ["covariates.parquet", "entities.parquet", "relationships.parquet"]
  return []
}

export function isQueryMode(mode: string): boolean {
  return mode === "local" || mode === "global" || mode === "drift"
}

/** FS-5: per-mode prerequisite check against the built index. Empty list = queryable. */
export function gateMissing(indexRoot: string, mode: string): string[] {
  const missing: string[] = []
  for (const entry of requiredArtifacts(mode)) {
    if (entry === "lancedb") {
      let ok = false
      try {
        ok = existsSync(path.join(indexRoot, "lancedb")) && readdirSync(path.join(indexRoot, "lancedb")).length > 0
      } catch { ok = false }
      if (!ok) missing.push(entry)
      continue
    }
    let size = 0
    try {
      size = statSync(path.join(indexRoot, "output", entry)).size
    } catch { size = 0 }
    if (size <= 0) missing.push(entry)
  }
  return missing
}

/** How long a "building" marker is trusted before it counts as a dead run's leftover. */
const BUILDING_GRACE_MS = 6 * 3600 * 1000

function isFreshIncident(timestamp: string, graceMs: number): boolean {
  const t = Date.parse(timestamp)
  return Number.isFinite(t) && Date.now() - t < graceMs
}

/** FS-4: one-line session notice. null = healthy (complete and fresh) → no notice. */
export function statusNotice(manifest: ManifestV2 | null): string | null {
  if (!manifest) return "graphrag index missing — build with graphrag mode=index."
  const status = manifest.status
  // A build marker is only meaningful while a run is live (Java holds the index
  // lock for the whole run). A marker older than the grace window belongs to a
  // run that died, and leaving it silent would hide exactly that.
  if (status === "building" && isFreshIncident(manifest.timestamp, BUILDING_GRACE_MS)) return null
  const since = manifest.timestamp ? manifest.timestamp.slice(0, 10) : "unknown"
  const bits: string[] = []
  if (status === "building") {
    bits.push(`graphrag index stuck in building since ${since}`)
    bits.push("Run graphrag mode=index.")
  } else if (status === "complete") {
    // A complete index still falls behind the working tree. The old plugin
    // reported that; going silent here would hide staleness. Removals and
    // structural-input changes are staleness too, with no dirty paths listed.
    if (manifest.dirty.length === 0 && manifest.removed.length === 0 && !manifest.full_reindex) return null
    const parts: string[] = []
    if (manifest.dirty.length > 0) parts.push(`${manifest.dirty.length} files changed`)
    if (manifest.removed.length > 0) parts.push(`${manifest.removed.length} files removed`)
    if (manifest.full_reindex) parts.push("structural inputs changed")
    bits.push(`graphrag index stale: ${parts.join(", ")} since ${since}`)
  } else {
    bits.push(`graphrag index ${status}`)
    if (manifest.partial_reason) bits.push(manifest.partial_reason)
    if (manifest.failure_reason) bits.push(`last failure: ${manifest.failure_reason}`)
    if (manifest.dirty.length > 0) bits.push(`${manifest.dirty.length} files dirty since ${since}`)
    if (manifest.removed.length > 0) bits.push(`${manifest.removed.length} files removed`)
    if (manifest.full_reindex) bits.push("full reindex requested")
    if (manifest.consecutive_failures > 0) bits.push(`${manifest.consecutive_failures} consecutive failures`)
    if (manifest.last_good_build) bits.push(`last good build ${manifest.last_good_build.slice(0, 10)}`)
    // No absolute "queries unavailable" claim here: the artifact gate decides
    // that per mode, and a failed preflight can coexist with a complete older
    // index whose queries still work.
    bits.push("Run graphrag mode=index.")
  }
  const line = bits.join("; ")
  return line.endsWith(".") ? line : `${line}.`
}

export interface GraphragYamlConfig {
  chatApiKeyEnv: string
  embeddingApiKeyEnv: string
  embeddingApiBase: string
}

export function parseGraphragYamlConfig(text: string): GraphragYamlConfig {
  const get = (key: string, fallback: string): string => {
    const m = text.match(new RegExp(`^\\s*${key}:\\s*(.+)$`, "m"))
    const v = m?.[1]?.trim()
    return v && v.length > 0 ? v : fallback
  }
  return {
    chatApiKeyEnv: get("chat_api_key_env", "DEEPSEEK_API_KEY"),
    embeddingApiKeyEnv: get("embedding_api_key_env", "GRAPHRAG_API_KEY"),
    embeddingApiBase: get("embedding_api_base", "http://localhost:1234/v1"),
  }
}
