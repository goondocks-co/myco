# Daemon Lifecycle

Myco runs a long-lived background daemon that processes session events, runs intelligence tasks, maintains the search index, and continuously synthesizes knowledge into digest extracts. The daemon is fully automatic — users never start, stop, or restart it manually.

## Session Flow

```mermaid
sequenceDiagram
    participant User
    participant Hook as Agent Hooks
    participant Daemon
    participant Transcript as Agent Transcript
    participant DB as SQLite
    participant LLM

    Note over Hook,Daemon: Session Start
    Hook->>Daemon: POST /sessions/register {session_id, branch}
    Daemon->>DB: Upsert session (status=active)
    Hook->>Daemon: POST /context {branch}
    Daemon-->>Hook: Digest extract (or layer-based fallback)
    Hook-->>User: Context injected

    Note over Hook,Daemon: During Session
    User->>Hook: Prompt submitted
    Hook->>Daemon: POST /events {user_prompt}
    Daemon->>DB: Close open batch, create new batch
    Hook->>Daemon: POST /context/prompt {prompt}
    Daemon-->>Hook: Relevant spores (vector search)
    Hook-->>User: Spores injected

    User->>Hook: Tool used
    Hook->>Daemon: POST /events {tool_use}
    Daemon->>DB: Insert activity

    Note over Hook,Daemon: Per-Turn Stop (async)
    Hook->>Daemon: POST /events/stop
    Daemon-->>Hook: {ok: true}
    Daemon->>Transcript: Parse transcript (tool_count)
    Daemon->>DB: Update session stats

    Note over Hook,Daemon: Session End
    Hook->>Daemon: POST /sessions/unregister
    Daemon->>DB: Close session (set ended_at)
    Daemon->>LLM: Fire-and-forget title/summary task
```

### Event Types

| Event | Hook | What happens |
|-------|------|-------------|
| `user_prompt` | UserPromptSubmit | Close open batch, create new batch in DB |
| `tool_use` | PostToolUse | Insert activity, increment batch activity_count |
| `tool_failure` | PostToolUseFailure | Insert activity with success=0 |
| `subagent_start` | SubagentStart | Record as activity |
| `subagent_stop` | SubagentStop | Record as activity |
| `pre_compact` | PreCompact | Record compaction event |
| `post_compact` | PostCompact | Record compaction event |
| `task_completed` | TaskCompleted | Record as activity |

### Batch Summary Triggers

Summaries are event-driven, triggered on configurable intervals:
- Every N batches (configurable via `agent.summary_batch_interval`, default 5)
- On session stop: fire-and-forget title-summary agent task
- Setting `summary_batch_interval: 0` disables interval-based triggers

## Intelligence Agent

The intelligence agent runs inside the daemon, processing captured data through configurable task phases. Tasks are defined as YAML files with a dependency graph of phases.

### Task Execution Model

```mermaid
flowchart TD
    Trigger[Agent Trigger] --> Load[Load Task Definition]
    Load --> Orchestrator{Orchestrator<br/>Enabled?}
    Orchestrator -->|Yes| Plan[Generate Plan<br/>SDK query]
    Orchestrator -->|No| Waves
    Plan --> Waves[Compute Waves<br/>Kahn's Algorithm]
    Waves --> W1[Wave 1<br/>read-state]
    W1 --> W2[Wave 2<br/>extract + summarize]
    W2 --> W3[Wave 3<br/>consolidate + graph]
    W3 --> W4[Wave 4<br/>digest]
    W4 --> W5[Wave 5<br/>report]

    style Trigger fill:#e8f5e9
    style Waves fill:#e1f5fe
```

Phases in the same wave run in parallel via `Promise.allSettled()`. Each phase gets:
- Scoped tools (only the tools listed in `phase.tools[]`)
- A turn budget (`phase.maxTurns`)
- Isolated provider environment (via SDK `env` option)
- Results from prior phases as context

### Provider Config Resolution

```
Agent definition (YAML)
  ↓ overridden by
Database agent row
  ↓ overridden by
Task YAML (built-in or user)
  ↓ overridden by
myco.yaml global (agent.provider / agent.model)
  ↓ overridden by
myco.yaml per-task (agent.tasks.<name>.provider)
  ↓ overridden by
myco.yaml per-phase (agent.tasks.<name>.phases.<phase>.provider)
```

### Built-in Tasks

| Task | Phases | Description |
|------|--------|-------------|
| `full-intelligence` | read-state → extract + summarize → consolidate + graph → digest → report | Complete pipeline |
| `title-summary` | Single phase | Generate/update session titles and summaries |
| `extract-only` | read-state → extract | Observation extraction only |
| `review-session` | Single phase | Deep review of a specific session |
| `supersession-sweep` | Single phase | Find and supersede stale spores |
| `digest-only` | Single phase | Regenerate digest extracts |
| `graph-maintenance` | Single phase | Entity and edge maintenance |

### Consolidation

When the intelligence agent finds 3+ semantically similar spores, it synthesizes them into a **wisdom** spore:

1. Wisdom spore created with `observation_type: 'wisdom'` and `properties.consolidated_from`
2. `DERIVED_FROM` graph edges auto-created from wisdom to each source
3. Source spores resolved with action `consolidate` (status → 'consolidated')
4. Consolidated spores excluded from future consolidation

## Digest System

The digest engine synthesizes accumulated knowledge into tiered context extracts. These pre-computed summaries are served instantly at session start.

```mermaid
flowchart TD
    Timer[Metabolism Timer] --> Check{New<br/>Substrate?}
    Check -->|Yes| Tiers[Generate Extracts<br/>Sequential: 1500 → 3000 → 5000 → 10000]
    Check -->|No| Backoff[Metabolic Slowdown<br/>15m → 30m → 1h → dormancy]
    Tiers --> Store[Store in digest_extracts<br/>table]
    Store --> Reset[Reset to Active Metabolism]

    Session[New Session Registered] --> Activate[Activate Metabolism]
    Activate --> Timer

    style Timer fill:#e8f5e9
    style Backoff fill:#fff3e0
    style Tiers fill:#e1f5fe
```

### Metabolism States

| State | Interval | Trigger |
|-------|----------|---------|
| **Active** | 5 minutes | Substrate found, or session registered |
| **Cooling** | 15m → 30m → 1h | Empty cycles (no new substrate) |
| **Dormant** | Suspended | No substrate for 2+ hours |

### Tiered Extracts

| Tier | Character | Use Case |
|------|-----------|----------|
| **1,500** | Executive briefing | Quick orientation — what is this, what's active, what to avoid |
| **3,000** | Team standup | Enough to start contributing — decisions, plans, conventions |
| **5,000** | Deep onboarding | Full context — trade-offs, patterns, team dynamics |
| **10,000** | Institutional knowledge | Everything — thread history, design tensions, lessons learned |

## Graph Architecture

The knowledge graph uses a two-layer model stored in the `graph_edges` table:

**Lineage layer** (automatic, no LLM):
- `FROM_SESSION` — spore → session (created on spore insert)
- `EXTRACTED_FROM` — spore → batch (created on spore insert)
- `HAS_BATCH` — session → batch (created on batch insert)
- `DERIVED_FROM` — wisdom spore → source spore (created on consolidation)

**Intelligence layer** (agent-created, LLM-driven):
- `RELATES_TO` — semantic relationship between spores or entities
- `SUPERSEDED_BY` — newer observation replaces older one
- `REFERENCES` — spore references an entity
- `DEPENDS_ON` — architectural dependency between entities
- `AFFECTS` — observation impacts a component

Node types: `session`, `batch`, `spore`, `entity`.

### Entity Types

Three types:
- **component** — module, class, service, or significant function
- **concept** — architectural pattern or domain concept spanning 2+ sessions
- **person** — contributor or team member

Entities are created only when referenced by 3+ spores from 2+ sessions.

## Indexing & Embedding

Every database write can trigger a two-stage indexing process: FTS for keyword search, vector embeddings for semantic search.

```mermaid
flowchart LR
    Write[DB Write] --> FTS[FTS Index<br/>SQLite FTS5]
    Write --> Embed{Embedding<br/>Provider<br/>Available?}
    Embed -->|Yes| Gen[Generate<br/>Embedding]
    Embed -->|No| Skip[Skip<br/>Vector Index]
    Gen --> Vec[Vector Index<br/>sqlite-vec]

    style FTS fill:#e1f5fe
    style Vec fill:#f3e5f5
    style Skip fill:#fff3e0
```

### What Gets Indexed

| Content | When | Embedded |
|---------|------|----------|
| Sessions | On close | Yes (fire-and-forget) |
| Prompt batches | On close | FTS only |
| Spores | On insert | Yes (fire-and-forget) |
| Plans | On capture | Yes (fire-and-forget) |
| Artifacts | On capture | Yes (fire-and-forget) |

### Embedding Reconciliation

The `EmbeddingManager` runs periodic reconciliation via the PowerManager:
- **Embed missing** — find rows with `embedded=0`, generate and store vectors
- **Clean orphans** — remove vectors for deleted records
- **Reembed stale** — re-embed vectors from a previous model after provider change

Embeddings are always fire-and-forget — they never block the response. If providers are unavailable, records are still written and FTS-indexed. Semantic search degrades gracefully.

## Context Injection

Two injection points, each with a different purpose:

```mermaid
flowchart TD
    SS[SessionStart] --> Struct[Digest Extract<br/>Pre-computed project understanding<br/>or layer-based fallback]
    UP[UserPromptSubmit] --> Sem[Semantic Context<br/>Vector search against prompt<br/>Top 3 relevant spores]

    Struct --> Agent[Agent Context Window]
    Sem --> Agent

    style SS fill:#e8f5e9
    style UP fill:#fff3e0
```

**Session start** — injected once, project understanding:
- Digest extract at the configured tier (when extracts exist)
- Fallback layers: active plans, recent sessions, relevant spores, team activity
- Total budget: ~1200 tokens
- Session ID and branch name always appended

**Per-prompt** — injected on every prompt, targeted intelligence:
- Vector similarity search against the prompt text
- Top 3 spores, filtered for superseded/archived
- Each result includes the spore ID for follow-up
- Short prompts (<10 chars) skip the search

## Power Management

The daemon adapts its background work rate based on activity:

```mermaid
flowchart LR
    Active[Active<br/>5s intervals] -->|10s idle| Idle[Idle<br/>30s intervals]
    Idle -->|60s idle| Sleep[Sleep<br/>5m intervals]
    Sleep -->|600s idle| Deep[Deep Sleep<br/>timer stopped]
    Deep -->|any request| Active
    Sleep -->|any request| Active
    Idle -->|any request| Active
```

| State | Job interval | Trigger to wake |
|-------|-------------|-----------------|
| **active** | 5 seconds | Any HTTP request |
| **idle** | 30 seconds | Any HTTP request |
| **sleep** | 5 minutes | Any HTTP request |
| **deep_sleep** | Stopped | Any HTTP request |

### Registered Jobs

| Job | States | Purpose |
|-----|--------|---------|
| `embedding-reconcile` | active, idle | Batch embed missing rows, clean orphans |
| `session-maintenance` | active, idle, sleep | Complete stale sessions, delete dead ones |
| `agent-auto-run` | active, idle | Run intelligence agent on unprocessed batches |

## Daemon Startup

```mermaid
flowchart TD
    Hook[SessionStart Hook] --> Health{Daemon<br/>Healthy?}
    Health -->|Yes| Register[Register Session]
    Health -->|No| Spawn[Spawn Daemon]
    Spawn --> Wait[Wait for Health<br/>100ms → 200ms → 400ms → 800ms → 1500ms]
    Wait --> Ready{Healthy?}
    Ready -->|Yes| Register
    Ready -->|No| Degraded[Degraded Mode<br/>Buffer to disk]
    Register --> Context[Inject Session Context]
```

The daemon initializes in this order:

1. Kill stale daemon (check `daemon.json` PID)
2. Load secrets from `secrets.env`
3. Load config from `myco.yaml`
4. Initialize SQLite database + schema (idempotent)
5. Initialize embedding system (vector store, provider, record source, manager)
6. Register built-in agents and tasks from YAML definitions
7. Clean stale agent runs (crash recovery)
8. Resolve UI directory (`dist/ui/`)
9. Create PowerManager (state machine for background jobs)
10. Create HTTP server
11. Create SessionRegistry
12. Create TranscriptMiner
13. Clean stale event buffers (>24h)
14. Reconcile buffered events from downtime
15. Register ~40+ API routes
16. Start server (evict existing daemon, resolve port)
17. Register power jobs (embedding, session maintenance, agent auto-run)
18. Start PowerManager tick loop
19. Write `daemon.json` with PID and port

## Shutdown

The daemon shuts itself down after a grace period with no active sessions:

```mermaid
flowchart LR
    Unreg[Last Session<br/>Unregisters] --> Grace[Grace Timer<br/>30 seconds]
    Grace --> Check{New Session<br/>Registered?}
    Check -->|Yes| Cancel[Cancel Timer]
    Check -->|No| Shutdown[Clean Shutdown]
    Shutdown --> Close[Close DB<br/>Stop PowerManager<br/>Flush Logs]
```

## Degraded Mode

If the daemon is unreachable, hooks fall back gracefully:

| Hook | Degraded behavior |
|------|-------------------|
| `SessionStart` | Context injection via local DB query (no digest, no semantic search) |
| `UserPromptSubmit` | Events buffered to disk (JSONL files), no context injection |
| `PostToolUse` | Events buffered to disk |
| `Stop` | Buffered to disk, processed when daemon returns |
| `SessionEnd` | No-op |

Buffered events are reconciled by the daemon when it next starts. Buffer files are cleaned up after 24 hours.

## After Plugin Updates

1. Old daemon continues running with old code until it shuts down
2. Next `SessionStart` hook spawns a new daemon from the updated `dist/` directory
3. New daemon picks up seamlessly — same database, same indexes, same config

No manual restart needed. For development, use `make build && myco-dev restart`.

## Configuration

```yaml
version: 3
embedding:
  provider: ollama              # ollama | openai-compatible | openrouter | openai
  model: bge-m3                 # embedding model name
  base_url: http://...          # optional, for custom endpoints
daemon:
  port: null                    # null = auto-assign, persisted once resolved
  log_level: info               # debug | info | warn | error
capture:
  transcript_paths: []          # additional transcript search paths
  artifact_watch:               # directories to watch for plan files
    - .claude/plans/
    - .cursor/plans/
  artifact_extensions: [.md]
  buffer_max_events: 500
agent:
  auto_run: true                # daemon auto-triggers on unprocessed batches
  interval_seconds: 300         # seconds between auto-run checks
  summary_batch_interval: 5     # batches between title/summary triggers (0 = disable)
  provider:                     # global default provider
    type: cloud                 # cloud | ollama | lmstudio
    model: claude-sonnet-4-6    # optional model override
    context_length: 8192        # optional, for local models
  tasks:                        # per-task overrides
    title-summary:
      provider:
        type: ollama
        model: granite4:small-h
```

## Monitoring

```bash
myco stats          # PID, port, active sessions, database stats
myco doctor         # Health check: vault, DB, providers, agents, daemon
myco doctor --fix   # Auto-repair fixable issues
myco logs           # Tail daemon logs
```

## Database

All data lives in SQLite:

| Database | Contents |
|----------|----------|
| `myco.db` | Sessions, batches, activities, spores, entities, graph edges, agent runs/reports/turns, digest extracts, plans, artifacts, team, FTS indexes |
| `vectors.db` | sqlite-vec vector embeddings (1024-dim for bge-m3) |

Supporting files:

| File | Purpose |
|------|---------|
| `myco.yaml` | Vault configuration |
| `daemon.json` | Running daemon PID and port |
| `secrets.env` | API keys for cloud providers (gitignored) |
| `buffer/*.jsonl` | Per-session event buffers (ephemeral) |
| `attachments/*.png` | Images extracted from session transcripts |
| `logs/daemon.log` | Daemon structured logs (JSONL) |
| `tasks/*.yaml` | User-created agent task definitions |

## Transcript Sourcing

Session conversation turns are built from the agent's native transcript file — not from Myco's event buffer. The buffer only captures what hooks send (user prompts, tool uses) and has no AI responses.

The symbiont adapter registry tries each adapter in priority order:

| Agent | Transcript Location | Format |
|-------|-------------------|--------|
| Claude Code | `~/.claude/projects/<project>/<session>.jsonl` | JSONL (`type` field) |
| Cursor (newer) | `~/.cursor/projects/<project>/agent-transcripts/<session>/<session>.jsonl` | JSONL (`role` field) |
| Cursor (older) | `~/.cursor/projects/<project>/agent-transcripts/<session>.txt` | Plain text (`user:`/`assistant:` markers) |
| Buffer fallback | `buffer/<session>.jsonl` | Myco's own event buffer (no AI responses) |

Images in transcripts are decoded and saved to `attachments/` as `{session-id}-t{turn}-{index}.{ext}`.
