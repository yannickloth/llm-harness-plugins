import { type Plugin, tool } from "@opencode-ai/plugin"
import path from "path"
import fs from "fs"
import os from "os"
import { createLogger } from "../../shared/plugin-logger"
import { safeSpawn, extractOpencodeText, extractOpencodeSessionId, NO_SUBSPAWN_ENV } from "../../shared/safe-spawn"
import { moduleDir } from "../../shared/module-dir"
import {
  buildLineRanges,
  buildOffloadContract,
  countFileLines,
  type CitationReport,
  type LineRange,
} from "./contract"

const pluginDir = path.join(moduleDir(import.meta.url, import.meta.dir), "..")
const classesDir = path.join(pluginDir, "build", "classes")
const mainClass = "eu.infolead.llmhp.offload.OffloadCli"

/** Disable the whole plugin (gate + tools register but no-op) when "0". */
const DISABLED_ENV = "LLMHP_PREMIUM_OFFLOAD"
/** Worker model — the cheap DeepSeek pool (§3 of the design). */
const WORKER_MODEL = process.env.LLMHP_OFFLOAD_WORKER_MODEL ?? "deepseek/deepseek-flash"
/** Worker agent names (registered in the host opencode.json). Empty disables. */
const READER_AGENT = process.env.LLMHP_OFFLOAD_READER_AGENT ?? "bulk-reader"
const WRITER_AGENT = process.env.LLMHP_OFFLOAD_WRITER_AGENT ?? "code-writer"
/** Cap one worker invocation. */
const WORKER_TIMEOUT_MS = Number(process.env.LLMHP_OFFLOAD_TIMEOUT_MS ?? 180_000)
/** Worker records older than this are pruned on plugin start (days). */
const WORKER_TTL_DAYS = Number(process.env.LLMHP_OFFLOAD_TTL_DAYS ?? 14)

function agentArgs(agent: string | undefined): string[] {
  return agent && agent !== "none" ? ["--agent", agent] : []
}

export default async ({ client, directory, worktree }: Parameters<Plugin>[0]) => {
  const logger = createLogger(client, "premium-read-offload")
  const root = worktree ?? directory

  if (process.env[DISABLED_ENV] === "0") {
    logger.info("plugin disabled via LLMHP_PREMIUM_OFFLOAD=0")
    return {}
  }

  logger.info(`plugin active — gate on premium sessions, worker=${WORKER_MODEL}`)

  function java(args: string[], input?: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return safeSpawn(["java", "--class-path", classesDir, mainClass, ...args], input != null ? { input } : {})
  }

  async function jparse(args: string[], input?: string): Promise<any | null> {
    const r = await java(args, input)
    try { return JSON.parse(r.stdout.trim()) } catch { return null }
  }

  /**
   * Append one cost-telemetry record. Best-effort: telemetry must never break an
   * offload, so a failure here is swallowed (record-metric itself is best-effort
   * on the Java side too). Values we cannot measure are omitted, not guessed —
   * there is deliberately no fabricated dollar/quota figure.
   */
  async function metric(fields: Record<string, unknown>): Promise<void> {
    try {
      const rec = { ts: new Date().toISOString(), plugin: "premium-read-offload", ...fields }
      await jparse(["record-metric", root, JSON.stringify(rec)])
    } catch (e) {
      logger.warn(`record-metric failed: ${(e as Error).message}`)
    }
  }

  /** Resolve an absolute path the way the read tool presents it. */
  function abs(p: string): string {
    if (!p) return p
    return path.isAbsolute(p) ? p : path.resolve(root, p)
  }

  /** Path of the append-only cost-telemetry log (mirrors WorkerStore). */
  function metricsPath(): string {
    return path.join(root, ".premium-read-offload", "metrics.jsonl")
  }

  // Reclaim expired worker sessions on start (TTL-only; no keep-list, so
  // nothing is treated as stale). A changed corpus is caught at read time by
  // fingerprint comparison, so no eager stale sweep is needed. Best-effort:
  // a prune failure must never block plugin load.
  void jparse(["worker-prune", root])
    .then((r) => { if (r?.pruned?.length) logger.info(`pruned ${r.pruned.length} expired worker session(s)`) })
    .catch(() => {})

  // ── the gate ──────────────────────────────────────────────────────────────

  const hooks = {
    "chat.message": async (input: { sessionID: string; model?: { providerID: string; modelID: string } }) => {
      if (!input.model) return
      try {
        await jparse(["record-model", root, input.sessionID, input.model.providerID, input.model.modelID])
      } catch (e) {
        logger.warn(`record-model failed: ${(e as Error).message}`)
      }
    },

    "tool.execute.before": async (input: { tool: string; sessionID: string }, output: { args: any }) => {
      try {
        if (input.tool === "read") {
          const filePath = typeof output.args?.filePath === "string" ? output.args.filePath
            : typeof output.args?.file_path === "string" ? output.args.file_path : ""
          if (!filePath) return
          const offset = Number.isFinite(output.args?.offset) ? String(output.args.offset) : "-"
          const limit = Number.isFinite(output.args?.limit) ? String(output.args.limit) : "-"
          const v = await jparse(["decide-read", root, input.sessionID, abs(filePath), offset, limit])
          if (v?.decision === "block") {
            logger.info(`gated read: ${filePath} (${v.detail})`)
            throw new Error(blockMessage(abs(filePath), v.detail))
          }
          return
        }
        if (input.tool === "bash") {
          const command = typeof output.args?.command === "string" ? output.args.command
            : typeof output.args?.cmd === "string" ? output.args.cmd : ""
          if (!command) return
          const v = await jparse(["decide-bash", root, input.sessionID, command])
          if (v?.decision === "block") {
            logger.info(`gated bash read: ${command} (${v.detail})`)
            throw new Error(bashBlockMessage(command, v.detail))
          }
        }
      } catch (e) {
        // A throw from decide-* logic IS the block. Re-throw those; swallow
        // infrastructure failures (fail open — never break the main task).
        if (e instanceof Error && (e.message.startsWith("PREMIUM_READ_OFFLOAD"))) throw e
        logger.warn(`gate check failed (allowing): ${(e as Error).message}`)
      }
    },
  }

  function blockMessage(file: string, detail: string): string {
    return (
      `PREMIUM_READ_OFFLOAD: this read was gated (${detail}). ` +
      `This session runs on a premium model; reading a large file into context spends ` +
      `scarce subscription quota. Instead, delegate the read to the cheap worker:\n` +
      `  use the offload-read tool with {\"question\": \"<what you need>\", \"paths\": [\"${file}\"]}\n` +
      `It returns a derived answer, NOT file bytes — correct for understanding, wrong for editing. ` +
      `The result is JSON: check line_ranges for coverage and citations for verified/unverified claims. ` +
      `If you genuinely need exact content (e.g. to edit), either read a bounded section with ` +
      `offset/limit, or call allow-direct-read first, then retry this read.`
    )
  }

  function bashBlockMessage(command: string, detail: string): string {
    return (
      `PREMIUM_READ_OFFLOAD: this command was gated (${detail}). ` +
      `Reading a large file into context via bash spends premium subscription quota. ` +
      `Use the offload-read tool instead, or a targeted command (e.g. a pipe to grep), ` +
      `or call allow-direct-read for the file first.`
    )
  }

  // ── worker invocation ─────────────────────────────────────────────────────

  /** Build the worker message: XML file boundaries + the question. */
  function buildMessage(question: string, corpus: Array<{ path: string; content: string }>): string {
    const parts: string[] = []
    for (const f of corpus) {
      parts.push(`<file path="${f.path}">\n${f.content}\n</file>\n`)
    }
    parts.push(`Question: ${question}\n`)
    return parts.join("\n")
  }

  function readCorpus(paths: string[]): Array<{ path: string; content: string }> {
    const out: Array<{ path: string; content: string }> = []
    for (const p of paths) {
      const full = abs(p)
      if (!fs.existsSync(full) || !fs.statSync(full).isFile()) {
        throw new Error(`file not found or unreadable: ${p}`)
      }
      out.push({ path: full, content: fs.readFileSync(full, "utf-8") })
    }
    return out
  }

  /** Reused throwaway data home for worker sessions (keeps them out of the
   * user's real session list, and makes them prunable). */
  function workerDataDir(): string {
    const override = process.env.LLMHP_OFFLOAD_DATA_DIR
    const runtime = process.env.XDG_RUNTIME_DIR
    const base = override ?? (runtime ? path.join(runtime, "premium-read-offload") : path.join(os.tmpdir(), "premium-read-offload"))
    fs.mkdirSync(base, { recursive: true })
    linkWorkerAuth(base)
    return base
  }

  /**
   * The worker runs with XDG_DATA_HOME pointed at `base` so its sessions stay
   * out of the user's list. But built-in providers (deepseek, kimi-for-coding,
   * …) authenticate from `auth.json` in that data home — with an empty one the
   * worker's model call 401s and offload-read fails with "worker produced no
   * text output". Link the real auth (and account) files in, falling back to a
   * copy where symlinks are unavailable.
   */
  function linkWorkerAuth(base: string): void {
    try {
      const opencodeDir = path.join(base, "opencode")
      fs.mkdirSync(opencodeDir, { recursive: true })
      const realData = process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share")
      for (const name of ["auth.json", "account.json"]) {
        const target = path.join(opencodeDir, name)
        if (fs.existsSync(target)) continue
        const source = path.join(realData, "opencode", name)
        if (!fs.existsSync(source)) continue
        try {
          fs.symlinkSync(source, target)
        } catch {
          fs.copyFileSync(source, target)
        }
      }
    } catch (e) {
      logger.warn(`could not link worker auth (offload may 401): ${(e as Error).message}`)
    }
  }

  /** Corpus line count across all paths, or -1 if any file cannot be read. */
  function corpusLineCount(paths: string[]): number {
    let total = 0
    for (const p of paths) {
      const n = countFileLines(abs(p))
      if (n < 0) return -1
      total += n
    }
    return total
  }

  /** Outcome of a worker turn, with the telemetry the tool records. */
  interface WorkerOutcome {
    /** Worker text with failing citations tagged [unverified]. */
    answer: string
    cacheHit: boolean
    corpusLines: number
    latencyMs: number
    paths: string[]
    workerSession: string | null
    lineRanges: Record<string, LineRange>
    verification: CitationReport | null
  }

  /** Mechanically verify the worker's [cite: path:line "quote"] annotations.
   * Returns null (contract marks verification:"error") when the Java core
   * cannot be reached — verification must never break an offload. */
  async function verifyCitations(answer: string, paths: string[]): Promise<{ answer: string; citations: CitationReport } | null> {
    const r = await java(["verify-answer", root, ...paths], answer)
    try {
      const j = JSON.parse(r.stdout.trim())
      if (typeof j?.answer === "string" && j?.citations) return { answer: j.answer, citations: j.citations }
    } catch {
      // fall through to null
    }
    return null
  }

  /**
   * Run one worker turn against a corpus. Reuses the stored worker session for
   * the corpus when present (cache hit), else loads the corpus into a fresh
   * session. The key binds the corpus fingerprint to its session id, so a
   * changed corpus can never resurrect an old (stale) worker session.
   *
   * <p>Returns null when the offload is not worth its startup cost (trivial
   * question or tiny corpus): the caller answers locally instead.
   */
  async function runWorker(question: string, paths: string[]): Promise<WorkerOutcome | null> {
    if (!paths.length) throw new Error("offload-read requires at least one path")

    const corpusPaths = paths.map(abs)
    const corpusLines = corpusLineCount(paths)
    const lineRanges = buildLineRanges(corpusPaths)

    // Look up the worker record for this exact corpus. The store compares the
    // stored fingerprint, so a changed corpus is a miss even if two corpora
    // hash to the same key — a stale session can never be resumed.
    const getRes = await jparse(["worker-get", root, ...corpusPaths])
    const existing: string | null = getRes?.sessionID ?? null
    const cacheHit = existing != null

    // "Did the worker earn its keep?" A cold worker (child startup ~seconds)
    // only pays for itself on a non-trivial question over a real corpus.
    const worth = await jparse(["worth-offload", root, String(cacheHit), String(corpusLines), question])
    if (worth?.worth === false) return null

    const dataDir = workerDataDir()
    const env = { XDG_DATA_HOME: dataDir }
    const started = Date.now()
    let stdout: string
    let workerSession: string | null = existing

    if (existing) {
      // Resume: corpus already in the worker's context → cache hit.
      const r = await safeSpawn(
        ["opencode", "run", "--format", "json", "--model", WORKER_MODEL, ...agentArgs(READER_AGENT), "-s", existing, "--", question],
        { cwd: root, env },
      )
      stdout = r.stdout
    } else {
      const corpus = readCorpus(paths)
      const message = buildMessage(question, corpus)
      // The assembled corpus can exceed Linux's 128 KiB per-argument limit
      // (MAX_ARG_STRLEN) and fail with E2BIG, so it goes on stdin, not argv
      // (design §9). `opencode run` reads piped stdin when stdin is not a TTY.
      // The `<file path="...">` blocks carry full paths (needed for citations);
      // no `-f` attachments, which would only carry basenames and re-send the
      // corpus a second time.
      const r = await safeSpawn(
        ["opencode", "run", "--format", "json", "--model", WORKER_MODEL, ...agentArgs(READER_AGENT)],
        { cwd: root, env, input: message },
      )
      stdout = r.stdout
      const sid = extractOpencodeSessionId(stdout)
      if (sid) {
        workerSession = sid
        await jparse(["worker-set", root, sid, ...corpusPaths])
      }
    }

    const text = extractOpencodeText(stdout)
    if (!text) throw new Error("worker produced no text output")

    // Verify the worker's citations against the corpus it was actually given.
    // Fail open: if the core is unreachable the answer passes through
    // unannotated and the contract marks verification:"error".
    let answer = text
    let verification: CitationReport | null = null
    try {
      const v = await verifyCitations(text, corpusPaths)
      if (v) { answer = v.answer; verification = v.citations }
    } catch (e) {
      logger.warn(`citation verification failed (answer returned unannotated): ${(e as Error).message}`)
    }

    return { answer, cacheHit, corpusLines, latencyMs: Date.now() - started, paths: corpusPaths, workerSession, lineRanges, verification }
  }

  async function runWorkerWithTimeout(question: string, paths: string[]): Promise<WorkerOutcome | null> {
    return await Promise.race([
      runWorker(question, paths),
      new Promise<null>((_, reject) =>
        setTimeout(() => reject(new Error(`worker timed out after ${WORKER_TIMEOUT_MS}ms`)), WORKER_TIMEOUT_MS),
      ),
    ])
  }

  return {
    ...hooks,
    tool: {
      "offload-read": tool({
        description:
          "Delegate a bulk file read to the cheap DeepSeek worker instead of reading the files into this " +
          "premium session's context. Returns JSON, not file bytes: {answer, files_read, line_ranges, " +
          "worker_session, cache_hit, citations, verification}. Read `answer` for the derived summary " +
          "(correct for understanding, wrong for editing), and use the provenance fields to judge coverage: " +
          "`files_read`/`line_ranges` say what the worker saw, `cache_hit` says whether it was a cheap resumed " +
          "turn, and `citations` reports how many worker claims were mechanically verified against the files " +
          "(claims with unresolvable citations are tagged [unverified] in `answer`). Files are cached in a " +
          "persistent worker session, so follow-up questions about the same files are cheap.",
        args: {
          question: tool.schema.string().describe("What you need to know about the files"),
          paths: tool.schema.array(tool.schema.string()).describe("File paths to hand to the worker"),
        },
        async execute({ question, paths }: { question: string; paths: string[] }) {
          try {
            const outcome = await runWorkerWithTimeout(question, paths)
            if (!outcome) {
              // The guard declined: too trivial or too small to justify a worker.
              await metric({ op: "offload-read", outcome: "skipped-not-worth", question, paths: paths.map(abs) })
              return JSON.stringify({
                skipped: true,
                reason: "question is trivial or corpus is small — not worth a worker round-trip",
                hint: "Read the file directly (it is small), or read a bounded section with offset/limit, and answer in-session.",
              })
            }
            await metric({
              op: "offload-read",
              outcome: "done",
              cacheHit: outcome.cacheHit,
              corpusLines: outcome.corpusLines,
              latencyMs: outcome.latencyMs,
              answerChars: outcome.answer.length,
              workerSession: outcome.workerSession,
              citationsVerified: outcome.verification?.verified,
              citationsUnverified: outcome.verification?.unverified,
              paths: outcome.paths,
              workerModel: WORKER_MODEL,
            })
            return buildOffloadContract({
              answer: outcome.answer,
              filesRead: outcome.paths,
              lineRanges: outcome.lineRanges,
              workerSession: outcome.workerSession,
              cacheHit: outcome.cacheHit,
              verification: outcome.verification,
            })
          } catch (e) {
            await metric({ op: "offload-read", outcome: "error", detail: String(e), paths: paths.map(abs) })
            return JSON.stringify({ error: "offload failed", detail: String(e), hint: "Retry, or use a targeted read / allow-direct-read." })
          }
        },
      }),

      "allow-direct-read": tool({
        description:
          "Grant a one-shot permission to read a large file directly into this premium session, bypassing the " +
          "offload gate once. Use only when exact content is genuinely needed (e.g. before editing). " +
          "The permission applies to the next read of that path in this session.",
        args: {
          path: tool.schema.string().describe("File path to permit a direct read for"),
          reason: tool.schema.string().describe("Why exact content is needed (recorded in the audit log)"),
        },
        async execute({ path: p, reason }: { path: string; reason: string }, context: { sessionID: string }) {
          try {
            const r = await jparse(["grant-direct", root, context.sessionID, abs(p)])
            logger.info(`allow-direct-read granted: ${p} — ${reason}`)
            return JSON.stringify({ granted: r?.granted === true, path: p, reason })
          } catch (e) {
            return JSON.stringify({ granted: false, detail: String(e) })
          }
        },
      }),

      "code-write": tool({
        description:
          "Delegate boilerplate code generation to the cheap DeepSeek worker. Use for tests, config, docstrings, " +
          "type stubs — any generation where >80% is predictable from reference files. Returns the generated code; " +
          "pass `target` to write it to disk. Review the output for the ~5-20% that needs judgment.",
        args: {
          spec: tool.schema.string().describe("What to generate"),
          reference: tool.schema.string().describe("File whose patterns/conventions the output must match (required)"),
          target: tool.schema.string().optional().describe("Path to write the generated code to; omit to return it"),
        },
        async execute({ spec, reference, target }: { spec: string; reference: string; target?: string }) {
          if (!reference) {
            return JSON.stringify({ error: "reference is required — the worker needs a file to match patterns against" })
          }
          try {
            const refFull = abs(reference)
            if (!fs.existsSync(refFull)) {
              return JSON.stringify({ error: `reference file not found: ${reference}` })
            }
            const ref = fs.readFileSync(refFull, "utf-8")
            const message = `Spec: ${spec}\n\nReference:\n${ref}\n`
            if (process.env[NO_SUBSPAWN_ENV] === "1") return "Offload disabled in subprocess."
            const started = Date.now()
            // Large references would blow the per-argument limit on argv, so
            // the prompt goes on stdin (same E2BIG fix as offload-read).
            const r = await safeSpawn(
              ["opencode", "run", "--format", "json", "--model", WORKER_MODEL, ...agentArgs(WRITER_AGENT)],
              { cwd: root, env: { XDG_DATA_HOME: workerDataDir() }, input: message },
            )
            let code = extractOpencodeText(r.stdout)
            if (!code) {
              await metric({ op: "code-write", outcome: "error", detail: "worker produced no output", reference: refFull, workerModel: WORKER_MODEL })
              return JSON.stringify({ error: "worker produced no output" })
            }
            // Strip markdown fences the worker sometimes adds.
            code = code.replace(/^```[a-zA-Z]*\n/gm, "").replace(/^```\s*$/gm, "")
            await metric({
              op: "code-write",
              outcome: "done",
              reference: refFull,
              target: target ? abs(target) : null,
              generatedLines: code.split("\n").length,
              latencyMs: Date.now() - started,
              workerModel: WORKER_MODEL,
            })
            if (target) {
              const targetFull = abs(target)
              fs.mkdirSync(path.dirname(targetFull), { recursive: true })
              fs.writeFileSync(targetFull, code)
              logger.info(`code-write wrote ${code.split("\n").length} lines to ${target}`)
              return JSON.stringify({ wrote: target, lines: code.split("\n").length })
            }
            return code
          } catch (e) {
            await metric({ op: "code-write", outcome: "error", detail: String(e), reference, workerModel: WORKER_MODEL })
            return JSON.stringify({ error: "code-write failed", detail: String(e) })
          }
        },
      }),

      "offload-status": tool({
        description: "Report the premium-read-offload gate status for the current session (premium? thresholds? worker model?).",
        args: {},
        async execute() {
          const workerIds = await jparse(["worker-list", root])
          return JSON.stringify({
            workerModel: WORKER_MODEL,
            dataDir: workerDataDir(),
            thresholds: {
              premium: process.env.LLMHP_OFFLOAD_MIN_LINES ?? "1000",
              zai: process.env.LLMHP_OFFLOAD_ZAI_MIN_LINES ?? "400",
              targetedMax: process.env.LLMHP_OFFLOAD_TARGETED_MAX ?? "2000",
              minWorthLines: process.env.LLMHP_OFFLOAD_MIN_WORTH_LINES ?? "200",
            },
            workerTtlDays: WORKER_TTL_DAYS,
            workerSessions: workerIds?.sessionIDs ?? [],
            metrics: `${metricsPath()} (JSONL; one record per offload/code-write, skipped, or error)`,
          })
        },
      }),
    },
  }
}
