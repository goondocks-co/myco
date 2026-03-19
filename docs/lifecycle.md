# Daemon Lifecycle

Myco runs a long-lived background daemon that processes session events, extracts observations, and maintains the vault index. The daemon is fully automatic — users never start, stop, or restart it manually.

## Session Flow

```mermaid
sequenceDiagram
    participant User
    participant Hook as Agent Hooks
    participant Daemon
    participant Transcript as Agent Transcript
    participant Vault
    participant LLM

    Note over Hook,Daemon: Session Start
    Hook->>Daemon: POST /sessions/register {session_id, branch}
    Daemon-->>Hook: Heuristic lineage detection
    Hook->>Daemon: POST /context {branch}
    Daemon-->>Hook: Active plans + parent session
    Hook-->>User: Context injected

    Note over Hook,Daemon: During Session
    User->>Hook: Prompt submitted
    Hook->>Daemon: POST /events {user_prompt}
    Hook->>Daemon: POST /context/prompt {prompt}
    Daemon-->>Hook: Relevant spores (vector search)
    Hook-->>User: Spores injected

    User->>Hook: Tool used
    Hook->>Daemon: POST /events {tool_use}

    Note over Hook,Daemon: Session End (async — hook returns immediately)
    Hook->>Daemon: POST /events/stop
    Daemon-->>Hook: {ok: true}
    Daemon->>LLM: Extract observations from last batch
    Daemon->>Transcript: Read agent transcript (Claude Code, Cursor)
    Note right of Transcript: Tiered: transcript → buffer fallback
    Daemon->>Vault: Write images to attachments/
    Daemon->>LLM: Summarize full conversation
    Daemon->>LLM: Classify artifacts
    Daemon->>Vault: Write session note (full rebuild from transcript)
    Daemon->>Vault: Write spore notes
    Daemon->>Vault: Write artifact notes
    Daemon->>LLM: Detect lineage (semantic similarity)
    Hook->>Daemon: POST /sessions/unregister
```

## Indexing & Embedding Pipeline

Every vault write goes through a two-stage indexing process: FTS for keyword search, vector embeddings for semantic search.

```mermaid
flowchart LR
    Write[Vault Write] --> FTS[FTS Index<br/>SQLite FTS5]
    Write --> Embed{Embedding<br/>Provider<br/>Available?}
    Embed -->|Yes| Gen[Generate<br/>Embedding]
    Embed -->|No| Skip[Skip<br/>Vector Index]
    Gen --> Vec[Vector Index<br/>sqlite-vec]

    style FTS fill:#e1f5fe
    style Vec fill:#f3e5f5
    style Skip fill:#fff3e0
```

### What Gets Indexed and Embedded

| Content | When | FTS Indexed | Embedded | Vector ID |
|---------|------|-------------|----------|-----------|
| Session notes | Stop handler | ✅ `indexAndEmbed` | ✅ fire-and-forget | `session-{id}` |
| Observations (daemon) | Stop handler | ✅ `indexAndEmbed` | ✅ fire-and-forget | `{type}-{session}-{ts}` |
| Observations (MCP `myco_remember`) | On tool call | ✅ `indexNote` | ✅ `embedNote` | `{type}-{hex}` |
| Artifacts | Stop handler | ✅ `indexAndEmbed` | ✅ fire-and-forget | `{slugified-path}` |
| Plans (file watcher) | Real-time | ✅ `indexAndEmbed` | ✅ fire-and-forget | `plan-{filename}` |
| Wisdom notes (`myco_consolidate`) | On tool call | ✅ `indexNote` | ✅ `embedNote` | `{type}-wisdom-{hex}` |
| Superseded spores | On supersede | ✅ (updated) | ❌ (embedding deleted) | — |

### Embedding is Fire-and-Forget

Embeddings are generated asynchronously and never block the response. If the embedding provider is unavailable, the note is still written and FTS-indexed — semantic search just won't find it until the next `rebuild`.

```mermaid
flowchart TD
    Stop[Stop Handler] --> Write[Write Note to Vault]
    Write --> Index[FTS Index — synchronous]
    Write --> Embed[Generate Embedding — async]
    Index --> Respond[Return Response]
    Embed -.->|fire-and-forget| Vec[Upsert Vector]
    Embed -.->|on failure| Log[Log Warning]

    style Embed stroke-dasharray: 5 5
    style Vec stroke-dasharray: 5 5
    style Log stroke-dasharray: 5 5
```

## Context Injection

Two injection points, each with a different purpose:

```mermaid
flowchart TD
    SS[SessionStart] --> Struct[Structural Context<br/>Active plans + parent session<br/>Branch name + IDs as breadcrumbs]
    UP[UserPromptSubmit] --> Sem[Semantic Context<br/>Vector search against prompt<br/>Top 3 relevant spores + IDs]

    Struct --> Agent[Agent Context Window]
    Sem --> Agent

    style SS fill:#e8f5e9
    style UP fill:#fff3e0
    style Struct fill:#e8f5e9
    style Sem fill:#fff3e0
```

**Session start** — injected once, structural framing:
- Active plans (what's in flight)
- Parent session summary (lineage continuity)
- Git branch name
- IDs as breadcrumbs for MCP tool follow-up

**Per-prompt** — injected on every prompt, targeted intelligence:
- Vector similarity search against the prompt text (~20ms, no LLM)
- Top 3 spores, filtered for superseded/archived
- Each result includes the spore ID for follow-up
- Short prompts (<10 chars) skip the search

## Daemon Startup

```mermaid
flowchart TD
    Hook[SessionStart Hook] --> Health{Daemon<br/>Healthy?}
    Health -->|Yes| Register[Register Session]
    Health -->|No| Spawn[Spawn Daemon]
    Spawn --> Wait[Wait for Health<br/>100ms → 200ms → 400ms → 800ms → 1500ms]
    Wait --> Ready{Healthy?}
    Ready -->|Yes| Register
    Ready -->|No| Degraded[Degraded Mode<br/>Local FTS only]
    Register --> Lineage[Heuristic Lineage Detection]
    Register --> Context[Inject Session Context]
```

The daemon initializes in this order:

1. Load config from `myco.yaml`
2. Create structured logger
3. Initialize LLM provider + embedding provider
4. Initialize vector index (test embedding for dimensions)
5. Initialize FTS index
6. Initialize lineage graph
7. Migrate flat spore files to type subdirectories (if needed)
8. Start plan file watcher
9. Start HTTP server
10. Write `daemon.json` with PID and port

## Shutdown

The daemon shuts itself down after a grace period with no active sessions:

```mermaid
flowchart LR
    Unreg[Last Session<br/>Unregisters] --> Grace[Grace Timer<br/>30 seconds]
    Grace --> Check{New Session<br/>Registered?}
    Check -->|Yes| Cancel[Cancel Timer]
    Check -->|No| Shutdown[Clean Shutdown]
    Shutdown --> Close[Close Indexes<br/>Stop Watchers<br/>Flush Logs]
```

The grace period prevents the daemon from cycling on/off during rapid session reloads (e.g., clearing context → new session within seconds).

## Degraded Mode

If the daemon is unreachable, hooks fall back gracefully:

| Hook | Degraded behavior |
|------|-------------------|
| `SessionStart` | Context injection via local FTS query (no semantic search) |
| `UserPromptSubmit` | Events buffered to disk (JSONL files), no context injection |
| `PostToolUse` | Events buffered to disk |
| `Stop` | Local LLM processing: session/spore writes (no embeddings, no lineage) |
| `SessionEnd` | No-op |

Buffered events are processed by the daemon when it next starts. Buffer files are cleaned up after 24 hours.

## After Plugin Updates

1. Old daemon continues running with old code until it shuts down
2. Next `SessionStart` hook spawns a new daemon from the updated `dist/` directory
3. New daemon picks up seamlessly — same vault, same indexes, same config

No manual restart needed. For development, use `make build && node dist/src/cli.js restart`.

## Configuration

```yaml
daemon:
  log_level: info          # debug | info | warn | error
  grace_period: 30         # seconds before shutdown after last session ends
  max_log_size: 5242880    # log rotation threshold (bytes)
```

## Monitoring

```bash
node dist/src/cli.js stats    # PID, port, active sessions, vault stats
node dist/src/cli.js logs     # Tail daemon + MCP activity logs
```

Or via MCP:
```json
{ "tool": "myco_logs", "level": "info", "component": "lifecycle" }
```

## Files

| File | Purpose |
|------|---------|
| `daemon.json` | Running daemon PID and port |
| `index.db` | SQLite FTS5 full-text search index |
| `vectors.db` | sqlite-vec vector embedding index |
| `lineage.json` | Session parent-child relationship graph |
| `logs/daemon.log` | Daemon structured logs (JSONL) |
| `logs/mcp.jsonl` | MCP tool activity log |
| `buffer/*.jsonl` | Per-session event buffers (ephemeral) |
| `attachments/*.png` | Images extracted from session transcripts (Obsidian embeds) |

## Transcript Sourcing

Session conversation turns are built from the agent's native transcript file — not from Myco's event buffer. The buffer only captures what hooks send (user prompts, tool uses) and has no AI responses.

The agent adapter registry (`src/agents/`) tries each adapter in priority order:

| Agent | Transcript Location | Format |
|-------|-------------------|--------|
| Claude Code | `~/.claude/projects/<project>/<session>.jsonl` | JSONL (`type` field) |
| Cursor (newer) | `~/.cursor/projects/<project>/agent-transcripts/<session>/<session>.jsonl` | JSONL (`role` field) |
| Cursor (older) | `~/.cursor/projects/<project>/agent-transcripts/<session>.txt` | Plain text (`user:`/`assistant:` markers) |
| Buffer fallback | `buffer/<session>.jsonl` | Myco's own event buffer (no AI responses) |

Images in transcripts are decoded and saved to `attachments/` as `{session-id}-t{turn}-{index}.{ext}`, then embedded in the session note with `![[filename]]`.
