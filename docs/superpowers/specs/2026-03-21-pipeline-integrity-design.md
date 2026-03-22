# Pipeline Integrity System ("Mycelium")

## Problem

LLM and embedding failures in Myco are silent. When a provider is unavailable, misconfigured, or overloaded:

1. **Downstream stages process incomplete data** — digest synthesizes substrate that was never fully extracted or embedded, producing low-quality or incorrect context extracts.
2. **Recovery is manual** — the user must discover failures through symptoms (missing observations, bad digests) and manually run `reprocess`, `rebuild`, or `digest --full`.
3. **No visibility** — there is no way to see what's queued, what failed, why it failed, or whether the system is healthy.
4. **Bad data compounds** — partially-processed sessions lead to incomplete spores, which lead to wrong consolidation, which leads to incorrect digests injected into every prompt.

Concrete example: the LM Studio provider was loading duplicate model instances on every digest cycle due to strict config matching on `offload_kv_cache_to_gpu` (a field absent on non-llama.cpp models). This exhausted system resources, causing all subsequent LLM calls to fail — but the daemon continued attempting downstream processing, producing degraded session notes and skipping digest tiers without surfacing the root cause.

## Solution

A dedicated `pipeline.db` (SQLite) tracks every piece of content through fixed processing stages. Failures halt downstream processing, transient errors retry automatically, configuration errors open circuit breakers and surface to the user. The vault markdown remains the source of truth — `pipeline.db` is disposable and rebuildable.

## Design Principles

- **Halt downstream on upstream failure.** A work item cannot advance to the next stage until the current stage succeeds. No more processing incomplete data.
- **Self-heal when possible.** Transient failures (timeouts, temporary unavailability) retry automatically with backoff. The user never needs to know unless retries exhaust.
- **Surface what can't self-heal.** Configuration errors (model not loaded, resource exhaustion, auth failure) open a circuit breaker, block all pending work, and alert the user with a specific suggested action.
- **Vault is source of truth.** `pipeline.db` is a derived view of processing state. It can be deleted and rebuilt by walking the vault and inferring what's been done from what exists.
- **Capture never stops.** Even when the pipeline is blocked, session events continue to be buffered and transcripts continue to be written. When the blockage clears, the backlog drains automatically.

## Pipeline Stages

```
┌──────────┐    ┌─────────────┐    ┌───────────┐    ┌───────────────┐    ┌────────┐
│ CAPTURE  │───▶│ EXTRACTION  │───▶│ EMBEDDING │───▶│ CONSOLIDATION │───▶│ DIGEST │
└──────────┘    └─────────────┘    └───────────┘    └───────────────┘    └────────┘
```

### Stage Definitions

| Stage | What Happens | Depends On |
|-------|-------------|------------|
| **Capture** | Events buffered, transcript written, vault note created | Nothing (always succeeds if daemon is running) |
| **Extraction** | LLM extracts observations, generates summary + title, classifies artifacts | Capture |
| **Embedding** | Content embedded into vectors.db for semantic search | Extraction |
| **Consolidation** | Supersession detection + wisdom synthesis for spores | Embedding |
| **Digest** | Vault notes included as substrate in digest cycle | Consolidation (for spores), Embedding (for sessions/artifacts) |

### Work Item Types

| Work Item | Capture | Extraction | Embedding | Consolidation | Digest |
|-----------|---------|------------|-----------|---------------|--------|
| Session | Buffer events, write transcript | Observations + Summary + Title | Session narrative + each observation | Per-observation spore clustering | Substrate |
| Spore | Written to vault | Skipped (already extracted) | Spore content | Cluster evaluation (supersession + wisdom) | Substrate |
| Artifact | Classified at capture | Skipped (already classified) | Artifact content (new capability) | Skipped | Substrate |

### Stage Statuses

| Status | Meaning |
|--------|---------|
| `pending` | Queued, not yet attempted |
| `processing` | Actively being worked on |
| `succeeded` | Completed successfully |
| `failed` | Failed, eligible for retry |
| `blocked` | Upstream stage failed or circuit breaker open |
| `skipped` | Stage does not apply to this work item type |
| `poisoned` | Retry limit exhausted, needs human intervention |

### Partial Success Semantics

Session extraction involves multiple LLM calls (observations, summary, title, artifact classification). **Extraction is all-or-nothing**: if any sub-call fails, the entire extraction stage is marked `failed` and all outputs from that attempt are discarded. This prevents partially-extracted sessions from advancing to embedding with incomplete data.

On retry, all sub-calls run again from scratch. The transcript is the source of truth — re-extraction is deterministic in terms of input, even if LLM output varies.

Rationale: partial success creates ambiguity about what was extracted and what wasn't, making downstream stages unreliable. All-or-nothing is simpler to reason about and the retry cost is acceptable (extraction is a single session's worth of data).

## Provider Instance Mapping

The codebase uses up to three distinct provider instances. Circuit breakers are keyed by **provider instance role**, not provider type, because the same provider type (e.g., ollama) could back multiple roles with different models.

| Provider Role | Stages Using It | Config Source |
|--------------|----------------|---------------|
| `llm` | Extraction (observations, summary, title, classification), Lineage | `intelligence.llm.*` |
| `embedding` | Embedding | `intelligence.embedding.*` |
| `digest-llm` | Digest, Consolidation (supersession + wisdom) | `digest.intelligence.*` (falls back to `llm` if not configured) |

Circuit breaker keys: `llm`, `embedding`, `digest-llm`.

A failure in the `embedding` provider opens the `embedding` circuit, blocking the embedding stage. The `llm` circuit remains closed — extraction continues normally. Conversely, a `digest-llm` failure blocks digest and consolidation but doesn't affect extraction or embedding.

When `digest.intelligence.provider` is null (inheriting from main `llm`), the `digest-llm` circuit maps to the same physical provider but is tracked independently. This allows the digest to fail (e.g., due to context window limits) without blocking extraction.

## SQLite Schema

### Tables

```sql
-- Every piece of content that enters the pipeline
CREATE TABLE work_items (
  id            TEXT NOT NULL,
  item_type     TEXT NOT NULL,        -- 'session' | 'spore' | 'artifact'
  source_path   TEXT,                 -- vault file path (for rebuild-from-markdown)
  created_at    TEXT NOT NULL,        -- ISO timestamp
  updated_at    TEXT NOT NULL,        -- last stage transition
  PRIMARY KEY (id, item_type)         -- composite key prevents cross-type collisions
);

-- Stage progression for each work item (append-only)
CREATE TABLE stage_transitions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  work_item_id  TEXT NOT NULL,
  item_type     TEXT NOT NULL,
  stage         TEXT NOT NULL,        -- 'capture' | 'extraction' | 'embedding' | 'consolidation' | 'digest'
  status        TEXT NOT NULL,        -- 'pending' | 'processing' | 'succeeded' | 'failed' | 'blocked' | 'skipped' | 'poisoned'
  attempt       INTEGER DEFAULT 1,   -- retry count for this stage
  error_type    TEXT,                 -- 'transient' | 'config' | 'parse' | null on success
  error_message TEXT,                 -- human-readable error detail
  started_at    TEXT,                 -- when processing began
  completed_at  TEXT,                 -- when status became terminal
  created_at    TEXT NOT NULL,        -- when this transition was recorded
  FOREIGN KEY (work_item_id, item_type) REFERENCES work_items(id, item_type)
);

-- Compacted history for transitions older than retention window
CREATE TABLE stage_history (
  work_item_id  TEXT NOT NULL,
  item_type     TEXT NOT NULL,
  stage         TEXT NOT NULL,
  total_attempts INTEGER,
  final_status  TEXT NOT NULL,
  first_attempt TEXT NOT NULL,        -- ISO timestamp
  last_attempt  TEXT NOT NULL,        -- ISO timestamp
  last_error    TEXT,                 -- final error message preserved
  error_types   TEXT,                 -- JSON: {"transient": 2, "parse": 1} for debugging patterns
  PRIMARY KEY (work_item_id, item_type, stage)
);

-- Circuit breaker state per provider role
CREATE TABLE circuit_breakers (
  provider_role TEXT PRIMARY KEY,     -- 'llm' | 'embedding' | 'digest-llm'
  state         TEXT NOT NULL,        -- 'closed' | 'open' | 'half-open'
  failure_count INTEGER DEFAULT 0,
  last_failure  TEXT,                 -- ISO timestamp
  last_error    TEXT,                 -- most recent error message
  opens_at      TEXT,                 -- when half-open probe is allowed
  updated_at    TEXT NOT NULL
);

-- Current state view (latest transition per work item per stage)
CREATE VIEW pipeline_status AS
WITH ranked AS (
  SELECT
    st.*,
    ROW_NUMBER() OVER (
      PARTITION BY st.work_item_id, st.item_type, st.stage
      ORDER BY st.id DESC
    ) AS rn
  FROM stage_transitions st
)
SELECT
  wi.id,
  wi.item_type,
  wi.source_path,
  r.stage,
  r.status,
  r.attempt,
  r.error_type,
  r.error_message,
  r.started_at,
  r.completed_at
FROM work_items wi
JOIN ranked r ON r.work_item_id = wi.id AND r.item_type = wi.item_type
WHERE r.rn = 1;

CREATE INDEX idx_transitions_item_stage ON stage_transitions(work_item_id, item_type, stage);
CREATE INDEX idx_transitions_status ON stage_transitions(status);
CREATE INDEX idx_items_type ON work_items(item_type);
```

### Design Decisions

- **Composite primary key**: `(id, item_type)` on `work_items` prevents collisions between different item types that might share slugified IDs.
- **Append-only transitions**: Every status change is a new row in `stage_transitions`. This provides full audit trail and retry history without mutation.
- **Window function view**: `pipeline_status` uses `ROW_NUMBER()` partitioned by (work_item, stage) for reliable latest-transition retrieval.
- **30-day rolling compaction**: Transitions older than the retention window (configurable, default 30 days) are collapsed into one `stage_history` row per work_item/stage, then deleted. Compaction runs on daemon startup or daily timer. Keeps table bounded at ~10K rows. The `error_types` JSON field preserves failure pattern distribution for debugging recurring issues.
- **Separate from index.db**: Pipeline state is a distinct concern from search indexing. Clean separation means either can be rebuilt independently.

## Retry Logic

### Policy by Error Type

| Error Type | Max Retries | Backoff | Behavior |
|-----------|-------------|---------|----------|
| `transient` | 3 | Exponential: `base × 4^attempt` (30s → 2m → 8m) | Retry on next pipeline tick after backoff elapses |
| `config` | 0 | None | Open circuit breaker, block all pending, surface to user |
| `parse` | 1 | Next pipeline tick | One retry (LLM non-determinism), then poison |

### Error Classification

Single classification function applied to every LLM/embedding failure:

**Config errors** (stop immediately, open circuit):

| Signal | Detection |
|--------|-----------|
| Model not loaded | HTTP 404 + body contains "model" or "not found" |
| Resource exhaustion | HTTP 500 + "insufficient resources" or "model_load_failed" |
| Auth failure | HTTP 401 or 403 |
| Provider not running | ECONNREFUSED |
| Invalid API key | HTTP 401 + "api_key" or "unauthorized" |
| Model incompatible | HTTP 400 + "unsupported" or "not compatible" |
| Configured host unreachable | ENOTFOUND for the configured `base_url` hostname |

**Transient errors** (retry with backoff):

| Signal | Detection |
|--------|-----------|
| Timeout | AbortError, ETIMEDOUT |
| Server overloaded | HTTP 429, HTTP 503 |
| Connection reset | ECONNRESET, "socket hang up" |
| Generic server error | HTTP 500 without config-specific keywords |
| Well-known host DNS failure | ENOTFOUND for known hostnames (api.anthropic.com, etc.) |

Note on DNS: `ENOTFOUND` for a configured `base_url` (e.g., `localhost`, a custom hostname) is a config error — retrying won't help. `ENOTFOUND` for a well-known API hostname (e.g., `api.anthropic.com`) is likely a transient network issue.

**Parse errors** (retry once, then poison):

| Signal | Detection |
|--------|-----------|
| Invalid JSON | JSON.parse throws on response body |
| Missing fields | Schema validation fails (no `output`, no `content`) |
| Empty content | LLM returned blank or whitespace-only |
| Only reasoning tokens | After stripping `<think>` tags, nothing remains |

### Suggested Actions (surfaced in UI)

| Error | User-Facing Message |
|-------|-------------------|
| Model not loaded | "Load {model} in LM Studio, or change the model in Configuration" |
| Resource exhaustion | "Not enough resources to load {model}. Free memory or choose a smaller model" |
| Provider unreachable | "Cannot connect to {provider} at {url}. Check that it's running" |
| Host not found | "Cannot resolve {hostname}. Check the base_url in Configuration" |
| Auth failure | "Invalid API key for {provider}. Update in Configuration" |
| Parse failure (poisoned) | "LLM returned invalid output for {item}. Try a different model or manually reprocess" |

## Circuit Breakers

### State Machine

```
CLOSED ──(3 consecutive failures)──▶ OPEN ──(cooldown expires)──▶ HALF-OPEN
   ▲                                                                  │
   │                                                                  │
   └──────────────(probe succeeds)────────────────────────────────────┘
                                                                      │
                                              (probe fails)───▶ OPEN (reset cooldown)
```

- **Closed**: Normal operation. Failures increment counter. 3 consecutive failures of the same error type → open.
- **Open**: All new work items for this provider role get status `blocked`. Cooldown starts at 5 minutes.
- **Half-open**: After cooldown, one probe request allowed. Success → closed, all `blocked` items move to `pending`. Failure → back to open, cooldown doubles (5m → 10m → 20m, max 1 hour).
- **Manual reset**: User can close the circuit via the Mycelium UI after fixing the underlying issue. All `blocked` items move to `pending`.

### Downstream Blocking

When a circuit opens, all work items with `pending` status at stages that use the failed provider role get marked `blocked`. When the circuit closes (automatically or manually), they move back to `pending` and process on the next pipeline tick.

## Backlog Processing

Sessions continue capturing during outages. When a circuit closes:

1. All `blocked` items move to `pending`
2. Processing resumes in **chronological order** (oldest first) — ensures digest builds on complete history
3. **Priority ordering**: current session stops > backlog items > consolidation/digest
4. **Batch size limit**: 5 items per tick during backlog drain — prevents monopolizing the LLM provider
5. **Digest waits**: digest stage only runs when all upstream stages have cleared their pending/failed items

## Daemon Integration

### Architectural Changes

This design introduces two significant architectural shifts:

**1. Event-driven → pipeline-driven processing.**

Today, session stop events trigger all LLM processing inline (extract → embed → supersede). After this change, stop events only register work items and advance capture to `succeeded`. All LLM work is processed by the pipeline on its own tick.

**2. Consolidation becomes a standalone pipeline stage.**

Today, consolidation runs as a digest pre-pass hook via `digestEngine.registerPrePass()`. After this change, consolidation is an independent pipeline stage between embedding and digest. It processes spores through the pipeline like any other stage, no longer coupled to digest timing. The digest engine's pre-pass hook mechanism remains for any future non-pipeline hooks, but consolidation is removed from it.

### Processing Timer

The pipeline runs on its own timer, separate from the digest metabolism timer:

- **Pipeline tick interval**: 30 seconds (configurable). Fast enough for near-real-time processing of new sessions, slow enough to batch efficiently.
- **Metabolism timer**: Unchanged. Still drives digest cadence (active → cooldown → dormant). The digest stage in the pipeline only runs when the metabolism timer fires AND all upstream stages are clear.
- **Tick serialization**: Pipeline ticks are serialized — if a tick is still processing when the next interval fires, it is skipped. Prevents double-processing of the same pending items. Same pattern as `cycleInProgress` in the existing digest engine.

### Startup Recovery

On daemon startup, all work items in `processing` status are moved to `pending`. This handles the case where the daemon crashed mid-processing — items won't get stuck in `processing` forever.

### Embedding Latency Trade-off

Today, embeddings fire inline (best-effort) so spores are immediately searchable. Under the pipeline model, newly extracted spores wait for the next pipeline tick to be embedded — a latency gap of up to 30 seconds.

This is an acceptable trade-off: reliability and tracking are more valuable than sub-second embedding latency. The 30-second tick interval keeps the gap small. If a search misses a just-extracted spore, the next search will find it.

### New Module: `src/daemon/pipeline.ts`

```
PipelineManager
  ├── register(itemId, type, sourcePath)     — create work item, set initial stages
  ├── advance(itemId, stage, status, error?) — record stage transition
  ├── nextBatch(stage, limit)                — get pending items ready for processing
  ├── circuitState(providerRole)             — check circuit breaker state
  ├── tripCircuit(providerRole, error)       — open circuit breaker
  ├── probeCircuit(providerRole)             — half-open test
  ├── compact()                              — 30-day transition compaction
  ├── recoverStuck()                         — move processing → pending on startup
  └── health()                               — aggregate status for dashboard/API
```

### How Existing Code Changes

| Component | Today | After |
|-----------|-------|-------|
| Session stop (`main.ts`) | Calls processor → writes session → embeds → supersedes inline | `pipeline.register()` → capture:succeeded. Pipeline processes remaining stages on tick. |
| BufferProcessor (`processor.ts`) | Fire-and-forget, returns degraded flag | Called BY pipeline for extraction stage. Success/failure tracked. All-or-nothing. |
| Embedding calls (scattered) | Fire-and-forget `.then()/.catch()` | Pipeline embedding stage. Only attempted when extraction succeeded. Tracked. |
| Consolidation (`consolidation.ts`) | Digest pre-pass hook, best-effort | Independent pipeline stage. Removed from digest pre-pass. Only runs when embedding succeeded. |
| Digest (`digest.ts`) | Discovers substrate by timestamp, runs pre-pass hooks | Only includes work items where all upstream stages succeeded. No more pre-pass consolidation. |

### What This Replaces

- `BatchManager` batching/closure pattern → pipeline stages
- Fire-and-forget embedding calls → tracked pipeline stage
- `SUMMARIZATION_FAILED_MARKER` hack → `failed` status in pipeline
- Manual `reprocess` for most failures → automatic retry with backoff
- `digest --full` for missed substrate → pipeline ensures nothing missed
- Consolidation as digest pre-pass → independent pipeline stage

### What Stays the Same

- Vault writes (session notes, spores, extracts) — unchanged
- Transcript as source of truth — unchanged
- Buffer system — unchanged (pipeline reads from it, doesn't replace it)
- MCP tools — unchanged (they read vault, not pipeline)
- Vault structure — unchanged

### Processing Loop

On each pipeline tick (30-second interval, serialized):

```
1. Check circuit breakers — skip stages with open circuits
2. Process pending extraction items (batch, concurrency-limited)
3. Process pending embedding items
4. Process pending consolidation items
5. If metabolism timer has fired AND all upstream stages clear:
   → Run digest cycle
6. Compact old transitions if needed (daily)
```

### CLI Command Integration

Existing CLI commands continue to work but route through the pipeline:

| Command | Today | After |
|---------|-------|-------|
| `reprocess` | Directly calls processor, writes results | Registers work items as `pending` at extraction stage. Pipeline processes them. |
| `rebuild` | Re-indexes all vault notes (FTS + vectors) | Unchanged — FTS reindex is orthogonal to pipeline. Vector rebuild registers items at embedding stage. |
| `digest` | Runs digest cycle directly | Registers all substrate as `pending` at digest stage. Pipeline processes on next tick. |
| `digest --full` | Wipes extracts, reprocesses all tiers | Resets all work items to `pending` at digest stage. Pipeline reprocesses. |
| `curate` | Runs curation directly | Registers spores at consolidation stage. Pipeline processes. |

## Rebuild from Vault

`pipeline.db` is disposable. It can be rebuilt by walking vault markdown and inferring stage completion from what exists:

### Rebuild Algorithm

```
1. Walk vault directories:
   - sessions/**/*.md → register as 'session'
   - spores/**/*.md   → register as 'spore'
   - artifacts/**/*.md → register as 'artifact'

2. For each work item, infer stage status from existing data:

   Session:
   - File exists with conversation section        → capture: succeeded
   - Linked spore files exist (observations)       → extraction: succeeded
   - Has entry in vectors.db                       → embedding: succeeded
   - Appears in latest digest trace                → digest: succeeded

   Spore:
   - File exists                                   → capture: succeeded
   - Has entry in vectors.db                       → embedding: succeeded
   - Appears in digest trace                       → digest: succeeded

   Artifact:
   - File exists                                   → capture: succeeded
   - Has entry in vectors.db                       → embedding: succeeded
   - Appears in digest trace                       → digest: succeeded

   Consolidation (all types):
   - Cannot be reliably inferred from vault state alone.
     Mark as 'pending' — this triggers a re-consolidation pass.
     Acceptable cost: consolidation is idempotent (already-superseded
     spores won't be superseded again, wisdom clusters are stable).

3. Any stage that can't be confirmed → mark as 'pending'
   (triggers processing on next pipeline tick)
```

### First-Run Migration

Existing Myco installations upgrading to this version have no `pipeline.db`. On first startup:
1. Daemon detects missing `pipeline.db`
2. Creates schema
3. Runs rebuild algorithm
4. Discovers unprocessed work (e.g., artifact embeddings never done, consolidation status unknown)
5. Queues missing stages as `pending`
6. Pipeline processes on subsequent ticks, draining backlog chronologically

Note: first-run migration will trigger a full consolidation re-evaluation since consolidation status cannot be inferred. This is a one-time cost. Consolidation is idempotent — it won't create duplicate wisdom notes or re-supersede already-superseded spores.

## Dashboard & UI

### Dashboard (At-a-Glance)

The existing topology visualization gains real meaning. Each pipeline stage shows aggregate health:
- **Green**: all items succeeded
- **Yellow**: items pending or retrying
- **Red**: failures, circuit open, poisoned items

Clicking any stage navigates to the Mycelium page filtered to that stage.

### Mycelium Page (Replaces Operations)

Full pipeline control room:

**Pipeline visualization**: Horizontal stage flow with live counts per status. Circuit breaker indicators on affected stages.

**Work item list**: Filterable by stage, status, type. Sortable by date. Shows current stage, error info, retry count.

**Work item detail** (drill-in): Full transition timeline with timestamps. Error details per attempt. Action buttons: Retry (for poisoned), Skip (force advance).

**Circuit breaker panel**: Per-provider-role cards showing state, failure count, last error, cooldown remaining. Manual reset button. Open/close history.

**Backlog indicator**: Count of items waiting to process. Estimated drain time based on current throughput.

**Preserved operations**: Rebuild (FTS reindex), manual digest trigger, and curate actions remain available as utility actions on the Mycelium page, since they serve purposes orthogonal to pipeline integrity.

### API Routes

```
GET  /api/pipeline/health              — aggregate health (stages × status counts)
GET  /api/pipeline/items               — paginated work items with current status
GET  /api/pipeline/items/:id           — single item with full transition history
GET  /api/pipeline/circuits            — circuit breaker states
POST /api/pipeline/retry/:id           — retry a poisoned item
POST /api/pipeline/retry-all           — retry all poisoned items
POST /api/pipeline/circuit/:provider/reset — manually close a circuit breaker
```

## Configuration

New section in `myco.yaml` schema:

```yaml
pipeline:
  retention_days: 30          # transition history compaction window
  batch_size: 5               # max items per stage per tick during backlog drain
  tick_interval_seconds: 30   # pipeline processing interval
  retry:
    transient_max: 3          # max retries for transient errors
    backoff_base_seconds: 30  # initial backoff (base × 4^attempt: 30s → 2m → 8m)
  circuit_breaker:
    failure_threshold: 3      # consecutive failures to open circuit
    cooldown_seconds: 300     # initial cooldown (5 minutes)
    max_cooldown_seconds: 3600 # maximum cooldown (1 hour)
```

## New Capability: Artifact Embedding

As part of this work, artifacts will be embedded for the first time. Artifacts flow through:
- Capture (classification, already exists)
- Embedding (new — artifact content embedded into vectors.db)
- Digest (substrate inclusion, already happens but with incomplete data)

This closes a gap where artifacts were classified but invisible to semantic search and digest synthesis.
