import { describe, test, expect } from "bun:test"
import pluginFactory from "./index"
import { STE100_MARKER, STE100_RULE } from "./ste100-rule"
import { CALC_MARKER, CALC_RULE } from "./calc-rule"
import {
  ENGINES,
  cleanMaxima,
  detectOsFamily,
  engineFailure,
  formatOutcome,
  formatProbeReport,
  installPlan,
  maximaCommands,
  maximaFailure,
  noEngineProposal,
  osFamilyFromId,
  parseOsRelease,
  pickEngine,
  probeEngines,
  pythonSource,
  renderCommand,
  runEngine,
  sympySource,
  type Availability,
  type SpawnFn,
} from "./calc-tool"

const noopClient = {
  app: {
    log: async () => true,
  },
}

describe("general-skills STE-100 system injection", () => {
  test("STE100_RULE starts with the stable marker", () => {
    expect(STE100_RULE.startsWith(STE100_MARKER)).toBe(true)
  })

  test("STE100_RULE names ASD-STE100", () => {
    expect(STE100_RULE).toContain("ASD-STE100 Simplified Technical English")
  })

  test("STE100_RULE covers all ten requirements", () => {
    const reqs = [
      "Approved vocabulary",
      "One meaning per word",
      "Short sentences",
      "Active voice",
      "Simple grammar",
      "Avoid abbreviations",
      "Clarity over style",
      "Structured writing",
      "Sequencing",
      "Negative commands",
    ]
    for (const r of reqs) expect(STE100_RULE).toContain(r)
  })

  test("STE100_RULE states scope applies to technical/scientific and exempts chat", () => {
    expect(STE100_RULE).toContain("technical or scientific")
    expect(STE100_RULE).toContain("conversational chat")
  })

  test("system.transform injects both rules, calc first then STE-100", async () => {
    const plugin = await (pluginFactory as any).server({ client: noopClient } as any)
    const output = { system: ["existing system"] }
    await plugin["experimental.chat.system.transform"]({} as any, output)
    expect(output.system).toHaveLength(3)
    expect(output.system[0].startsWith(CALC_MARKER)).toBe(true)
    expect(output.system[1].startsWith(STE100_MARKER)).toBe(true)
    expect(output.system[2]).toBe("existing system")
  })

  test("system.transform does not duplicate when marker already present", async () => {
    const plugin = await (pluginFactory as any).server({ client: noopClient } as any)
    const output = { system: [STE100_RULE, "existing system"] }
    await plugin["experimental.chat.system.transform"]({} as any, output)
    expect(output.system).toHaveLength(3)
    expect(output.system.filter(s => s.includes(STE100_MARKER))).toHaveLength(1)
  })

  test("system.transform does not duplicate the calc rule", async () => {
    const plugin = await (pluginFactory as any).server({ client: noopClient } as any)
    const output = { system: [CALC_RULE, "existing system"] }
    await plugin["experimental.chat.system.transform"]({} as any, output)
    expect(output.system.filter(s => s.includes(CALC_MARKER))).toHaveLength(1)
  })

  test("system.transform handles an empty system array", async () => {
    const plugin = await (pluginFactory as any).server({ client: noopClient } as any)
    const output = { system: [] }
    await plugin["experimental.chat.system.transform"]({} as any, output)
    expect(output.system).toHaveLength(2)
    expect(output.system[0].startsWith(CALC_MARKER)).toBe(true)
    expect(output.system[1].startsWith(STE100_MARKER)).toBe(true)
  })
})

// Fake host: keyed by binary name, so a probe or a run resolves without a shell.
function fakeHost(script: Record<string, { stdout?: string; stderr?: string; code?: number }>): SpawnFn & { calls: string[][] } {
  const calls: string[][] = []
  const fn = (async (argv: string[], input?: string) => {
    calls.push(argv.concat(input ? [input] : []))
    const hit = script[argv[0]]
    if (!hit) return { stdout: "", stderr: `sh: ${argv[0]}: command not found`, exitCode: 127 }
    return { stdout: hit.stdout ?? "", stderr: hit.stderr ?? "", exitCode: hit.code ?? 0 }
  }) as SpawnFn & { calls: string[][] }
  fn.calls = calls
  return fn
}

const ALL_READY = fakeHost({
  qalc: { stdout: "Qalculate! 5.13.1\n" },
  numbat: { stdout: "numbat 1.24.0\n" },
  bc: { stdout: "bc 1.08.2\n" },
  python3: { stdout: "Python 3.13.5\n" },
  uv: { stdout: "uv 0.7.0\n" },
  maxima: { stdout: "Maxima 5.50.0\n" },
})

describe("calc rule", () => {
  test("CALC_RULE starts with the marker and names the engines", () => {
    expect(CALC_RULE.startsWith(CALC_MARKER)).toBe(true)
    for (const needle of ["qalc", "numbat", "bc -l", "python3", "sympy", "maxima", "calc_probe"]) {
      expect(CALC_RULE).toContain(needle)
    }
  })

  test("CALC_RULE forbids estimation and requires a stated source", () => {
    expect(CALC_RULE).toContain("Do not compute them by estimation")
    expect(CALC_RULE).toContain("Do not state a specific number")
    expect(CALC_RULE).toContain("the engine and the expression")
    expect(CALC_RULE).toContain("propose the install")
    expect(CALC_RULE).toContain("Report the difference")
    expect(CALC_RULE).toContain("Do not combine them into one value")
  })

  test("CALC_RULE names the qalc name check and the no-integration limits", () => {
    expect(CALC_RULE).toContain("qalc --list-functions")
    expect(CALC_RULE).toContain("no integration")
    expect(CALC_RULE).toContain("maxima or sympy")
  })

  test("v1 registers the calc and calc_probe tools", async () => {
    const plugin = await (pluginFactory as any).server({ client: noopClient } as any)
    expect(typeof plugin.tool.calc.execute).toBe("function")
    expect(typeof plugin.tool.calc_probe.execute).toBe("function")
  })
})

describe("calc engine registry", () => {
  test("qalc runs terse with a time cap; numbat uses -e; bc/maxima read via argv/stdin", () => {
    expect(ENGINES.qalc.argv("2^10")).toEqual([
      "qalc",
      "-t",
      "-m",
      "5000",
      "-s",
      "decimal_comma 0",
      "2^10",
    ])
    expect(ENGINES.numbat.argv("150 km/h -> mph")).toEqual(["numbat", "-e", "150 km/h -> mph"])
    expect(ENGINES.bc.argv("1+1")).toEqual(["bc", "-l"])
    expect(ENGINES.bc.input!("1+1")).toBe("1+1;\n")
    expect(ENGINES.maxima.argv("integrate(x^2,x)")).toEqual([
      "maxima",
      "-q",
      "--batch-string",
      'printf(true, "~a", integrate(x^2,x));',
    ])
    expect(ENGINES.sympy.argv("solve(x**2-2)").slice(0, 4)).toEqual(["uv", "run", "--with", "sympy"])
  })

  test("python/sympy sources import the right namespaces", () => {
    expect(pythonSource("math.sqrt(2)")).toContain("import math")
    expect(pythonSource("math.sqrt(2)")).toContain("print(math.sqrt(2))")
    // sympy >=1.13 defines no x/y/z on `import *`, so the expression must go
    // through parse_expr, and it must be embedded as a quoted literal.
    expect(sympySource("integrate(x,x)")).toContain("from sympy.parsing.sympy_parser import parse_expr")
    expect(sympySource("integrate(x,x)")).toContain('print(parse_expr("integrate(x,x)", evaluate=True))')
    expect(sympySource('solve(x**2 == 4)')).toContain('"solve(x**2 == 4)"')
  })

  test("qalc argv forces a dot decimal separator (locale makes qalc print commas)", () => {
    const argv = ENGINES.qalc.argv("1/8")
    const i = argv.indexOf("-s")
    expect(i).toBeGreaterThan(-1)
    expect(argv[i + 1]).toBe("decimal_comma 0")
  })

  test("qalc is documented as having no integration", () => {
    expect(ENGINES.qalc.good).toContain("no integration")
    expect(ENGINES.qalc.limits).toContain("integer-part")
  })

  test("maximaCommands prints plain text for one expression, and passes statements through", () => {
    expect(maximaCommands("integrate(x,x)")).toBe('printf(true, "~a", integrate(x,x));')
    expect(maximaCommands("a: 1; b: a!;")).toBe("a: 1; b: a!;")
    expect(maximaCommands("kill(all)$")).toBe("kill(all)$")
    expect(maximaCommands("integrate(x,x);")).toBe("integrate(x,x);")
  })

  test("cleanMaxima keeps results, drops echoes and labels, unwraps pretty-print", () => {
    const raw = [
      "Maxima 5.50.0 https://maxima.sourceforge.io",
      "(%i1) integrate(x^2,x);",
      "                                  3",
      "(%o1)                          x",
      "                                 ---",
      "                                  3",
      "(%i2) ",
    ].join("\n")
    expect(cleanMaxima(raw)).toBe("x --- 3")
    expect(cleanMaxima("(%o1) 1.449489743\n(%i2) ")).toBe("1.449489743")
  })

  test("cleanMaxima reads the printf form the engine asks for", () => {
    // Live shape: echo, plain-text result, `false` label.
    const raw = [
      '(%i1) printf(true, "~a", integrate(x^2*e^x,x,0,1))',
      '(e*log(e)^2-2*e*log(e)+2*e)/log(e)^3-2/log(e)^3',
      '(%o1)                                      false',
      '(%i2) ',
    ].join("\n")
    expect(cleanMaxima(raw)).toBe("(e*log(e)^2-2*e*log(e)+2*e)/log(e)^3-2/log(e)^3")
  })

  test("cleanMaxima returns nothing for preamble-only output", () => {
    expect(cleanMaxima("Maxima 5.47.0 https://maxima.sourceforge.io\nusing Lisp SBCL 2.6.4\n")).toBe("")
  })
})

describe("calc availability and install proposals", () => {
  test("probeEngines marks every engine by exit code", async () => {
    const avail = await probeEngines(ALL_READY)
    expect(Object.values(avail)).toEqual([true, true, true, true, true, true])
    const partial = await probeEngines(fakeHost({ qalc: { stdout: "Qalculate!" }, bc: { stdout: "bc" } }))
    expect(partial.qalc).toBe(true)
    expect(partial.bc).toBe(true)
    expect(partial.numbat).toBe(false)
    expect(partial.maxima).toBe(false)
  })

  test("pickEngine: qalc default, numbat for arrow syntax, null when nothing installed", async () => {
    const avail = await probeEngines(ALL_READY)
    expect(pickEngine("150 km/h to mph", avail)).toBe("qalc")
    expect(pickEngine("150 km/h -> mph", avail)).toBe("numbat")
    const empty = {} as Availability
    ;(Object.keys(ENGINES) as (keyof Availability)[]).forEach(k => (empty[k] = false))
    expect(pickEngine("2+2", empty)).toBeNull()
    const bcOnly = { ...empty, bc: true }
    expect(pickEngine("2+2", bcOnly)).toBe("bc")
  })

  test("os family mapping covers CachyOS, NixOS, Debian, Fedora, macOS", () => {
    expect(osFamilyFromId("cachyos")).toBe("arch")
    expect(osFamilyFromId("nixos")).toBe("nixos")
    expect(osFamilyFromId("ubuntu")).toBe("deb")
    expect(osFamilyFromId("fedora")).toBe("rpm")
    expect(osFamilyFromId("darwin")).toBe("mac")
    expect(osFamilyFromId(undefined)).toBe("unknown")
    expect(parseOsRelease('NAME="CachyOS Linux"\nID=cachyos\nID_LIKE="arch"\n')).toBe("cachyos")
    expect(detectOsFamily(() => 'ID_LIKE="arch"\n', "linux")).toBe("arch")
    expect(detectOsFamily(() => null, "darwin")).toBe("mac")
    expect(detectOsFamily(() => "ID=weirdos\n", "linux")).toBe("unknown")
  })

  test("qalc installs as libqalculate — the GUI packages do not ship the CLI", () => {
    expect(ENGINES.qalc.nix).toBe("libqalculate")
    expect(ENGINES.qalc.pacman).toBe("libqalculate")
    const nixos = installPlan("qalc", "nixos").join(" ")
    expect(nixos).toContain("pkgs.libqalculate")
    expect(nixos).toContain("users/common-hm.nix")
    expect(nixos).toContain("nixos-rebuild switch --flake")
    expect(installPlan("numbat", "arch").join(" ")).toBe("sudo pacman -S numbat")
    expect(installPlan("bc", "deb").join(" ")).toBe("sudo apt-get install -y bc")
    expect(installPlan("maxima", "rpm").join(" ")).toContain("dnf")
  })

  test("probe report lists missing engines with a proposal, and says so when all ready", async () => {
    const avail = await probeEngines(fakeHost({ qalc: { stdout: "Qalculate!" }, python3: { stdout: "Python" } }))
    const report = formatProbeReport(avail, "arch")
    expect(report).toContain("OS family: arch")
    expect(report).toContain("qalc")
    expect(report).toContain("ready")
    expect(report).toContain("MISSING")
    expect(report).toContain("sudo pacman -S numbat")
    expect(report.includes("all engines ready")).toBe(false)
    const allReady = formatProbeReport(await probeEngines(ALL_READY), "nixos")
    expect(allReady).toContain("all engines ready")
  })

  test("noEngineProposal refuses mental arithmetic outright", () => {
    const p = noEngineProposal("nixos")
    expect(p).toContain("do NOT compute this by mental arithmetic")
    expect(p).toContain("users/common-hm.nix")
  })
})

describe("calc execution", () => {
  test("success path returns engine, output, and a re-runnable command", async () => {
    const host = fakeHost({ ...qalcHost(), qalc: { stdout: "93.20567884 mph\n" } })
    const out = await runEngine("qalc", "150 km/h to mph", host)
    expect(out.ok).toBe(true)
    const line = formatOutcome(out, "150 km/h to mph")
    expect(line).toContain("engine=qalc")
    expect(line).toContain("93.20567884 mph")
    expect(line).toContain('command: qalc -t -m 5000 -s "decimal_comma 0" "150 km/h to mph"')
  })

  test("non-zero exit is a failure with no number to report", async () => {
    const host = fakeHost({ ...qalcHost(), qalc: { stderr: "qalc: not found", code: 127 } })
    const out = await runEngine("qalc", "2+2", host)
    expect(out.ok).toBe(false)
    expect(formatOutcome(out, "2+2")).toMatch(/^FAILED engine=qalc/)
    expect(formatOutcome(out, "2+2")).toContain("Do not report any number")
  })

  test("qalc exits 0 on parse errors — the `error:` line is caught as failure", async () => {
    const host = fakeHost({ ...qalcHost(), qalc: { stdout: "error: Trailing characters (not a valid function)\n" } })
    const out = await runEngine("qalc", "sqrt(", host)
    expect(out.ok).toBe(false)
    expect(out.error).toContain("error:")
  })

  test("timeout is reported as a timeout, never as a number", async () => {
    const hang: SpawnFn = () => new Promise(resolve => setTimeout(() => resolve({ stdout: "late", stderr: "", exitCode: 0 }), 500))
    const out = await runEngine("maxima", "integrate(x^2,x)", hang, 10)
    expect(out.ok).toBe(false)
    expect(out.error).toContain("timeout after 10 ms")
  })

  test("bc feeds the expression on stdin with a statement terminator", async () => {
    const host = fakeHost({ bc: { stdout: ".33333333333333333333\n" } })
    const out = await runEngine("bc", "1/3", host)
    expect(out.ok).toBe(true)
    expect(host.calls[host.calls.length - 1]).toEqual(["bc", "-l", "1/3;\n"])
  })

  test("renderCommand collapses embedded sources to a size marker and caps length", () => {
    const cmd = renderCommand(ENGINES.sympy.argv("integrate(x,x)"))
    expect(cmd).toMatch(/^uv run --with sympy python -c <source \d+ chars>$/)
    expect(renderCommand(["qalc", "-t", "-m", "5000", "150 km/h to mph"])).toBe(
      'qalc -t -m 5000 "150 km/h to mph"',
    )
    const long = renderCommand(["qalc", "-t", "x".repeat(400)], 60)
    expect(long.length).toBeLessThanOrEqual(60)
    expect(long.endsWith("…")).toBe(true)
  })

  test("series sum: three methods, difference reported (values from live runs)", async () => {
    // Live values on this host: maxima ev(sum(1/k^2,k,1,1000),numer); python
    // sum(1/(k*k) …); exact limit pi^2/6 from qalc.
    const maxima = 1.6439345666815615
    const python = 1.6439345666815597
    const exact = 1.6449340668482264
    const spread = Math.abs(maxima - python)
    expect(spread).toBeGreaterThan(0)
    expect(spread).toBeLessThan(1e-13)
    // The partial sum is below the limit by about 1/n = 1e-3.
    const tail = exact - maxima
    expect(tail).toBeGreaterThan(5e-4)
    expect(tail).toBeLessThan(1.5e-3)
  })

  test("engineFailure is null on a clean run", () => {
    expect(engineFailure("qalc", { stdout: "4", stderr: "", exitCode: 0 })).toBeNull()
    expect(engineFailure("qalc", { stdout: "", stderr: "boom", exitCode: 2 })).toContain("exit 2")
  })

  test("maxima exits 0 on errors — the output carries the failure", () => {
    // Live shape on Arch Maxima 5.47, exit status 0:
    expect(
      maximaFailure(
        '(%i1) printf(true, "~a", integrate(x^2;\nincorrect syntax: Missing )\nintegrate(x^2;\n            ^\n',
        "integrate(x^2;",
      ),
    ).toContain("incorrect syntax")
    // An unknown function prints its own call back: not a number.
    expect(
      maximaFailure(
        '(%i1) printf(true, "~a", foobar(2))\nfoobar(2)\n(%o1)                                      false\n',
        "foobar(2)",
      ),
    ).toContain("unevaluated")
    // Maxima prints a quoted noun form when it cannot evaluate (live-verified
    // for an infinite sum on 5.47): letters and digits must match for that.
    expect(
      maximaFailure(
        "(%i1) printf(true, \"~a\", sum(1/k^2, k, 1, inf))\n'sum(1/k^2,k,1,inf)\n(%o1)                                      false\n",
        "sum(1/k^2, k, 1, inf)",
      ),
    ).toContain("unevaluated")
    // Nothing printed (preamble only).
    expect(maximaFailure("Maxima 5.47.0 https://maxima.sourceforge.io\n", "1+1;")).toContain(
      "printed no result",
    )
    // A real result passes.
    expect(
      maximaFailure(
        '(%i1) printf(true, "~a", integrate(x^2, x))\nx^3/3\n(%o1)                                      false\n',
        "integrate(x^2,x)",
      ),
    ).toBeNull()
  })

  test("runEngine cleans the Maxima printf form to the plain-text result", async () => {
    const host = fakeHost({
      maxima: {
        stdout:
          '(%i1) printf(true, "~a", solve(x^2+2*x-5 = 0,x))\n[x = - sqrt(6) - 1, x = sqrt(6) - 1]\n(%o1)                                      false\n',
      },
    })
    const out = await runEngine("maxima", "solve(x^2+2*x-5=0,x)", host)
    expect(out.ok).toBe(true)
    expect(out.output).toBe("[x = - sqrt(6) - 1, x = sqrt(6) - 1]")
  })

  test("runEngine reports the Maxima syntax error as a failure with exit 0", async () => {
    const host = fakeHost({
      maxima: { stdout: "(%i1) printf(true, \"~a\", integrate(x^2)\nincorrect syntax: Missing )\n" },
    })
    const out = await runEngine("maxima", "integrate(x^2;", host)
    expect(out.ok).toBe(false)
    expect(out.error).toContain("incorrect syntax")
  })
})

function qalcHost(): Record<string, { stdout?: string; stderr?: string; code?: number }> {
  return { qalc: { stdout: "Qalculate!" } }
}
