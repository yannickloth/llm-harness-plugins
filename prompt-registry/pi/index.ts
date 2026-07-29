import { join } from "node:path"

const JAVA_CLASS = "eu.infolead.llmhp.promptregistry.PromptRegistryCli"

function findPluginDir(): string {
  return join(import.meta.dir, "..")
}

export default function promptRegistryPi(pi: any) {
  const pluginDir = findPluginDir()
  const classpath = join(pluginDir, "build", "classes")
  var registryDir = ""

  pi.on("session_start", (_event: any, ctx: any) => {
    registryDir = join(ctx.cwd, ".prompt-registry", "registry")
  })

  function runCli(args: string[]): any {
    const result = Bun.spawnSync(["java", "--class-path", classpath, JAVA_CLASS, "--registry-dir", registryDir, ...args])
    const output = result.stdout.toString().trim() || result.stderr.toString().trim()
    if (result.exitCode !== 0) return { content: [{ type: "text", text: "ERROR: " + output }], isError: true }
    return { content: [{ type: "text", text: output }] }
  }

  pi.registerTool({
    name: "pr-commit",
    label: "Commit Prompt",
    description: "Commit current prompt version to registry. Snapshots from plugin's prompts/ directory.",
    parameters: {} as any,
    async execute(toolCallId: string, params: Record<string, unknown>, signal: AbortSignal | undefined, _onUpdate: any, ctx: any) {
      const argv = ["commit", String(params.name ?? "")]
      if (params.from) argv.push("--from", String(params.from))
      if (params.author) argv.push("--author", String(params.author))
      return runCli(argv)
    },
  })

  pi.registerTool({
    name: "pr-pull",
    label: "Pull Prompt",
    description: "Pull prompt version from registry into plugin's prompts/ directory.",
    parameters: {} as any,
    async execute(toolCallId: string, params: Record<string, unknown>, signal: AbortSignal | undefined, _onUpdate: any, ctx: any) {
      const argv = ["pull", String(params.name_ver ?? "")]
      if (params.to) argv.push("--to", String(params.to))
      return runCli(argv)
    },
  })

  pi.registerTool({
    name: "pr-list",
    label: "List Prompts",
    description: "List registered prompts and versions.",
    parameters: {} as any,
    async execute(toolCallId: string, params: Record<string, unknown>, signal: AbortSignal | undefined, _onUpdate: any, ctx: any) {
      const argv = ["list"]
      if (params.name) argv.push(String(params.name))
      return runCli(argv)
    },
  })

  pi.registerTool({
    name: "pr-diff",
    label: "Diff Prompt Versions",
    description: "Compare two versions of a prompt.",
    parameters: {} as any,
    async execute(toolCallId: string, params: Record<string, unknown>, signal: AbortSignal | undefined, _onUpdate: any, ctx: any) {
      return runCli(["diff", String(params.name ?? ""), String(params.v1 ?? ""), String(params.v2 ?? "")])
    },
  })

  pi.registerTool({
    name: "pr-test",
    label: "A/B Test Setup",
    description: "Set up A/B comparison between two prompt versions.",
    parameters: {} as any,
    async execute(toolCallId: string, params: Record<string, unknown>, signal: AbortSignal | undefined, _onUpdate: any, ctx: any) {
      return runCli(["test", String(params.name ?? ""), String(params.variant_a ?? ""), String(params.variant_b ?? "")])
    },
  })
}
