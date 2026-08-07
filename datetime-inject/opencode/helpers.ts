import os from "os"
import path from "path"
import { readFileSync } from "fs"

export type Flags = {
  datetime: boolean
  platform: boolean
  toolchain: boolean
}

export const DEFAULT_FLAGS: Flags = {
  datetime: true,
  platform: true,
  toolchain: true,
}

export const DATETIME_HEADER = "[current datetime"
export const PLATFORM_HEADER = "[platform]"
export const TOOLCHAIN_HEADER = "[toolchain]"
export const STABLE_MARKERS = [DATETIME_HEADER, PLATFORM_HEADER, TOOLCHAIN_HEADER]

export function currentDatetime(): string {
  return new Date().toLocaleString("en-GB", {
    timeZone: "UTC",
    dateStyle: "medium",
    timeStyle: "medium",
    hour12: false,
  })
}

export function datetimeNote(): string {
  return `${DATETIME_HEADER}: ${currentDatetime()} UTC]`
}

export function readText(p: string): string {
  try {
    return readFileSync(p, "utf-8")
  } catch {
    return ""
  }
}

export function readOsRelease(): string {
  for (const p of ["/etc/os-release", "/usr/lib/os-release"]) {
    const txt = readText(p)
    const pretty = txt.match(/^PRETTY_NAME="?([^"\n]+)"?/m)
    const id = txt.match(/^ID=(\w+)/m)
    if (pretty?.[1] || id?.[1]) return pretty?.[1] ?? id![1]
  }
  return `${os.platform()} (${os.type()})`
}

export function readDistroId(): string {
  for (const p of ["/etc/os-release", "/usr/lib/os-release"]) {
    const m = readText(p).match(/^ID=(\w+)/m)
    if (m?.[1]) return m[1]
  }
  return ""
}

export function packageManagerFor(id: string): string {
  const d = id.toLowerCase()
  if (d.includes("cachyos") || d.includes("arch")) return "pacman / paru"
  if (d.includes("fedora")) return "dnf"
  if (d.includes("ubuntu") || d.includes("debian")) return "apt"
  if (d.includes("nixos")) return "nix"
  return ""
}

export function graphicsPlatform(): string | undefined {
  if (process.env.WAYLAND_DISPLAY) return "Wayland"
  if (process.env.DISPLAY) return "X11"
  return undefined
}

export function platformNote(): string {
  const lines = [
    PLATFORM_HEADER,
    `System: ${readOsRelease()}`,
    `CPU: ${os.cpus().length} cores (${os.arch()})`,
    `Memory: ${Math.round(os.totalmem() / 1024 ** 3)} GiB`,
  ]
  const pm = packageManagerFor(readDistroId())
  if (pm) lines.push(`Package manager: ${pm}`)
  const gpm = graphicsPlatform()
  if (gpm) lines.push(`Graphics platform: ${gpm}`)
  return lines.join("\n")
}

export function extractFlakePackages(flake: string): string[] {
  const pkgs: string[] = []
  const patterns = [
    /buildInputs\s*=\s*\[([\s\S]*?)\]\s*;/,
    /nativeBuildInputs\s*=\s*\[([\s\S]*?)\]\s*;/,
    /packages\s*=\s*\[([\s\S]*?)\]\s*;/,
  ]
  for (const re of patterns) {
    const section = flake.match(re)
    if (!section) continue
    for (const m of section[1].matchAll(/pkgs\.([a-zA-Z][\w.-]*)/g)) {
      if (!pkgs.includes(m[1])) pkgs.push(m[1])
    }
  }
  return pkgs
}

export function getToolchainLines(root: string, textReader: (p: string) => string = readText): string[] {
  const lines: string[] = []
  const envrc = textReader(path.join(root, ".envrc"))
  const flake = textReader(path.join(root, "flake.nix"))

  if (envrc) {
    if (envrc.includes("use flake")) lines.push("direnv: flake-based (use flake)")
    else if (envrc.includes("use asdf")) lines.push("direnv: asdf")
    else if (envrc.includes("use nix")) lines.push("direnv: nix")
    else lines.push(`direnv: ${envrc.trim().split("\n")[0]}`)
  }
  if (flake) {
    const locked = textReader(path.join(root, "flake.lock")) !== ""
    const desc = flake.match(/description\s*=\s*"([^"]+)"/)?.[1]?.trim() ?? ""
    lines.push(
      `nix flake: ${locked ? "locked" : "unlocked (no flake.lock)"}${desc ? ` — ${desc}` : ""}`,
    )
    const pkgs = extractFlakePackages(flake)
    if (pkgs.length) lines.push(`flake packages: ${pkgs.join(", ")}`)
  }
  return lines
}

export function toolchainNote(root: string, textReader?: (p: string) => string): string {
  const lines = getToolchainLines(root, textReader)
  if (!lines.length) return ""
  return `${TOOLCHAIN_HEADER}\n${lines.join("\n")}`
}

export function buildContext(root: string, flags: Flags = DEFAULT_FLAGS, textReader?: (p: string) => string): string {
  const parts: string[] = []
  if (flags.datetime) parts.push(datetimeNote())
  if (flags.platform) parts.push(platformNote())
  if (flags.toolchain) {
    const tc = toolchainNote(root, textReader)
    if (tc) parts.push(tc)
  }
  return parts.join("\n\n")
}

export function hasAnyMarker(system: string[]): boolean {
  return system.some(s => STABLE_MARKERS.some(m => s.includes(m)))
}
