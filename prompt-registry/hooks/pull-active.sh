#!/bin/bash
set -euo pipefail
HOOK_DIR="$(dirname "$0")"
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$HOOK_DIR/.." && pwd)}"
CLASSES_DIR="$PLUGIN_ROOT/build/classes"
MAIN_CLASS="eu.infolead.llmhp.promptregistry.PromptRegistryCli"

[ -f "$CLASSES_DIR/eu/infolead/llmhp/promptregistry/PromptRegistryCli.class" ] || exit 0

java --class-path "$CLASSES_DIR" "$MAIN_CLASS" pull-all --to "$PLUGIN_ROOT" 2>/dev/null || true
