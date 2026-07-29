#!/bin/bash
set -euo pipefail

HOOK_DIR="$(dirname "$0")"
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(dirname "$HOOK_DIR")}"
CLASSES_DIR="$PLUGIN_ROOT/build/classes"
MAIN_CLASS="eu.infolead.llmhp.cache.SemanticCacheCli"

[ -f "$CLASSES_DIR/eu/infolead/llmhp/cache/SemanticCacheCli.class" ] || exit 0

TOOL_NAME="${CLAUDE_TOOL_NAME:-}"

case "$TOOL_NAME" in
    Write|Edit)
        PROMPT="${CLAUDE_PROMPT_CONTEXT:-}"
        [ -n "$PROMPT" ] || exit 0
        java --class-path "$CLASSES_DIR" "$MAIN_CLASS" store "$PROMPT" 2>/dev/null || true
        ;;
esac

exit 0
