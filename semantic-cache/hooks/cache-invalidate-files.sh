#!/bin/bash
set -euo pipefail

HOOK_DIR="$(dirname "$0")"
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(dirname "$HOOK_DIR")}"
CLASSES_DIR="$PLUGIN_ROOT/build/classes"
MAIN_CLASS="eu.infolead.llmhp.cache.SemanticCacheCli"

[ -f "$CLASSES_DIR/eu/infolead/llmhp/cache/SemanticCacheCli.class" ] || exit 0

TOOL_INPUT=$(cat)
FILE_PATH=$(echo "$TOOL_INPUT" | python3 -c "import sys,json; ti=json.load(sys.stdin).get('tool_input',{}); print(ti.get('file_path','') or ti.get('filePath','') or ti.get('path',''))" 2>/dev/null || echo "")

[ -n "$FILE_PATH" ] || exit 0

java --class-path "$CLASSES_DIR" "$MAIN_CLASS" invalidate-files "$FILE_PATH" 2>/dev/null || true

exit 0
