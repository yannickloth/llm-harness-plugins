#!/bin/bash
# PostToolUse hook — accumulates token usage per session
# Reads usage info from the tool response JSON (stdin), parses total_tokens,
# and accumulates into session budget tracker.
set -euo pipefail

HOOK_DIR="$(dirname "$0")"
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(dirname "$HOOK_DIR")}"
CLASSES_DIR="$PLUGIN_ROOT/build/classes"
MAIN_CLASS="eu.infolead.llmhp.router.RouterCli"

if [ ! -f "$CLASSES_DIR/eu/infolead/llmhp/router/RouterCli.class" ]; then
    exit 0
fi
if ! command -v java >/dev/null 2>&1; then
    exit 0
fi

PROJECT_ROOT=$(cd "$CLAUDE_PROJECT_DIR" 2>/dev/null && pwd || echo "unknown")
METRICS_DIR="$PROJECT_ROOT/.tier-router/metrics"
SESSION_ID="${CLAUDE_SESSION_ID:-unknown}"

# Parse token usage from stdin JSON — Claude Code provides usage in response
RAW=$(cat)
TOKENS=$(echo "$RAW" | python3 -c "
import sys,json
try:
    d = json.load(sys.stdin)
    # Try common token usage field paths
    usage = d.get('usage', {})
    if isinstance(usage, dict):
        total = usage.get('total_tokens', usage.get('totalTokens', 0))
        if total:
            print(total)
        else:
            print(0, file=sys.stderr)
            print(0)
    else:
        resp = d.get('response', d.get('output', {}))
        if isinstance(resp, dict):
            usage = resp.get('usage', {})
            if isinstance(usage, dict):
                total = usage.get('total_tokens', usage.get('totalTokens', 0))
                if total:
                    print(total)
                else:
                    print(0, file=sys.stderr)
                    print(0)
            else:
                print(0, file=sys.stderr)
                print(0)
        else:
            print(0, file=sys.stderr)
            print(0)
except (ValueError, KeyError, TypeError):
    print(0, file=sys.stderr)
    print(0)
" 2>/dev/null || echo "0")

if [ "$TOKENS" = "0" ]; then
    exit 0
fi

RESULT=$(java --class-path "$CLASSES_DIR" "$MAIN_CLASS" budget-accumulate "$SESSION_ID" "$TOKENS" "$METRICS_DIR" 2>/dev/null || echo '{"status":"error"}')

STATUS=$(echo "$RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('status','error'))" 2>/dev/null || echo "error")
TOTAL=$(echo "$RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('tokensUsed',0))" 2>/dev/null || echo "0")
CEILING=$(echo "$RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('ceiling',0))" 2>/dev/null || echo "0")
NEWLY_EXHAUSTED=$(echo "$RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('newlyExhausted','false'))" 2>/dev/null || echo "false")

echo "[budget] Accumulated +$TOKENS → $TOTAL / $CEILING tokens" >&2

if [ "$NEWLY_EXHAUSTED" = "true" ]; then
    mkdir -p "$METRICS_DIR"
    echo "exhausted" > "$METRICS_DIR/.budget-exhausted"
    echo "[budget] BUDGET CEILING REACHED at $TOTAL / $CEILING" >&2
fi

exit 0
