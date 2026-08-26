export interface SpawnResult {
  stdout: string
  stderr: string
  /** Process exit code, or the terminating signal number if the child was
   * killed by a signal (Bun reports signal termination as the signal number).
   * Callers should treat only `=== 0` as success. */
  exitCode: number
}

/**
 * Env var set on every `opencode run` subprocess launched by a plugin. Child
 * opencode processes that load the same plugin must see this and refuse to
 * re-launch their own subprocesses — otherwise a plugin that reacts to
 * `session.idle` recurses into an unbounded spawn storm (each child spawning
 * more children). Set to `"1"` on the child; plugins check it before spawning.
 */
export const NO_SUBSPAWN_ENV = "LLMHP_NO_SUBSPAWN"

/**
 * Kill an entire process tree. `proc.kill()` on Bun only signals the immediate
 * child PID, leaving grandchildren (e.g. a Java CLI spawned by `opencode run`,
 * or a nested `opencode run`) orphaned. When the child was spawned with
 * `detached: true` it leads its own process group, so signalling the negative
 * PID terminates the whole group. Falls back to signalling the single PID when
 * the group kill is unavailable. Returns false only when neither signal could
 * be delivered (caller may then choose to treat the child as possibly alive).
 */
export function killProcessTree(proc: { pid: number }, signal: NodeJS.Signals | number = "SIGKILL"): boolean {
  try {
    process.kill(-proc.pid, signal)
    return true
  } catch {
    try {
      process.kill(proc.pid, signal)
      return true
    } catch {
      return false // already gone, or we lack permission to signal it
    }
  }
}

/**
 * Spawn a child in its own process group so the whole tree can be reaped on
 * timeout, and propagate the no-subspawn guard. Returns the child.
 *
 * `stdin` defaults to `"ignore"`: detached subprocesses that take their prompt
 * as an argv argument (keeper/dreamer) never read stdin, and leaving the pipe
 * open on a child that *does* wait for EOF would hang it. Callers that write
 * a prompt to stdin must pass `stdin: "pipe"` explicitly.
 */
export function spawnDetached(
  argv: string[],
  opts: { cwd?: string; env?: Record<string, string>; stdin?: "pipe" | "ignore"; stdout?: "pipe" | "ignore"; stderr?: "pipe" | "ignore" } = {},
): ReturnType<typeof Bun.spawn> {
  return Bun.spawn(argv, {
    stdin: opts.stdin ?? "ignore",
    stdout: opts.stdout ?? "pipe",
    stderr: opts.stderr ?? "pipe",
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env, [NO_SUBSPAWN_ENV]: "1" },
    detached: true,
  })
}

/**
 * Run a command with all stdio captured to pipes.
 *
 * Unlike `$\`...\`.nothrow()`, which streams the subprocess's stdout/stderr to
 * the parent's terminal, `safeSpawn` never writes to the terminal. This keeps
 * plugin-launched CLI output (e.g. Java `System.out`/`System.err`) out of the
 * interactive TUI, which would otherwise overwrite the CLI UI.
 */
export function safeSpawn(
  argv: string[],
  opts: { input?: string; cwd?: string; env?: Record<string, string> } = {},
): Promise<SpawnResult> {
  const proc = Bun.spawn(argv, {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    cwd: opts.cwd,
    // Merge over process.env so a caller-supplied env adds to (not replaces)
    // PATH, HOME, etc. Passing a bare env object to Bun.spawn replaces the
    // whole environment, which silently breaks children that need the parent's
    // PATH/HOME (e.g. tier-router's Java RouterCli).
    env: { ...process.env, ...opts.env },
  })

  const drain = async (stream: ReadableStream<Uint8Array>): Promise<string> => {
    return new Response(stream).text()
  }

  const outP = drain(proc.stdout)
  const errP = drain(proc.stderr)

  if (opts.input != null) {
    const w = proc.stdin
    w.write(opts.input)
    void w.end()
  } else {
    proc.stdin!.end()
  }

  return Promise.all([outP, errP, proc.exited]).then(([stdout, stderr, exitCode]) => ({
    stdout,
    stderr,
    exitCode,
  }))
}

/**
 * Extract the assistant's text replies from `opencode run --format json`
 * output (newline-delimited JSON events). Text parts are emitted as
 * `{"type":"text","part":{"text":"..."}}`; non-text events and non-JSON
 * lines (logs) are ignored. Empty if no text reply was produced.
 */
export function extractOpencodeText(out: string): string {
  const words: string[] = []
  for (const line of out.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const evt = JSON.parse(trimmed)
      if (evt.type === "text" && typeof evt.part?.text === "string") {
        words.push(evt.part.text)
      }
    } catch {
      // ignore non-JSON lines (e.g. logs)
    }
  }
  return words.join(" ").trim()
}

/**
 * Extract the first session ID seen in `opencode run --format json` output
 * (newline-delimited JSON events). Every event carries a top-level
 * `sessionID`; return the first non-empty one. Null when none is seen.
 *
 * Plugins that spawn maintenance `opencode run` subprocesses (classifier,
 * keeper, dreamer) use this to find and delete the throwaway session those
 * subprocesses create, so they do not clutter the user's session list.
 */
export function extractOpencodeSessionId(out: string): string | null {
  for (const line of out.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const evt = JSON.parse(trimmed)
      if (typeof evt?.sessionID === "string" && evt.sessionID) return evt.sessionID
    } catch {
      // ignore non-JSON lines (e.g. logs)
    }
  }
  return null
}

export function safeSpawnSync(
  argv: string[],
  opts: { cwd?: string; env?: Record<string, string> } = {},
): SpawnResult {
  const proc = Bun.spawnSync(argv, {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    cwd: opts.cwd,
    // Same merge-as-override semantics as safeSpawn; never replace process.env.
    env: { ...process.env, ...opts.env },
  })
  return {
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
    exitCode: proc.exitCode,
  }
}
