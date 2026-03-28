/**
 * D1 schema for the Myco team sync worker.
 *
 * Mirrors the synced subset of the local SQLite schema. Tables use
 * (id, machine_id) composite primary keys so records from multiple
 * machines coexist without collision.
 *
 * Fully idempotent — safe to call on every request.
 */

const SESSIONS_TABLE = `
  CREATE TABLE IF NOT EXISTS sessions (
    id                     TEXT NOT NULL,
    machine_id             TEXT NOT NULL,
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
    content_hash           TEXT,
    created_at             INTEGER NOT NULL,
    synced_at              INTEGER,
    PRIMARY KEY (id, machine_id)
  )`;

const PROMPT_BATCHES_TABLE = `
  CREATE TABLE IF NOT EXISTS prompt_batches (
    id                INTEGER NOT NULL,
    machine_id        TEXT NOT NULL,
    session_id        TEXT NOT NULL,
    prompt_number     INTEGER,
    user_prompt       TEXT,
    response_summary  TEXT,
    classification    TEXT,
    started_at        INTEGER,
    ended_at          INTEGER,
    status            TEXT DEFAULT 'active',
    activity_count    INTEGER DEFAULT 0,
    processed         INTEGER DEFAULT 0,
    content_hash      TEXT,
    created_at        INTEGER NOT NULL,
    synced_at         INTEGER,
    PRIMARY KEY (id, machine_id)
  )`;

const SPORES_TABLE = `
  CREATE TABLE IF NOT EXISTS spores (
    id                TEXT NOT NULL,
    machine_id        TEXT NOT NULL,
    agent_id          TEXT NOT NULL,
    session_id        TEXT,
    prompt_batch_id   INTEGER,
    observation_type  TEXT NOT NULL,
    status            TEXT DEFAULT 'active',
    content           TEXT NOT NULL,
    context           TEXT,
    importance        INTEGER DEFAULT 5,
    file_path         TEXT,
    tags              TEXT,
    content_hash      TEXT,
    properties        TEXT,
    created_at        INTEGER NOT NULL,
    updated_at        INTEGER,
    synced_at         INTEGER,
    PRIMARY KEY (id, machine_id)
  )`;

const ENTITIES_TABLE = `
  CREATE TABLE IF NOT EXISTS entities (
    id          TEXT NOT NULL,
    machine_id  TEXT NOT NULL,
    agent_id    TEXT NOT NULL,
    type        TEXT NOT NULL,
    name        TEXT NOT NULL,
    properties  TEXT,
    first_seen  INTEGER NOT NULL,
    last_seen   INTEGER NOT NULL,
    status      TEXT DEFAULT 'active',
    synced_at   INTEGER,
    PRIMARY KEY (id, machine_id)
  )`;

const GRAPH_EDGES_TABLE = `
  CREATE TABLE IF NOT EXISTS graph_edges (
    id              TEXT NOT NULL,
    machine_id      TEXT NOT NULL,
    agent_id        TEXT NOT NULL,
    source_id       TEXT NOT NULL,
    source_type     TEXT NOT NULL,
    target_id       TEXT NOT NULL,
    target_type     TEXT NOT NULL,
    type            TEXT NOT NULL,
    session_id      TEXT,
    confidence      REAL DEFAULT 1.0,
    properties      TEXT,
    created_at      INTEGER NOT NULL,
    synced_at       INTEGER,
    PRIMARY KEY (id, machine_id)
  )`;

const PLANS_TABLE = `
  CREATE TABLE IF NOT EXISTS plans (
    id               TEXT NOT NULL,
    machine_id       TEXT NOT NULL,
    status           TEXT DEFAULT 'active',
    author           TEXT,
    title            TEXT,
    content          TEXT,
    source_path      TEXT,
    tags             TEXT,
    session_id       TEXT,
    prompt_batch_id  INTEGER,
    content_hash     TEXT,
    processed        INTEGER DEFAULT 0,
    created_at       INTEGER NOT NULL,
    updated_at       INTEGER,
    synced_at        INTEGER,
    PRIMARY KEY (id, machine_id)
  )`;

const ARTIFACTS_TABLE = `
  CREATE TABLE IF NOT EXISTS artifacts (
    id               TEXT NOT NULL,
    machine_id       TEXT NOT NULL,
    artifact_type    TEXT,
    source_path      TEXT NOT NULL,
    title            TEXT NOT NULL,
    content          TEXT,
    last_captured_by TEXT,
    tags             TEXT,
    created_at       INTEGER NOT NULL,
    updated_at       INTEGER,
    synced_at        INTEGER,
    PRIMARY KEY (id, machine_id)
  )`;

const ENTITY_MENTIONS_TABLE = `
  CREATE TABLE IF NOT EXISTS entity_mentions (
    entity_id   TEXT NOT NULL,
    note_id     TEXT NOT NULL,
    note_type   TEXT NOT NULL,
    agent_id    TEXT NOT NULL,
    machine_id  TEXT NOT NULL,
    synced_at   INTEGER,
    UNIQUE (entity_id, note_id, note_type, agent_id)
  )`;

const RESOLUTION_EVENTS_TABLE = `
  CREATE TABLE IF NOT EXISTS resolution_events (
    id            TEXT NOT NULL,
    machine_id    TEXT NOT NULL,
    agent_id      TEXT NOT NULL,
    spore_id      TEXT NOT NULL,
    action        TEXT NOT NULL,
    new_spore_id  TEXT,
    reason        TEXT,
    session_id    TEXT,
    created_at    INTEGER NOT NULL,
    synced_at     INTEGER,
    PRIMARY KEY (id, machine_id)
  )`;

const DIGEST_EXTRACTS_TABLE = `
  CREATE TABLE IF NOT EXISTS digest_extracts (
    id              INTEGER NOT NULL,
    machine_id      TEXT NOT NULL,
    agent_id        TEXT NOT NULL,
    tier            INTEGER NOT NULL,
    content         TEXT NOT NULL,
    substrate_hash  TEXT,
    generated_at    INTEGER NOT NULL,
    synced_at       INTEGER,
    PRIMARY KEY (id, machine_id)
  )`;

const NODES_TABLE = `
  CREATE TABLE IF NOT EXISTS nodes (
    machine_id              TEXT PRIMARY KEY,
    package_version         TEXT,
    schema_version          INTEGER,
    sync_protocol_version   INTEGER,
    last_seen               INTEGER NOT NULL,
    registered_at           INTEGER NOT NULL
  )`;

const TEAM_CONFIG_TABLE = `
  CREATE TABLE IF NOT EXISTS team_config (
    key    TEXT PRIMARY KEY,
    value  TEXT NOT NULL
  )`;

const SECONDARY_INDEXES = [
  'CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions (status)',
  'CREATE INDEX IF NOT EXISTS idx_sessions_content_hash ON sessions (content_hash)',
  'CREATE INDEX IF NOT EXISTS idx_spores_status ON spores (status)',
  'CREATE INDEX IF NOT EXISTS idx_spores_content_hash ON spores (content_hash)',
  'CREATE INDEX IF NOT EXISTS idx_spores_observation_type ON spores (observation_type)',
  'CREATE INDEX IF NOT EXISTS idx_plans_content_hash ON plans (content_hash)',
  'CREATE INDEX IF NOT EXISTS idx_graph_edges_source ON graph_edges (source_id, source_type)',
  'CREATE INDEX IF NOT EXISTS idx_graph_edges_target ON graph_edges (target_id, target_type)',
  'CREATE INDEX IF NOT EXISTS idx_entities_type ON entities (type)',
];

const ALL_DDLS = [
  SESSIONS_TABLE,
  PROMPT_BATCHES_TABLE,
  SPORES_TABLE,
  ENTITIES_TABLE,
  GRAPH_EDGES_TABLE,
  ENTITY_MENTIONS_TABLE,
  RESOLUTION_EVENTS_TABLE,
  PLANS_TABLE,
  ARTIFACTS_TABLE,
  DIGEST_EXTRACTS_TABLE,
  NODES_TABLE,
  TEAM_CONFIG_TABLE,
];

/**
 * Create all D1 tables and indexes. Fully idempotent via IF NOT EXISTS.
 */
export async function initD1Schema(db: D1Database): Promise<void> {
  const statements = [...ALL_DDLS, ...SECONDARY_INDEXES];
  const batch = statements.map((sql) => db.prepare(sql));
  await db.batch(batch);
}
