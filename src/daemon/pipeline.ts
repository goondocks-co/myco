/**
 * PipelineManager — SQLite-backed pipeline state for work item tracking,
 * stage transitions, and circuit breakers.
 *
 * Follows the same database pattern as MycoIndex (src/index/sqlite.ts):
 * better-sqlite3, WAL mode, CREATE IF NOT EXISTS for idempotency.
 */

import Database from 'better-sqlite3';
import path from 'node:path';
import type { PipelineStage, PipelineStatus, PipelineProviderRole } from '@myco/constants';

/** Database filename within the vault directory. */
const PIPELINE_DB_FILENAME = 'pipeline.db';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PipelineHealth {
  stages: Record<string, Record<string, number>>;
  circuits: Array<{
    provider_role: string;
    state: string;
    failure_count: number;
    last_error: string | null;
  }>;
  totals: {
    pending: number;
    processing: number;
    failed: number;
    blocked: number;
    poisoned: number;
    succeeded: number;
  };
}

// ---------------------------------------------------------------------------
// Schema SQL
// ---------------------------------------------------------------------------

const SCHEMA_SQL = `
  -- work_items: every piece of content in the pipeline
  CREATE TABLE IF NOT EXISTS work_items (
    id TEXT NOT NULL,
    item_type TEXT NOT NULL,
    source_path TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (id, item_type)
  );

  -- stage_transitions: append-only audit trail
  CREATE TABLE IF NOT EXISTS stage_transitions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    work_item_id TEXT NOT NULL,
    item_type TEXT NOT NULL,
    stage TEXT NOT NULL,
    status TEXT NOT NULL,
    attempt INTEGER DEFAULT 1,
    error_type TEXT,
    error_message TEXT,
    started_at TEXT,
    completed_at TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (work_item_id, item_type) REFERENCES work_items(id, item_type)
  );

  -- stage_history: compacted transitions older than retention window
  CREATE TABLE IF NOT EXISTS stage_history (
    work_item_id TEXT NOT NULL,
    item_type TEXT NOT NULL,
    stage TEXT NOT NULL,
    total_attempts INTEGER,
    final_status TEXT NOT NULL,
    first_attempt TEXT NOT NULL,
    last_attempt TEXT NOT NULL,
    last_error TEXT,
    error_types TEXT,
    PRIMARY KEY (work_item_id, item_type, stage)
  );

  -- circuit_breakers: per-provider-role state
  CREATE TABLE IF NOT EXISTS circuit_breakers (
    provider_role TEXT PRIMARY KEY,
    state TEXT NOT NULL DEFAULT 'closed',
    failure_count INTEGER DEFAULT 0,
    last_failure TEXT,
    last_error TEXT,
    opens_at TEXT,
    updated_at TEXT NOT NULL
  );
`;

const INDEXES_SQL = `
  CREATE INDEX IF NOT EXISTS idx_transitions_item_stage
    ON stage_transitions(work_item_id, item_type, stage);
  CREATE INDEX IF NOT EXISTS idx_transitions_status
    ON stage_transitions(status);
  CREATE INDEX IF NOT EXISTS idx_items_type
    ON work_items(item_type);
`;

const VIEW_SQL = `
  CREATE VIEW IF NOT EXISTS pipeline_status AS
  WITH ranked AS (
    SELECT st.*,
      ROW_NUMBER() OVER (
        PARTITION BY st.work_item_id, st.item_type, st.stage
        ORDER BY st.id DESC
      ) AS rn
    FROM stage_transitions st
  )
  SELECT
    wi.id, wi.item_type, wi.source_path,
    r.stage, r.status, r.attempt,
    r.error_type, r.error_message,
    r.started_at, r.completed_at
  FROM work_items wi
  JOIN ranked r ON r.work_item_id = wi.id AND r.item_type = wi.item_type
  WHERE r.rn = 1;
`;

// ---------------------------------------------------------------------------
// Health query SQL
// ---------------------------------------------------------------------------

/** Aggregate counts of stage x status from the pipeline_status view. */
const HEALTH_STAGE_STATUS_SQL = `
  SELECT stage, status, COUNT(*) as count
  FROM pipeline_status
  GROUP BY stage, status
`;

/** All circuit breaker rows. */
const HEALTH_CIRCUITS_SQL = `
  SELECT provider_role, state, failure_count, last_error
  FROM circuit_breakers
`;

// ---------------------------------------------------------------------------
// PipelineManager
// ---------------------------------------------------------------------------

export class PipelineManager {
  private db: Database.Database;

  constructor(vaultDir: string) {
    const dbPath = path.join(vaultDir, PIPELINE_DB_FILENAME);
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.init();
  }

  private init(): void {
    this.db.exec(SCHEMA_SQL);
    this.db.exec(INDEXES_SQL);
    this.db.exec(VIEW_SQL);
  }

  /** Expose the underlying database for direct queries (used in tests and by higher-level methods). */
  getDb(): Database.Database {
    return this.db;
  }

  /** Read a PRAGMA value (used in tests to verify WAL mode and foreign keys). */
  getPragma(name: string): unknown {
    return this.db.pragma(name, { simple: true });
  }

  /** Aggregate pipeline health: stage/status counts, circuit states, totals. */
  health(): PipelineHealth {
    const stageRows = this.db.prepare(HEALTH_STAGE_STATUS_SQL).all() as Array<{
      stage: string;
      status: string;
      count: number;
    }>;

    const stages: Record<string, Record<string, number>> = {};
    const totals: PipelineHealth['totals'] = {
      pending: 0,
      processing: 0,
      failed: 0,
      blocked: 0,
      poisoned: 0,
      succeeded: 0,
    };

    for (const row of stageRows) {
      if (!stages[row.stage]) {
        stages[row.stage] = {};
      }
      stages[row.stage][row.status] = row.count;

      // Accumulate into totals if the status is one we track
      if (row.status in totals) {
        totals[row.status as keyof typeof totals] += row.count;
      }
    }

    const circuitRows = this.db.prepare(HEALTH_CIRCUITS_SQL).all() as Array<{
      provider_role: string;
      state: string;
      failure_count: number;
      last_error: string | null;
    }>;

    const circuits = circuitRows.map((r) => ({
      provider_role: r.provider_role,
      state: r.state,
      failure_count: r.failure_count,
      last_error: r.last_error,
    }));

    return { stages, circuits, totals };
  }

  /** Close the database connection. */
  close(): void {
    this.db.close();
  }
}
