#!/usr/bin/env bash
# Real memory footprint (bytes) of a model server, for bench.py's memory watchdog.
#
#   mem.sh CONTAINER [unified]        # dockerised server
#   mem.sh --pid PID [unified]        # native server (llama.cpp, vLLM, MLX, LM Studio, Ollama)
#
# Contract with bench.py, and why it is written this way:
#   success -> one integer on stdout, exit 0.
#   failure -> NOTHING on stdout, a reason on stderr, exit non-zero.
# A watchdog that prints 0 when it cannot measure is worse than no watchdog: bench.py reads
# 0, sees it under the cap, and the run proceeds with the memory cap unenforced. That is the
# exact failure this script had: `set -e` plus `pipefail` killed it at the `docker top` line,
# so the `echo 0` fallback was unreachable and the probe printed nothing at all. Every probe
# path here reports its own failure explicitly.
#
# Discrete NVIDIA: nvidia-smi per-process used memory + container/process anon RSS.
# Unified memory (Intel/AMD iGPU, Linux DRM): drm-resident-* deduplicated by drm-client-id
#   over the process tree + cgroup anon. Reading other users' fdinfo needs root: run the
#   watchdog with passwordless sudo for this script, or as root. Never embed a password.
# macOS: no per-process GPU accounting. Reports system-wide wired+compressed memory as a
#   proxy and says so on stderr. Apple Silicon caps GPU allocations at the sysctl
#   iogpu.wired_limit_mb; set that, do not rely on this probe to police it.
# Windows: not supported. Use nvidia-smi via a PowerShell probe of your own.
set -uo pipefail

fail() { echo "mem.sh: $*" >&2; exit 2; }

arg1=${1:-}
[ -z "$arg1" ] && fail "usage: mem.sh CONTAINER [unified] | mem.sh --pid PID [unified]"

pids=""
anon=0

if [ "$arg1" = "--pid" ]; then
  root_pid=${2:?mem.sh --pid needs a PID}
  mode=${3:-auto}
  [ -d "/proc/$root_pid" ] || fail "pid $root_pid does not exist"
  # Whole process tree: the engine forks scheduler/worker children that hold the buffers.
  # BFS over /proc/<pid>/stat parent fields. Cheap and dependency-free.
  declare -A tree
  queue=("$root_pid")
  while [ ${#queue[@]} -gt 0 ]; do
    cur=${queue[0]}; queue=("${queue[@]:1}")
    [ -n "${tree[$cur]:-}" ] && continue
    tree[$cur]=1
    pids="$pids $cur"
    for child in $(grep -l "" /proc/*/stat 2>/dev/null | cut -d/ -f3); do
      ppid=$(awk '{print $4}' "/proc/$child/stat" 2>/dev/null) || continue
      [ "$ppid" = "$cur" ] && queue+=("$child")
    done
  done
  for p in $pids; do
    r=$(awk '/^VmRSS:/{print $2}' "/proc/$p/status" 2>/dev/null)
    anon=$((anon + ${r:-0} * 1024))
  done
else
  c=$arg1
  mode=${2:-auto}
  command -v docker >/dev/null || fail "docker not on PATH; use 'mem.sh --pid PID' for a native server"
  pids=$(docker top "$c" -eo pid 2>/dev/null | tail -n +2 | tr '\n' ' ')
  rc=$?
  if [ $rc -ne 0 ] || [ -z "${pids// /}" ]; then
    fail "container '$c' has no readable processes (docker top rc=$rc); use 'mem.sh --pid PID'"
  fi
  cid=$(docker inspect -f '{{.Id}}' "$c" 2>/dev/null) || fail "docker inspect failed for '$c'"
  cg=$(ls -d /sys/fs/cgroup/system.slice/docker-"$cid".scope /sys/fs/cgroup/docker/"$cid" 2>/dev/null | head -1)
  if [ -n "$cg" ] && [ -r "$cg/memory.stat" ]; then
    anon=$(awk '/^anon /{print $2}' "$cg/memory.stat")
  else
    # No cgroup v1/v2 anon file: fall back to summing RSS of the container's processes.
    for p in $pids; do
      r=$(awk '/^VmRSS:/{print $2}' "/proc/$p/status" 2>/dev/null)
      anon=$((anon + ${r:-0} * 1024))
    done
  fi
fi

[ -z "${pids// /}" ] && fail "no processes resolved"

gpu=0
measured_gpu=0

if [ "$(uname -s)" = "Darwin" ]; then
  echo "mem.sh: macOS has no per-process GPU accounting; reporting system-wide wired+compressed" >&2
  page=$(vm_stat | awk '/page size of/{print $8}')
  [ -z "$page" ] && fail "vm_stat did not report a page size"
  wired=$(vm_stat | awk '/wired/{gsub(/\./,"",$4); print $4}')
  comp=$(vm_stat | awk '/compressed/{gsub(/\./,"",$4); print $4}')
  [ -z "$wired" ] && fail "vm_stat wired memory unreadable"
  echo $(( (${wired:-0} + ${comp:-0}) * ${page:-16384} ))
  exit 0
fi

if [ "$mode" != unified ] && command -v nvidia-smi >/dev/null; then
  snap=$(nvidia-smi --query-compute-apps=pid,used_memory --format=csv,noheader,nounits 2>/dev/null) \
    || fail "nvidia-smi failed; the GPU half of the cap is unmeasurable"
  [ -z "$snap" ] && fail "nvidia-smi reported no compute processes"
  for p in $pids; do
    m=$(printf '%s\n' "$snap" | awk -F', ' -v p="$p" '$1==p{print $2}')
    [ -n "$m" ] && measured_gpu=$((measured_gpu + 1))
    gpu=$((gpu + ${m:-0} * 1048576))
  done
  [ $measured_gpu -eq 0 ] && fail "nvidia-smi lists none of the server's pids; GPU memory unmeasured"
else
  declare -A seen
  found=0
  for p in $pids; do
    for f in /proc/"$p"/fdinfo/*; do
      [ -r "$f" ] || continue
      id=$(awk '/drm-client-id/{print $2}' "$f" 2>/dev/null)
      [ -z "$id" ] && continue
      [ -n "${seen[$id]:-}" ] && continue
      seen[$id]=1
      kb=$(awk '/drm-resident-/{s+=$2} END{print s+0}' "$f")
      gpu=$((gpu + kb * 1024))
      found=$((found + 1))
    done
  done
  if [ $found -eq 0 ]; then
    echo "mem.sh: no drm-resident-* entries found; reporting CPU RSS only (iGPU memory unmeasured)" >&2
  fi
fi

echo $((gpu + anon))
