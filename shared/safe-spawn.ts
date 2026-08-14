export interface SpawnResult {
  stdout: string
  stderr: string
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
 * the group kill is unavailable.
 */
export function killProcessTree(proc: { pid: number }, signal: NodeJS.Signals | number = "SIGKILL"): void {
  try {
    process.kill(-proc.pid, signal)
  } catch {
    try { process.kill(proc.pid, signal) } catch { /* already gone */ }
  }
}

/**
 * Spawn a child in its own process group so the whole tree can be reaped on
 * timeout, and propagate the no-subspawn guard. Returns the child.
 */
export function spawnDetached(
  argv: string[],
  opts: { cwd?: string; env?: Record<string, string>; stdin?: "pipe" | "ignore"; stdout?: "pipe" | "ignore"; stderr?: "pipe" | "ignore" } = {},
): ReturnType<typeof Bun.spawn> {
  return Bun.spawn(argv, {
    stdin: opts.stdin ?? "pipe",
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
    env: opts.env,
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

export function safeSpawnSync(
  argv: string[],
  opts: { cwd?: string; env?: Record<string, string> } = {},
): SpawnResult {
  const proc = Bun.spawnSync(argv, {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    cwd: opts.cwd,
    env: opts.env,
  })
  return {
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
    exitCode: proc.exitCode,
  }
}
