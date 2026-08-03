import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, readdirSync, unlinkSync, renameSync, openSync, closeSync } from "fs"
import { join, dirname } from "path"
import { homedir } from "os"

export type ConfigValue = string | number | boolean | null | ConfigValue[] | { [key: string]: ConfigValue }
export type ConfigObject = { [key: string]: ConfigValue }

export interface MergeSource {
  path: string
  name: string
  priority: number
}

export interface MergeResult {
  merged: ConfigObject
  sources: Record<string, MergeSource>
  perKey: Record<string, string>
}

interface BackupEntry {
  path: string
  mtime: number
}

const MAX_BACKUPS = 5
const BACKUP_THROTTLE_MS = 60_000
const BACKUP_DIR = join(homedir(), ".claude", "backups")

function stripBOM(content: string): string {
  if (content.codePointAt(0) === 0xFEFF) return content.slice(1)
  return content
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

const PROTOTYPE_KEYS = new Set(["__proto__", "constructor", "prototype"])

function deepMerge(target: ConfigObject, source: ConfigObject): ConfigObject {
  const result: ConfigObject = { ...target }

  for (const key of Object.keys(source)) {
    if (PROTOTYPE_KEYS.has(key)) continue

    const srcVal = source[key]
    const tgtVal = target[key]

    if (srcVal === null) {
      delete result[key]
      continue
    }

    if (isObject(srcVal) && isObject(tgtVal)) {
      result[key] = deepMerge(tgtVal as ConfigObject, srcVal as ConfigObject)
    } else {
      result[key] = srcVal
    }
  }

  return result
}

function readJsonFile(path: string): ConfigObject | null {
  try {
    if (!existsSync(path)) return null
    const raw = readFileSync(path, "utf-8")
    const stripped = stripBOM(raw)
    const parsed = JSON.parse(stripped)
    if (!isObject(parsed)) return null
    return parsed as ConfigObject
  } catch {
    return null
  }
}

class KeyTracker {
  perKey: Record<string, string> = {}

  track(data: ConfigObject, sourceName: string) {
    const self = this
    function walk(obj: ConfigObject, prefix: string) {
      for (const key of Object.keys(obj)) {
        if (PROTOTYPE_KEYS.has(key)) continue

        const fullKey = prefix ? `${prefix}.${key}` : key
        if (obj[key] === null) {
          delete self.perKey[fullKey]
          continue
        }
        self.perKey[fullKey] = sourceName
        if (isObject(obj[key])) {
          walk(obj[key] as ConfigObject, fullKey)
        }
      }
    }
    walk(data, "")
  }
}

export function loadSettingsFromDisk(
  sourcePaths: MergeSource[],
): MergeResult {
  const sorted = [...sourcePaths].sort((a, b) => a.priority - b.priority)

  const sources: Record<string, MergeSource> = {}
  for (const s of sorted) {
    sources[s.name] = s
  }

  const tracker = new KeyTracker()

  let merged: ConfigObject = {}

  for (const source of sorted) {
    const data = readJsonFile(source.path)
    if (data === null) continue
    tracker.track(data, source.name)
    merged = deepMerge(merged, data)
  }

  return { merged, sources, perKey: tracker.perKey }
}

export function mergeWithFlags(
  fileResult: MergeResult,
  flags: ConfigObject,
): MergeResult {
  if (Object.keys(flags).length === 0) return fileResult

  const flagSource: MergeSource = { path: "_flags_", name: "flagSettings", priority: 999 }

  const merged = deepMerge(fileResult.merged, flags)
  const sources = { ...fileResult.sources, flagSettings: flagSource }

  const tracker = new KeyTracker()
  tracker.perKey = { ...fileResult.perKey }
  tracker.track(flags, "flagSettings")

  return { merged, sources, perKey: tracker.perKey }
}

export function getSourceForKey(
  result: MergeResult,
  key: string,
): string | undefined {
  return result.perKey[key]
}

function getBackupDir(): string {
  if (!existsSync(BACKUP_DIR)) {
    mkdirSync(BACKUP_DIR, { recursive: true, mode: 0o700 })
  }
  return BACKUP_DIR
}

function lockFilePath(path: string): string {
  return path + ".lock"
}

function acquireLock(path: string): { release: () => void } | null {
  const lockPath = lockFilePath(path)
  const lockDir = dirname(lockPath)
  if (!existsSync(lockDir)) {
    try {
      mkdirSync(lockDir, { recursive: true, mode: 0o700 })
    } catch {
      return null
    }
  }

  try {
    openSync(lockPath, "wx")
  } catch {
    try {
      const age = Date.now() - statSync(lockPath).mtimeMs
      if (age <= 30_000) return null
      unlinkSync(lockPath)
      openSync(lockPath, "wx")
    } catch {
      return null
    }
  }

  return {
    release: () => {
      try {
        unlinkSync(lockPath)
      } catch {
        // lock already gone — nothing to release
      }
    },
  }
}

function listBackups(configPath: string): BackupEntry[] {
  const dir = getBackupDir()
  const basename = configPath.replace(/\//g, "_")
  try {
    const entries = readdirSync(dir)
      .filter((f) => f.startsWith(basename + "_"))
      .map((f) => {
        const fullPath = join(dir, f)
        try {
          return { path: fullPath, mtime: statSync(fullPath).mtimeMs }
        } catch {
          return null
        }
      })
      .filter((e): e is BackupEntry => e !== null)
      .sort((a, b) => b.mtime - a.mtime)
    return entries
  } catch {
    return []
  }
}

function shouldBackup(configPath: string): boolean {
  const backups = listBackups(configPath)
  if (backups.length === 0) return true
  const newest = backups[0]
  return Date.now() - newest.mtime >= BACKUP_THROTTLE_MS
}

function createBackup(configPath: string): void {
  if (!existsSync(configPath)) return
  if (!shouldBackup(configPath)) return

  const dir = getBackupDir()
  const basename = configPath.replace(/\//g, "_")
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-")
  const backupPath = join(dir, `${basename}_${timestamp}`)

  try {
    const content = readFileSync(configPath)
    writeFileSync(backupPath, content, { mode: 0o600 })
  } catch {
    return
  }

  const backups = listBackups(configPath)
  while (backups.length >= MAX_BACKUPS) {
    const oldest = backups.pop()
    if (oldest) {
      try {
        unlinkSync(oldest.path)
      } catch {
        // stale entry — ignore
      }
    }
  }
}

const AUTH_KEYS = new Set([
  "apiKey", "api_key",
  "token", "bearer",
  "secretKey", "secret_key", "secret",
  "accessToken", "access_token",
  "credentials",
  "azureApiKey", "azure_api_key",
  "openaiApiKey", "openai_api_key",
  "password", "passwd",
  "clientSecret", "client_secret",
  "accessKey", "access_key",
  "privateKey", "private_key",
])

function hasCredentials(obj: ConfigObject): boolean {
  for (const key of Object.keys(obj)) {
    if (PROTOTYPE_KEYS.has(key)) continue

    const val = obj[key]
    if (AUTH_KEYS.has(key) || AUTH_KEYS.has(key.toLowerCase())) {
      if (typeof val === "string" && val.length > 0 && !val.startsWith("${")) {
        return true
      }
    }
    if (isObject(val)) {
      if (hasCredentials(val as ConfigObject)) return true
    }
  }
  return false
}

export function wouldLoseAuthState(
  existing: ConfigObject,
  proposed: ConfigObject,
): boolean {
  return hasCredentials(existing) && !hasCredentials(proposed)
}

export function saveConfigAtomic(
  configPath: string,
  data: ConfigObject,
): { success: boolean; reason?: string } {
  if (!isObject(data)) {
    return { success: false, reason: "data must be a plain object, not array or primitive" }
  }

  const existing = readJsonFile(configPath)
  if (existing !== null && wouldLoseAuthState(existing, data)) {
    return {
      success: false,
      reason: "auth-loss guard: proposed config would remove existing credentials",
    }
  }

  const dir = dirname(configPath)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
  }

  const lock = acquireLock(configPath)
  if (lock === null) {
    return {
      success: false,
      reason: "lock acquisition failed: another process may be writing",
    }
  }

  const tmpPath = configPath + ".tmp." + process.pid

  try {
    createBackup(configPath)

    const json = JSON.stringify(data, null, 2) + "\n"
    writeFileSync(tmpPath, json, { mode: 0o600 })
    renameSync(tmpPath, configPath)

    return { success: true }
  } catch (e) {
    try { unlinkSync(tmpPath) } catch {}
    return {
      success: false,
      reason: `write failed: ${(e as Error).message}`,
    }
  } finally {
    lock.release()
  }
}

export function buildConfigCascade(
  userSettingsPath: string,
  localSettingsPath: string,
  flagOverrides: ConfigObject = {},
): MergeResult {
  const fileResult = loadSettingsFromDisk([
    { path: userSettingsPath, name: "userSettings", priority: 1 },
    { path: localSettingsPath, name: "localSettings", priority: 2 },
  ])

  return mergeWithFlags(fileResult, flagOverrides)
}
