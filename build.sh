#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
JAVA_SRC="$SCRIPT_DIR/agentmem/src/main/java"
CLASSES_DIR="$SCRIPT_DIR/agentmem/build/classes"
BIN_DIR="$SCRIPT_DIR/agentmem/bin"

mkdir -p "$CLASSES_DIR" "$BIN_DIR"

find "$JAVA_SRC" -name '*.java' -print0 | xargs -0 javac -d "$CLASSES_DIR" --release 25

cat > "$BIN_DIR/memorysystem" << 'RUNNER'
#!/usr/bin/env bash
# Resolves ${CLAUDE_PLUGIN_ROOT} when run from Claude Code plugin, or self-locates
if [ -n "${CLAUDE_PLUGIN_ROOT:-}" ]; then
    ROOT="${CLAUDE_PLUGIN_ROOT}"
else
    ROOT="$(cd "$(dirname "$0")/.." && pwd)"
fi
exec java --class-path "${ROOT}/build/classes" --source 25 "${ROOT}/MemorySystem.java" "$@"
RUNNER
chmod +x "$BIN_DIR/memorysystem"

echo "Compiled to $CLASSES_DIR"
echo "Runner: $BIN_DIR/memorysystem"
