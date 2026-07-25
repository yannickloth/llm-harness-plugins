import type { Plugin, tool } from "@opencode-ai/plugin"
import { $ } from "bun"
import path from "path"

const agentmemDir = path.join(import.meta.dir, "..")
const classesDir = path.join(agentmemDir, "build", "classes")
const script = path.join(agentmemDir, "MemorySystem.java")

export default async ({ project, client, $ }: Parameters<Plugin>[0]) => {
  console.log("[agentmem] plugin active — 4 tools registered")
  return {
    tool: {
      "save-memory": tool({
        description: "Save a project learning to persistent memory. Two-step protocol: write topic file with frontmatter, then add index pointer to MEMORY.md.",
        args: {
          name: tool.schema.string().describe("Filename stem, [a-zA-Z0-9_-]+"),
          description: tool.schema.string().describe("One-line relevance summary"),
          type: tool.schema.enum(["user", "feedback", "project", "reference"]),
          subtype: tool.schema.string().optional().describe("failure | serendipity | anomaly | digest | question | episode"),
          who: tool.schema.string().describe("Human | Agent (user-requested) | Agent (autonomous)"),
          context: tool.schema.string().describe("What problem was being solved"),
          confidence: tool.schema.enum(["high", "medium", "low", "speculative"]).default("medium"),
          content: tool.schema.string().describe("Body. For feedback/project: What/Why/How-to-apply/Who/Context"),
          hook: tool.schema.string().describe("One-line MEMORY.md pointer, <=150 chars"),
          contradicts: tool.schema.string().optional(),
          guard_trigger: tool.schema.string().optional(),
        },
        async execute(args, context) {
          const memDir = context.worktree
            ? path.join(context.worktree, ".agentmem")
            : path.join(context.directory, ".agentmem")
          const cmd = [
            "java", "--class-path", classesDir, "--source", "25",
            script, "save", memDir,
            args.name, args.description, args.type, args.who,
            args.context, args.confidence, args.content, args.hook,
            args.subtype ?? "--",
            args.contradicts ?? "--",
            args.guard_trigger ?? "--"
          ]
          const result = await $`${cmd}`.nothrow().text()
          return result.trim()
        },
      }),

      "forget-memory": tool({
        description: "Explicitly delete a memory. Moves file to .cold/ and removes from MEMORY.md index.",
        args: {
          name: tool.schema.string().describe("Memory file name (with or without .md extension)"),
        },
        async execute(args, context) {
          const memDir = context.worktree
            ? path.join(context.worktree, ".agentmem")
            : path.join(context.directory, ".agentmem")
          const result = await $`java --class-path ${classesDir} --source 25 ${script} delete ${memDir} ${args.name}`.nothrow().text()
          return result.trim()
        },
      }),

      "check-memory-health": tool({
        description: "Check memory directory health: dangling pointers, orphans, index size.",
        args: {},
        async execute(_args, context) {
          const memDir = context.worktree
            ? path.join(context.worktree, ".agentmem")
            : path.join(context.directory, ".agentmem")
          const result = await $`java --class-path ${classesDir} --source 25 ${script} quality-health ${memDir}`.nothrow().text()
          return result.trim()
        },
      }),

      "init-memory": tool({
        description: "Bootstrap memory from git history. Scans commits for patterns: frequent fixes, reverted refactors, config breaks.",
        args: {
          repo_path: tool.schema.string().optional(),
        },
        async execute(args, context) {
          const memDir = context.worktree
            ? path.join(context.worktree, ".agentmem")
            : path.join(context.directory, ".agentmem")
          const repoPath = args.repo_path
            ?? context.worktree
            ?? context.directory
          const result = await $`java --class-path ${classesDir} --source 25 ${script} bootstrap ${memDir} ${repoPath}`.nothrow().text()
          return result.trim()
        },
      }),
    },
  }
}
