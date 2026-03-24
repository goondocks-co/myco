# Agent Rename & Intelligence Pipeline Fix

**Date:** 2026-03-23
**Status:** Draft
**Scope:** Terminology rename (curator → agent), session summary generation fix, embedding pipeline verification, semantic search validation

## Problem

The v2 refactor introduced a new intelligence pipeline but left three interconnected issues:

1. **Terminology debt:** ~876 references to "curator" across ~61 files. The internal name `myco-curator`, DB columns `curator_id`, config key `curation`, and CLI command `myco curate` all use outdated terminology. The correct term is "agent" — the Myco agent that runs the intelligence pipeline.

2. **Session summaries not generated:** The agent prompt says to update session title/summary "if batch significantly changes narrative," but audit trails show no `vault_update_session` calls. The vague criteria give the agent discretion to skip it entirely, and it does. Sessions have no summaries, which means nothing to embed for session-level semantic search.

3. **Semantic search not returning results:** The embedding worker was added but semantic search still returns empty. Without working search, the agent can't find related spores for supersession, can't deduplicate, and can't build coherent digest extracts. It falls back to reading tables directly — expensive and blind to similarity.

These are coupled: no summaries → nothing to embed for sessions → semantic search degraded → agent operates blind to its own history.

## Approach: Layered Implementation

Three layers, each building on the previous. Each layer gets its own commit.

### Layer 1: Schema & Constants

**DB schema (`src/db/schema.ts`):**
- Rename `curators` table → `agents`
- Rename `curator_id` column → `agent_id` in all 12 tables: `spores`, `entities`, `entity_mentions`, `edges`, `resolution_events`, `digest_extracts`, `agent_runs`, `agent_reports`, `agent_turns`, `agent_tasks`, `agent_state`, and the `agents` table itself
- Update all indexes and constraints referencing old names (rename via `ALTER INDEX ... RENAME TO`)
- Bump `SCHEMA_VERSION` from 3 → 4

**Startup migration:**
- Add idempotent migration that runs on daemon startup (before schema creation)
- `ALTER TABLE curators RENAME TO agents` (if `curators` exists)
- `ALTER TABLE <table> RENAME COLUMN curator_id TO agent_id` for each of the 12 tables (if column exists)
- Rename indexes: `idx_spores_curator_id` → `idx_spores_agent_id`, etc.
- Migration checks for old name existence before renaming — safe to run multiple times
- Update existing `migrateV1ToV2` function to reference new table/column names (fresh installs will never have `curators` table)

**Constants (`src/constants.ts`):**
- `DEFAULT_CURATOR_ID` → `DEFAULT_AGENT_ID`
- `USER_CURATOR_ID` → `USER_AGENT_ID`
- `USER_CURATOR_NAME` → `USER_AGENT_NAME`
- `CURATION_CLUSTER_SIMILARITY` → `AGENT_CLUSTER_SIMILARITY`

**Config schema (`src/config/schema.ts`):**
- `CurationSchema` → `AgentSchema`
- Config key `curation` → `agent` in myco.yaml
- Add Zod `.transform()` to map old `curation` key to `agent` during parsing (handles existing myco.yaml files)
- Fields: `auto_run`, `interval_seconds` (unchanged)

**Types (`src/agent/types.ts`):**
- All `curatorId` params → `agentId`
- All `curator*` type names → `agent*` equivalents

### Layer 2: Code References

**File renames:**
- `src/db/queries/curators.ts` → `src/db/queries/agents.ts`
- `src/agent/definitions/curator.yaml` → `src/agent/definitions/agent.yaml`
- `src/agent/prompts/curator.md` → `src/agent/prompts/agent.md`
- `src/cli/curate.ts` → `src/cli/agent-run.ts`
- `ui/src/components/dashboard/CuratorStatus.tsx` → `AgentStatus.tsx`
- `tests/db/queries/curators.test.ts` → `tests/db/queries/agents.test.ts`

**CLI command rename:**
- `myco curate` → `myco agent` (in `src/cli.ts` command dispatch)
- Update `src/cli/curate.ts` → `src/cli/agent-run.ts` implementation
- Update CLI help text

**Function renames (all files referencing curator):**
- `getCurator` → `getAgent`
- `registerCurator` → `registerAgent`
- `listCurators` → `listAgents`
- `getStatesForCurator` → `getStatesForAgent`
- `runCurationAgent` → `runAgent`
- `registerBuiltInCuratorsAndTasks` → `registerBuiltInAgentsAndTasks`
- `curationTimer` → `agentTimer`

**Variable/param renames across all source files:**
- `curatorId` → `agentId` everywhere
- `curator_id` in API request/response bodies → `agent_id`
- Import paths updated for renamed files
- Hardcoded column name strings (e.g., `'curator_id'` in `src/db/queries/embeddings.ts` `TABLE_SELECT_COLUMNS`) → `'agent_id'`

**YAML definition (`agent.yaml`):**
- `name: myco-curator` → `name: myco-agent`
- All task YAMLs: `agent: myco-curator` → `agent: myco-agent`

**Daemon (`src/daemon/main.ts`):**
- Curation timer variable and log messages
- API route handler references
- Built-in registration calls

**Stats service (`src/services/stats.ts`):**
- Response key `curator` → `agent` (coordinated with frontend)

**UI components:**
- All components referencing `curator_id` in API calls or display
- React hooks using curator terminology (`use-config.ts`, `use-daemon.ts`, `use-agent.ts`)
- Dashboard components: `DataFlow.tsx` (`stats.curator` → `stats.agent`), `ActivityFeed.tsx`
- Settings page: `curationAutoRun` → `agentAutoRun`, `curationIntervalSeconds` → `agentIntervalSeconds`

**Test files (17 files):**
- `tests/db/queries/curators.test.ts` → `agents.test.ts`
- All other test files referencing `curator_id` or curator functions:
  `spores.test.ts`, `agent-state.test.ts`, `extended-queries.test.ts`, `tasks.test.ts`, `runs.test.ts`, `reports.test.ts`, `turns.test.ts`, `feed.test.ts`, `search.test.ts`, `embeddings.test.ts`, `schema.test.ts`, `context.test.ts`, `executor.test.ts`, `loader.test.ts`, `tools.test.ts`, `injector.test.ts`

**Documentation & skills:**
- `skills/myco-curate/SKILL.md` — terminology update
- `skills/myco/SKILL.md`, `skills/myco/references/wisdom.md` — terminology update
- `docs/agent-tools.md`, `docs/quickstart.md`, `docs/lifecycle.md` — terminology update
- `README.md` — terminology update

### Layer 3: Prompts, Tasks & Behavioral Fixes

**System prompt (`agent.md`) — terminology + evaluation:**
- Replace all "curator/curation" language with "agent/intelligence"
- Review and validate:
  - Processing protocol phases (extract → graph → supersession → summary → digest)
  - Observation type definitions — specific enough to guide extraction?
  - Entity and relationship type definitions — appropriate for the domain?
  - Supersession criteria — clear enough to prevent false positives?
  - Digest tier instructions — each tier well-differentiated?

**Session summary generation — behavioral fix:**

Add concrete "meaningful change" criteria to the processing protocol:

> After processing batches for a session, evaluate whether the session summary needs updating. Update is REQUIRED when:
> - The session has no summary yet
> - New tools or files appear that aren't captured in the existing summary
> - The session scope expanded beyond what the current summary describes
> - 3+ batches have been processed since the last summary update
>
> When updating, provide BOTH title and summary. The title should reflect the full session scope (not just the first prompt). The summary should be 2-4 sentences capturing key work done and outcomes.
>
> You MUST call `vault_update_session` for every session you process. If no update criteria are met, you may skip the call — but log your reasoning via `vault_report`.

**Task definitions — evaluation pass:**
- `full-intelligence.yaml`: Verify prompt covers all phases including mandatory summary step
- `title-summary.yaml`: Verify toolOverrides include all needed tools
- `review-session.yaml`: Verify single-session processing includes summary
- `extract-only.yaml`: Verify it updates summaries (prompt says it should)
- `digest-only.yaml`, `graph-maintenance.yaml`, `supersession-sweep.yaml`: Verify scoped correctly
- All tasks: rename `agent: myco-curator` → `agent: myco-agent`

**Tool descriptions — evaluation:**
- `vault_update_session`: Clarify that title and summary should both be provided when generating fresh
- `vault_search`: Clarify fallback behavior when no embeddings exist
- `vault_report`: Clarify this should be used when skipping expected actions (like summary generation)

### Embedding & Semantic Search Verification

After Layer 3 implementation, verify the full pipeline:

**Embedding worker:**
- Confirm worker runs on 30s interval across all 4 tables (sessions, spores, plans, artifacts)
- Verify content column mapping is correct per table
- Verify newly created spores/summaries appear in embedding queue
- Confirm queue drains to zero
- Fix performance issue: `getUnembedded` should filter `WHERE summary IS NOT NULL` for sessions table, so the worker doesn't repeatedly fetch and skip summary-less sessions every cycle

**Semantic search:**
- Diagnose why search returns empty: query embedding? threshold? empty vectors? wrong operator?
- Test with known query that should match existing spores
- Trace full path: query → embed → vector comparison → results
- Verify `vault_search` tool returns results to the agent

**Agent search fallback:**
- Verify agent behavior when search returns empty
- Prompt should instruct: don't silently skip supersession/dedup, report via `vault_report`

**End-to-end validation:**
1. Trigger full-intelligence run with new prompts
2. Check audit trail: `vault_update_session` called for processed sessions
3. Verify titles regenerated from content
4. Verify summaries are substantive
5. Wait for embedding worker cycle
6. Run `myco search` with session-related query — session appears in results
7. Verify per-prompt context injection can surface relevant sessions

**Post-rename verification:**
- Run `grep -ri 'curator\|curation' src/ tests/ ui/ skills/ docs/` and confirm zero results
- `make check` passes (lint + tests)

## Files Affected

### Layer 1 (Schema/Constants) — ~6 files
- `src/db/schema.ts` (schema definitions + old migration updates + version bump)
- `src/constants.ts`
- `src/config/schema.ts`
- `src/agent/types.ts`

### Layer 2 (Code References) — ~55 files
**Source (~25 files):**
- `src/db/queries/curators.ts` → `agents.ts`
- `src/db/queries/spores.ts`, `entities.ts`, `edges.ts`, `agent-state.ts`, `digest-extracts.ts`, `resolution-events.ts`, `runs.ts`, `reports.ts`, `turns.ts`, `tasks.ts`, `embeddings.ts`
- `src/agent/executor.ts`, `loader.ts`, `tools.ts`, `context.ts`
- `src/agent/definitions/curator.yaml` → `agent.yaml`
- `src/agent/definitions/tasks/*.yaml` (7 files)
- `src/daemon/main.ts`
- `src/daemon/api/mycelium.ts`
- `src/services/stats.ts`
- `src/cli.ts`, `src/cli/curate.ts` → `agent-run.ts`, `src/cli/stats.ts`
- `src/mcp/tools/remember.ts`

**UI (~8 files):**
- `ui/src/components/dashboard/CuratorStatus.tsx` → `AgentStatus.tsx`
- `ui/src/components/dashboard/DataFlow.tsx`, `ActivityFeed.tsx`
- `ui/src/components/mycelium/*.tsx` (4 files)
- `ui/src/hooks/use-spores.ts`, `use-agent.ts`, `use-config.ts`, `use-daemon.ts`
- `ui/src/pages/Settings.tsx`

**Tests (~17 files):**
- `tests/db/queries/curators.test.ts` → `agents.test.ts`
- All test files with curator references (16 additional files)

**Docs & skills (~5 files):**
- `skills/myco-curate/SKILL.md`, `skills/myco/SKILL.md`, `skills/myco/references/wisdom.md`
- `docs/agent-tools.md`, `docs/quickstart.md`, `docs/lifecycle.md`
- `README.md`

### Layer 3 (Prompts/Behavioral) — ~10 files
- `src/agent/prompts/curator.md` → `agent.md` (terminology + behavioral fixes)
- `src/agent/definitions/tasks/*.yaml` (7 files — prompt review)
- `src/agent/tools.ts` (tool description updates)
- `src/db/queries/embeddings.ts` (getUnembedded filter fix)

### Verification — no file changes, runtime testing
- Agent run triggered via API/CLI
- Embedding queue monitored
- Semantic search tested via CLI
- Post-rename grep for stale references

## Out of Scope

- UI design overhaul (separate session with new design system)
- Graph visualization UX (broken, but not part of this work)
- Dashboard layout changes
- New agent features or additional tools
- Per-prompt context injection changes (depends on search working first)
