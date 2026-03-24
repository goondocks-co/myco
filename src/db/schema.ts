/**
 * PGlite database schema — all capture, intelligence, and agent state tables.
 *
 * Uses `CREATE TABLE IF NOT EXISTS` and `CREATE INDEX IF NOT EXISTS` throughout
 * for idempotency. Running `createSchema()` multiple times is always safe.
 *
 * Timestamp convention: all timestamps are INTEGER (Unix epoch seconds).
 * Content hashing: all `content_hash` columns are TEXT with UNIQUE constraint.
 * Embedding dimensions: 1024 (bge-m3 default).
 */

import type { PGlite } from '@electric-sql/pglite';
import { epochSeconds } from '@myco/constants.js';
import {
  EDGE_TYPE_FROM_SESSION,
  EDGE_TYPE_EXTRACTED_FROM,
} from '@myco/db/queries/lineage.js';

/** Current schema version — increment on breaking changes. */
export const SCHEMA_VERSION = 5;

/** Previous schema version (for migration guard). */
export const PREVIOUS_SCHEMA_VERSION = 4;

/** Embedding vector dimensions (bge-m3 default). */
export const EMBEDDING_DIMENSIONS = 1024;

/** Legacy agent ID from the "curator" era — used in data migrations. */
const LEGACY_AGENT_ID = 'myco-curator';

/** Current agent ID — the rename target for legacy rows. */
const CURRENT_AGENT_ID = 'myco-agent';

// ---------------------------------------------------------------------------
// DDL statements
// ---------------------------------------------------------------------------

const SCHEMA_VERSION_TABLE = `
  CREATE TABLE IF NOT EXISTS schema_version (
    version   INTEGER PRIMARY KEY,
    applied_at INTEGER NOT NULL
  )`;

// -- Capture Layer ----------------------------------------------------------

const SESSIONS_TABLE = `
  CREATE TABLE IF NOT EXISTS sessions (
    id                     TEXT PRIMARY KEY,
    agent                  TEXT NOT NULL,
    "user"                 TEXT,
    project_root           TEXT,
    branch                 TEXT,
    started_at             INTEGER NOT NULL,
    ended_at               INTEGER,
    status                 TEXT DEFAULT 'active',
    prompt_count           INTEGER DEFAULT 0,
    tool_count             INTEGER DEFAULT 0,
    title                  TEXT,
    summary                TEXT,
    transcript_path        TEXT,
    parent_session_id      TEXT,
    parent_session_reason  TEXT,
    processed              INTEGER DEFAULT 0,
    content_hash           TEXT UNIQUE,
    created_at             INTEGER NOT NULL,
    embedding              vector(${EMBEDDING_DIMENSIONS})
  )`;

const PROMPT_BATCHES_TABLE = `
  CREATE TABLE IF NOT EXISTS prompt_batches (
    id                SERIAL PRIMARY KEY,
    session_id        TEXT NOT NULL REFERENCES sessions(id),
    prompt_number     INTEGER,
    user_prompt       TEXT,
    response_summary  TEXT,
    classification    TEXT,
    started_at        INTEGER,
    ended_at          INTEGER,
    status            TEXT DEFAULT 'active',
    activity_count    INTEGER DEFAULT 0,
    processed         INTEGER DEFAULT 0,
    content_hash      TEXT UNIQUE,
    created_at        INTEGER NOT NULL,
    embedding         vector(${EMBEDDING_DIMENSIONS}),
    search_vector     tsvector
  )`;

const ACTIVITIES_TABLE = `
  CREATE TABLE IF NOT EXISTS activities (
    id                   SERIAL PRIMARY KEY,
    session_id           TEXT NOT NULL REFERENCES sessions(id),
    prompt_batch_id      INTEGER REFERENCES prompt_batches(id),
    tool_name            TEXT NOT NULL,
    tool_input           TEXT,
    tool_output_summary  TEXT,
    file_path            TEXT,
    files_affected       TEXT,
    duration_ms          INTEGER,
    success              INTEGER DEFAULT 1,
    error_message        TEXT,
    timestamp            INTEGER NOT NULL,
    processed            INTEGER DEFAULT 0,
    content_hash         TEXT UNIQUE,
    created_at           INTEGER NOT NULL,
    search_vector        tsvector
  )`;

const PLANS_TABLE = `
  CREATE TABLE IF NOT EXISTS plans (
    id          TEXT PRIMARY KEY,
    status      TEXT DEFAULT 'active',
    author      TEXT,
    title       TEXT,
    content     TEXT,
    source_path TEXT,
    tags        TEXT,
    processed   INTEGER DEFAULT 0,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER,
    embedding   vector(${EMBEDDING_DIMENSIONS})
  )`;

const ARTIFACTS_TABLE = `
  CREATE TABLE IF NOT EXISTS artifacts (
    id               TEXT PRIMARY KEY,
    artifact_type    TEXT,
    source_path      TEXT NOT NULL,
    title            TEXT NOT NULL,
    content          TEXT,
    last_captured_by TEXT,
    tags             TEXT,
    created_at       INTEGER NOT NULL,
    updated_at       INTEGER,
    embedding        vector(${EMBEDDING_DIMENSIONS})
  )`;

const TEAM_MEMBERS_TABLE = `
  CREATE TABLE IF NOT EXISTS team_members (
    id      TEXT PRIMARY KEY,
    "user"  TEXT NOT NULL,
    role    TEXT,
    joined  TEXT,
    tags    TEXT
  )`;

const ATTACHMENTS_TABLE = `
  CREATE TABLE IF NOT EXISTS attachments (
    id              TEXT PRIMARY KEY,
    session_id      TEXT REFERENCES sessions(id),
    prompt_batch_id INTEGER REFERENCES prompt_batches(id),
    file_path       TEXT NOT NULL,
    media_type      TEXT,
    description     TEXT,
    created_at      INTEGER NOT NULL
  )`;

// -- Intelligence Layer -----------------------------------------------------

const AGENTS_TABLE = `
  CREATE TABLE IF NOT EXISTS agents (
    id                  TEXT PRIMARY KEY,
    name                TEXT NOT NULL,
    provider            TEXT,
    model               TEXT,
    system_prompt_hash  TEXT,
    config              TEXT,
    source              TEXT NOT NULL DEFAULT 'built-in',
    system_prompt       TEXT,
    max_turns           INTEGER,
    timeout_seconds     INTEGER,
    tool_access         TEXT,
    enabled             INTEGER NOT NULL DEFAULT 1,
    created_at          INTEGER NOT NULL,
    updated_at          INTEGER
  )`;

const SPORES_TABLE = `
  CREATE TABLE IF NOT EXISTS spores (
    id                TEXT PRIMARY KEY,
    agent_id          TEXT NOT NULL REFERENCES agents(id),
    session_id        TEXT REFERENCES sessions(id),
    prompt_batch_id   INTEGER REFERENCES prompt_batches(id),
    observation_type  TEXT NOT NULL,
    status            TEXT DEFAULT 'active',
    content           TEXT NOT NULL,
    context           TEXT,
    importance        INTEGER DEFAULT 5,
    file_path         TEXT,
    tags              TEXT,
    content_hash      TEXT UNIQUE,
    properties        TEXT,
    created_at        INTEGER NOT NULL,
    updated_at        INTEGER,
    embedding         vector(${EMBEDDING_DIMENSIONS})
  )`;

const ENTITIES_TABLE = `
  CREATE TABLE IF NOT EXISTS entities (
    id          TEXT PRIMARY KEY,
    agent_id    TEXT NOT NULL REFERENCES agents(id),
    type        TEXT NOT NULL,
    name        TEXT NOT NULL,
    properties  TEXT,
    first_seen  INTEGER NOT NULL,
    last_seen   INTEGER NOT NULL,
    status      TEXT DEFAULT 'active',
    UNIQUE (agent_id, type, name)
  )`;

const EDGES_TABLE = `
  CREATE TABLE IF NOT EXISTS edges (
    id          SERIAL PRIMARY KEY,
    agent_id    TEXT NOT NULL REFERENCES agents(id),
    source_id   TEXT NOT NULL REFERENCES entities(id),
    target_id   TEXT NOT NULL REFERENCES entities(id),
    type        TEXT NOT NULL,
    valid_from  INTEGER,
    valid_until INTEGER,
    session_id  TEXT,
    confidence  REAL DEFAULT 1.0,
    properties  TEXT,
    created_at  INTEGER NOT NULL
  )`;

const GRAPH_EDGES_TABLE = `
  CREATE TABLE IF NOT EXISTS graph_edges (
    id              TEXT PRIMARY KEY,
    agent_id        TEXT NOT NULL REFERENCES agents(id),
    source_id       TEXT NOT NULL,
    source_type     TEXT NOT NULL,
    target_id       TEXT NOT NULL,
    target_type     TEXT NOT NULL,
    type            TEXT NOT NULL,
    session_id      TEXT,
    confidence      REAL DEFAULT 1.0,
    properties      TEXT,
    created_at      INTEGER NOT NULL
  )`;

const ENTITY_MENTIONS_TABLE = `
  CREATE TABLE IF NOT EXISTS entity_mentions (
    entity_id   TEXT NOT NULL REFERENCES entities(id),
    note_id     TEXT NOT NULL,
    note_type   TEXT NOT NULL,
    agent_id    TEXT NOT NULL REFERENCES agents(id),
    UNIQUE (entity_id, note_id, note_type, agent_id)
  )`;

const RESOLUTION_EVENTS_TABLE = `
  CREATE TABLE IF NOT EXISTS resolution_events (
    id            TEXT PRIMARY KEY,
    agent_id      TEXT NOT NULL REFERENCES agents(id),
    spore_id      TEXT NOT NULL REFERENCES spores(id),
    action        TEXT NOT NULL,
    new_spore_id  TEXT,
    reason        TEXT,
    session_id    TEXT,
    created_at    INTEGER NOT NULL
  )`;

const DIGEST_EXTRACTS_TABLE = `
  CREATE TABLE IF NOT EXISTS digest_extracts (
    id              SERIAL PRIMARY KEY,
    agent_id        TEXT NOT NULL REFERENCES agents(id),
    tier            INTEGER NOT NULL,
    content         TEXT NOT NULL,
    substrate_hash  TEXT,
    generated_at    INTEGER NOT NULL,
    UNIQUE (agent_id, tier)
  )`;

// -- Agent State Layer ------------------------------------------------------

const AGENT_RUNS_TABLE = `
  CREATE TABLE IF NOT EXISTS agent_runs (
    id            TEXT PRIMARY KEY,
    agent_id      TEXT NOT NULL REFERENCES agents(id),
    task          TEXT,
    instruction   TEXT,
    status        TEXT DEFAULT 'pending',
    started_at    INTEGER,
    completed_at  INTEGER,
    tokens_used   INTEGER,
    cost_usd      REAL,
    actions_taken TEXT,
    error         TEXT
  )`;

const AGENT_REPORTS_TABLE = `
  CREATE TABLE IF NOT EXISTS agent_reports (
    id          SERIAL PRIMARY KEY,
    run_id      TEXT NOT NULL REFERENCES agent_runs(id),
    agent_id    TEXT NOT NULL REFERENCES agents(id),
    action      TEXT NOT NULL,
    summary     TEXT NOT NULL,
    details     TEXT,
    created_at  INTEGER NOT NULL
  )`;

const AGENT_TURNS_TABLE = `
  CREATE TABLE IF NOT EXISTS agent_turns (
    id                   SERIAL PRIMARY KEY,
    run_id               TEXT NOT NULL REFERENCES agent_runs(id),
    agent_id             TEXT NOT NULL REFERENCES agents(id),
    turn_number          INTEGER NOT NULL,
    tool_name            TEXT NOT NULL,
    tool_input           TEXT,
    tool_output_summary  TEXT,
    started_at           INTEGER,
    completed_at         INTEGER
  )`;

const AGENT_TASKS_TABLE = `
  CREATE TABLE IF NOT EXISTS agent_tasks (
    id              TEXT PRIMARY KEY,
    agent_id        TEXT NOT NULL REFERENCES agents(id),
    source          TEXT NOT NULL DEFAULT 'built-in',
    display_name    TEXT,
    description     TEXT,
    prompt          TEXT NOT NULL,
    is_default      INTEGER DEFAULT 0,
    tool_overrides  TEXT,
    model           TEXT,
    config          TEXT,
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER
  )`;

const AGENT_STATE_TABLE = `
  CREATE TABLE IF NOT EXISTS agent_state (
    agent_id    TEXT NOT NULL REFERENCES agents(id),
    key         TEXT NOT NULL,
    value       TEXT NOT NULL,
    updated_at  INTEGER NOT NULL,
    PRIMARY KEY (agent_id, key)
  )`;

// -- Indexes ----------------------------------------------------------------

const SECONDARY_INDEXES = [
  // Sessions
  'CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions (status)',
  'CREATE INDEX IF NOT EXISTS idx_sessions_processed ON sessions (processed)',
  'CREATE INDEX IF NOT EXISTS idx_sessions_started_at ON sessions (started_at)',
  'CREATE INDEX IF NOT EXISTS idx_sessions_agent ON sessions (agent)',

  // Prompt batches
  'CREATE INDEX IF NOT EXISTS idx_prompt_batches_session_id ON prompt_batches (session_id)',
  'CREATE INDEX IF NOT EXISTS idx_prompt_batches_processed ON prompt_batches (processed)',
  'CREATE INDEX IF NOT EXISTS idx_prompt_batches_status ON prompt_batches (status)',
  'CREATE INDEX IF NOT EXISTS idx_prompt_batches_search ON prompt_batches USING GIN (search_vector)',

  // Activities
  'CREATE INDEX IF NOT EXISTS idx_activities_session_id ON activities (session_id)',
  'CREATE INDEX IF NOT EXISTS idx_activities_prompt_batch_id ON activities (prompt_batch_id)',
  'CREATE INDEX IF NOT EXISTS idx_activities_tool_name ON activities (tool_name)',
  'CREATE INDEX IF NOT EXISTS idx_activities_timestamp ON activities (timestamp)',
  'CREATE INDEX IF NOT EXISTS idx_activities_processed ON activities (processed)',
  'CREATE INDEX IF NOT EXISTS idx_activities_search ON activities USING GIN (search_vector)',

  // Spores
  'CREATE INDEX IF NOT EXISTS idx_spores_agent_id ON spores (agent_id)',
  'CREATE INDEX IF NOT EXISTS idx_spores_session_id ON spores (session_id)',
  'CREATE INDEX IF NOT EXISTS idx_spores_status ON spores (status)',
  'CREATE INDEX IF NOT EXISTS idx_spores_observation_type ON spores (observation_type)',
  'CREATE INDEX IF NOT EXISTS idx_spores_created_at ON spores (created_at)',

  // Entities
  'CREATE INDEX IF NOT EXISTS idx_entities_agent_id ON entities (agent_id)',
  'CREATE INDEX IF NOT EXISTS idx_entities_type ON entities (type)',

  // Edges
  'CREATE INDEX IF NOT EXISTS idx_edges_agent_id ON edges (agent_id)',
  'CREATE INDEX IF NOT EXISTS idx_edges_source_id ON edges (source_id)',
  'CREATE INDEX IF NOT EXISTS idx_edges_target_id ON edges (target_id)',
  'CREATE INDEX IF NOT EXISTS idx_edges_type ON edges (type)',

  // Graph edges
  'CREATE INDEX IF NOT EXISTS idx_graph_edges_source ON graph_edges (source_id, source_type)',
  'CREATE INDEX IF NOT EXISTS idx_graph_edges_target ON graph_edges (target_id, target_type)',
  'CREATE INDEX IF NOT EXISTS idx_graph_edges_type ON graph_edges (type)',
  'CREATE INDEX IF NOT EXISTS idx_graph_edges_agent ON graph_edges (agent_id)',
  'CREATE INDEX IF NOT EXISTS idx_graph_edges_source_type ON graph_edges (source_id, type)',

  // Entity mentions
  'CREATE INDEX IF NOT EXISTS idx_entity_mentions_entity_id ON entity_mentions (entity_id)',
  'CREATE INDEX IF NOT EXISTS idx_entity_mentions_agent_id ON entity_mentions (agent_id)',

  // Resolution events
  'CREATE INDEX IF NOT EXISTS idx_resolution_events_spore_id ON resolution_events (spore_id)',
  'CREATE INDEX IF NOT EXISTS idx_resolution_events_agent_id ON resolution_events (agent_id)',

  // Digest extracts
  'CREATE INDEX IF NOT EXISTS idx_digest_extracts_agent_id ON digest_extracts (agent_id)',

  // Agent runs
  'CREATE INDEX IF NOT EXISTS idx_agent_runs_agent_id ON agent_runs (agent_id)',
  'CREATE INDEX IF NOT EXISTS idx_agent_runs_status ON agent_runs (status)',
  'CREATE INDEX IF NOT EXISTS idx_agent_runs_agent_status ON agent_runs (agent_id, status)',

  // Agent reports
  'CREATE INDEX IF NOT EXISTS idx_agent_reports_run_id ON agent_reports (run_id)',

  // Agent turns
  'CREATE INDEX IF NOT EXISTS idx_agent_turns_run_id ON agent_turns (run_id)',

  // Agent tasks
  'CREATE INDEX IF NOT EXISTS idx_agent_tasks_agent_id ON agent_tasks (agent_id)',
];

const HNSW_INDEXES = [
  `CREATE INDEX IF NOT EXISTS idx_sessions_embedding ON sessions USING hnsw (embedding vector_cosine_ops)`,
  `CREATE INDEX IF NOT EXISTS idx_prompt_batches_embedding ON prompt_batches USING hnsw (embedding vector_cosine_ops)`,
  `CREATE INDEX IF NOT EXISTS idx_spores_embedding ON spores USING hnsw (embedding vector_cosine_ops)`,
  `CREATE INDEX IF NOT EXISTS idx_plans_embedding ON plans USING hnsw (embedding vector_cosine_ops)`,
  `CREATE INDEX IF NOT EXISTS idx_artifacts_embedding ON artifacts USING hnsw (embedding vector_cosine_ops)`,
];

// -- Ordered table creation -------------------------------------------------

const TABLE_DDLS = [
  SCHEMA_VERSION_TABLE,
  // Capture layer (order matters for FK references)
  SESSIONS_TABLE,
  PROMPT_BATCHES_TABLE,
  ACTIVITIES_TABLE,
  PLANS_TABLE,
  ARTIFACTS_TABLE,
  TEAM_MEMBERS_TABLE,
  ATTACHMENTS_TABLE,
  // Intelligence layer
  AGENTS_TABLE,
  SPORES_TABLE,
  ENTITIES_TABLE,
  EDGES_TABLE,
  GRAPH_EDGES_TABLE,
  ENTITY_MENTIONS_TABLE,
  RESOLUTION_EVENTS_TABLE,
  DIGEST_EXTRACTS_TABLE,
  // Agent state layer
  AGENT_RUNS_TABLE,
  AGENT_REPORTS_TABLE,
  AGENT_TURNS_TABLE,
  AGENT_TASKS_TABLE,
  AGENT_STATE_TABLE,
];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Migrations
// ---------------------------------------------------------------------------

/**
 * Check if a column exists on a table via information_schema.
 * Used by migration guards for idempotent ALTER TABLE.
 */
async function columnExists(
  db: PGlite,
  tableName: string,
  columnName: string,
): Promise<boolean> {
  const result = await db.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = $1
         AND column_name = $2
     ) AS exists`,
    [tableName, columnName],
  );
  return result.rows[0].exists;
}

/**
 * Migrate from v1 → v2:
 * - Expand curators table with new columns
 * - Add instruction column to agent_runs
 *
 * New tables (agent_reports, agent_turns, agent_tasks) are created via
 * CREATE TABLE IF NOT EXISTS in the DDL list — no ALTER needed.
 *
 * Idempotent: each ALTER is guarded by a column existence check.
 */
async function migrateV1ToV2(db: PGlite): Promise<void> {
  // -- curators: new columns (only if the table exists — skipped on fresh installs) --
  if (await tableExists(db, 'curators')) {
    const curatorAlters: Array<{ column: string; ddl: string }> = [
      { column: 'source', ddl: `ALTER TABLE curators ADD COLUMN source TEXT NOT NULL DEFAULT 'built-in'` },
      { column: 'system_prompt', ddl: `ALTER TABLE curators ADD COLUMN system_prompt TEXT` },
      { column: 'max_turns', ddl: `ALTER TABLE curators ADD COLUMN max_turns INTEGER` },
      { column: 'timeout_seconds', ddl: `ALTER TABLE curators ADD COLUMN timeout_seconds INTEGER` },
      { column: 'tool_access', ddl: `ALTER TABLE curators ADD COLUMN tool_access TEXT` },
      { column: 'enabled', ddl: `ALTER TABLE curators ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1` },
      { column: 'updated_at', ddl: `ALTER TABLE curators ADD COLUMN updated_at INTEGER` },
    ];

    for (const { column, ddl } of curatorAlters) {
      if (!(await columnExists(db, 'curators', column))) {
        await db.query(ddl);
      }
    }
  }

  // -- agent_runs: instruction column (only if the table exists — skipped on fresh installs) --
  if (await tableExists(db, 'agent_runs') && !(await columnExists(db, 'agent_runs', 'instruction'))) {
    await db.query(`ALTER TABLE agent_runs ADD COLUMN instruction TEXT`);
  }
}

/**
 * Migrate from v2 → v3:
 * - Add search_vector tsvector column to prompt_batches and activities
 * - Add embedding vector column to plans and artifacts
 * - Add GIN indexes for FTS on new tsvector columns
 * - Add HNSW indexes for new embedding columns
 *
 * Idempotent: uses IF NOT EXISTS for indexes and column existence checks for ALTER TABLE.
 */
async function migrateV2ToV3(db: PGlite): Promise<void> {
  // Guard each ALTER with table existence — skipped on fresh installs where
  // these tables don't exist yet (the DDL loop will create them with all columns).
  if (await tableExists(db, 'prompt_batches') && !(await columnExists(db, 'prompt_batches', 'search_vector'))) {
    await db.query('ALTER TABLE prompt_batches ADD COLUMN search_vector tsvector');
  }
  if (await tableExists(db, 'activities') && !(await columnExists(db, 'activities', 'search_vector'))) {
    await db.query('ALTER TABLE activities ADD COLUMN search_vector tsvector');
  }
  if (await tableExists(db, 'plans') && !(await columnExists(db, 'plans', 'embedding'))) {
    await db.query(`ALTER TABLE plans ADD COLUMN embedding vector(${EMBEDDING_DIMENSIONS})`);
  }
  if (await tableExists(db, 'artifacts') && !(await columnExists(db, 'artifacts', 'embedding'))) {
    await db.query(`ALTER TABLE artifacts ADD COLUMN embedding vector(${EMBEDDING_DIMENSIONS})`);
  }

  // GIN indexes for FTS (only if tables exist)
  if (await tableExists(db, 'prompt_batches')) {
    await db.query('CREATE INDEX IF NOT EXISTS idx_prompt_batches_search ON prompt_batches USING GIN (search_vector)');
  }
  if (await tableExists(db, 'activities')) {
    await db.query('CREATE INDEX IF NOT EXISTS idx_activities_search ON activities USING GIN (search_vector)');
  }

  // HNSW indexes for new embedding columns (only if tables exist)
  if (await tableExists(db, 'plans')) {
    await db.query(`CREATE INDEX IF NOT EXISTS idx_plans_embedding ON plans USING hnsw (embedding vector_cosine_ops)`);
  }
  if (await tableExists(db, 'artifacts')) {
    await db.query(`CREATE INDEX IF NOT EXISTS idx_artifacts_embedding ON artifacts USING hnsw (embedding vector_cosine_ops)`);
  }

  // Advance the version row if schema_version table already exists with version 2
  await db.query(`UPDATE schema_version SET version = 3 WHERE version = 2`);
}

/**
 * Check if a table exists in the public schema.
 * Used by migration guards for idempotent ALTER TABLE / RENAME.
 */
async function tableExists(
  db: PGlite,
  tableName: string,
): Promise<boolean> {
  const result = await db.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name = $1
     ) AS exists`,
    [tableName],
  );
  return result.rows[0].exists;
}

/**
 * Check if an index exists in the public schema.
 * Used by migration guards for idempotent index renames.
 */
async function indexExistsInSchema(
  db: PGlite,
  indexName: string,
): Promise<boolean> {
  const result = await db.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM pg_indexes
       WHERE schemaname = 'public'
         AND indexname = $1
     ) AS exists`,
    [indexName],
  );
  return result.rows[0].exists;
}

/**
 * Migrate from v3 → v4:
 * - Rename `curators` table → `agents`
 * - Rename `curator_id` → `agent_id` in 12 tables
 * - Rename all curator-named indexes → agent-named equivalents
 *
 * Idempotent: each operation is guarded by existence checks.
 * Must run BEFORE DDL loop so existing databases get tables renamed
 * before `CREATE TABLE IF NOT EXISTS` with new names runs.
 */
async function migrateV3ToV4(db: PGlite): Promise<void> {
  // -- Step 1: Rename curators table → agents --
  if (await tableExists(db, 'curators')) {
    await db.query('ALTER TABLE curators RENAME TO agents');
  }

  // -- Step 2: Rename curator_id → agent_id in all 12 tables --
  // Tables that have a curator_id column to rename:
  const AGENT_ID_TABLES = [
    'agents',
    'spores',
    'entities',
    'entity_mentions',
    'edges',
    'resolution_events',
    'digest_extracts',
    'agent_runs',
    'agent_reports',
    'agent_turns',
    'agent_tasks',
    'agent_state',
  ] as const;

  for (const table of AGENT_ID_TABLES) {
    if (await columnExists(db, table, 'curator_id')) {
      await db.query(`ALTER TABLE ${table} RENAME COLUMN curator_id TO agent_id`);
    }
  }

  // -- Step 3: Rename curator-named indexes → agent-named equivalents --
  const INDEX_RENAMES: Array<[oldName: string, newName: string]> = [
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

  for (const [oldName, newName] of INDEX_RENAMES) {
    if (await indexExistsInSchema(db, oldName)) {
      await db.query(`ALTER INDEX ${oldName} RENAME TO ${newName}`);
    }
  }

  // -- Step 4: Update agent_id values from old default to new default --
  // The column rename (step 2) preserved values, but the DEFAULT_AGENT_ID
  // constant changed from 'myco-curator' to 'myco-agent'. Update all rows.
  for (const table of AGENT_ID_TABLES) {
    if (await columnExists(db, table, 'agent_id')) {
      await db.query(`UPDATE ${table} SET agent_id = '${CURRENT_AGENT_ID}' WHERE agent_id = '${LEGACY_AGENT_ID}'`);
    }
  }

  // Advance the version row from v3 → v4 (hardcoded — must not use module-level constants)
  await db.query(`UPDATE schema_version SET version = 4 WHERE version = 3`);
}

/**
 * Migrate from v4 → v5:
 * - Add `properties` column to spores
 * - Add `model` column to agent_tasks
 * - Add `status` column to entities
 *
 * The `graph_edges` table is created by the DDL loop (IF NOT EXISTS).
 * Idempotent: each ALTER is guarded by column existence checks.
 */
async function migrateV4ToV5(db: PGlite): Promise<void> {
  // Add properties column to spores
  if (await tableExists(db, 'spores') && !(await columnExists(db, 'spores', 'properties'))) {
    await db.query('ALTER TABLE spores ADD COLUMN properties TEXT');
  }
  // Add model column to agent_tasks
  if (await tableExists(db, 'agent_tasks') && !(await columnExists(db, 'agent_tasks', 'model'))) {
    await db.query('ALTER TABLE agent_tasks ADD COLUMN model TEXT');
  }
  // Add status column to entities
  if (await tableExists(db, 'entities') && !(await columnExists(db, 'entities', 'status'))) {
    await db.query("ALTER TABLE entities ADD COLUMN status TEXT DEFAULT 'active'");
  }
  // Advance the version row from v4 → v5
  await db.query(`UPDATE schema_version SET version = ${SCHEMA_VERSION} WHERE version = ${PREVIOUS_SCHEMA_VERSION}`);
}

/**
 * One-time data fixup: update agent_id values from 'myco-curator' to 'myco-agent'.
 * The v3→v4 migration renamed columns but not values. This runs on every startup
 * and is idempotent — rows already set to 'myco-agent' are unaffected.
 */
async function fixupAgentIdValues(db: PGlite): Promise<void> {
  // Early-exit: if no rows in agents have the legacy ID, nothing to fix
  if (await tableExists(db, 'agents')) {
    const probe = await db.query(
      `SELECT 1 FROM agents WHERE id = $1 LIMIT 1`,
      [LEGACY_AGENT_ID],
    );
    if (probe.rows.length === 0) return;
  }

  const TABLES_WITH_AGENT_ID = [
    'agents', 'spores', 'entities', 'entity_mentions', 'edges',
    'resolution_events', 'digest_extracts', 'agent_runs', 'agent_reports',
    'agent_turns', 'agent_tasks', 'agent_state',
  ] as const;

  for (const table of TABLES_WITH_AGENT_ID) {
    if (await tableExists(db, table) && await columnExists(db, table, 'agent_id')) {
      await db.query(
        `UPDATE ${table} SET agent_id = $1 WHERE agent_id = $2`,
        [CURRENT_AGENT_ID, LEGACY_AGENT_ID],
      );
    }
  }

  // Also fix old task names in agent_runs and agent_tasks
  const OLD_TASK_NAME = 'full-curation';
  const NEW_TASK_NAME = 'full-intelligence';
  if (await tableExists(db, 'agent_runs')) {
    await db.query(
      `UPDATE agent_runs SET task = $1 WHERE task = $2`,
      [NEW_TASK_NAME, OLD_TASK_NAME],
    );
  }
  if (await tableExists(db, 'agent_tasks')) {
    await db.query(
      `UPDATE agent_tasks SET id = $1 WHERE id = $2`,
      [NEW_TASK_NAME, OLD_TASK_NAME],
    );
  }
}

// ---------------------------------------------------------------------------
// Startup fixups (idempotent, run on every startup)
// ---------------------------------------------------------------------------

/** Valid entity types after the graph redesign. */
const VALID_ENTITY_TYPES = ['component', 'concept', 'person'];

/**
 * Backfill lineage edges for existing spores that predate the graph_edges table.
 * Idempotent: uses LEFT JOIN to skip spores that already have edges.
 */
async function backfillSporeLineage(db: PGlite): Promise<void> {
  if (!(await tableExists(db, 'graph_edges')) || !(await tableExists(db, 'spores'))) return;

  // Check if any spores lack FROM_SESSION edges
  const probe = await db.query(
    `SELECT s.id FROM spores s
     LEFT JOIN graph_edges ge ON ge.source_id = s.id AND ge.type = $1
     WHERE s.session_id IS NOT NULL AND ge.id IS NULL
     LIMIT 1`,
    [EDGE_TYPE_FROM_SESSION],
  );
  if (probe.rows.length === 0) return; // All spores already have lineage

  // Backfill FROM_SESSION
  await db.query(
    `INSERT INTO graph_edges (id, agent_id, source_id, source_type, target_id, target_type, type, created_at)
     SELECT gen_random_uuid(), s.agent_id, s.id, 'spore', s.session_id, 'session', $1, s.created_at
     FROM spores s
     LEFT JOIN graph_edges ge ON ge.source_id = s.id AND ge.type = $1
     WHERE s.session_id IS NOT NULL AND ge.id IS NULL`,
    [EDGE_TYPE_FROM_SESSION],
  );

  // Backfill EXTRACTED_FROM
  await db.query(
    `INSERT INTO graph_edges (id, agent_id, source_id, source_type, target_id, target_type, type, created_at)
     SELECT gen_random_uuid(), s.agent_id, s.id, 'spore', CAST(s.prompt_batch_id AS TEXT), 'batch', $1, s.created_at
     FROM spores s
     LEFT JOIN graph_edges ge ON ge.source_id = s.id AND ge.type = $1
     WHERE s.prompt_batch_id IS NOT NULL AND ge.id IS NULL`,
    [EDGE_TYPE_EXTRACTED_FROM],
  );
}

/**
 * Archive entities whose type is not in the valid set (component, concept, person).
 * Idempotent: only updates rows that are still 'active' with invalid types.
 */
async function archiveInvalidEntityTypes(db: PGlite): Promise<void> {
  if (!(await tableExists(db, 'entities')) || !(await columnExists(db, 'entities', 'status'))) return;

  const placeholders = VALID_ENTITY_TYPES.map((_, i) => `$${i + 1}`).join(', ');
  await db.query(
    `UPDATE entities SET status = 'archived' WHERE status = 'active' AND type NOT IN (${placeholders})`,
    VALID_ENTITY_TYPES,
  );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create all database tables, indexes, and record the schema version.
 *
 * Fully idempotent — safe to call on every startup. Uses `IF NOT EXISTS`
 * for all DDL and `ON CONFLICT DO NOTHING` for the version row.
 *
 * Runs migrations for existing databases that are at a prior schema version.
 */
export async function createSchema(db: PGlite): Promise<void> {
  // Fast-path: skip all DDL if schema is already at the current version
  try {
    const versionResult = await db.query<{ version: number }>(
      'SELECT version FROM schema_version ORDER BY version DESC LIMIT 1',
    );
    if (versionResult.rows.length > 0 && versionResult.rows[0].version === SCHEMA_VERSION) {
      // Always run data fixups even on the fast-path (idempotent)
      await fixupAgentIdValues(db);
      await backfillSporeLineage(db);
      await archiveInvalidEntityTypes(db);
      return;
    }
  } catch {
    // Table doesn't exist yet — first run, continue with full DDL
  }

  // Ensure schema_version table exists before running migrations
  // (migrations may UPDATE this table; DDL loop also creates it via IF NOT EXISTS)
  await db.query(SCHEMA_VERSION_TABLE);

  // Run migrations BEFORE DDL loop so existing databases get tables/columns
  // renamed before `CREATE TABLE IF NOT EXISTS` with new names runs.
  // On fresh installs, old tables don't exist so migrations are harmless no-ops.
  await migrateV1ToV2(db);
  await migrateV2ToV3(db);
  await migrateV3ToV4(db);
  await migrateV4ToV5(db);

  // Create tables in dependency order (IF NOT EXISTS — idempotent)
  for (const ddl of TABLE_DDLS) {
    await db.query(ddl);
  }

  // Secondary B-tree indexes
  for (const idx of SECONDARY_INDEXES) {
    await db.query(idx);
  }

  // HNSW vector indexes
  for (const idx of HNSW_INDEXES) {
    await db.query(idx);
  }

  // Record schema version (idempotent — ON CONFLICT DO NOTHING)
  await db.query(
    `INSERT INTO schema_version (version, applied_at)
     VALUES ($1, $2)
     ON CONFLICT (version) DO NOTHING`,
    [SCHEMA_VERSION, epochSeconds()],
  );
}
