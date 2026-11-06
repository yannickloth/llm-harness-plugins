# codify-first — Assumptions

Injects a short always-on `codify-first intake` directive into the system prompt (gated by a session-topic classifier) and self-registers the `codify-first` skill that carries the full gate-and-codify procedure.

## OpenCode API (hooks used, v1 vs v2, version sensitivity)
- Dual entrypoint: v2 default export `{ id, setup(ctx), server(input, options) }`; v1 path returns a plugin factory from `server()`. ⚠ `id` + `setup` must match the running binary (2.2.5); a hook rename fails load silently (the load canary is the only signal).
- v2 hooks: `ctx.skill.transform` (shared/v2-skills.ts), `ctx.session.hook("prompt")` (reads `event.prompt?.text`, `event.sessionID`), `ctx.session.hook("context")` (reads/writes `event.system` parts `{ type, text }`, appends the directive). Shapes match the datetime-inject/agentfeed v2 ports. ⚠ All version-sensitive.
- v1 hooks: `config` (appends the skills dir to `input.skills.paths`), `chat.message` (classifies the first text part per message; same input shape as agentfeed/agentmem), `experimental.chat.system.transform` (string array). ⚠ The experimental hook name must exist in `@opencode-ai/plugin` v1.19.3.
- v1/v2 parity is manual: identical marker check (`CODIFY_FIRST_MARKER` substring) and identical personal-session suppression, but v1 reassigns `output.system` while v2 mutates `event.system` in place — both idempotent per marker.
- ⚠ v2 settings arrive as `ctx.options` (`enabled`, `topicGate`); v1 reads them from the config hook's `input.codify_first` (or `codifyFirst`) block, overriding constructor options. Whether opencode 2.x forwards a top-level `codify_first` config key into `ctx.options` (vs only plugin-tuple options) is unverified — if not, the JSON settings are silently ignored on the v2 path (defaults `true`/`true` apply).

## Environment (env vars read, with defaults; binaries on PATH; OS/process assumptions)
- No binaries spawned, no env vars read (canary env vars belong to shared/load-canary, preflight-only).
- Runs in-process only: all state lives in the opencode server process's heap. ⚠ An opencode server restart loses all topic classifications (sessions re-enter as `unknown` → directive re-injected).

## Filesystem & layout (paths read/written, where anchored — cwd / repo root / XDG; formats; encodings)
- `skills/` anchored at the plugin directory via `moduleDir(import.meta.url)` — independent of cwd.
- Read: `skills/codify-first/SKILL.md` (frontmatter `name`/`description` parsed by shared/v2-skills.ts; `argument-hint:` ignored). UTF-8 assumed.
- Write: nothing, except the load canary marker (only when `LLMHP_CANARY_DIR` and `LLMHP_CANARY_NONCE` are both set; no-op otherwise).
- ⚠ `skillCount` runs `fs.statSync` on every skills-dir entry without a guard; a broken symlink there throws during `setup` and kills plugin load.
- The skill's "check what exists" step and "project-first target" step instruct the model to read/write `.opencode/skill/` and `.opencode/agent/` **in the consuming project** (cwd-relative, not this repo). ⚠ Singular `skill/` and `agent/` are the legacy directory spellings; upstream opencode scans `{skill,skills}` and legacy `agent/`, so both still resolve, but the modern spellings are `skills/`/`agents/` (the repo's own claude-to-opencode-migration skill uses the plural).
- ⚠ The skill step 3 says to "follow the built-in `customize-opencode` skill" for authoring conventions. In the live opencode 2.2.5 session `skill("customize-opencode")` returns "Unable to load skill" — the reference is not actionable on this binary (the built-in existed in upstream v1.14.x).
- The skill references the `find-skills` skill (present in the live session) and the project `AGENTS.md` (assumed to exist in the consuming project; optional).

## External services (URLs/ports, protocol assumptions)
- None.

## Configuration (what opencode.json must register for it to work; whether it actually is)
- Root `opencode.json` registers `./codify-first/opencode` (plugin array, line 10) — ✓ actually is.
- Optional `codify_first` block (`enabled`, `topicGate`, both default `true`) — ⚠ honored on the v1 path; v2 delivery via `ctx.options` unverified (see above). README shows the block; no entry for it exists in the current root `opencode.json`, so defaults apply.
- No `agent`/`skill` entries required: the skill self-registers via `ctx.skill.transform` (v2) / `skills.paths` (v1).

## Concurrency (locks, multi-instance behavior, atomicity)
- ⚠ The topic map (shared/session-topic.ts) is a module-level in-memory `Map` — no locking, no eviction, no persistence. Grows one entry per session ID for the server's lifetime; concurrent messages for one session interleave without sync (last classification wins; `project` is sticky by construction).
- Multiple plugin instances in one process share the same map (same module instance) — consistent, but a second opencode process (e.g., `opencode run` subprocess) has its own empty map.

## Data & LLM behavior (formats trusted from the model; model assumptions)
- The intake gate trusts the model to run the three-question gate, cap codification at one artifact per task, and execute the original task through the created artifact — enforced only by directive/skill text.
- ⚠ The topic classifier is keyword-regex only (shared/session-topic.ts): project markers include bare common English words (`go`, `test`, `session`, `task`, `c`, `h`), so personal English messages can classify as `project`; personal markers exist only for FR/DE/ES/IT, so English personal text never matches and falls to `unknown` — and `unknown` sessions still receive the directive. The README promise "personal sessions are left alone" holds only for the four European-language lists.
- ⚠ `project` stickiness makes classifier false positives permanent: one early project-word in a personal session reclassifies it for the rest of the session.
- The directive is appended to the end of the system prompt (after base prompt, after other plugins' injections) on both v1 and v2 paths.
