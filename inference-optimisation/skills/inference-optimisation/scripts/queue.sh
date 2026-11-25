#!/usr/bin/env bash
# Serialized GPU queue: runs bench.py on each config in order, one GPU job at a time across all callers.
#
#   queue.sh ctl-a cand ctl-b            # interleave controls around each candidate
#   BENCH_FLAGS="--long 131072" queue.sh cand
#   SERVER_STOP="docker stop -t 60 srv" queue.sh cand   # run after every job, crashed or not
#
# Detach long queues so they survive agent/terminal restarts:
#   setsid nohup bash queue.sh ctl-a cand ctl-b > queue.log 2>&1 < /dev/null & disown
#
# Run from your experiment directory (the one holding configs/ and ledger.jsonl).
#
# Why the cleanup line is here: a run that dies mid-flight (OOM kill, driver fault, server
# that never became healthy) leaves the server up and half-configured. The next job then
# benchmarks a stale server and the comparison is silently invalid. With SERVER_STOP set,
# every job is followed by a stop, so the next job starts from a known state.
set -uo pipefail

if [ "$#" -eq 0 ]; then
  echo "queue.sh: no configs given." >&2
  echo "usage: queue.sh NAME [NAME ...]   # names are configs/NAME.json" >&2
  exit 2
fi

LOCK=${QUEUE_LOCK:-/tmp/inference-hillclimb.lock}
exec 9>"$LOCK" || { echo "queue.sh: cannot open lock $LOCK" >&2; exit 2; }
flock 9 || { echo "queue.sh: flock failed on $LOCK" >&2; exit 2; }

BENCH=${BENCH:-$(dirname "$0")/bench.py}
[ -f "$BENCH" ] || { echo "queue.sh: bench.py not found at $BENCH" >&2; exit 2; }

fails=0
for n in "$@"; do
  cfg="configs/$n.json"
  if [ ! -f "$cfg" ]; then
    echo "SKIP $n: $cfg does not exist"
    fails=$((fails + 1))
    continue
  fi
  python3 "$BENCH" run "$cfg" ${BENCH_FLAGS:-} > "runs-$n.log" 2>&1
  rc=$?
  if [ -n "${SERVER_STOP:-}" ]; then
    sh -c "$SERVER_STOP" >/dev/null 2>&1
  fi
  line=$(tail -c 300 "runs-$n.log" | tr '\n' ' ' | cut -c1-200)
  if [ $rc -ne 0 ]; then
    fails=$((fails + 1))
    echo "FAIL $n (rc=$rc): $line"
  else
    echo "done $n: $line"
  fi
done

if [ "$fails" -gt 0 ]; then
  echo "QUEUE_DONE $@ ($fails of $# did not complete)"
  exit 1
fi
echo "QUEUE_DONE $@"
