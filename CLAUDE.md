# Myco — Collective Agent Intelligence

Claude Code plugin that captures session knowledge (events, observations, summaries) into a Markdown vault and serves it back via MCP tools.

## Dogfooding

We develop Myco using Myco. The plugin is loaded from the local working directory, not installed from the marketplace:

```sh
claude --plugin-dir .
```

This sets `${CLAUDE_PLUGIN_ROOT}` to the repo root. The vault lives at `~/.myco/vaults/myco/` (configured in `.env` and `.claude/settings.json`).

**Implications for development:**

- After changing hook or daemon code, you MUST run `make build` and then `node dist/src/cli.js restart` for the daemon. Hooks pick up new code on next invocation; the daemon does not.
- The MCP server reloads on `/reload-plugins`, but a full session restart may be needed for connection changes.
- Session data from your development sessions is real vault data. Be careful with destructive vault operations — you'll lose your own session history.

**How end users install Myco (not how we run it):**

```sh
claude plugin marketplace add goondocks-co/myco
claude plugin install myco@myco-plugins
# or
claude plugin add /path/to/myco          # local permanent install
```

Permanent installs register the plugin globally. `--plugin-dir .` is for development only. Do not confuse these modes in documentation or code paths — `${CLAUDE_PLUGIN_ROOT}` resolves differently in each case.

## Non-Goals

- This is NOT a general-purpose knowledge base or note-taking app. Do not add user-facing UI, web dashboards, or REST APIs.
- This is NOT a framework. Do not add plugin systems, extensibility hooks, or abstraction layers for hypothetical consumers.
- Do not add dependencies on cloud services. All intelligence runs locally (Ollama, LM Studio) or via lightweight API (Anthropic).

## Architecture

```
src/
  agents/        # Agent adapters (Claude Code, Cursor) for transcript discovery, parsing, and image capture
  capture/       # Event buffering (EventBuffer) and buffer-based turn fallback
  config/        # Vault config loading and Zod schema
  context/       # Context injection for UserPromptSubmit hook
  daemon/        # Long-lived HTTP daemon: batch processing, session lifecycle, plan watching
  hooks/         # Claude Code hook entry points (thin — delegate to daemon)
  index/         # SQLite FTS5 + sqlite-vec vector search
  intelligence/  # LLM backend abstraction (Ollama, LM Studio, Anthropic)
  mcp/           # MCP server + tool handlers
  prompts/       # LLM prompt templates (extraction, summary, title, classification)
  vault/         # Reader, writer, Zod schemas for vault notes
tests/           # Mirrors src/ structure: tests/<module>.test.ts
hooks/           # Hook registration shell scripts (invoke dist/src/hooks/*.js)
commands/        # Slash command markdown files
skills/          # Skill markdown files (subdirectory per skill)
.claude-plugin/  # Claude Code plugin manifest + marketplace catalog
.cursor-plugin/  # Cursor plugin manifest + marketplace catalog
.github/         # VS Code Copilot agent plugin manifest (also CI workflows)
.mcp.json        # MCP server config for VS Code (servers format)
```

### Module Boundaries

- **Hooks MUST be thin.** Hook entry points in `src/hooks/` MUST delegate to the daemon via `DaemonClient`. Hooks MUST NOT contain business logic, LLM calls, or complex processing. If the daemon is unreachable, hooks spawn it via `client.ensureRunning()` and buffer events to disk for later processing.
- **The daemon is the authority.** All event processing, session note writing, observation extraction, and embedding happen in the daemon (`src/daemon/main.ts`). Hooks send events; the daemon decides what to do with them.
- **MCP server config MUST be in `plugin.json`.** The `mcpServers` field in `.claude-plugin/plugin.json` is the only way to register MCP servers for plugins loaded via `--plugin-dir`. Do NOT use standalone `.mcp.json` for plugin MCP servers.

## Data Preservation

**Every write path MUST be additive. Never overwrite or delete accumulated session data.**

This is Myco's core contract. Violations:

- Session notes are rebuilt from the agent's authoritative transcript on each stop event. The transcript file (e.g., Claude's `.jsonl`) is the source of truth — all turns are re-parsed and the `## Conversation` section is regenerated in full. Data preservation is guaranteed by the transcript being append-only, not by the session note's write logic.
- The degraded stop path (`src/hooks/stop.ts`) MUST NOT write a session file if one already exists. It returns early; the daemon handles it when it's back.
- Buffer files (`buffer/<session-id>.jsonl`) MUST NOT be deleted on session unregister. Session reload (SessionEnd → SessionStart) reuses the same session ID. Buffers are cleaned up by age (>24h) on daemon startup only.
- `observation_type` in memory frontmatter accepts any string (`z.string()`). The LLM prompt guides types; the schema MUST NOT reject unexpected values.

## Session ID Is the Source of Truth

Do not tie state management to hook lifecycle events (SessionEnd, SessionStart). The agent will reload, resume, and trigger these hooks unpredictably. Session ID is the durable identifier — key all persistent state to it. Clean up based on age/staleness, never based on lifecycle transitions.

React to the **content** of hook payloads, not the event type.

## Idempotence by Default

Every write operation MUST be safe to run twice with the same input. No "first-time" vs "subsequent" branching that produces different structures — the output MUST be identical regardless of how many times the operation runs.

Concrete requirements:

- `writeMemory`, `writeArtifact`, `writeSession`, `writePlan`, `writeTeamMember` MUST produce the same file content given the same input, whether or not the file already exists.
- Startup tasks (migration, buffer cleanup, index rebuild) MUST be idempotent. Running the daemon startup sequence twice in a row MUST NOT move, duplicate, or corrupt data.
- `indexNote` and `indexAndEmbed` MUST upsert, not insert. Re-indexing an already-indexed note MUST NOT create duplicates.

If an operation cannot be made idempotent, it MUST be guarded by an explicit check (e.g., "skip if already migrated") and that guard MUST be documented in the code.

## No Magic Literals

Numeric and string constants MUST NOT appear inline in logic. Extract them as named constants at module scope or in a shared constants file.

This applies to:

- **Truncation limits:** Every `.slice(0, N)` MUST reference a named constant (e.g., `EMBEDDING_INPUT_LIMIT`, `PROMPT_PREVIEW_CHARS`, `CANDIDATE_CONTENT_PREVIEW`). The constant name documents the intent; the number alone does not.
- **Timeouts and thresholds:** Durations (e.g., `24 * 60 * 60 * 1000` for buffer cleanup), retry counts, similarity thresholds — all MUST be named constants.
- **Token estimates:** The `chars / 4` heuristic MUST use a named constant (`CHARS_PER_TOKEN = 4`) so it can be found and updated in one place.
- **Config defaults:** Zod `.default()` values are acceptable as-is — the schema IS the documentation. But defaults used outside Zod schemas (e.g., fallback values in constructors) MUST be named constants.

Exceptions: array indices (`[0]`), string operations (`.slice(0, 10)` for ISO date prefix), and loop bounds derived from data (`i < items.length`) are not magic literals.

## Naming Conventions

- **Memory files:** `memories/{normalized_type}/{observation_type}-{session_id_last_6}-{timestamp}.md` (e.g., `memories/gotcha/gotcha-ac5220-1773416089650.md`). The subdirectory name normalizes underscores to hyphens (`bug_fix` → `bug-fix/`).
- **Session files:** `sessions/{YYYY-MM-DD}/session-{session_id}.md`
- **Imports:** Use `@myco/*` path aliases mapping to `src/*`
- **Tests:** `tests/<module>.test.ts` mirroring `src/<module>.ts`

## Vault Structure

```
~/.myco/vaults/<vault-name>/
  myco.yaml          # Vault configuration
  daemon.json        # Running daemon PID/port
  index.db           # SQLite FTS5 index
  vectors.db         # sqlite-vec vector embeddings
  buffer/            # Per-session JSONL event buffers (ephemeral)
  sessions/          # Session notes by date
  memories/          # Observation notes (subdirectories by type: gotcha/, decision/, etc.)
  plans/             # Plan notes
  artifacts/         # Artifact references
  attachments/       # Images extracted from session transcripts (Obsidian embeds)
  team/              # Team member notes
  logs/              # Daemon logs
```

## Quality Gates

Before committing:

```sh
make check
```

This runs `make lint` (tsc --noEmit) then `make test` (vitest run). Both MUST pass.

To build (which also runs check first):

```sh
make build
```

### Available Make targets

| Target | What it does |
|--------|-------------|
| `make build` | Runs `check`, then `npm run build` (tsc emit) |
| `make check` | Runs `lint` + `test` — the pre-commit gate |
| `make lint` | `tsc --noEmit` — type checking only, strict mode |
| `make test` | `vitest run` — all tests |
| `make watch` | `tsc --watch` for development |
| `make clean` | Remove `dist/` |
| `make install` | `npm install` |

- `make check` MUST pass with zero errors before committing.
- Do NOT skip or disable tests to make the build pass.

## Golden Paths

### Add a new MCP tool

1. Create handler in `src/mcp/tools/<tool-name>.ts`
2. Add tool definition to `TOOL_DEFINITIONS` array in `src/mcp/server.ts`
3. Add case to the `CallToolRequestSchema` switch in `src/mcp/server.ts`
4. Add tests in `tests/mcp/tools/<tool-name>.test.ts`

### Add a new hook

1. Create entry point in `src/hooks/<hook-name>.ts` — keep it thin
2. Create shell wrapper in `hooks/<hook-name>` that invokes `node dist/src/hooks/<hook-name>.js`
3. The hook SHOULD send events to the daemon via `DaemonClient`; only fall back to local processing if the daemon is unreachable

### Add a new daemon route

1. Add `server.registerRoute()` call in `src/daemon/main.ts`
2. Follow the pattern: validate input → process → write to vault → index → embed
3. Embedding is fire-and-forget (`.then()/.catch()`) — never block the response on embedding

### Test the vault and embeddings

Use the CLI: `node dist/src/cli.js <command>`

- `stats` — vault health, index counts, daemon status
- `search <query>` — semantic search (primary) + FTS (fallback)
- `vectors <query>` — raw similarity scores for threshold tuning
- `rebuild` — reindex all vault notes (FTS + vectors)
- `restart` — kill and respawn the daemon with current code

### Restart daemon after code changes

The daemon persists across sessions. After modifying daemon code, you MUST restart it:

```sh
node dist/src/cli.js restart
```

Or manually: kill the PID in `~/.myco/vaults/myco/daemon.json`, then let the next session-start hook spawn a fresh one.
