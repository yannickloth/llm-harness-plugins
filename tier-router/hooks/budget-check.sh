#!/bin/bash
# Budget check hook — runs before user-prompt-submit.sh
# Checks cumulative token spend against ceiling. On breach, writes a signal
# file that user-prompt-submit.sh reads to inject a budget-exhausted directive.
set -euo pipefail

HOOK_DIR="$(dirname "$0")"
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(dirname "$HOOK_DIR")}"
CLASSES_DIR="$PLUGIN_ROOT/build/classes"
MAIN_CLASS="eu.infolead.llmhp.router.RouterCli"

# Verify router engine exists
if [ ! -f "$CLASSES_DIR/eu/infolead/llmhp/router/RouterCli.class" ]; then
    echo "[budget] Router not compiled. Pass through." >&2
    exit 0
fi
if ! command -v java >/dev/null 2>&1; then
    echo "[budget] java not found. Pass through." >&2
    exit 0
fi

PROJECT_ROOT=$(cd "$CLAUDE_PROJECT_DIR" 2>/dev/null && pwd || echo "unknown")
METRICS_DIR="$PROJECT_ROOT/.tier-router/metrics"
SESSION_ID="${CLAUDE_SESSION_ID:-unknown}"

RESULT=$(java --class-path "$CLASSES_DIR" "$MAIN_CLASS" budget-check "$SESSION_ID" "$METRICS_DIR" 2>/dev/null || echo '{"status":"error"}')

STATUS=$(echo "$RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('status','error'))" 2>/dev/null || echo "error")
TOKENS_USED=$(echo "$RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('tokensUsed',0))" 2>/dev/null || echo "0")
CEILING=$(echo "$RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('ceiling',0))" 2>/dev/null || echo "0")

echo "[budget] Session $SESSION_ID: $TOKENS_USED / $CEILING tokens" >&2

if [ "$STATUS" = "exhausted" ]; then
    # Write signal file for user-prompt-submit.sh to pick up
    mkdir -p "$METRICS_DIR"
    echo "exhausted" > "$METRICS_DIR/.budget-exhausted"
    echo "[budget] BUDGET EXHAUSTED at $TOKENS_USED / $CEILING" >&2
else
    rm -f "$METRICS_DIR/.budget-exhausted"
    echo "[budget] Budget OK" >&2
fi

exit 0
