#!/bin/bash
set -euo pipefail

HOOK_DIR="$(dirname "$0")"
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(dirname "$HOOK_DIR")}"
CLASSES_DIR="$PLUGIN_ROOT/build/classes"
MAIN_CLASS="eu.infolead.llmhp.cache.SemanticCacheCli"

if [ ! -f "$CLASSES_DIR/eu/infolead/llmhp/cache/SemanticCacheCli.class" ]; then
    exit 0
fi

java --class-path "$CLASSES_DIR" "$MAIN_CLASS" invalidate-stale 2>/dev/null || true

exit 0
