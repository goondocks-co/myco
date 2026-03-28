# Myco — Collective Agent Intelligence

Codex plugin that captures session knowledge (events, observations, summaries) into a SQLite-backed intelligence graph and serves it back via MCP tools.

## Dogfooding

We develop Myco using Myco. The vault lives at `~/.myco/vaults/myco/` (configured in `.env` and `.Codex/settings.json`).

**Implications for development:**

- After changing hook or daemon code, you MUST run `make build` and then `myco-dev restart` for the daemon. Hooks pick up new code on next invocation; the daemon does not.
- The MCP server reloads on `/reload-plugins`, but a full session restart may be needed for connection changes.
- Session data from your development sessions is real vault data. Be careful with destructive vault operations — you'll lose your own session history.

**How end users install Myco (not how we run it):**

```sh
curl -fsSL https://myco.sh/install.sh | sh   # Installs Node package globally
cd your-project
myco init                                       # Interactive wizard: embedding provider, model, plugin registration
```

`myco init` runs an interactive wizard that guides users through embedding provider selection (Ollama, OpenRouter, OpenAI, or skip), model selection, vault creation, and symbiont plugin registration. Use `myco doctor` to verify setup health.

**Dev binary setup:**

```sh
make dev-link    # Creates myco-dev symlink, sets MYCO_CMD=myco-dev in settings.json
make dev-unlink  # Removes myco-dev, clears MYCO_CMD
```

After changing hook or daemon code, run `make build` — the wrapper script picks up the new build automatically.

## Non-Goals

- This is NOT a general-purpose knowledge base or note-taking app. Do not add external REST APIs or public-facing web services. The local dashboard is the configuration and operations interface.
- This is NOT a framework. Do not add plugin systems, extensibility hooks, or abstraction layers for hypothetical consumers.
- Do not add dependencies on cloud services. All intelligence runs locally (Ollama, LM Studio) or via lightweight API (Anthropic).

## Architecture

```
src/
  symbionts/     # Symbiont adapters (Codex, Cursor) for transcript discovery, parsing, and plugin registration
  capture/       # Event buffering (EventBuffer) and buffer-based turn fallback
  config/        # Vault config loading and Zod schema
  context/       # Context injection for UserPromptSubmit hook
  daemon/        # Long-lived HTTP daemon: batch processing, session lifecycle, plan watching, digest
  hooks/         # Codex hook entry points (thin — delegate to daemon)
  index/         # SQLite FTS5 + sqlite-vec vector search
  intelligence/  # LLM backend abstraction (Ollama, LM Studio, Anthropic)
  mcp/           # MCP server + tool handlers
  prompts/       # LLM prompt templates (extraction, summary, title, classification)
  vault/         # Reader, writer, Zod schemas for database records
tests/           # Mirrors src/ structure: tests/<module>.test.ts
hooks/           # Hook registration shell scripts (invoke dist/src/hooks/*.js)
skills/          # Skill markdown files (subdirectory per skill)
.github/         # VS Code Copilot agent plugin manifest (also CI workflows)
.mcp.json        # Project-level MCP config written by the SymbiontInstaller
ui/              # React + Tailwind dashboard (Vite build → dist/ui/)
  src/
    components/  # UI components (ui/, topology/, config/, operations/)
    hooks/       # React hooks (use-daemon, use-config, use-power-query, etc.)
    layout/      # Layout with sidebar navigation
    lib/         # Utilities (api, cn, constants)
    pages/       # Dashboard, Configuration, Operations, Logs
    providers/   # Theme, Font, Power providers
```

### Dashboard

The daemon serves a React SPA at `http://localhost:<port>/` for configuration management and operational triggers.

**Development:** `cd ui && MYCO_DAEMON_PORT=<port> npx vite dev` — Vite dev server proxies API calls to the daemon.

**Build:** `make build` runs both `tsup` (backend) and `vite build` (frontend). Output: `dist/ui/`.

**API routes** are thin handlers in `src/daemon/api/` that delegate to shared services in `src/services/`. The CLI and API use the same code paths — no logic duplication.

### Module Boundaries

- **Hooks MUST be thin.** Hook entry points in `src/hooks/` MUST delegate to the daemon via `DaemonClient`. Hooks MUST NOT contain business logic, LLM calls, or complex processing. If the daemon is unreachable, hooks spawn it via `client.ensureRunning()` and buffer events to disk for later processing.
- **The daemon is the authority.** All event processing, session recording, spore extraction, and embedding happen in the daemon (`src/daemon/main.ts`). Hooks send events; the daemon decides what to do with them.
- **Digest is a daemon task.** The digest engine runs inside the daemon process alongside batch processing and plan watching. It is NOT a hook or MCP server — it produces digest extracts that are served by hooks and MCP tools at query time.

## Data Preservation

**Every write path MUST be additive. Never overwrite or delete accumulated session data.**

This is Myco's core contract. Violations:

- Session records are rebuilt from the agent's authoritative transcript on each stop event. The transcript file (e.g., the agent's `.jsonl`) is the source of truth — all turns are re-parsed and the conversation section is regenerated in full. Data preservation is guaranteed by the transcript being append-only, not by the session write logic.
- The degraded stop path (`src/hooks/stop.ts`) MUST NOT write a session file if one already exists. It returns early; the daemon handles it when it's back.
- Buffer files (`buffer/<session-id>.jsonl`) MUST NOT be deleted on session unregister. Session reload (SessionEnd → SessionStart) reuses the same session ID. Buffers are cleaned up by age (>24h) on daemon startup only.
- `observation_type` in spore frontmatter accepts any string (`z.string()`). The LLM prompt guides types; the schema MUST NOT reject unexpected values.

## Session ID Is the Source of Truth

Do not tie state management to hook lifecycle events (SessionEnd, SessionStart). The agent will reload, resume, and trigger these hooks unpredictably. Session ID is the durable identifier — key all persistent state to it. Clean up based on age/staleness, never based on lifecycle transitions.

React to the **content** of hook payloads, not the event type.

## Idempotence by Default

Every write operation MUST be safe to run twice with the same input. No "first-time" vs "subsequent" branching that produces different structures — the output MUST be identical regardless of how many times the operation runs.

Concrete requirements:

- `writeSpore`, `writeArtifact`, `writeSession`, `writePlan`, `writeTeamMember` MUST produce the same file content given the same input, whether or not the file already exists.
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

- **Spore files:** `spores/{normalized_type}/{observation_type}-{session_id_last_6}-{timestamp}.md` (e.g., `spores/gotcha/gotcha-ac5220-1773416089650.md`). The subdirectory name normalizes underscores to hyphens (`bug_fix` → `bug-fix/`).
- **Session files:** `sessions/{YYYY-MM-DD}/session-{session_id}.md`
- **Imports:** Use `@myco/*` path aliases mapping to `src/*`
- **Tests:** `tests/<module>.test.ts` mirroring `src/<module>.ts`

## Glossary

| Term | Definition |
|------|-----------|
| **Digest** | Continuous reasoning process that synthesizes vault knowledge into pre-computed context extracts. Runs as a daemon task on an adaptive timer. |
| **Extract** | Tiered context representation at a specific token budget (1500/3000/5000/10000). Stored in `digest_extracts` table. |
| **Substrate** | New or updated database records not yet digested. Input to a digest cycle. |
| **Trace** | Append-only audit chain of digest cycles. Stored in `agent_runs` and `agent_reports` tables. |
| **Metabolism** | Adaptive processing rate of the digest system. Active → cooling → dormant. |
| **Dormancy** | Digest timer suspended when no new substrate arrives for an extended period. |
| **Activation** | Return from dormancy to active metabolism, triggered by new session events. |
| **Spore** | Discrete observation extracted from session activity (gotcha, decision, discovery, trade-off, bug fix). Stored in `spores` table. |
| **Wisdom** | Higher-order observation synthesized from 3+ related spores. Stored as spore with `observation_type: 'wisdom'` and `properties.consolidated_from`. |
| **Lineage edge** | Automatic graph connection created by daemon on insert: FROM_SESSION, EXTRACTED_FROM, HAS_BATCH, DERIVED_FROM. No LLM needed. |
| **Semantic edge** | Intelligence graph connection created by agent: RELATES_TO, SUPERSEDED_BY, REFERENCES, DEPENDS_ON, AFFECTS. LLM-driven. |
| **Graph edge** | Stored in `graph_edges` table. Supports cross-type references between session, batch, spore, and entity nodes. |
| **Symbiont** | External coding agent that Myco integrates with (Claude Code, Cursor, Codex). Named for the mycorrhizal symbiotic relationship. Declared via YAML manifests in `src/symbionts/manifests/`. |
| **Wave** | Group of phases whose dependencies are all satisfied, executing in parallel via `Promise.allSettled()`. The executor computes waves from the phase `dependsOn` DAG using topological sort. |
| **Phase dependency** | DAG edge between phases declared via `dependsOn` in task YAML. Phases depend on named predecessors; the executor resolves these into execution waves. |

## Vault Structure

```
~/.myco/vaults/<vault-name>/
  myco.yaml          # Vault configuration
  daemon.json        # Running daemon PID/port
  index.db           # SQLite FTS5 index
  vectors.db         # sqlite-vec vector embeddings
  buffer/            # Per-session JSONL event buffers (ephemeral)
  sessions/          # Session notes by date
  spores/            # Observation notes (subdirectories by type: gotcha/, decision/, etc.)
  plans/             # Plan notes
  artifacts/         # Artifact references
  attachments/       # Images extracted from session transcripts
  team/              # Team member notes
  digest/            # Pre-computed context extracts and digest trace
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
| `make build` | Runs `check`, then `npm run build` (tsup bundle) |
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

1. Create entry point in `src/hooks/<hook-name>.ts` — keep it thin, export `main()`
2. Create entry wrapper in `src/entries/<hook-name>.ts` that imports and calls `main()`
3. Add hook name to the `HOOK_DISPATCH` map in `src/cli.ts`
4. Add the hook command to the symbiont hook templates in `src/symbionts/templates/<agent>/hooks.json` so the SymbiontInstaller writes it to the project on `myco init`
5. The hook SHOULD send events to the daemon via `DaemonClient`; only fall back to local processing if the daemon is unreachable

### Add a new daemon route

1. Add `server.registerRoute()` call in `src/daemon/main.ts`
2. Follow the pattern: validate input → process → write to vault → index → embed
3. Embedding is fire-and-forget (`.then()/.catch()`) — never block the response on embedding

### Add a new API route (dashboard)

1. Create handler in `src/daemon/api/<name>.ts` — thin handler that delegates to shared services
2. If the operation needs shared logic with the CLI, put it in `src/services/vault-ops.ts`
3. Register route in `src/daemon/main.ts` (use `server.registerRoute()` with the new `RouteRequest`/`RouteResponse` types)
4. Add tests in `tests/daemon/api/<name>.test.ts`
5. Add the UI in `ui/src/pages/` or `ui/src/components/` as needed

### Test the vault and embeddings

Use the CLI: `myco <command>` (or `myco-dev` in dogfooding mode)

- `stats` — vault health, index counts, daemon status
- `search <query>` — semantic search (primary) + FTS (fallback)
- `vectors <query>` — raw similarity scores for threshold tuning
- `rebuild` — reindex all records (FTS + vectors)
- `restart` — kill and respawn the daemon with current code

### Modify digest behavior

1. Prompt templates in `src/prompts/digest-*.md` — change what the LLM focuses on per tier
2. Substrate formatting in `src/daemon/digest.ts` `formatSubstrate()` — change how notes are presented to the LLM
3. Metabolism timing in `src/daemon/digest.ts` `Metabolism` class — change active/cooldown/dormancy intervals
4. Config in `src/config/schema.ts` `DigestSchema` — change defaults or add new options

### Restart daemon after code changes

The daemon persists across sessions. After modifying daemon code, you MUST restart it:

```sh
myco restart     # or myco-dev restart in dogfooding mode
```

Or manually: kill the PID in `~/.myco/vaults/myco/daemon.json`, then let the next session-start hook spawn a fresh one.

## Agent Teams

Use Codex agent teams for parallelizable work where teammates need to communicate with each other. See [docs/agent-teams.md](docs/agent-teams.md) for the full reference.

### When to use agent teams

- **User explicitly requests it** — always honor a direct request to create an agent team.
- **Cross-layer implementation** — changes spanning frontend, backend, and tests where each layer can be owned independently.
- **Competing hypothesis debugging** — multiple theories to investigate in parallel, especially when adversarial debate would surface the root cause faster.
- **Parallel review** — reviewing a PR or codebase from multiple lenses (security, performance, coverage) simultaneously.
- **Independent module development** — building 3+ modules with no shared files, where parallel execution saves significant time.

### When NOT to use agent teams

- **Sequential or dependent work** — tasks that must happen in order. Use a single session.
- **Same-file edits** — two teammates editing the same file causes overwrites. Use a single session or subagents.
- **Simple focused tasks** — when only the result matters and no inter-worker discussion is needed. Use subagents.
- **Token-constrained work** — each teammate is a separate Codex instance. Use subagents for lower cost.

### Rules for agent team usage

- **3-5 teammates** is the default. Scale up only when the work genuinely benefits.
- **5-6 tasks per teammate** keeps everyone productive without excessive context switching.
- **File ownership must be exclusive** — break work so each teammate owns a different set of files. Never assign two teammates to the same file.
- **Spawn prompts must include full context** — teammates do NOT inherit the lead's conversation history. Include all task-specific details in the spawn prompt.
- **Require plan approval for risky changes** — use plan mode for teammates touching critical paths (auth, data, config).
- **The lead delegates, not implements** — if the lead starts doing work itself, tell it to wait for teammates.
- **Only the lead cleans up** — teammates must not run cleanup. Shut down all teammates before the lead cleans up the team.
