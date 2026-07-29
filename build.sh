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
    local BIN_DIR="$SCRIPT_DIR/$NAME/bin"

    mkdir -p "$CLASSES_DIR" "$TEST_CLASSES_DIR" "$BIN_DIR"

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

compile_plugin "guardrail-chain"
compile_plugin "agentmem" "$GUARDRAIL_CP"
compile_plugin "agentinsights"
compile_plugin "knowledge-graph"
compile_plugin "tier-router"
compile_plugin "semantic-cache"

cat > "$SCRIPT_DIR/agentmem/bin/memorysystem" << 'RUNNER'
#!/usr/bin/env bash
if [ -n "${CLAUDE_PLUGIN_ROOT:-}" ]; then
    ROOT="${CLAUDE_PLUGIN_ROOT}"
else
    ROOT="$(cd "$(dirname "$0")/.." && pwd)"
fi
GUARDRAIL_DIR="$(cd "$(dirname "$0")/../../guardrail-chain" && pwd)"
exec java --class-path "${ROOT}/build/classes:${GUARDRAIL_DIR}/build/classes" eu.infolead.llmhp.memory.MemorySystemCli "$@"
RUNNER
chmod +x "$SCRIPT_DIR/agentmem/bin/memorysystem"

cat > "$SCRIPT_DIR/guardrail-chain/bin/gcl" << 'RUNNER'
#!/usr/bin/env bash
if [ -n "${CLAUDE_PLUGIN_ROOT:-}" ]; then
    ROOT="${CLAUDE_PLUGIN_ROOT}"
else
    ROOT="$(cd "$(dirname "$0")/.." && pwd)"
fi
exec java --class-path "${ROOT}/build/classes" eu.infolead.llmhp.guardrails.GuardrailPipelineCli "$@"
RUNNER
chmod +x "$SCRIPT_DIR/guardrail-chain/bin/gcl"

cat > "$SCRIPT_DIR/semantic-cache/bin/cachecli" << 'RUNNER'
#!/usr/bin/env bash
if [ -n "${CLAUDE_PLUGIN_ROOT:-}" ]; then
    ROOT="${CLAUDE_PLUGIN_ROOT}"
else
    ROOT="$(cd "$(dirname "$0")/.." && pwd)"
fi
exec java --class-path "${ROOT}/build/classes" eu.infolead.llmhp.cache.SemanticCacheCli "$@"
RUNNER
chmod +x "$SCRIPT_DIR/semantic-cache/bin/cachecli"

echo "Runner: $SCRIPT_DIR/agentmem/bin/memorysystem"
echo "Runner: $SCRIPT_DIR/agentinsights/bin/insights"
echo "Runner: $SCRIPT_DIR/semantic-cache/bin/cachecli"
echo "Runner: $SCRIPT_DIR/guardrail-chain/bin/gcl"

run_tests "agentinsights"
run_tests "semantic-cache"
run_tests "guardrail-chain"
