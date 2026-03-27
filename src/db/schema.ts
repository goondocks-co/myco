/**
 * SQLite database schema -- all capture, intelligence, and agent state tables.
 *
 * Uses `CREATE TABLE IF NOT EXISTS` and `CREATE INDEX IF NOT EXISTS` throughout
 * for idempotency. Running `createSchema()` multiple times is always safe.
 *
 * Timestamp convention: all timestamps are INTEGER (Unix epoch seconds).
 * Content hashing: all `content_hash` columns are TEXT with UNIQUE constraint.
 * Embedding dimensions: 1024 (bge-m3 default) -- used by external sqlite-vec store.
 *
 * Vector columns live in a separate sqlite-vec virtual table, not inline.
 * Tables that participate in vector search carry an `embedded INTEGER DEFAULT 0`
 * flag so the embedder knows which rows still need vectors.
 */

import type { Database } from 'better-sqlite3';
import { epochSeconds } from '@myco/constants.js';

/** Current schema version -- fresh start for the SQLite era. */
export const SCHEMA_VERSION = 3;

/** Embedding vector dimensions (bge-m3 default). */
export const EMBEDDING_DIMENSIONS = 1024;

// ---------------------------------------------------------------------------
// DDL statements
// ---------------------------------------------------------------------------

const SCHEMA_VERSION_TABLE = `
  CREATE TABLE IF NOT EXISTS schema_version (
    version    INTEGER PRIMARY KEY,
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
    embedded               INTEGER DEFAULT 0
  )`;

const PROMPT_BATCHES_TABLE = `
  CREATE TABLE IF NOT EXISTS prompt_batches (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
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
    created_at        INTEGER NOT NULL
  )`;

const ACTIVITIES_TABLE = `
  CREATE TABLE IF NOT EXISTS activities (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
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
    created_at           INTEGER NOT NULL
  )`;

const PLANS_TABLE = `
  CREATE TABLE IF NOT EXISTS plans (
    id               TEXT PRIMARY KEY,
    status           TEXT DEFAULT 'active',
    author           TEXT,
    title            TEXT,
    content          TEXT,
    source_path      TEXT,
    tags             TEXT,
    session_id       TEXT REFERENCES sessions(id),
    prompt_batch_id  INTEGER REFERENCES prompt_batches(id),
    content_hash     TEXT,
    processed        INTEGER DEFAULT 0,
    created_at       INTEGER NOT NULL,
    updated_at       INTEGER,
    embedded         INTEGER DEFAULT 0
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
    embedded         INTEGER DEFAULT 0
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
    data            BLOB,
    content_hash    TEXT,
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
    embedded          INTEGER DEFAULT 0
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
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
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
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id      TEXT NOT NULL REFERENCES agent_runs(id),
    agent_id    TEXT NOT NULL REFERENCES agents(id),
    action      TEXT NOT NULL,
    summary     TEXT NOT NULL,
    details     TEXT,
    created_at  INTEGER NOT NULL
  )`;

const AGENT_TURNS_TABLE = `
  CREATE TABLE IF NOT EXISTS agent_turns (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
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

// -- Logging Layer ----------------------------------------------------------

const LOG_ENTRIES_TABLE = `
  CREATE TABLE IF NOT EXISTS log_entries (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp   TEXT    NOT NULL,
    level       TEXT    NOT NULL,
    component   TEXT    NOT NULL,
    kind        TEXT    NOT NULL,
    message     TEXT    NOT NULL,
    data        TEXT,
    session_id  TEXT
  )`;

// -- FTS5 Virtual Tables ----------------------------------------------------

const FTS_TABLES = [
  `CREATE VIRTUAL TABLE IF NOT EXISTS prompt_batches_fts
     USING fts5(user_prompt, content='prompt_batches', content_rowid='id')`,

  `CREATE VIRTUAL TABLE IF NOT EXISTS activities_fts
     USING fts5(tool_name, tool_input, file_path, content='activities', content_rowid='id')`,

  `CREATE VIRTUAL TABLE IF NOT EXISTS log_entries_fts
     USING fts5(message, content='log_entries', content_rowid='id')`,

  // FTS5 sync triggers for log_entries (external-content table)
  `CREATE TRIGGER IF NOT EXISTS log_entries_ai AFTER INSERT ON log_entries BEGIN
     INSERT INTO log_entries_fts(rowid, message) VALUES (new.id, new.message);
   END`,

  `CREATE TRIGGER IF NOT EXISTS log_entries_ad AFTER DELETE ON log_entries BEGIN
     INSERT INTO log_entries_fts(log_entries_fts, rowid, message) VALUES('delete', old.id, old.message);
   END`,
];

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

  // Activities
  'CREATE INDEX IF NOT EXISTS idx_activities_session_id ON activities (session_id)',
  'CREATE INDEX IF NOT EXISTS idx_activities_prompt_batch_id ON activities (prompt_batch_id)',
  'CREATE INDEX IF NOT EXISTS idx_activities_tool_name ON activities (tool_name)',
  'CREATE INDEX IF NOT EXISTS idx_activities_timestamp ON activities (timestamp)',
  'CREATE INDEX IF NOT EXISTS idx_activities_processed ON activities (processed)',

  // Spores
  'CREATE INDEX IF NOT EXISTS idx_spores_agent_id ON spores (agent_id)',
  'CREATE INDEX IF NOT EXISTS idx_spores_session_id ON spores (session_id)',
  'CREATE INDEX IF NOT EXISTS idx_spores_status ON spores (status)',
  'CREATE INDEX IF NOT EXISTS idx_spores_observation_type ON spores (observation_type)',
  'CREATE INDEX IF NOT EXISTS idx_spores_created_at ON spores (created_at)',

  // Entities
  'CREATE INDEX IF NOT EXISTS idx_entities_agent_id ON entities (agent_id)',
  'CREATE INDEX IF NOT EXISTS idx_entities_type ON entities (type)',

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

  // Plans
  'CREATE INDEX IF NOT EXISTS idx_plans_session_id ON plans (session_id)',
  'CREATE INDEX IF NOT EXISTS idx_plans_source_path ON plans (source_path)',
  'CREATE INDEX IF NOT EXISTS idx_plans_content_hash ON plans (content_hash)',
  // Attachments
  'CREATE INDEX IF NOT EXISTS idx_attachments_file_path ON attachments (file_path)',

  // Log entries
  'CREATE INDEX IF NOT EXISTS idx_log_entries_timestamp ON log_entries (timestamp)',
  'CREATE INDEX IF NOT EXISTS idx_log_entries_level ON log_entries (level)',
  'CREATE INDEX IF NOT EXISTS idx_log_entries_component ON log_entries (component)',
  'CREATE INDEX IF NOT EXISTS idx_log_entries_kind ON log_entries (kind)',
  'CREATE INDEX IF NOT EXISTS idx_log_entries_session_id ON log_entries (session_id)',
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
  // Logging layer
  LOG_ENTRIES_TABLE,
];

// ---------------------------------------------------------------------------
// Migrations
// ---------------------------------------------------------------------------

/**
 * Migrate a version-1 database to version-2.
 *
 * Version 2 adds:
 *   - plans.session_id, plans.prompt_batch_id, plans.content_hash
 *   - attachments.data, attachments.content_hash
 *   - indexes: idx_plans_session_id, idx_plans_source_path, idx_plans_content_hash
 *
 * Each ALTER TABLE is wrapped in try/catch so re-running is safe -- SQLite
 * throws "duplicate column name" if the column already exists, which we ignore.
 */
function migrateV1ToV2(db: Database): void {
  db.exec('BEGIN');
  try {
    const alterStatements = [
      'ALTER TABLE plans ADD COLUMN session_id TEXT REFERENCES sessions(id)',
      'ALTER TABLE plans ADD COLUMN prompt_batch_id INTEGER REFERENCES prompt_batches(id)',
      'ALTER TABLE plans ADD COLUMN content_hash TEXT',
      'ALTER TABLE attachments ADD COLUMN data BLOB',
      'ALTER TABLE attachments ADD COLUMN content_hash TEXT',
    ];

    for (const stmt of alterStatements) {
      try {
        db.exec(stmt);
      } catch {
        // Column already exists -- safe to ignore on re-run
      }
    }

    // Indexes use IF NOT EXISTS so they are idempotent
    const newIndexes = [
      'CREATE INDEX IF NOT EXISTS idx_plans_session_id ON plans (session_id)',
      'CREATE INDEX IF NOT EXISTS idx_plans_source_path ON plans (source_path)',
      'CREATE INDEX IF NOT EXISTS idx_plans_content_hash ON plans (content_hash)',
      'CREATE INDEX IF NOT EXISTS idx_attachments_file_path ON attachments (file_path)',
    ];

    for (const idx of newIndexes) {
      db.exec(idx);
    }

    db.prepare(
      `INSERT INTO schema_version (version, applied_at)
       VALUES (?, ?)
       ON CONFLICT (version) DO NOTHING`
    ).run(2, epochSeconds());

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/**
 * Migrate a version-2 database to version-3.
 *
 * Version 3 adds:
 *   - log_entries table
 *   - log_entries_fts virtual table (FTS5)
 *   - indexes: idx_log_entries_timestamp, _level, _component, _kind, _session_id
 *
 * Uses `CREATE ... IF NOT EXISTS` throughout for idempotency.
 */
function migrateV2ToV3(db: Database): void {
  db.exec('BEGIN');
  try {
    db.exec(LOG_ENTRIES_TABLE);

    db.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS log_entries_fts
         USING fts5(message, content='log_entries', content_rowid='id')`
    );

    // FTS5 sync triggers for log_entries
    db.exec(
      `CREATE TRIGGER IF NOT EXISTS log_entries_ai AFTER INSERT ON log_entries BEGIN
         INSERT INTO log_entries_fts(rowid, message) VALUES (new.id, new.message);
       END`
    );
    db.exec(
      `CREATE TRIGGER IF NOT EXISTS log_entries_ad AFTER DELETE ON log_entries BEGIN
         INSERT INTO log_entries_fts(log_entries_fts, rowid, message) VALUES('delete', old.id, old.message);
       END`
    );

    const newIndexes = [
      'CREATE INDEX IF NOT EXISTS idx_log_entries_timestamp ON log_entries (timestamp)',
      'CREATE INDEX IF NOT EXISTS idx_log_entries_level ON log_entries (level)',
      'CREATE INDEX IF NOT EXISTS idx_log_entries_component ON log_entries (component)',
      'CREATE INDEX IF NOT EXISTS idx_log_entries_kind ON log_entries (kind)',
      'CREATE INDEX IF NOT EXISTS idx_log_entries_session_id ON log_entries (session_id)',
    ];

    for (const idx of newIndexes) {
      db.exec(idx);
    }

    db.prepare(
      `INSERT INTO schema_version (version, applied_at)
       VALUES (?, ?)
       ON CONFLICT (version) DO NOTHING`
    ).run(3, epochSeconds());

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create all database tables, indexes, and record the schema version.
 *
 * Fully idempotent -- safe to call on every startup. Uses `IF NOT EXISTS`
 * for all DDL and `ON CONFLICT DO NOTHING` for the version row.
 */
export function createSchema(db: Database): void {
  // Fast-path: skip if already at current version
  try {
    const row = db.prepare(
      'SELECT version FROM schema_version ORDER BY version DESC LIMIT 1'
    ).get() as { version: number } | undefined;
    if (row?.version === SCHEMA_VERSION) return;
    // Migration path: version 1 → 2 (then fall through to check for 2 → 3)
    if (row?.version === 1) {
      migrateV1ToV2(db);
    }
    // Migration path: version 2 → 3
    const afterV1Migration = (db.prepare(
      'SELECT version FROM schema_version ORDER BY version DESC LIMIT 1'
    ).get() as { version: number } | undefined)?.version ?? 0;
    if (afterV1Migration < 3) {
      migrateV2ToV3(db);
    }
    return;
  } catch {
    // Table doesn't exist yet -- first run
  }

  for (const ddl of TABLE_DDLS) {
    db.exec(ddl);
  }

  for (const ddl of FTS_TABLES) {
    db.exec(ddl);
  }

  for (const idx of SECONDARY_INDEXES) {
    db.exec(idx);
  }

  db.prepare(
    `INSERT INTO schema_version (version, applied_at)
     VALUES (?, ?)
     ON CONFLICT (version) DO NOTHING`
  ).run(SCHEMA_VERSION, epochSeconds());
}
