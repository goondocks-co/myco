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
claude plugin add @goondocks-co/myco     # from marketplace
# or
claude plugin add /path/to/myco          # local permanent install
```

Permanent installs register the plugin globally. `--plugin-dir .` is for development only. Do not confuse these modes in documentation or code paths — `${CLAUDE_PLUGIN_ROOT}` resolves differently in each case.

## Non-Goals

- This is NOT a general-purpose knowledge base or note-taking app. Do not add user-facing UI, web dashboards, or REST APIs.
- This is NOT a framework. Do not add plugin systems, extensibility hooks, or abstraction layers for hypothetical consumers.
- Do not add dependencies on cloud services. All intelligence runs locally (Ollama, LM Studio) or via lightweight API (Haiku).

## Architecture

```
src/
  capture/       # Event buffering (EventBuffer) and transcript mining
  config/        # Vault config loading and Zod schema
  context/       # Context injection for UserPromptSubmit hook
  daemon/        # Long-lived HTTP daemon: batch processing, session lifecycle, plan watching
  hooks/         # Claude Code hook entry points (thin — delegate to daemon)
  index/         # SQLite FTS5 + sqlite-vec vector search
  intelligence/  # LLM backend abstraction (Ollama, LM Studio, Haiku)
  mcp/           # MCP server + tool handlers
  vault/         # Reader, writer, Zod schemas for vault notes
tests/           # Mirrors src/ structure: tests/<module>.test.ts
hooks/           # Hook registration shell scripts (invoke dist/src/hooks/*.js)
commands/        # Slash command markdown files
skills/          # Skill markdown files (subdirectory per skill)
.claude-plugin/  # plugin.json manifest (includes mcpServers config)
```

### Module Boundaries

- **Hooks MUST be thin.** Hook entry points in `src/hooks/` MUST delegate to the daemon via `DaemonClient`. Hooks MUST NOT contain business logic, LLM calls, or complex processing. The only exception is the degraded fallback path in `stop.ts`, which runs when the daemon is unreachable.
- **The daemon is the authority.** All event processing, session note writing, observation extraction, and embedding happen in the daemon (`src/daemon/main.ts`). Hooks send events; the daemon decides what to do with them.
- **MCP server config MUST be in `plugin.json`.** The `mcpServers` field in `.claude-plugin/plugin.json` is the only way to register MCP servers for plugins loaded via `--plugin-dir`. Do NOT use standalone `.mcp.json` for plugin MCP servers.

## Data Preservation

**Every write path MUST be additive. Never overwrite or delete accumulated session data.**

This is Myco's core contract. Violations:

- Session notes MUST append new turns to the existing `## Conversation` section. The `writeSession` call rebuilds frontmatter but MUST preserve all prior turn content.
- The degraded stop path (`src/hooks/stop.ts`) MUST NOT write a session file if one already exists. It returns early; the daemon handles it when it's back.
- Buffer files (`buffer/<session-id>.jsonl`) MUST NOT be deleted on session unregister. Session reload (SessionEnd → SessionStart) reuses the same session ID. Buffers are cleaned up by age (>24h) on daemon startup only.
- `observation_type` in memory frontmatter accepts any string (`z.string()`). The LLM prompt guides types; the schema MUST NOT reject unexpected values.

## Session ID Is the Source of Truth

Do not tie state management to hook lifecycle events (SessionEnd, SessionStart). The agent will reload, resume, and trigger these hooks unpredictably. Session ID is the durable identifier — key all persistent state to it. Clean up based on age/staleness, never based on lifecycle transitions.

React to the **content** of hook payloads, not the event type.

## Naming Conventions

- **Memory files:** `{observation_type}-{session_id_last_6}-{timestamp}.md` (e.g., `gotcha-ac5220-1773416089650.md`)
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
  memories/          # Observation notes
  plans/             # Plan notes
  artifacts/         # Artifact references
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
