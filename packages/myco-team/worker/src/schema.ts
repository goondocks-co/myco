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
    project_id             TEXT,
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
    project_id             TEXT,
    session_id             TEXT NOT NULL,
    parent_prompt_batch_id INTEGER,
    kind                   TEXT NOT NULL DEFAULT 'initial',
    origin                 TEXT NOT NULL DEFAULT 'human',
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
    project_id        TEXT,
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
    project_id  TEXT,
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
    project_id      TEXT,
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
    project_id       TEXT,
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
    project_id       TEXT,
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
    project_id  TEXT,
    synced_at   INTEGER,
    UNIQUE (entity_id, note_id, note_type, agent_id)
  )`;

const RESOLUTION_EVENTS_TABLE = `
  CREATE TABLE IF NOT EXISTS resolution_events (
    id            TEXT NOT NULL,
    machine_id    TEXT NOT NULL,
    project_id    TEXT,
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
    project_id      TEXT,
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
    project_id      TEXT,
    agent_id        TEXT NOT NULL,
    topic           TEXT NOT NULL,
    rationale       TEXT NOT NULL,
    confidence      REAL NOT NULL DEFAULT 0.0,
    status          TEXT NOT NULL DEFAULT 'identified',
    source_ids      TEXT NOT NULL DEFAULT '[]',
    skill_id        TEXT,
    supersedes      TEXT,
    evidence_bundle_id  TEXT,
    quality_score       REAL,
    quality_failures    TEXT NOT NULL DEFAULT '[]',
    coverage_matches    TEXT NOT NULL DEFAULT '[]',
    last_reconciled_at  INTEGER,
    reconciliation_reason TEXT,
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
    project_id      TEXT,
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
    project_id      TEXT,
    skill_id        TEXT NOT NULL,
    session_id      TEXT NOT NULL,
    detected_at     INTEGER NOT NULL,
    synced_at       INTEGER,
    PRIMARY KEY (id, machine_id)
  )`;

const KNOWLEDGE_RELEASE_STATE_TABLE = `
  CREATE TABLE IF NOT EXISTS knowledge_release_state (
    id                       INTEGER NOT NULL,
    machine_id               TEXT NOT NULL,
    project_id               TEXT,
    identity_key             TEXT NOT NULL,
    namespace                TEXT NOT NULL,
    record_id                TEXT NOT NULL,
    source_session_id        TEXT,
    source_prompt_batch_id   INTEGER,
    state                    TEXT NOT NULL,
    confidence               TEXT NOT NULL,
    basis_kind               TEXT,
    basis_ref                TEXT,
    basis_sha                TEXT,
    release_pr_number        INTEGER,
    reason                   TEXT,
    checked_at               INTEGER NOT NULL,
    created_at               INTEGER NOT NULL,
    updated_at               INTEGER,
    synced_at                INTEGER,
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

const BASE_SECONDARY_INDEXES = [
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
  'CREATE INDEX IF NOT EXISTS idx_knowledge_release_state_record ON knowledge_release_state (namespace, record_id, machine_id)',
  'CREATE INDEX IF NOT EXISTS idx_knowledge_release_state_state ON knowledge_release_state (state, confidence)',
];

const POST_MIGRATION_INDEXES = [
  'CREATE INDEX IF NOT EXISTS idx_plans_logical_key ON plans (logical_key)',
  'CREATE INDEX IF NOT EXISTS idx_prompt_batches_parent ON prompt_batches (parent_prompt_batch_id)',
  'CREATE INDEX IF NOT EXISTS idx_prompt_batches_project_origin_created ON prompt_batches (project_id, origin, created_at)',
  // v39 mirror — composite (project_id, created_at) indexes that back
  // per-project recency queries on the local SQLite vault. D1 carries
  // them so the same query plan works against the synced replica.
  'CREATE INDEX IF NOT EXISTS idx_sessions_project_created ON sessions (project_id, created_at)',
  'CREATE INDEX IF NOT EXISTS idx_prompt_batches_project_created ON prompt_batches (project_id, created_at)',
];

const PROJECT_SCOPE_INDEXES = [
  'CREATE INDEX IF NOT EXISTS idx_sessions_project_id ON sessions (project_id)',
  'CREATE INDEX IF NOT EXISTS idx_prompt_batches_project_id ON prompt_batches (project_id)',
  'CREATE INDEX IF NOT EXISTS idx_spores_project_id ON spores (project_id)',
  'CREATE INDEX IF NOT EXISTS idx_entities_project_id ON entities (project_id)',
  'CREATE INDEX IF NOT EXISTS idx_graph_edges_project_id ON graph_edges (project_id)',
  'CREATE INDEX IF NOT EXISTS idx_plans_project_id ON plans (project_id)',
  'CREATE INDEX IF NOT EXISTS idx_artifacts_project_id ON artifacts (project_id)',
  'CREATE INDEX IF NOT EXISTS idx_entity_mentions_project_id ON entity_mentions (project_id)',
  'CREATE INDEX IF NOT EXISTS idx_resolution_events_project_id ON resolution_events (project_id)',
  'CREATE INDEX IF NOT EXISTS idx_digest_extracts_project_id ON digest_extracts (project_id)',
  'CREATE INDEX IF NOT EXISTS idx_skill_candidates_project_id ON skill_candidates (project_id)',
  'CREATE INDEX IF NOT EXISTS idx_skill_records_project_id ON skill_records (project_id)',
  'CREATE INDEX IF NOT EXISTS idx_skill_usage_project_id ON skill_usage (project_id)',
  'CREATE INDEX IF NOT EXISTS idx_knowledge_release_state_project_id ON knowledge_release_state (project_id)',
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
  KNOWLEDGE_RELEASE_STATE_TABLE,
  NODES_TABLE,
  TEAM_CONFIG_TABLE,
];

export interface InitD1Options {
  /**
   * Oldest sync protocol version the worker still accepts. The
   * Grove-era project-id orphan prune is gated on every active node
   * having registered at >= this version. Pre-Grove daemons that
   * haven't connected since the worker upgrade still have valid
   * pre-Grove rows in D1; deleting them on the worker's first boot
   * after upgrade is what would silently destroy that teammate's
   * data. When omitted, the prune runs unconditionally — preserving
   * the historical behavior for callers that don't pass options.
   */
  minClientVersion?: number;
}

/**
 * Create all D1 tables and indexes. Fully idempotent via IF NOT EXISTS.
 * Includes ALTER TABLE migrations for columns added after initial deployment.
 *
 * The optional `minClientVersion` argument gates the destructive
 * one-shot pre-Grove orphan-row prune. Without it, the function runs
 * the prune on every boot — same as before. With it, the prune only
 * runs once every active node in the `nodes` table has registered at
 * the new floor (see `arePruneClientsAtMinVersion`). This protects
 * unmigrated teammates from losing their pre-Grove rows the first
 * time any teammate ships an upgraded worker.
 */
export async function initD1Schema(db: D1Database, options: InitD1Options = {}): Promise<void> {
  const statements = [...ALL_DDLS, ...BASE_SECONDARY_INDEXES];
  const batch = statements.map((sql) => db.prepare(sql));
  await db.batch(batch);

  // Migrations for existing tables (safe to re-run — silently ignored if column exists)
  const migrations = [
    'ALTER TABLE plans ADD COLUMN logical_key TEXT',
    'ALTER TABLE skill_usage ADD COLUMN synced_at INTEGER',
    'ALTER TABLE skill_candidates ADD COLUMN approved_at INTEGER',
    'ALTER TABLE skill_candidates ADD COLUMN supersedes TEXT',
    'ALTER TABLE skill_candidates ADD COLUMN evidence_bundle_id TEXT',
    'ALTER TABLE skill_candidates ADD COLUMN quality_score REAL',
    "ALTER TABLE skill_candidates ADD COLUMN quality_failures TEXT NOT NULL DEFAULT '[]'",
    "ALTER TABLE skill_candidates ADD COLUMN coverage_matches TEXT NOT NULL DEFAULT '[]'",
    'ALTER TABLE skill_candidates ADD COLUMN last_reconciled_at INTEGER',
    'ALTER TABLE skill_candidates ADD COLUMN reconciliation_reason TEXT',
    'ALTER TABLE prompt_batches ADD COLUMN parent_prompt_batch_id INTEGER',
    "ALTER TABLE prompt_batches ADD COLUMN kind TEXT NOT NULL DEFAULT 'initial'",
    "ALTER TABLE prompt_batches ADD COLUMN origin TEXT NOT NULL DEFAULT 'human'",
    'ALTER TABLE sessions ADD COLUMN project_id TEXT',
    'ALTER TABLE prompt_batches ADD COLUMN project_id TEXT',
    'ALTER TABLE spores ADD COLUMN project_id TEXT',
    'ALTER TABLE entities ADD COLUMN project_id TEXT',
    'ALTER TABLE graph_edges ADD COLUMN project_id TEXT',
    'ALTER TABLE plans ADD COLUMN project_id TEXT',
    'ALTER TABLE artifacts ADD COLUMN project_id TEXT',
    'ALTER TABLE entity_mentions ADD COLUMN project_id TEXT',
    'ALTER TABLE resolution_events ADD COLUMN project_id TEXT',
    'ALTER TABLE digest_extracts ADD COLUMN project_id TEXT',
    'ALTER TABLE skill_candidates ADD COLUMN project_id TEXT',
    'ALTER TABLE skill_records ADD COLUMN project_id TEXT',
    'ALTER TABLE skill_usage ADD COLUMN project_id TEXT',
  ];
  for (const sql of migrations) {
    try {
      await db.prepare(sql).run();
    } catch {
      // Column already exists — expected after first run
    }
  }

  // Verify the ALTER chain made every expected column addressable on this
  // connection. Each entry is `(table, columns[])` covering columns this
  // helper ALTERs above. The parser fails fast on "no such column" — if
  // any ALTER hasn't propagated (lazy schema cache, partial replica
  // refresh, deploy race), this surfaces the gap before any write hits
  // it. Callers retry on throw; the next request will re-enter
  // initD1Schema and re-attempt the ALTERs.
  await verifyColumnsAddressable(db, [
    ['skill_candidates', [
      'approved_at', 'supersedes',
      'evidence_bundle_id', 'quality_score',
      'quality_failures', 'coverage_matches',
      'last_reconciled_at', 'reconciliation_reason',
      'project_id',
    ]],
    ['prompt_batches', ['parent_prompt_batch_id', 'kind', 'origin', 'project_id']],
    ['plans', ['logical_key', 'project_id']],
    ['skill_usage', ['synced_at', 'project_id']],
    ['sessions', ['project_id']],
    ['spores', ['project_id']],
    ['entities', ['project_id']],
    ['graph_edges', ['project_id']],
    ['artifacts', ['project_id']],
    ['entity_mentions', ['project_id']],
    ['resolution_events', ['project_id']],
    ['digest_extracts', ['project_id']],
    ['skill_records', ['project_id']],
  ]);

  for (const sql of [...POST_MIGRATION_INDEXES, ...PROJECT_SCOPE_INDEXES]) {
    await db.prepare(sql).run();
  }

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

  // One-shot prune for the retired matrix-evaluation feature. Mirrors
  // the local v24 migration. The tables/columns may never have been
  // created on this D1 (the worker schema never carried them), so each
  // step is IF EXISTS — the marker still gets written so we don't keep
  // attempting the drops on every Worker invocation.
  const evalMarker = await db
    .prepare(`SELECT value FROM team_config WHERE key = ?`)
    .bind('evaluation_feature_pruned')
    .first<{ value: string }>();

  if (!evalMarker) {
    const evalDrops = [
      'DROP INDEX IF EXISTS idx_agent_runs_evaluation_id',
      'DROP TABLE IF EXISTS agent_run_evaluations',
    ];
    for (const sql of evalDrops) {
      try {
        await db.prepare(sql).run();
      } catch {
        // Missing table/index is the expected case for D1s that never
        // carried the evaluation feature.
      }
    }
    try {
      await db.prepare('ALTER TABLE agent_runs DROP COLUMN evaluation_id').run();
    } catch {
      // Column or table absent — expected.
    }
    await db
      .prepare(`INSERT INTO team_config (key, value) VALUES (?, ?)`)
      .bind('evaluation_feature_pruned', '1')
      .run();
  }

  // One-shot prune for orphan `project_id` rows: NULL, empty, or any
  // non-`proj_<32 hex>` value. These came from pre-Grove daemon writers
  // that quietly enqueued bad ids before the brand was added locally
  // (and the corresponding worker-side gate in handleEnqueue). Mirrors
  // the local v36 sweep and converges D1 with the cleaned-up vault.
  // Marker-guarded so the prune runs once per D1.
  const projectIdPruneMarker = await db
    .prepare(`SELECT value FROM team_config WHERE key = ?`)
    .bind('project_id_orphans_pruned_v36')
    .first<{ value: string }>();

  if (!projectIdPruneMarker) {
    // Compatibility gate: defer the destructive prune until every
    // active node in the `nodes` table has registered at
    // >= options.minClientVersion. Pre-Grove daemons (no
    // sync_protocol_version row, or a value below the floor) still
    // own valid pre-Grove rows in D1; running the prune on the
    // worker's first boot after upgrade would silently delete that
    // teammate's data on every other teammate's machine. Skipping
    // the marker write means we re-evaluate next boot — the prune
    // runs as soon as all teammates ship the upgrade, with no
    // operator intervention.
    const safeToPrune = await arePruneClientsAtMinVersion(db, options.minClientVersion);
    if (!safeToPrune) {
      return;
    }

    const tablesToPrune: readonly string[] = [
      'sessions',
      'prompt_batches',
      'spores',
      'entities',
      'graph_edges',
      'plans',
      'artifacts',
      'entity_mentions',
      'resolution_events',
      'digest_extracts',
      'skill_candidates',
      'skill_records',
      'skill_usage',
      'knowledge_release_state',
    ];
    for (const table of tablesToPrune) {
      try {
        await db
          .prepare(
            `DELETE FROM ${table}
              WHERE project_id IS NULL
                 OR project_id = ''
                 OR project_id NOT LIKE 'proj_%'`,
          )
          .run();
      } catch {
        // Table absent on this D1 (e.g. an older deploy that hasn't
        // received every column yet) — skip and move on.
      }
    }
    await db
      .prepare(`INSERT INTO team_config (key, value) VALUES (?, ?)`)
      .bind('project_id_orphans_pruned_v36', '1')
      .run();
  }
}

/**
 * Verify the listed columns are addressable on `db`. Issues one
 * `SELECT <columns> FROM <table> LIMIT 0` per table. A `no such
 * column` parser error throws with the missing table+column so the
 * caller can surface the gap and retry.
 */
async function verifyColumnsAddressable(
  db: D1Database,
  expected: ReadonlyArray<readonly [string, readonly string[]]>,
): Promise<void> {
  for (const [table, columns] of expected) {
    if (columns.length === 0) continue;
    const projection = columns.join(', ');
    try {
      await db.prepare(`SELECT ${projection} FROM ${table} LIMIT 0`).run();
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(
        `D1 schema verification failed for ${table}(${projection}): ${reason}. ` +
        `Expected ALTER TABLE columns are not addressable on this connection. ` +
        `Subsequent requests will retry initD1Schema.`,
      );
    }
  }
}

/**
 * Active-node window for the prune gate. A node that hasn't checked
 * in within this window is treated as departed and ignored — without
 * this, a single stale node on protocol v0/null would block the
 * prune forever. Mirrors the 30-day "active machine" definition the
 * daemon uses on the local outbox.
 */
const PRUNE_ACTIVE_WINDOW_SECONDS = 30 * 24 * 60 * 60;

/**
 * True when it's safe to run the v36 project-id orphan prune.
 *
 * Returns false when *any* active node has registered at a protocol
 * below `minClientVersion`, OR has never recorded a protocol version
 * at all (NULL is treated as v1 — the historical pre-version client).
 *
 * If `minClientVersion` is undefined the gate is bypassed (preserves
 * the legacy "always prune" behavior for callers that don't pass it).
 */
async function arePruneClientsAtMinVersion(
  db: D1Database,
  minClientVersion: number | undefined,
): Promise<boolean> {
  if (typeof minClientVersion !== 'number' || !Number.isFinite(minClientVersion)) {
    return true;
  }
  try {
    const cutoff = Math.floor(Date.now() / 1000) - PRUNE_ACTIVE_WINDOW_SECONDS;
    const row = await db
      .prepare(
        `SELECT COUNT(*) AS unsafe
           FROM nodes
          WHERE last_seen >= ?
            AND COALESCE(sync_protocol_version, 1) < ?`,
      )
      .bind(cutoff, minClientVersion)
      .first<{ unsafe: number }>();
    return Number(row?.unsafe ?? 0) === 0;
  } catch {
    // `nodes` table may be missing on a brand-new D1 that hasn't
    // received any /connect calls yet. With nothing to protect, the
    // prune is safe — this is the fresh-deploy fast path.
    return true;
  }
}
