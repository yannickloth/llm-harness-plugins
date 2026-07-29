#!/bin/bash
set -euo pipefail

HOOK_DIR="$(dirname "$0")"
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(dirname "$HOOK_DIR")}"
CLASSES_DIR="$PLUGIN_ROOT/build/classes"
MAIN_CLASS="eu.infolead.llmhp.cache.SemanticCacheCli"
CACHE_DIR="${CLAUDE_PROJECT_DIR:-.}/.agentmem/cache"

if [ ! -f "$CLASSES_DIR/eu/infolead/llmhp/cache/SemanticCacheCli.class" ]; then
    exit 0
fi

PROMPT="${CLAUDE_PROMPT_CONTEXT:-$(cat)}"
RESULT=$(java --class-path "$CLASSES_DIR" "$MAIN_CLASS" lookup 2>/dev/null <<< "$PROMPT" || echo '{"hit":false}')
HIT=$(echo "$RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('hit',False))" 2>/dev/null || echo "False")

if [ "$HIT" = "True" ]; then
    echo '[semantic-cache] Cache hit — returning cached response (verify against current state)' >&2
    echo "$RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin)['cached_response'])" 2>/dev/null
    exit 0
fi

exit 0
