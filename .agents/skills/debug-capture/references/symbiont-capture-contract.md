# Symbiont Capture Contract

What each supported agent emits and how Myco captures it. Companion to `capture-lifecycle.md` in this directory.

Every new symbiont (or new symbiont version) reproduces the same shape of integration bug if this matrix isn't kept current. When you debug a capture issue, find the symbiont's row before forming a hypothesis — most "weird capture behavior" is really "this agent does X differently and Myco's adapter doesn't handle that case."

The values below are derived from the symbiont manifests in `packages/myco/src/symbionts/manifests/*.yaml` and the installed hook templates in `packages/myco/src/symbionts/templates/*/`. If those drift from this table, the manifest wins — please update the doc.

## Matrix

| Aspect | Claude Code | Codex | Cursor | OpenCode | Gemini CLI | Windsurf |
|---|---|---|---|---|---|---|
| Manifest name | `claude-code` | `codex` | `cursor` | `opencode` | `gemini` | `windsurf` |
| Binary | `claude` | `codex` | `cursor` | `opencode` | `gemini` | `windsurf` |
| Hook config target | `.claude/settings.json` | `.codex/hooks.json` | `.cursor/hooks.json` | `.opencode/plugins/myco.ts` (plugin file) | `.gemini/settings.json` | `.windsurf/hooks.json` |
| Hook events emitted | SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, PostToolUseFailure, SubagentStart, SubagentStop, Stop, StopFailure, SessionEnd, PreCompact, PostCompact, TaskCompleted | SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, Stop | sessionStart, sessionEnd, beforeSubmitPrompt, postToolUse, postToolUseFailure, subagentStart, subagentStop, stop, preCompact | (delivered via plugin runtime; see plugin file) | SessionStart, BeforeAgent, AfterAgent, AfterTool, PreCompress, SessionEnd | pre_user_prompt, post_cascade_response, post_run_command, post_write_code |
| Session ID hook field | `session_id` | `session_id` | `conversation_id` | `session_id` | `session_id` (env fallback `GEMINI_SESSION_ID`) | `trajectory_id` |
| Transcript path hook field | `transcript_path` | `transcript_path` | `transcript_path` | `transcript_path` | `transcript_path` | `transcript_path` |
| Transcript path convention | `~/.claude/projects/<encoded-cwd>/<sid>.jsonl` | `~/.codex/sessions/<date>/rollout-<sid>.jsonl` | host-managed; path in payload | host-managed; path in payload | host-managed; path in payload | host-managed; path in payload |
| Last-response hook field | `last_assistant_message` | `last_assistant_message` | `last_assistant_message` | `last_assistant_message` | `last_assistant_message` | `last_assistant_message` |
| Project root resolution | `CLAUDE_PROJECT_DIR` env var (set by Claude Code in the hook env) | hook payload `cwd` | hook payload `cwd` | plugin runtime API | hook payload `cwd` | hook payload `cwd` |
| Plugin root env var | `CLAUDE_PLUGIN_ROOT` | `CODEX_PLUGIN_ROOT` | `CURSOR_PLUGIN_ROOT` | `MYCO_PLUGIN_ROOT` (set by plugin shim) | `GEMINI_PLUGIN_ROOT` | `WINDSURF_PLUGIN_ROOT` |
| Resume command template | `claude --resume {sessionId}` | (none — Codex resumes via rollout file lookup) | (none — IDE) | `opencode --resume {sessionId}` | (none — CLI session restart) | (none — IDE) |
| Plan capture dirs | `~/.claude/plans/`, `.claude/plans/` | (none — uses prompt tags) | `~/.cursor/plans/` | `.opencode/plans/` | `.gemini/plans/` | `~/.windsurf/plans/` |
| Plan capture prompt tags | `ultraplan` | (codex-specific tag set in manifest) | (none) | (none — file-based) | (none — file-based) | (none — file-based) |
| Capture install format | JSON merge | JSON merge | JSON merge | `plugin-file` (verbatim ts copy with myco markers) | JSON merge | JSON merge |
| Notable manifest rules | drop `<command-message>` / `<command-name>` envelopes (slash-command dispatch); drop async Agent-tool completion notifications | drop ephemeral sub-invocation tool events without `transcript_path` | (see manifest rules) | (see manifest rules) | (see manifest rules) | (see manifest rules) |

## How to read this

- **Session ID hook field** — the JSON key Myco's hook parser looks for in the payload to pull the session id. Required; if it's missing or renamed by an upstream change, every event drops with "orphan-no-session-id".
- **Transcript path hook field** — same; required for the transcript miner to find the agent's native conversation file at Stop.
- **Project root resolution** — how the daemon knows which project's vault to route the event to. Claude Code uses an env var the agent injects; everyone else carries `cwd` in the hook payload.
- **Manifest rules** — declarative filters that drop or rewrite specific event shapes before they hit the dispatcher. These are how we handle agent-specific quirks (slash command dispatch envelopes, ephemeral sub-invocations, etc.) without hardcoding agent names in the dispatcher.

## Prompt classification (origin) and sub-agent threads

Beyond drop/keep, each agent's `capture.rules` classify prompts by *origin* — WHO issued them — so non-human prompts are preserved but hidden by default. Three action lanes:

- **`drop`** — proven-valueless only (duplicate dispatch envelopes, no-transcript phantoms, non-interactive `exec`).
- **`classify` + `set_origin`** — capture but tag `system` or `agent_dispatch` (hidden behind the "Show system & sub-agent prompts" filter). Origin values: `human` (default), `system` (runtime/synthesized continuations), `agent_dispatch` (sub-agent → parent), `hook_injected` (reserved).
- **`rewrite_prompt`** — unwrap a human wrapper (`strip_envelope` for a tag pair, `extract_after` for a marker preamble) so the stored prompt is only the user's text.

Two structural predicates decide classification without brittle text matching:

- `prompt_envelope_tag_in: [tags]` — attribute-robust open-tag-name match (`<agent-message from="…">` matches `agent-message`); maps known envelopes to an origin.
- `prompt_is_enclosing_envelope: true` — whole-message fail-safe → `system`. MUST be the last `user_prompt` rule, and only for agents whose human input is NOT itself wrapped. Agents that wrap human input (e.g. Cursor `<user_query>`, Cline `<user_input>`) strip the wrapper first and carry no fail-safe, otherwise every human prompt hides as `system`.

Sub-agent threads (agents that isolate sub-agent work into separate transcripts, e.g. Codex `thread_spawn`): the sub-agent's turns are mined into the PARENT session as `agent_dispatch` batches with a non-null `thread_id`/`thread_label` — one session, many threads, no child session row. Three manifest dot-paths drive it: `subagentParentPath`, `subagentThreadIdPath`, `subagentLabelPath` (all in `capture:`). Agents without `subagentParentPath` have no thread concept.

## Where to look when this doc is wrong

The source of truth for everything in the matrix lives under `packages/myco/src/symbionts/`:

- `manifests/<agent>.yaml` — declarative shape: hook field mapping, plan dirs, plan tags, manifest rules.
- `templates/<agent>/hooks.json` (or `plugin.ts` for plugin-file format) — the actual hook command list installed into the user's project.
- `manifest-schema.ts` — the Zod schema for the manifest.

If you're adding a new symbiont, see the `.agents/skills/add-symbiont/SKILL.md` skill. If you're debugging an existing one, walk the capture-lifecycle stack top-down and find the layer where the symbiont's behavior diverges from this matrix.
