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
import {
  PIPELINE_STAGES,
  ITEM_STAGE_MAP,
  PIPELINE_TRANSIENT_MAX_RETRIES,
  PIPELINE_PARSE_MAX_RETRIES,
  PIPELINE_BACKOFF_BASE_MS,
  PIPELINE_BACKOFF_MULTIPLIER,
} from '@myco/constants';

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

export interface AdvanceOptions {
  errorType?: 'transient' | 'config' | 'parse';
  errorMessage?: string;
}

export interface StageStatus {
  stage: string;
  status: string;
  attempt: number;
  error_type: string | null;
  error_message: string | null;
  started_at: string | null;
  completed_at: string | null;
}

export interface BatchItem {
  id: string;
  item_type: string;
  source_path: string | null;
  created_at: string;
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

  // -------------------------------------------------------------------------
  // Work item registration
  // -------------------------------------------------------------------------

  /**
   * Register a work item in the pipeline. Creates the work_items row and
   * initial stage_transitions for all applicable stages.
   *
   * Uses INSERT OR IGNORE for work_items (idempotency — re-registering is a no-op).
   * Checks if transitions already exist before inserting.
   */
  register(itemId: string, itemType: string, sourcePath?: string): void {
    const now = new Date().toISOString();

    // INSERT OR IGNORE — idempotent for the work_items row
    this.db
      .prepare(
        'INSERT OR IGNORE INTO work_items (id, item_type, source_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(itemId, itemType, sourcePath ?? null, now, now);

    // Check if transitions already exist (idempotency guard)
    const existingCount = this.db
      .prepare(
        'SELECT COUNT(*) as cnt FROM stage_transitions WHERE work_item_id = ? AND item_type = ?',
      )
      .get(itemId, itemType) as { cnt: number };

    if (existingCount.cnt > 0) {
      return; // Already registered — skip transition creation
    }

    const applicableStages = ITEM_STAGE_MAP[itemType] ?? [];
    const insertStmt = this.db.prepare(
      'INSERT INTO stage_transitions (work_item_id, item_type, stage, status, attempt, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    );

    const insertAll = this.db.transaction(() => {
      for (const stage of PIPELINE_STAGES) {
        const status = applicableStages.includes(stage) ? 'pending' : 'skipped';
        insertStmt.run(itemId, itemType, stage, status, 1, now);
      }
    });
    insertAll();
  }

  // -------------------------------------------------------------------------
  // Stage transitions
  // -------------------------------------------------------------------------

  /**
   * Record a stage transition. Append-only — never updates existing rows.
   *
   * When status is 'failed': checks retry limits and may auto-poison.
   * When error_type is 'config': blocks all downstream stages.
   */
  advance(
    itemId: string,
    itemType: string,
    stage: string,
    status: string,
    error?: AdvanceOptions,
  ): void {
    const now = new Date().toISOString();

    // Calculate attempt by counting prior transitions with 'failed' or 'processing' status
    const priorCount = this.db
      .prepare(
        `SELECT COUNT(*) as cnt FROM stage_transitions
         WHERE work_item_id = ? AND item_type = ? AND stage = ?
         AND status IN ('failed', 'processing')`,
      )
      .get(itemId, itemType, stage) as { cnt: number };

    const attempt = status === 'failed' || status === 'processing'
      ? Math.ceil((priorCount.cnt + 1) / 2) || 1
      : priorCount.cnt > 0
        ? Math.ceil(priorCount.cnt / 2) || 1
        : 1;

    let resolvedStatus = status;

    // Check for auto-poison on failure
    if (status === 'failed' && error?.errorType) {
      const maxRetries =
        error.errorType === 'transient'
          ? PIPELINE_TRANSIENT_MAX_RETRIES
          : PIPELINE_PARSE_MAX_RETRIES;

      // Count prior failed transitions for this item+stage
      const failedCount = this.db
        .prepare(
          `SELECT COUNT(*) as cnt FROM stage_transitions
           WHERE work_item_id = ? AND item_type = ? AND stage = ? AND status = 'failed'`,
        )
        .get(itemId, itemType, stage) as { cnt: number };

      if (failedCount.cnt >= maxRetries) {
        resolvedStatus = 'poisoned';
      }
    }

    // Set started_at for processing, completed_at for terminal states
    const startedAt = status === 'processing' ? now : null;
    const completedAt = ['succeeded', 'failed', 'poisoned', 'blocked', 'skipped'].includes(resolvedStatus) ? now : null;

    this.db
      .prepare(
        `INSERT INTO stage_transitions
         (work_item_id, item_type, stage, status, attempt, error_type, error_message, started_at, completed_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        itemId,
        itemType,
        stage,
        resolvedStatus,
        attempt,
        error?.errorType ?? null,
        error?.errorMessage ?? null,
        startedAt,
        completedAt,
        now,
      );

    // Update work_items.updated_at
    this.db
      .prepare('UPDATE work_items SET updated_at = ? WHERE id = ? AND item_type = ?')
      .run(now, itemId, itemType);

    // Block downstream stages when error_type is 'config'
    if (status === 'failed' && error?.errorType === 'config') {
      const stageIdx = PIPELINE_STAGES.indexOf(stage as PipelineStage);
      if (stageIdx >= 0) {
        const downstreamStages = PIPELINE_STAGES.slice(stageIdx + 1);
        for (const downstream of downstreamStages) {
          // Only block stages that are currently pending (not already skipped)
          const currentStatus = this.db
            .prepare(
              `SELECT status FROM stage_transitions
               WHERE work_item_id = ? AND item_type = ? AND stage = ?
               ORDER BY id DESC LIMIT 1`,
            )
            .get(itemId, itemType, downstream) as { status: string } | undefined;

          if (currentStatus && currentStatus.status === 'pending') {
            this.db
              .prepare(
                `INSERT INTO stage_transitions
                 (work_item_id, item_type, stage, status, attempt, error_type, error_message, started_at, completed_at, created_at)
                 VALUES (?, ?, ?, 'blocked', 1, 'config', ?, NULL, ?, ?)`,
              )
              .run(
                itemId,
                itemType,
                downstream,
                `blocked by ${stage} config failure`,
                now,
                now,
              );
          }
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Status queries
  // -------------------------------------------------------------------------

  /**
   * Get current status for all stages of a work item.
   * Queries the pipeline_status view filtered by work_item_id and item_type.
   */
  getItemStatus(itemId: string, itemType: string): StageStatus[] {
    return this.db
      .prepare(
        `SELECT stage, status, attempt, error_type, error_message, started_at, completed_at
         FROM pipeline_status
         WHERE id = ? AND item_type = ?`,
      )
      .all(itemId, itemType) as StageStatus[];
  }

  // -------------------------------------------------------------------------
  // Batch queries
  // -------------------------------------------------------------------------

  /**
   * Get pending work items ready for processing at a given stage.
   *
   * Requirements:
   * - Only items where the requested stage is 'pending'
   * - Only items whose PREVIOUS stage (in PIPELINE_STAGES order) is 'succeeded' or 'skipped'
   * - Exclude items in backoff window
   * - Ordered by work_items.created_at ASC (oldest first)
   */
  nextBatch(stage: string, limit: number): BatchItem[] {
    const stageIdx = PIPELINE_STAGES.indexOf(stage as PipelineStage);

    // For the first stage (capture), there is no upstream requirement
    if (stageIdx === 0) {
      return this.db
        .prepare(
          `SELECT ps.id, ps.item_type, ps.source_path, wi.created_at
           FROM pipeline_status ps
           JOIN work_items wi ON wi.id = ps.id AND wi.item_type = ps.item_type
           WHERE ps.stage = ? AND ps.status = 'pending'
           AND NOT EXISTS (
             SELECT 1 FROM stage_transitions st2
             WHERE st2.work_item_id = ps.id AND st2.item_type = ps.item_type
             AND st2.stage = ? AND st2.status = 'failed'
             AND st2.completed_at IS NOT NULL
             AND (julianday('now') - julianday(st2.completed_at)) * 86400000 <
               ? * POWER(?, (
                 SELECT COUNT(*) FROM stage_transitions st3
                 WHERE st3.work_item_id = ps.id AND st3.item_type = ps.item_type
                 AND st3.stage = ? AND st3.status = 'failed'
               ) - 1)
           )
           ORDER BY wi.created_at ASC
           LIMIT ?`,
        )
        .all(
          stage,
          stage,
          PIPELINE_BACKOFF_BASE_MS,
          PIPELINE_BACKOFF_MULTIPLIER,
          stage,
          limit,
        ) as BatchItem[];
    }

    const prevStage = PIPELINE_STAGES[stageIdx - 1];

    return this.db
      .prepare(
        `SELECT ps.id, ps.item_type, ps.source_path, wi.created_at
         FROM pipeline_status ps
         JOIN work_items wi ON wi.id = ps.id AND wi.item_type = ps.item_type
         WHERE ps.stage = ? AND ps.status = 'pending'
         AND EXISTS (
           SELECT 1 FROM pipeline_status ps2
           WHERE ps2.id = ps.id AND ps2.item_type = ps.item_type
           AND ps2.stage = ? AND ps2.status IN ('succeeded', 'skipped')
         )
         AND NOT EXISTS (
           SELECT 1 FROM stage_transitions st2
           WHERE st2.work_item_id = ps.id AND st2.item_type = ps.item_type
           AND st2.stage = ? AND st2.status = 'failed'
           AND st2.completed_at IS NOT NULL
           AND (julianday('now') - julianday(st2.completed_at)) * 86400000 <
             ? * POWER(?, (
               SELECT COUNT(*) FROM stage_transitions st3
               WHERE st3.work_item_id = ps.id AND st3.item_type = ps.item_type
               AND st3.stage = ? AND st3.status = 'failed'
             ) - 1)
         )
         ORDER BY wi.created_at ASC
         LIMIT ?`,
      )
      .all(
        stage,
        prevStage,
        stage,
        PIPELINE_BACKOFF_BASE_MS,
        PIPELINE_BACKOFF_MULTIPLIER,
        stage,
        limit,
      ) as BatchItem[];
  }

  /** Close the database connection. */
  close(): void {
    this.db.close();
  }
}
