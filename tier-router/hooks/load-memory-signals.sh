#!/bin/bash
# Memory signals loader — SessionStart hook
# Reads agentmem's MEMORY.md and user memory files, extracts domain expertise
# signals (LEARNING/EXPERT/PREFERENCE), writes to tier-router's metrics dir.
# user-prompt-submit.sh reads the signals on each routing decision.
set -euo pipefail

HOOK_DIR="$(dirname "$0")"
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(dirname "$HOOK_DIR")}"
CLASSES_DIR="$PLUGIN_ROOT/build/classes"
MAIN_CLASS="eu.infolead.llmhp.router.RouterCli"

if [ ! -f "$CLASSES_DIR/eu/infolead/llmhp/router/RouterCli.class" ]; then
    echo "[memory-signals] Router not compiled. Pass through." >&2
    exit 0
fi
if ! command -v java >/dev/null 2>&1; then
    echo "[memory-signals] java not found. Pass through." >&2
    exit 0
fi

PROJECT_ROOT=$(cd "$CLAUDE_PROJECT_DIR" 2>/dev/null && pwd || echo "unknown")
AGENTMEM_DIR="$PROJECT_ROOT/.agentmem"
METRICS_DIR="$PROJECT_ROOT/.tier-router/metrics"

if [ ! -d "$AGENTMEM_DIR" ]; then
    echo "[memory-signals] No .agentmem/ directory — skipping" >&2
    exit 0
fi

RESULT=$(java --class-path "$CLASSES_DIR" "$MAIN_CLASS" memory-load "$AGENTMEM_DIR" "$METRICS_DIR" 2>/dev/null || echo '{"status":"error"}')

STATUS=$(echo "$RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('status','error'))" 2>/dev/null || echo "error")
COUNT=$(echo "$RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('count',0))" 2>/dev/null || echo "0")

if [ "$STATUS" = "loaded" ]; then
    echo "[memory-signals] Loaded $COUNT memory signal(s) from .agentmem/" >&2
else
    echo "[memory-signals] No memory signals extracted" >&2
fi

exit 0
