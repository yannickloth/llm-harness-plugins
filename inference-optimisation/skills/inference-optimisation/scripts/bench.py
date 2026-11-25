#!/usr/bin/env python3
"""Engine-agnostic hill-climb benchmark for any OpenAI-compatible server (vLLM, SGLang, llama.cpp server,
TabbyAPI, MLX-LM server, LM Studio, Ollama's /v1 ...). Standard library only.

  python3 bench.py run configs/NAME.json [--long N] [--skip-cN] [--reps N] [--sustained-cN]
  # --reps defaults to 2 x panel size (12 on the shipped 6-prompt panel): the per-prompt output-length
  # guard needs each prompt sent at least twice. Passing fewer flags the run OUT_LEN_UNTESTED.
  python3 bench.py show [ledger.jsonl]

Config (JSON):
  {
    "name": "ctl-a",                              # unique run name (ledger key)
    "base_url": "http://127.0.0.1:8000",
    "model": "my-model",                           # served model name
    "launch": ["docker", "run", "-d", "..."],      # optional; omit to benchmark an already-running server
    "stop":   ["docker", "stop", "-t", "60", "srv"],  # optional; run after a drain wait
    "health_timeout_s": 900,
    "concurrency": 4,                              # N for the cN test
    "prefill_lengths": [4096, 32768],              # approximate prompt tokens for cold prefill
    "prompts": ["...", "..."],                     # optional >= 6 prompt panel; fixed, never randomised
    "sustained_ctx": 16384, "sustained_out": 2048,  # for --sustained-cN
    "extra_body": {"chat_template_kwargs": {"enable_thinking": false}},  # merged into every request
    "temperature": 0.6,
    "memory": {"cap_gib": 46, "probe": ["bash", "mem.sh", "srv"], "interval_s": 3},  # probe prints bytes
    "require_ac": true                             # refuse to run on battery (Linux / macOS)
  }

Measurements (all token counts come from the server's usage stats, never from streamed chunks):
  startup_s, ttft_short_ms, c1_decode (median of --reps), c1_all, cN_aggregate (wall clock), cN_per_stream,
  cN_sustained_aggregate (--sustained-cN: N streams at sustained_ctx to sustained_out),
  prefill_<L> (prompt_tokens / TTFT on a unique cold prompt), long-context needle retrieval (--long),
  out_tokens_median + out_tokens_spread_pct (output-length instability: the worst spread among
  REPEATS OF THE SAME PROMPT - a speed win that shortens answers is not a win) +
  out_tokens_coverage_pct (share of panel prompts seen >= 2 times, i.e. testable; 0 when reps <
  panel size, and then out_tokens_spread_pct is null, NOT zero) +
  out_tokens_by_prompt (per-prompt median completion tokens IN PANEL ORDER - this is what the NEXT run
  compares against with `stats.py outlen`; the spread guard is blind to a lever that scales every answer
  by the same factor, which has spread exactly 0%) +
  out_tokens_panel_spread_pct (cross-prompt spread, informational only: a panel with prompts of
  different intended length has a large one, and speculation changes length by design),
  mem_peak_gib (steady-state footprint, warmup readings excluded), mem_peak_warmup_gib
  (startup allocation, when warmup_probes > 0 - compare the two: a config whose steady state
  equals its startup spike never gave the memory back), mem_watchdog (ok | off | failed),
  state_start / state_end (driver,
  kernel, GPU, CPU, python: compare them across the runs of one experiment and void a run that
  differs), flags (LOOP, REQ_FAIL, ON_BATTERY, MEM_CAP, MEM_WATCHDOG_FAILED, STATE_CHANGED,
  OUT_LEN_UNSTABLE, OUT_LEN_UNTESTED). Results are appended to ledger.jsonl.
The server is left running after a run (the next run's launch stops it first); stop it yourself when done.
"""
import json, os, random, re, statistics, string, subprocess, sys, threading, time, urllib.request
from concurrent.futures import ThreadPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__))
PROMPTS = [  # fixed panel: acceptance and speed depend on content, so never randomise these
    "Write a Python implementation of an LRU cache with O(1) get and put, with docstrings and tests.",
    "Explain, step by step, how TCP congestion control works, including slow start and fast recovery.",
    "Write a short story (about 600 words) about a lighthouse keeper who finds a message in a bottle.",
    "Compare B-trees and LSM-trees for a write-heavy database workload. Use a table and give a recommendation.",
    "Write a bash script that backs up a directory to a timestamped tar.gz and keeps only the last 7 backups.",
    "Summarise the causes and consequences of the 1929 stock market crash in five paragraphs.",
]
TOKENS_PER_WORD = 3.5  # measured, not guessed: random-word filler text tokenizes at ~3.5 tok/word.
                       # Getting this wrong turned nominal "32K/128K" cells into real 58K/232K cells.
                       # Re-measure it with the target tokenizer if you can; prompt_tokens in the
                       # ledger is always the truth, this only sizes the request.
WORDS = ("river stone paper cloud engine garden silver market winter orange signal harbor violet "
         "candle forest mirror thunder copper meadow lantern").split()


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


class Server:
    def __init__(self, cfg):
        self.cfg, self.base = cfg, cfg.get("base_url", "http://127.0.0.1:8000").rstrip("/")

    def get(self, path, timeout=5):
        with urllib.request.urlopen(self.base + path, timeout=timeout) as r:
            return json.loads(r.read() or b"{}")

    def healthy(self):
        try:
            return bool(self.get("/v1/models").get("data"))
        except Exception:
            return False

    def chat(self, prompt, max_tokens, temperature=None, timeout=7200):
        """Stream one chat completion. Returns ttft, decode tok/s, prompt/completion tokens (server usage)."""
        body = {"model": self.cfg["model"], "messages": [{"role": "user", "content": prompt}],
                "max_tokens": max_tokens, "stream": True, "stream_options": {"include_usage": True},
                "temperature": self.cfg.get("temperature", 0.6) if temperature is None else temperature}
        body.update(self.cfg.get("extra_body", {}))
        req = urllib.request.Request(self.base + "/v1/chat/completions", data=json.dumps(body).encode(),
                                     headers={"Content-Type": "application/json"})
        t0 = time.monotonic(); t_first = None; text = []; usage = {}
        with urllib.request.urlopen(req, timeout=timeout) as r:
            for raw in r:
                line = raw.decode("utf-8", "replace").strip()
                if not line.startswith("data:"):
                    continue
                data = line[5:].strip()
                if data == "[DONE]":
                    break
                ev = json.loads(data)
                if ev.get("usage"):
                    usage = ev["usage"]
                for ch in ev.get("choices") or []:
                    d = ch.get("delta") or {}
                    piece = (d.get("content") or "") + (d.get("reasoning_content") or d.get("reasoning") or "")
                    if piece:
                        if t_first is None:
                            t_first = time.monotonic()
                        text.append(piece)
        t_end = time.monotonic()
        ct, pt = usage.get("completion_tokens"), usage.get("prompt_tokens")
        if t_first is None:
            t_first = t_end
        decode = (ct - 1) / (t_end - t_first) if ct and ct > 1 and t_end > t_first else None
        return {"ttft": t_first - t0, "decode": decode, "completion_tokens": ct, "prompt_tokens": pt,
                "wall": t_end - t0, "t0": t0, "t_end": t_end, "text": "".join(text)}


def tail_lines(text, periods=3):
    """True when the last `periods` non-empty LINES are identical and the line carries content.

    The word-level tail test cannot see compact structured output: a CSV row ("7,14") or a JSON object
    ("{\"id\": 9}") is ONE word, so the >= 2 distinct words per block floor rejects it and a model
    looping out identical rows to max_tokens is not flagged. Lines catch that class.

    Two exclusions keep it safe. A line with no alphanumeric character ("}", ")", "---") repeats
    legitimately at the end of nested code, so it never fires. And it takes THREE identical lines, not
    two: a table with one duplicated trailing row, a duplicated closing sentence and a list ending in a
    repeated item are all normal.

    What it does flag is irreducibly ambiguous: a table, CSV, JSON array or bullet list whose last three
    rows are genuinely identical is structurally indistinguishable from a model stuck on a 3-row cycle.
    That is why LOOP is advisory on structured output - read the flagged samples.
    """
    ls = [l.strip() for l in text.splitlines() if l.strip()]
    if len(ls) < periods:
        return False
    tail = ls[-periods:]
    if len(set(tail)) != 1:
        return False
    line = tail[0]
    if not any(c.isalnum() for c in line):
        return False
    return len(line.split()) >= 2 or len(line) >= 4


def tail_tokens(text, periods=3, max_period=12):
    """Tail-periodicity on a bracket-separated token stream: catches loops the word-level test misses.

    A model looping out JSON or CSV ends with a closing delimiter, and that delimiter defeats the
    word-level test: `[{"id": 1}, {"id": 2}, {"id": 1}, {"id": 1}, {"id": 1}]` tokenizes by whitespace to
    `... {"id": 1}]`, and the final `]` glued to the last value breaks the exact-match chain, so a real
    loop is not flagged. Splitting words and single punctuation characters apart makes the stream
    uniform: `1}]` becomes `1`, `}`, `]`, and the cycle lines up.

    Same rules as the word-level test (three full periods, at least two distinct tokens per block) plus
    an alphanumeric floor on the block, so a run of `}` `}` `}` from nested code is not a loop.
    """
    t = [x.lower() for x in re.findall(r"\w+|[^\w\s]", text)]
    for p in range(1, max_period + 1):
        if len(t) < periods * p or len(set(t[-p:])) < 2:
            continue
        if not any(c.isalnum() for c in t[-p:]):
            continue
        if all(t[i] == t[i + p] for i in range(len(t) - periods * p, len(t) - p)):
            return True
    return False


def looping(text, scales=((8, 0.5, 8), (4, 0.7, 8), (2, 0.85, 4)), max_period=12):
    """Degenerate-output flag: a cycle that runs to the end of the answer, or heavy n-gram repetition.

    Three tests, calibrated on measured repeat ratios (references/gotchas.md), not on intuition:

    1. Single-word stall: >= 4 words, all identical ("the the the the").
    2. Tail periodicity: the last `periods` blocks of p words are identical, for some p <= 12, with at
       least two distinct words in the block. This is the signature of a loop that runs to max_tokens.
       Three full periods and the distinctness floor are what make it safe: two identical trailing rows
       in a table, a trailing "}\n}" in code, a duplicated item at the end of a list and a repeated
       closing sentence all flagged as loops under a two-period rule, and all pass at three.
       Matching is case-insensitive, so a sentence loop that capitalizes each cycle is caught.
    3. n-gram repetition at 8-, 4- and 2-gram scales, each with its OWN threshold and sample floor,
       because the ratio a normal answer reaches rises as the scale shrinks: measured on code, a JSON
       array, a markdown table, a 60-item numbered list, varied prose, a 29-word answer that
       legitimately repeats a 2-word term 10 times, and a name list, the 8-gram ratio is 0.00-0.50, the
       4-gram ratio 0.00-0.58 and the 2-gram ratio 0.00-0.74. One shared 0.5 threshold at all three
       scales flagged that 29-word answer (2-gram ratio 0.607) as degenerate. Thresholds 0.5 / 0.7 /
       0.85 with floors 8 / 8 / 4 measured zero false positives on those outputs.

    Calibrated result, measured on 44 cases: **zero false positives on 20 normal outputs** (prose, code,
    JSON arrays, markdown tables, numbered lists, name lists, YAML, multilingual prose, short answers, a
    repeated-term answer, tables with a duplicated trailing row, JSON with a duplicated trailing object,
    code ending in four closing braces, code ending in three closing braces, an answer repeating its
    closing sentence twice, a code block ending in two identical lines) **and 18 of 19 degenerate ones
    caught** (word stalls from 4 words up, 3- and 4-word cycles at 15-60 words, a 5-word phrase looped to
    the end, a case-varying sentence loop, a ChatML-style role loop, a CSV row loop, a pretty-printed JSON
    object loop, a numbered-list loop, a bullet-list loop, code repeating one line to the end, multilingual
    and CJK loops). Two documented blind spots: (1) a 3-word cycle that stops at 8 words; (2) a
    **single-line** JSON array whose trailing objects are identical - the closing `]` glued to the last
    value breaks every exact-match chain, and the n-gram ratios stay under threshold. Blind spot (2) is
    caught by a different gate: a loop that runs to max_tokens inflates `out_tokens_median`, and
    `stats.py outlen` flags it as LENGTHENED. A clean `LOOP` flag is not proof of clean output.

    Structured output with three genuinely identical trailing rows (table, CSV, YAML) IS flagged, and that
    is irreducible: it is structurally indistinguishable from a 3-row cycle. That is why `LOOP` is
    advisory - read the flagged text.
    """
    w = [x.lower() for x in text.split()]
    if len(w) >= 4 and len(set(w)) == 1:
        return True
    if tail_lines(text):
        return True
    if tail_tokens(text):
        return True
    for p in range(1, max_period + 1):
        if len(w) < 3 * p or len(set(w[-p:])) < 2:
            continue
        if all(w[i] == w[i + p] for i in range(len(w) - 3 * p, len(w) - p)):
            return True
    for n, thr, min_grams in scales:
        grams = [tuple(w[i:i + n]) for i in range(max(0, len(w) - n + 1))]
        if len(grams) >= min_grams and 1 - len(set(grams)) / len(grams) > thr:
            return True
    return False


def document(tokens, seed, needles=3):
    """Unique filler document of ~`tokens` tokens with `needles` retrieval codes at spread depths.

    TOKENS_PER_WORD is measured, not guessed: random-word filler text tokenizes at ~3.5 tokens per
    word on a modern BPE tokenizer, and getting this wrong is what turned nominal "32K/128K" cells
    into real 58K/232K cells. The real count always comes back as prompt_tokens and is what gets
    reported - the estimate only sizes the request.
    """
    rng = random.Random(seed)
    n_words = int(tokens / TOKENS_PER_WORD)
    words = [rng.choice(WORDS) for _ in range(n_words)]
    codes = ["".join(rng.choices(string.ascii_uppercase + string.digits, k=8)) for _ in range(needles)]
    for i, c in enumerate(codes):
        pos = int(n_words * (i + 1) / (needles + 1))
        words.insert(pos, f". The secret code number {i + 1} is {c}. ")
    head = f"[doc {seed}-{time.time_ns()}] "  # defeats prefix caching
    q = "\n\nList every secret code number and its value that appears in the document above. Answer only with the codes."
    return head + " ".join(words) + q, codes


def on_ac():
    try:
        if sys.platform == "darwin":
            return "AC Power" in subprocess.run(["pmset", "-g", "batt"], capture_output=True, text=True).stdout
        import glob
        vals = [open(p).read().strip() for p in glob.glob("/sys/class/power_supply/*/online")]
        return not vals or "1" in vals
    except Exception:
        return True


def prev_state(path="ledger.jsonl"):
    """The state_end of the last ledger line, for cross-run drift detection. None if no ledger."""
    try:
        last = None
        with open(path) as f:
            for line in f:
                if line.strip():
                    last = line
        return json.loads(last).get("state_end") if last else None
    except (FileNotFoundError, json.JSONDecodeError):
        return None


def sysstate():
    """Environment fingerprint. The ground rule is 'void the run if the state changed', and
    that is only enforceable if the state is actually recorded. bench.py records it; the
    agent compares it between the ledger lines of one experiment."""
    def sh(cmd):
        try:
            return subprocess.run(cmd, capture_output=True, text=True, timeout=10).stdout.strip()
        except Exception:
            return None
    st = {"kernel": None, "driver": None, "cpu": None, "py": sys.version.split()[0]}
    try:
        st["kernel"] = " ".join(sh(["uname", "-sr"]) or "").strip() or None
    except Exception:
        pass
    try:
        import platform
        st["cpu"] = platform.processor() or None
    except Exception:
        pass
    nv = sh(["nvidia-smi", "--query-gpu=driver_version,name", "--format=csv,noheader"])
    if nv:
        st["driver"] = nv.split(",")[0].strip()
        st["gpu"] = nv.strip()
    return {k: v for k, v in st.items() if v}


class MemWatch(threading.Thread):
    """Polls the probe for the real footprint. A probe that prints nothing is a *failure*,
    not a 0: it is counted and the run is flagged, so the cap can't be silently unenforced.
    That was the exact mem.sh bug: a dead probe read as 0 and tripped nothing.

    `warmup_probes` valid readings are treated as engine startup allocation: cap-checked like
    every other reading, reported separately as `mem_peak_warmup_gib`, and excluded from
    `mem_peak_gib` so the ledger compares steady-state footprints, not startup spikes."""
    def __init__(self, mcfg, on_trip):
        super().__init__(daemon=True)
        self.mcfg, self.on_trip = mcfg, on_trip
        self.peak, self.peak_warm, self.warm_left = 0, 0, 0
        self.tripped, self.stop = False, threading.Event()
        self.ok_reads, self.fail_reads, self.cap = 0, 0, mcfg.get("cap_gib") * 2**30

    def run(self):
        # warmup_probes: how many valid readings count as engine startup allocation. Those are
        # cap-checked exactly like every other reading (a cap is a cap), and they are reported as
        # mem_peak_warmup_gib, but they are kept OUT of mem_peak_gib, which is the steady-state
        # footprint the ledger compares between configs. Without this, a config that allocates a
        # large buffer at startup and frees it looks like it holds that memory all run.
        warm = max(0, int(self.mcfg.get("warmup_probes", 3)))
        self.warm_left = warm
        while not self.stop.wait(self.mcfg.get("interval_s", 3)):
            out = None
            try:
                r = subprocess.run(self.mcfg["probe"], capture_output=True, text=True, timeout=30)
                if r.returncode != 0:
                    self.fail_reads += 1
                    continue
                out = (r.stdout.strip() or "").splitlines()
            except Exception:
                self.fail_reads += 1
                continue
            if not out or not out[-1].strip().lstrip("-").isdigit():
                self.fail_reads += 1
                continue
            b = int(out[-1])
            self.ok_reads += 1
            if self.warm_left > 0:
                self.warm_left -= 1
                self.peak_warm = max(self.peak_warm, b)
            else:
                self.peak = max(self.peak, b)
            if b > self.cap and not self.tripped:
                self.tripped = True
                log(f"MEMORY CAP EXCEEDED: {b / 2**30:.1f} GiB > {self.cap / 2**30:.1f} GiB"
                    + (" (during warmup)" if self.warm_left < warm else ""))
                self.on_trip()

    def failed(self):
        """True if we never got a single valid reading (probe dead on this platform)."""
        return self.ok_reads == 0 and self.fail_reads >= 1


def run(cfg_path, long_ctx=None, skip_cn=False, reps=None, sustained_cn=False):
    try:
        cfg = json.load(open(cfg_path))
    except FileNotFoundError:
        sys.exit(f"bench.py: config '{cfg_path}' not found (run from the directory holding configs/)")
    except json.JSONDecodeError as e:
        sys.exit(f"bench.py: config '{cfg_path}' is not valid JSON: {e}")
    mem = cfg.get("memory", {})
    if mem.get("probe") and "cap_gib" not in mem:
        sys.exit("bench.py: memory.probe is set but memory.cap_gib is missing; refusing to run "
                 "with an unbounded cap (the watchdog would trip nothing)")
    # Acceptance depends on prompt content, so the panel is fixed per config, never randomised.
    # A 6-prompt panel is the floor; at long context or with speculation, use >= 12 spanning
    # code, prose, structured output and multilingual text, or a win can be prompt-specific.
    panel = cfg.get("prompts") or PROMPTS
    if len(panel) < 6:
        sys.exit("bench.py: config 'prompts' must hold at least 6 prompts")
    if reps is None:
        # Default to two passes over the panel. The per-prompt output-length guard needs each prompt
        # sent at least twice, so the old default of 6 reps on a 6-prompt panel measured nothing.
        reps = 2 * len(panel)
    if reps < 2 * len(panel):
        # With reps < 2 x panel, most prompts are sent ONCE, so the per-prompt output-length guard has
        # nothing to compare. Say it up front: at reps=6 and a 6-prompt panel the guard sees ZERO
        # prompts, and a clean spread in the ledger means "not measured", not "stable".
        log(f"WARNING: reps={reps} < 2 x panel={len(panel)}: only {max(0, reps - len(panel))} of "
            f"{len(panel)} prompts get a repeat, so the per-prompt length guard is largely blind "
            f"(expect OUT_LEN_UNTESTED); pass --reps {2 * len(panel)} to cover the whole panel")
    srv, res, flags = Server(cfg), {"name": cfg["name"], "time": time.strftime("%Y-%m-%dT%H:%M:%S")}, []
    res["state_start"] = sysstate()
    if cfg.get("require_ac") and not on_ac():
        sys.exit("refusing to run on battery (require_ac)")

    def stop_server():
        if cfg.get("stop"):
            subprocess.run(cfg["stop"], capture_output=True)

    watch = MemWatch(cfg["memory"], stop_server) if cfg.get("memory", {}).get("probe") else None
    if cfg.get("launch"):
        stop_server()
        t0 = time.monotonic()
        subprocess.run(cfg["launch"], check=True, capture_output=True)
        if watch:
            watch.start()
        deadline = t0 + cfg.get("health_timeout_s", 900)
        while not srv.healthy():
            if time.monotonic() > deadline or (watch and watch.tripped):
                res.update(ok=False, error="server did not become healthy")
                return finish(res, flags, watch)
            time.sleep(1)
        res["startup_s"] = round(time.monotonic() - t0, 1)
        log("healthy after", res["startup_s"], "s")
    else:
        if not srv.healthy():
            sys.exit("server not reachable and no launch command given")
        if watch:
            watch.start()
    try:
        srv.chat("Say hello.", 16)  # warm-up (not measured)
        r = srv.chat("Reply with the single word: ready", 8)
        res["ttft_short_ms"] = round(r["ttft"] * 1000, 1)

        c1, lens = [], []
        obs = []  # (prompt_index, completion_tokens): keyed by the prompt SENT, not by list position
        for i in range(reps):
            r = srv.chat(panel[i % len(panel)], 512)
            if r["decode"]:
                c1.append(round(r["decode"], 2))
            if r["completion_tokens"]:
                obs.append((i % len(panel), r["completion_tokens"]))
            if looping(r["text"]):
                flags.append("LOOP")
        lens = [x[1] for x in obs]
        res["c1_decode"] = round(statistics.median(c1), 2) if c1 else None
        res["c1_all"] = c1
        # Quality guard: a speed win that shortens or degenerates output is not a win.
        # Needle retrieval and greedy equivalence do not catch "answers got blander".
        if len(lens) >= 3:
            res["out_tokens_median"] = statistics.median(lens)
            # Spread is measured PER PROMPT. A panel whose prompts intend different answer lengths has
            # a large intrinsic cross-prompt spread (a 3-word and a 200-word answer in one panel is not
            # instability), and speculative decoding legitimately changes accepted length - that is its
            # whole mechanism - so a cross-prompt spread flagged the best lever on the panel's own
            # composition. Only repeats of the SAME prompt moving around is instability.
            by_prompt = {}
            for pi, ln in obs:
                by_prompt.setdefault(pi, []).append(ln)
            tested = {pi: vs for pi, vs in by_prompt.items() if len(vs) >= 2 and statistics.median(vs) > 0}
            # Per-prompt medians in panel order, so the NEXT run can compare them against this one with
            # `stats.py outlen`. The spread guard is blind to a lever that scales every answer by the
            # same factor (spread exactly 0%), and the speed test compares tok/s, not length - this list
            # is what makes a uniform shortening visible.
            res["out_tokens_by_prompt"] = [
                (round(statistics.median(by_prompt[p]), 1) if p in by_prompt else None)
                for p in range(len(panel))
            ]
            res["out_tokens_coverage_pct"] = round(100 * len(tested) / len(panel), 1)
            res["out_tokens_spread_pct"] = (round(max(
                100 * (max(vs) - min(vs)) / statistics.median(vs) for vs in tested.values()), 1)
                if tested else None)
            res["out_tokens_panel_spread_pct"] = round(
                100 * (max(lens) - min(lens)) / statistics.median(lens), 1)
            if not tested:
                # reps < 2 x panel size means most prompts are seen once, so the per-prompt guard
                # measures nothing. Say so in the ledger: a 0.0% spread here is ABSENCE OF MEASUREMENT,
                # not evidence of stability.
                flags.append("OUT_LEN_UNTESTED")
            elif res["out_tokens_spread_pct"] > 60:
                flags.append("OUT_LEN_UNSTABLE")
        log("c1 median", res["c1_decode"], c1)

        n = int(cfg.get("concurrency", 4))
        if n > 1 and not skip_cn:
            with ThreadPoolExecutor(n) as ex:
                rs = list(ex.map(lambda i: srv.chat(panel[i % len(panel)], 512), range(n)))
            toks = sum((x["completion_tokens"] or 0) for x in rs)
            wall = max(x["t_end"] for x in rs) - min(x["t0"] for x in rs)
            res[f"c{n}_aggregate"] = round(toks / wall, 2)
            res[f"c{n}_per_stream"] = [round(x["decode"] or 0, 2) for x in rs]
            log(f"c{n} aggregate", res[f"c{n}_aggregate"])
            # Burst cN with 512-token outputs never fills the KV pool, so it cannot see the
            # collapse a sized pool is meant to prevent. --sustained-cN runs N streams at a
            # long prompt to a long output: that is the number the KV ceiling predicts.
            if sustained_cn:
                L = int(cfg.get("sustained_ctx", 16384))
                out = int(cfg.get("sustained_out", 2048))
                docs = [document(L, seed=L + i)[0] for i in range(n)]
                with ThreadPoolExecutor(n) as ex:
                    rs2 = list(ex.map(lambda i: srv.chat(docs[i], out), range(n)))
                toks2 = sum((x["completion_tokens"] or 0) for x in rs2)
                wall2 = max(x["t_end"] for x in rs2) - min(x["t0"] for x in rs2)
                res[f"c{n}_sustained_aggregate"] = round(toks2 / wall2, 2) if wall2 > 0 else None
                res[f"c{n}_sustained_ctx"] = L
                # The requested context is an estimate; the server's token count is the measurement.
                # If these disagree, the ceiling comparison is against the wrong context length.
                res[f"c{n}_sustained_prompt_tokens"] = [x["prompt_tokens"] for x in rs2]
                res[f"c{n}_sustained_ttft_s"] = [round(x["ttft"], 1) for x in rs2]
                log(f"c{n} sustained", res[f"c{n}_sustained_aggregate"], f"at ~{L} ctx",
                    "actual prompt_tokens", res[f"c{n}_sustained_prompt_tokens"])

        for L in cfg.get("prefill_lengths", [4096, 32768]):
            prompt, _ = document(L, seed=L)
            r = srv.chat(prompt, 1, temperature=0.0)
            res[f"prefill_{L}"] = round(r["prompt_tokens"] / r["ttft"], 1) if r["prompt_tokens"] else None
            res[f"prefill_{L}_tokens"] = r["prompt_tokens"]
            log(f"prefill ~{L}", res[f"prefill_{L}"], "tok/s over", r["prompt_tokens"], "tokens")

        if long_ctx:
            prompt, codes = document(long_ctx, seed=7)
            r = srv.chat(prompt, 256, temperature=0.0)
            res["long"] = {"prompt_tokens": r["prompt_tokens"], "ttft_s": round(r["ttft"], 1),
                           "prefill": round(r["prompt_tokens"] / r["ttft"], 1) if r["prompt_tokens"] else None,
                           "decode": r["decode"] and round(r["decode"], 2),
                           "retrieval": f"{sum(c in r['text'] for c in codes)}/{len(codes)}"}
            log("long", res["long"])
        res["ok"] = True
    except Exception as e:
        res.update(ok=False, error=repr(e)); flags.append("REQ_FAIL")
    return finish(res, flags, watch)


def finish(res, flags, watch):
    if watch:
        watch.stop.set()
        res["mem_peak_gib"] = round(watch.peak / 2**30, 2)
        if watch.peak_warm:
            res["mem_peak_warmup_gib"] = round(watch.peak_warm / 2**30, 2)
        res["mem_watchdog"] = "failed" if watch.failed() else ("ok" if watch.ok_reads else "off")
        if watch.failed():
            flags.append("MEM_WATCHDOG_FAILED")
        if watch.tripped:
            flags.append("MEM_CAP"); res["ok"] = False
    res["state_end"] = sysstate()
    if res.get("state_start") != res.get("state_end"):
        flags.append("STATE_CHANGED"); res["ok"] = False
    # Cross-run drift: the harness cannot know which change was your lever, so this is a flag to
    # read, not an automatic void. Compare it against the intended lever; an unexplained diff voids
    # the comparison with the previous run.
    prev = prev_state("ledger.jsonl")
    if prev is not None and res.get("state_start") != prev:
        flags.append("CROSS_RUN_STATE_CHANGED")
        res["state_prev"] = prev
    if not on_ac():
        flags.append("ON_BATTERY"); res["ok"] = False
    res["flags"] = sorted(set(flags))
    try:
        with open("ledger.jsonl", "a") as f:
            f.write(json.dumps(res) + "\n")
    except OSError as e:
        print("bench.py: could not write ledger.jsonl:", e, file=sys.stderr)
    print(json.dumps(res, indent=1))
    if "CROSS_RUN_STATE_CHANGED" in res["flags"]:
        print("NOTE: the machine fingerprint differs from the previous ledger run. Confirm the diff")
        print("      is exactly the lever you changed; if it is not, this run does not compare.")
    return res


def show(path="ledger.jsonl"):
    try:
        rows = [json.loads(l) for l in open(path) if l.strip()]
    except FileNotFoundError:
        sys.exit(f"bench.py: no {path} yet. Run one experiment first, then `bench.py show`.")
    agg = sorted({k for d in rows for k in d if k.startswith("c") and k.endswith("_aggregate")})
    pre = sorted({k for d in rows for k in d if k.startswith("prefill_") and k[8:].isdigit()}, key=lambda k: int(k[8:]))
    keys = ["c1_decode", *agg, *pre, "ttft_short_ms", "startup_s", "mem_peak_gib"]
    print("name".ljust(24) + "".join(k[:13].rjust(14) for k in keys) + "  flags")
    for d in rows:
        print(d["name"][:24].ljust(24) + "".join(str(d.get(k, "-"))[:13].rjust(14) for k in keys) + "  " + ",".join(d.get("flags", [])))


if __name__ == "__main__":
    a = sys.argv[1:]
    if not a or a[0] not in ("run", "show"):
        sys.exit(__doc__)
    if a[0] == "show":
        show(*(a[1:2]))
    else:
        opt = lambda k, d=None: a[a.index(k) + 1] if k in a else d
        run(a[1], long_ctx=int(opt("--long")) if opt("--long") else None, skip_cn="--skip-cN" in a,
            reps=int(opt("--reps")) if opt("--reps") else None, sustained_cn="--sustained-cN" in a)
