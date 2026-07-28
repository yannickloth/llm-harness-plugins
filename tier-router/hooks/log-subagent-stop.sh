#!/bin/bash
# Log subagent stop for tier usage tracking
set -euo pipefail

HOOK_DIR="$(dirname "$0")"
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(dirname "$HOOK_DIR")}"

SUBAGENT=$(cat | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('subagent_name','unknown'))" 2>/dev/null || echo "unknown")
DURATION=$(cat | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('duration_seconds',0))" 2>/dev/null || echo "0")
TIMESTAMP=$(date -Iseconds)

echo "[tier-router] Subagent stopped: $SUBAGENT (${DURATION}s)" >&2

PROJECT_ROOT=$(cd "$CLAUDE_PROJECT_DIR" 2>/dev/null && pwd || echo "unknown")
METRICS_DIR="$PROJECT_ROOT/.tier-router/metrics"
mkdir -p "$METRICS_DIR"
TODAY=$(date +%Y-%m-%d)

(
    flock -x -w 2 200 2>/dev/null && {
        echo "{\"type\":\"subagent_stop\",\"timestamp\":\"$TIMESTAMP\",\"subagent\":\"$SUBAGENT\",\"duration_s\":$DURATION}" >> "$METRICS_DIR/$TODAY.jsonl"
    } || true
) 200>"$METRICS_DIR/$TODAY.jsonl.lock"

exit 0
