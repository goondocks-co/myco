# Agent Rename & Intelligence Pipeline Fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename all "curator/curation" terminology to "agent" across the entire codebase, fix session summary generation so the agent actually produces titles and summaries, and verify the embedding + semantic search pipeline works end-to-end.

**Architecture:** Three-layer approach: Layer 1 changes the DB schema, constants, config, and types (the foundation). Layer 2 updates all code references, file names, tests, UI, and docs to compile against the new foundation. Layer 3 updates prompts and task definitions with terminology fixes and behavioral improvements for session summary generation, then verifies the full pipeline.

**Tech Stack:** TypeScript, PGlite (Postgres-compatible), Zod, Claude Agent SDK, Vitest, React/Tailwind (UI)

**Spec:** `docs/superpowers/specs/2026-03-23-agent-rename-pipeline-fix-design.md`

---

## Layer 1: Schema & Constants

### Task 1: Add DB Migration for Table/Column Renames

The migration renames `curators` → `agents` and `curator_id` → `agent_id` across all 12 tables. It must be idempotent and run before schema creation.

**Files:**
- Modify: `src/db/schema.ts:16-19` (SCHEMA_VERSION), `src/db/schema.ts:149-308` (CREATE TABLE statements), `src/db/schema.ts:312-382` (indexes), `src/db/schema.ts:451-508` (old migrations), `src/db/schema.ts:522-561` (createSchema)

- [ ] **Step 1: Write the migration function**

Add `migrateV3ToV4()` to `src/db/schema.ts` after the existing `migrateV2ToV3()` function (~line 508). This function renames the table and all columns:

```typescript
async function migrateV3ToV4(db: PGliteInterface): Promise<void> {
  // Rename curators table → agents
  const curatorTableExists = await db.query(
    `SELECT 1 FROM information_schema.tables WHERE table_name = 'curators' LIMIT 1`,
  );
  if (curatorTableExists.rows.length > 0) {
    await db.query(`ALTER TABLE curators RENAME TO agents`);
  }

  // Rename curator_id → agent_id in all tables that have it
  const tables = [
    'agents', 'spores', 'entities', 'entity_mentions', 'edges',
    'resolution_events', 'digest_extracts', 'agent_runs', 'agent_reports',
    'agent_turns', 'agent_tasks', 'agent_state',
  ];
  for (const table of tables) {
    const colExists = await columnExists(db, table, 'curator_id');
    if (colExists) {
      await db.query(`ALTER TABLE ${table} RENAME COLUMN curator_id TO agent_id`);
    }
  }

  // Rename indexes
  const indexRenames = [
    ['idx_spores_curator_id', 'idx_spores_agent_id'],
    ['idx_entities_curator_id', 'idx_entities_agent_id'],
    ['idx_edges_curator_id', 'idx_edges_agent_id'],
    ['idx_entity_mentions_curator_id', 'idx_entity_mentions_agent_id'],
    ['idx_resolution_events_curator_id', 'idx_resolution_events_agent_id'],
    ['idx_digest_extracts_curator_id', 'idx_digest_extracts_agent_id'],
    ['idx_agent_runs_curator_id', 'idx_agent_runs_agent_id'],
    ['idx_agent_runs_curator_status', 'idx_agent_runs_agent_status'],
    ['idx_agent_tasks_curator_id', 'idx_agent_tasks_agent_id'],
  ];
  for (const [oldName, newName] of indexRenames) {
    const exists = await db.query(
      `SELECT 1 FROM pg_indexes WHERE indexname = $1 LIMIT 1`,
      [oldName],
    );
    if (exists.rows.length > 0) {
      await db.query(`ALTER INDEX ${oldName} RENAME TO ${newName}`);
    }
  }
}
```

- [ ] **Step 2: Update SCHEMA_VERSION and PREVIOUS_SCHEMA_VERSION**

At `src/db/schema.ts:16-19`, change:
```typescript
const SCHEMA_VERSION = 4;
const PREVIOUS_SCHEMA_VERSION = 3;
```

- [ ] **Step 3: Update all CREATE TABLE statements to use new names**

In `src/db/schema.ts`, update the DDL strings:

- Line 149: `curators` table → rename to `agents`, rename `id` column comment context if any
- Line 170: `spores` table → `curator_id` → `agent_id`
- Line 189: `entities` table → `curator_id` → `agent_id`
- Line 201: `edges` table → `curator_id` → `agent_id`
- Line 218: `entity_mentions` table → `curator_id` → `agent_id`
- Line 225: `resolution_events` table → `curator_id` → `agent_id`
- Line 237: `digest_extracts` table → `curator_id` → `agent_id`
- Line 250: `agent_runs` table → `curator_id` → `agent_id`
- Line 266: `agent_reports` table → `curator_id` → `agent_id`
- Line 277: `agent_turns` table → `curator_id` → `agent_id`
- Line 289: `agent_tasks` table → `curator_id` → `agent_id`
- Line 303: `agent_state` table → `curator_id` → `agent_id`

All REFERENCES constraints pointing to `curators(id)` → `agents(id)`.

- [ ] **Step 4: Update all index definitions**

In `src/db/schema.ts` lines 312-382, rename all indexes referencing `curator_id`:
- `idx_spores_curator_id` → `idx_spores_agent_id` (column: `agent_id`)
- `idx_entities_curator_id` → `idx_entities_agent_id` (column: `agent_id`)
- `idx_edges_curator_id` → `idx_edges_agent_id` (column: `agent_id`)
- `idx_entity_mentions_curator_id` → `idx_entity_mentions_agent_id` (column: `agent_id`)
- `idx_resolution_events_curator_id` → `idx_resolution_events_agent_id` (column: `agent_id`)
- `idx_digest_extracts_curator_id` → `idx_digest_extracts_agent_id` (column: `agent_id`)
- `idx_agent_runs_curator_id` → `idx_agent_runs_agent_id` (column: `agent_id`)
- `idx_agent_runs_curator_status` → `idx_agent_runs_agent_status` (columns: `agent_id, status`)
- `idx_agent_tasks_curator_id` → `idx_agent_tasks_agent_id` (column: `agent_id`)

- [ ] **Step 5: Leave old migration functions UNTOUCHED**

**CRITICAL:** Do NOT modify `migrateV1ToV2()` or `migrateV2ToV3()`. These run in sequence before `migrateV3ToV4()`. On an existing v2 database, these migrations need the old table/column names (`curators`, `curator_id`) because the rename hasn't happened yet at that point in the chain. For fresh installs, the old tables won't exist, so these migrations are harmless no-ops (guarded by `columnExists` checks).

- [ ] **Step 6: Wire migration into createSchema()**

In `createSchema()` (~line 522-561), add `migrateV3ToV4(db)` call. It must run BEFORE the DDL statements so that:
1. Existing databases: tables are renamed from old names → new names
2. Then DDL runs with `CREATE TABLE IF NOT EXISTS agents ...` — finds the just-renamed tables, no-ops

The actual code change: move or add the `migrateV3ToV4(db)` call before the `for (const ddl of TABLE_DDLS)` loop. The existing V1→V2 and V2→V3 migrations should also run before DDL (they already reference old names and are guarded by existence checks).

- [ ] **Step 7: Update schema test file**

`tests/db/schema.test.ts` has 30+ references to `curators` table name and `curator_id` column name in assertions and test data. Update all to use new names (`agents`, `agent_id`).

- [ ] **Step 8: Run tests to verify schema changes compile**

Run: `npx tsc --noEmit 2>&1 | head -50`
Expected: Type errors in files referencing old names (this is correct — Layer 2 fixes them). Schema file itself should have no errors.

- [ ] **Step 9: Commit Layer 1 schema changes**

```bash
git add src/db/schema.ts tests/db/schema.test.ts
git commit -m "refactor: rename curators→agents in DB schema, add v3→v4 migration"
```

---

### Task 2: Update Constants

**Files:**
- Modify: `src/constants.ts:148-152` (curator ID constants)

- [ ] **Step 1: Rename curator constants**

In `src/constants.ts`:
- Line 148: `DEFAULT_CURATOR_ID = 'myco-curator'` → `DEFAULT_AGENT_ID = 'myco-agent'`
- Line 150: `USER_CURATOR_ID = 'user'` → `USER_AGENT_ID = 'user'` (value stays same, name changes)
- Line 152: `USER_CURATOR_NAME = 'User (MCP)'` → `USER_AGENT_NAME = 'User (MCP)'` (value stays same)

Also grep for `CURATION_CLUSTER_SIMILARITY` and rename to `AGENT_CLUSTER_SIMILARITY`.

- [ ] **Step 2: Commit**

```bash
git add src/constants.ts
git commit -m "refactor: rename curator constants to agent"
```

---

### Task 3: Update Config Schema

**Files:**
- Modify: `src/config/schema.ts:21-39`

- [ ] **Step 1: Rename CurationSchema → AgentSchema**

In `src/config/schema.ts`:
- Lines 21-26: Rename `CurationSchema` → `AgentSchema`. Update JSDoc from "curator" to "agent" language.
- Line 34: Change config key from `curation: CurationSchema` → `agent: AgentSchema`
- Add a Zod preprocess or `.transform()` to map old `curation` key to `agent` for existing myco.yaml files.

The actual schema structure is:

```typescript
const AgentSchema = z.object({
  /** Whether the daemon automatically runs the agent on unprocessed batches. */
  auto_run: z.boolean().default(true),
  /** Seconds between agent timer checks. */
  interval_seconds: z.number().int().positive().default(300),
});

export const MycoConfigSchema = z.preprocess(
  (raw: unknown) => {
    // Migrate old config key: curation → agent
    if (raw && typeof raw === 'object' && 'curation' in raw && !('agent' in raw)) {
      const { curation, ...rest } = raw as Record<string, unknown>;
      return { ...rest, agent: curation };
    }
    return raw;
  },
  z.object({
    version: z.literal(3),
    config_version: z.number().int().nonnegative().default(0),
    embedding: EmbeddingProviderSchema.default(() => EmbeddingProviderSchema.parse({})),
    daemon: DaemonSchema.default(() => DaemonSchema.parse({})),
    capture: CaptureSchema.default(() => CaptureSchema.parse({})),
    agent: AgentSchema.default(() => AgentSchema.parse({})),
  }),
);
```

- [ ] **Step 2: Commit**

```bash
git add src/config/schema.ts
git commit -m "refactor: rename CurationSchema→AgentSchema, add curation→agent config migration"
```

---

### Task 4: Update Agent Types

**Files:**
- Modify: `src/agent/types.ts`

- [ ] **Step 1: Rename all curatorId references**

In `src/agent/types.ts`:
- Line 47: `curatorId` → `agentId` in `EffectiveConfig`
- Line 60: `curatorId` → `agentId` in `RunOptions`
- Any type names containing "curator" → "agent"

- [ ] **Step 2: Commit**

```bash
git add src/agent/types.ts
git commit -m "refactor: rename curatorId→agentId in agent types"
```

---

## Layer 2: Code References

### Task 5: Rename DB Query Files and Update Query Functions

This is the largest single task — all DB query modules reference `curator_id`.

**Files:**
- Rename: `src/db/queries/curators.ts` → `src/db/queries/agents.ts`
- Modify: `src/db/queries/agents.ts` (all function/type/column names)
- Modify: `src/db/queries/spores.ts`, `entities.ts`, `edges.ts`, `agent-state.ts`, `digest-extracts.ts`, `resolution-events.ts`, `runs.ts`, `reports.ts`, `turns.ts`, `tasks.ts`, `embeddings.ts`
- Rename: `tests/db/queries/curators.test.ts` → `tests/db/queries/agents.test.ts`

- [ ] **Step 1: Rename and update curators.ts → agents.ts**

Rename file. Then update contents:
- `CuratorInsert` → `AgentInsert`
- `CuratorRow` → `AgentRow`
- `CURATOR_COLUMNS` → `AGENT_COLUMNS`
- All SQL referencing `curators` table → `agents`
- `registerCurator` → `registerAgent`
- `getCurator` → `getAgent`
- `listCurators` → `listAgents`
- All `curator_id` in SQL strings → `agent_id`

- [ ] **Step 2: Update all other query files**

For each file in `src/db/queries/`: replace `curator_id` with `agent_id` in SQL strings, parameter names, and TypeScript types. Also update imports from `./curators` to `./agents`.

Key file: `src/db/queries/embeddings.ts` — the `TABLE_SELECT_COLUMNS` at line 45 has hardcoded `'curator_id'` for spores. Change to `'agent_id'`.

Key file: `src/db/queries/agent-state.ts` — `getStatesForCurator` → `getStatesForAgent`.

- [ ] **Step 3: Rename and update test file**

Rename `tests/db/queries/curators.test.ts` → `tests/db/queries/agents.test.ts`. Update all internal references.

- [ ] **Step 4: Update all other test files**

For each test file referencing `curator_id` or curator functions (16 files): update references to use new names. Update imports.

- [ ] **Step 5: Run tests**

Run: `make test`
Expected: Many failures from files not yet updated (executor, loader, daemon, etc.). DB query tests should pass.

- [ ] **Step 6: Commit**

```bash
git add src/db/queries/ tests/db/queries/
git commit -m "refactor: rename curator→agent in all DB query modules and tests"
```

---

### Task 6: Update Agent Executor, Loader, Context, and Tools

**Files:**
- Modify: `src/agent/executor.ts`, `src/agent/loader.ts`, `src/agent/context.ts`, `src/agent/tools.ts`
- Modify: `tests/agent/executor.test.ts`, `tests/agent/loader.test.ts`, `tests/agent/context.test.ts`, `tests/agent/tools.test.ts`

- [ ] **Step 1: Update executor.ts**

- Import `DEFAULT_AGENT_ID` instead of `DEFAULT_CURATOR_ID`
- `runCurationAgent` → `runAgent`
- All `curatorId` variables → `agentId`
- `getCurator()` → `getAgent()`
- `getRunningRun(curatorId)` → `getRunningRun(agentId)`
- `createVaultToolServer(curatorId, runId)` → `createVaultToolServer(agentId, runId)`
- `buildVaultContext(curatorId)` → `buildVaultContext(agentId)`
- `curator_id: curatorId` in run record → `agent_id: agentId`

- [ ] **Step 2: Update loader.ts**

- Import `DEFAULT_AGENT_ID` instead of `DEFAULT_CURATOR_ID`
- `registerBuiltInCuratorsAndTasks` → `registerBuiltInAgentsAndTasks`
- `registerCurator` → `registerAgent`
- All `curatorId` → `agentId`
- Update log messages from "curator" to "agent"

- [ ] **Step 3: Update context.ts**

- `buildVaultContext(curatorId: string)` → `buildVaultContext(agentId: string)`
- `getStatesForCurator(curatorId)` → `getStatesForAgent(agentId)`
- `getLastDigestTimestamp(curatorId: string)` → `getLastDigestTimestamp(agentId: string)`
- SQL: `curator_id = $1` → `agent_id = $1`

- [ ] **Step 4: Update tools.ts**

- `curatorId` closure variable → `agentId`
- `createVaultToolServer(curatorId, runId)` → `createVaultToolServer(agentId, runId)`
- All tool implementations injecting `curator_id` → `agent_id`
- `recordTurn` calls: `curator_id` → `agent_id`

- [ ] **Step 5: Update test files**

Update `tests/agent/executor.test.ts`, `loader.test.ts`, `context.test.ts`, `tools.test.ts` — replace all curator references with agent equivalents.

- [ ] **Step 6: Run tests**

Run: `make test`
Expected: Agent module tests should pass. Remaining failures from daemon, CLI, UI, services.

- [ ] **Step 7: Commit**

```bash
git add src/agent/ tests/agent/
git commit -m "refactor: rename curator→agent in agent executor, loader, context, tools"
```

---

### Task 7: Update CLI and Services

**Files:**
- Modify: `src/cli.ts:79` (curate command dispatch)
- Rename: `src/cli/curate.ts` → `src/cli/agent-run.ts`
- Modify: `src/cli/stats.ts`
- Modify: `src/services/stats.ts`

- [ ] **Step 1: Rename CLI command**

In `src/cli.ts`:
- Line 23 (USAGE string): `curate [options]` → `agent [options]`, and "Run the curation agent" → "Run the intelligence agent"
- Line 79: `case 'curate':` → `case 'agent':`
- Update the dynamic import path from `./cli/curate.js` to `./cli/agent-run.js`

- [ ] **Step 2: Rename and update curate.ts → agent-run.ts**

Rename file. Update contents:
- `runCurationAgent` → `runAgent`
- Update import path from `../agent/executor.js`
- Update console.log messages from "curation" to "agent"

- [ ] **Step 3: Update stats service**

In `src/services/stats.ts`:
- `V2Stats.curator` → `V2Stats.agent` (the response key)
- All internal references to curator stats → agent stats
- SQL queries already reference `agent_runs` table (unchanged), just the TypeScript property name changes

In `src/cli/stats.ts`:
- Update any display of curator stats to say "agent"

- [ ] **Step 4: Commit**

```bash
git add src/cli.ts src/cli/curate.ts src/cli/agent-run.ts src/cli/stats.ts src/services/stats.ts
git commit -m "refactor: rename myco curate→myco agent CLI command, update stats service"
```

---

### Task 8: Update Daemon

**Files:**
- Modify: `src/daemon/main.ts` (registration ~line 269, API routes ~line 825, curation timer ~line 1075)
- Modify: `src/daemon/api/mycelium.ts`

- [ ] **Step 1: Update built-in registration**

At `src/daemon/main.ts` ~line 269-277:
- `registerBuiltInCuratorsAndTasks` → `registerBuiltInAgentsAndTasks`
- Log messages: "curators" → "agents"

- [ ] **Step 2: Update API routes**

At ~lines 825-883:
- POST `/api/agent/run`: `curatorId` param → `agentId`
- GET `/api/agent/tasks`: `curator_id` query param → `agent_id`, `DEFAULT_CURATOR_ID` → `DEFAULT_AGENT_ID`
- `runCurationAgent` → `runAgent`
- Import path updates

- [ ] **Step 3: Update curation timer**

At ~lines 1075-1098:
- `config.curation.auto_run` → `config.agent.auto_run`
- `config.curation.interval_seconds` → `config.agent.interval_seconds`
- `curationTimer` variable → `agentTimer`
- `runCurationAgent` → `runAgent`
- Log messages: "curation" → "agent"

- [ ] **Step 4: Update MCP proxy routes in daemon**

In `src/daemon/main.ts` ~lines 906-1046 (the MCP proxy section — remember, supersede, and other MCP-proxied routes):
- `USER_CURATOR_ID` → `USER_AGENT_ID`
- `USER_CURATOR_NAME` → `USER_AGENT_NAME`
- `registerCurator` → `registerAgent`
- Raw SQL strings with `curator_id` → `agent_id`

- [ ] **Step 5: Update mycelium API**

In `src/daemon/api/mycelium.ts`:
- All `curator_id` query params → `agent_id`
- Import updates

- [ ] **Step 6: Commit**

```bash
git add src/daemon/
git commit -m "refactor: rename curator→agent in daemon registration, routes, timer"
```

---

### Task 9: Rename Agent Definition and Task YAML Files

**Files:**
- Rename: `src/agent/definitions/curator.yaml` → `src/agent/definitions/agent.yaml`
- Modify: `src/agent/definitions/agent.yaml` (name field)
- Modify: All 7 files in `src/agent/definitions/tasks/` (agent field)

- [ ] **Step 1: Rename and update agent definition**

Rename `curator.yaml` → `agent.yaml`. Update contents:
- `name: myco-curator` → `name: myco-agent`
- `systemPromptPath: ../prompts/curator.md` → `systemPromptPath: ../prompts/agent.md`
- Update comments from "curator" to "agent"

- [ ] **Step 2: Update all task YAML files**

In each of the 7 task files, change:
- `agent: myco-curator` → `agent: myco-agent`

Files: `full-intelligence.yaml`, `title-summary.yaml`, `review-session.yaml`, `extract-only.yaml`, `digest-only.yaml`, `graph-maintenance.yaml`, `supersession-sweep.yaml`

- [ ] **Step 3: Update loader to reference new filename**

In `src/agent/loader.ts`, if the definition filename is hardcoded (e.g., `curator.yaml`), update to `agent.yaml`.

- [ ] **Step 4: Commit**

```bash
git add src/agent/definitions/ src/agent/prompts/ src/agent/loader.ts
git commit -m "refactor: rename curator.yaml→agent.yaml, update all task definitions"
```

---

### Task 10: Update UI Components and Hooks

**Files:**
- Rename: `ui/src/components/dashboard/CuratorStatus.tsx` → `AgentStatus.tsx`
- Modify: `ui/src/components/dashboard/DataFlow.tsx`, `ActivityFeed.tsx`
- Modify: `ui/src/components/mycelium/SporeList.tsx`, `SporeDetail.tsx`, `GraphExplorer.tsx`, `DigestView.tsx`
- Modify: `ui/src/hooks/use-spores.ts`, `use-agent.ts`, `use-config.ts`, `use-daemon.ts`
- Modify: `ui/src/pages/Settings.tsx`

- [ ] **Step 1: Rename CuratorStatus component**

Rename file. Update component name, props, and all internal `curator` references to `agent`. Update the stats key from `stats.curator` to `stats.agent`.

- [ ] **Step 2: Update dashboard components**

In `DataFlow.tsx`: `stats.curator.last_run_status` → `stats.agent.last_run_status`, etc. Display label "Curation" → "Agent".

In `ActivityFeed.tsx`: update any curator references.

- [ ] **Step 3: Update mycelium components**

In all mycelium components: `curator_id` in API params and display → `agent_id`.

- [ ] **Step 4: Update React hooks**

- `use-config.ts`: `curation` config key → `agent`
- `use-daemon.ts`: curator status references → agent
- `use-agent.ts`: `curator_id` params → `agent_id`
- `use-spores.ts`: `curator_id` params → `agent_id`

- [ ] **Step 5: Update Settings page**

In `ui/src/pages/Settings.tsx`:
- `curationAutoRun` → `agentAutoRun`
- `curationIntervalSeconds` → `agentIntervalSeconds`
- `curation` config key in API calls → `agent`
- Display labels: "Curation" → "Agent"

- [ ] **Step 6: Update any component importing CuratorStatus**

Search for imports of `CuratorStatus` and update to `AgentStatus`.

- [ ] **Step 7: Commit**

```bash
git add ui/
git commit -m "refactor: rename curator→agent across all UI components, hooks, and pages"
```

---

### Task 11: Update MCP Tools, Skills, and Documentation

**Files:**
- Modify: `src/mcp/tools/remember.ts`
- Modify: `tests/context/injector.test.ts`
- Modify: `skills/myco-curate/SKILL.md`, `skills/myco/SKILL.md`, `skills/myco/references/wisdom.md`, `skills/myco/references/cli-usage.md`
- Modify: `src/prompts/digest-system.md`
- Modify: `docs/agent-tools.md`, `docs/quickstart.md`, `docs/lifecycle.md`, `README.md`

- [ ] **Step 1: Update MCP tool**

In `src/mcp/tools/remember.ts`: replace `curator_id` references with `agent_id`.

- [ ] **Step 2: Update remaining test files**

`tests/context/injector.test.ts` and any other test files not yet updated.

- [ ] **Step 3: Update skills**

In `skills/myco-curate/SKILL.md`: update all "curator/curation" terminology to "agent/intelligence".
In `skills/myco/SKILL.md`, `skills/myco/references/wisdom.md`, and `skills/myco/references/cli-usage.md`: same. The cli-usage file references the `curate` command — update to `agent`.

- [ ] **Step 4: Update prompts**

In `src/prompts/digest-system.md`: replace "curate" language (e.g., "curate what matters most") with "agent/intelligence" terminology.

- [ ] **Step 5: Update documentation**

Update `docs/agent-tools.md`, `docs/quickstart.md`, `docs/lifecycle.md`, `README.md` — replace "curator/curation" with "agent/intelligence".

- [ ] **Step 6: Run full verification**

Run: `grep -ri 'curator\|curation' src/ tests/ ui/ skills/ docs/ --include='*.ts' --include='*.tsx' --include='*.md' --include='*.yaml' --include='*.yml' | grep -v node_modules | grep -v dist | grep -v 'agent-rename-pipeline-fix'`
Expected: Zero results (excluding spec/plan docs).

Run: `make check`
Expected: PASS (lint + tests).

- [ ] **Step 7: Commit**

```bash
git add src/mcp/ src/prompts/ tests/ skills/ docs/ README.md
git commit -m "refactor: complete curator→agent rename in MCP tools, prompts, skills, docs, remaining tests"
```

---

## Layer 3: Prompts, Tasks & Behavioral Fixes

### Task 12: Update Agent System Prompt

**Files:**
- Rename: `src/agent/prompts/curator.md` → `src/agent/prompts/agent.md`
- Modify contents for terminology AND behavioral fixes

- [ ] **Step 1: Rename file**

Rename `curator.md` → `agent.md`.

- [ ] **Step 2: Update terminology throughout**

Replace all instances of "curator/curation" with "agent/intelligence" in the prompt text. Update the identity section from "You are the Myco curation agent" to "You are the Myco intelligence agent."

- [ ] **Step 3: Strengthen session summary generation criteria**

In the Processing Protocol section (~lines 100-109), replace the vague "Update session title/summary if batch significantly changes narrative" with concrete criteria:

```markdown
### Session Summary Updates

After processing batches for a session, evaluate whether the session summary needs updating.

**Update is REQUIRED when:**
- The session has no title or summary yet (always generate on first encounter)
- New tools or files appear that are not captured in the existing summary
- The session scope expanded beyond what the current summary describes
- 3 or more new batches have been processed since the last summary update

**When updating:** Provide BOTH title and summary via `vault_update_session`.
- Title: concise (under 80 characters), reflects the full session scope — not just the first prompt
- Summary: 2-4 sentences capturing key work done, tools used, files affected, and outcomes

**When skipping:** If no update criteria are met, report your reasoning via `vault_report` with action "skip" and a summary explaining why the existing title/summary is still accurate.
```

- [ ] **Step 4: Add search fallback guidance**

Add to the Processing Protocol, in the supersession section:

```markdown
If `vault_search` returns no results (embedding unavailable or no similar spores found), report this via `vault_report` with action "skip" and continue processing. Do not skip supersession checks entirely — use `vault_spores` to manually review recent spores of the same observation type as a fallback.
```

- [ ] **Step 5: Review remaining prompt sections**

Read through the entire prompt and verify:
- Observation type definitions are specific enough (gotcha, decision, discovery, trade_off, bug_fix)
- Entity types cover the domain (component, concept, file, bug, decision, tool, person)
- Relationship types are clear (DISCOVERED_IN, AFFECTS, RESOLVED_BY, SUPERSEDES, RELATES_TO, CONTRADICTS, CAUSED_BY, DEPENDS_ON)
- Digest tier instructions differentiate tiers (1500 = headline summary, 3000 = key decisions + gotchas, 5000 = full context, 7500/10000 = comprehensive)
- Exit behavior is correct

Flag any issues found and fix them. If everything looks sound, move on.

- [ ] **Step 6: Commit**

```bash
git add src/agent/prompts/
git commit -m "refactor: rename curator.md→agent.md, strengthen summary generation criteria"
```

---

### Task 13: Update Task Definition Prompts

**Files:**
- Modify: All 7 files in `src/agent/definitions/tasks/`

- [ ] **Step 1: Review and update full-intelligence.yaml**

This is the default task. Verify the prompt explicitly mentions session summary generation as a required step. If it doesn't, add it:

```yaml
prompt: >
  Process all unprocessed prompt batches and sessions. For each batch:
  extract observations as spores, identify entities and relationships for the
  knowledge graph, and check for supersession against existing spores.
  For each session touched, evaluate and update the session title and summary
  per the summary update criteria. After processing all new data, regenerate
  digest extracts if the substrate has changed.
```

- [ ] **Step 2: Review title-summary.yaml**

Verify `toolOverrides` include everything needed: `query_sessions`, `query_unprocessed` (to read batches), `get_agent_state`, `update_session_summary`, `set_agent_state`. Add `query_unprocessed` if missing — the agent needs to read prompt batches to generate good summaries.

- [ ] **Step 3: Review extract-only.yaml**

Verify it mentions summary updates in the prompt (it should, since it processes batches).

- [ ] **Step 4: Review remaining tasks**

- `review-session.yaml`: should mention summary generation
- `digest-only.yaml`: should NOT mention summary generation (correct scope)
- `graph-maintenance.yaml`: should NOT mention summary generation (correct scope)
- `supersession-sweep.yaml`: should NOT mention summary generation (correct scope)

- [ ] **Step 5: Commit**

```bash
git add src/agent/definitions/tasks/
git commit -m "refactor: update task prompts for mandatory summary generation"
```

---

### Task 14: Update Tool Descriptions

**Files:**
- Modify: `src/agent/tools.ts` (tool description strings only)

- [ ] **Step 1: Update vault_update_session description**

At `src/agent/tools.ts` ~line 334, improve the description:

```typescript
'Update a session title and/or summary. When generating for the first time, provide BOTH title and summary. Title should be under 80 characters and reflect the full session scope.',
```

- [ ] **Step 2: Update vault_search description**

At ~line 155, clarify fallback:

```typescript
'Semantic similarity search across vault content. Returns ranked results by cosine similarity. If no embeddings are available, returns an empty result set — use vault_spores or vault_sessions as a fallback.',
```

- [ ] **Step 3: Update vault_report description**

At ~line 410, clarify skip reporting:

```typescript
'Record an observability report for the current run. Use action "skip" when skipping expected operations (e.g., not updating a session summary) with reasoning in the summary field.',
```

- [ ] **Step 4: Commit**

```bash
git add src/agent/tools.ts
git commit -m "refactor: improve tool descriptions for session summary and search fallback"
```

---

### Task 15: Fix Embedding Worker — Filter Summary-less Sessions

**Files:**
- Modify: `src/db/queries/embeddings.ts:258-280` (getUnembedded function)
- Modify: `tests/db/queries/embeddings.test.ts`

- [ ] **Step 1: Write failing test**

In `tests/db/queries/embeddings.test.ts`, add a test that verifies `getUnembedded('sessions')` does NOT return sessions without summaries:

```typescript
it('should not return sessions without summaries for embedding', async () => {
  // Insert a session with no summary
  await db.query(`INSERT INTO sessions (id, agent, started_at, created_at) VALUES ('no-summary', 'test', $1, $1)`, [Date.now()]);
  // Insert a session with a summary
  await db.query(`INSERT INTO sessions (id, agent, started_at, created_at, summary) VALUES ('has-summary', 'test', $1, $1, 'A useful summary')`, [Date.now()]);

  const rows = await getUnembedded('sessions');
  const ids = rows.map(r => r.id);
  expect(ids).not.toContain('no-summary');
  expect(ids).toContain('has-summary');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/db/queries/embeddings.test.ts -t "should not return sessions without summaries"`
Expected: FAIL (getUnembedded currently returns all sessions without embeddings regardless of summary)

- [ ] **Step 3: Implement the fix**

In `src/db/queries/embeddings.ts`, in the `getUnembedded()` function (~line 258-280), add a conditional WHERE clause for the sessions table:

```typescript
const summaryFilter = table === 'sessions' ? ' AND summary IS NOT NULL' : '';
const sql = `SELECT id, created_at FROM ${table} WHERE embedding IS NULL${summaryFilter} ORDER BY created_at ASC LIMIT $1`;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/db/queries/embeddings.test.ts -t "should not return sessions without summaries"`
Expected: PASS

- [ ] **Step 5: Run full test suite**

Run: `make check`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/db/queries/embeddings.ts tests/db/queries/embeddings.test.ts
git commit -m "fix: skip sessions without summaries in embedding worker queue"
```

---

## Verification

### Task 16: Full Pipeline Verification

This task verifies the complete pipeline works end-to-end after all code changes.

**Files:** No file changes — runtime testing only.

- [ ] **Step 1: Build**

Run: `make build`
Expected: Clean build, no errors.

- [ ] **Step 2: Restart daemon**

Run: `myco-dev restart`
Expected: Daemon starts, migration runs (if needed), built-in agent registered.

- [ ] **Step 3: Verify migration ran**

Check daemon logs for migration output. Verify the `agents` table exists and `curators` does not:

Run: `myco-dev stats`
Expected: Stats output shows agent info under `agent` key (not `curator`).

- [ ] **Step 4: Verify post-rename grep**

Run: `grep -ri 'curator\|curation' src/ tests/ ui/ skills/ docs/ --include='*.ts' --include='*.tsx' --include='*.md' --include='*.yaml' --include='*.yml' | grep -v node_modules | grep -v dist | grep -v 'agent-rename-pipeline-fix'`
Expected: Zero results (excluding the spec/plan docs themselves).

- [ ] **Step 5: Check embedding queue**

Run: `myco-dev stats`
Look at embedding section: `queue_depth`, `embedded_count`, `total_embeddable`. Verify queue is draining.

- [ ] **Step 6: Test semantic search**

Run: `myco-dev search "plugin migration"` (or any query matching known spore content)
Expected: Returns results with similarity scores > 0.3.

If no results: check if embeddings exist (`embedded_count > 0`), check if the search threshold is appropriate, check embedding provider availability.

- [ ] **Step 7: Trigger agent run**

Run: `myco-dev agent --task full-intelligence`
Watch logs for:
- Agent processes unprocessed batches
- `vault_update_session` appears in audit trail (check via dashboard or `myco-dev stats`)
- Spores created
- Digest extracts generated

- [ ] **Step 8: Verify session summaries generated**

After agent run completes, check sessions in the dashboard or via API:
- Sessions that were processed should now have title and summary
- Titles should reflect actual session content, not just the first prompt

- [ ] **Step 9: Verify summaries get embedded**

Wait 30-60 seconds for embedding worker cycle. Check embedding queue — new summaries should be embedded. Run semantic search with a session-related query to verify sessions appear in results.

- [ ] **Step 10: Final commit (if any fixups needed)**

If any issues were found and fixed during verification, commit them.
