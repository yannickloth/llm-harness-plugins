#!/usr/bin/env bash
# Eval runner for premium-read-offload.
#
# Mirrors shunt's eval structure: hook routing decisions (gate allow/block) plus
# end-to-end skill scenarios. No network / no model spend — the gate is
# deterministic and lives in Java.
#
#   bash evals/run.sh          # gate decision evals
#   bash evals/run.sh --e2e    # also print e2e scenario checklist
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PLUGIN_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MAIN="eu.infolead.llmhp.offload.OffloadCli"
CLASSES="$PLUGIN_DIR/build/classes"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

PASSED=0; FAILED=0; TOTAL=0

jrun() { java --class-path "$CLASSES" "$MAIN" "$@"; }

# check <name> <expected-decision> <actual-json>
check() {
  TOTAL=$((TOTAL + 1))
  local name="$1" expected="$2" actual
  actual=$(printf '%s' "$3" | jq -r '.decision' 2>/dev/null || echo "PARSE_ERROR")
  if [ "$actual" = "$expected" ]; then
    PASSED=$((PASSED + 1)); printf "  \033[32mPASS\033[0m  %-40s %s\n" "$name" "$expected"
  else
    FAILED=$((FAILED + 1)); printf "  \033[31mFAIL\033[0m  %-40s expected=%s got=%s\n" "$name" "$expected" "$actual"
  fi
}

# fixtures
BIG="$TMP/big.ts";   seq 1 3000 > "$BIG"
MED="$TMP/med.ts";   seq 1 500  > "$MED"
ZAI_MED="$TMP/z.ts"; seq 1 450  > "$ZAI_MED"
SMALL="$TMP/s.ts";   seq 1 100  > "$SMALL"

jrun record-model "$TMP" kimi-sess kimi k3 >/dev/null
jrun record-model "$TMP" zai-sess zai-coding-plan glm-5.3-flash >/dev/null
jrun record-model "$TMP" ds-sess deepseek deepseek-flash >/dev/null
jrun record-model "$TMP" zai53 zai-coding-plan glm-5.3 >/dev/null
jrun record-model "$TMP" kfc-sess kimi-for-coding k3-256k >/dev/null

echo ""
echo "Read gate (decide-read)"
echo "────────────────────────────────────────────────────────────────"
check "kimi + big + unbounded"      block "$(jrun decide-read "$TMP" kimi-sess "$BIG" - -)"
check "kimi-for-coding + big"       block "$(jrun decide-read "$TMP" kfc-sess "$BIG" - -)"
check "kimi + small"                allow "$(jrun decide-read "$TMP" kimi-sess "$SMALL" - -)"
check "kimi + med(500<1000)"        allow "$(jrun decide-read "$TMP" kimi-sess "$MED" - -)"
check "zai + med(500>400)"          block "$(jrun decide-read "$TMP" zai-sess "$MED" - -)"
check "zai + 450>400"               block "$(jrun decide-read "$TMP" zai53 "$ZAI_MED" - -)"
check "zai + small"                 allow "$(jrun decide-read "$TMP" zai-sess "$SMALL" - -)"
check "deepseek + big"              allow "$(jrun decide-read "$TMP" ds-sess "$BIG" - -)"
check "unknown session (fail open)" allow "$(jrun decide-read "$TMP" nobody "$BIG" - -)"
check "targeted offset/limit"       allow "$(jrun decide-read "$TMP" kimi-sess "$BIG" 10 50)"
check "huge limit (unbounded)"      block "$(jrun decide-read "$TMP" kimi-sess "$BIG" 1 999999)"
check "full-span offset+limit"      block "$(jrun decide-read "$TMP" kimi-sess "$BIG" 1 3000)"
check "nonexistent file"            allow "$(jrun decide-read "$TMP" kimi-sess "$TMP/nope.ts" - -)"

# direct-read permit
jrun grant-direct "$TMP" kimi-sess "$BIG" >/dev/null
check "permitted direct read"       allow "$(jrun decide-read "$TMP" kimi-sess "$BIG" - -)"
check "permit is one-shot"          block "$(jrun decide-read "$TMP" kimi-sess "$BIG" - -)"

echo ""
echo "Bash gate (decide-bash)"
echo "────────────────────────────────────────────────────────────────"
check "cat big on kimi"             block "$(jrun decide-bash "$TMP" kimi-sess "cat $BIG")"
check "cat small on kimi"           allow "$(jrun decide-bash "$TMP" kimi-sess "cat $SMALL")"
check "cat big piped (targeted)"    allow "$(jrun decide-bash "$TMP" kimi-sess "cat $BIG | grep x")"
check "cat big redirected"          allow "$(jrun decide-bash "$TMP" kimi-sess "cat $BIG > out")"
check "cat big on deepseek"         allow "$(jrun decide-bash "$TMP" ds-sess "cat $BIG")"
check "head -100 big"               allow "$(jrun decide-bash "$TMP" kimi-sess "head -100 $BIG")"
check "git status (non-read)"       allow "$(jrun decide-bash "$TMP" kimi-sess "git status")"
check "cat zai med>400"             block "$(jrun decide-bash "$TMP" zai-sess "cat $MED")"

echo ""
echo "Model gating"
echo "────────────────────────────────────────────────────────────────"
TOTAL=$((TOTAL + 1))
if [ "$(jrun is-premium "$TMP" kimi-sess | jq -r '.premium')" = "true" ] && \
   [ "$(jrun is-premium "$TMP" ds-sess   | jq -r '.premium')" = "false" ]; then
  PASSED=$((PASSED + 1)); printf "  \033[32mPASS\033[0m  %-40s\n" "premium classification"
else
  FAILED=$((FAILED + 1)); printf "  \033[31mFAIL\033[0m  %-40s\n" "premium classification"
fi

echo ""
echo "Worker session store"
echo "────────────────────────────────────────────────────────────────"
KEY=$(jrun corpus-key "$TMP" "$BIG" | jq -r '.corpusKey')
check2() {
  TOTAL=$((TOTAL + 1))
  if [ "$2" = "$3" ]; then PASSED=$((PASSED + 1)); printf "  \033[32mPASS\033[0m  %-40s\n" "$1"
  else FAILED=$((FAILED + 1)); printf "  \033[31mFAIL\033[0m  %-40s expected=%s got=%s\n" "$1" "$3" "$2"; fi
}
check2 "worker-get empty" "$(jrun worker-get "$TMP" "$BIG" | jq -r '.sessionID')" "null"
jrun worker-set "$TMP" "ses_worker_test" "$BIG" >/dev/null
check2 "worker-get roundtrip" "$(jrun worker-get "$TMP" "$BIG" | jq -r '.sessionID')" "ses_worker_test"
check2 "worker-list contains" "$(jrun worker-list "$TMP" | jq -r '.sessionIDs | index("ses_worker_test") != null')" "true"
KEY2=$(jrun corpus-key "$TMP" "$SMALL" | jq -r '.corpusKey')
check2 "corpus key differs by content" "$([ "$KEY" != "$KEY2" ] && echo differ)" "differ"

# Stale-summary invalidation: change the corpus, same path → miss.
printf 'changed\n' >> "$BIG"
check2 "changed corpus is a miss" "$(jrun worker-get "$TMP" "$BIG" | jq -r '.sessionID')" "null"

echo ""
echo "Worth-it guard (worth-offload)"
echo "────────────────────────────────────────────────────────────────"
check2 "trivial Q not worth it"   "$(jrun worth-offload "$TMP" false 5000 'how many lines are in this file?' | jq -r '.worth')" "false"
check2 "real Q big corpus"        "$(jrun worth-offload "$TMP" false 5000 'explain the call graph' | jq -r '.worth')" "true"
check2 "real Q tiny corpus"       "$(jrun worth-offload "$TMP" false 50 'explain the call graph' | jq -r '.worth')" "false"
check2 "cache hit always worth it" "$(jrun worth-offload "$TMP" true 50 'how many lines?' | jq -r '.worth')" "true"

echo ""
echo "Cost telemetry (record-metric)"
echo "────────────────────────────────────────────────────────────────"
METRICS="$TMP/.premium-read-offload/metrics.jsonl"
jrun record-metric "$TMP" '{"op":"offload-read","cacheHit":false,"corpusLines":3000}' >/dev/null
jrun record-metric "$TMP" '{"op":"offload-read","cacheHit":true,"corpusLines":3000}' >/dev/null
check2 "two metric lines"         "$(wc -l < "$METRICS" | tr -d ' ')" "2"
check2 "metric json parses"       "$(jq -r '.op' < "$METRICS" | head -1)" "offload-read"

echo ""
echo "Citation verification (verify-answer)"
echo "────────────────────────────────────────────────────────────────"
CITED="$TMP/cited.txt"; printf 'alpha\nbeta\ngamma\ndelta\n' > "$CITED"

RES=$(printf 'ok [cite: %s:1-2 "alpha beta"]' "$CITED" | jrun verify-answer "$TMP" "$CITED")
check2 "matching quote verified"   "$(printf '%s' "$RES" | jq -r '.citations.verified')" "1"
check2 "verified not tagged"       "$(printf '%s' "$RES" | jq -r '.answer | contains("[unverified]")')" "false"

RES=$(printf 'bad [cite: %s:3 "WRONG"]' "$CITED" | jrun verify-answer "$TMP" "$CITED")
check2 "wrong quote unverified"    "$(printf '%s' "$RES" | jq -r '.citations.items[0].status')" "quote_mismatch"
check2 "unverified claim tagged"   "$(printf '%s' "$RES" | jq -r '.answer | contains("[unverified]")')" "true"

RES=$(printf '[cite: %s:9-10 "x"]' "$CITED" | jrun verify-answer "$TMP" "$CITED")
check2 "out-of-range unverified"   "$(printf '%s' "$RES" | jq -r '.citations.items[0].status')" "missing_lines"

RES=$(printf 'prose with no citations' | jrun verify-answer "$TMP" "$CITED")
check2 "no citations flagged"      "$(printf '%s' "$RES" | jq -r '.citations.hasCitations')" "false"
check2 "no-citation answer tagged" "$(printf '%s' "$RES" | jq -r '.answer | contains("[unverified: no citations found]")')" "true"

echo ""
echo "════════════════════════════════════════════════════════════════"
printf "Total: \033[32m%d passed\033[0m, \033[31m%d failed\033[0m, %d total\n" "$PASSED" "$FAILED" "$TOTAL"

if [ "${1:-}" = "--e2e" ]; then
  echo ""
  echo "End-to-end scenarios (manual — require a running opencode session)"
  echo "────────────────────────────────────────────────────────────────"
  echo "  1. Premium session asks about a 3000-line file"
  echo "       → read is blocked; agent calls offload-read; gets a summary."
  echo "  2. Follow-up question about the same file"
  echo "       → offload-read resumes the worker session (cache hit, cheap)."
  echo "  3. Debugging task referencing an exact line"
  echo "       → agent uses offset/limit (allowed), no delegation."
  echo "  4. Edit task"
  echo "       → agent calls allow-direct-read (or offset/limit), then reads."
  echo "  5. Boilerplate generation"
  echo "       → agent calls code-write with --reference/--target."
fi

echo ""
[ "$FAILED" -gt 0 ] && exit 1
exit 0
