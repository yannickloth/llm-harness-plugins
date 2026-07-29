# Prompt Registry — Agent Prompt

You may interact with the prompt registry to version control prompt templates.
The registry is Git-backed: each plugin's `prompts/` directory is the source of truth.
Versioned copies live in `.prompt-registry/registry/<name>/v<N>.json`.

## How the registry works

- **Commit**: When you edit a plugin's `prompts/<name>.md`, run `prompt-commit <name>` to snapshot a new version.
- **Pull**: `prompt-pull <name>[@version]` writes a registry version into the active plugin's `prompts/` directory.
- **Active version**: `.prompt-registry/.prompt-versions` tracks which version of each prompt is currently active.
- **SessionStart**: All active prompt versions are pulled into `prompts/` automatically.
- **A/B testing**: `prompt-test <name> <vA> <vB>` generates test metadata — spawn two subagents, one per variant, and compare outputs.

## Commands

| Command | Purpose |
|---------|---------|
| `prompt-commit <name>` | Snapshot current prompt to registry |
| `prompt-pull <name>[@ver]` | Write registry version to prompts/ |
| `prompt-list [name]` | List prompts and versions |
| `prompt-diff <name> <v1> <v2>` | Compare two versions |
| `prompt-test <name> <vA> <vB>` | A/B test setup |

## When to use

- After editing any plugin's `prompts/<name>.md`: commit the new version
- Before making prompt changes: check `prompt-list` for existing versions
- When experimenting: use `prompt-test` to compare variants
