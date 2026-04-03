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
import { epochSeconds, DEFAULT_MACHINE_ID } from '@myco/constants.js';

/** Current schema version -- fresh start for the SQLite era. */
export const SCHEMA_VERSION = 9;

// Re-export for backwards compat (other modules import from schema.ts)
export { DEFAULT_MACHINE_ID };

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
    embedded               INTEGER DEFAULT 0,
    machine_id             TEXT NOT NULL DEFAULT 'local',
    synced_at              INTEGER
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
    created_at        INTEGER NOT NULL,
    machine_id        TEXT NOT NULL DEFAULT 'local',
    synced_at         INTEGER
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
    embedded         INTEGER DEFAULT 0,
    machine_id       TEXT NOT NULL DEFAULT 'local',
    synced_at        INTEGER
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
    embedded         INTEGER DEFAULT 0,
    machine_id       TEXT NOT NULL DEFAULT 'local',
    synced_at        INTEGER
  )`;

const TEAM_MEMBERS_TABLE = `
  CREATE TABLE IF NOT EXISTS team_members (
    id          TEXT PRIMARY KEY,
    "user"      TEXT NOT NULL,
    role        TEXT,
    joined      TEXT,
    tags        TEXT,
    machine_id  TEXT NOT NULL DEFAULT 'local',
    synced_at   INTEGER
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
    embedded          INTEGER DEFAULT 0,
    machine_id        TEXT NOT NULL DEFAULT 'local',
    synced_at         INTEGER
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
    machine_id  TEXT NOT NULL DEFAULT 'local',
    synced_at   INTEGER,
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
    created_at      INTEGER NOT NULL,
    machine_id      TEXT NOT NULL DEFAULT 'local',
    synced_at       INTEGER
  )`;

const ENTITY_MENTIONS_TABLE = `
  CREATE TABLE IF NOT EXISTS entity_mentions (
    entity_id   TEXT NOT NULL REFERENCES entities(id),
    note_id     TEXT NOT NULL,
    note_type   TEXT NOT NULL,
    agent_id    TEXT NOT NULL REFERENCES agents(id),
    machine_id  TEXT NOT NULL DEFAULT 'local',
    synced_at   INTEGER,
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
    created_at    INTEGER NOT NULL,
    machine_id    TEXT NOT NULL DEFAULT 'local',
    synced_at     INTEGER
  )`;

const DIGEST_EXTRACTS_TABLE = `
  CREATE TABLE IF NOT EXISTS digest_extracts (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id        TEXT NOT NULL REFERENCES agents(id),
    tier            INTEGER NOT NULL,
    content         TEXT NOT NULL,
    substrate_hash  TEXT,
    generated_at    INTEGER NOT NULL,
    machine_id      TEXT NOT NULL DEFAULT 'local',
    synced_at       INTEGER,
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

// -- Sync Layer -------------------------------------------------------------

const TEAM_OUTBOX_TABLE = `
  CREATE TABLE IF NOT EXISTS team_outbox (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    table_name  TEXT NOT NULL,
    row_id      TEXT NOT NULL,
    operation   TEXT NOT NULL DEFAULT 'upsert',
    payload     TEXT NOT NULL,
    machine_id  TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    sent_at     INTEGER,
    retry_count    INTEGER NOT NULL DEFAULT 0,
    last_attempt_at INTEGER
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

// -- Skills Layer -----------------------------------------------------------

const SKILL_CANDIDATES_TABLE = `
  CREATE TABLE IF NOT EXISTS skill_candidates (
    id              TEXT PRIMARY KEY,
    agent_id        TEXT NOT NULL REFERENCES agents(id),
    machine_id      TEXT NOT NULL DEFAULT 'local',
    topic           TEXT NOT NULL,
    rationale       TEXT NOT NULL,
    confidence      REAL NOT NULL DEFAULT 0.0,
    status          TEXT NOT NULL DEFAULT 'identified',
    source_ids      TEXT NOT NULL DEFAULT '[]',
    skill_id        TEXT,
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL,
    synced_at       INTEGER
  )`;

const SKILL_RECORDS_TABLE = `
  CREATE TABLE IF NOT EXISTS skill_records (
    id              TEXT PRIMARY KEY,
    agent_id        TEXT NOT NULL REFERENCES agents(id),
    machine_id      TEXT NOT NULL DEFAULT 'local',
    name            TEXT NOT NULL UNIQUE,
    display_name    TEXT NOT NULL,
    description     TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'active',
    generation      INTEGER NOT NULL DEFAULT 1,
    candidate_id    TEXT REFERENCES skill_candidates(id),
    source_ids      TEXT NOT NULL DEFAULT '[]',
    path            TEXT NOT NULL,
    usage_count     INTEGER NOT NULL DEFAULT 0,
    last_used_at    INTEGER,
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL,
    properties      TEXT NOT NULL DEFAULT '{}',
    synced_at       INTEGER
  )`;

const SKILL_LINEAGE_TABLE = `
  CREATE TABLE IF NOT EXISTS skill_lineage (
    id               TEXT PRIMARY KEY,
    skill_id         TEXT NOT NULL REFERENCES skill_records(id),
    generation       INTEGER NOT NULL,
    action           TEXT NOT NULL,
    rationale        TEXT NOT NULL,
    source_ids_added TEXT NOT NULL DEFAULT '[]',
    content_snapshot TEXT NOT NULL,
    created_at       INTEGER NOT NULL
  )`;

const SKILL_USAGE_TABLE = `
  CREATE TABLE IF NOT EXISTS skill_usage (
    id          TEXT PRIMARY KEY,
    skill_id    TEXT NOT NULL REFERENCES skill_records(id),
    session_id  TEXT NOT NULL REFERENCES sessions(id),
    machine_id  TEXT NOT NULL DEFAULT 'local',
    detected_at INTEGER NOT NULL
  )`;

// -- Notifications Layer ----------------------------------------------------

const NOTIFICATIONS_TABLE = `
  CREATE TABLE IF NOT EXISTS notifications (
    id          TEXT PRIMARY KEY,
    domain      TEXT NOT NULL,
    type        TEXT NOT NULL,
    level       TEXT NOT NULL DEFAULT 'info',
    title       TEXT NOT NULL,
    message     TEXT,
    mode        TEXT NOT NULL DEFAULT 'banner',
    status      TEXT NOT NULL DEFAULT 'unread',
    link        TEXT,
    metadata    TEXT,
    created_at  INTEGER NOT NULL
  )`;

// -- FTS5 Virtual Tables ----------------------------------------------------

const FTS_TABLES = [
  `CREATE VIRTUAL TABLE IF NOT EXISTS prompt_batches_fts
     USING fts5(user_prompt, response_summary, content='prompt_batches', content_rowid='id')`,

  `CREATE VIRTUAL TABLE IF NOT EXISTS activities_fts
     USING fts5(tool_name, tool_input, file_path, content='activities', content_rowid='id')`,

  `CREATE VIRTUAL TABLE IF NOT EXISTS log_entries_fts
     USING fts5(message, content='log_entries', content_rowid='id')`,

  `CREATE VIRTUAL TABLE IF NOT EXISTS spores_fts
     USING fts5(content, content='spores', content_rowid='rowid')`,

  `CREATE VIRTUAL TABLE IF NOT EXISTS sessions_fts
     USING fts5(title, summary, content='sessions', content_rowid='rowid')`,

  // FTS5 sync triggers for log_entries (external-content table)
  `CREATE TRIGGER IF NOT EXISTS log_entries_ai AFTER INSERT ON log_entries BEGIN
     INSERT INTO log_entries_fts(rowid, message) VALUES (new.id, new.message);
   END`,

  `CREATE TRIGGER IF NOT EXISTS log_entries_ad AFTER DELETE ON log_entries BEGIN
     INSERT INTO log_entries_fts(log_entries_fts, rowid, message) VALUES('delete', old.id, old.message);
   END`,

  // FTS5 sync triggers for prompt_batches
  `CREATE TRIGGER IF NOT EXISTS prompt_batches_fts_ai AFTER INSERT ON prompt_batches BEGIN
     INSERT INTO prompt_batches_fts(rowid, user_prompt, response_summary) VALUES (new.id, new.user_prompt, new.response_summary);
   END`,

  `CREATE TRIGGER IF NOT EXISTS prompt_batches_fts_au AFTER UPDATE OF user_prompt, response_summary ON prompt_batches BEGIN
     INSERT INTO prompt_batches_fts(prompt_batches_fts, rowid, user_prompt, response_summary) VALUES('delete', old.id, old.user_prompt, old.response_summary);
     INSERT INTO prompt_batches_fts(rowid, user_prompt, response_summary) VALUES (new.id, new.user_prompt, new.response_summary);
   END`,

  `CREATE TRIGGER IF NOT EXISTS prompt_batches_fts_ad AFTER DELETE ON prompt_batches BEGIN
     INSERT INTO prompt_batches_fts(prompt_batches_fts, rowid, user_prompt, response_summary) VALUES('delete', old.id, old.user_prompt, old.response_summary);
   END`,

  // FTS5 sync triggers for spores
  `CREATE TRIGGER IF NOT EXISTS spores_fts_ai AFTER INSERT ON spores BEGIN
     INSERT INTO spores_fts(rowid, content) VALUES (new.rowid, new.content);
   END`,

  `CREATE TRIGGER IF NOT EXISTS spores_fts_au AFTER UPDATE OF content ON spores BEGIN
     INSERT INTO spores_fts(spores_fts, rowid, content) VALUES('delete', old.rowid, old.content);
     INSERT INTO spores_fts(rowid, content) VALUES (new.rowid, new.content);
   END`,

  `CREATE TRIGGER IF NOT EXISTS spores_fts_ad AFTER DELETE ON spores BEGIN
     INSERT INTO spores_fts(spores_fts, rowid, content) VALUES('delete', old.rowid, old.content);
   END`,

  // FTS5 sync triggers for sessions
  `CREATE TRIGGER IF NOT EXISTS sessions_fts_ai AFTER INSERT ON sessions BEGIN
     INSERT INTO sessions_fts(rowid, title, summary) VALUES (new.rowid, new.title, new.summary);
   END`,

  `CREATE TRIGGER IF NOT EXISTS sessions_fts_au AFTER UPDATE OF title, summary ON sessions BEGIN
     INSERT INTO sessions_fts(sessions_fts, rowid, title, summary) VALUES('delete', old.rowid, old.title, old.summary);
     INSERT INTO sessions_fts(rowid, title, summary) VALUES (new.rowid, new.title, new.summary);
   END`,

  `CREATE TRIGGER IF NOT EXISTS sessions_fts_ad AFTER DELETE ON sessions BEGIN
     INSERT INTO sessions_fts(sessions_fts, rowid, title, summary) VALUES('delete', old.rowid, old.title, old.summary);
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
  'CREATE INDEX IF NOT EXISTS idx_agent_runs_task_completed ON agent_runs (task, status, completed_at)',

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

  // Team outbox
  'CREATE INDEX IF NOT EXISTS idx_team_outbox_pending ON team_outbox (sent_at, created_at)',
  'CREATE INDEX IF NOT EXISTS idx_team_outbox_table_name ON team_outbox (table_name)',
  'CREATE INDEX IF NOT EXISTS idx_team_outbox_row_lookup ON team_outbox (table_name, row_id)',

  // Machine ID (synced tables)
  'CREATE INDEX IF NOT EXISTS idx_sessions_machine_id ON sessions (machine_id)',
  'CREATE INDEX IF NOT EXISTS idx_spores_machine_id ON spores (machine_id)',
  'CREATE INDEX IF NOT EXISTS idx_graph_edges_machine_id ON graph_edges (machine_id)',

  // Skill candidates
  'CREATE INDEX IF NOT EXISTS idx_skill_candidates_agent_id ON skill_candidates (agent_id)',
  'CREATE INDEX IF NOT EXISTS idx_skill_candidates_status ON skill_candidates (status)',
  'CREATE INDEX IF NOT EXISTS idx_skill_candidates_machine_id ON skill_candidates (machine_id)',
  'CREATE INDEX IF NOT EXISTS idx_skill_candidates_agent_status ON skill_candidates (agent_id, status)',

  // Skill records
  'CREATE INDEX IF NOT EXISTS idx_skill_records_agent_id ON skill_records (agent_id)',
  'CREATE INDEX IF NOT EXISTS idx_skill_records_status ON skill_records (status)',
  'CREATE INDEX IF NOT EXISTS idx_skill_records_name ON skill_records (name)',
  'CREATE INDEX IF NOT EXISTS idx_skill_records_machine_id ON skill_records (machine_id)',
  'CREATE INDEX IF NOT EXISTS idx_skill_records_agent_status ON skill_records (agent_id, status)',

  // Skill lineage
  'CREATE INDEX IF NOT EXISTS idx_skill_lineage_skill_id ON skill_lineage (skill_id)',

  // Skill usage
  'CREATE INDEX IF NOT EXISTS idx_skill_usage_skill_id ON skill_usage (skill_id)',
  'CREATE INDEX IF NOT EXISTS idx_skill_usage_session_id ON skill_usage (session_id)',
  'CREATE INDEX IF NOT EXISTS idx_skill_usage_skill_session ON skill_usage (skill_id, session_id)',

  // Log entries
  'CREATE INDEX IF NOT EXISTS idx_log_entries_timestamp ON log_entries (timestamp)',
  'CREATE INDEX IF NOT EXISTS idx_log_entries_level ON log_entries (level)',
  'CREATE INDEX IF NOT EXISTS idx_log_entries_component ON log_entries (component)',
  'CREATE INDEX IF NOT EXISTS idx_log_entries_kind ON log_entries (kind)',
  'CREATE INDEX IF NOT EXISTS idx_log_entries_session_id ON log_entries (session_id)',

  // Notifications
  'CREATE INDEX IF NOT EXISTS idx_notifications_status ON notifications (status)',
  'CREATE INDEX IF NOT EXISTS idx_notifications_domain ON notifications (domain)',
  'CREATE INDEX IF NOT EXISTS idx_notifications_created_at ON notifications (created_at)',
  'CREATE INDEX IF NOT EXISTS idx_notifications_status_created ON notifications (status, created_at)',
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
  // Skills layer
  SKILL_CANDIDATES_TABLE,
  SKILL_RECORDS_TABLE,
  SKILL_LINEAGE_TABLE,
  SKILL_USAGE_TABLE,
  // Sync layer
  TEAM_OUTBOX_TABLE,
  // Logging layer
  LOG_ENTRIES_TABLE,
  // Notifications layer
  NOTIFICATIONS_TABLE,
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

/**
 * Migrate a version-3 database to version-4.
 *
 * Version 4 adds multi-machine support:
 *   - machine_id TEXT NOT NULL DEFAULT 'local' on all synced tables
 *   - synced_at INTEGER on all synced tables
 *   - team_outbox table + indexes
 *   - machine_id indexes on high-traffic tables
 *
 * Backfills existing rows with the provided machineId.
 */
function migrateV3ToV4(db: Database, machineId: string): void {
  db.exec('BEGIN');
  try {
    // Tables that need machine_id + synced_at columns
    const syncedTables = [
      'sessions',
      'prompt_batches',
      'spores',
      'entities',
      'graph_edges',
      'entity_mentions',
      'resolution_events',
      'plans',
      'artifacts',
      'digest_extracts',
      'team_members',
    ];

    for (const table of syncedTables) {
      try {
        db.exec(`ALTER TABLE ${table} ADD COLUMN machine_id TEXT NOT NULL DEFAULT 'local'`);
      } catch {
        // Column already exists -- safe to ignore on re-run
      }
      try {
        db.exec(`ALTER TABLE ${table} ADD COLUMN synced_at INTEGER`);
      } catch {
        // Column already exists -- safe to ignore on re-run
      }
    }

    // Backfill machine_id on existing rows
    for (const table of syncedTables) {
      db.prepare(`UPDATE ${table} SET machine_id = ? WHERE machine_id = 'local'`).run(machineId);
    }

    // Create team_outbox table
    db.exec(TEAM_OUTBOX_TABLE);

    // Create new indexes (IF NOT EXISTS for idempotency)
    const newIndexes = [
      'CREATE INDEX IF NOT EXISTS idx_team_outbox_pending ON team_outbox (sent_at, created_at)',
      'CREATE INDEX IF NOT EXISTS idx_team_outbox_table_name ON team_outbox (table_name)',
      'CREATE INDEX IF NOT EXISTS idx_team_outbox_row_lookup ON team_outbox (table_name, row_id)',
      'CREATE INDEX IF NOT EXISTS idx_sessions_machine_id ON sessions (machine_id)',
      'CREATE INDEX IF NOT EXISTS idx_spores_machine_id ON spores (machine_id)',
      'CREATE INDEX IF NOT EXISTS idx_graph_edges_machine_id ON graph_edges (machine_id)',
    ];

    for (const idx of newIndexes) {
      db.exec(idx);
    }

    db.prepare(
      `INSERT INTO schema_version (version, applied_at)
       VALUES (?, ?)
       ON CONFLICT (version) DO NOTHING`
    ).run(4, epochSeconds());

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/**
 * Migrate a version-5 database to version-6.
 *
 * Version 6 expands FTS5 coverage:
 *   - prompt_batches_fts gains response_summary column (drop + recreate)
 *   - spores_fts new virtual table (content column, hidden rowid)
 *   - sessions_fts new virtual table (title + summary, hidden rowid)
 *   - sync triggers for all three tables (insert / update / delete)
 *   - backfills FTS from existing data
 *
 * Uses `IF NOT EXISTS` throughout for idempotency where possible.
 * The prompt_batches_fts table must be dropped first since its column
 * definition changed.
 */
function migrateV5ToV6(db: Database): void {
  db.exec('BEGIN');
  try {
    // Drop old prompt_batches_fts (column definition changed)
    db.exec('DROP TABLE IF EXISTS prompt_batches_fts');

    // Recreate with response_summary added
    db.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS prompt_batches_fts
         USING fts5(user_prompt, response_summary, content='prompt_batches', content_rowid='id')`,
    );

    // New FTS tables
    db.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS spores_fts
         USING fts5(content, content='spores', content_rowid='rowid')`,
    );
    db.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS sessions_fts
         USING fts5(title, summary, content='sessions', content_rowid='rowid')`,
    );

    // Triggers for prompt_batches
    db.exec(
      `CREATE TRIGGER IF NOT EXISTS prompt_batches_fts_ai AFTER INSERT ON prompt_batches BEGIN
         INSERT INTO prompt_batches_fts(rowid, user_prompt, response_summary) VALUES (new.id, new.user_prompt, new.response_summary);
       END`,
    );
    db.exec(
      `CREATE TRIGGER IF NOT EXISTS prompt_batches_fts_au AFTER UPDATE OF user_prompt, response_summary ON prompt_batches BEGIN
         INSERT INTO prompt_batches_fts(prompt_batches_fts, rowid, user_prompt, response_summary) VALUES('delete', old.id, old.user_prompt, old.response_summary);
         INSERT INTO prompt_batches_fts(rowid, user_prompt, response_summary) VALUES (new.id, new.user_prompt, new.response_summary);
       END`,
    );
    db.exec(
      `CREATE TRIGGER IF NOT EXISTS prompt_batches_fts_ad AFTER DELETE ON prompt_batches BEGIN
         INSERT INTO prompt_batches_fts(prompt_batches_fts, rowid, user_prompt, response_summary) VALUES('delete', old.id, old.user_prompt, old.response_summary);
       END`,
    );

    // Triggers for spores
    db.exec(
      `CREATE TRIGGER IF NOT EXISTS spores_fts_ai AFTER INSERT ON spores BEGIN
         INSERT INTO spores_fts(rowid, content) VALUES (new.rowid, new.content);
       END`,
    );
    db.exec(
      `CREATE TRIGGER IF NOT EXISTS spores_fts_au AFTER UPDATE OF content ON spores BEGIN
         INSERT INTO spores_fts(spores_fts, rowid, content) VALUES('delete', old.rowid, old.content);
         INSERT INTO spores_fts(rowid, content) VALUES (new.rowid, new.content);
       END`,
    );
    db.exec(
      `CREATE TRIGGER IF NOT EXISTS spores_fts_ad AFTER DELETE ON spores BEGIN
         INSERT INTO spores_fts(spores_fts, rowid, content) VALUES('delete', old.rowid, old.content);
       END`,
    );

    // Triggers for sessions
    db.exec(
      `CREATE TRIGGER IF NOT EXISTS sessions_fts_ai AFTER INSERT ON sessions BEGIN
         INSERT INTO sessions_fts(rowid, title, summary) VALUES (new.rowid, new.title, new.summary);
       END`,
    );
    db.exec(
      `CREATE TRIGGER IF NOT EXISTS sessions_fts_au AFTER UPDATE OF title, summary ON sessions BEGIN
         INSERT INTO sessions_fts(sessions_fts, rowid, title, summary) VALUES('delete', old.rowid, old.title, old.summary);
         INSERT INTO sessions_fts(rowid, title, summary) VALUES (new.rowid, new.title, new.summary);
       END`,
    );
    db.exec(
      `CREATE TRIGGER IF NOT EXISTS sessions_fts_ad AFTER DELETE ON sessions BEGIN
         INSERT INTO sessions_fts(sessions_fts, rowid, title, summary) VALUES('delete', old.rowid, old.title, old.summary);
       END`,
    );

    // Backfill FTS from existing data
    db.exec(
      `INSERT INTO prompt_batches_fts(rowid, user_prompt, response_summary)
         SELECT rowid, user_prompt, response_summary FROM prompt_batches`,
    );
    db.exec(
      `INSERT INTO spores_fts(rowid, content)
         SELECT rowid, content FROM spores`,
    );
    db.exec(
      `INSERT INTO sessions_fts(rowid, title, summary)
         SELECT rowid, title, summary FROM sessions`,
    );

    db.prepare(
      `INSERT INTO schema_version (version, applied_at)
       VALUES (?, ?)
       ON CONFLICT (version) DO NOTHING`,
    ).run(6, epochSeconds());

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/**
 * Migrate a version-4 database to version-5.
 *
 * Version 5 adds the Skills layer:
 *   - skill_candidates table
 *   - skill_records table
 *   - skill_lineage table
 *   - skill_usage table
 *   - indexes for all new tables
 *
 * Uses `CREATE TABLE IF NOT EXISTS` throughout for idempotency.
 */
function migrateV4ToV5(db: Database): void {
  db.exec('BEGIN');
  try {
    db.exec(SKILL_CANDIDATES_TABLE);
    db.exec(SKILL_RECORDS_TABLE);
    db.exec(SKILL_LINEAGE_TABLE);
    db.exec(SKILL_USAGE_TABLE);

    const newIndexes = [
      'CREATE INDEX IF NOT EXISTS idx_skill_candidates_agent_id ON skill_candidates (agent_id)',
      'CREATE INDEX IF NOT EXISTS idx_skill_candidates_status ON skill_candidates (status)',
      'CREATE INDEX IF NOT EXISTS idx_skill_candidates_machine_id ON skill_candidates (machine_id)',
      'CREATE INDEX IF NOT EXISTS idx_skill_candidates_agent_status ON skill_candidates (agent_id, status)',
      'CREATE INDEX IF NOT EXISTS idx_skill_records_agent_id ON skill_records (agent_id)',
      'CREATE INDEX IF NOT EXISTS idx_skill_records_status ON skill_records (status)',
      'CREATE INDEX IF NOT EXISTS idx_skill_records_name ON skill_records (name)',
      'CREATE INDEX IF NOT EXISTS idx_skill_records_machine_id ON skill_records (machine_id)',
      'CREATE INDEX IF NOT EXISTS idx_skill_records_agent_status ON skill_records (agent_id, status)',
      'CREATE INDEX IF NOT EXISTS idx_skill_lineage_skill_id ON skill_lineage (skill_id)',
      'CREATE INDEX IF NOT EXISTS idx_skill_usage_skill_id ON skill_usage (skill_id)',
      'CREATE INDEX IF NOT EXISTS idx_skill_usage_session_id ON skill_usage (session_id)',
      'CREATE INDEX IF NOT EXISTS idx_skill_usage_skill_session ON skill_usage (skill_id, session_id)',
      'CREATE INDEX IF NOT EXISTS idx_agent_runs_task_completed ON agent_runs (task, status, completed_at)',
    ];

    for (const idx of newIndexes) {
      db.exec(idx);
    }

    db.prepare(
      `INSERT INTO schema_version (version, applied_at)
       VALUES (?, ?)
       ON CONFLICT (version) DO NOTHING`
    ).run(5, epochSeconds());

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

/**
 * Migrate v6 → v7: fix stale 'local' machine_id on ALL synced tables.
 *
 * The agent vault tools historically used DEFAULT_MACHINE_ID ('local')
 * instead of the resolved machine identity. This one-time data migration
 * fixes all affected records and re-queues them for team sync.
 */
function migrateV6ToV7(db: Database, machineId: string): void {
  if (machineId === 'local' || machineId === DEFAULT_MACHINE_ID) return; // Nothing to fix

  db.exec('BEGIN');
  try {
    // entity_mentions excluded — no `id` column (composite key: entity_id, note_id, note_type)
    const tables = [
      'sessions', 'prompt_batches', 'spores', 'entities', 'graph_edges',
      'resolution_events', 'plans', 'artifacts',
      'digest_extracts', 'skill_candidates', 'skill_records',
    ];

    for (const table of tables) {
      try {
        // Find rows that need fixing BEFORE updating
        const staleRows = db.prepare(
          `SELECT id FROM ${table} WHERE machine_id = 'local'`,
        ).all() as Array<{ id: string }>;

        if (staleRows.length === 0) continue;

        // Fix machine_id and clear synced_at
        db.prepare(
          `UPDATE ${table} SET machine_id = ?, synced_at = NULL WHERE machine_id = 'local'`,
        ).run(machineId);

        // Clear stale outbox entries for affected rows only
        for (const row of staleRows) {
          db.prepare(
            `DELETE FROM team_outbox WHERE table_name = ? AND row_id = ?`,
          ).run(table, String(row.id));
        }

        // Re-enqueue only the fixed rows with full payload
        const enqueueStmt = db.prepare(
          `INSERT INTO team_outbox (table_name, row_id, operation, payload, machine_id, created_at)
           VALUES (?, ?, 'upsert', ?, ?, ?)`,
        );
        const now = epochSeconds();
        for (const stale of staleRows) {
          const fresh = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(stale.id) as Record<string, unknown>;
          if (fresh) {
            enqueueStmt.run(table, String(stale.id), JSON.stringify(fresh), machineId, now);
          }
        }
      } catch (tableErr) {
        // Skip if table doesn't exist; re-throw for other errors (I/O, constraint)
        const msg = tableErr instanceof Error ? tableErr.message : String(tableErr);
        if (!msg.includes('no such table')) throw tableErr;
      }
    }

    db.prepare(
      `INSERT INTO schema_version (version, applied_at)
       VALUES (?, ?)
       ON CONFLICT (version) DO NOTHING`,
    ).run(7, epochSeconds());

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/**
 * Migrate v7 → v8: add notifications table.
 *
 * Uses `CREATE TABLE IF NOT EXISTS` for idempotency.
 */
function migrateV7ToV8(db: Database): void {
  db.exec('BEGIN');
  try {
    db.exec(NOTIFICATIONS_TABLE);

    const newIndexes = [
      'CREATE INDEX IF NOT EXISTS idx_notifications_status ON notifications (status)',
      'CREATE INDEX IF NOT EXISTS idx_notifications_domain ON notifications (domain)',
      'CREATE INDEX IF NOT EXISTS idx_notifications_created_at ON notifications (created_at)',
      'CREATE INDEX IF NOT EXISTS idx_notifications_status_created ON notifications (status, created_at)',
    ];

    for (const idx of newIndexes) {
      db.exec(idx);
    }

    db.prepare(
      `INSERT INTO schema_version (version, applied_at)
       VALUES (?, ?)
       ON CONFLICT (version) DO NOTHING`,
    ).run(8, epochSeconds());

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/**
 * Version 9 adds retry tracking to the team outbox:
 *   - retry_count INTEGER NOT NULL DEFAULT 0
 *   - last_attempt_at INTEGER
 *
 * Records exceeding the max retry count are dead-lettered (excluded from
 * pending queries) so they don't block the sync flush or deep sleep.
 */
function migrateV8ToV9(db: Database): void {
  db.exec('BEGIN');
  try {
    db.exec('ALTER TABLE team_outbox ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0');
    db.exec('ALTER TABLE team_outbox ADD COLUMN last_attempt_at INTEGER');

    db.prepare(
      `INSERT INTO schema_version (version, applied_at)
       VALUES (?, ?)
       ON CONFLICT (version) DO NOTHING`,
    ).run(9, epochSeconds());

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/**
 * @param db — better-sqlite3 Database instance.
 * @param machineId — machine identifier for backfilling existing rows during
 *   v3→v4 and v6→v7 migrations. Defaults to `'local'` (tests, init).
 */
export function createSchema(db: Database, machineId: string = DEFAULT_MACHINE_ID): void {
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
    // Migration path: version 3 → 4
    const afterV2Migration = (db.prepare(
      'SELECT version FROM schema_version ORDER BY version DESC LIMIT 1'
    ).get() as { version: number } | undefined)?.version ?? 0;
    if (afterV2Migration < 4) {
      migrateV3ToV4(db, machineId);
    }
    // Migration path: version 4 → 5
    const afterV3Migration = (db.prepare(
      'SELECT version FROM schema_version ORDER BY version DESC LIMIT 1'
    ).get() as { version: number } | undefined)?.version ?? 0;
    if (afterV3Migration < 5) {
      migrateV4ToV5(db);
    }
    // Migration path: version 5 → 6
    const afterV4Migration = (db.prepare(
      'SELECT version FROM schema_version ORDER BY version DESC LIMIT 1'
    ).get() as { version: number } | undefined)?.version ?? 0;
    if (afterV4Migration < 6) {
      migrateV5ToV6(db);
    }
    // Migration path: version 6 → 7
    const afterV5Migration = (db.prepare(
      'SELECT version FROM schema_version ORDER BY version DESC LIMIT 1'
    ).get() as { version: number } | undefined)?.version ?? 0;
    if (afterV5Migration < 7) {
      migrateV6ToV7(db, machineId);
    }
    // Migration path: version 7 → 8
    const afterV6Migration = (db.prepare(
      'SELECT version FROM schema_version ORDER BY version DESC LIMIT 1'
    ).get() as { version: number } | undefined)?.version ?? 0;
    if (afterV6Migration < 8) {
      migrateV7ToV8(db);
    }
    // Migration path: version 8 → 9
    const afterV7Migration = (db.prepare(
      'SELECT version FROM schema_version ORDER BY version DESC LIMIT 1'
    ).get() as { version: number } | undefined)?.version ?? 0;
    if (afterV7Migration < 9) {
      migrateV8ToV9(db);
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
