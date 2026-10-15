// session-lifecycle — session bookkeeping + file-access logging via a java sidecar.
//
// Dual-version entrypoint (the harness idiom): `server(input)` is the v1 path,
// `setup(ctx)` the v2 path. v2 differences from v1:
//   - export shape is an object, so v1 is served by `server`;
//   - no `client` and no `{ directory, worktree }` args — the root comes from
//     `ctx.location`;
//   - the v1 `event` hook becomes a `ctx.event.subscribe({ signal })` async
//     iterator yielding `{ type, data }`;
//   - `tool.execute.after` becomes `ctx.tool.hook("execute.after", cb)`.
// v2 payload field names differ from v1's, so those reads are best-effort with
// fallbacks (same approach guardrail-chain takes). A missed field only means
// less bookkeeping — the sidecar calls are `.nothrow()`.
import type { Plugin } from "@opencode-ai/plugin"
import { $ } from "bun"
import path from "path"
import { createLogger } from "../../shared/plugin-logger"
import { moduleDir } from "../../shared/module-dir"
import { writeLoadCanary } from "../../shared/load-canary"

const pluginDir = path.join(moduleDir(import.meta.url, import.meta.dir), "..")
const classesDir = path.join(pluginDir, "build", "classes")
const MAIN_CLASS = "SessionLifecycle"
const JVM_OPTS = "--add-opens java.base/java.util=ALL-UNNAMED"

function accessTypeFor(tool: string): string | null {
  if (tool === "read") return "read"
  if (tool === "edit" || tool === "write") return "write"
  return null
}

function extractFilePath(args: Record<string, unknown> | undefined): string | null {
  if (!args) return null
  for (const key of ["filePath", "file_path", "path", "file"]) {
    const v = (args as any)[key]
    if (typeof v === "string" && v) return v
  }
  return null
}

const sidecar = (root: string, subcommand: string, rest: (string | number)[] = []) =>
  $`java ${JVM_OPTS} --class-path ${classesDir} ${MAIN_CLASS} ${subcommand} ${root} ${rest.map(String)}`.nothrow().quiet()

// ---------------------------------------------------------------------------
// v1 entrypoint.
// ---------------------------------------------------------------------------
const v1Factory: Plugin = async ({ client, directory, worktree }) => {
  writeLoadCanary("session-lifecycle")
  const logger = createLogger(client, "session-lifecycle")
  const root = worktree ?? directory

  logger.info("plugin active — lifecycle + file-access logging")

  return {
    event: async ({ event }) => {
      switch (event.type) {
        case "session.created": {
          const sessionId = event.properties?.sessionID
          if (!sessionId) return
          await $`java ${JVM_OPTS} --class-path ${classesDir} ${MAIN_CLASS} sweep ${root}`.nothrow().quiet()
          await $`java ${JVM_OPTS} --class-path ${classesDir} ${MAIN_CLASS} snapshot-commits ${root} ${sessionId}`.nothrow().quiet()
          await $`java ${JVM_OPTS} --class-path ${classesDir} ${MAIN_CLASS} check-errors ${root}`.nothrow().quiet()
          break
        }
        case "session.idle": {
          const sessionId = event.properties?.sessionID
          if (!sessionId) return
          await $`java ${JVM_OPTS} --class-path ${classesDir} ${MAIN_CLASS} diff-commits ${root} ${sessionId}`.nothrow().quiet()
          await $`java ${JVM_OPTS} --class-path ${classesDir} ${MAIN_CLASS} archive ${root} ${sessionId}`.nothrow().quiet()
          break
        }
      }
    },

    "tool.execute.after": async (input: { tool: string; sessionID: string; args: any }, _output) => {
      const tool = input.tool
      const accessType = accessTypeFor(tool)
      if (!accessType) return
      const filePath = extractFilePath(input.args ?? {})
      if (!filePath) return
      await $`java ${JVM_OPTS} --class-path ${classesDir} ${MAIN_CLASS} record-access ${root} ${input.sessionID} ${accessType} ${filePath}`.nothrow().quiet()
    },
  }
}

// ---------------------------------------------------------------------------
// v2 entrypoint.
// ---------------------------------------------------------------------------
export default {
  id: "session-lifecycle",

  async setup(ctx: any) {
    writeLoadCanary("session-lifecycle")
    const root: string = ctx.location?.project?.canonical ?? ctx.location?.directory

    const controller = new AbortController()
    void (async () => {
      try {
        for await (const input of ctx.event.subscribe({ signal: controller.signal })) {
          if (controller.signal.aborted) break
          const type = input?.type ?? input?.event?.type
          const data = input?.data ?? input?.event?.properties ?? input?.properties
          const sessionId = data?.sessionID ?? data?.session?.id
          if (!sessionId) continue
          if (type === "session.created") {
            await sidecar(root, "sweep")
            await sidecar(root, "snapshot-commits", [sessionId])
            await sidecar(root, "check-errors")
          } else if (type === "session.idle") {
            await sidecar(root, "diff-commits", [sessionId])
            await sidecar(root, "archive", [sessionId])
          }
        }
      } catch {
        // bookkeeping must never break the session
      }
    })()

    await ctx.tool.hook("execute.after", async (event: any) => {
      const accessType = accessTypeFor(event?.tool ?? event?.name)
      if (!accessType) return
      const filePath = extractFilePath(event?.input ?? event?.args)
      const sessionId = event?.sessionID ?? event?.session?.id
      if (!filePath || !sessionId) return
      await sidecar(root, "record-access", [sessionId, accessType, filePath])
    })

    return () => controller.abort()
  },

  async server(input: any, options?: any) {
    return v1Factory(input, options)
  },
}
