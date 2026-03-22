# Myco v2 Dashboard & API Overhaul — Design Spec

**Date:** 2026-03-22
**Status:** Draft
**Author:** Chris + Claude
**Depends on:** Phase 1 (PGlite Foundation), Phase 2 (Agent SDK Intelligence Layer)

---

## Overview

Overhaul the Myco dashboard and daemon API to reflect the v2 architecture. The markdown vault is gone — PGlite is the only data store, and the dashboard is the primary viewer for all captured and derived data. The v1 pipeline UI (circuit breakers, work items, reprocess) is removed entirely.

### What this covers

- Dashboard redesign as visual operations hub
- Session browser with full drill-down (batches, activities, screenshots, AI summaries)
- Mycelium browser (spores, graph, digest) — the derived intelligence layer
- Agent page (curator run history, decisions, trigger runs, diagnostics)
- Slim v2 settings page (project config + embedding provider)
- All new daemon API routes required by the UI
- Config schema overhaul (strip v1 sections)
- Removal of dead v1 UI code

### What this does NOT cover

- Custom agent tasks / user-defined curator identities (future — schema supports it, UI deferred)
- Data export or import tools
- Session lineage detection in hooks (may be offloaded to curator agent)
- The curator system prompt or curation logic itself

---

## Motivation

Phase 1 replaced the markdown vault with PGlite. Phase 2 added the Agent SDK intelligence layer. But the dashboard still renders v1 concepts: pipeline stages, circuit breakers, work items, FTS counts, reprocess operations. It calls API endpoints that no longer exist (`/pipeline/*`, `/digest`, `/curate`, `/rebuild`, `/reprocess`). The config page exposes settings for removed features (pipeline, team, context layers, digest metabolism).

With the markdown vault gone, Obsidian is no longer the data viewer. The dashboard must become self-sufficient — the only way to browse sessions, inspect what the curator built, manage embedding, and understand what Myco knows.

---

## Navigation

Six pages, replacing the current five (Dashboard, Configuration, Mycelium, Operations, Logs):

| Page | Purpose |
|------|---------|
| **Dashboard** | Visual operations hub — data flow, embedding status, curator status, activity feed |
| **Sessions** | Browse raw material — session list, drill into batches/activities/screenshots |
| **Mycelium** | Browse derived intelligence — spores, graph explorer, digest extracts |
| **Agent** | Curator identity — run history, decisions, trigger runs, diagnostics |
| **Settings** | Slim config — project settings + embedding provider |
| **Logs** | Daemon log viewer (kept from v1, minimal changes) |

**Global search** (`Cmd+K`): Search bar in the layout header, always visible. Two search modes:
- **Semantic search** (default): pgvector similarity across the intelligence layer — session summaries (agent-generated), spores, plans/artifacts. Searches derived knowledge, not raw capture data.
- **Full-text search**: Postgres `tsvector`/`tsquery` on raw materials — prompt text, tool names, file paths, AI responses in `prompt_batches` and `activities`. For finding specific raw data points ("the prompt where I mentioned database migration").
Results grouped by type, clickable to detail views.

**Replaced pages:** Mycelium (rewritten — v1 pipeline version replaced with mycelium intelligence browser).
**Removed pages:** Operations (v1 pipeline utilities — functionality no longer exists).

---

## Search & Embedding Architecture

Two search strategies serving different purposes:

### Semantic Search (pgvector) — Intelligence Layer

Searches the derived knowledge the curator has built. Embeddable content:

| Table | What gets embedded | Notes |
|-------|--------------------|-------|
| `sessions` | Agent-generated session summary (rich, with metadata/references) | Not the raw session — the curator's summary. Embedding is written after the curator processes the session via the `title-summary` task. Null until processed. |
| `spores` | Spore content (observation text) | Embedded on creation by the curator or embedding worker. |
| `plans` | Plan content | **Schema change needed:** add `embedding vector(1024)` column to `plans` table. Plans/specs are captured artifacts that are part of the graph. |
| `artifacts` | Artifact content | **Schema change needed:** add `embedding vector(1024)` column to `artifacts` table. User-supplied and agent-generated artifacts. |

`prompt_batches.embedding` column exists in the current schema but is repurposed or removed — raw batch text is not what we embed. The session summary incorporates batch-level detail into a rich embedded representation.

`digest_extracts` are NOT embedded — they are the compressed context injected directly into agent sessions, not searched.

### Full-Text Search (Postgres tsvector) — Raw Materials

Keyword search over the capture layer for finding specific data points:

| Table | Indexed columns | Use case |
|-------|----------------|----------|
| `prompt_batches` | `user_prompt`, `response_summary` | "Find the prompt where I discussed auth migration" |
| `activities` | `tool_name`, `tool_input`, `file_path` | "Find tool calls that touched auth.ts" |

**Schema changes needed:** Add `search_vector tsvector` column to `prompt_batches` and `activities`. Maintain via `tsvector_update_trigger` or populate on insert. Add GIN index for fast lookup.

### Context Injection Flow

1. **Session start** → inject digest extract at configured tier (broad project context)
2. **After user prompt** → semantic search spores for relevant immediate context based on the prompt

---

## Dashboard — Visual Operations Hub

The landing page. Shows the health and flow of the entire system at a glance.

### Hero: Data Flow Visualization

A horizontal flow diagram showing the Myco data lifecycle:

```
Sessions → Batches → Embedding → Curation → Mycelium → Digest
```

Each node displays:
- **Live count** (active sessions, unprocessed batches, pending embeddings, active spores, digest freshness)
- **Status indicator** (healthy / stale / pending / idle)
- **Clickable** — navigates to the relevant detail page

Visual cues for flow health: unprocessed batches accumulate visually, embedding queue depth is visible, digest staleness shows time since last cycle. The goal is to see at a glance whether data is flowing end-to-end or piling up somewhere.

### Panels

| Panel | Content |
|-------|---------|
| **Activity Feed** | Chronological stream of recent events: sessions opened/closed, curation runs completed, spores created, embeddings processed. Live-updating via polling. Each entry has timestamp + short description + link to detail. |
| **Curator Status** | Current state: idle / running (with elapsed time). Last run: task name, spores created, decisions made, time ago. Quick **"Run Now"** button to trigger curation. |
| **Embedding Health** | Provider name + status (connected / unavailable). Model name. Queue depth: count of items where `embedding IS NULL` across embeddable tables (sessions with summaries, spores, plans, artifacts). Throughput indicator if actively processing. |
| **System** | Daemon uptime, PGlite database size, port, PID. Compact horizontal bar — not cards. |

### API dependencies

- `GET /api/stats` — counts for flow nodes (sessions, batches unprocessed, spores, embedding queue, digest age)
- `GET /api/activity` — recent activity feed
- `GET /api/embedding/status` — provider health + queue depth
- `GET /api/agent/runs?limit=1` — last curator run for status panel

---

## Sessions Page

Browse raw material: everything Myco captured from agent sessions. Sessions are the source of all intelligence — every spore, edge, and digest extract traces back to a session.

### List View

Table with columns:
- **Title** (agent-generated summary when available, otherwise first prompt preview)
- **Agent** (claude-code, cursor, etc.)
- **Branch** (git branch during session)
- **Status** (active / completed)
- **Prompts** (count of prompt batches)
- **Tools** (count of tool uses)
- **Started** (relative timestamp)
- **Duration**

Filters: status, date range, agent type.
Default sort: most recent first.
Pagination: cursor-based, 50 per page.

### Detail View

Drill-in from the list (nested route or slide panel).

**Header:**
- Title, agent, user, branch, timestamps, status
- Session summary (agent-generated when the curator has processed it; absent until then)

**Timeline — Prompt Batches:**

Each prompt batch is a collapsible card, ordered chronologically:

1. **User prompt** — full text, with inline display of any screenshots/images the user provided during that prompt
2. **Activities** — tool calls listed: tool name, file path, success/error indicator, duration. Expandable for input/output detail.
3. **AI summary** — the assistant's response summary from the hook's `last_assistant_message`

This mirrors the natural conversation flow: user asks → agent works → agent responds.

**Metadata Sidebar:**
- Transcript path
- Parent session link (lineage — if detected by curator, shown; otherwise absent)
- Content hash
- Linked artifacts: plans and specs generated during the session (from `plans` and `artifacts` tables where `session_id` matches or source detected by curator)
- Attachments: images extracted from transcript

**Screenshots/Images:**
User-provided screenshots are captured from the agent transcript during stop event processing. Currently, the daemon writes image files to the `attachments/` directory on disk but does NOT populate the `attachments` table in PGlite. This must be fixed: the stop event handler should INSERT into the `attachments` table with the file path, media type, session_id, and prompt_batch_id. The daemon then serves these files via a static file route (`GET /api/attachments/:filename`). In the detail view, screenshots render inline with the user prompt that included them — the same experience as the old Obsidian vault, now in the dashboard.

### API dependencies

- `GET /api/sessions` — list with filters (already exists, may need enrichment)
- `GET /api/sessions/:id` — session detail with metadata
- `GET /api/sessions/:id/batches` — ordered batches with prompt text and AI summary
- `GET /api/batches/:id/activities` — activities for a specific batch
- `GET /api/sessions/:id/attachments` — images/screenshots for a session

---

## Mycelium Page

The derived intelligence the curator has built. Everything here was created by the Myco agent from raw session material. Every item traces back to its source.

All data on this page is scoped to `curator_id`. Currently, only the built-in Myco curator populates this. When custom curator identities are supported, each will have its own mycelium view.

### Spores Tab

Filterable list of observations the curator extracted:
- **Columns:** observation type, status (active/superseded/consolidated), importance, content preview, source session, created date
- **Filters:** observation type (gotcha, decision, discovery, trade_off, bug_fix, etc.), status, importance range
- **Click → Spore Detail:**
  - Full content and context
  - Source link: session + prompt batch where this was discovered
  - Resolution history: if superseded or consolidated, links to successor spores and the resolution event
  - Edges: relationships to other spores (SUPERSEDES, RELATES_TO, CONTRADICTS, etc.)

### Graph Tab

Visual graph explorer — the mycelium network.

**Data model:** The graph has two layers. **Entities** are abstract concepts the curator identifies across sessions (type: component, concept, file, bug, decision, tool, person). **Edges** connect entities to each other with labeled relationships. **Entity mentions** (`entity_mentions` table) link entities back to the concrete vault objects (spores, sessions) where they were observed. This means the graph nodes are entities, but each entity is grounded in the spores and sessions that reference it.

- **Entry point:** Select an entity to center the view, or enter from a spore/session detail page (which resolves to the entities mentioned in that note via `entity_mentions`)
- **Display:** Nodes are entities (labeled with name + type). Edges are labeled relationships (DISCOVERED_IN, SUPERSEDES, RELATES_TO, AFFECTS, CAUSED_BY, DEPENDS_ON, CONTRADICTS, RESOLVED_BY). Entity nodes show a count badge for how many spores/sessions mention them.
- **Depth:** 1–3 hops from center entity, user-controllable
- **Interaction:** Click any entity to re-center. Click edge labels to see metadata (session_id where relationship was discovered, confidence score). Click the mention count badge to see the list of spores/sessions that reference this entity.
- **Traceability:** Every entity traces back to the spores/sessions where the curator observed it. Every edge records the session_id where the relationship was discovered.
- **Empty state:** "No graph data yet — run the curator to build the mycelium." Graceful when entities/edges tables are empty.

**API response shape for `GET /api/graph/:id`:**
```typescript
{
  center: { id: string, type: string, name: string, properties: object },
  nodes: Array<{ id: string, type: string, name: string, mention_count: number }>,
  edges: Array<{ source_id: string, target_id: string, type: string, confidence: number, session_id?: string }>,
  depth: number
}
```
The `id` parameter is always an entity ID. To enter the graph from a spore or session, the UI first calls `GET /api/entities?mentioned_in=<note_id>&note_type=<spore|session>` to resolve entity IDs, then calls the graph endpoint with one of those entity IDs.

### Digest Section

Below the tabs (or as a third tab): current digest extracts.

- **Tiers:** 1500 / 3000 / 5000 / 7500 / 10000 tokens
- **Per tier:** content preview (expandable to full), generated_at timestamp, freshness indicator (time since generation)
- **Substrate:** count of new material since last digest cycle
- **Empty state:** "No digest generated yet."

### API dependencies

- `GET /api/spores` — list/filter spores
- `GET /api/spores/:id` — spore detail with edges and source links
- `GET /api/entities` — list/filter entities (with `mentioned_in` + `note_type` query params for resolution)
- `GET /api/graph/:id` — graph traversal from an entity ID: nodes + edges within depth
- `GET /api/digest` — current digest extracts by tier, scoped to curator_id

---

## Agent Page

The Myco curator's identity and operational history. "Myco created, Myco decided." This is not a task runner — it's the operational view of an intelligent agent that builds and maintains the mycelium.

### Run History (Default View)

List of curation runs:
- **Columns:** task name, status (completed/failed/running), started, duration, tokens used, cost, actions taken (spores created, edges built, etc.)
- **Sort:** most recent first
- **Click → Run Detail**

### Run Detail

Two-panel view:

**Decisions (primary, visible by default):**
What the agent decided and why. Rendered from `agent_reports` — each report shows:
- **Action** taken (e.g., "extracted gotcha", "superseded stale spore", "built entity edge")
- **Summary** — the agent's explanation of its reasoning
- **Details** — structured data (affected spore IDs, session references, etc.)

This is the `vault_report` tool output — the curator's own narrative of its work. It's the primary way to understand what a run accomplished.

**Audit Trail (collapsed/toggle, for diagnostics):**
Full turn-by-turn execution trace from `agent_turns`:
- Turn number, tool called, input summary, output summary, timing
- For prompt tuning, cost optimization, and debugging agent behavior

**Summary bar:** Status badge, total tokens, cost (USD), actions taken count, duration.

### Trigger Run

"Run Now" interaction:
- **Task picker:** dropdown of built-in shipped tasks (full-curation, extract-only, digest-only, review-session, graph-maintenance, supersession-sweep, title-summary, consolidation)
- **Instruction field:** optional free-text to focus the agent (e.g., "Focus on auth module decisions")
- **Run button:** triggers `POST /api/agent/run`

The task definitions ship with the package and are not editable from the UI. Custom tasks that change model/tools/settings create a new curator identity (future feature — schema supports it via `curator_id` scoping).

### API dependencies

- `GET /api/agent/runs` — list runs (already exists)
- `GET /api/agent/runs/:id` — run detail (already exists)
- `GET /api/agent/runs/:id/reports` — decision reports (already exists)
- `GET /api/agent/runs/:id/turns` — audit trail (new)
- `POST /api/agent/run` — trigger run (already exists)
- `GET /api/agent/tasks` — list available tasks for the picker

---

## Settings Page

Slim. Two sections reflecting what's actually configurable in v2.

### Project

| Field | Type | Notes |
|-------|------|-------|
| Vault name | Read-only | Derived from project directory |
| Daemon port | Number | Set once, stored in YAML, rarely changed |
| Log level | Select | debug / info / warn / error |

### Embedding

| Field | Type | Notes |
|-------|------|-------|
| Provider | Select | ollama (recommended) / openai-compatible |
| Model | Text | Default: bge-m3 |
| Base URL | Text | Optional, for custom endpoints |
| **Test Connection** | Button | Verifies embedding provider is reachable and model is available |

That's it. No LLM config (curator ships its own via Claude Agent SDK + user's Claude subscription, or custom agents configure their own). No team, capture token limits, context layers, digest metabolism, consolidation — all either removed or managed by the agent internally.

### Config schema changes

The `MycoConfigSchema` in `src/config/schema.ts` needs to be stripped down:

**Remove:** `intelligence.llm`, `capture.extraction_max_tokens`, `capture.summary_max_tokens`, `capture.title_max_tokens`, `capture.classification_max_tokens`, `context` (entire section), `team` (entire section), `digest.intelligence`, `digest.metabolism`, `digest.substrate`, `digest.consolidation`

**Keep:** `version`, `config_version`, `intelligence.embedding` (renamed to top-level `embedding`), `daemon.port`, `daemon.log_level`, `capture.transcript_paths`, `capture.artifact_watch`, `capture.artifact_extensions`, `capture.buffer_max_events`

**Resulting schema (approximate):**
```
{
  version: 3,
  config_version: number,
  embedding: { provider, model, base_url? },
  daemon: { port, log_level },
  capture: { transcript_paths, artifact_watch, artifact_extensions, buffer_max_events }
}
```

**Version numbering note:** The config YAML `version` field (currently `z.literal(2)`, moving to `z.literal(3)`) is distinct from the database `schema_version` table (currently version 2). The config version tracks the YAML schema shape; the database version tracks PGlite DDL migrations. If new database tables or columns are needed for this phase (e.g., `attachments` table population fix), the database schema version bumps independently.

The `digest.tiers` and `digest.inject_tier` may remain if digest behavior is partially configurable, or they move to agent task config in the database. To be determined during implementation.

---

## New Daemon API Routes

### Sessions

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/sessions` | List sessions with filters (exists — may need enrichment for title, summary) |
| GET | `/api/sessions/:id` | Session detail: full metadata, summary, lineage, linked artifacts |
| GET | `/api/sessions/:id/batches` | Ordered batches: prompt text, AI summary, activity count, classification |
| GET | `/api/batches/:id/activities` | Activities for a batch: tool name, file path, success, duration, input/output |
| GET | `/api/sessions/:id/attachments` | Images/screenshots attached to the session |

### Mycelium

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/spores` | List/filter spores: type, status, importance, curator_id, pagination |
| GET | `/api/spores/:id` | Spore detail: content, context, source session, edges, resolution history |
| GET | `/api/entities` | List/filter entities, with `mentioned_in` + `note_type` query params for resolving from spore/session |
| GET | `/api/graph/:id` | Graph traversal from an entity ID: nodes + edges within depth (see response shape in Mycelium section) |
| GET | `/api/digest` | Digest extracts by tier, scoped to curator_id, with freshness metadata |

### Search

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/search?q=<query>&mode=<semantic|fts>&type=<filter>` | Dual-mode search. `semantic` (default): pgvector similarity across intelligence layer (session summaries, spores, plans, artifacts). `fts`: Postgres full-text search across raw materials (prompt text, tool names, file paths). Results grouped by type with scores. |

### Agent

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/agent/runs/:id/turns` | Audit trail for a run (new) |
| GET | `/api/agent/tasks` | List available tasks for trigger UI (new) |

Existing routes that stay: `POST /api/agent/run`, `GET /api/agent/runs`, `GET /api/agent/runs/:id`, `GET /api/agent/runs/:id/reports`.

### Operations

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/activity` | Recent activity feed for dashboard. Synthesized from multiple tables via UNION query: recent sessions (opened/closed), agent_runs (completed/failed), spores (created). Returns unified list sorted by timestamp. Each entry: `{ type, id, summary, timestamp, link }`. Capped at 50 most recent. |
| GET | `/api/embedding/status` | Provider health (test connection), queue depth (`SELECT COUNT(*) WHERE embedding IS NULL` across sessions with summaries, spores, plans, artifacts), model info from config |
| GET | `/api/attachments/:filename` | Serve attachment files from the vault's `attachments/` directory (static file serving for screenshots/images) |
| GET | `/api/stats` | Updated for v2: session/batch/spore/entity/edge counts, embedding coverage (embedded vs total), digest freshness, unprocessed batch count |

### Removed

All `/pipeline/*` routes are removed from UI consumption. Any remaining daemon routes for internal use (hook event ingestion) are unchanged.

### Existing routes that stay (no changes needed)

- `GET /api/config`, `PUT /api/config` — read/write project config (used by Settings page)
- `GET /api/logs` — daemon log stream (used by Logs page)
- `POST /api/log` — external log ingestion from MCP server
- `GET /api/models` — list available models from providers (used by Settings for model suggestions)
- `POST /api/restart`, `GET /api/progress/:token` — daemon restart with progress tracking

### Curator ID scoping

All mycelium API routes (`/api/spores`, `/api/entities`, `/api/graph`, `/api/digest`) are scoped to `curator_id`. The default is `DEFAULT_CURATOR_ID` (`myco-curator`) from `src/constants.ts`. Routes accept an optional `curator_id` query parameter to override, but the UI defaults to the built-in curator. When custom curator identities are supported, the UI will add a curator selector.

### New query helpers needed

Several API routes require new PGlite query functions not yet implemented:
- `listBatchesBySession(sessionId)` — ordered batches for a session
- `listActivitiesByBatch(batchId)` — activities for a specific batch
- `listAttachmentsBySession(sessionId)` — attachment records for a session
- `listEntities(options?)` — with `mentioned_in` + `note_type` filter support
- `getEntityWithEdges(entityId, depth)` — entity + connected nodes/edges within depth
- `listDigestExtracts(curatorId)` — all tier extracts for a curator
- `listTurnsByRun(runId)` — agent turns for audit trail
- `listTasksByCurator(curatorId)` — available tasks
- `getActivityFeed(limit)` — cross-table UNION query for dashboard feed

---

## Cleanup

### UI files to remove

- `ui/src/pages/Mycelium.tsx` (v1 pipeline version — new Mycelium page is different)
- `ui/src/pages/Operations.tsx`
- `ui/src/components/pipeline/` (entire directory — PipelineVisualization, StageDetail, etc.)
- `ui/src/components/operations/` (entire directory — CurationPanel, RebuildPanel, ReprocessPanel, CircuitBreakerPanel, DigestHealthPanel, WorkItemList)
- `ui/src/hooks/use-pipeline.ts`
- Any v1 type definitions for pipeline stages, work items, circuit breakers

### UI files to create

- `ui/src/pages/Sessions.tsx`
- `ui/src/pages/Mycelium.tsx` (new — spores, graph, digest)
- `ui/src/pages/Agent.tsx`
- `ui/src/pages/Settings.tsx` (replaces Configuration.tsx)
- `ui/src/components/sessions/` (SessionList, SessionDetail, BatchTimeline, ActivityList)
- `ui/src/components/mycelium/` (SporeList, SporeDetail, GraphExplorer, DigestView)
- `ui/src/components/agent/` (RunList, RunDetail, DecisionReports, AuditTrail, TriggerRun)
- `ui/src/components/dashboard/` (DataFlow, ActivityFeed, CuratorStatus, EmbeddingHealth)
- `ui/src/components/search/` (GlobalSearch, SearchResults)
- `ui/src/hooks/use-sessions.ts`, `use-spores.ts`, `use-agent.ts`, `use-search.ts`, `use-embedding.ts`

### Config schema changes

- `src/config/schema.ts` — strip to v3 shape (see Settings section)
- Config migration: v2 → v3 (preserve embedding and daemon settings, drop removed sections)
- Update all config consumers in daemon, hooks, CLI

---

## Implementation Phases

### Phase 3a: API Foundation
New daemon API routes, config schema overhaul, stats update. No UI changes yet — backend first.

### Phase 3b: Dashboard + Layout
New navigation, global search, data flow visualization, activity feed, system panels. Remove v1 pages and components.

### Phase 3c: Sessions Browser
Sessions list + detail view with batch timeline, activities, screenshots, metadata sidebar.

### Phase 3d: Mycelium Browser
Spores list/detail, graph explorer, digest view.

### Phase 3e: Agent Page
Run history, run detail with decisions + audit trail, trigger run UI.

### Phase 3f: Settings + Cleanup
Slim settings page, remove dead code, final integration testing.

---

## Open Questions

1. **Session lineage detection:** Can hooks reliably detect parent/child session relationships (e.g., Claude Code's session resume), or must this be deferred to the curator agent? If hooks can detect it, `parent_session_id` is populated at capture time. If not, the curator enriches it later by analyzing transcript patterns.

2. **Graph visualization library:** The graph explorer needs a force-directed or hierarchical layout library. Candidates: D3.js (maximum control), react-force-graph (simpler), Cytoscape.js (graph-focused). Decision deferred to implementation.

3. **Digest config location:** Do `digest.tiers` and `digest.inject_tier` stay in the YAML config, or move to agent task config in the database? If the curator fully owns digest behavior, the config should be in its task definition, not the YAML.

## Resolved Decisions

- **Attachment storage:** File-based. Screenshots written to `attachments/` directory, served via `GET /api/attachments/:filename`. The `attachments` table in PGlite stores metadata (file_path, media_type, session_id, prompt_batch_id) — the daemon's stop handler must be fixed to INSERT records when writing files.

- **Activity feed scope:** Aggregated meaningful events only (session open/close, curation run complete, spore created). Individual tool uses are too high-frequency — those are visible in the session detail's batch timeline. Feed synthesized via cross-table UNION query, capped at 50 entries.

- **Search architecture:** Two modes. Semantic search (pgvector) covers the intelligence layer: session summaries, spores, plans, artifacts. Full-text search (Postgres tsvector) covers raw materials: prompt text, tool names, file paths. Raw materials are not embedded — embedding is reserved for derived intelligence. See "Search & Embedding Architecture" section for full details.

- **Schema changes for search:** Add `embedding vector(1024)` to `plans` and `artifacts` tables. Add `search_vector tsvector` to `prompt_batches` and `activities`. Remove or repurpose `prompt_batches.embedding` (raw batch text is not embedded; session summaries incorporate batch detail). Add GIN indexes for FTS.
