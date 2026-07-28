#!/bin/bash
# UserPromptSubmit Hook — Tier Router integration
#
# Intercepts EVERY user prompt before Claude processes it.
# 1. Classifies: mechanical → haiku, judgment → sonnet, deep → opus, trivial → fable
# 2. Reformulates with SOTA prompt engineering criteria
# 3. Detects ambiguity and asks for clarification
# 4. Injects <routing-recommendation> directive into Claude's context
#
# Trigger: UserPromptSubmit
# Change Driver: prompt-routing-logic

set -euo pipefail

HOOK_DIR="$(dirname "$0")"
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(dirname "$HOOK_DIR")}"
CLASSES_DIR="$PLUGIN_ROOT/build/classes"
MAIN_CLASS="eu.infolead.llmhp.router.RouterCli"

# Read user request from stdin
USER_REQUEST=$(cat)

# Verify router engine exists
if [ ! -f "$CLASSES_DIR/eu/infolead/llmhp/router/RouterCli.class" ]; then
    echo "[tier-router] Router not compiled. Pass through." >&2
    exit 0
fi

# Check dependencies
if ! command -v java >/dev/null 2>&1; then
    echo "[tier-router] java not found. Pass through." >&2
    exit 0
fi

TIMESTAMP=$(date -Iseconds)
REQUEST_HASH=$(echo -n "$USER_REQUEST" | sha256sum | cut -d' ' -f1 | head -c16)

# Step 1: Check ambiguity — if ambiguous, inject clarification request
AMBIGUITY=$(java --class-path "$CLASSES_DIR" "$MAIN_CLASS" ambiguity 2>/dev/null <<< "$USER_REQUEST" || echo "clear")
if [[ "$AMBIGUITY" == ambiguous:* ]]; then
    QUESTIONS="${AMBIGUITY#ambiguous:}"
    cat <<EOF
<routing-recommendation request-hash="$REQUEST_HASH">
ROUTING DIRECTIVE — AMBIGUOUS REQUEST. Clarification required.

Decision: CLARIFY
Reason: Request is ambiguous — missing scope, target, or specificity

CLARIFICATION QUESTIONS:
$QUESTIONS

ACTION INSTRUCTIONS:
- You MUST NOT proceed with this request
- You MUST ask the user the clarification questions above
- You MUST NOT attempt to guess or infer the missing information
- Once the user clarifies, re-process with updated context
</routing-recommendation>
EOF
    exit 0
fi

# Step 2: Classify + rewrite
ROUTING_OUTPUT=$(java --class-path "$CLASSES_DIR" "$MAIN_CLASS" route 2>/dev/null <<< "$USER_REQUEST" || echo '{"decision":"escalate","tier":"sonnet","reason":"classification_failed","confidence":0.5}')

# Step 3: Extract fields
DECISION=$(echo "$ROUTING_OUTPUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('decision','escalate'))" 2>/dev/null || echo "escalate")
TIER=$(echo "$ROUTING_OUTPUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('tier','sonnet'))" 2>/dev/null || echo "sonnet")
REASON=$(echo "$ROUTING_OUTPUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('reason','no reason'))" 2>/dev/null || echo "no reason")
CONFIDENCE=$(echo "$ROUTING_OUTPUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('confidence',0.5))" 2>/dev/null || echo "0.5")
REWRITTEN=$(echo "$ROUTING_OUTPUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('rewritten_prompt',''))" 2>/dev/null || echo "$USER_REQUEST")

# Log to stderr for visibility
echo "[tier-router] Decision: $DECISION" >&2
echo "[tier-router] Tier: $TIER" >&2
echo "[tier-router] Reason: $REASON" >&2
echo "[tier-router] Confidence: $CONFIDENCE" >&2

# Metrics log (atomic append)
PROJECT_ROOT=$(cd "$CLAUDE_PROJECT_DIR" 2>/dev/null && pwd || echo "unknown")
METRICS_DIR="$PROJECT_ROOT/.tier-router/metrics"
mkdir -p "$METRICS_DIR"
TODAY=$(date +%Y-%m-%d)

(
    flock -x -w 5 200 2>/dev/null && {
        echo "{\"timestamp\":\"$TIMESTAMP\",\"hash\":\"$REQUEST_HASH\",\"decision\":\"$DECISION\",\"tier\":\"$TIER\",\"confidence\":$CONFIDENCE}" >> "$METRICS_DIR/$TODAY.jsonl"
    } || true
) 200>"$METRICS_DIR/$TODAY.jsonl.lock"

# Step 4: Output routing directive (injected into Claude context)
cat <<EOF
<routing-recommendation request-hash="$REQUEST_HASH">
ROUTING DIRECTIVE — MANDATORY ACTION REQUIRED. No interpretation allowed.

Decision: $DECISION
Tier: $TIER-general
Reason: $REASON
Confidence: $CONFIDENCE

ACTION INSTRUCTIONS:
- You MUST NOT handle this request directly
- You MUST use the Task tool to invoke the appropriate agent
EOF

if [ "$DECISION" = "escalate" ]; then
    cat <<'INNER'
- You MUST invoke the sonnet-general agent with the user's request
- You MUST NOT ask clarifying questions about routing
- Execute immediately with no hesitation

ORIGINAL REQUEST: [see user's message above]
INNER
else
    cat <<INNER
- You MUST invoke the ${TIER}-general agent with the rewritten prompt below
- You MUST NOT ask clarifying questions about routing
- Execute immediately with no hesitation

REWRITTEN PROMPT: $REWRITTEN
INNER
fi

cat <<'EOF'
</routing-recommendation>
EOF

exit 0
