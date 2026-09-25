import { type Config, type Plugin, tool } from "@opencode-ai/plugin"
import { createLogger } from "../../shared/plugin-logger"
import { moduleDir } from "../../shared/module-dir"
import { $ } from "bun"
import fs from "fs"
import path from "path"

const skillsDir = path.resolve(moduleDir(import.meta.url, import.meta.dir), "..", "skills")

function skillCount(dir: string): number {
  if (!fs.existsSync(dir)) return 0
  return fs
    .readdirSync(dir)
    .filter(entry => {
      const d = path.join(dir, entry)
      return fs.statSync(d).isDirectory() && fs.existsSync(path.join(d, "SKILL.md"))
    }).length
}

/** Locate the toolkit's compiled classes dir (build/classes). */
function classesDir(): string {
  return path.join(moduleDir(import.meta.url, import.meta.dir), "..", "build", "classes")
}

async function runJava(toolClass: string, args: string[]): Promise<string> {
  const cp = classesDir()
  if (!fs.existsSync(cp)) {
    return `graphics-toolkit classes not found at ${cp}. Run the build (build.sh or javac) first.`
  }
  const result = await $`java --class-path ${cp} eu.infolead.llmhp.graphics.${toolClass} ${args}`.nothrow().quiet()
  if (result.exitCode !== 0) {
    return result.stderr().trim() || result.text().trim()
  }
  return result.stdout().trim()
}

export default async ({ client }: Parameters<Plugin>[0]) => {
  const logger = createLogger(client, "graphics-toolkit")
  const count = skillCount(skillsDir)
  logger.info(`plugin active — skill self-registration (${count} skills in ${skillsDir})`)

  return {
    config: async (input: Config) => {
      const skills = (input as any).skills ?? {}
      const paths: string[] = Array.isArray(skills.paths) ? [...skills.paths] : []
      if (count > 0 && !paths.includes(skillsDir)) paths.push(skillsDir)
      ;(input as any).skills = { ...skills, paths }
    },
    tool: {
      "svg-selfcheck": tool({
        description: "Deterministic gate on a generated diagram/HTML/SVG artifact: accessible-SVG contract, single-file safety, allowlisted remote URLs, no executable attrs/scripts. Run on any generated SVG/HTML before shipping.",
        args: {
          filePath: tool.schema.string().describe("Path to the .html or .svg file to verify"),
        },
        async execute(args) {
          return runJava("GraphicsSvgCheck", [args.filePath])
        },
      }),
      "svg-geometry": tool({
        description: "Deterministic geometry gate: 4px-grid compliance on rect node boxes and viewBox sanity. Chart/text primitives are exempt. Run on generated SVG/HTML.",
        args: {
          filePath: tool.schema.string().describe("Path to the .html or .svg file to verify"),
        },
        async execute(args) {
          return runJava("GraphicsGeometryCheck", [args.filePath])
        },
      }),
      "svg-motion": tool({
        description: "Deterministic motion-contract gate: motion mode, step budget, reduced-motion + print fallbacks, control/status structure. Run on motion-enabled SVG/HTML.",
        args: {
          filePath: tool.schema.string().describe("Path to the .html or .svg file to verify"),
        },
        async execute(args) {
          return runJava("GraphicsMotionCheck", [args.filePath])
        },
      }),
      "graphics-export": tool({
        description: "Export a diagram HTML to a standalone SVG and compute PNG rasterization sizing from the viewBox x scale. Never hand-author SVG; generate HTML first.",
        args: {
          filePath: tool.schema.string().describe("Path to the .html source"),
          out: tool.schema.string().optional().describe("Optional output .svg path"),
          scale: tool.schema.number().optional().describe("PNG device_scale_factor (default 2)"),
        },
        async execute(args) {
          const cli = [args.filePath]
          if (args.out) cli.push("--out", args.out)
          if (args.scale) cli.push("--scale", String(args.scale))
          return runJava("GraphicsExport", cli)
        },
      }),
      "drawio-extract": tool({
        description: "Extract a normalized IR digest from a draw.io file (nodes/edges/containers/hubs/budget/type candidates). Untrusted-data safe: never executes or follows source content.",
        args: {
          filePath: tool.schema.string().describe("Path to the .drawio file"),
          page: tool.schema.string().optional().describe("Page index, name, or 'all'"),
        },
        async execute(args) {
          const cli = [args.filePath]
          if (args.page) cli.push("--page", args.page)
          return runJava("DrawioExtract", cli)
        },
      }),
      "mermaid-extract": tool({
        description: "Extract a normalized IR digest from a Mermaid source (nodes/edges/containers/budget/type candidates). Untrusted-data safe: never evaluates, renders, or executes source.",
        args: {
          filePath: tool.schema.string().describe("Path to the .mmd/.mermaid file"),
          diagram: tool.schema.string().optional().describe("Diagram index, or 'all'"),
        },
        async execute(args) {
          const cli = [args.filePath]
          if (args.diagram) cli.push("--diagram", args.diagram)
          return runJava("MermaidExtract", cli)
        },
      }),
    },
  }
}
