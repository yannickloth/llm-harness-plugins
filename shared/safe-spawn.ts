export interface SpawnResult {
  stdout: string
  stderr: string
  exitCode: number
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
  opts: { input?: string; cwd?: string } = {},
): Promise<SpawnResult> {
  const proc = Bun.spawn(argv, {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    cwd: opts.cwd,
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
  opts: { cwd?: string } = {},
): SpawnResult {
  const proc = Bun.spawnSync(argv, {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    cwd: opts.cwd,
  })
  return {
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
    exitCode: proc.exitCode,
  }
}
