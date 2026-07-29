import { existsSync, readFileSync, statSync } from "node:fs"
import { isAbsolute, join } from "node:path"

const JAVA_CLASS = "eu.infolead.llmhp.guardrails.GuardrailPipelineCli"

function findPluginDir(): string {
  return join(import.meta.dir, "..")
}

interface ToolCtx { cwd: string; signal: AbortSignal | undefined }

export default function guardrailChainPi(pi: any) {
  const pluginDir = findPluginDir()
  const classpath = join(pluginDir, "build", "classes")
  var projectRoot = ""

  pi.on("session_start", (_event: any, ctx: any) => {
    projectRoot = ctx.cwd
  })

  const scanSecrets: any = {
    name: "gcl-scan-secrets",
    label: "Scan for Secrets",
    description: "Scan text for hardcoded secrets before writing. Detects API keys, tokens, PEM, AWS, GitHub, Slack tokens.",
    parameters: {} as any,
    async execute(toolCallId: string, params: Record<string, unknown>, signal: AbortSignal | undefined, _onUpdate: any, ctx: ToolCtx) {
      const content = String(params.content ?? "")
      const args = ["java", "--class-path", classpath, JAVA_CLASS, "scan-secrets", content]
      const result = Bun.spawnSync(["sh", "-c", args.join(" ")])
      const output = result.stdout.toString().trim() || result.stderr.toString().trim()
      if (result.exitCode !== 0) return { content: [{ type: "text", text: "ERROR: " + output }], isError: true }
      return { content: [{ type: "text", text: output }] }
    },
  }
  pi.registerTool(scanSecrets)

  const checkInjection: any = {
    name: "gcl-check-injection",
    label: "Check Injection",
    description: "Check prompt for injection patterns: ignore instructions, DAN, pretend, system override.",
    parameters: {} as any,
    async execute(toolCallId: string, params: Record<string, unknown>, signal: AbortSignal | undefined, _onUpdate: any, ctx: ToolCtx) {
      const prompt = String(params.prompt ?? "")
      const args = ["java", "--class-path", classpath, JAVA_CLASS, "check-injection", prompt]
      const result = Bun.spawnSync(["sh", "-c", args.join(" ")])
      const output = result.stdout.toString().trim() || result.stderr.toString().trim()
      if (result.exitCode !== 0) return { content: [{ type: "text", text: "ERROR: " + output }], isError: true }
      return { content: [{ type: "text", text: output }] }
    },
  }
  pi.registerTool(checkInjection)

  const checkPath: any = {
    name: "gcl-check-path",
    label: "Check Path Safety",
    description: "Validate file path — no symlink traversal, within containment, not overwriting protected files.",
    parameters: {} as any,
    async execute(toolCallId: string, params: Record<string, unknown>, signal: AbortSignal | undefined, _onUpdate: any, ctx: ToolCtx) {
      const target = String(params.target ?? "")
      const containment = String(params.containment ?? "")
      const args = ["java", "--class-path", classpath, JAVA_CLASS, "check-path", target, containment]
      const result = Bun.spawnSync(["sh", "-c", args.join(" ")])
      const output = result.stdout.toString().trim() || result.stderr.toString().trim()
      if (result.exitCode !== 0) return { content: [{ type: "text", text: "ERROR: " + output }], isError: true }
      return { content: [{ type: "text", text: output }] }
    },
  }
  pi.registerTool(checkPath)

  pi.on("tool_result", (event: any, ctx: any) => {
    const toolName = event.toolName
    if (toolName !== "write" && toolName !== "edit") return undefined
    const filePath = event.input?.path ?? event.input?.file_path
    if (!filePath) return undefined
    const abs = resolveAbsolute(ctx.cwd, String(filePath))
    if (!existsSync(abs)) return undefined
    const content = readFileSync(abs, "utf-8")
    if (content.length > 50000) return undefined
    const args = ["java", "--class-path", classpath, JAVA_CLASS, "output-filter", content]
    const result = Bun.spawnSync(["sh", "-c", args.join(" ")])
    const output = result.stdout.toString().trim()
    try {
      const parsed = JSON.parse(output)
      if (parsed.blocked) {
        console.error("[guardrail-chain] SECRET DETECTED in:", abs)
      }
    } catch (_) {}
    return undefined
  })
}

function resolveAbsolute(cwd: string, rawPath: string): string {
  if (isAbsolute(rawPath)) return rawPath
  return join(cwd, rawPath)
}
