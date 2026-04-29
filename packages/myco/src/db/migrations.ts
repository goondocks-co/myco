/**
 * Schema migrations for the Myco vault database.
 *
 * Each migration is a function that upgrades the database from version N-1 to N.
 * The MIGRATIONS registry provides a declarative list that createSchema() can
 * iterate over instead of hand-coding version checks.
 */

import type { Database } from 'bun:sqlite';
import { epochSeconds, DEFAULT_MACHINE_ID } from '@myco/constants.js';
import { CANDIDATE_STATUS } from '@myco/constants/skill-candidate-status.js';
import {
  LOG_ENTRIES_TABLE,
  TEAM_OUTBOX_TABLE,
  SKILL_CANDIDATES_TABLE,
  SKILL_RECORDS_TABLE,
  SKILL_LINEAGE_TABLE,
  SKILL_USAGE_TABLE,
  NOTIFICATIONS_TABLE,
  AGENT_RUN_WRITE_INTENTS_TABLE,
  DIGEST_EXTRACT_REVISIONS_TABLE,
  CORTEX_INSTRUCTIONS_TABLE,
  MIGRATION_TASKS_TABLE,
  CANOPY_ENTRIES_TABLE,
  CANOPY_MAPS_TABLE,
  CANOPY_SESSION_COLUMNS,
  CANOPY_ACTIVITY_COLUMN,
  CANOPY_INDEX_DDLS,
} from './schema-ddl.js';
import {
  buildPlanId,
  deriveStoredPlanLogicalKey,
} from '@myco/plans/identity.js';

// ---------------------------------------------------------------------------
// Migration interface + registry
// ---------------------------------------------------------------------------

export interface Migration {
  version: number;
  migrate: (db: Database, machineId: string) => void;
}

export const MIGRATIONS: Migration[] = [
  { version: 2, migrate: (db) => migrateV1ToV2(db) },
  { version: 3, migrate: (db) => migrateV2ToV3(db) },
  { version: 4, migrate: migrateV3ToV4 },
  { version: 5, migrate: (db) => migrateV4ToV5(db) },
  { version: 6, migrate: (db) => migrateV5ToV6(db) },
  { version: 7, migrate: migrateV6ToV7 },
  { version: 8, migrate: (db) => migrateV7ToV8(db) },
  { version: 9, migrate: (db) => migrateV8ToV9(db) },
  { version: 10, migrate: (db) => migrateV9ToV10(db) },
  { version: 11, migrate: (db) => migrateV10ToV11(db) },
  { version: 12, migrate: (db) => migrateV11ToV12(db) },
  { version: 13, migrate: (db) => migrateV12ToV13(db) },
  { version: 14, migrate: (db) => migrateV13ToV14(db) },
  { version: 15, migrate: (db) => migrateV14ToV15(db) },
  { version: 16, migrate: (db) => migrateV15ToV16(db) },
  { version: 17, migrate: (db) => migrateV16ToV17(db) },
  { version: 18, migrate: (db) => migrateV17ToV18(db) },
  { version: 19, migrate: (db) => migrateV18ToV19(db) },
  { version: 20, migrate: (db, machineId) => migrateV19ToV20(db, machineId) },
  { version: 21, migrate: (db) => migrateV20ToV21(db) },
  { version: 22, migrate: (db) => migrateV21ToV22(db) },
  { version: 23, migrate: (db) => migrateV22ToV23(db) },
  { version: 24, migrate: (db) => migrateV23ToV24(db) },
  { version: 25, migrate: (db) => migrateV24ToV25(db) },
  { version: 26, migrate: (db) => migrateV25ToV26(db) },
  { version: 27, migrate: (db) => migrateV26ToV27(db) },
  { version: 28, migrate: (db) => migrateV27ToV28(db) },
];

// ---------------------------------------------------------------------------
// Individual migration functions
// ---------------------------------------------------------------------------

/**
 * Return the set of column names on a table, via PRAGMA table_info.
 * Used to make ADD COLUMN migrations idempotent without wrapping each
 * statement in a try/catch inside a transaction (which poisons the txn).
 */
function getTableColumnSet(db: Database, tableName: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
  return new Set(rows.map((r) => r.name));
}

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

function migrateV17ToV18(db: Database): void {
  db.exec('BEGIN');
  try {
    db.exec(CORTEX_INSTRUCTIONS_TABLE);
    db.exec(
      'CREATE INDEX IF NOT EXISTS idx_cortex_instructions_agent_id ON cortex_instructions (agent_id)',
    );

    db.prepare(
      `INSERT INTO schema_version (version, applied_at)
       VALUES (?, ?)
       ON CONFLICT (version) DO NOTHING`,
    ).run(18, epochSeconds());

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/**
 * Version 19 removes Cortex instructions from the team-sync surface.
 *
 * Cortex instructions are local operating guidance, not shared team
 * knowledge. No current call site enqueues `cortex_instructions` outbox
 * rows, so this DELETE is a safety net — the real invariant is enforced
 * in `enqueueOutbox` via LOCAL_ONLY_OUTBOX_TABLES. Any rows that slipped
 * in from an older build are cleared here so they don't linger as
 * futile retries; new inserts for this table name are rejected at the
 * enqueue layer.
 */
function migrateV18ToV19(db: Database): void {
  db.exec('BEGIN');
  try {
    db.prepare(
      'DELETE FROM team_outbox WHERE table_name = ?',
    ).run('cortex_instructions');

    db.prepare(
      `INSERT INTO schema_version (version, applied_at)
       VALUES (?, ?)
       ON CONFLICT (version) DO NOTHING`,
    ).run(19, epochSeconds());

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/**
 * Migrate a version-12 database to version-13.
 *
 * Version 13 adds first-class agent runtime/checkpoint fields so runs can be
 * resumed without overloading actions_taken JSON.
 */
function migrateV12ToV13(db: Database): void {
  const existing = getTableColumnSet(db, 'agent_runs');
  const columnAdds: Array<[string, string]> = [
    ['runtime', 'TEXT'],
    ['provider', 'TEXT'],
    ['model', 'TEXT'],
    ['session_ref', 'TEXT'],
    ['resumable', 'INTEGER DEFAULT 0'],
    ['resume_status', 'TEXT'],
    ['resume_mode', 'TEXT'],
    ['resumed_at', 'INTEGER'],
    ['checkpoints', 'TEXT'],
    ['usage_data', 'TEXT'],
  ];
  const pendingAdds = columnAdds.filter(([name]) => !existing.has(name));

  db.exec('BEGIN');
  try {
    for (const [name, decl] of pendingAdds) {
      db.exec(`ALTER TABLE agent_runs ADD COLUMN ${name} ${decl}`);
    }

    const newIndexes = [
      `CREATE INDEX IF NOT EXISTS idx_agent_runs_task_status_started_at ON agent_runs (task, status, started_at)`,
      `CREATE INDEX IF NOT EXISTS idx_agent_runs_resumable_task ON agent_runs (task, resumable, completed_at)`,
    ];
    for (const idx of newIndexes) {
      db.exec(idx);
    }

    db.prepare(
      `INSERT INTO schema_version (version, applied_at)
       VALUES (?, ?)
       ON CONFLICT (version) DO NOTHING`,
    ).run(13, epochSeconds());

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/**
 * Migrate a version-13 database to version-14.
 *
 * Version 14 adds richer local-only cost accounting metadata for agent runs.
 * These columns intentionally stay on the local SQLite vault only and are not
 * part of team sync / outbox payloads.
 */
function migrateV13ToV14(db: Database): void {
  const existing = getTableColumnSet(db, 'agent_runs');
  const columnAdds: Array<[string, string]> = [
    ['actual_cost_usd', 'REAL'],
    ['estimated_cost_usd', 'REAL'],
    ['cost_source', 'TEXT'],
    ['cost_data', 'TEXT'],
  ];
  const pendingAdds = columnAdds.filter(([name]) => !existing.has(name));

  db.exec('BEGIN');
  try {
    for (const [name, decl] of pendingAdds) {
      db.exec(`ALTER TABLE agent_runs ADD COLUMN ${name} ${decl}`);
    }

    db.prepare(
      `INSERT INTO schema_version (version, applied_at)
       VALUES (?, ?)
       ON CONFLICT (version) DO NOTHING`
    ).run(14, epochSeconds());

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/**
 * Test-only re-export of the v20 collision resolver. The migration itself is
 * internal; tests need this entry point to assert the collision guard.
 */
export function resolveV20PlanIdentityCollisionsForTest(db: Database): void {
  resolveV20PlanIdentityCollisions(db);
}

/**
 * Resolve any logical-key collisions in the v20 plan migration staging pass.
 *
 * Used after the first pass populates id_next / logical_key_next on every
 * plan row. Rows whose derived logical key was already taken by an earlier
 * row get moved onto a per-row legacy key so no two rows end up with the
 * same plan id after the swap.
 *
 * Throws a descriptive error if a collision would remain even after the
 * legacy-key fallback -- the caller is expected to fail the migration and
 * surface the conflicting keys to the operator.
 */
function resolveV20PlanIdentityCollisions(db: Database): void {
  const dupes = db.prepare(
    `SELECT logical_key_next, COUNT(*) AS n
       FROM plans
       WHERE logical_key_next <> ''
       GROUP BY logical_key_next
       HAVING n > 1`,
  ).all() as Array<{ logical_key_next: string; n: number }>;

  if (dupes.length > 0) {
    const rowsForKey = db.prepare(
      `SELECT id, session_id
         FROM plans
         WHERE logical_key_next = ?
         ORDER BY created_at ASC, id ASC`,
    );
    const updateStaging = db.prepare(
      `UPDATE plans
          SET logical_key_next = ?, id_next = ?
        WHERE id = ?`,
    );

    for (const dupe of dupes) {
      const conflicting = rowsForKey.all(dupe.logical_key_next) as Array<{ id: string; session_id: string | null }>;
      for (let i = 1; i < conflicting.length; i += 1) {
        const row = conflicting[i];
        const legacyKey = row.session_id
          ? `session:${row.session_id}:legacy:${row.id}`
          : `legacy:${row.id}`;
        updateStaging.run(legacyKey, buildPlanId(legacyKey), row.id);
      }
    }
  }

  // Final guard: ensure the staging pass is collision-free. If a collision
  // still exists after the legacy fallback, surface a descriptive error
  // listing the offending keys rather than letting the swap hit a UNIQUE
  // constraint violation.
  const remaining = db.prepare(
    `SELECT id_next, GROUP_CONCAT(id, ',') AS ids
       FROM plans
       WHERE id_next IS NOT NULL
       GROUP BY id_next
       HAVING COUNT(*) > 1`,
  ).all() as Array<{ id_next: string; ids: string }>;

  if (remaining.length > 0) {
    const detail = remaining
      .map((r) => `${r.id_next} <= [${r.ids}]`)
      .join('; ');
    throw new Error(
      `v20 plan migration: plan id collisions after legacy fallback: ${detail}`,
    );
  }
}

/**
 * Version 20 adds plans.logical_key and backfills plan identity so capture
 * channels can converge on one last-write-wins row per logical plan.
 *
 * This is intentionally a forward migration on top of the shipped v19 schema
 * chain from main. Earlier versions keep their original meaning; logical-key
 * plan identity is introduced only once the vault reaches v20.
 *
 * Identity swap is performed in two passes:
 *   1. Populate `id_next` / `logical_key_next` staging columns with the
 *      computed values for every row, and resolve any collisions before
 *      touching the primary key.
 *   2. Swap `id` / `logical_key` from the staging columns in a single
 *      UPDATE. This guarantees we never attempt an UPDATE that would fail
 *      with a UNIQUE violation mid-loop and leave the vault stuck at v19.
 */
function migrateV19ToV20(db: Database, machineId: string): void {
  db.exec('BEGIN');
  try {
    const planColumns = getTableColumnSet(db, 'plans');
    if (!planColumns.has('logical_key')) {
      db.exec(`ALTER TABLE plans ADD COLUMN logical_key TEXT NOT NULL DEFAULT ''`);
    }
    // Staging columns for the two-pass identity swap. Dropped before COMMIT.
    if (!planColumns.has('id_next')) {
      db.exec(`ALTER TABLE plans ADD COLUMN id_next TEXT`);
    }
    if (!planColumns.has('logical_key_next')) {
      db.exec(`ALTER TABLE plans ADD COLUMN logical_key_next TEXT NOT NULL DEFAULT ''`);
    }

    const rows = db.prepare(
      `SELECT *
       FROM plans
       ORDER BY created_at ASC, id ASC`,
    ).all() as Array<{
      id: string;
      logical_key?: string;
      status: string | null;
      author: string | null;
      title: string | null;
      content: string | null;
      source_path: string | null;
      tags: string | null;
      session_id: string | null;
      prompt_batch_id: number | null;
      content_hash: string | null;
      processed: number | null;
      created_at: number;
      updated_at: number | null;
      embedded: number | null;
      machine_id: string | null;
      synced_at: number | null;
    }>;

    // Pass 1: populate staging columns with derived identities.
    const writeStaging = db.prepare(
      `UPDATE plans
          SET id_next = ?, logical_key_next = ?
        WHERE id = ?`,
    );
    for (const row of rows) {
      const derivedLogicalKey = deriveStoredPlanLogicalKey(row);
      writeStaging.run(buildPlanId(derivedLogicalKey), derivedLogicalKey, row.id);
    }

    // Pass 1b: reassign any colliding rows onto per-row legacy keys and
    // verify the staging pass is collision-free before the swap.
    resolveV20PlanIdentityCollisions(db);

    // Build a map of each row's previous logical_key (pre-swap) so the
    // outbox re-enqueue step can detect whether identity actually changed.
    const previousLogicalKeyByOldId = new Map<string, string>();
    const previousIdNextByOldId = new Map<string, string>();
    const staged = db.prepare(
      `SELECT id, id_next, logical_key, logical_key_next FROM plans`,
    ).all() as Array<{ id: string; id_next: string | null; logical_key: string | null; logical_key_next: string }>;
    for (const row of staged) {
      previousLogicalKeyByOldId.set(row.id, row.logical_key ?? '');
      if (row.id_next) previousIdNextByOldId.set(row.id, row.id_next);
    }

    // Pass 2: swap identity columns in place. Because the staging columns
    // are collision-free, the final id update cannot violate UNIQUE.
    db.prepare(
      `UPDATE plans
          SET embedded = CASE WHEN id = id_next THEN embedded ELSE 0 END,
              synced_at = CASE WHEN id = id_next THEN synced_at ELSE NULL END
        WHERE id_next IS NOT NULL`,
    ).run();
    db.prepare(
      `UPDATE plans
          SET id = id_next,
              logical_key = logical_key_next
        WHERE id_next IS NOT NULL`,
    ).run();

    // Finalize: enqueue outbox operations for rows whose identity changed.
    // Skip enqueuing upserts for rows whose id AND logical_key match their
    // prior values -- those rows retain their existing outbox state.
    // (Finding #39)
    const deleteOutboxEntries = db.prepare(
      `DELETE FROM team_outbox
       WHERE table_name = 'plans' AND row_id IN (?, ?)`,
    );
    const enqueueOutbox = db.prepare(
      `INSERT INTO team_outbox (table_name, row_id, operation, payload, machine_id, created_at)
       VALUES ('plans', ?, ?, ?, ?, ?)`,
    );
    const now = epochSeconds();

    for (const row of rows) {
      const nextId = previousIdNextByOldId.get(row.id) ?? row.id;
      const fresh = db.prepare(`SELECT * FROM plans WHERE id = ?`).get(nextId) as Record<string, unknown> | undefined;

      const identityChanged = nextId !== row.id;
      const previousLogicalKey = previousLogicalKeyByOldId.get(row.id) ?? '';
      const currentLogicalKey = (fresh?.logical_key as string | undefined) ?? '';
      const logicalKeyChanged = previousLogicalKey !== currentLogicalKey;
      const needsResync = identityChanged || logicalKeyChanged;

      if (!needsResync) continue;

      deleteOutboxEntries.run(row.id, nextId);

      if (identityChanged) {
        enqueueOutbox.run(
          row.id,
          'delete',
          JSON.stringify({ id: row.id }),
          row.machine_id ?? machineId,
          now,
        );
      }

      if (fresh) {
        const { id_next: _idNext, logical_key_next: _lkNext, ...publishable } = fresh;
        enqueueOutbox.run(
          nextId,
          'upsert',
          JSON.stringify(publishable),
          (fresh.machine_id as string | null) ?? machineId,
          now,
        );
      }
    }

    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_plans_logical_key ON plans (logical_key)`);

    // Drop staging columns now that the swap is committed. SQLite supports
    // DROP COLUMN since 3.35; our minimum version is newer.
    db.exec(`ALTER TABLE plans DROP COLUMN id_next`);
    db.exec(`ALTER TABLE plans DROP COLUMN logical_key_next`);

    db.prepare(
      `INSERT INTO schema_version (version, applied_at)
       VALUES (?, ?)
       ON CONFLICT (version) DO NOTHING`,
    ).run(20, epochSeconds());

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
 * Migrate v6 -> v7: fix stale 'local' machine_id on ALL synced tables.
 *
 * The agent vault tools historically used DEFAULT_MACHINE_ID ('local')
 * instead of the resolved machine identity. This one-time data migration
 * fixes all affected records and re-queues them for team sync.
 */
function migrateV6ToV7(db: Database, machineId: string): void {
  if (machineId === 'local' || machineId === DEFAULT_MACHINE_ID) return; // Nothing to fix

  db.exec('BEGIN');
  try {
    // entity_mentions excluded -- no `id` column (composite key: entity_id, note_id, note_type)
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
 * Migrate v7 -> v8: add notifications table.
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
 * Version 10 adds an audit trail for skill candidate approvals.
 *
 *   - skill_candidates.approved_at INTEGER (nullable) — timestamp of the
 *     first transition into status='approved'. Auto-managed by
 *     updateCandidate going forward.
 *
 * Backfill: rows currently in status 'approved' or 'generated' get
 * approved_at set to the migration timestamp. This is a one-time,
 * deliberately-imprecise assumption — the true approval time is lost
 * for existing rows, so we record "as of the migration, these were
 * considered approved" rather than inventing timestamps.
 *
 * Rows in 'identified' or 'dismissed' state keep approved_at = NULL.
 *
 * Idempotent: the ALTER is wrapped in try/catch so re-runs tolerate the
 * existing column; the backfill uses `WHERE approved_at IS NULL` so it
 * never overwrites a previously-recorded timestamp.
 */
function migrateV9ToV10(db: Database): void {
  db.exec('BEGIN');
  try {
    try {
      db.exec('ALTER TABLE skill_candidates ADD COLUMN approved_at INTEGER');
    } catch {
      // Column already exists -- safe to ignore on re-run
    }

    const now = epochSeconds();
    db.prepare(
      `UPDATE skill_candidates
         SET approved_at = ?
       WHERE approved_at IS NULL
         AND status IN (?, ?)`,
    ).run(now, CANDIDATE_STATUS.APPROVED, CANDIDATE_STATUS.GENERATED);

    db.prepare(
      `INSERT INTO schema_version (version, applied_at)
       VALUES (?, ?)
       ON CONFLICT (version) DO NOTHING`,
    ).run(10, epochSeconds());

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/**
 * Version 11 adds supersedes tracking to skill candidates.
 *
 *   - skill_candidates.supersedes TEXT (nullable) — JSON array of skill
 *     record names that this candidate would replace. Used by the skill
 *     survey task to create domain-level candidates that explicitly
 *     subsume existing narrow skills.
 *
 * Idempotent: the ALTER is wrapped in try/catch so re-runs tolerate the
 * existing column.
 */
function migrateV10ToV11(db: Database): void {
  db.exec('BEGIN');
  try {
    try {
      db.exec('ALTER TABLE skill_candidates ADD COLUMN supersedes TEXT');
    } catch {
      // Column already exists -- safe to ignore on re-run
    }

    db.prepare(
      `INSERT INTO schema_version (version, applied_at)
       VALUES (?, ?)
       ON CONFLICT (version) DO NOTHING`,
    ).run(11, epochSeconds());

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/**
 * Version 12 adds embedding support for skill records.
 *
 *   - skill_records.embedded INTEGER DEFAULT 0 — flag for the embedding
 *     pipeline to know which rows still need vectors.
 *
 * Idempotent: the ALTER is wrapped in try/catch so re-runs tolerate the
 * existing column.
 */
function migrateV11ToV12(db: Database): void {
  db.exec('BEGIN');
  try {
    try {
      db.exec('ALTER TABLE skill_records ADD COLUMN embedded INTEGER DEFAULT 0');
    } catch {
      // Column already exists
    }

    db.prepare(
      `INSERT INTO schema_version (version, applied_at)
       VALUES (?, ?)
       ON CONFLICT (version) DO NOTHING`,
    ).run(12, epochSeconds());

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/**
 * Version 15 adds the evaluation / dry-run harness storage:
 *   - agent_run_write_intents — append-only log of dry-run attempted writes
 *   - digest_extract_revisions — append-only history of digest_extracts rows
 *   - agent_run_evaluations — matrix grouping record
 *   - agent_runs.dry_run INTEGER NOT NULL DEFAULT 0
 *   - agent_runs.evaluation_id TEXT (nullable, no FK)
 *
 * Each ALTER uses the standard idempotency guard. Table creation uses
 * `CREATE TABLE IF NOT EXISTS`.
 *
 * Note on write_intents: the table is append-only from the query layer
 * (no UPDATE/DELETE helper exposed). ON DELETE CASCADE on run_id is
 * intentional so parent-row purges still cleanly cascade.
 */
/**
 * Version 16 persists the reasoning level and full execution override packet
 * used for each run, so downstream consumers (eval comparison, RunTaskDialog
 * override editor, phase-level override execution) can reconstruct exactly
 * what configuration produced a run independent of the current task definition.
 *
 *   - agent_runs.reasoning_level TEXT (nullable) -- 'low' | 'default' | 'high'
 *   - agent_runs.execution_overrides TEXT (nullable) -- JSON of RunOptions.executionOverrides
 *
 * Each ALTER uses the standard idempotency guard; NULL is the expected value
 * for runs that used the task default config throughout.
 */
function migrateV15ToV16(db: Database): void {
  const existing = getTableColumnSet(db, 'agent_runs');
  const columnAdds: Array<[string, string]> = [
    ['reasoning_level', 'TEXT'],
    ['execution_overrides', 'TEXT'],
  ];
  const pendingAdds = columnAdds.filter(([name]) => !existing.has(name));

  db.exec('BEGIN');
  try {
    for (const [name, decl] of pendingAdds) {
      db.exec(`ALTER TABLE agent_runs ADD COLUMN ${name} ${decl}`);
    }

    db.prepare(
      `INSERT INTO schema_version (version, applied_at)
       VALUES (?, ?)
       ON CONFLICT (version) DO NOTHING`,
    ).run(16, epochSeconds());

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/**
 * Version 17 adds a composite index on agent_run_write_intents to speed up
 * the per-evaluation batched tool-count query:
 *
 *   SELECT wi.run_id, wi.tool_name, COUNT(*)
 *   FROM agent_run_write_intents wi
 *   JOIN agent_runs r ON r.id = wi.run_id
 *   WHERE r.evaluation_id = ?
 *   GROUP BY wi.run_id, wi.tool_name
 *
 * The existing `idx_write_intents_run_id` already serves the equality
 * filter, but the composite index lets SQLite resolve the GROUP BY
 * directly from the index without a separate sort pass.
 *
 * Fully idempotent: `IF NOT EXISTS` on the index, no DDL on the base
 * table.
 */
function migrateV16ToV17(db: Database): void {
  db.exec('BEGIN');
  try {
    db.exec(
      'CREATE INDEX IF NOT EXISTS idx_write_intents_run_id_tool ON agent_run_write_intents (run_id, tool_name)',
    );

    db.prepare(
      `INSERT INTO schema_version (version, applied_at)
       VALUES (?, ?)
       ON CONFLICT (version) DO NOTHING`,
    ).run(17, epochSeconds());

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// Inlined for historical migration-chain fidelity: the v24 migration
// drops this table, but vaults stamped at v14 or below still need the
// table created as part of their v15 step. The constant itself was
// removed from schema-ddl.ts when the feature was retired.
const AGENT_RUN_EVALUATIONS_TABLE_V15 = `
  CREATE TABLE IF NOT EXISTS agent_run_evaluations (
    id            TEXT PRIMARY KEY,
    task_id       TEXT NOT NULL,
    matrix_json   TEXT NOT NULL,
    notes         TEXT,
    status        TEXT NOT NULL DEFAULT 'pending',
    created_at    INTEGER NOT NULL,
    completed_at  INTEGER
  )`;

function migrateV14ToV15(db: Database): void {
  const existing = getTableColumnSet(db, 'agent_runs');
  const columnAdds: Array<[string, string]> = [
    ['dry_run', 'INTEGER NOT NULL DEFAULT 0'],
    ['evaluation_id', 'TEXT'],
  ];
  const pendingAdds = columnAdds.filter(([name]) => !existing.has(name));

  db.exec('BEGIN');
  try {
    db.exec(AGENT_RUN_WRITE_INTENTS_TABLE);
    db.exec(DIGEST_EXTRACT_REVISIONS_TABLE);
    db.exec(AGENT_RUN_EVALUATIONS_TABLE_V15);

    for (const [name, decl] of pendingAdds) {
      db.exec(`ALTER TABLE agent_runs ADD COLUMN ${name} ${decl}`);
    }

    const newIndexes = [
      'CREATE INDEX IF NOT EXISTS idx_write_intents_run_id ON agent_run_write_intents (run_id)',
      'CREATE INDEX IF NOT EXISTS idx_digest_revisions_agent_tier ON digest_extract_revisions (agent_id, tier, created_at DESC)',
      'CREATE INDEX IF NOT EXISTS idx_agent_runs_evaluation_id ON agent_runs (evaluation_id)',
    ];
    for (const idx of newIndexes) {
      db.exec(idx);
    }

    db.prepare(
      `INSERT INTO schema_version (version, applied_at)
       VALUES (?, ?)
       ON CONFLICT (version) DO NOTHING`,
    ).run(15, epochSeconds());

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/**
 * Migrate v20 → v21: retire the semantic knowledge graph.
 *
 * Prunes agent-created entities, entity mentions, and semantic-typed edges.
 * Lineage edges remain (daemon-created). Tables preserved for reversibility.
 */
function migrateV20ToV21(db: Database): void {
  db.prepare('BEGIN').run();
  try {
    // Guard each DELETE — the v13 migration-chain test scaffold omits these tables.
    if (tableExists(db, 'graph_edges')) {
      db.prepare(
        `DELETE FROM graph_edges WHERE type IN ('REFERENCES', 'AFFECTS', 'DEPENDS_ON', 'RELATES_TO')`,
      ).run();
    }
    if (tableExists(db, 'entity_mentions')) {
      db.prepare(`DELETE FROM entity_mentions`).run();
    }
    if (tableExists(db, 'entities')) {
      db.prepare(`DELETE FROM entities`).run();
    }

    db.prepare(
      `INSERT INTO schema_version (version, applied_at)
       VALUES (?, ?)
       ON CONFLICT (version) DO NOTHING`,
    ).run(21, epochSeconds());

    db.prepare('COMMIT').run();
  } catch (err) {
    db.prepare('ROLLBACK').run();
    throw err;
  }
}

function tableExists(db: Database, name: string): boolean {
  const row = db.prepare(
    `SELECT count(*) AS c FROM sqlite_master WHERE type = 'table' AND name = ?`,
  ).get(name) as { c: number };
  return row.c > 0;
}

/**
 * Migrate a version-21 database to version-22.
 *
 * Version 22 adds steering prompt nesting support:
 *   - prompt_batches.parent_prompt_batch_id (nullable FK to prompt_batches.id)
 *   - prompt_batches.kind (TEXT NOT NULL DEFAULT 'initial')
 *   - idx_prompt_batches_parent
 *
 * Existing rows get kind='initial', parent_prompt_batch_id=NULL — they render
 * exactly as before until the OpenCode backfill (Task 11) runs.
 */
function migrateV21ToV22(db: Database): void {
  db.prepare('BEGIN').run();
  try {
    if (tableExists(db, 'prompt_batches')) {
      const existing = getTableColumnSet(db, 'prompt_batches');

      if (!existing.has('parent_prompt_batch_id')) {
        db.prepare(
          `ALTER TABLE prompt_batches ADD COLUMN parent_prompt_batch_id INTEGER REFERENCES prompt_batches(id)`,
        ).run();
      }

      if (!existing.has('kind')) {
        db.prepare(
          `ALTER TABLE prompt_batches ADD COLUMN kind TEXT NOT NULL DEFAULT 'initial'`,
        ).run();
      }

      db.prepare(
        `CREATE INDEX IF NOT EXISTS idx_prompt_batches_parent ON prompt_batches (parent_prompt_batch_id)`,
      ).run();

      // Historical note: v22 originally contained an OpenCode backfill that
      // reclassified batches with response_summary=NULL as steering children.
      // That heuristic assumed missing summary implied mid-turn steering; in
      // practice the missing summaries were a separate capture bug in the
      // opencode plugin (stop events had no buffer fallback). The backfill
      // was removed before shipping to avoid mass-mislabeling real turns as
      // steering. Vaults that ran an intermediate build of v22 with the
      // heuristic can be corrected via the historical-repair path (null
      // response_summary recovery + parent/child reclassification run
      // together).
    }

    db.prepare(
      `INSERT INTO schema_version (version, applied_at)
       VALUES (?, ?)
       ON CONFLICT (version) DO NOTHING`,
    ).run(22, epochSeconds());

    db.prepare('COMMIT').run();
  } catch (err) {
    db.prepare('ROLLBACK').run();
    throw err;
  }
}

/** Migrate version 23: add `migration_tasks` ledger for runtime migrations. */
function migrateV22ToV23(db: Database): void {
  db.prepare('BEGIN').run();
  try {
    db.prepare(MIGRATION_TASKS_TABLE).run();

    db.prepare(
      `INSERT INTO schema_version (version, applied_at)
       VALUES (?, ?)
       ON CONFLICT (version) DO NOTHING`,
    ).run(23, epochSeconds());

    db.prepare('COMMIT').run();
  } catch (err) {
    db.prepare('ROLLBACK').run();
    throw err;
  }
}

/**
 * Migrate version 24: retire the matrix-evaluation feature.
 *
 * Drops `idx_agent_runs_evaluation_id`, the `agent_run_evaluations`
 * table, and the `agent_runs.evaluation_id` column. All other agent_runs
 * data (including dry_run, reasoning_level, execution_overrides) is
 * preserved.
 *
 * Requires SQLite >= 3.35 for `ALTER TABLE ... DROP COLUMN`. The bundled
 * better-sqlite3 on supported platforms ships a modern SQLite, so the
 * simple path is sufficient rather than the table-rebuild pattern.
 * Idempotent via `IF EXISTS` guards + a column-presence check before
 * DROP COLUMN.
 */
function migrateV23ToV24(db: Database): void {
  db.prepare('BEGIN').run();
  try {
    db.prepare('DROP INDEX IF EXISTS idx_agent_runs_evaluation_id').run();
    db.prepare('DROP TABLE IF EXISTS agent_run_evaluations').run();

    const cols = getTableColumnSet(db, 'agent_runs');
    if (cols.has('evaluation_id')) {
      db.prepare('ALTER TABLE agent_runs DROP COLUMN evaluation_id').run();
    }

    db.prepare(
      `INSERT INTO schema_version (version, applied_at)
       VALUES (?, ?)
       ON CONFLICT (version) DO NOTHING`,
    ).run(24, epochSeconds());

    db.prepare('COMMIT').run();
  } catch (err) {
    db.prepare('ROLLBACK').run();
    throw err;
  }
}

/**
 * Version 25 lands the Canopy code-intelligence layer:
 *   - new `canopy_entries` table (project-scoped source file index)
 *   - `activities.canopy_injection_tokens` — per-Read injection cost, NULL otherwise
 *   - six aggregate columns on `sessions` for per-session injection outcomes
 *   - two indexes on canopy_entries (content_hash lookup, mechanical_updated_at scan)
 *
 * All new columns on existing tables are nullable; pre-feature rows stay NULL.
 */
function migrateV24ToV25(db: Database): void {
  const existingSessions = getTableColumnSet(db, 'sessions');
  const sessionPending = CANOPY_SESSION_COLUMNS.filter(([name]) => !existingSessions.has(name));

  const existingActivities = getTableColumnSet(db, 'activities');
  const [activityName, activityDecl] = CANOPY_ACTIVITY_COLUMN;
  const activityPending = !existingActivities.has(activityName);

  db.prepare('BEGIN').run();
  try {
    db.prepare(CANOPY_ENTRIES_TABLE).run();

    for (const [name, decl] of sessionPending) {
      db.prepare(`ALTER TABLE sessions ADD COLUMN ${name} ${decl}`).run();
    }
    if (activityPending) {
      db.prepare(`ALTER TABLE activities ADD COLUMN ${activityName} ${activityDecl}`).run();
    }

    for (const ddl of CANOPY_INDEX_DDLS) db.prepare(ddl).run();

    db.prepare(
      `INSERT INTO schema_version (version, applied_at)
       VALUES (?, ?)
       ON CONFLICT (version) DO NOTHING`,
    ).run(25, epochSeconds());

    db.prepare('COMMIT').run();
  } catch (err) {
    db.prepare('ROLLBACK').run();
    throw err;
  }
}

/**
 * Version 26 adds the `embedded` column to `canopy_entries`:
 *   - canopy_entries.embedded — INTEGER NOT NULL DEFAULT 0
 *
 * This flag tracks which rows need to be sent to the embedding pipeline.
 * Pre-v26 rows start at 0 (eligible for embedding).
 */
function migrateV25ToV26(db: Database): void {
  const existing = getTableColumnSet(db, 'canopy_entries');
  if (existing.has('embedded')) {
    db.prepare(
      `INSERT INTO schema_version (version, applied_at)
       VALUES (?, ?)
       ON CONFLICT (version) DO NOTHING`,
    ).run(26, epochSeconds());
    return;
  }

  db.prepare('BEGIN').run();
  try {
    db.prepare(`ALTER TABLE canopy_entries ADD COLUMN embedded INTEGER DEFAULT 0`).run();
    db.prepare(
      `INSERT INTO schema_version (version, applied_at)
       VALUES (?, ?)
       ON CONFLICT (version) DO NOTHING`,
    ).run(26, epochSeconds());
    db.prepare('COMMIT').run();
  } catch (err) {
    db.prepare('ROLLBACK').run();
    throw err;
  }
}

function migrateV26ToV27(db: Database): void {
  const sessionCols = getTableColumnSet(db, 'sessions');
  const sessionPending = !sessionCols.has('canopy_map_tool_calls');

  db.prepare('BEGIN').run();
  try {
    db.prepare(CANOPY_MAPS_TABLE).run();
    if (sessionPending) {
      db.prepare(`ALTER TABLE sessions ADD COLUMN canopy_map_tool_calls INTEGER NOT NULL DEFAULT 0`).run();
    }
    db.prepare(
      `INSERT INTO schema_version (version, applied_at)
       VALUES (?, ?)
       ON CONFLICT (version) DO NOTHING`,
    ).run(27, epochSeconds());
    db.prepare('COMMIT').run();
  } catch (err) {
    db.prepare('ROLLBACK').run();
    throw err;
  }
}

/**
 * Version 28 cleans up `canopy_entries` rows that the new layered exclude
 * matcher would now reject. Earlier scans had no baseline of "obvious noise"
 * (`.git/`, `node_modules/`, `__pycache__/`, virtualenvs, build outputs,
 * lockfiles), and they only honored the project root's `.gitignore`, not
 * nested `.gitignore` files. Vaults that ran older Canopy scans accumulated
 * stale rows for those paths.
 *
 * The patterns below are inlined (not imported from
 * `CANOPY_DEFAULT_EXCLUDE_PATTERNS`) so the migration stays self-contained
 * and frozen at the v28 contract — future additions to the live baseline
 * won't retroactively change what this migration deleted. Pure path-string
 * matching, no fs access required.
 */
const V28_CANOPY_BASELINE_SEGMENTS: readonly string[] = [
  '.git', '.DS_Store',
  'node_modules',
  '__pycache__', '.venv', 'venv', 'env', 'ENV',
  '.pytest_cache', '.ruff_cache', '.mypy_cache', '.tox',
  'dist', 'build', 'target', '.gradle', '.cache',
  '.next', '.nuxt', '.turbo', '.svelte-kit',
];

const V28_CANOPY_BASELINE_BASENAMES: readonly string[] = [
  'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock',
];

function pathMatchesV28Baseline(p: string): boolean {
  const normalized = p.replace(/\\/g, '/');
  const segments = normalized.split('/');
  for (const seg of segments) {
    if (V28_CANOPY_BASELINE_SEGMENTS.includes(seg)) return true;
  }
  const basename = segments[segments.length - 1] ?? '';
  if (V28_CANOPY_BASELINE_BASENAMES.includes(basename)) return true;
  if (basename.endsWith('.lock')) return true;
  return false;
}

function migrateV27ToV28(db: Database): void {
  db.prepare('BEGIN').run();
  try {
    // Pull every (project_id, path) pair and delete the ones matching
    // the frozen v28 baseline. Untouched rows keep all prior work
    // (descriptions, hashes, embedded flag).
    //
    // Embeddings note: vectors live in a separate vectors.db opened by
    // the daemon's embedding subsystem — this migration cannot touch
    // them directly. The EmbeddingManager's existing orphan sweep
    // (Phase 3 of each reconcile cycle, see daemon/embedding/manager.ts)
    // detects vectors whose record_id no longer matches an active
    // canopy_entries row and removes them on the next cycle.
    const rows = db
      .prepare('SELECT project_id, path FROM canopy_entries')
      .all() as Array<{ project_id: string; path: string }>;
    const del = db.prepare(
      'DELETE FROM canopy_entries WHERE project_id = ? AND path = ?',
    );
    let deleted = 0;
    for (const row of rows) {
      if (pathMatchesV28Baseline(row.path)) {
        del.run(row.project_id, row.path);
        deleted++;
      }
    }

    db.prepare(
      `INSERT INTO schema_version (version, applied_at)
       VALUES (?, ?)
       ON CONFLICT (version) DO NOTHING`,
    ).run(28, epochSeconds());
    db.prepare('COMMIT').run();
    if (deleted > 0) {
      console.log(`[migration v28] purged ${deleted} canopy_entries rows matching new exclude baseline`);
    }
  } catch (err) {
    db.prepare('ROLLBACK').run();
    throw err;
  }
}
