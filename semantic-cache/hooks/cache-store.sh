#!/bin/bash
set -euo pipefail

HOOK_DIR="$(dirname "$0")"
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(dirname "$HOOK_DIR")}"
CLASSES_DIR="$PLUGIN_ROOT/build/classes"
MAIN_CLASS="eu.infolead.llmhp.cache.SemanticCacheCli"

if [ ! -f "$CLASSES_DIR/eu/infolead/llmhp/cache/SemanticCacheCli.class" ]; then
    exit 0
fi

TOOL_INPUT=$(cat)
TOOL_NAME="${CLAUDE_TOOL_NAME:-}"

case "$TOOL_NAME" in
    Write|Edit)
        PROMPT="${CLAUDE_PROMPT_CONTEXT:-}"
        RESPONSE="$TOOL_INPUT"
        if [ -n "$PROMPT" ] && [ -n "$RESPONSE" ]; then
            java --class-path "$CLASSES_DIR" "$MAIN_CLASS" store "$PROMPT" 2>/dev/null <<< "$RESPONSE" || true
        fi
        ;;
esac

exit 0
