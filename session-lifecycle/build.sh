#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC_DIR="$SCRIPT_DIR/src/main/java"
CLASSES_DIR="$SCRIPT_DIR/build/classes"
BIN_DIR="$SCRIPT_DIR/bin"

mkdir -p "$CLASSES_DIR" "$BIN_DIR"

find "$SRC_DIR" -name '*.java' -print0 | xargs -0 javac -d "$CLASSES_DIR" --release 25

javac -d "$CLASSES_DIR" -cp "$CLASSES_DIR" --release 25 "$BIN_DIR/SessionLifecycle.java"

echo "Compiled session-lifecycle to $CLASSES_DIR"
