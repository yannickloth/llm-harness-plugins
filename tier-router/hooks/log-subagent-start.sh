#!/bin/bash
# Log subagent start for tier tracking
set -euo pipefail

HOOK_DIR="$(dirname "$0")"
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(dirname "$HOOK_DIR")}"

SUBAGENT=$(cat | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('subagent_name','unknown'))" 2>/dev/null || echo "unknown")
TIMESTAMP=$(date -Iseconds)

echo "[tier-router] Subagent started: $SUBAGENT" >&2

PROJECT_ROOT=$(cd "$CLAUDE_PROJECT_DIR" 2>/dev/null && pwd || echo "unknown")
METRICS_DIR="$PROJECT_ROOT/.tier-router/metrics"
mkdir -p "$METRICS_DIR"
TODAY=$(date +%Y-%m-%d)

(
    flock -x -w 2 200 2>/dev/null && {
        echo "{\"type\":\"subagent_start\",\"timestamp\":\"$TIMESTAMP\",\"subagent\":\"$SUBAGENT\"}" >> "$METRICS_DIR/$TODAY.jsonl"
    } || true
) 200>"$METRICS_DIR/$TODAY.jsonl.lock"

exit 0
