#!/usr/bin/env bash
# canary_preflight.sh <opencode> <opencode.json> — do the plugins of THIS config actually load in
# THIS binary? Exit 0 iff every plugin in the config's "plugin" array left its load marker
# (shared/load-canary.ts) in a headless probe; exit 1 — fail closed — if any is missing. The
# consumer (a pipeline, CI) must not launch real runs on exit 1: a dropped plugin means its
# guardrails are silently gone.
#
# The probe is free: `opencode run` loads plugins before any model call, so the probe uses a model
# id that cannot resolve (canary/no-credito) and dies right after init — same trick as polaris's
# dead API key (canario_preflight.sh, idea de {{CONTACTO}} con su agente KAI, 25-sep-2026). We kill
# the CLI as soon as the markers appear and never wait for its retries.
#
# Plugins only write markers when LLMHP_CANARY_DIR + LLMHP_CANARY_NONCE are set, so interactive
# sessions are untouched. Markers carry a sub-millisecond monotonic token (performance.now()), and
# the preflight verifies plugins initialized in the config's "plugin" order — the README's
# load-order table ("must load before...") is only as real as that. An OK is cached per (binary
# version + config content): rerun probes only after an upgrade or config change.
#   LLMHP_CANARY_WAIT  — max seconds waiting for markers (def. 60)
#   LLMHP_CANARY_STATE — stamp cache dir (def. ${TMPDIR:-/tmp}/llmhp-canary)
#   LLMHP_CANARY_ORDER — set to 0 to skip the init-order check
#   LLMHP_CANARY_OFF=1 — skip the check (exit 0 without probing)
set -u
BIN="${1:?uso: canary_preflight.sh <opencode> <opencode.json>}"
CFG="${2:?uso: canary_preflight.sh <opencode> <opencode.json>}"

[ -x "$(command -v "$BIN")" ] || { echo "canary: binary not runnable: $BIN" >&2; exit 1; }
[ -r "$CFG" ] || { echo "canary: config not readable: $CFG" >&2; exit 1; }
[ "${LLMHP_CANARY_OFF:-0}" = 1 ] && exit 0

# Plugin ids from the config entries: <id>/opencode/<file>.ts and the V2
# directory form <id>/opencode both map to <id>; anything else -> basename.
IDS="$(python3 - "$CFG" <<'PY'
import json, os, sys
cfg = json.load(open(sys.argv[1]))
root = os.path.dirname(os.path.abspath(sys.argv[1]))
ids = []
for p in cfg.get("plugin", []):
    path = os.path.join(root, p) if p.startswith(".") else p
    parts = path.replace("\\", "/").split("/")
    if len(parts) >= 3 and parts[-2] == "opencode":
        ids.append(parts[-3])
    elif len(parts) >= 2 and parts[-1] == "opencode":
        ids.append(parts[-2])
    else:
        ids.append(os.path.splitext(os.path.basename(path))[0])
print("\n".join(ids))
PY
)" || { echo "canary: cannot parse $CFG" >&2; exit 1; }
[ -n "$IDS" ] || exit 0   # nothing registered, nothing to guard

STATE="${LLMHP_CANARY_STATE:-${TMPDIR:-/tmp}/llmhp-canary}"
VER="$("$BIN" --version 2>/dev/null)" || { echo "canary: '$BIN --version' failed" >&2; exit 1; }
# V2 loads plugins only with a private server: plain `run` talks to the background
# service and can die before plugin init. `--standalone` keeps the probe hermetic
# and is a no-op flag on V1 (which does not advertise it), so add it when supported.
EXTRA=()
"$BIN" run --help 2>&1 | grep -q -- '--standalone' && EXTRA=(--standalone)
# PROTO invalidates stamps when the marker format or probe invocation changes
# (v4: `--standalone` when supported, so V2 actually initializes plugins).
CFG_SHA="$(sha256sum "$CFG" | cut -d' ' -f1)"
KEY="$(printf '%s' "proto-4|$VER|$CFG_SHA|$IDS|" | tr '\n' '\001' | sha256sum | cut -d' ' -f1)"
[ -f "$STATE/ok-$KEY" ] && exit 0

MARKS="$(mktemp -d "${TMPDIR:-/tmp}/canary.XXXXXX")"
N="pre-$$-$RANDOM$RANDOM"
( exec env LLMHP_CANARY_DIR="$MARKS" LLMHP_CANARY_NONCE="$N" \
    "$BIN" run ${EXTRA[@]+"${EXTRA[@]}"} "canary del muro" --model canary/no-credito </dev/null >/dev/null 2>&1 ) &
PID=$!
ok() {
  for id in $IDS; do [ -f "$MARKS/$N.$id.testigo" ] || return 1; done
}
PASOS=$(( ${LLMHP_CANARY_WAIT:-60} * 5 ))   # en pasos de 0,2 s
while [ "$PASOS" -gt 0 ]; do
  ok && break
  kill -0 "$PID" 2>/dev/null || { sleep 0.2; break; }
  sleep 0.2; PASOS=$((PASOS - 1))
done
kill "$PID" 2>/dev/null || true; wait "$PID" 2>/dev/null || true

if ok; then
  if [ "${LLMHP_CANARY_ORDER:-1}" = 1 ]; then
    # Init order must follow config order (ties allowed; compared on the
    # sub-ms monotonic token, not epoch ms). Sequential loading is what makes
    # the README's load-order table enforceable at all.
    BAD=""; prev=""; prev_id=""
    for id in $IDS; do
      t="$(awk '{print $2}' "$MARKS/$N.$id.testigo")"
      if [ -n "$prev" ]; then
        awk -v a="$prev" -v b="$t" 'BEGIN { if (b + 0 < a + 0) exit 1 }' || BAD="$BAD $prev_id->$id"
      fi
      prev="$t"; prev_id="$id"
    done
    if [ -n "$BAD" ]; then
      rm -rf "$MARKS" 2>/dev/null || true
      echo "canary: plugin init order violated (config order not followed):$BAD" >&2
      exit 1
    fi
  fi
  rm -rf "$MARKS"
  mkdir -p "$STATE"
  : > "$STATE/ok-$KEY"
  exit 0
fi
MISSING=""
for id in $IDS; do [ -f "$MARKS/$N.$id.testigo" ] || MISSING="$MISSING $id"; done
rm -rf "$MARKS" 2>/dev/null || true
echo "canary: plugins did NOT load (fail closed); missing markers:$MISSING" >&2
exit 1
