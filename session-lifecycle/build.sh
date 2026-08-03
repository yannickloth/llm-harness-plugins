#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC_DIR="$SCRIPT_DIR/src/main/java"
CLASSES_DIR="$SCRIPT_DIR/build/classes"
BIN_DIR="$SCRIPT_DIR/bin"
SHARED_CP="$SCRIPT_DIR/../shared/build/classes"

mkdir -p "$CLASSES_DIR" "$BIN_DIR"

find "$SRC_DIR" -name '*.java' -print0 | xargs -0 javac -d "$CLASSES_DIR" --release 25 --class-path "$SHARED_CP"

javac -d "$CLASSES_DIR" -cp "${CLASSES_DIR}:${SHARED_CP}" --release 25 "$BIN_DIR/SessionLifecycle.java"

echo "Compiled session-lifecycle to $CLASSES_DIR"
