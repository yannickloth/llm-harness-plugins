import type { Plugin } from "@opencode-ai/plugin"
import { $ } from "bun"
import path from "path"

export default async ({ directory, worktree }: Parameters<Plugin>[0]) => {
  const root = worktree ?? directory
  const pluginDir = path.join(import.meta.dir, "..")
  const classesDir = path.join(pluginDir, "build", "classes")
  const mainClass = "SessionLifecycle"
  const jvmOpts = "--add-opens java.base/java.util=ALL-UNNAMED"

  console.log("[session-lifecycle] plugin active — 3 lifecycle hooks")

  return {
    event: async ({ event }) => {
      switch (event.type) {
        case "session.created": {
          const sessionId = event.properties?.sessionID
          if (!sessionId) return
          await $`java ${jvmOpts} --class-path ${classesDir} ${mainClass} snapshot-commits ${root} ${sessionId}`.nothrow().quiet()
          await $`java ${jvmOpts} --class-path ${classesDir} ${mainClass} check-errors ${root}`.nothrow().quiet()
          break
        }
        case "file.edited": {
          const sessionId = (event.properties as any)?.sessionID
          const file = event.properties?.file
          if (!sessionId || !file) return
          await $`java ${jvmOpts} --class-path ${classesDir} ${mainClass} record-edit ${root} ${sessionId} ${file}`.nothrow().quiet()
          break
        }
        case "session.idle": {
          const sessionId = (event.properties as any)?.sessionID
          if (!sessionId) return
          await $`java ${jvmOpts} --class-path ${classesDir} ${mainClass} diff-commits ${root} ${sessionId}`.nothrow().quiet()
          await $`java ${jvmOpts} --class-path ${classesDir} ${mainClass} archive ${root} ${sessionId}`.nothrow().quiet()
          break
        }
      }
    },
  }
}
