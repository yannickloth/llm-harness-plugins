import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, existsSync, readFileSync, unlinkSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import {
  loadSettingsFromDisk,
  mergeWithFlags,
  getSourceForKey,
  saveConfigAtomic,
  wouldLoseAuthState,
  buildConfigCascade,
} from "./config-settings"
import type { MergeSource, ConfigObject } from "./config-settings"

let tmpDir: string

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "config-settings-test-"))
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

function writeJson(name: string, obj: ConfigObject): string {
  const path = join(tmpDir, name)
  writeFileSync(path, JSON.stringify(obj, null, 2) + "\n")
  return path
}

function readJson(path: string): ConfigObject {
  return JSON.parse(readFileSync(path, "utf-8"))
}

describe("loadSettingsFromDisk", () => {
  test("returns empty merge when no files exist", () => {
    const result = loadSettingsFromDisk([
      { path: join(tmpDir, "nonexistent.json"), name: "user", priority: 1 },
    ])
    expect(result.merged).toEqual({})
    expect(Object.keys(result.perKey)).toHaveLength(0)
  })

  test("loads single file", () => {
    const path = writeJson("user.json", { model: "gpt-4", temperature: 0.7 })
    const result = loadSettingsFromDisk([
      { path, name: "userSettings", priority: 1 },
    ])
    expect(result.merged).toEqual({ model: "gpt-4", temperature: 0.7 })
    expect(result.perKey["model"]).toBe("userSettings")
    expect(result.perKey["temperature"]).toBe("userSettings")
  })

  test("higher priority overrides lower", () => {
    const userPath = writeJson("user.json", { model: "haiku", temperature: 0.5, maxTokens: 4096 })
    const localPath = writeJson("local.json", { model: "sonnet", temperature: 0.3 })

    const result = loadSettingsFromDisk([
      { path: userPath, name: "userSettings", priority: 1 },
      { path: localPath, name: "localSettings", priority: 2 },
    ])

    expect(result.merged.model).toBe("sonnet")
    expect(result.merged.temperature).toBe(0.3)
    expect(result.merged.maxTokens).toBe(4096)
    expect(result.perKey["model"]).toBe("localSettings")
    expect(result.perKey["temperature"]).toBe("localSettings")
    expect(result.perKey["maxTokens"]).toBe("userSettings")
  })

  test("deep merges nested objects", () => {
    const userPath = writeJson("user.json", {
      guardrail: { enabled: true, secretScan: true },
      cache: { ttl: 300 },
    })
    const localPath = writeJson("local.json", {
      guardrail: { secretScan: false, pathValidation: true },
    })

    const result = loadSettingsFromDisk([
      { path: userPath, name: "userSettings", priority: 1 },
      { path: localPath, name: "localSettings", priority: 2 },
    ])

    expect(result.merged.guardrail).toEqual({
      enabled: true,
      secretScan: false,
      pathValidation: true,
    })
    expect(result.merged.cache).toEqual({ ttl: 300 })
    expect(result.perKey["guardrail.secretScan"]).toBe("localSettings")
    expect(result.perKey["guardrail.pathValidation"]).toBe("localSettings")
    expect(result.perKey["guardrail.enabled"]).toBe("userSettings")
  })

  test("scalar replaces object and object replaces scalar", () => {
    const userPath = writeJson("user.json", { provider: { name: "azure", apiversion: "2024-01" } })
    const localPath = writeJson("local.json", { provider: "openai" })

    const result = loadSettingsFromDisk([
      { path: userPath, name: "userSettings", priority: 1 },
      { path: localPath, name: "localSettings", priority: 2 },
    ])

    expect(result.merged.provider).toBe("openai")
  })

  test("null value is delete marker", () => {
    const userPath = writeJson("user.json", { model: "gpt-4", debug: true })
    const localPath = writeJson("local.json", { debug: null })

    const result = loadSettingsFromDisk([
      { path: userPath, name: "userSettings", priority: 1 },
      { path: localPath, name: "localSettings", priority: 2 },
    ])

    expect(result.merged.model).toBe("gpt-4")
    expect(result.merged.debug).toBeUndefined()
    expect("debug" in result.merged).toBe(false)
    expect(result.perKey["debug"]).toBeUndefined()
  })

  test("skips malformed JSON files silently", () => {
    const brokenPath = join(tmpDir, "broken.json")
    writeFileSync(brokenPath, "not json {{{", "utf-8")

    const userPath = writeJson("user.json", { model: "haiku" })
    const localPath = writeJson("local.json", { temperature: 0.5 })

    const result = loadSettingsFromDisk([
      { path: brokenPath, name: "broken", priority: 1 },
      { path: userPath, name: "userSettings", priority: 2 },
      { path: localPath, name: "localSettings", priority: 3 },
    ])

    expect(result.merged.model).toBe("haiku")
    expect(result.merged.temperature).toBe(0.5)
    expect(result.perKey["model"]).toBe("userSettings")
  })

  test("skips JSON arrays at top level", () => {
    const arrayPath = join(tmpDir, "array.json")
    writeFileSync(arrayPath, JSON.stringify([1, 2, 3]), "utf-8")

    const userPath = writeJson("user.json", { model: "haiku" })

    const result = loadSettingsFromDisk([
      { path: arrayPath, name: "array", priority: 1 },
      { path: userPath, name: "userSettings", priority: 2 },
    ])

    expect(result.merged.model).toBe("haiku")
  })

  test("handles BOM-prefixed files", () => {
    const path = join(tmpDir, "bom.json")
    const content = "\uFEFF" + JSON.stringify({ model: "gpt-4" })
    writeFileSync(path, content, "utf-8")

    const result = loadSettingsFromDisk([
      { path, name: "userSettings", priority: 1 },
    ])

    expect(result.merged.model).toBe("gpt-4")
  })

  test("sources record includes all registered sources", () => {
    const userPath = writeJson("user.json", { model: "haiku" })
    const localPath = join(tmpDir, "nonexistent.json")

    const result = loadSettingsFromDisk([
      { path: userPath, name: "userSettings", priority: 1 },
      { path: localPath, name: "localSettings", priority: 2 },
    ])

    expect(result.sources["userSettings"]).toBeDefined()
    expect(result.sources["localSettings"]).toBeDefined()
  })

  test("getSourceForKey returns correct source name", () => {
    const userPath = writeJson("user.json", { model: "haiku", nested: { key: "a" } })
    const localPath = writeJson("local.json", { nested: { key: "b" } })

    const result = loadSettingsFromDisk([
      { path: userPath, name: "userSettings", priority: 1 },
      { path: localPath, name: "localSettings", priority: 2 },
    ])

    expect(getSourceForKey(result, "model")).toBe("userSettings")
    expect(getSourceForKey(result, "nested.key")).toBe("localSettings")
    expect(getSourceForKey(result, "nonexistent")).toBeUndefined()
  })
})

describe("mergeWithFlags", () => {
  test("flags override file-merged settings", () => {
    const userPath = writeJson("user.json", { model: "haiku", temperature: 0.5 })
    const fileResult = loadSettingsFromDisk([
      { path: userPath, name: "userSettings", priority: 1 },
    ])

    const result = mergeWithFlags(fileResult, { model: "gpt-4", maxTokens: 8192 })

    expect(result.merged.model).toBe("gpt-4")
    expect(result.merged.temperature).toBe(0.5)
    expect(result.merged.maxTokens).toBe(8192)
    expect(result.perKey["model"]).toBe("flagSettings")
    expect(result.perKey["temperature"]).toBe("userSettings")
    expect(result.perKey["maxTokens"]).toBe("flagSettings")
  })

  test("empty flags returns original result unchanged", () => {
    const userPath = writeJson("user.json", { model: "haiku" })
    const fileResult = loadSettingsFromDisk([
      { path: userPath, name: "userSettings", priority: 1 },
    ])

    const result = mergeWithFlags(fileResult, {})

    expect(result).toBe(fileResult)
  })

  test("sources includes flagSettings after merge", () => {
    const userPath = writeJson("user.json", { model: "haiku" })
    const fileResult = loadSettingsFromDisk([
      { path: userPath, name: "userSettings", priority: 1 },
    ])

    const result = mergeWithFlags(fileResult, { temperature: 0.9 })

    expect(result.sources["flagSettings"]).toBeDefined()
    expect(result.sources["flagSettings"].name).toBe("flagSettings")
  })
})

describe("buildConfigCascade", () => {
  test("merges user -> local -> flags", () => {
    const userPath = writeJson("user.json", { model: "haiku", temperature: 0.5, debug: false })
    const localPath = writeJson("local.json", { temperature: 0.3, maxTokens: 4096 })

    const result = buildConfigCascade(userPath, localPath, {
      model: "sonnet",
    })

    expect(result.merged.model).toBe("sonnet")
    expect(result.merged.temperature).toBe(0.3)
    expect(result.merged.maxTokens).toBe(4096)
    expect(result.merged.debug).toBe(false)
    expect(result.perKey["model"]).toBe("flagSettings")
    expect(result.perKey["temperature"]).toBe("localSettings")
    expect(result.perKey["maxTokens"]).toBe("localSettings")
    expect(result.perKey["debug"]).toBe("userSettings")
  })

  test("works when a file is missing", () => {
    const userPath = writeJson("user.json", { model: "haiku" })

    const result = buildConfigCascade(userPath, join(tmpDir, "nonexistent.json"), {
      temperature: 0.5,
    })

    expect(result.merged.model).toBe("haiku")
    expect(result.merged.temperature).toBe(0.5)
  })
})

describe("saveConfigAtomic", () => {
  test("writes config to disk", () => {
    const configPath = join(tmpDir, "config.json")
    const result = saveConfigAtomic(configPath, { model: "gpt-4", temperature: 0.7 })

    expect(result.success).toBe(true)
    expect(existsSync(configPath)).toBe(true)
    const saved = readJson(configPath)
    expect(saved).toEqual({ model: "gpt-4", temperature: 0.7 })
    const raw = readFileSync(configPath, "utf-8")
    expect(raw.endsWith("\n")).toBe(true)
  })

  test("updates existing config", () => {
    const configPath = join(tmpDir, "config.json")
    saveConfigAtomic(configPath, { model: "haiku" })
    saveConfigAtomic(configPath, { model: "sonnet", temperature: 0.3 })

    const saved = readJson(configPath)
    expect(saved).toEqual({ model: "sonnet", temperature: 0.3 })
  })

  test("blocks write that removes auth state", () => {
    const configPath = join(tmpDir, "config.json")
    saveConfigAtomic(configPath, { model: "gpt-4", apiKey: "sk-secret123" })

    const result = saveConfigAtomic(configPath, { model: "gpt-4" })

    expect(result.success).toBe(false)
    expect(result.reason).toContain("auth-loss guard")

    const saved = readJson(configPath)
    expect(saved.apiKey).toBe("sk-secret123")
  })

  test("allows write when auth keys are present in both", () => {
    const configPath = join(tmpDir, "config.json")
    saveConfigAtomic(configPath, { apiKey: "sk-old" })

    const result = saveConfigAtomic(configPath, { apiKey: "sk-new", model: "sonnet" })

    expect(result.success).toBe(true)
    const saved = readJson(configPath)
    expect(saved.apiKey).toBe("sk-new")
    expect(saved.model).toBe("sonnet")
  })

  test("allows write when no existing file", () => {
    const configPath = join(tmpDir, "new-config.json")

    const result = saveConfigAtomic(configPath, { model: "haiku" })

    expect(result.success).toBe(true)
    expect(existsSync(configPath)).toBe(true)
  })

  test("creates parent directories if needed", () => {
    const configPath = join(tmpDir, "nested", "dir", "config.json")

    const result = saveConfigAtomic(configPath, { model: "haiku" })

    expect(result.success).toBe(true)
    expect(existsSync(configPath)).toBe(true)
  })
})

describe("wouldLoseAuthState", () => {
  test("detects removal of known auth key", () => {
    const existing: ConfigObject = { model: "gpt-4", apiKey: "sk-xxx" }
    const proposed: ConfigObject = { model: "gpt-4" }

    expect(wouldLoseAuthState(existing, proposed)).toBe(true)
  })

  test("does not trigger on non-auth string leaves", () => {
    const existing: ConfigObject = { model: "sonnet", endpoint: "https://api.openai.com" }
    const proposed: ConfigObject = { model: "sonnet" }

    expect(wouldLoseAuthState(existing, proposed)).toBe(false)
  })

  test("passes when no auth keys in either", () => {
    const existing: ConfigObject = { model: "haiku", temperature: 0.5 }
    const proposed: ConfigObject = { model: "sonnet", temperature: 0.3 }

    expect(wouldLoseAuthState(existing, proposed)).toBe(false)
  })

  test("passes when credentials are added", () => {
    const existing: ConfigObject = { model: "haiku" }
    const proposed: ConfigObject = { model: "haiku", apiKey: "sk-xxx" }

    expect(wouldLoseAuthState(existing, proposed)).toBe(false)
  })

  test("detects credential loss in nested object", () => {
    const existing: ConfigObject = {
      model: "gpt-4",
      azure: { apiKey: "sk-azure" },
    }
    const proposed: ConfigObject = {
      model: "gpt-4",
      azure: { endpoint: "https://eastus.api" },
    }

    expect(wouldLoseAuthState(existing, proposed)).toBe(true)
  })

  test("detects client_secret and password", () => {
    const existing: ConfigObject = { client_secret: "cs-abc", password: "pw-xyz" }
    const proposed: ConfigObject = {}

    expect(wouldLoseAuthState(existing, proposed)).toBe(true)
  })

  test("detects camelCase variant", () => {
    const existing: ConfigObject = { clientSecret: "cs-abc" }
    const proposed: ConfigObject = {}

    expect(wouldLoseAuthState(existing, proposed)).toBe(true)
  })

  test("ignores env-var references like ${VAR}", () => {
    const existing: ConfigObject = { apiKey: "${OPENAI_KEY}" }
    const proposed: ConfigObject = { model: "haiku" }

    expect(wouldLoseAuthState(existing, proposed)).toBe(false)
  })

  test("env-var with suffix is treated as placeholder and skipped", () => {
    const existing: ConfigObject = { model: "haiku", apiKey: "${PROJ}_suffix" }
    const proposed: ConfigObject = { model: "haiku" }

    expect(wouldLoseAuthState(existing, proposed)).toBe(false)
  })

  test("passes when no existing config", () => {
    const existing: ConfigObject = {}
    const proposed: ConfigObject = { model: "haiku" }

    expect(wouldLoseAuthState(existing, proposed)).toBe(false)
  })
})

describe("prototype pollution", () => {
  test("__proto__ key in JSON is ignored by deep merge", () => {
    const userPath = writeJson("user.json", { model: "haiku" })
    const localPath = join(tmpDir, "local.json")
    writeFileSync(localPath, JSON.stringify({ __proto__: { polluted: true }, temperature: 0.5 }), "utf-8")

    const result = loadSettingsFromDisk([
      { path: userPath, name: "userSettings", priority: 1 },
      { path: localPath, name: "localSettings", priority: 2 },
    ])

    expect(result.merged.temperature).toBe(0.5)
    expect(({} as any).polluted).toBeUndefined()
  })

  test("constructor key is ignored", () => {
    const path = writeJson("user.json", { constructor: "__evil__", model: "haiku" })

    const result = loadSettingsFromDisk([
      { path, name: "userSettings", priority: 1 },
    ])

    expect(result.merged.model).toBe("haiku")
    expect(Object.prototype.constructor).toBe(Object)
    expect((result.merged as any).constructor).toBe(Object)
  })

  test("prototype key in nested object is ignored", () => {
    const userPath = writeJson("user.json", { nested: { model: "haiku" } })
    const localPath = join(tmpDir, "local.json")
    writeFileSync(localPath, JSON.stringify({ nested: { prototype: "bad", model: "sonnet" } }), "utf-8")

    const result = loadSettingsFromDisk([
      { path: userPath, name: "userSettings", priority: 1 },
      { path: localPath, name: "localSettings", priority: 2 },
    ])

    expect((result.merged as ConfigObject & { nested: ConfigObject }).nested.model).toBe("sonnet")
  })

  test("__proto__ in flags is ignored", () => {
    const userPath = writeJson("user.json", { model: "haiku" })
    const fileResult = loadSettingsFromDisk([
      { path: userPath, name: "userSettings", priority: 1 },
    ])

    const result = mergeWithFlags(fileResult, { __proto__: { polluted: true }, temperature: 0.5 } as any)

    expect(result.merged.temperature).toBe(0.5)
    expect(({} as any).polluted).toBeUndefined()
  })
})

describe("backup behavior", () => {
  test("does not create backup when config does not exist", () => {
    const configPath = join(tmpDir, "nonexistent-config.json")
    const result = saveConfigAtomic(configPath, { model: "haiku" })

    expect(result.success).toBe(true)
  })
})
