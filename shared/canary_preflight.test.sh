#!/usr/bin/env bash
# canary_preflight.test.sh — if opencode stops loading the plugins, the preflight fails CLOSED.
#
# What is pinned here (canary_preflight.sh + shared/load-canary.ts), with a fake `opencode`:
#   1. plugins load -> exit 0, probe markers cleaned up, OK cached per (version + config);
#   2. same version + config -> cached OK, no new probe;
#   3. new binary version -> probe reruns, old stamp kept (one per key);
#   4. probe loads no plugins (what a --bare default or a broken load would do) -> exit 1,
#      missing ids named, no OK cached for that key;
#   5. LLMHP_CANARY_OFF=1 -> exit 0 without probing (explicit escape hatch);
#   6. config with an empty plugin array -> exit 0 without probing;
#   7. ids derive from submodule-nested paths too (<any>/llm-harness-plugins/<id>/opencode/x.ts);
#   8. every */opencode/index.ts in this repo calls writeLoadCanary("<its dir name>") — a new
#      plugin without wiring fails here, not silently in a host project;
#   9. init order violated (a later-config plugin initialized first) -> fail closed, pair named;
#  10. LLMHP_CANARY_ORDER=0 -> order inversion tolerated (explicit opt-out).
set -u
SHARED_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SHARED_DIR/.." && pwd)"
PREFLIGHT="$SHARED_DIR/canary_preflight.sh"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/canary-test.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

fallos=0
check() { # check <exit-code> <label> — 0 means good
  if [ "$1" = 0 ]; then echo "  ok  $2"; else echo "  FAIL $2"; fallos=$((fallos + 1)); fi
}
check_eq() { # check_eq <got> <want> <label>
  if [ "$1" = "$2" ]; then echo "  ok  $3"; else echo "  FAIL $3 (got: $1, want: $2)"; fallos=$((fallos + 1)); fi
}

# fake opencode: --version answers; `run` writes canary markers like real plugins would
# (unless FAKE_PRE=0, simulating hooks/plugins not loading), then dies on the bogus model.
FAKE="$TMP/opencode_falso.sh"
cat > "$FAKE" <<'EOF'
#!/bin/bash
if [ "${1:-}" = "--version" ]; then echo "${FAKE_VERSION:-1.0.0} (opencode)"; exit 0; fi
if [ "${1:-}" = "run" ]; then
  echo run >> "$FAKE_LOG"
  if [ "${FAKE_PRE:-1}" = 1 ] && [ -n "${LLMHP_CANARY_DIR:-}" ]; then
    i=0
    for id in ${FAKE_PLUGINS:-}; do
      i=$((i + 1))
      base="$(date +%s%3N)"
      perf="$base.$(printf '%03d' "$i")"
      # deterministic inversion: first-config plugin gets a much later token
      if [ "${FAKE_INVERT:-0}" = 1 ] && [ "$i" = 1 ]; then perf="$((base + 1000)).000"; fi
      printf '%s %s %s\n' "$base" "$perf" "$$" > "$LLMHP_CANARY_DIR/$LLMHP_CANARY_NONCE.$id.testigo"
    done
  fi
  echo '{"is_error":true,"error":"model not found: canary/no-credito"}'
  exit 1
fi
exit 0
EOF
chmod +x "$FAKE"

CFG="$TMP/opencode.json"
cat > "$CFG" <<'EOF'
{ "plugin": ["./p1/opencode/index.ts", "./nested/lib/p2/opencode/index.ts"] }
EOF

STATE="$TMP/state"
LOG="$TMP/probes.log"
run_preflight() { # run_preflight <label> [KEY=VAL...]
  local label="$1"; shift
  env -u LLMHP_CANARY_OFF -u LLMHP_CANARY_WAIT -u LLMHP_CANARY_ORDER \
    LLMHP_CANARY_STATE="$STATE" LLMHP_CANARY_WAIT=5 FAKE_LOG="$LOG" \
    FAKE_PLUGINS="p1 p2" "$@" bash "$PREFLIGHT" "$FAKE" "$CFG" > "$TMP/out.$label" 2> "$TMP/err.$label"
}

probes() { [ -f "$LOG" ] && wc -l < "$LOG" | tr -d ' ' || echo 0; }
stamps() { ls "$STATE" 2>/dev/null | grep -c '^ok-' || true; }

echo "1. plugins load -> exit 0, markers cleaned, OK cached"
run_preflight c1
check $? "exit 0"
check_eq "$(probes)" 1 "one probe ran"
check_eq "$(stamps)" 1 "OK cached"
leaked=$(ls -d "$TMP"/canary.* 2>/dev/null | wc -l)
check_eq "$leaked" 0 "probe marker dir cleaned up"

echo "2. same version + config -> cached, no new probe"
run_preflight c2
check $? "exit 0"
check_eq "$(probes)" 1 "no second probe"

echo "3. new binary version -> probe reruns, old stamp kept"
run_preflight c3 FAKE_VERSION=1.1.0
check $? "exit 0"
check_eq "$(probes)" 2 "probe reran"
check_eq "$(stamps)" 2 "one stamp per key (2)"

echo "4. plugins do not load -> fail closed, no OK for the broken key"
run_preflight c4 FAKE_VERSION=2.0.0 FAKE_PRE=0
rc4=$?
check_eq "$rc4" 1 "exit 1 (fail closed)"
grep -q 'p1' "$TMP/err.c4"; check $? "p1 named on stderr"
grep -q 'p2' "$TMP/err.c4"; check $? "p2 named on stderr"
check_eq "$(stamps)" 2 "no OK cached for the broken key (still 2)"
check_eq "$(probes)" 3 "probe ran (the preflight itself is what catches the silence)"

echo "5. LLMHP_CANARY_OFF=1 -> exit 0 without probing"
run_preflight c5 FAKE_VERSION=9.9.9 LLMHP_CANARY_OFF=1
check $? "exit 0"
check_eq "$(probes)" 3 "no probe ran"

echo "6. empty plugin array -> exit 0 without probing"
echo '{ "plugin": [] }' > "$CFG"
run_preflight c6 FAKE_VERSION=9.9.8
check $? "exit 0"
check_eq "$(probes)" 3 "no probe ran"

echo "7. id derivation: submodule-nested path -> datetime-inject"
cat > "$CFG" <<'EOF'
{ "plugin": ["./sub/llm-harness-plugins/datetime-inject/opencode/index.ts"] }
EOF
run_preflight c7 FAKE_PLUGINS="datetime-inject"
check $? "nested path resolves to the plugin id"

echo "8. every plugin in this repo wires the canary under its own dir name"
total=0; wired=0; unwired=""
for f in "$ROOT"/*/opencode/index.ts; do
  total=$((total + 1))
  id="$(basename "$(dirname "$(dirname "$f")")")"
  if grep -q "writeLoadCanary(\"$id\")" "$f"; then wired=$((wired + 1)); else unwired="$unwired $id"; fi
done
check_eq "$wired" "$total" "$wired/$total wired"
check_eq "${unwired:-none}" "none" "no unwired plugin"
grep -q 'export function writeLoadCanary' "$ROOT/shared/load-canary.ts"; check $? "primitive exists in shared/"

echo "9. init order violated -> fail closed, inversion pair named"
cat > "$CFG" <<'EOF'
{ "plugin": ["./p1/opencode/index.ts", "./p2/opencode/index.ts"] }
EOF
rm -f "$LOG"
run_preflight c9 FAKE_VERSION=3.0.0 FAKE_INVERT=1
rc9=$?
check_eq "$rc9" 1 "exit 1 (fail closed)"
grep -q 'p1->p2' "$TMP/err.c9"; check $? "inversion pair named on stderr"
check_eq "$(probes)" 1 "probe ran"
check_eq "$(stamps)" 3 "no OK cached for the order-violating key (still 3; scenario 7 added one)"

echo "10. LLMHP_CANARY_ORDER=0 -> inversion tolerated"
run_preflight c10 FAKE_VERSION=3.1.0 FAKE_INVERT=1 LLMHP_CANARY_ORDER=0
check $? "exit 0"
check_eq "$(probes)" 2 "probe ran"
check_eq "$(stamps)" 4 "OK cached for the opt-out key"

echo
if [ "$fallos" -gt 0 ]; then echo "FAIL $fallos canary preflight check(s)"; exit 1; fi
echo "canary preflight: all green"
