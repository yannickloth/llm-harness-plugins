#!/bin/bash
set -euo pipefail

HOOK_DIR="$(dirname "$0")"
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(dirname "$HOOK_DIR")}"
CLASSES_DIR="$PLUGIN_ROOT/build/classes"
RUNNER="$PLUGIN_ROOT/bin/cachecli"
MAIN_CLASS="eu.infolead.llmhp.cache.SemanticCacheCli"

if [ -f "$CLASSES_DIR/eu/infolead/llmhp/cache/SemanticCacheCli.class" ]; then
    : # ok
else
    exit 0
fi

PROMPT="${CLAUDE_PROMPT_CONTEXT:-$(cat)}"
RESULT=$(java --class-path "$CLASSES_DIR" "$MAIN_CLASS" lookup <<< "$PROMPT" 2>/dev/null || echo '{"hit":false}')
HIT=$(echo "$RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('hit',False))" 2>/dev/null || echo "False")

if [ "$HIT" = "True" ]; then
    CACHED=$(echo "$RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin)['cached_response'])" 2>/dev/null)
    printf '[semantic-cache] Cache hit — injecting cached response as additionalContext\n' >&2
    jq -n --arg ctx "$CACHED" '{
        hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "allow",
            permissionDecisionReason: "Semantic cache hit — cached response injected as context",
            additionalContext: ("[SEMANTIC CACHE HIT — stale, verify against current state]\n\n" + $ctx)
        }
    }'
    exit 0
fi

exit 0
