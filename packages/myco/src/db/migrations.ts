/**
 * Schema migrations for the Myco vault database.
 *
 * Each migration is a function that upgrades the database from version N-1 to N.
 * The MIGRATIONS registry provides a declarative list that createSchema() can
 * iterate over instead of hand-coding version checks.
 */

import type { Database } from 'better-sqlite3';
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
  AGENT_RUN_EVALUATIONS_TABLE,
} from './schema-ddl.js';

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
    db.exec(AGENT_RUN_EVALUATIONS_TABLE);

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
