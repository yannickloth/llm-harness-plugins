import { describe, test, expect } from "bun:test"
import path from "path"
import {
  buildContext,
  buildStaticContext,
  buildSessionContext,
  buildPerMessageContext,
  currentDatetime,
  datetimeNote,
  DATETIME_HEADER,
  PLATFORM_HEADER,
  TOOLCHAIN_HEADER,
  STABLE_MARKERS,
  packageManagerFor,
  hasAnyMarker,
  getToolchainLines,
  extractFlakePackages,
} from "./helpers"

const REPO_ROOT = path.join(import.meta.dir, "..", "..")

// Deterministic file reader over an in-memory map (no disk dependency).
function memReader(files: Record<string, string>) {
  return (p: string) => files[path.basename(p)] ?? ""
}

describe("datetime-inject helpers", () => {
  describe("datetime", () => {
    test("datetimeNote starts with the stable header", () => {
      expect(datetimeNote().startsWith(DATETIME_HEADER)).toBe(true)
    })

    test("datetimeNote contains UTC marker and ends bracket", () => {
      const note = datetimeNote()
      expect(note).toContain(" UTC]")
      expect(note.endsWith("]")).toBe(true)
    })

    test("currentDatetime is non-empty and round-trippable via Date", () => {
      const dt = currentDatetime()
      expect(dt.length).toBeGreaterThan(0)
      expect(new Date(dt).toString()).not.toBe("Invalid Date")
    })
  })

  describe("platform", () => {
    test("platform section has header and Standard diagnostic lines", () => {
      const ctx = buildContext("/", { platform: true, datetime: false, toolchain: false })
      expect(ctx.startsWith(PLATFORM_HEADER)).toBe(true)
      expect(ctx).toContain("System:")
      expect(ctx).toContain("CPU:")
      expect(ctx).toContain("Memory:")
    })

    test("packageManagerFor maps known distros", () => {
      expect(packageManagerFor("cachyos")).toBe("pacman / paru")
      expect(packageManagerFor("arch")).toBe("pacman / paru")
      expect(packageManagerFor("fedora")).toBe("dnf")
      expect(packageManagerFor("ubuntu")).toBe("apt")
      expect(packageManagerFor("debian")).toBe("apt")
      expect(packageManagerFor("nixos")).toBe("nix")
    })

    test("packageManagerFor returns empty for unknown/no ID", () => {
      expect(packageManagerFor("")).toBe("")
      expect(packageManagerFor("unknownnix")).toBe("")
    })
  })

  describe("toolchain", () => {
    const files = {
      ".envrc": "use flake",
      "flake.nix":
        '{ inputs.nixpkgs.url = "github:NixOS/nixpkgs"; outputs = { self, nixpkgs }: { devShells.x86_64-linux.default = nixpkgs.mkShell { buildInputs = [ pkgs.python312Packages.graphrag pkgs.pandoc ]; }; }; };',
      "flake.lock": "{}",
    }

    test("extractFlakePackages pulls bare pkgs.* tokens", () => {
      const flake = files["flake.nix"]
      expect(extractFlakePackages(flake)).toEqual([
        "python312Packages.graphrag",
        "pandoc",
      ])
    })

    test("getToolchainLines reports flake + direnv + packages via injected reader", () => {
      const lines = getToolchainLines("/proj", memReader(files))
      expect(lines.some(l => l.includes("direnv: flake-based"))).toBe(true)
      expect(lines.some(l => l.includes("nix flake: locked"))).toBe(true)
      expect(lines.some(l => l.includes("flake packages: python312Packages.graphrag, pandoc"))).toBe(true)
    })

    test("getToolchainLines marks unlocked when no flake.lock", () => {
      const noLock = { ...files, "flake.lock": "" }
      const lines = getToolchainLines("/proj", memReader(noLock))
      expect(lines.some(l => l.includes("nix flake: unlocked"))).toBe(true)
    })

    test("toolchain section omitted when no envrc or flake", () => {
      const ctx = buildContext("/empty", { toolchain: true, datetime: false, platform: false }, memReader({}))
      expect(ctx).toBe("")
    })

    test("toolchain note omits description when absent", () => {
      const flakeNoDesc = '{ outputs = { self, nixpkgs }: { devShells.x86_64-linux.default = nixpkgs.mkShell { buildInputs = [ pkgs.bash ]; }; }; };'
      const lines = getToolchainLines("/p", memReader({ "flake.nix": flakeNoDesc, "flake.lock": "{}" }))
      expect(lines.some(l => l.startsWith("nix flake: locked"))).toBe(true)
      expect(lines.some(l => l.includes(" — "))).toBe(false)
    })

    test("direnv asdf and nix detection", () => {
      expect(getToolchainLines("/p", memReader({ ".envrc": "use asdf" })))
        .toEqual(["direnv: asdf"])
      expect(getToolchainLines("/p", memReader({ ".envrc": "use nix" })))
        .toEqual(["direnv: nix"])
    })

    test("nativeBuildInputs parsed", () => {
      const flake = "{ outputs = { self, nixpkgs }: { devShells.x86_64-linux.default = nixpkgs.mkShell { nativeBuildInputs = [ pkgs.gcc pkgs.cmake ]; }; }; };"
      expect(extractFlakePackages(flake)).toEqual(["gcc", "cmake"])
    })
  })

  describe("buildContext flag permutations", () => {
    test("all flags on yields all three sections in order", () => {
      const ctx = buildContext("/proj", { datetime: true, platform: true, toolchain: true }, memReader({ ".envrc": "use flake" }))
      const iDatetime = ctx.indexOf(DATETIME_HEADER)
      const iPlatform = ctx.indexOf(PLATFORM_HEADER)
      const iToolchain = ctx.indexOf(TOOLCHAIN_HEADER)
      expect(iDatetime).toBeGreaterThanOrEqual(0)
      expect(iPlatform).toBeGreaterThan(iDatetime)
      expect(iToolchain).toBeGreaterThan(iPlatform)
      expect(ctx).toContain("\n\n")
    })

    test("each flag independently toggles its section", () => {
      const datetimeOnly = buildContext("/proj", { datetime: true, platform: false, toolchain: false }, memReader({}))
      expect(datetimeOnly).toContain(DATETIME_HEADER)
      expect(datetimeOnly).not.toContain(PLATFORM_HEADER)
      expect(datetimeOnly).not.toContain(TOOLCHAIN_HEADER)

      const platformOnly = buildContext("/proj", { datetime: false, platform: true, toolchain: false }, memReader({}))
      expect(platformOnly).toContain(PLATFORM_HEADER)
      expect(platformOnly).not.toContain(DATETIME_HEADER)
      expect(platformOnly).not.toContain(TOOLCHAIN_HEADER)

      const toolchainOnly = buildContext("/proj", { datetime: false, platform: false, toolchain: true }, memReader({ ".envrc": "use nix" }))
      expect(toolchainOnly).toContain(TOOLCHAIN_HEADER)
      expect(toolchainOnly).not.toContain(DATETIME_HEADER)
      expect(toolchainOnly).not.toContain(PLATFORM_HEADER)
    })

    test("all flags off yields empty string", () => {
      expect(buildContext("/proj", { datetime: false, platform: false, toolchain: false }, memReader({}))).toBe("")
    })

    test("toolchain-only with no toolchain files yields empty", () => {
      expect(buildContext("/empty", { datetime: false, platform: false, toolchain: true }, memReader({}))).toBe("")
    })
  })

  describe("cadence split (static per session vs per-message)", () => {
    const files = { ".envrc": "use flake" }

    test("buildStaticContext carries platform and toolchain, never datetime", () => {
      const ctx = buildStaticContext("/proj", { platform: true, toolchain: true, datetime: true }, memReader(files))
      expect(ctx).toContain(PLATFORM_HEADER)
      expect(ctx).toContain(TOOLCHAIN_HEADER)
      expect(ctx).not.toContain(DATETIME_HEADER)
    })

    test("buildStaticContext omits platform when flag off", () => {
      const ctx = buildStaticContext("/proj", { platform: false, toolchain: true, datetime: true }, memReader(files))
      expect(ctx).not.toContain(PLATFORM_HEADER)
      expect(ctx).toContain(TOOLCHAIN_HEADER)
    })

    test("buildPerMessageContext is datetime-only", () => {
      const ctx = buildPerMessageContext({ datetime: true, platform: true, toolchain: true })
      expect(ctx).toContain(DATETIME_HEADER)
      expect(ctx).not.toContain(PLATFORM_HEADER)
      expect(ctx).not.toContain(TOOLCHAIN_HEADER)
    })

    test("buildPerMessageContext empty when datetime disabled", () => {
      expect(buildPerMessageContext({ datetime: false })).toBe("")
    })

    test("buildSessionContext carries datetime + platform + toolchain", () => {
      const ctx = buildSessionContext("/proj", { datetime: true, platform: true, toolchain: true }, memReader(files))
      expect(ctx).toContain(DATETIME_HEADER)
      expect(ctx).toContain(PLATFORM_HEADER)
      expect(ctx).toContain(TOOLCHAIN_HEADER)
    })
  })

  describe("dedup markers", () => {
    test("STABLE_MARKERS contains the three section headers", () => {
      expect(STABLE_MARKERS).toEqual([DATETIME_HEADER, PLATFORM_HEADER, TOOLCHAIN_HEADER])
    })

    test("hasAnyMarker detects an already-injected system", () => {
      const injected = [`${DATETIME_HEADER}: 07 Aug 2026, 13:20:05 UTC]\n\n${PLATFORM_HEADER}`]
      expect(hasAnyMarker(injected)).toBe(true)
    })

    test("hasAnyMarker returns false for marker-free system", () => {
      expect(hasAnyMarker(["standard system prompt"])).toBe(false)
      expect(hasAnyMarker([])).toBe(false)
    })

    test("hasAnyMarker matches on prefix even when timestamp differs (the stacking fix)", () => {
      const before = [`${DATETIME_HEADER}: 01 Jan 2024, 00:00:00 UTC]`]
      expect(hasAnyMarker(before)).toBe(true)
    })
  })
})

describe("datetime-inject plugin hooks", () => {
  async function loadHooks(opts: Record<string, unknown> = {}) {
    const mod = await import(`./index.ts?${Date.now()}`)
    return mod.default({ directory: REPO_ROOT, worktree: REPO_ROOT }, opts)
  }

  test("plugin registers both hooks", async () => {
    const hooks = await loadHooks()
    expect(hooks["chat.message"]).toBeDefined()
    expect(hooks["experimental.chat.system.transform"]).toBeDefined()
  })

  test("chat.message prepends datetime to text part", async () => {
    const hooks = await loadHooks()
    const output = { parts: [{ type: "text", text: "what time is it?" }] }
    await hooks["chat.message"]({}, output)
    expect(output.parts[0].text.startsWith(DATETIME_HEADER)).toBe(true)
    expect(output.parts[0].text).toContain("what time is it?")
  })

  test("chat.message does NOT duplicate session-static sections on each message", async () => {
    // Frequency fix: platform/toolchain live in the system prompt (once per
    // session); per-message injection is datetime-only.
    const hooks = await loadHooks()
    const output = { parts: [{ type: "text", text: "again" }] }
    await hooks["chat.message"]({}, output)
    expect(output.parts[0].text).toContain(DATETIME_HEADER)
    expect(output.parts[0].text).not.toContain(PLATFORM_HEADER)
    expect(output.parts[0].text).not.toContain(TOOLCHAIN_HEADER)
  })

  test("chat.message leaves empty text untouched", async () => {
    const hooks = await loadHooks()
    const output = { parts: [{ type: "text", text: "   " }] }
    await hooks["chat.message"]({}, output)
    expect(output.parts[0].text).toBe("   ")
  })

  test("chat.message leaves messages without text part untouched", async () => {
    const hooks = await loadHooks()
    const output = { parts: [] as Array<{ type: string; text: string }> }
    await hooks["chat.message"]({}, output)
    expect(output.parts).toEqual([])
  })

  test("chat.message adds data to non-text parts", async () => {
    const hooks = await loadHooks()
    const output = { parts: [{ type: "tool", tool: "bash", args: { command: "ls" } }] }
    await hooks["chat.message"]({}, output)
    expect(output.parts[0].type).toBe("tool")
  })

  test("system.transform injects session-static context once, then dedups (no stacking)", async () => {
    const hooks = await loadHooks()
    const output = { system: ["base system prompt"] }
    await hooks["experimental.chat.system.transform"]({}, output)
    expect(output.system[0]).toContain(PLATFORM_HEADER)
    expect(hasAnyMarker(output.system)).toBe(true)
    expect(output.system.length).toBe(2)

    await hooks["experimental.chat.system.transform"]({}, output)
    expect(output.system.length).toBe(2)
  })

  test("system.transform carries platform and toolchain but not datetime", async () => {
    const hooks = await loadHooks()
    const output = { system: ["base"] }
    await hooks["experimental.chat.system.transform"]({}, output)
    expect(output.system[0]).toContain(PLATFORM_HEADER)
    expect(output.system[0]).toContain(TOOLCHAIN_HEADER)
    expect(output.system[0]).not.toContain(DATETIME_HEADER)
  })

  test("system.transform respects injectIntoSystem=false", async () => {
    const hooks = await loadHooks({ injectIntoSystem: false })
    const output = { system: ["base"] }
    await hooks["experimental.chat.system.transform"]({}, output)
    expect(hasAnyMarker(output.system)).toBe(false)
    expect(output.system).toEqual(["base"])
  })

  test("system.transform skips when marker already present", async () => {
    const hooks = await loadHooks()
    const output = { system: [`${PLATFORM_HEADER} already here`] }
    await hooks["experimental.chat.system.transform"]({}, output)
    expect(output.system.length).toBe(1)
  })

  test("system-only mode injects nothing per message (injectDatetimePerMessage=false)", async () => {
    const hooks = await loadHooks({ injectDatetimePerMessage: false })
    const msg = { parts: [{ type: "text", text: "hi" }] }
    await hooks["chat.message"]({}, msg)
    expect(msg.parts[0].text).toBe("hi")
  })

  test("system-only mode puts datetime into system context", async () => {
    const hooks = await loadHooks({ injectDatetimePerMessage: false })
    const output = { system: ["base"] }
    await hooks["experimental.chat.system.transform"]({}, output)
    expect(output.system[0]).toContain(DATETIME_HEADER)
    expect(output.system[0]).toContain(PLATFORM_HEADER)
    expect(output.system.length).toBe(2)
  })
})
