/**
 * Calculator backends for the `calc` / `calc_probe` tools (general-skills plugin).
 *
 * Why this exists: a language model's arithmetic is generated, not computed.
 * Multi-digit products, unit conversions, percentages, date spans and
 * statistics come out fluent and plausible, and are wrong often enough to
 * poison a report. The fix is mechanical, not aspirational: every number that
 * reaches the user is produced by a real calculator run in this session, and
 * the engine plus the expression is named alongside it.
 *
 * Design: engines are data (argv + stdin), execution is injected (`SpawnFn`),
 * so the registry, the availability probe, the engine picker, the output
 * cleaners and the missing-tool install proposals are all testable without a
 * host, a shell, or a network. Nothing in this file touches Bun.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type EngineId = "qalc" | "numbat" | "bc" | "python" | "sympy" | "maxima"

export type SpawnResult = { stdout: string; stderr: string; exitCode: number }
export type SpawnFn = (argv: string[], input?: string) => Promise<SpawnResult>

export type EngineSpec = {
  id: EngineId
  /** binary probed for availability, and the head of every argv */
  binary: string
  argv: (expr: string) => string[]
  /** stdin payload for engines that read the expression from stdin */
  input?: (expr: string) => string
  /** package name per installer family, used verbatim in proposals */
  nix: string
  pacman: string
  apt: string
  dnf: string
  brew: string
  good: string
  limits: string
  versionArgs: string[]
}

export type Availability = Record<EngineId, boolean>

export type CalcOutcome = {
  ok: boolean
  engine: EngineId
  argv: string[]
  output: string
  error?: string
}

// ---------------------------------------------------------------------------
// Engine registry
// ---------------------------------------------------------------------------

/**
 * Maxima echoes its input as `(%i1) …` and labels every result `(%o1) …`, with
 * multi-line pretty-printed math underneath the label. Keep the result blocks
 * only, strip the label, and join the wrapped lines of one result.
 */
export function cleanMaxima(raw: string): string {
  const blocks: string[] = []
  let cur: string[] | null = null
  const flush = () => {
    if (cur && cur.length) blocks.push(cur.join(" ").replace(/\s+/g, " ").trim())
    cur = null
  }
  for (const line of raw.split("\n")) {
    const result = line.match(/^\(%o\d+\)\s*(.*)$/)
    if (result) {
      flush()
      cur = [result[1]]
      continue
    }
    if (/^\(%i\d+\)/.test(line.trim()) || line.trim() === "") {
      flush()
      continue
    }
    if (cur) cur.push(line.trim())
  }
  flush()
  return blocks.join("\n").trim()
}

/** qalc reports some parse failures with exit 0 and an `error:` line on stdout;
 *  others exit non-zero and print a partial rendering (e.g. `sqrt(` → `√()`).
 *  Treat both shapes as failure — a rendered fragment is not a result. */
export function engineFailure(engine: EngineId, res: SpawnResult): string | null {
  const out = `${res.stdout}\n${res.stderr}`
  if (res.exitCode !== 0) return `exit ${res.exitCode}: ${res.stderr.trim() || res.stdout.trim() || "no output"}`
  if (/^\s*error:/m.test(out)) return out.trim().split("\n").find(l => /^\s*error:/m.test(l)) ?? "error"
  return null
}

/** Terse qalc: result only, capped at 5 s so a hung unit/currency fetch cannot stall a turn. */
const QALC_TIMEOUT_MS = 5000

export const ENGINES: Record<EngineId, EngineSpec> = {
  qalc: {
    id: "qalc",
    binary: "qalc",
    argv: e => ["qalc", "-t", "-m", String(QALC_TIMEOUT_MS), e],
    versionArgs: ["--version"],
    nix: "libqalculate",
    pacman: "libqalculate",
    apt: "qalc",
    dnf: "libqalculate",
    brew: "qalculate-gtk",
    good:
      "units + currencies, arbitrary precision, symbolic (diff/solve/factor/matrix), statistics (mean/median/var/stdev), date-time arithmetic, number bases — no integration (use maxima/sympy)",
    limits: "no `simplify` and no definite/indefinite integration: `int(…)` is the integer-part function; first interactive run asks two setup prompts",
  },
  numbat: {
    id: "numbat",
    binary: "numbat",
    argv: e => ["numbat", "-e", e],
    versionArgs: ["--version"],
    nix: "numbat",
    pacman: "numbat",
    apt: "numbat",
    dnf: "numbat",
    brew: "numbat",
    good: "dimension-checked scientific computation — unit errors are compile errors, not silent bugs",
    limits: "no symbolic CAS; own expression syntax (`->` for conversion)",
  },
  bc: {
    id: "bc",
    binary: "bc",
    argv: () => ["bc", "-l"],
    input: e => `${e.trim().endsWith(";") ? e : `${e};`}\n`,
    versionArgs: ["--version"],
    nix: "bc",
    pacman: "bc",
    apt: "bc",
    dnf: "bc",
    brew: "bc",
    good: "POSIX arithmetic in pipelines and scripts; `-l` gives scale 20 plus exp/ln/sin/atan",
    limits: "numeric only — no units, no symbols",
  },
  python: {
    id: "python",
    binary: "python3",
    argv: e => ["python3", "-c", pythonSource(e)],
    versionArgs: ["--version"],
    nix: "python3",
    pacman: "python",
    apt: "python3",
    dnf: "python3",
    brew: "python",
    good: "full numeric standard library: math, statistics, itertools, fractions, decimal, datetime",
    limits: "IEEE double precision; symbolic math needs `sympy`",
  },
  sympy: {
    id: "sympy",
    binary: "uv",
    argv: e => ["uv", "run", "--with", "sympy", "python", "-c", sympySource(e)],
    versionArgs: ["--version"],
    nix: "uv (then uv run --with sympy)",
    pacman: "uv",
    apt: "uv (then uv run --with sympy)",
    dnf: "uv (then uv run --with sympy)",
    brew: "uv (then uv run --with sympy)",
    good: "exact symbolic CAS in one call — solve, integrate, series, matrices, limits",
    limits: "needs `uv`; first run fetches sympy (network)",
  },
  maxima: {
    id: "maxima",
    binary: "maxima",
    // --batch-string runs commands non-interactively; --very-quiet drops the
    // `(%o1)` expression labels; -Q exits non-zero on error so a failed
    // derivation can never look like a result.
    argv: e => ["maxima", "--very-quiet", "--suppress-input-echo", "-Q", "--batch-string", maximaCommands(e)],
    versionArgs: ["--version"],
    nix: "maxima",
    pacman: "maxima",
    apt: "maxima",
    dnf: "maxima",
    brew: "maxima",
    good: "mature CAS: integrate/solve/limit/sum/odes, exact rationals, tensor algebra",
    limits: "slow start (~1 s); Maxima syntax with `;` terminators, not infix C-style",
  },
}

/** Preferred engine order when the caller does not name one. */
export const ENGINE_PRIORITY: EngineId[] = ["qalc", "numbat", "bc", "python", "maxima", "sympy"]

export function pythonSource(expr: string): string {
  return `import math, statistics, itertools, fractions, decimal, datetime\nprint(${expr})\n`
}

/**
 * Sympy source.
 *
 * Sympy ≥ 1.13 no longer defines `x`, `y`, `z`, `t` on `import *`, so a bare
 * `print(<expr>)` dies with `NameError: name 'x' is not defined`. Route the
 * expression through `parse_expr`: its standard transformations create a Symbol
 * for every undefined name, so `integrate(x**2*exp(x), (x,0,1))` works with no
 * symbol bookkeeping from the caller.
 *
 * The expression is embedded as a JSON string literal — JSON string escapes are
 * valid Python, which keeps quotes, newlines and backslashes in the caller's
 * expression from breaking the generated source.
 */
export function sympySource(expr: string): string {
  return [
    "from sympy import *",
    "from sympy.parsing.sympy_parser import parse_expr",
    `print(parse_expr(${JSON.stringify(expr)}, evaluate=True))`,
    "",
  ].join("\n")
}

/** Maxima statements are `;`-terminated (`$` suppresses output of one). */
export function maximaCommands(expr: string): string {
  const t = expr.trim()
  if (!t) return t
  return /[$;]\s*$/.test(t) ? t : `${t};`
}

// ---------------------------------------------------------------------------
// Availability + install proposals
// ---------------------------------------------------------------------------

export async function probeEngines(spawn: SpawnFn): Promise<Availability> {
  const ids = Object.keys(ENGINES) as EngineId[]
  const results = await Promise.all(
    ids.map(async id => {
      try {
        const r = await spawn([ENGINES[id].binary, ...ENGINES[id].versionArgs])
        return [id, r.exitCode === 0] as const
      } catch {
        return [id, false] as const
      }
    }),
  )
  const out = {} as Availability
  for (const [id, ok] of results) out[id] = ok
  return out
}

export type OsFamily = "nixos" | "arch" | "deb" | "rpm" | "mac" | "unknown"

/** `/etc/os-release` ID → installer family. */
export function osFamilyFromId(id: string | undefined): OsFamily {
  const i = (id ?? "").toLowerCase()
  if (i === "nixos") return "nixos"
  if (["cachyos", "arch", "manjaro", "endeavouros", "garuda", "arcolinux", "void"].includes(i)) return "arch"
  if (["debian", "ubuntu", "linuxmint", "pop", "elementary", "raspbian"].includes(i)) return "deb"
  if (["fedora", "rhel", "centos", "almalinux", "rocky", "opensuse-tumbleweed", "opensuse", "fedora-atomic"].includes(i)) return "rpm"
  if (i === "darwin" || i === "macos") return "mac"
  return "unknown"
}

/** Parse `ID=` (and `ID_LIKE=`) out of `/etc/os-release` text. */
export function parseOsRelease(text: string): string | undefined {
  const line = text.split("\n").find(l => /^ID=/.test(l))
  if (!line) return undefined
  return line.slice(3).trim().replace(/^"|"$/g, "")
}

/**
 * OS family, from an injected reader (tests supply fake content, the plugin
 * supplies a real file read). Darwin is detected by `uname`, so the reader is
 * paired with a platform string.
 */
export function detectOsFamily(
  read: (path: string) => string | null,
  platform: string,
): OsFamily {
  if (platform === "darwin") return "mac"
  const text = read("/etc/os-release")
  if (!text) return "unknown"
  const id = parseOsRelease(text)
  const family = osFamilyFromId(id)
  if (family !== "unknown") return family
  // No usable ID= — fall back to ID_LIKE=, which cachyos and many derivatives set.
  const like = text
    .split("\n")
    .find(l => /^ID_LIKE=/.test(l))
    ?.slice(8)
    .trim()
    .replace(/^"|"$/g, "")
  for (const token of (like ?? "").split(/\s+/)) {
    const f = osFamilyFromId(token)
    if (f !== "unknown") return f
  }
  return "unknown"
}

/** The exact, copy-pasteable install action for one engine on one OS family. */
export function installPlan(id: EngineId, family: OsFamily): string[] {
  const s = ENGINES[id]
  switch (family) {
    case "nixos":
      // The shared per-user module covers every user on every host, and also
      // the standalone home-manager deployment used on non-NixOS hosts.
      return [`add pkgs.${s.nix} to home.packages in users/common-hm.nix, then: sudo nixos-rebuild switch --flake ./`]
    case "arch":
      return [`sudo pacman -S ${s.pacman}`]
    case "deb":
      return [`sudo apt-get install -y ${s.apt}`]
    case "rpm":
      return [`sudo dnf install -y ${s.dnf}`]
    case "mac":
      return [`brew install ${s.brew}`]
    default:
      return [`install "${s.binary}" with this system's package manager (nixpkgs: ${s.nix}, pacman: ${s.pacman}, apt: ${s.apt})`]
  }
}

/** Availability report the probe tool returns: engine, state, capability, and
 *  the proposal for every missing engine. Deterministic and testable. */
export function formatProbeReport(avail: Availability, family: OsFamily): string {
  const ids = Object.keys(ENGINES) as EngineId[]
  const lines: string[] = []
  lines.push(`OS family: ${family}`)
  lines.push("")
  lines.push("engine    state      best for")
  for (const id of ids) {
    const s = ENGINES[id]
    lines.push(`${id.padEnd(9)} ${(avail[id] ? "ready" : "MISSING").padEnd(10)} ${s.good}`)
  }
  const missing = ids.filter(id => !avail[id])
  lines.push("")
  if (missing.length === 0) {
    lines.push("all engines ready — no install needed")
  } else {
    lines.push("install proposals (propose, never silently skip the calculation):")
    for (const id of missing) lines.push(`  ${id}: ${installPlan(id, family).join(" ")}`)
  }
  return lines.join("\n")
}

/**
 * Engine picker for `engine: "auto"`.
 * Numbat arrow syntax means the caller is already writing in numbat.
 * Otherwise take the most capable engine that is installed.
 */
export function pickEngine(expr: string, avail: Availability): EngineId | null {
  if (/(^|\s)->\s/.test(expr) && avail.numbat) return "numbat"
  for (const id of ENGINE_PRIORITY) if (avail[id]) return id
  return null
}

/** Proposal text returned when nothing is installed: a calculation must be
 *  delegated, so the answer to the user is "install X", never a mental guess. */
export function noEngineProposal(family: OsFamily): string {
  const lines = ["no calculator engine is installed — do NOT compute this by mental arithmetic."]
  for (const id of ENGINE_PRIORITY) lines.push(`  ${id}: ${installPlan(id, family).join(" ")}`)
  lines.push("propose the install to the user and ask which to run; qalc covers most needs.")
  return lines.join("\n")
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

/**
 * Run one expression through one engine.
 * `timeoutMs` bounds the whole child: a hung currency fetch or a Maxima loop
 * must not eat the turn. On timeout the outcome says so — it never returns a
 * made-up number.
 */
export async function runEngine(
  id: EngineId,
  expr: string,
  spawn: SpawnFn,
  timeoutMs = 20000,
): Promise<CalcOutcome> {
  const spec = ENGINES[id]
  const argv = spec.argv(expr)
  const input = spec.input ? spec.input(expr) : undefined
  let timedOut = false
  const work = spawn(argv, input)
  const raced = new Promise<SpawnResult>(resolve => {
    const t = setTimeout(() => {
      timedOut = true
      resolve({ stdout: "", stderr: `timed out after ${timeoutMs} ms`, exitCode: 124 })
    }, timeoutMs)
    t.unref?.()
    work.then(r => {
      clearTimeout(t)
      resolve(r)
    })
  })
  const res = await raced
  const fail = engineFailure(id, res)
  const raw = (res.stdout || "") + (res.stderr && !res.stdout ? `\n${res.stderr}` : "")
  const output = id === "maxima" ? cleanMaxima(raw) : raw.trim()
  if (fail) return { ok: false, engine: id, argv, output, error: timedOut ? `timeout after ${timeoutMs} ms` : fail }
  return { ok: true, engine: id, argv, output: output || "(no output)" }
}

/** Provenance line: every reported number names its engine and expression. */
export function formatOutcome(o: CalcOutcome, expr: string): string {
  const cmd = renderCommand(o.argv)
  if (!o.ok) {
    return `FAILED engine=${o.engine} expr=${expr}\n${o.error ?? o.output}\ncommand: ${cmd}\nDo not report any number from this attempt. Fix the expression, switch engine, or propose an install.`
  }
  return `engine=${o.engine} expr=${expr}\n${o.output}\ncommand: ${cmd}`
}

/**
 * Re-runnable form of the invocation. Multi-line argv members (the `-c` source
 * for python/sympy, the `--batch-string` for maxima) collapse to a size marker
 * so the provenance line stays one line; long sources are capped.
 */
export function renderCommand(argv: string[], maxLen = 240): string {
  const s = argv
    .map(a => (a.includes("\n") ? `<source ${a.length} chars>` : /\s/.test(a) ? JSON.stringify(a) : a))
    .join(" ")
  return s.length > maxLen ? `${s.slice(0, maxLen - 1)}…` : s
}
