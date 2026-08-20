#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

compile_plugin() {
    local NAME="$1"
    local EXTRA_CP="${2:-}"
    local SRC_DIR="$SCRIPT_DIR/$NAME/src/main/java"
    local TEST_DIR="$SCRIPT_DIR/$NAME/src/test/java"
    local CLASSES_DIR="$SCRIPT_DIR/$NAME/build/classes"
    local TEST_CLASSES_DIR="$SCRIPT_DIR/$NAME/build/test-classes"
    mkdir -p "$CLASSES_DIR" "$TEST_CLASSES_DIR"

    if [ -n "$EXTRA_CP" ]; then
        find "$SRC_DIR" -name '*.java' -print0 | xargs -0 javac -d "$CLASSES_DIR" --release 25 --class-path "$EXTRA_CP"
    else
        find "$SRC_DIR" -name '*.java' -print0 | xargs -0 javac -d "$CLASSES_DIR" --release 25
    fi

    if [ -d "$TEST_DIR" ] && [ "$(find "$TEST_DIR" -name '*.java' -print0 | tr -dc '\0' | wc -c)" -gt 0 ]; then
        local test_cp="$CLASSES_DIR"
        if [ -n "$EXTRA_CP" ]; then
            test_cp="${CLASSES_DIR}:${EXTRA_CP}"
        fi
        find "$TEST_DIR" -name '*.java' -print0 | xargs -0 javac -d "$TEST_CLASSES_DIR" --release 25 \
            --class-path "$test_cp"
        echo "Compiled tests for $NAME to $TEST_CLASSES_DIR"
    fi

    echo "Compiled $NAME to $CLASSES_DIR"
}

run_tests() {
    local NAME="$1"
    local EXTRA_CP="${2:-}"
    local CLASSES_DIR="$SCRIPT_DIR/$NAME/build/classes"
    local TEST_CLASSES_DIR="$SCRIPT_DIR/$NAME/build/test-classes"

    if [ ! -d "$TEST_CLASSES_DIR" ]; then return 0; fi

    echo "--- Running $NAME tests ---"
    local ALL_PASSED=true
    local found=0
    while IFS= read -r -d '' testfile; do
        found=$((found + 1))
        local relpath="${testfile#"$TEST_CLASSES_DIR/"}"
        relpath="${relpath%.class}"
        local fqn="${relpath//\//.}"
        echo "  $fqn"
        local run_cp="${CLASSES_DIR}:${TEST_CLASSES_DIR}"
        if [ -n "$EXTRA_CP" ]; then
            run_cp="${run_cp}:${EXTRA_CP}"
        fi
        java --class-path "$run_cp" "$fqn" || ALL_PASSED=false
    done < <(find "$TEST_CLASSES_DIR" -name '*Test.class' -print0 2>/dev/null || true)
    if [ "$found" -eq 0 ]; then
        echo "  No test classes found."
        return 0
    fi
    if [ "$ALL_PASSED" = true ]; then
        echo "$NAME tests: PASSED"
    else
        echo "$NAME tests: FAILED"
        return 1
    fi
}

GUARDRAIL_CP="$SCRIPT_DIR/guardrail-chain/build/classes"
SHARED_CP="$SCRIPT_DIR/shared/build/classes"
KNOWLEDGE_GRAPH_CP="$SCRIPT_DIR/knowledge-graph/build/classes"

compile_plugin "shared"
compile_plugin "guardrail-chain"
compile_plugin "agentmem" "$GUARDRAIL_CP"
compile_plugin "agentinsights"
compile_plugin "knowledge-graph"
compile_plugin "graphrag" "$KNOWLEDGE_GRAPH_CP"
compile_plugin "tier-router" "$SHARED_CP"
compile_plugin "semantic-cache"
compile_plugin "prompt-registry"
compile_plugin "permission-modes"
compile_plugin "agentfeed"

compile_plugin "session-lifecycle" "$SHARED_CP"
compile_plugin "graphics-toolkit"

run_tests "agentmem" "$GUARDRAIL_CP"
echo "--- Running agentmem TS tests ---"
bun test "$SCRIPT_DIR/agentmem/opencode/helpers.test.ts" || echo "agentmem TS tests: FAILED (bun not available?)"
echo ""
run_tests "agentinsights"
run_tests "graphrag" "$KNOWLEDGE_GRAPH_CP"
echo "--- Running graphrag TS tests ---"
bun test "$SCRIPT_DIR/graphrag/opencode/index.test.ts" || echo "graphrag TS tests: FAILED (bun not available?)"
run_tests "semantic-cache"
run_tests "guardrail-chain"
run_tests "prompt-registry"
run_tests "shared"
run_tests "tier-router" "$SHARED_CP"
run_tests "permission-modes"
echo "--- Running permission-modes TS tests ---"
bun test "$SCRIPT_DIR/permission-modes/opencode/index.test.ts" || echo "permission-modes TS tests: FAILED (bun not available?)"

echo "--- Running general-skills TS tests ---"
bun test "$SCRIPT_DIR/general-skills/opencode/index.test.ts" || echo "general-skills TS tests: FAILED (bun not available?)"

echo "--- Running datetime-inject TS tests ---"
bun test "$SCRIPT_DIR/datetime-inject/opencode/index.test.ts" || echo "datetime-inject TS tests: FAILED (bun not available?)"

echo "--- Running offpeak-nudge TS tests ---"
bun test "$SCRIPT_DIR/offpeak-nudge/opencode/index.test.ts" || echo "offpeak-nudge TS tests: FAILED (bun not available?)"

echo "--- Running system-message-merge TS tests ---"
bun test "$SCRIPT_DIR/system-message-merge/opencode/index.test.ts" || echo "system-message-merge TS tests: FAILED (bun not available?)"

echo "--- Running agentfeed Java tests ---"
run_tests "agentfeed"

echo "--- Running agentfeed TS tests ---"
bun test "$SCRIPT_DIR/agentfeed/opencode/ledger.test.ts" \
          "$SCRIPT_DIR/agentfeed/opencode/digest.test.ts" \
          "$SCRIPT_DIR/agentfeed/opencode/activity.test.ts" \
          "$SCRIPT_DIR/agentfeed/opencode/index.test.ts" || echo "agentfeed TS tests: FAILED (bun not available?)"

echo "--- Running graphics-toolkit Java self-checks on vendored examples ---"
GFX_CP="$SCRIPT_DIR/graphics-toolkit/build/classes"
java --class-path "$GFX_CP" eu.infolead.llmhp.graphics.GraphicsSvgCheck \
  "$SCRIPT_DIR/graphics-toolkit/skills/diagram-design/assets/example-architecture.html" \
  >/dev/null 2>&1 \
  && echo "graphics svg-selfcheck: PASSED" \
  || echo "graphics svg-selfcheck: FAILED"

echo "--- Running scientific-writing agent registration check ---"
SW_AGENTS="$SCRIPT_DIR/scientific-writing/agents"
if [ -d "$SW_AGENTS" ]; then
  SW_PASS=1
  for f in "$SW_AGENTS"/*.md; do
    fname=$(basename "$f" .md)
    fmeta=$(grep -m1 "^name:" "$f" | awk '{print $2}')
    if [ "$fname" != "$fmeta" ]; then
      echo "  scientific-writing agent name mismatch: $fname vs $fmeta"
      SW_PASS=0
    fi
  done
  # Verify every agent file in the plugin is registered in opencode.json.
  python3 - "$SCRIPT_DIR/opencode.json" "$SW_AGENTS" <<'PY' || SW_PASS=0
import json, os, sys
cfg=json.load(open(sys.argv[1]))
agents=cfg.get("agent",{})
agents_dir=sys.argv[2]
root=os.path.dirname(sys.argv[1])
missing=[]
for fn in sorted(os.listdir(agents_dir)):
    if not fn.endswith(".md"):
        continue
    name=fn[:-3]
    spec=agents.get(name)
    if not spec or "file" not in spec:
        missing.append(name)
        continue
    if not os.path.isfile(os.path.join(root, spec["file"])):
        missing.append(name)
if missing:
    print("  unregistered or missing agent files:", missing); sys.exit(1)
PY
  if [ "$SW_PASS" -eq 1 ]; then echo "scientific-writing agent registration: PASSED"; else echo "scientific-writing agent registration: FAILED"; fi
else
  echo "scientific-writing agent registration: FAILED (agents dir missing)"
fi

echo "--- Running agentfeed CLI feed validity check ---"
CLI_DIR="${XDG_RUNTIME_DIR:-/tmp/opencode}/agentfeed-cli"
rm -rf "$CLI_DIR"
mkdir -p "$CLI_DIR/feeds"
printf '{"id":"host:1","host":"host","seq":1,"ts":"2026-08-13T22:22:05.000Z","agent":"auditor","type":"msg","text":"smoke \\"test\\" <ok> \001"}\n' > "$CLI_DIR/ledger.jsonl"
java --class-path "$SCRIPT_DIR/agentfeed/build/classes" eu.infolead.llmhp.agentfeed.AtomCli \
  --ledger "$CLI_DIR/ledger.jsonl" --out "$CLI_DIR/feeds" >/dev/null 2>&1 \
  && [ -s "$CLI_DIR/feeds/feed.xml" ] \
  && xmllint --noout "$CLI_DIR/feeds/feed.xml" 2>/dev/null \
  && echo "agentfeed CLI feed validity: PASSED" \
  || echo "agentfeed CLI feed validity: FAILED"
rm -rf "$CLI_DIR"
