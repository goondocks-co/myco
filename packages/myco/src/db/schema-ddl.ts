/**
 * DDL constants for all Myco vault tables, FTS5 virtual tables,
 * sync triggers, and secondary indexes.
 *
 * Extracted from schema.ts for readability -- these are pure string
 * constants with no runtime behaviour.
 */

// ---------------------------------------------------------------------------
// Table DDL statements
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
    logical_key      TEXT NOT NULL,
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

export const CORTEX_INSTRUCTIONS_TABLE = `
  CREATE TABLE IF NOT EXISTS cortex_instructions (
    id            TEXT PRIMARY KEY,
    agent_id      TEXT NOT NULL,
    content       TEXT NOT NULL,
    input_hash    TEXT NOT NULL,
    source_run_id TEXT,
    generated_at  INTEGER NOT NULL,
    machine_id    TEXT NOT NULL DEFAULT 'local',
    synced_at     INTEGER
  )`;

// -- Agent State Layer ------------------------------------------------------

const AGENT_RUNS_TABLE = `
  CREATE TABLE IF NOT EXISTS agent_runs (
    id             TEXT PRIMARY KEY,
    agent_id       TEXT NOT NULL REFERENCES agents(id),
    task           TEXT,
    instruction    TEXT,
    status         TEXT DEFAULT 'pending',
    runtime        TEXT,
    provider       TEXT,
    model          TEXT,
    session_ref    TEXT,
    resumable      INTEGER DEFAULT 0,
    resume_status  TEXT,
    resume_mode    TEXT,
    resumed_at     INTEGER,
    checkpoints    TEXT,
    usage_data     TEXT,
    started_at     INTEGER,
    completed_at   INTEGER,
    tokens_used    INTEGER,
    cost_usd       REAL,
    actual_cost_usd REAL,
    estimated_cost_usd REAL,
    cost_source    TEXT,
    cost_data      TEXT,
    actions_taken  TEXT,
    error          TEXT,
    dry_run        INTEGER NOT NULL DEFAULT 0,
    evaluation_id  TEXT,
    reasoning_level      TEXT,
    execution_overrides  TEXT
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

export const TEAM_OUTBOX_TABLE = `
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

export const LOG_ENTRIES_TABLE = `
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

export const SKILL_CANDIDATES_TABLE = `
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
    supersedes      TEXT,
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL,
    approved_at     INTEGER,
    synced_at       INTEGER
  )`;

export const SKILL_RECORDS_TABLE = `
  CREATE TABLE IF NOT EXISTS skill_records (
    id              TEXT PRIMARY KEY,
    agent_id        TEXT NOT NULL REFERENCES agents(id),
    machine_id      TEXT NOT NULL DEFAULT 'local',
    name            TEXT NOT NULL UNIQUE,
    display_name    TEXT NOT NULL,
    description     TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'active',
    embedded        INTEGER DEFAULT 0,
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

export const SKILL_LINEAGE_TABLE = `
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

export const SKILL_USAGE_TABLE = `
  CREATE TABLE IF NOT EXISTS skill_usage (
    id          TEXT PRIMARY KEY,
    skill_id    TEXT NOT NULL REFERENCES skill_records(id),
    session_id  TEXT NOT NULL REFERENCES sessions(id),
    machine_id  TEXT NOT NULL DEFAULT 'local',
    detected_at INTEGER NOT NULL
  )`;

// -- Notifications Layer ----------------------------------------------------

export const NOTIFICATIONS_TABLE = `
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

// -- Eval Harness Layer -----------------------------------------------------

/**
 * Append-only log of every write a dry-run attempted. Each row captures the
 * tool that was called, the JSON-encoded arguments, the synthetic payload we
 * returned to the agent, and any stub id we minted for a synthetic resource.
 *
 * Append-only invariant: enforced at the query layer — no UPDATE or DELETE
 * helper is exposed. The ON DELETE CASCADE on `run_id` is intentional so a
 * future purge of `agent_runs` (e.g. retention job) also removes the
 * corresponding intents in a single atomic step. Rows must never be deleted
 * except as a side effect of a parent `agent_runs` delete.
 */
export const AGENT_RUN_WRITE_INTENTS_TABLE = `
  CREATE TABLE IF NOT EXISTS agent_run_write_intents (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id            TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
    phase_id          TEXT,
    tool_name         TEXT NOT NULL,
    tool_input        TEXT NOT NULL,
    synthetic_output  TEXT NOT NULL,
    stub_id           TEXT,
    recorded_at       INTEGER NOT NULL
  )`;

/**
 * Append-only history of digest_extracts rows. A new revision is inserted
 * every time a real (non-dry) run overwrites an existing digest. Rollback
 * restores an old revision and records a fresh revision to preserve the
 * append-only invariant.
 */
export const DIGEST_EXTRACT_REVISIONS_TABLE = `
  CREATE TABLE IF NOT EXISTS digest_extract_revisions (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id            TEXT NOT NULL,
    tier                INTEGER NOT NULL,
    content             TEXT NOT NULL,
    metadata            TEXT,
    run_id              TEXT REFERENCES agent_runs(id) ON DELETE SET NULL,
    parent_revision_id  INTEGER REFERENCES digest_extract_revisions(id),
    created_at          INTEGER NOT NULL
  )`;

/**
 * Matrix grouping record for evaluation runs. Child runs link back via
 * `agent_runs.evaluation_id` — code-level integrity, no FK because child
 * runs are themselves normal agent_runs rows.
 */
export const AGENT_RUN_EVALUATIONS_TABLE = `
  CREATE TABLE IF NOT EXISTS agent_run_evaluations (
    id            TEXT PRIMARY KEY,
    task_id       TEXT NOT NULL,
    matrix_json   TEXT NOT NULL,
    notes         TEXT,
    status        TEXT NOT NULL DEFAULT 'pending',
    created_at    INTEGER NOT NULL,
    completed_at  INTEGER
  )`;

// -- FTS5 Virtual Tables ----------------------------------------------------

export const FTS_TABLES = [
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

export const SECONDARY_INDEXES = [
  // Sessions
  'CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions (status)',
  'CREATE INDEX IF NOT EXISTS idx_sessions_processed ON sessions (processed)',
  'CREATE INDEX IF NOT EXISTS idx_sessions_started_at ON sessions (started_at)',
  'CREATE INDEX IF NOT EXISTS idx_sessions_agent ON sessions (agent)',
  'CREATE INDEX IF NOT EXISTS idx_sessions_created_at ON sessions (created_at)',

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
  'CREATE INDEX IF NOT EXISTS idx_cortex_instructions_agent_id ON cortex_instructions (agent_id)',

  // Agent runs
  'CREATE INDEX IF NOT EXISTS idx_agent_runs_agent_id ON agent_runs (agent_id)',
  'CREATE INDEX IF NOT EXISTS idx_agent_runs_status ON agent_runs (status)',
  'CREATE INDEX IF NOT EXISTS idx_agent_runs_agent_status ON agent_runs (agent_id, status)',
  'CREATE INDEX IF NOT EXISTS idx_agent_runs_task_completed ON agent_runs (task, status, completed_at)',
  'CREATE INDEX IF NOT EXISTS idx_agent_runs_task_status_started_at ON agent_runs (task, status, started_at)',
  'CREATE INDEX IF NOT EXISTS idx_agent_runs_resumable_task ON agent_runs (task, resumable, completed_at)',

  // Agent reports
  'CREATE INDEX IF NOT EXISTS idx_agent_reports_run_id ON agent_reports (run_id)',

  // Agent turns
  'CREATE INDEX IF NOT EXISTS idx_agent_turns_run_id ON agent_turns (run_id)',

  // Agent tasks
  'CREATE INDEX IF NOT EXISTS idx_agent_tasks_agent_id ON agent_tasks (agent_id)',

  // Plans
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_plans_logical_key ON plans (logical_key)',
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

  // Eval harness
  'CREATE INDEX IF NOT EXISTS idx_write_intents_run_id ON agent_run_write_intents (run_id)',
  'CREATE INDEX IF NOT EXISTS idx_write_intents_run_id_tool ON agent_run_write_intents (run_id, tool_name)',
  'CREATE INDEX IF NOT EXISTS idx_digest_revisions_agent_tier ON digest_extract_revisions (agent_id, tier, created_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_agent_runs_evaluation_id ON agent_runs (evaluation_id)',
];

// -- Ordered table creation -------------------------------------------------

export const TABLE_DDLS = [
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
  CORTEX_INSTRUCTIONS_TABLE,
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
  // Eval harness layer
  AGENT_RUN_WRITE_INTENTS_TABLE,
  DIGEST_EXTRACT_REVISIONS_TABLE,
  AGENT_RUN_EVALUATIONS_TABLE,
];
