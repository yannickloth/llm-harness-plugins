#!/usr/bin/env bash
#
# Make plugin-shipped agents discoverable to OpenCode.
#
# A plugin's agent files (<plugin>/agents/<name>.md) are NOT auto-discovered:
# the plugin directory is not a location OpenCode scans for agents, so a plugin
# that spawns `opencode run --agent <name>` (agentmem's memory-keeper /
# memory-dreamer, for example) fails with Session.AgentNotFoundError unless the
# name is registered. The two registration paths that work:
#
#   A. place the .md where agent discovery looks, keeping its frontmatter
#      (mode, steps, permission) authoritative; or
#   B. reference the body from opencode.json as prompt: "{file:...}" — only the
#      body loads, frontmatter is ignored, so mode/permissions must be restated
#      in JSON.
#
# This script uses A: one symlink per agent into the global agent directory, so
# the repo file stays the single source of truth and edits take effect
# immediately (no re-run needed). The destination is ~/.config/opencode/agent/,
# which every version in use discovers (V2 also reads agents/, mode/, modes/).
#
# ONLY THE PLUGINS IN $OPENCODE_AGENT_PLUGINS ARE LINKED (default: agentmem).
# This is deliberate, not laziness: an agent file the oldest client in use
# cannot validate makes that client refuse to start entirely. Linking every
# plugin agent here once broke JetBrains' bundled opencode 1.18.25, which
# aborted with `Configuration is invalid at
# ~/.config/opencode/agent/typst-syntax-fixer.md` (a `tools:`-in-legacy-format
# file that V2 normalizes but 1.18.x rejects) — and that client then could not
# run at all. Add plugins one at a time, verifying each client still starts:
#
#   OPENCODE_AGENT_PLUGINS="agentmem general-skills" ./install-agents.sh
#
# Idempotent, and self-pruning: links into this repo that are no longer in the
# allowlist are removed, so narrowing the list cleans up on the next run. A real
# file in the destination is never overwritten or deleted.
#
# Usage: ./install-agents.sh [--dry-run]
set -euo pipefail

dest="${XDG_CONFIG_HOME:-$HOME/.config}/opencode/agent"
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
plugins="${OPENCODE_AGENT_PLUGINS:-agentmem}"
dry_run=0
[ "${1:-}" = "--dry-run" ] && dry_run=1

mkdir -p "$dest"

declare -a sources=()
for plugin in $plugins; do
  dir="$repo/$plugin/agents"
  [ -d "$dir" ] || { echo "skip    $plugin — no $dir"; continue; }
  while IFS= read -r file; do
    sources+=("$(readlink -f "$file")")
  done < <(find "$dir" -maxdepth 1 -name '*.md' | sort)
done

created=0
skipped=0
removed=0

# Prune stale links into this repo that the allowlist no longer covers.
for link in "$dest"/*.md; do
  [ -L "$link" ] || continue
  target="$(readlink -f "$link" 2>/dev/null || true)"
  case "$target" in
    "$repo"/*) ;;
    *) continue ;;
  esac
  keep=0
  for source in "${sources[@]:-}"; do
    [ "$source" = "$target" ] && keep=1 && break
  done
  if [ "$keep" = 0 ]; then
    if [ "$dry_run" = 1 ]; then
      echo "would remove $(basename "$link") — not in $plugins"
    else
      rm -f "$link"
      echo "removed $(basename "$link") — not in $plugins"
    fi
    removed=$((removed + 1))
  fi
done

for source in "${sources[@]:-}"; do
  [ -n "$source" ] || continue
  name="$(basename "$source")"
  target="$dest/$name"

  if [ -L "$target" ] && [ "$(readlink -f "$target")" = "$source" ]; then
    continue
  fi
  if [ -e "$target" ] && [ ! -L "$target" ]; then
    echo "skip    $name — $target exists and is not a symlink"
    skipped=$((skipped + 1))
    continue
  fi

  if [ "$dry_run" = 1 ]; then
    echo "would link $name -> $source"
  else
    ln -sfn "$source" "$target"
    echo "linked  $name -> $source"
  fi
  created=$((created + 1))
done

if [ "$dry_run" = 1 ]; then
  echo "$created to link, $removed to remove, $skipped skipped (plugins: $plugins; dest: $dest)"
else
  echo "$created linked, $removed removed, $skipped skipped (plugins: $plugins; dest: $dest)"
fi
