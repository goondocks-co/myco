/**
 * D1 schema for the Myco team sync worker.
 *
 * Mirrors the synced subset of the local SQLite schema. Tables use
 * (id, machine_id) composite primary keys so records from multiple
 * machines coexist without collision.
 *
 * Fully idempotent — safe to call on every request.
 */

// Inline constants — the worker is deployed independently and cannot
// import from the main @myco package at runtime.
const CANDIDATE_STATUS = { APPROVED: 'approved', GENERATED: 'generated' } as const;

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
    id                     INTEGER NOT NULL,
    machine_id             TEXT NOT NULL,
    session_id             TEXT NOT NULL,
    parent_prompt_batch_id INTEGER,
    kind                   TEXT NOT NULL DEFAULT 'initial',
    prompt_number          INTEGER,
    user_prompt            TEXT,
    response_summary       TEXT,
    classification         TEXT,
    started_at             INTEGER,
    ended_at               INTEGER,
    status                 TEXT DEFAULT 'active',
    activity_count         INTEGER DEFAULT 0,
    processed              INTEGER DEFAULT 0,
    content_hash           TEXT,
    created_at             INTEGER NOT NULL,
    synced_at              INTEGER,
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
    logical_key      TEXT,
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

const SKILL_CANDIDATES_TABLE = `
  CREATE TABLE IF NOT EXISTS skill_candidates (
    id              TEXT NOT NULL,
    machine_id      TEXT NOT NULL,
    agent_id        TEXT NOT NULL,
    topic           TEXT NOT NULL,
    rationale       TEXT NOT NULL,
    confidence      REAL NOT NULL DEFAULT 0.0,
    status          TEXT NOT NULL DEFAULT 'identified',
    source_ids      TEXT NOT NULL DEFAULT '[]',
    skill_id        TEXT,
    supersedes      TEXT,
    approved_at     INTEGER,
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL,
    synced_at       INTEGER,
    PRIMARY KEY (id, machine_id)
  )`;

const SKILL_RECORDS_TABLE = `
  CREATE TABLE IF NOT EXISTS skill_records (
    id              TEXT NOT NULL,
    machine_id      TEXT NOT NULL,
    agent_id        TEXT NOT NULL,
    name            TEXT NOT NULL,
    display_name    TEXT NOT NULL,
    description     TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'active',
    generation      INTEGER NOT NULL DEFAULT 1,
    candidate_id    TEXT,
    source_ids      TEXT NOT NULL DEFAULT '[]',
    path            TEXT NOT NULL,
    usage_count     INTEGER NOT NULL DEFAULT 0,
    last_used_at    INTEGER,
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL,
    properties      TEXT NOT NULL DEFAULT '{}',
    synced_at       INTEGER,
    PRIMARY KEY (id, machine_id)
  )`;

const SKILL_USAGE_TABLE = `
  CREATE TABLE IF NOT EXISTS skill_usage (
    id              TEXT NOT NULL,
    machine_id      TEXT NOT NULL,
    skill_id        TEXT NOT NULL,
    session_id      TEXT NOT NULL,
    detected_at     INTEGER NOT NULL,
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
  'CREATE INDEX IF NOT EXISTS idx_skill_candidates_status ON skill_candidates (status)',
  'CREATE INDEX IF NOT EXISTS idx_skill_records_status ON skill_records (status)',
  'CREATE INDEX IF NOT EXISTS idx_skill_records_name ON skill_records (name, machine_id)',
  'CREATE INDEX IF NOT EXISTS idx_skill_usage_skill_id ON skill_usage (skill_id)',
  'CREATE INDEX IF NOT EXISTS idx_prompt_batches_parent ON prompt_batches (parent_prompt_batch_id)',
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
  SKILL_CANDIDATES_TABLE,
  SKILL_RECORDS_TABLE,
  SKILL_USAGE_TABLE,
  NODES_TABLE,
  TEAM_CONFIG_TABLE,
];

/**
 * Create all D1 tables and indexes. Fully idempotent via IF NOT EXISTS.
 * Includes ALTER TABLE migrations for columns added after initial deployment.
 */
export async function initD1Schema(db: D1Database): Promise<void> {
  const statements = [...ALL_DDLS, ...SECONDARY_INDEXES];
  const batch = statements.map((sql) => db.prepare(sql));
  await db.batch(batch);

  // Migrations for existing tables (safe to re-run — silently ignored if column exists)
  const migrations = [
    'ALTER TABLE plans ADD COLUMN logical_key TEXT',
    'ALTER TABLE skill_usage ADD COLUMN synced_at INTEGER',
    'ALTER TABLE skill_candidates ADD COLUMN approved_at INTEGER',
    'ALTER TABLE skill_candidates ADD COLUMN supersedes TEXT',
    'ALTER TABLE prompt_batches ADD COLUMN parent_prompt_batch_id INTEGER',
    "ALTER TABLE prompt_batches ADD COLUMN kind TEXT NOT NULL DEFAULT 'initial'",
  ];
  for (const sql of migrations) {
    try {
      await db.prepare(sql).run();
    } catch {
      // Column already exists — expected after first run
    }
  }

  await db.prepare(
    'CREATE INDEX IF NOT EXISTS idx_plans_logical_key ON plans (logical_key)',
  ).run();

  // Backfill approved_at for already-synced historical rows so remote D1
  // mirrors the local SQLite v10 migration semantics. Idempotent via the
  // approved_at IS NULL guard.
  await db.prepare(
    `UPDATE skill_candidates
       SET approved_at = strftime('%s', 'now')
     WHERE approved_at IS NULL
       AND status IN (?, ?)`,
  )
    .bind(CANDIDATE_STATUS.APPROVED, CANDIDATE_STATUS.GENERATED)
    .run();

  // One-shot prune: mirrors the local v21 migration. Marker-guarded so
  // repeated Worker invocations no-op after the first successful prune.
  const marker = await db
    .prepare(`SELECT value FROM team_config WHERE key = ?`)
    .bind('semantic_graph_pruned')
    .first<{ value: string }>();

  if (!marker) {
    await db.batch([
      db.prepare(
        `DELETE FROM graph_edges WHERE type IN ('REFERENCES', 'AFFECTS', 'DEPENDS_ON', 'RELATES_TO')`,
      ),
      db.prepare(`DELETE FROM entities`),
      db
        .prepare(`INSERT INTO team_config (key, value) VALUES (?, ?)`)
        .bind('semantic_graph_pruned', '1'),
    ]);
  }
}
